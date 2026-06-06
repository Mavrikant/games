import { defineGame } from '@shared/game-module';
import { reportGameOver } from '@shared/leaderboard';

// Water Sort — sıvı renk sıralama puzzle.
// Her tüp 4 katman. Hedef: her tüp ya boş ya da tek renk dolu olsun.
// Üst katman + onunla aynı renkten ardışık katmanlar tek seferde dökülür.
//
// State machine: Ready → Playing → Animating → (Win) → NextLevel → Playing …
//
// Solvability: Başlangıçtaki "sıralı dolu" durumdan rastgele geçerli ters
// dökümler ile karıştırıyoruz; tamamen rastgele üretim büyük olasılıkla
// çözülemez puzzle yaratır.

interface PourAnim {
  fromIdx: number;
  toIdx: number;
  color: number;
  units: number;
}

interface SavedState {
  level: number;
  tubes: number[][];
  history: number[][][];
  moves: number;
  numColors: number;
  numEmpty: number;
}

const TUBE_CAP = 4;
const POUR_MS = 360;

const STORAGE_LEVEL = 'water-sort.level';
const STORAGE_BEST = 'water-sort.bestMoves';
const STORAGE_STATE = 'water-sort.state';
const SCORE_DESC = { gameId: 'water-sort', storageKey: STORAGE_BEST, direction: 'lower' as const };

// Palet — kullanıcının beyni 12+ rengi kolayca ayırabilsin diye yüksek
// kontrastlı, "su" hissi veren tonlar.
const PALETTE: string[] = [
  '#ef4444', // kırmızı
  '#f59e0b', // turuncu/amber
  '#fde047', // sarı
  '#22c55e', // yeşil
  '#06b6d4', // turkuaz
  '#3b82f6', // mavi
  '#a855f7', // mor
  '#ec4899', // pembe
  '#84cc16', // limon yeşili
  '#f97316', // koyu turuncu
  '#0ea5e9', // gök mavisi
  '#d946ef', // magenta
];

let levelEl!: HTMLElement;
let movesEl!: HTMLElement;
let bestEl!: HTMLElement;
let boardEl!: HTMLElement;
let undoBtn!: HTMLButtonElement;
let restartBtn!: HTMLButtonElement;
let newGameBtn!: HTMLButtonElement;
let overlayEl!: HTMLElement;
let overlayTitleEl!: HTMLElement;
let overlayMsgEl!: HTMLElement;
let overlayNextBtn!: HTMLButtonElement;

// State.
// tubes[i] = layers from bottom to top. tubes[i][0] = en alttaki sıvı.
let tubes: number[][] = [];
let history: number[][][] = []; // önceki tüp durumlarının snapshot'ları.
let level = 1;
let bestMoves: Record<string, number> = {};
let moves = 0;
let numColors = 0;
let numEmpty = 0;
let selectedIdx: number | null = null;
let animating: PourAnim | null = null;
let won = false;
let resetToken = 0; // stale-async-callback guard
let initialTubes: number[][] = []; // mevcut puzzle'ın orijinal hali (Sıfırla)

// Render-side referanslar — re-render arasında yeniden kurulur.
let tubeEls: HTMLButtonElement[] = [];

// -------------------- Storage helpers (unguarded-storage pitfall) --------------------

function safeReadNumber(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  } catch {
    return fallback;
  }
}

function safeReadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object') return fallback;
    return parsed as T;
  } catch {
    return fallback;
  }
}

function safeWrite(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

function safeWriteJSON(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

function persistLevel(): void {
  safeWrite(STORAGE_LEVEL, String(level));
}

function persistBest(): void {
  safeWriteJSON(STORAGE_BEST, bestMoves);
}

function persistState(): void {
  const state: SavedState = {
    level,
    tubes: clone(tubes),
    history: history.map(clone),
    moves,
    numColors,
    numEmpty,
  };
  safeWriteJSON(STORAGE_STATE, state);
}

function loadState(): SavedState | null {
  const data = safeReadJSON<Partial<SavedState> | null>(STORAGE_STATE, null);
  if (!data) return null;
  if (
    typeof data.level !== 'number' ||
    !Array.isArray(data.tubes) ||
    typeof data.moves !== 'number' ||
    typeof data.numColors !== 'number' ||
    typeof data.numEmpty !== 'number'
  ) {
    return null;
  }
  const tubesValid = data.tubes.every(
    (t) => Array.isArray(t) && t.every((v) => typeof v === 'number'),
  );
  if (!tubesValid) return null;
  const history = Array.isArray(data.history) ? data.history : [];
  return {
    level: data.level,
    tubes: data.tubes as number[][],
    history: history as number[][][],
    moves: data.moves,
    numColors: data.numColors,
    numEmpty: data.numEmpty,
  };
}

// -------------------- Helpers --------------------

function clone(arr: number[][]): number[][] {
  return arr.map((t) => t.slice());
}

function levelConfig(lv: number): { colors: number; empty: number } {
  // Seviye 1: 4 renk + 2 boş; seviye başına bir renk daha (cap 12);
  // her 3 seviyede +1 ekstra boş (cap 3).
  const colors = Math.min(PALETTE.length, 4 + Math.floor((lv - 1) / 1));
  const empty = Math.min(3, 2 + Math.floor((lv - 1) / 4));
  return { colors: Math.max(4, Math.min(colors, PALETTE.length)), empty };
}

function topInfo(tube: number[]): { color: number; count: number } | null {
  if (tube.length === 0) return null;
  const color = tube[tube.length - 1]!;
  let count = 1;
  for (let i = tube.length - 2; i >= 0; i--) {
    if (tube[i] === color) count++;
    else break;
  }
  return { color, count };
}

function canPour(srcIdx: number, dstIdx: number): boolean {
  if (srcIdx === dstIdx) return false;
  const src = tubes[srcIdx];
  const dst = tubes[dstIdx];
  if (!src || !dst) return false;
  if (src.length === 0) return false;
  if (dst.length >= TUBE_CAP) return false;
  const srcTop = src[src.length - 1]!;
  if (dst.length === 0) return true;
  return dst[dst.length - 1] === srcTop;
}

function pourUnits(srcIdx: number, dstIdx: number): number {
  // Kaç birim dökülecek? Üstteki ardışık aynı renkler, ama hedefin boş
  // kapasitesi kadarla sınırlı.
  const src = tubes[srcIdx]!;
  const dst = tubes[dstIdx]!;
  const info = topInfo(src);
  if (!info) return 0;
  const room = TUBE_CAP - dst.length;
  return Math.min(info.count, room);
}

function isSolved(): boolean {
  for (const t of tubes) {
    if (t.length === 0) continue;
    if (t.length !== TUBE_CAP) return false;
    const first = t[0]!;
    for (let i = 1; i < t.length; i++) {
      if (t[i] !== first) return false;
    }
  }
  return true;
}

// -------------------- Puzzle generation --------------------

function generatePuzzle(lv: number): { tubes: number[][]; colors: number; empty: number } {
  const { colors, empty } = levelConfig(lv);
  const colorPool = [...Array(PALETTE.length).keys()];
  shuffleInPlace(colorPool);
  const chosen = colorPool.slice(0, colors);

  // İki strateji yarışıyor:
  //  A) random distribution + solvability check via BFS
  //  B) reverse-pour from solved (her zaman çözülebilir)
  // En karışık (score yüksek) ve çözülebilir olanı seç.
  let best: number[][] | null = null;
  let bestScore = -Infinity;

  for (let attempt = 0; attempt < 24; attempt++) {
    const useRandom = attempt < 16;
    const work = useRandom
      ? randomDistributeAndCheck(chosen, empty)
      : scrambleFromSolved(chosen, empty, lv);
    if (!work) continue;
    const score = scrambleScore(work);
    const monos = countMonoFullTubes(work);
    // Mono full sayısı 1+ ise puan kırp (oyuncu için az ilginç).
    const adjustedScore = score - monos * 8;
    if (adjustedScore > bestScore) {
      best = work;
      bestScore = adjustedScore;
    }
    // Yeterince zor + 0 mono → erken çık.
    if (monos === 0 && score >= 5 + lv) break;
  }
  return { tubes: best!, colors, empty };
}

// Random distribute katmanları dolu tüplere; sonra BFS ile solvable mı diye
// kontrol et. Solvable değilse null dön.
function randomDistributeAndCheck(chosen: number[], empty: number): number[][] | null {
  const colors = chosen.length;
  const pool: number[] = [];
  for (const c of chosen) for (let i = 0; i < TUBE_CAP; i++) pool.push(c);
  shuffleInPlace(pool);
  const work: number[][] = [];
  for (let i = 0; i < colors; i++) {
    const tube: number[] = [];
    for (let j = 0; j < TUBE_CAP; j++) tube.push(pool.pop()!);
    work.push(tube);
  }
  for (let i = 0; i < empty; i++) work.push([]);
  return isSolvableBFS(work, 20000) ? work : null;
}

// BFS ile solvability check. nodeLimit'i aşarsa false (timeout) döner.
// State'i string key olarak kodla; visited set tut.
function isSolvableBFS(start: number[][], nodeLimit: number): boolean {
  const key = (st: number[][]): string => st.map((t) => t.join(',')).sort().join('|');
  const isWin = (st: number[][]): boolean => {
    for (const t of st) {
      if (t.length === 0) continue;
      if (t.length !== TUBE_CAP) return false;
      for (let i = 1; i < t.length; i++) if (t[i] !== t[0]) return false;
    }
    return true;
  };
  if (isWin(start)) return true;
  const visited = new Set<string>();
  visited.add(key(start));
  // DFS with stack (low memory).
  const stack: number[][][] = [start];
  let nodes = 0;
  while (stack.length > 0) {
    if (++nodes > nodeLimit) return false;
    const cur = stack.pop()!;
    const n = cur.length;
    for (let s = 0; s < n; s++) {
      const src = cur[s]!;
      if (src.length === 0) continue;
      const topC = src[src.length - 1]!;
      let runLen = 1;
      for (let i = src.length - 2; i >= 0; i--) {
        if (src[i] === topC) runLen++;
        else break;
      }
      for (let d = 0; d < n; d++) {
        if (s === d) continue;
        const dst = cur[d]!;
        if (dst.length >= TUBE_CAP) continue;
        if (dst.length > 0 && dst[dst.length - 1] !== topC) continue;
        const room = TUBE_CAP - dst.length;
        const move = Math.min(runLen, room);
        if (move <= 0) continue;
        // Pruning: pour into empty when src is already mono is wasteful
        // (just renames the tube). Skip when src fully transfers to empty.
        const isSrcMono = (() => {
          for (const v of src) if (v !== topC) return false;
          return src.length === runLen;
        })();
        if (isSrcMono && dst.length === 0 && move === src.length) continue;
        const next = cur.map((t) => t.slice());
        for (let i = 0; i < move; i++) next[d]!.push(next[s]!.pop()!);
        if (isWin(next)) return true;
        const k = key(next);
        if (!visited.has(k)) {
          visited.add(k);
          stack.push(next);
        }
      }
    }
  }
  return false;
}

function countMonoFullTubes(tubes: number[][]): number {
  let n = 0;
  for (const t of tubes) if (isMonoFullTube(t)) n++;
  return n;
}

// Tek katmanlık "renk çeşitliliği" skor: tüpün içindeki ardışık-aynı-renk
// bloklarının toplamı. Yüksek skor = daha çok karışık.
function scrambleScore(tubes: number[][]): number {
  let score = 0;
  for (const t of tubes) {
    if (t.length === 0) continue;
    let blocks = 1;
    for (let i = 1; i < t.length; i++) {
      if (t[i] !== t[i - 1]) blocks++;
    }
    score += blocks - 1; // 4 farklı renkli tüp = 3 puan
  }
  return score;
}

// Strateji: çözülmüş durumdan başla, geçerli forward pour'larla karıştır.
// Boş tüpleri workspace olarak kullanır, ama hamleler her zaman tersinir
// olduğu için sonuç durum garanti çözülebilir.
function scrambleFromSolved(chosen: number[], empty: number, lv: number): number[][] {
  const colors = chosen.length;
  const work: number[][] = chosen.map((c) => [c, c, c, c]);
  for (let i = 0; i < empty; i++) work.push([]);

  const totalTubes = colors + empty;
  const SCRAMBLE_MOVES = 120 + lv * 12;
  let lastPair = -1;

  for (let step = 0; step < SCRAMBLE_MOVES; step++) {
    const candidates: Array<{ src: number; dst: number; maxUnits: number }> = [];
    for (let s = 0; s < totalTubes; s++) {
      const src = work[s]!;
      if (src.length === 0) continue;
      const topC = src[src.length - 1]!;
      let runLen = 1;
      for (let i = src.length - 2; i >= 0; i--) {
        if (src[i] === topC) runLen++;
        else break;
      }
      for (let d = 0; d < totalTubes; d++) {
        if (s === d) continue;
        const dst = work[d]!;
        if (dst.length >= TUBE_CAP) continue;
        if (dst.length === 0 || dst[dst.length - 1] === topC) {
          const pairId = s * 100 + d;
          if (pairId === lastPair) continue;
          const room = TUBE_CAP - dst.length;
          const maxUnits = Math.min(runLen, room);
          if (maxUnits <= 0) continue;
          candidates.push({ src: s, dst: d, maxUnits });
        }
      }
    }
    if (candidates.length === 0) break;
    const pick = candidates[Math.floor(Math.random() * candidates.length)]!;
    const src = work[pick.src]!;
    const dst = work[pick.dst]!;
    // Random partial pour.
    let units = 1 + Math.floor(Math.random() * pick.maxUnits);
    // Mono-full kaynaktan tam dökmeyi (rotasyon) önle.
    if (isMonoFullTube(src) && dst.length === 0 && units === src.length) {
      units = Math.max(1, units - 1);
    }
    // Tahmini: bu hamleden sonra dst mono-full olur mu? Olursa kısalt.
    const topC = src[src.length - 1]!;
    const dstAfter = dst.length + units;
    if (dstAfter === TUBE_CAP) {
      // Tüm dst aynı renk mi olacak?
      let allSame = true;
      for (const v of dst) if (v !== topC) { allSame = false; break; }
      if (allSame && units > 0) units = Math.max(1, units - 1);
    }
    for (let i = 0; i < units; i++) {
      dst.push(src.pop()!);
    }
    lastPair = pick.dst * 100 + pick.src;
  }

  return work;
}

function isMonoFullTube(t: number[]): boolean {
  if (t.length !== TUBE_CAP) return false;
  const c = t[0]!;
  return t.every((v) => v === c);
}

function shuffleInPlace<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
}

// -------------------- Game lifecycle --------------------

function startLevel(lv: number, freshPuzzle = true): void {
  resetToken++;
  animating = null;
  selectedIdx = null;
  won = false;
  moves = 0;
  history = [];
  level = lv;

  if (freshPuzzle) {
    const gen = generatePuzzle(lv);
    tubes = gen.tubes.map((t) => t.slice());
    numColors = gen.colors;
    numEmpty = gen.empty;
    initialTubes = clone(tubes);
  } else {
    tubes = clone(initialTubes);
    // numColors/numEmpty already set
  }

  persistLevel();
  persistState();
  updateHud();
  renderBoard();
  hideOverlay();
}

function restartCurrentPuzzle(): void {
  // Mevcut puzzle'ı tekrar oyna — generation tekrar etme.
  if (initialTubes.length === 0) {
    startLevel(level, true);
    return;
  }
  startLevel(level, false);
}

function nextLevel(): void {
  level = level + 1;
  startLevel(level, true);
}

function loadOrInit(): void {
  const saved = loadState();
  if (saved && saved.tubes.length > 0) {
    level = saved.level;
    tubes = saved.tubes.map((t) => t.slice());
    history = saved.history.map((h) => h.map((t) => t.slice()));
    moves = saved.moves;
    numColors = saved.numColors;
    numEmpty = saved.numEmpty;
    initialTubes = clone(tubes); // restart, kaldığın yerden başlar
    persistLevel();
    updateHud();
    renderBoard();
    if (isSolved()) {
      // Daha önce çözülmüş ama overlay kapatılmamış bir state ise yeni
      // seviyeyi otomatik başlatma (kullanıcı seçsin) → overlay göster.
      showWin();
    }
    return;
  }
  startLevel(level, true);
}

// -------------------- Pour action --------------------

function tryPour(srcIdx: number, dstIdx: number): boolean {
  if (animating !== null || won) return false;
  if (!canPour(srcIdx, dstIdx)) return false;
  const units = pourUnits(srcIdx, dstIdx);
  if (units <= 0) return false;
  const src = tubes[srcIdx]!;
  const color = src[src.length - 1]!;

  // History snapshot — undo öncesi.
  history.push(clone(tubes));
  if (history.length > 50) history.shift();

  // Animasyon başlat. Sıvı görsel olarak kaynaktan akar; ama state
  // güncellemesi animasyon bitiminde uygulanır (visual sync).
  animating = {
    fromIdx: srcIdx,
    toIdx: dstIdx,
    color,
    units,
  };

  // Kaynaktan üst katmanları HEMEN kaldırma — animasyonda bunlar "akıyor"
  // gibi görünmeli. Bu yüzden state'i animasyon bitiminde mutate ediyoruz.
  const myToken = resetToken;
  window.setTimeout(() => {
    if (myToken !== resetToken) return; // stale-async-callback guard
    if (!animating) return;
    // State mutate: src'den n adet üstte aynı renk varsa pop, dst'ye push.
    const s = tubes[srcIdx]!;
    const d = tubes[dstIdx]!;
    for (let i = 0; i < units; i++) {
      if (s.length === 0) break;
      if (s[s.length - 1] !== color) break;
      if (d.length >= TUBE_CAP) break;
      d.push(s.pop()!);
    }
    moves++;
    animating = null;
    selectedIdx = null;
    updateHud();
    renderBoard();
    persistState();
    if (isSolved()) {
      handleWin();
    }
  }, POUR_MS);

  renderBoard();
  return true;
}

function undo(): void {
  if (animating !== null || won) return;
  const prev = history.pop();
  if (!prev) return;
  tubes = prev.map((t) => t.slice());
  moves = Math.max(0, moves - 1);
  selectedIdx = null;
  updateHud();
  renderBoard();
  persistState();
}

function handleWin(): void {
  won = true;
  // En iyi hamle sayısını seviye bazında kaydet.
  const key = String(level);
  const prevBest = bestMoves[key];
  if (typeof prevBest !== 'number' || moves < prevBest) {
    bestMoves[key] = moves;
    persistBest();
  }
  reportGameOver(SCORE_DESC, moves, { label: 'Hamle' });
  updateHud();
  showWin();
}

function showWin(): void {
  const key = String(level);
  const best = bestMoves[key];
  overlayTitleEl.textContent = 'Tebrikler!';
  const bestStr = typeof best === 'number' ? best.toString() : moves.toString();
  overlayMsgEl.textContent = `Seviye ${level} · ${moves} hamle · en iyi: ${bestStr}`;
  overlayNextBtn.textContent = 'Sonraki seviye';
  overlayEl.classList.remove('ws-overlay--hidden');
  overlayEl.setAttribute('aria-hidden', 'false');
}

function hideOverlay(): void {
  overlayEl.classList.add('ws-overlay--hidden');
  overlayEl.setAttribute('aria-hidden', 'true');
}

// -------------------- Selection / input --------------------

function onTubeClick(idx: number): void {
  if (animating !== null || won) return;
  if (selectedIdx === null) {
    // Boş tüp seçmek mantıksız.
    if (tubes[idx]!.length === 0) return;
    selectedIdx = idx;
    renderBoard();
    return;
  }
  if (selectedIdx === idx) {
    // Aynı tüpe tekrar tıklamak deselect.
    selectedIdx = null;
    renderBoard();
    return;
  }
  // Hedefe dök; geçersizse hedefi yeni seçim yap (mantıklı UX:
  // kullanıcı yanlışlıkla yanlış kaynak seçtiyse).
  const ok = tryPour(selectedIdx, idx);
  if (!ok) {
    // Hedef tüp dolu/uygun değil. Yeni seçim olarak değerlendir
    // (ama boşsa deselect).
    if (tubes[idx]!.length === 0) {
      selectedIdx = null;
    } else {
      selectedIdx = idx;
    }
    renderBoard();
  }
}

// -------------------- Rendering --------------------

function updateHud(): void {
  levelEl.textContent = String(level);
  movesEl.textContent = String(moves);
  const key = String(level);
  const best = bestMoves[key];
  bestEl.textContent = typeof best === 'number' ? String(best) : '—';
  undoBtn.disabled = history.length === 0 || animating !== null || won;
  undoBtn.setAttribute('aria-disabled', undoBtn.disabled ? 'true' : 'false');
}

function renderBoard(): void {
  // Tek satırda 6 tüpe kadar; sonrası 2 satıra bölünür (CSS grid yapar).
  // Tüp sayısına göre CSS değişkeni güncelle.
  const n = tubes.length;
  // Desktop: en fazla 7 wide; daha fazlası 2 satıra
  const cols = Math.min(7, n);
  // Mobile: en fazla 5 wide; daha fazlası 2-3 satıra
  const colsSm = Math.min(5, Math.ceil(n / Math.ceil(n / 5)));
  boardEl.style.setProperty('--cols', String(cols));
  boardEl.style.setProperty('--cols-sm', String(colsSm));

  // İlk render veya tüp sayısı değiştiyse DOM'u yeniden kur.
  if (tubeEls.length !== tubes.length) {
    boardEl.innerHTML = '';
    tubeEls = [];
    for (let i = 0; i < tubes.length; i++) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ws-tube';
      btn.setAttribute('aria-label', `Tüp ${i + 1}`);
      btn.dataset.idx = String(i);
      btn.innerHTML =
        '<span class="ws-tube__inner">' +
        '<span class="ws-tube__liquid"></span>' +
        '<span class="ws-tube__rim" aria-hidden="true"></span>' +
        '</span>';
      btn.addEventListener('click', () => onTubeClick(i));
      boardEl.appendChild(btn);
      tubeEls.push(btn);
    }
  }

  for (let i = 0; i < tubes.length; i++) {
    const btn = tubeEls[i]!;
    btn.classList.toggle('ws-tube--selected', selectedIdx === i);
    btn.classList.toggle('ws-tube--complete', isMonoFullTube(tubes[i]!));
    btn.classList.toggle(
      'ws-tube--pouring',
      animating !== null && animating.fromIdx === i,
    );
    btn.classList.toggle(
      'ws-tube--receiving',
      animating !== null && animating.toIdx === i,
    );
    // Hangi tarafa eğileceğini belirle (kaynak hedefin solunda mı sağında mı?)
    if (animating !== null && animating.fromIdx === i) {
      const dir = animating.toIdx > i ? 'right' : 'left';
      btn.dataset.tilt = dir;
    } else {
      delete btn.dataset.tilt;
    }
    const liquid = btn.querySelector<HTMLElement>('.ws-tube__liquid')!;
    renderLiquid(liquid, tubes[i]!);
  }
}

function renderLiquid(el: HTMLElement, tube: number[]): void {
  // En alttan en üste doğru renk katmanları. Bottom 0% → Top 100%.
  // Katman sayısı (TUBE_CAP=4), her katman %25 yükseklik.
  el.innerHTML = '';
  if (tube.length === 0) return;
  const layerPct = 100 / TUBE_CAP;
  for (let i = 0; i < tube.length; i++) {
    const layer = document.createElement('span');
    layer.className = 'ws-layer';
    const color = PALETTE[tube[i]!]!;
    layer.style.background = color;
    // Bottom-up: katman i, %i*25 yüksekliğinden başlar.
    layer.style.bottom = `${i * layerPct}%`;
    layer.style.height = `${layerPct}%`;
    el.appendChild(layer);
  }
}

// -------------------- Init --------------------

function init(): void {
  levelEl = document.querySelector<HTMLElement>('#level')!;
  movesEl = document.querySelector<HTMLElement>('#moves')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  boardEl = document.querySelector<HTMLElement>('#board')!;
  undoBtn = document.querySelector<HTMLButtonElement>('#undo')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  newGameBtn = document.querySelector<HTMLButtonElement>('#new-game')!;
  overlayEl = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitleEl = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsgEl = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayNextBtn = document.querySelector<HTMLButtonElement>('#overlay-next')!;

  level = safeReadNumber(STORAGE_LEVEL, 1);
  bestMoves = safeReadJSON(STORAGE_BEST, {});

  undoBtn.addEventListener('click', () => undo());
  restartBtn.addEventListener('click', () => restartCurrentPuzzle());
  newGameBtn.addEventListener('click', () => startLevel(level, true));

  overlayNextBtn.addEventListener('click', () => {
    nextLevel();
  });

  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (won) {
      if (k === 'enter' || k === 'n' || k === ' ') {
        nextLevel();
        e.preventDefault();
      }
      return;
    }
    if (k === 'z' || (e.metaKey && k === 'z') || (e.ctrlKey && k === 'z')) {
      undo();
      e.preventDefault();
    } else if (k === 'r') {
      restartCurrentPuzzle();
      e.preventDefault();
    } else if (k === 'n') {
      if (won) {
        nextLevel();
        e.preventDefault();
      }
    } else if (k === 'escape') {
      if (selectedIdx !== null) {
        selectedIdx = null;
        renderBoard();
        e.preventDefault();
      }
    }
  });

  loadOrInit();
  updateHud();
}

export const game = defineGame({ init, reset: restartCurrentPuzzle });
