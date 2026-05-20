// Tahmin — desenin devamını seç.
// Mekanik: ekranda 4 item ve bir "?" görünür. Bir mantık var: aritmetik
// (örn. 2,4,6,?), alternating renk, şekil rotasyonu veya kombinasyon.
// 4 seçenekten doğru olanı seç.
//   - Doğru → skor +1
//   - Yanlış veya 12s dolması → 1 can kaybı
//   - 3 can biter → game over
// Pattern tipleri turn-by-turn rastgele.
//
// Pitfall önlemleri:
//   - visual-vs-hitbox: Tüm cell'ler aynı CSS sınıfı `.cell`'den boyut alır
//     (sequence & options aynı görsel/hitbox boyutu, CSS'te tek const olarak).
//   - overlay-input-leak: state enum (`playing | gameOver`). gameOver'da
//     option tıklaması ve sayı tuşları no-op. Sadece restart işler.
//   - stale-async-callback: Süre sayacı ve "yanlış cevap flash" delay'i
//     generation token (`gen`) ile korunur. reset/yeni soru gen'i bump eder.
//   - invisible-boot: reset() içinde ilk soru kurulur ve render edilir.
//     Sayfa açılır açılmaz 1. soru + 4 seçenek + 3 can + dolu timer bar görünür.
//   - unguarded-storage: safeRead/safeWrite try/catch.
//   - duplicate-with-shared-layer: title/hint body'de yok; layout sağlıyor.

// ---- Sabitler ----

const ROUND_MS = 12000; // 12 saniye
const TICK_MS = 100; // timer bar refresh interval
const FLASH_MS = 600; // doğru/yanlış vurgu süresi (sonraki sorudan önce)
const STARTING_LIVES = 3;
const STORAGE_BEST = 'tahmin.best';
const SEQ_LENGTH = 4; // gösterilen item sayısı (5. slot ?)
const OPTION_COUNT = 4;

// Renk paleti — pattern üretimi ve cell renderı için ortak.
const COLORS = ['red', 'blue', 'green', 'yellow', 'purple', 'orange'] as const;
type Color = (typeof COLORS)[number];

// Şekiller — pattern üretimi ve cell renderı için ortak.
const SHAPES = ['circle', 'square', 'triangle', 'diamond'] as const;
type Shape = (typeof SHAPES)[number];

// Rotasyon tipi.
type Rotation = 0 | 90 | 180 | 270;
const ROTATIONS: Rotation[] = [0, 90, 180, 270];

// Bir cell'in tüm görsel-anlam state'i.
interface Item {
  number?: number; // sayı (görsel gösterilir)
  color: Color; // arkaplan rengi (her zaman var; default mavi)
  shape: Shape; // şekil (her zaman var; default daire)
  rotation: Rotation; // şekil rotasyonu (default 0)
}

type PatternKind = 'arithmetic' | 'color' | 'shape' | 'combo';
type GameState = 'playing' | 'gameOver';

// ---- DOM refs ----

const scoreEl = document.querySelector<HTMLElement>('#score')!;
const bestEl = document.querySelector<HTMLElement>('#best')!;
const livesEl = document.querySelector<HTMLElement>('#lives')!;
const promptEl = document.querySelector<HTMLElement>('#prompt')!;
const timerBarEl = document.querySelector<HTMLElement>('#timer-bar')!;
const sequenceCells = Array.from(
  document.querySelectorAll<HTMLElement>('.sequence__cell'),
);
const optionButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>('.option'),
);
const restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
const overlayEl = document.querySelector<HTMLElement>('#overlay')!;
const overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
const overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
const overlayRestart =
  document.querySelector<HTMLButtonElement>('#overlay-restart')!;

// ---- Storage (safe) ----

function safeRead(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function safeWrite(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

function loadBest(): number {
  const raw = safeRead(STORAGE_BEST);
  if (raw === null) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

// ---- State ----

let state: GameState = 'playing';
let score = 0;
let lives = STARTING_LIVES;
let best = loadBest();

// Aktif soru — sequence[0..3] gösterilen, answer doğru cevap, options 4 cevap.
let sequence: Item[] = [];
let answer: Item = makeDefaultItem();
let options: Item[] = [];
let correctIndex = 0;
let currentPattern: PatternKind = 'arithmetic';

// Async generation token — reset/yeni soru bump eder.
let gen = 0;

// Süre kontrolü.
let roundStart = 0;
let roundDuration = ROUND_MS;
let tickHandle: number | null = null;

// UI feedback.
let feedbackIndex: number | null = null;
let feedbackKind: 'correct' | 'wrong' | null = null;

// ---- Helpers ----

function makeDefaultItem(): Item {
  return { color: 'blue', shape: 'circle', rotation: 0 };
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick<T>(arr: readonly T[]): T {
  const idx = Math.floor(Math.random() * arr.length);
  return arr[idx]!;
}

// ---- Pattern generators ----
// Her generator { sequence, answer, kind } döner. Yanlış seçenekleri ayrıca
// generateDistractors üretir; o aynı koddan beslenmeyen (yani "near-miss")
// item'lar verir ki kullanıcı kolayca cevabı bulamasın ama mantık tek olsun.

interface Question {
  sequence: Item[];
  answer: Item;
  kind: PatternKind;
}

function genArithmetic(): Question {
  // 4 sayı + 1 ? — arithmetic progression. step ∈ [-5,-1] ∪ [1,5] (sıfır yok)
  let step = randInt(1, 5);
  if (Math.random() < 0.5) step = -step;
  // Başlangıç: cevap 0..40 aralığında kalsın diye sınırlı.
  // a_n = start + step*n, n=0..4. Hem start hem start+4*step >= 0 ve <=99.
  let start = 0;
  for (let tries = 0; tries < 20; tries++) {
    start = randInt(0, 30);
    const last = start + step * (SEQ_LENGTH); // q slot value
    if (last >= 0 && last <= 99) break;
  }
  const seq: Item[] = [];
  for (let i = 0; i < SEQ_LENGTH; i++) {
    seq.push({
      number: start + step * i,
      color: 'blue',
      shape: 'circle',
      rotation: 0,
    });
  }
  const answer: Item = {
    number: start + step * SEQ_LENGTH,
    color: 'blue',
    shape: 'circle',
    rotation: 0,
  };
  return { sequence: seq, answer, kind: 'arithmetic' };
}

function genColor(): Question {
  // Alternating: 2 renkli A,B,A,B,? veya 3 renkli A,B,C,A,? gibi rotasyon.
  // İki tip: alternating 2-cycle, rotating 3-cycle.
  const isAlt2 = Math.random() < 0.5;
  if (isAlt2) {
    // A,B,A,B → next = A
    const colors = shuffleArray([...COLORS]).slice(0, 2);
    const a = colors[0]!;
    const b = colors[1]!;
    const seqColors: Color[] = [a, b, a, b];
    const ans: Color = a;
    const seq = seqColors.map<Item>((c) => ({
      color: c,
      shape: 'circle',
      rotation: 0,
    }));
    return {
      sequence: seq,
      answer: { color: ans, shape: 'circle', rotation: 0 },
      kind: 'color',
    };
  }
  // A,B,C,A → next = B
  const colors = shuffleArray([...COLORS]).slice(0, 3);
  const [a, b, c] = colors as [Color, Color, Color];
  const seqColors: Color[] = [a, b, c, a];
  const ans: Color = b;
  const seq = seqColors.map<Item>((col) => ({
    color: col,
    shape: 'circle',
    rotation: 0,
  }));
  return {
    sequence: seq,
    answer: { color: ans, shape: 'circle', rotation: 0 },
    kind: 'color',
  };
}

function genShape(): Question {
  // İki tür: rotasyon (0,90,180,270 → 0) veya şekil cycle (A,B,A,B,?)
  const isRotation = Math.random() < 0.5;
  const baseShape = pick(SHAPES);
  const color = pick(COLORS);

  if (isRotation) {
    // 0,90,180,270 → 0 (4-step cycle, next is start over). Dir ±.
    const dir = Math.random() < 0.5 ? 1 : -1;
    const startIdx = randInt(0, 3);
    const seq: Item[] = [];
    for (let i = 0; i < SEQ_LENGTH; i++) {
      const r = ROTATIONS[(((startIdx + dir * i) % 4) + 4) % 4]!;
      seq.push({ color, shape: baseShape, rotation: r });
    }
    const ansR = ROTATIONS[(((startIdx + dir * SEQ_LENGTH) % 4) + 4) % 4]!;
    return {
      sequence: seq,
      answer: { color, shape: baseShape, rotation: ansR },
      kind: 'shape',
    };
  }

  // Alternating shape A,B,A,B,?
  const shapes = shuffleArray([...SHAPES]).slice(0, 2);
  const s1 = shapes[0]!;
  const s2 = shapes[1]!;
  const seqShapes: Shape[] = [s1, s2, s1, s2];
  const ans: Shape = s1;
  const seq = seqShapes.map<Item>((sh) => ({
    color,
    shape: sh,
    rotation: 0,
  }));
  return {
    sequence: seq,
    answer: { color, shape: ans, rotation: 0 },
    kind: 'shape',
  };
}

function genCombo(): Question {
  // Kombinasyon: hem sayı hem renk değişir.
  // A,B,A,B sıralı renk + arithmetic sayı (1,2,3,4 → 5 etc.)
  const colors = shuffleArray([...COLORS]).slice(0, 2);
  const a = colors[0]!;
  const b = colors[1]!;
  const seqColors: Color[] = [a, b, a, b];
  const ansC: Color = a;

  let step = randInt(1, 4);
  if (Math.random() < 0.5) step = -step;
  let start = 1;
  for (let tries = 0; tries < 20; tries++) {
    start = randInt(1, 20);
    const last = start + step * SEQ_LENGTH;
    if (last >= 0 && last <= 99) break;
  }

  const seq: Item[] = [];
  for (let i = 0; i < SEQ_LENGTH; i++) {
    seq.push({
      number: start + step * i,
      color: seqColors[i]!,
      shape: 'circle',
      rotation: 0,
    });
  }
  const answer: Item = {
    number: start + step * SEQ_LENGTH,
    color: ansC,
    shape: 'circle',
    rotation: 0,
  };
  return { sequence: seq, answer, kind: 'combo' };
}

function shuffleArray<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = a[i]!;
    a[i] = a[j]!;
    a[j] = tmp;
  }
  return a;
}

// Üretici registry — turn-by-turn pick.
const GENERATORS: Record<PatternKind, () => Question> = {
  arithmetic: genArithmetic,
  color: genColor,
  shape: genShape,
  combo: genCombo,
};

const PATTERN_KINDS: PatternKind[] = ['arithmetic', 'color', 'shape', 'combo'];

function generateQuestion(): Question {
  const kind = pick(PATTERN_KINDS);
  return GENERATORS[kind]();
}

// ---- Distractor üretimi ----
// Doğru cevaba "yakın ama yanlış" 3 alternatif üretir. Pattern kind'a göre.
function generateDistractors(q: Question): Item[] {
  const distractors: Item[] = [];
  // Try çok defa; eşsiz olduğundan emin ol (item eşitliği itemEq ile).
  let tries = 0;
  while (distractors.length < OPTION_COUNT - 1 && tries < 200) {
    tries++;
    const cand = makeDistractor(q);
    if (itemEq(cand, q.answer)) continue;
    if (distractors.some((d) => itemEq(d, cand))) continue;
    // Distractor sequence içindeki herhangi bir item'e eşit olmasın ki
    // "zaten gördüm" hissi vermesin (opsiyonel).
    distractors.push(cand);
  }
  // Yeterli üretemediysek random ile doldur.
  while (distractors.length < OPTION_COUNT - 1) {
    const cand: Item = {
      number:
        q.answer.number !== undefined
          ? Math.max(0, q.answer.number + randInt(-5, 5))
          : undefined,
      color: pick(COLORS),
      shape: pick(SHAPES),
      rotation: pick(ROTATIONS),
    };
    if (!itemEq(cand, q.answer) && !distractors.some((d) => itemEq(d, cand))) {
      distractors.push(cand);
    }
  }
  return distractors;
}

function makeDistractor(q: Question): Item {
  const ans = q.answer;
  switch (q.kind) {
    case 'arithmetic': {
      // Sayıyı ±1..±9 kaydır.
      const delta = randInt(1, 9) * (Math.random() < 0.5 ? 1 : -1);
      const n = ans.number ?? 0;
      const num = Math.max(0, Math.min(99, n + delta));
      return { ...ans, number: num };
    }
    case 'color': {
      // Farklı renk.
      let c: Color = pick(COLORS);
      let safety = 10;
      while (c === ans.color && safety-- > 0) c = pick(COLORS);
      return { ...ans, color: c };
    }
    case 'shape': {
      // Şekil bazlı: rotasyon veya şekli değiştir.
      if (Math.random() < 0.5) {
        let r: Rotation = pick(ROTATIONS);
        let safety = 10;
        while (r === ans.rotation && safety-- > 0) r = pick(ROTATIONS);
        return { ...ans, rotation: r };
      }
      let s: Shape = pick(SHAPES);
      let safety = 10;
      while (s === ans.shape && safety-- > 0) s = pick(SHAPES);
      return { ...ans, shape: s };
    }
    case 'combo': {
      // Hem sayı hem renk değişebilir.
      const swapColor = Math.random() < 0.5;
      const n = ans.number ?? 0;
      const delta = randInt(1, 5) * (Math.random() < 0.5 ? 1 : -1);
      const num = Math.max(0, Math.min(99, n + delta));
      let c: Color = ans.color;
      if (swapColor) {
        c = pick(COLORS);
        let safety = 10;
        while (c === ans.color && safety-- > 0) c = pick(COLORS);
      }
      return { ...ans, number: num, color: c };
    }
  }
}

function itemEq(a: Item, b: Item): boolean {
  return (
    a.number === b.number &&
    a.color === b.color &&
    a.shape === b.shape &&
    a.rotation === b.rotation
  );
}

// ---- Render ----

function renderItemTo(host: HTMLElement, item: Item): void {
  host.innerHTML = '';
  host.className = host.className
    .split(/\s+/)
    .filter(
      (c) =>
        !c.startsWith('cell--color-') &&
        !c.startsWith('cell--shape-') &&
        c !== '',
    )
    .join(' ');
  host.classList.add(`cell--color-${item.color}`);
  host.classList.add(`cell--shape-${item.shape}`);

  // Şekil bir SVG ile çizilir; rotation transform ile uygulanır.
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('class', 'cell__svg');
  svg.setAttribute('aria-hidden', 'true');

  const g = document.createElementNS(svgNS, 'g');
  g.setAttribute(
    'transform',
    `rotate(${item.rotation} 50 50)`,
  );

  switch (item.shape) {
    case 'circle': {
      const el = document.createElementNS(svgNS, 'circle');
      el.setAttribute('cx', '50');
      el.setAttribute('cy', '50');
      el.setAttribute('r', '32');
      el.setAttribute('class', 'cell__fig');
      g.appendChild(el);
      break;
    }
    case 'square': {
      const el = document.createElementNS(svgNS, 'rect');
      el.setAttribute('x', '20');
      el.setAttribute('y', '20');
      el.setAttribute('width', '60');
      el.setAttribute('height', '60');
      el.setAttribute('rx', '6');
      el.setAttribute('class', 'cell__fig');
      g.appendChild(el);
      break;
    }
    case 'triangle': {
      const el = document.createElementNS(svgNS, 'polygon');
      // Tepe yukarıda (rotation 0).
      el.setAttribute('points', '50,15 85,80 15,80');
      el.setAttribute('class', 'cell__fig');
      g.appendChild(el);
      break;
    }
    case 'diamond': {
      const el = document.createElementNS(svgNS, 'polygon');
      el.setAttribute('points', '50,15 85,50 50,85 15,50');
      el.setAttribute('class', 'cell__fig');
      g.appendChild(el);
      break;
    }
  }

  svg.appendChild(g);
  host.appendChild(svg);

  if (item.number !== undefined) {
    const numEl = document.createElement('span');
    numEl.className = 'cell__num';
    numEl.textContent = String(item.number);
    host.appendChild(numEl);
  }
}

function renderSequence(): void {
  for (let i = 0; i < SEQ_LENGTH; i++) {
    const host = sequenceCells[i];
    const item = sequence[i];
    if (!host || !item) continue;
    renderItemTo(host, item);
  }
  // "?" slot — sequence__cell--unknown class korunur.
  const q = sequenceCells[SEQ_LENGTH];
  if (q) {
    q.className = 'cell sequence__cell sequence__cell--unknown';
    q.innerHTML = '<span class="cell__q">?</span>';
  }
}

function renderOptions(): void {
  for (let i = 0; i < OPTION_COUNT; i++) {
    const btn = optionButtons[i];
    const opt = options[i];
    if (!btn || !opt) continue;
    // Önce class temizle, sonra cell + option ekle (key span'i temizleme ile birlikte gider).
    btn.className = 'cell option';
    renderItemTo(btn, opt);
    // Renderdan sonra key span'i ekle (üst üste sırayla yerleşir).
    const key = document.createElement('span');
    key.className = 'option__key';
    key.textContent = String(i + 1);
    btn.appendChild(key);
    btn.disabled = state !== 'playing';
    btn.classList.toggle(
      'option--correct',
      feedbackIndex === i && feedbackKind === 'correct',
    );
    btn.classList.toggle(
      'option--wrong',
      feedbackIndex === i && feedbackKind === 'wrong',
    );
    btn.classList.toggle(
      'option--reveal',
      feedbackKind === 'wrong' && i === correctIndex,
    );
  }
}

function renderHud(): void {
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
  // 3 can görsel olarak nokta gösterilebilir; sayıyı text içeriği olarak da tut.
  const filled = '●'.repeat(Math.max(0, lives));
  const empty = '○'.repeat(Math.max(0, STARTING_LIVES - lives));
  livesEl.textContent = filled + empty;
}

function renderPrompt(): void {
  const labelMap: Record<PatternKind, string> = {
    arithmetic: 'Sayı dizisi',
    color: 'Renk deseni',
    shape: 'Şekil deseni',
    combo: 'Kombo desen',
  };
  promptEl.textContent = `${labelMap[currentPattern]} — sıradaki hangisi?`;
}

function renderTimer(elapsedMs: number): void {
  const ratio = Math.max(0, 1 - elapsedMs / roundDuration);
  timerBarEl.style.transform = `scaleX(${ratio.toFixed(4)})`;
  // Az kalınca uyarı rengi.
  timerBarEl.classList.toggle('timer__bar--warn', ratio < 0.34);
}

function renderAll(): void {
  renderHud();
  renderPrompt();
  renderSequence();
  renderOptions();
}

// ---- Round flow ----

function newRound(): void {
  // Bump generation — eski timer ve flash callback'leri iptal edilsin.
  gen++;
  stopTimer();
  feedbackIndex = null;
  feedbackKind = null;

  const q = generateQuestion();
  currentPattern = q.kind;
  sequence = q.sequence;
  answer = q.answer;

  // 4 seçenek: 3 distractor + 1 doğru, karıştırılır.
  const distractors = generateDistractors(q);
  const allOpts: Item[] = [...distractors, q.answer];
  options = shuffleArray(allOpts);
  correctIndex = options.findIndex((o) => itemEq(o, q.answer));

  renderAll();
  startTimer();
}

function startTimer(): void {
  roundStart = performance.now();
  renderTimer(0);
  const token = gen;
  // setInterval kullanmak yerine setTimeout chain — clear edilebilir.
  const tick = (): void => {
    if (token !== gen || state !== 'playing') return;
    const elapsed = performance.now() - roundStart;
    if (elapsed >= roundDuration) {
      renderTimer(roundDuration);
      timeOut();
      return;
    }
    renderTimer(elapsed);
    tickHandle = window.setTimeout(tick, TICK_MS);
  };
  tickHandle = window.setTimeout(tick, TICK_MS);
}

function stopTimer(): void {
  if (tickHandle !== null) {
    clearTimeout(tickHandle);
    tickHandle = null;
  }
}

function timeOut(): void {
  if (state !== 'playing') return;
  // Yanlış sayılır.
  applyWrong(null);
}

function pickOption(idx: number): void {
  if (state !== 'playing') return; // overlay-input-leak guard
  if (idx < 0 || idx >= OPTION_COUNT) return;
  const chosen = options[idx];
  if (!chosen) return;
  stopTimer();

  if (itemEq(chosen, answer)) {
    applyCorrect(idx);
  } else {
    applyWrong(idx);
  }
}

function applyCorrect(idx: number): void {
  score++;
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, String(best));
  }
  feedbackIndex = idx;
  feedbackKind = 'correct';
  renderAll();

  const token = gen;
  window.setTimeout(() => {
    if (token !== gen) return;
    if (state !== 'playing') return;
    newRound();
  }, FLASH_MS);
}

function applyWrong(idx: number | null): void {
  lives--;
  feedbackIndex = idx;
  feedbackKind = 'wrong';
  renderAll();

  if (lives <= 0) {
    // Yine FLASH_MS bekle ki kullanıcı doğru cevabı görsün.
    const token = gen;
    window.setTimeout(() => {
      if (token !== gen) return;
      gameOver();
    }, FLASH_MS);
    return;
  }

  const token = gen;
  window.setTimeout(() => {
    if (token !== gen) return;
    if (state !== 'playing') return;
    newRound();
  }, FLASH_MS);
}

function gameOver(): void {
  state = 'gameOver';
  stopTimer();
  // Options disabled re-render.
  renderOptions();
  showOverlay();
}

function showOverlay(): void {
  overlayTitle.textContent = score > 0 && score === best ? 'Yeni rekor!' : 'Oyun bitti';
  overlayMsg.textContent =
    score === 0
      ? 'Hiç doğru tahmin yapamadın. Tekrar dene!'
      : `${score} doğru tahmin. En iyi: ${best}.`;
  overlayEl.classList.remove('overlay--hidden');
  overlayEl.setAttribute('aria-hidden', 'false');
  try {
    overlayRestart.focus({ preventScroll: true });
  } catch {
    /* ignore */
  }
}

function hideOverlay(): void {
  overlayEl.classList.add('overlay--hidden');
  overlayEl.setAttribute('aria-hidden', 'true');
}

function resetGame(): void {
  // Bump gen ile pending callback'ler iptal.
  gen++;
  stopTimer();
  state = 'playing';
  score = 0;
  lives = STARTING_LIVES;
  feedbackIndex = null;
  feedbackKind = null;
  hideOverlay();
  newRound();
}

// ---- Wire up ----

optionButtons.forEach((btn, i) => {
  btn.addEventListener('click', () => pickOption(i));
});

restartBtn.addEventListener('click', resetGame);
overlayRestart.addEventListener('click', resetGame);

window.addEventListener('keydown', (event) => {
  const k = event.key;
  if (k === 'r' || k === 'R') {
    resetGame();
    event.preventDefault();
    return;
  }
  if (k >= '1' && k <= '4') {
    // overlay-input-leak: state guard pickOption içinde.
    pickOption(Number(k) - 1);
    event.preventDefault();
  }
});

// ---- Boot ----

// invisible-boot: ilk render senkron. newRound() pattern üretir + timer'ı başlatır.
resetGame();
