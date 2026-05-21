import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';

type Difficulty = 'easy' | 'medium' | 'hard';

interface DiffConfig {
  cols: number;
  rows: number;
}

const DIFFS: Record<Difficulty, DiffConfig> = {
  easy: { cols: 4, rows: 3 },
  medium: { cols: 4, rows: 4 },
  hard: { cols: 6, rows: 4 },
};

const EMOJI = ['🍒', '🍋', '🍇', '🍉', '🍑', '🥝', '🍓', '🥥', '🍍', '🥑', '🥭', '🌶'];

const STORAGE_BEST = 'memory.best';
const STORAGE_DIFF = 'memory.difficulty';
const FLIP_BACK_MS = 750;

let board!: HTMLElement;
let movesEl!: HTMLElement;
let timeEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let diffBtns: HTMLButtonElement[] = [];
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayRestart!: HTMLButtonElement;

interface Best {
  moves: number;
  time: number;
}
type BestMap = Partial<Record<Difficulty, Best>>;

interface Card {
  symbol: string;
  matched: boolean;
  revealed: boolean;
}

let difficulty: Difficulty = 'medium';
let bestMap: BestMap = {};

let cards: Card[] = [];
let cardEls: HTMLButtonElement[] = [];
let flipped: number[] = [];
let moves = 0;
let elapsedSec = 0;
let startTime = 0;
let timerHandle: number | null = null;
let lock = false;
let won = false;
const gen = createGenToken();

function loadBest(): BestMap {
  const v = safeRead<BestMap | null>(STORAGE_BEST, null);
  if (!v || typeof v !== 'object') return {};
  return v;
}

function saveBest(): void {
  safeWrite(STORAGE_BEST, bestMap);
}

/**
 * Difficulty is stored as a raw string (not JSON-encoded) to remain
 * compatible with the format from before the @shared/storage migration.
 * Wrapped in try/catch for Safari private mode.
 */
function loadDifficulty(): Difficulty {
  let raw = '';
  try {
    raw = localStorage.getItem(STORAGE_DIFF) ?? '';
  } catch {
    /* Safari private mode etc. */
  }
  if (raw === 'easy' || raw === 'medium' || raw === 'hard') return raw;
  return 'medium';
}

function saveDifficulty(): void {
  try {
    localStorage.setItem(STORAGE_DIFF, difficulty);
  } catch {
    /* ignore */
  }
}

function setDifficulty(d: Difficulty): void {
  difficulty = d;
  saveDifficulty();
  startGame();
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = a[i]!;
    a[i] = a[j]!;
    a[j] = tmp;
  }
  return a;
}

function startGame(): void {
  gen.bump();
  hideOverlay();
  stopTimer();
  const { cols, rows } = DIFFS[difficulty];
  const total = cols * rows;
  const pairs = total / 2;
  const symbols = EMOJI.slice(0, pairs);
  const deck = shuffle([...symbols, ...symbols]);
  cards = deck.map((symbol) => ({ symbol, matched: false, revealed: false }));
  flipped = [];
  moves = 0;
  elapsedSec = 0;
  startTime = 0;
  lock = false;
  won = false;
  movesEl.textContent = '0';
  timeEl.textContent = '0:00';
  renderBest();
  renderDiff();
  renderBoard();
}

function renderDiff(): void {
  diffBtns.forEach((btn) => {
    btn.classList.toggle(
      'diff__btn--active',
      btn.dataset.diff === difficulty,
    );
  });
}

function renderBest(): void {
  const b = bestMap[difficulty];
  bestEl.textContent = b ? String(b.moves) : '—';
}

function renderBoard(): void {
  const { cols } = DIFFS[difficulty];
  board.style.setProperty('--cols', String(cols));
  board.innerHTML = '';
  cardEls = cards.map((card, i) => {
    const btn = document.createElement('button');
    btn.className = 'card';
    btn.type = 'button';
    btn.dataset.i = String(i);
    btn.setAttribute('aria-label', `Kart ${i + 1}`);
    btn.innerHTML =
      '<span class="card__inner">' +
      '<span class="card__face card__face--back" aria-hidden="true"></span>' +
      `<span class="card__face card__face--front" aria-hidden="true">${card.symbol}</span>` +
      '</span>';
    btn.addEventListener('click', () => onCardClick(i));
    board.appendChild(btn);
    return btn;
  });
}

function onCardClick(i: number): void {
  if (lock || won) return;
  const card = cards[i];
  if (!card || card.revealed || card.matched) return;

  if (timerHandle === null) startTimer();

  card.revealed = true;
  flipped.push(i);
  updateCardEl(i);

  if (flipped.length < 2) return;

  moves++;
  movesEl.textContent = String(moves);

  const a = flipped[0]!;
  const b = flipped[1]!;
  if (cards[a]!.symbol === cards[b]!.symbol) {
    cards[a]!.matched = true;
    cards[b]!.matched = true;
    flipped = [];
    updateCardEl(a);
    updateCardEl(b);
    if (cards.every((c) => c.matched)) win();
  } else {
    lock = true;
    const myGen = gen.current();
    window.setTimeout(() => {
      if (!gen.isCurrent(myGen)) return;
      cards[a]!.revealed = false;
      cards[b]!.revealed = false;
      flipped = [];
      updateCardEl(a);
      updateCardEl(b);
      lock = false;
    }, FLIP_BACK_MS);
  }
}

function updateCardEl(i: number): void {
  const el = cardEls[i];
  const card = cards[i];
  if (!el || !card) return;
  el.classList.toggle('card--revealed', card.revealed || card.matched);
  el.classList.toggle('card--matched', card.matched);
}

function startTimer(): void {
  startTime = Date.now();
  timerHandle = window.setInterval(() => {
    elapsedSec = Math.floor((Date.now() - startTime) / 1000);
    timeEl.textContent = formatTime(elapsedSec);
  }, 250);
}

function stopTimer(): void {
  if (timerHandle !== null) {
    clearInterval(timerHandle);
    timerHandle = null;
  }
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function win(): void {
  stopTimer();
  won = true;
  const prev = bestMap[difficulty];
  const isBest =
    !prev ||
    moves < prev.moves ||
    (moves === prev.moves && elapsedSec < prev.time);
  if (isBest) {
    bestMap[difficulty] = { moves, time: elapsedSec };
    saveBest();
    renderBest();
  }
  overlayTitle.textContent = isBest ? 'Yeni rekor!' : 'Tebrikler!';
  overlayMsg.textContent = `${moves} hamle · ${formatTime(elapsedSec)}`;
  showOverlayEl(overlay);
}

function hideOverlay(): void {
  hideOverlayEl(overlay);
}

function init(): void {
  board = document.querySelector<HTMLElement>('#board')!;
  movesEl = document.querySelector<HTMLElement>('#moves')!;
  timeEl = document.querySelector<HTMLElement>('#time')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  diffBtns = Array.from(
    document.querySelectorAll<HTMLButtonElement>('.diff__btn'),
  );
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayRestart = document.querySelector<HTMLButtonElement>('#overlay-restart')!;

  difficulty = loadDifficulty();
  bestMap = loadBest();

  diffBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const d = btn.dataset.diff;
      if (d === 'easy' || d === 'medium' || d === 'hard') setDifficulty(d);
    });
  });

  restartBtn.addEventListener('click', startGame);
  overlayRestart.addEventListener('click', startGame);

  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'r') {
      startGame();
      e.preventDefault();
    } else if (k === '1') {
      setDifficulty('easy');
      e.preventDefault();
    } else if (k === '2') {
      setDifficulty('medium');
      e.preventDefault();
    } else if (k === '3') {
      setDifficulty('hard');
      e.preventDefault();
    }
  });

  startGame();
}

export const game = defineGame({ init, reset: startGame });
