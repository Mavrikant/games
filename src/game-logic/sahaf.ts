import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';

const STORAGE_BEST = 'sahaf.best';
const ROWS = 4;
const COLS = 4;
const BOOKS = ROWS * COLS;
const MAX_LIVES = 3;
const START_TIME = 8.0;
const MIN_TIME = 3.0;
const TIME_STEP = 0.25;
const FLASH_MS = 320;

interface BookColor {
  name: string;
  bg: string;
  fg: string;
}

const COLORS: ReadonlyArray<BookColor> = [
  { name: 'kırmızı', bg: '#d44a4a', fg: '#fff' },
  { name: 'mavi', bg: '#3a73c4', fg: '#fff' },
  { name: 'yeşil', bg: '#3e9d5f', fg: '#fff' },
  { name: 'sarı', bg: '#e0b13d', fg: '#241a05' },
  { name: 'mor', bg: '#8a4ec8', fg: '#fff' },
  { name: 'turuncu', bg: '#e07d3d', fg: '#fff' },
];

interface Emblem {
  name: string;
  glyph: string;
}

const EMBLEMS: ReadonlyArray<Emblem> = [
  { name: 'yıldız', glyph: '★' },
  { name: 'daire', glyph: '●' },
  { name: 'üçgen', glyph: '▲' },
  { name: 'kare', glyph: '■' },
  { name: 'artı', glyph: '✚' },
  { name: 'baklava', glyph: '◆' },
];

interface Book {
  colorIdx: number;
  emblemIdx: number;
  number: number;
}

type State = 'ready' | 'playing' | 'gameover';

const gen = createGenToken();
let state: State = 'ready';
let score = 0;
let best = 0;
let lives = MAX_LIVES;
let round = 0;
let timeLeft = 0;
let timeLimit = START_TIME;
let books: Book[] = [];
let targetIdx = 0;
let lastFrameMs = 0;
let rafHandle: number | null = null;

let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let livesEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let shelfEl!: HTMLElement;
let wantColorEl!: HTMLElement;
let wantEmblemEl!: HTMLElement;
let wantNumberEl!: HTMLElement;
let timeBarEl!: HTMLElement;
let overlayEl!: HTMLElement;
let overlayTitleEl!: HTMLElement;
let overlayMsgEl!: HTMLElement;
let overlayBtn!: HTMLButtonElement;
let bookButtons: HTMLButtonElement[] = [];

function randInt(n: number): number {
  return Math.floor(Math.random() * n);
}

function randomBook(): Book {
  return {
    colorIdx: randInt(COLORS.length),
    emblemIdx: randInt(EMBLEMS.length),
    number: randInt(9) + 1,
  };
}

function sameBook(a: Book, b: Book): boolean {
  return a.colorIdx === b.colorIdx && a.emblemIdx === b.emblemIdx && a.number === b.number;
}

function generateRound(): void {
  books = Array.from({ length: BOOKS }, randomBook);
  targetIdx = randInt(BOOKS);
  const target = books[targetIdx]!;
  for (let i = 0; i < BOOKS; i++) {
    if (i === targetIdx) continue;
    let attempt = 0;
    while (sameBook(books[i]!, target) && attempt < 10) {
      const next = (books[i]!.number % 9) + 1;
      books[i] = { ...books[i]!, number: next };
      attempt++;
    }
  }
}

function renderShelf(): void {
  for (let i = 0; i < BOOKS; i++) {
    const b = books[i]!;
    const btn = bookButtons[i]!;
    const color = COLORS[b.colorIdx]!;
    btn.style.background = color.bg;
    btn.style.color = color.fg;
    btn.classList.remove('book--wrong', 'book--right');
    btn.disabled = state !== 'playing';
    const emblemSpan = btn.querySelector<HTMLElement>('.book__emblem')!;
    const numberSpan = btn.querySelector<HTMLElement>('.book__number')!;
    emblemSpan.textContent = EMBLEMS[b.emblemIdx]!.glyph;
    numberSpan.textContent = String(b.number);
    btn.setAttribute(
      'aria-label',
      `${color.name} kapaklı, ${EMBLEMS[b.emblemIdx]!.name} işaretli, ${b.number} numara`,
    );
  }
}

function renderRequest(): void {
  const t = books[targetIdx]!;
  const color = COLORS[t.colorIdx]!;
  const emblem = EMBLEMS[t.emblemIdx]!;
  wantColorEl.style.background = color.bg;
  wantColorEl.style.color = color.fg;
  wantColorEl.textContent = color.name;
  wantEmblemEl.textContent = `${emblem.glyph} ${emblem.name}`;
  wantNumberEl.textContent = `№ ${t.number}`;
}

function renderHud(): void {
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
  livesEl.textContent = lives > 0 ? '♥ '.repeat(lives).trim() : '—';
}

function renderTimeBar(): void {
  const pct = Math.max(0, Math.min(1, timeLeft / timeLimit));
  timeBarEl.style.width = `${(pct * 100).toFixed(1)}%`;
  timeBarEl.classList.toggle('request__time-bar--low', pct < 0.3);
}

function delayed(ms: number, fn: () => void): void {
  const myGen = gen.current();
  window.setTimeout(() => {
    if (!gen.isCurrent(myGen)) return;
    fn();
  }, ms);
}

function stopRoundTimer(): void {
  if (rafHandle !== null) {
    cancelAnimationFrame(rafHandle);
    rafHandle = null;
  }
}

function startRoundTimer(): void {
  stopRoundTimer();
  lastFrameMs = performance.now();
  const myGen = gen.current();
  const step = (now: number): void => {
    if (!gen.isCurrent(myGen) || state !== 'playing') {
      rafHandle = null;
      return;
    }
    const dt = (now - lastFrameMs) / 1000;
    lastFrameMs = now;
    timeLeft -= dt;
    if (timeLeft <= 0) {
      timeLeft = 0;
      renderTimeBar();
      rafHandle = null;
      handleTimeout();
      return;
    }
    renderTimeBar();
    rafHandle = requestAnimationFrame(step);
  };
  rafHandle = requestAnimationFrame(step);
}

function commitBest(): void {
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
}

function startGame(): void {
  gen.bump();
  state = 'playing';
  score = 0;
  lives = MAX_LIVES;
  round = 0;
  renderHud();
  hideOverlayEl(overlayEl);
  nextRound();
}

function nextRound(): void {
  stopRoundTimer();
  round++;
  timeLimit = Math.max(MIN_TIME, START_TIME - (round - 1) * TIME_STEP);
  timeLeft = timeLimit;
  generateRound();
  renderShelf();
  renderRequest();
  renderTimeBar();
  startRoundTimer();
}

function endGame(): void {
  state = 'gameover';
  stopRoundTimer();
  commitBest();
  renderHud();
  for (const btn of bookButtons) btn.disabled = true;
  overlayTitleEl.textContent = 'Tezgâh kapandı';
  overlayMsgEl.textContent = `Skor: ${score} · Rekor: ${best}\nYeniden başlamak için tıkla.`;
  overlayBtn.textContent = 'Tekrar oyna';
  showOverlayEl(overlayEl);
}

function flashBook(idx: number, kind: 'right' | 'wrong'): void {
  const btn = bookButtons[idx]!;
  btn.classList.add(kind === 'right' ? 'book--right' : 'book--wrong');
}

function lockShelf(): void {
  for (const btn of bookButtons) btn.disabled = true;
}

function loseLife(): void {
  lives--;
  renderHud();
  if (lives <= 0) {
    delayed(FLASH_MS, endGame);
    return;
  }
  delayed(FLASH_MS, () => {
    if (state === 'playing') nextRound();
  });
}

function handleTimeout(): void {
  if (state !== 'playing') return;
  flashBook(targetIdx, 'right');
  lockShelf();
  loseLife();
}

function onPickBook(idx: number): void {
  if (state !== 'playing') return;
  stopRoundTimer();
  lockShelf();
  if (idx === targetIdx) {
    score++;
    commitBest();
    renderHud();
    flashBook(idx, 'right');
    delayed(FLASH_MS, () => {
      if (state === 'playing') nextRound();
    });
  } else {
    flashBook(idx, 'wrong');
    flashBook(targetIdx, 'right');
    loseLife();
  }
}

function buildShelf(): void {
  shelfEl.replaceChildren();
  bookButtons = [];
  for (let i = 0; i < BOOKS; i++) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'book';
    btn.setAttribute('role', 'gridcell');
    const emblem = document.createElement('span');
    emblem.className = 'book__emblem';
    const number = document.createElement('span');
    number.className = 'book__number';
    btn.append(emblem, number);
    btn.addEventListener('click', () => onPickBook(i));
    shelfEl.appendChild(btn);
    bookButtons.push(btn);
  }
}

function reset(): void {
  gen.bump();
  stopRoundTimer();
  state = 'ready';
  score = 0;
  lives = MAX_LIVES;
  round = 0;
  timeLimit = START_TIME;
  timeLeft = START_TIME;
  renderHud();
  generateRound();
  renderShelf();
  renderRequest();
  timeBarEl.style.width = '100%';
  timeBarEl.classList.remove('request__time-bar--low');
  lockShelf();
  overlayTitleEl.textContent = 'Sahaf';
  overlayMsgEl.textContent =
    'Müşterinin tarif ettiği kitabı raftan zamanında bul. Yanlış seçim veya süre dolması bir can götürür.';
  overlayBtn.textContent = 'Başla';
  showOverlayEl(overlayEl);
}

function init(): void {
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  livesEl = document.querySelector<HTMLElement>('#lives')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  shelfEl = document.querySelector<HTMLElement>('#shelf')!;
  wantColorEl = document.querySelector<HTMLElement>('#want-color')!;
  wantEmblemEl = document.querySelector<HTMLElement>('#want-emblem')!;
  wantNumberEl = document.querySelector<HTMLElement>('#want-number')!;
  timeBarEl = document.querySelector<HTMLElement>('#time-bar')!;
  overlayEl = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitleEl = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsgEl = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  buildShelf();

  overlayBtn.addEventListener('click', () => {
    if (state !== 'playing') startGame();
  });
  restartBtn.addEventListener('click', reset);

  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'r') {
      reset();
      e.preventDefault();
    } else if ((k === ' ' || k === 'enter') && state !== 'playing') {
      startGame();
      e.preventDefault();
    }
  });

  reset();
}

export const game = defineGame({ init, reset });
