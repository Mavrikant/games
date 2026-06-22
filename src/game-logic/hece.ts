import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOv, hideOverlay as hideOv } from '@shared/overlay';

// Hece — Türkçe kelimeleri hecelerine ayırarak doğru sırada seçtiğin özgün bir
// kelime/refleks oyunu. Mekanik: nilüfer yapraklarındaki heceleri sıraya göre
// tıkla, kurbağa o yaprağa atlasın. Doğru yapraklar yeşil, yanlış yaparsan
// kısa kırmızı titreşim + 2 saniye ceza. Her tamamlanan kelime +3 saniye bonus.
//
// PITFALLS guarded:
// - unguarded-storage: safeRead/safeWrite kullanılıyor.
// - stale-async-callback: token-based scheduling; reset() token'ı bump'lar.
// - overlay-input-leak: explicit state machine; tıklama/keydown state'e göre
//   guard'lanıyor.
// - module-level-dom-access: tüm DOM erişimi init() içinde.
// - missing-overlay-css: hece.css içinde .overlay--hidden display+opacity reset.

const STORAGE_BEST = 'hece.best';
const ROUND_SECONDS = 60;
const PAD_COUNT = 6;
const TIME_BONUS_PER_WORD = 3;
const MISS_PENALTY_S = 2;
const WRONG_FLASH_MS = 400;

type State = 'ready' | 'playing' | 'gameover';

interface Word {
  text: string;
  syllables: string[];
}

// Türkçe hece listesi. Her kelime önceden hecelere ayrılmış (UTF-8 büyük harf).
const WORDS: Word[] = [
  // 2 heceli — kolay
  { text: 'ELMA', syllables: ['EL', 'MA'] },
  { text: 'KAPI', syllables: ['KA', 'PI'] },
  { text: 'BALIK', syllables: ['BA', 'LIK'] },
  { text: 'KEDİ', syllables: ['KE', 'Dİ'] },
  { text: 'KUZU', syllables: ['KU', 'ZU'] },
  { text: 'AYNA', syllables: ['AY', 'NA'] },
  { text: 'KULE', syllables: ['KU', 'LE'] },
  { text: 'ARMUT', syllables: ['AR', 'MUT'] },
  { text: 'KARPUZ', syllables: ['KAR', 'PUZ'] },
  { text: 'KALEM', syllables: ['KA', 'LEM'] },
  { text: 'SEPET', syllables: ['SE', 'PET'] },
  { text: 'KÖPEK', syllables: ['KÖ', 'PEK'] },
  { text: 'BULUT', syllables: ['BU', 'LUT'] },
  { text: 'KUMSAL', syllables: ['KUM', 'SAL'] },
  { text: 'BAYRAK', syllables: ['BAY', 'RAK'] },
  { text: 'SOKAK', syllables: ['SO', 'KAK'] },
  { text: 'ŞEKER', syllables: ['ŞE', 'KER'] },
  { text: 'TOPRAK', syllables: ['TOP', 'RAK'] },
  { text: 'DENİZ', syllables: ['DE', 'NİZ'] },
  { text: 'ŞEHİR', syllables: ['ŞE', 'HİR'] },
  { text: 'GÖZLÜK', syllables: ['GÖZ', 'LÜK'] },
  { text: 'YILDIZ', syllables: ['YIL', 'DIZ'] },
  { text: 'BAHÇE', syllables: ['BAH', 'ÇE'] },
  { text: 'FINDIK', syllables: ['FIN', 'DIK'] },
  { text: 'ÇORAP', syllables: ['ÇO', 'RAP'] },

  // 3 heceli — orta
  { text: 'ANKARA', syllables: ['AN', 'KA', 'RA'] },
  { text: 'KELEBEK', syllables: ['KE', 'LE', 'BEK'] },
  { text: 'PENCERE', syllables: ['PEN', 'CE', 'RE'] },
  { text: 'PAPATYA', syllables: ['PA', 'PAT', 'YA'] },
  { text: 'KARAKOL', syllables: ['KA', 'RA', 'KOL'] },
  { text: 'KIRMIZI', syllables: ['KIR', 'MI', 'ZI'] },
  { text: 'DOMATES', syllables: ['DO', 'MA', 'TES'] },
  { text: 'PORTAKAL', syllables: ['POR', 'TA', 'KAL'] },
  { text: 'MERHABA', syllables: ['MER', 'HA', 'BA'] },

  // 4-5 heceli — zor
  { text: 'BALKABAĞI', syllables: ['BAL', 'KA', 'BA', 'ĞI'] },
  { text: 'OKULUMUZ', syllables: ['O', 'KU', 'LU', 'MUZ'] },
  { text: 'KÜTÜPHANE', syllables: ['KÜ', 'TÜP', 'HA', 'NE'] },
  { text: 'KARAHİNDİBA', syllables: ['KA', 'RA', 'HİN', 'Dİ', 'BA'] },
];

const ALL_SYLLABLES = Array.from(new Set(WORDS.flatMap((w) => w.syllables)));

interface Pad {
  syllable: string;
  correctPos: number | null;
  el: HTMLButtonElement;
}

let state: State = 'ready';
let score = 0;
let best = 0;
let timeLeft = ROUND_SECONDS;
let token = 0;
let timerHandle: number | null = null;
let timeoutIds: number[] = [];

let currentWord: Word | null = null;
let nextSyllableIdx = 0;
let recentWordIdxs: number[] = [];
let pads: Pad[] = [];

let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let timeEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let wordBoxesEl!: HTMLElement;
let padsEl!: HTMLElement;
let frogEl!: HTMLElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayBtn!: HTMLButtonElement;

function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = a[i]!;
    a[i] = a[j]!;
    a[j] = tmp;
  }
  return a;
}

function scheduleAt(ms: number, fn: () => void): void {
  const myToken = token;
  const id = window.setTimeout(() => {
    if (myToken !== token) return;
    fn();
  }, ms);
  timeoutIds.push(id);
}

function clearAllTimers(): void {
  for (const id of timeoutIds) clearTimeout(id);
  timeoutIds = [];
  if (timerHandle !== null) {
    clearInterval(timerHandle);
    timerHandle = null;
  }
}

function pickNextWord(): Word {
  const skip = new Set(recentWordIdxs);
  const candidates: number[] = [];
  for (let i = 0; i < WORDS.length; i++) {
    if (!skip.has(i)) candidates.push(i);
  }
  const safePool =
    candidates.length > 0
      ? candidates
      : Array.from({ length: WORDS.length }, (_, i) => i);
  const idx = safePool[Math.floor(Math.random() * safePool.length)]!;
  recentWordIdxs.push(idx);
  if (recentWordIdxs.length > 5) recentWordIdxs.shift();
  return WORDS[idx]!;
}

function renderWordBoxes(): void {
  wordBoxesEl.innerHTML = '';
  if (!currentWord) return;
  for (let i = 0; i < currentWord.syllables.length; i++) {
    const box = document.createElement('span');
    box.className = 'he-box';
    if (i < nextSyllableIdx) {
      box.classList.add('he-box--filled');
    } else if (i === nextSyllableIdx) {
      box.classList.add('he-box--next');
    } else {
      box.classList.add('he-box--pending');
    }
    box.textContent = currentWord.syllables[i]!;
    wordBoxesEl.appendChild(box);
  }
}

function rebuildPads(): void {
  if (!currentWord) {
    padsEl.innerHTML = '';
    pads = [];
    return;
  }
  const correct = currentWord.syllables.slice();
  const decoyPool = ALL_SYLLABLES.filter((s) => !correct.includes(s));
  const targetPadCount = Math.max(PAD_COUNT, correct.length + 2);
  const decoyCount = Math.max(0, targetPadCount - correct.length);
  const decoys = shuffle(decoyPool).slice(0, decoyCount);

  const padItems: Array<{ syllable: string; correctPos: number | null }> = [];
  correct.forEach((s, i) => padItems.push({ syllable: s, correctPos: i }));
  decoys.forEach((s) => padItems.push({ syllable: s, correctPos: null }));
  const shuffled = shuffle(padItems);

  padsEl.innerHTML = '';
  pads = [];
  shuffled.forEach((item, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'he-pad';
    btn.textContent = item.syllable;
    btn.setAttribute('aria-label', `Hece ${item.syllable}`);
    btn.dataset.idx = String(i);
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      onPadTap(i);
    });
    padsEl.appendChild(btn);
    pads.push({ syllable: item.syllable, correctPos: item.correctPos, el: btn });
  });

  positionFrog(-1);
}

function positionFrog(padIdx: number): void {
  if (padIdx < 0 || padIdx >= pads.length) {
    frogEl.style.transform = 'translateX(0)';
    frogEl.style.opacity = '0.55';
    return;
  }
  const pad = pads[padIdx]!;
  const padRect = pad.el.getBoundingClientRect();
  const strip = frogEl.parentElement!;
  const stripRect = strip.getBoundingClientRect();
  const targetX =
    padRect.left + padRect.width / 2 - stripRect.left - frogEl.offsetWidth / 2;
  frogEl.style.transform = `translateX(${targetX}px)`;
  frogEl.style.opacity = '1';
}

function onPadTap(padIdx: number): void {
  if (state !== 'playing') return;
  if (!currentWord) return;
  const pad = pads[padIdx];
  if (!pad) return;
  if (pad.el.classList.contains('he-pad--used')) return;

  if (pad.correctPos === nextSyllableIdx) {
    pad.el.classList.remove('he-pad--wrong');
    pad.el.classList.add('he-pad--correct', 'he-pad--used');
    nextSyllableIdx++;
    renderWordBoxes();
    positionFrog(padIdx);

    if (nextSyllableIdx >= currentWord.syllables.length) {
      addScore(1);
      addTime(TIME_BONUS_PER_WORD);
      scheduleAt(380, () => loadNextWord());
    }
  } else {
    pad.el.classList.remove('he-pad--correct');
    pad.el.classList.add('he-pad--wrong');
    addTime(-MISS_PENALTY_S);
    scheduleAt(WRONG_FLASH_MS, () => {
      pad.el.classList.remove('he-pad--wrong');
    });
  }
}

function addScore(delta: number): void {
  score += delta;
  scoreEl.textContent = String(score);
  if (score > best) {
    best = score;
    bestEl.textContent = String(best);
    safeWrite(STORAGE_BEST, best);
  }
}

function addTime(delta: number): void {
  timeLeft = Math.max(0, timeLeft + delta);
  timeEl.textContent = String(timeLeft);
  if (timeLeft <= 0 && state === 'playing') {
    endGame();
  }
}

function loadNextWord(): void {
  if (state !== 'playing') return;
  currentWord = pickNextWord();
  nextSyllableIdx = 0;
  renderWordBoxes();
  rebuildPads();
}

function startGame(): void {
  token++;
  clearAllTimers();
  state = 'playing';
  score = 0;
  timeLeft = ROUND_SECONDS;
  nextSyllableIdx = 0;
  recentWordIdxs = [];
  scoreEl.textContent = '0';
  timeEl.textContent = String(ROUND_SECONDS);
  bestEl.textContent = String(best);
  hideOv(overlay);
  loadNextWord();
  timerHandle = window.setInterval(() => {
    if (state !== 'playing') return;
    timeLeft--;
    if (timeLeft < 0) timeLeft = 0;
    timeEl.textContent = String(timeLeft);
    if (timeLeft <= 0) endGame();
  }, 1000);
}

function endGame(): void {
  if (state === 'gameover') return;
  state = 'gameover';
  token++;
  clearAllTimers();
  const isNewBest = score >= best && score > 0;
  const title = isNewBest ? 'Yeni rekor!' : 'Süre doldu!';
  overlayTitle.textContent = title;
  overlayMsg.textContent =
    `Skor: ${score} kelime  •  En iyi: ${best}\n` +
    'Tekrar denemek için butona bas veya Boşluk/Enter.';
  overlayBtn.textContent = 'Tekrar';
  showOv(overlay);
}

function resetToReady(): void {
  token++;
  clearAllTimers();
  state = 'ready';
  score = 0;
  timeLeft = ROUND_SECONDS;
  nextSyllableIdx = 0;
  recentWordIdxs = [];
  currentWord = null;
  scoreEl.textContent = '0';
  timeEl.textContent = String(ROUND_SECONDS);
  bestEl.textContent = String(best);
  wordBoxesEl.innerHTML = '';
  padsEl.innerHTML = '';
  pads = [];
  positionFrog(-1);
  overlayTitle.textContent = 'Hece';
  overlayMsg.textContent =
    'Hedef kelimenin hecelerini doğru sırada nilüfer yapraklarından seç. ' +
    '60 saniyede mümkün olduğunca çok kelime tamamla.';
  overlayBtn.textContent = 'Başla';
  showOv(overlay);
}

function onKey(e: KeyboardEvent): void {
  const k = e.key.toLowerCase();
  if (k === 'r') {
    e.preventDefault();
    resetToReady();
    return;
  }
  if (state !== 'playing') {
    if (k === ' ' || k === 'enter') {
      e.preventDefault();
      startGame();
    }
    return;
  }
  if (k >= '1' && k <= '9') {
    const idx = Number(k) - 1;
    if (idx >= 0 && idx < pads.length) {
      e.preventDefault();
      onPadTap(idx);
    }
  }
}

function onResize(): void {
  let lastUsed = -1;
  for (let i = 0; i < pads.length; i++) {
    if (pads[i]!.el.classList.contains('he-pad--used')) lastUsed = i;
  }
  positionFrog(lastUsed);
}

function init(): void {
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  timeEl = document.querySelector<HTMLElement>('#time')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  wordBoxesEl = document.querySelector<HTMLElement>('#word-boxes')!;
  padsEl = document.querySelector<HTMLElement>('#pads')!;
  frogEl = document.querySelector<HTMLElement>('#frog')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;

  const storedBest = safeRead<number>(STORAGE_BEST, 0);
  best =
    typeof storedBest === 'number' && Number.isFinite(storedBest) && storedBest >= 0
      ? storedBest
      : 0;

  overlayBtn.addEventListener('click', () => {
    if (state === 'playing') return;
    startGame();
  });
  restartBtn.addEventListener('click', () => {
    resetToReady();
  });
  window.addEventListener('keydown', onKey);
  window.addEventListener('resize', onResize);

  resetToReady();
}

export const game = defineGame({ init, reset: resetToReady });
