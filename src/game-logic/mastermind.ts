// Mastermind — klasik kod-kırma.
// Bilgisayar 4 peg'lik bir gizli kod üretir (renk seti zorluğa göre değişir).

import { defineGame } from '@shared/game-module';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';
// Oyuncunun 10 denemesi var. Her tahmin sonrası geri bildirim:
//   - black peg: doğru renk + doğru pozisyon (code[i] === guess[i])
//   - white peg: doğru renk, yanlış pozisyon (Knuth: çoklu küme kesişimi - black)
// Tekrar serbest: aynı renk kodun birden fazla peg'inde olabilir. Bu yüzden
// "kısmi doğru" sayısını çoklu küme (multiset) intersection ile hesaplıyoruz.

// ---- Sabitler ----

const PEGS = 4;
const MAX_ATTEMPTS = 10;

// Renk paletleri. Token kullanıyoruz; CSS'te bu key'lere göre arka plan
// renkleri tanımlı. Renk-isimleri sadece dahili; aria-label için Türkçe set.
const COLORS_EASY = ['red', 'amber', 'yellow', 'green', 'blue', 'violet'];
const COLORS_HARD = [
  'red',
  'amber',
  'yellow',
  'green',
  'cyan',
  'blue',
  'violet',
  'pink',
];

const COLOR_LABEL_TR: Record<string, string> = {
  red: 'kırmızı',
  amber: 'turuncu',
  yellow: 'sarı',
  green: 'yeşil',
  cyan: 'turkuaz',
  blue: 'mavi',
  violet: 'mor',
  pink: 'pembe',
};

type Difficulty = 'easy' | 'hard';

const STORAGE_WINS = 'mastermind.wins';
const STORAGE_BEST = 'mastermind.best';
const STORAGE_DIFF = 'mastermind.difficulty';

// State machine — input handler her transition'da bu enum'a bakar.
type GameState = 'playing' | 'won' | 'lost';

// ---- DOM refs ----

let boardEl!: HTMLElement;
let attemptEl!: HTMLElement;
let winsEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let submitBtn!: HTMLButtonElement;
let clearBtn!: HTMLButtonElement;
let paletteEl!: HTMLElement;
let paletteInner!: HTMLElement;
let paletteCloseBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayCode!: HTMLElement;
let overlayRestart!: HTMLButtonElement;
let diffBtns: HTMLButtonElement[] = [];

// ---- Storage (safe) ----

/**
 * Reads a raw string from localStorage (not JSON-encoded; preserves the
 * existing mastermind storage format). Use directly when the stored value
 * isn't a JSON document.
 */
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
    /* private mode, disabled, full disk — ignore */
  }
}

function loadWins(): number {
  const raw = safeRead(STORAGE_WINS);
  if (raw === null) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}
function loadBest(): number | null {
  const raw = safeRead(STORAGE_BEST);
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 && n <= MAX_ATTEMPTS ? Math.floor(n) : null;
}
function loadDifficulty(): Difficulty {
  const raw = safeRead(STORAGE_DIFF);
  return raw === 'hard' ? 'hard' : 'easy';
}

// ---- State ----

let difficulty: Difficulty = loadDifficulty();
let colors: string[] = difficulty === 'hard' ? COLORS_HARD : COLORS_EASY;

let code: string[] = [];
let guesses: (string | null)[][] = [];
let feedbacks: { black: number; white: number }[] = [];
let currentRow = 0;
let currentRowPegs: (string | null)[] = new Array(PEGS).fill(null);
let state: GameState = 'playing';

let wins = loadWins();
let best: number | null = loadBest();

let activeSlot: { row: number; col: number } | null = null;

// Generation token — bump on every new game. Async callbacks (e.g. a
// hypothetical animation timer) must check `if (myGen !== gen) return`.
const gen = createGenToken();

// ---- Helpers ----

function makeCode(): string[] {
  const out: string[] = [];
  for (let i = 0; i < PEGS; i++) {
    const idx = Math.floor(Math.random() * colors.length);
    out.push(colors[idx]!);
  }
  return out;
}

/**
 * Knuth Mastermind feedback.
 *   - black = positions where code[i] === guess[i]
 *   - white = multiset-intersection(code, guess) - black
 * Tekrarları doğru sayar.
 */
function scoreGuess(
  secret: readonly string[],
  guess: readonly string[],
): { black: number; white: number } {
  let black = 0;
  // Multiset frequency counters (only over slots not already "black").
  const codeRemain: Record<string, number> = {};
  const guessRemain: Record<string, number> = {};
  for (let i = 0; i < PEGS; i++) {
    const s = secret[i]!;
    const g = guess[i]!;
    if (s === g) {
      black++;
    } else {
      codeRemain[s] = (codeRemain[s] ?? 0) + 1;
      guessRemain[g] = (guessRemain[g] ?? 0) + 1;
    }
  }
  let white = 0;
  for (const k of Object.keys(guessRemain)) {
    const c = codeRemain[k] ?? 0;
    const g = guessRemain[k] ?? 0;
    white += Math.min(c, g);
  }
  return { black, white };
}
// Expose for tests via window in dev (no harm in prod).
(window as unknown as { __mastermindScore?: typeof scoreGuess }).__mastermindScore =
  scoreGuess;

// ---- Build / render ----

function buildBoard(): void {
  boardEl.innerHTML = '';
  for (let r = 0; r < MAX_ATTEMPTS; r++) {
    const row = document.createElement('div');
    row.className = 'row';
    row.setAttribute('role', 'row');
    row.dataset.row = String(r);

    const num = document.createElement('div');
    num.className = 'row__num';
    num.textContent = String(r + 1);
    row.appendChild(num);

    const pegs = document.createElement('div');
    pegs.className = 'row__pegs';
    for (let c = 0; c < PEGS; c++) {
      const slot = document.createElement('button');
      slot.type = 'button';
      slot.className = 'slot';
      slot.dataset.row = String(r);
      slot.dataset.col = String(c);
      slot.setAttribute('aria-label', `Satır ${r + 1}, slot ${c + 1}`);
      slot.disabled = true;
      slot.addEventListener('click', onSlotClick);
      pegs.appendChild(slot);
    }
    row.appendChild(pegs);

    const fb = document.createElement('div');
    fb.className = 'row__feedback';
    fb.setAttribute('aria-label', `Satır ${r + 1} geri bildirimi`);
    for (let i = 0; i < PEGS; i++) {
      const dot = document.createElement('span');
      dot.className = 'fb';
      fb.appendChild(dot);
    }
    row.appendChild(fb);

    boardEl.appendChild(row);
  }
}

function getSlot(row: number, col: number): HTMLButtonElement | null {
  return boardEl.querySelector<HTMLButtonElement>(
    `.slot[data-row="${row}"][data-col="${col}"]`,
  );
}

function renderRow(rowIdx: number): void {
  const guess = guesses[rowIdx]!;
  for (let c = 0; c < PEGS; c++) {
    const slot = getSlot(rowIdx, c);
    if (!slot) continue;
    const color = guess[c];
    // Reset color classes.
    slot.classList.forEach((cls) => {
      if (cls.startsWith('slot--color-')) slot.classList.remove(cls);
    });
    if (color) {
      slot.classList.add('slot--filled');
      slot.classList.add(`slot--color-${color}`);
      slot.setAttribute(
        'aria-label',
        `Satır ${rowIdx + 1}, slot ${c + 1}: ${COLOR_LABEL_TR[color] ?? color}`,
      );
    } else {
      slot.classList.remove('slot--filled');
      slot.setAttribute('aria-label', `Satır ${rowIdx + 1}, slot ${c + 1}: boş`);
    }
    // Active slot highlight
    slot.classList.toggle(
      'slot--active',
      activeSlot !== null && activeSlot.row === rowIdx && activeSlot.col === c,
    );
  }
  // Feedback dots
  const fb = feedbacks[rowIdx];
  const fbRow = boardEl.querySelector<HTMLElement>(
    `.row[data-row="${rowIdx}"] .row__feedback`,
  );
  if (fbRow) {
    const dots = Array.from(fbRow.querySelectorAll<HTMLElement>('.fb'));
    dots.forEach((d) => {
      d.classList.remove('fb--black', 'fb--white');
    });
    if (fb) {
      let i = 0;
      for (let k = 0; k < fb.black && i < PEGS; k++, i++) {
        dots[i]?.classList.add('fb--black');
      }
      for (let k = 0; k < fb.white && i < PEGS; k++, i++) {
        dots[i]?.classList.add('fb--white');
      }
    }
  }

  // Row active class — current row is highlighted.
  const rowEl = boardEl.querySelector<HTMLElement>(`.row[data-row="${rowIdx}"]`);
  if (rowEl) {
    rowEl.classList.toggle('row--active', rowIdx === currentRow && state === 'playing');
    rowEl.classList.toggle('row--done', rowIdx < currentRow);
  }
}

function renderAll(): void {
  attemptEl.textContent = `${Math.min(currentRow + 1, MAX_ATTEMPTS)}/${MAX_ATTEMPTS}`;
  winsEl.textContent = String(wins);
  bestEl.textContent = best === null ? '—' : String(best);
  for (let r = 0; r < MAX_ATTEMPTS; r++) renderRow(r);
  renderDiffButtons();
  renderActionButtons();
  // Enable/disable slots: only current row in playing state.
  for (let r = 0; r < MAX_ATTEMPTS; r++) {
    for (let c = 0; c < PEGS; c++) {
      const slot = getSlot(r, c);
      if (!slot) continue;
      slot.disabled = !(state === 'playing' && r === currentRow);
    }
  }
}

function renderDiffButtons(): void {
  diffBtns.forEach((btn) => {
    const isActive = btn.dataset.diff === difficulty;
    btn.classList.toggle('diff__btn--active', isActive);
    btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });
}

function renderActionButtons(): void {
  const filled = currentRowPegs.every((p) => p !== null);
  submitBtn.disabled = state !== 'playing' || !filled;
  clearBtn.disabled =
    state !== 'playing' || currentRowPegs.every((p) => p === null);
}

// ---- Palette ----

function buildPalette(): void {
  paletteInner.innerHTML = '';
  for (const col of colors) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `palette__color slot--color-${col}`;
    btn.dataset.color = col;
    btn.setAttribute('aria-label', `${COLOR_LABEL_TR[col] ?? col} renk seç`);
    btn.addEventListener('click', onPaletteClick);
    paletteInner.appendChild(btn);
  }
  // "Boş bırak" — clear slot
  const clearOne = document.createElement('button');
  clearOne.type = 'button';
  clearOne.className = 'palette__color palette__color--clear';
  clearOne.dataset.color = '';
  clearOne.setAttribute('aria-label', 'Slot\'u boşalt');
  clearOne.textContent = '×';
  clearOne.addEventListener('click', onPaletteClick);
  paletteInner.appendChild(clearOne);
}

function openPalette(row: number, col: number): void {
  if (state !== 'playing' || row !== currentRow) return;
  activeSlot = { row, col };
  paletteEl.classList.remove('palette--hidden');
  paletteEl.setAttribute('aria-hidden', 'false');
  renderRow(row);
}

function closePalette(): void {
  activeSlot = null;
  paletteEl.classList.add('palette--hidden');
  paletteEl.setAttribute('aria-hidden', 'true');
  renderRow(currentRow);
}

function onPaletteClick(e: Event): void {
  if (state !== 'playing') {
    closePalette();
    return;
  }
  const target = e.currentTarget as HTMLButtonElement | null;
  if (!target || !activeSlot) return;
  const color = target.dataset.color ?? '';
  const { row, col } = activeSlot;
  if (color === '') {
    currentRowPegs[col] = null;
  } else {
    currentRowPegs[col] = color;
  }
  // Reflect to guesses[row] (current row's display source).
  guesses[row] = [...currentRowPegs];
  closePalette();
  renderAll();
}

// ---- Slot click ----

function onSlotClick(e: MouseEvent): void {
  // Pitfall guard: overlay open → no-op (state !== 'playing').
  if (state !== 'playing') return;
  const target = e.currentTarget as HTMLButtonElement | null;
  if (!target) return;
  const r = Number(target.dataset.row);
  const c = Number(target.dataset.col);
  if (!Number.isInteger(r) || !Number.isInteger(c)) return;
  if (r !== currentRow) return;
  openPalette(r, c);
}

// ---- Submit / clear / win / lose ----

function submitGuess(): void {
  if (state !== 'playing') return;
  if (!currentRowPegs.every((p) => p !== null)) return;
  const g = currentRowPegs.map((p) => p as string);
  guesses[currentRow] = [...g];
  const fb = scoreGuess(code, g);
  feedbacks[currentRow] = fb;

  if (fb.black === PEGS) {
    // Win
    const attemptsUsed = currentRow + 1;
    wins++;
    safeWrite(STORAGE_WINS, String(wins));
    if (best === null || attemptsUsed < best) {
      best = attemptsUsed;
      safeWrite(STORAGE_BEST, String(best));
    }
    state = 'won';
    currentRow++;
    currentRowPegs = new Array(PEGS).fill(null);
    renderAll();
    showWin(attemptsUsed);
    return;
  }

  currentRow++;
  currentRowPegs = new Array(PEGS).fill(null);

  if (currentRow >= MAX_ATTEMPTS) {
    state = 'lost';
    renderAll();
    showLose();
    return;
  }

  renderAll();
}

function clearCurrentRow(): void {
  if (state !== 'playing') return;
  currentRowPegs = new Array(PEGS).fill(null);
  guesses[currentRow] = [...currentRowPegs];
  renderAll();
}

function renderCodeOverlay(): void {
  overlayCode.innerHTML = '';
  for (const col of code) {
    const dot = document.createElement('span');
    dot.className = `code-peg slot--color-${col}`;
    dot.setAttribute(
      'aria-label',
      `Kod rengi ${COLOR_LABEL_TR[col] ?? col}`,
    );
    overlayCode.appendChild(dot);
  }
}

function showWin(attempts: number): void {
  renderCodeOverlay();
  const isBest = best !== null && best === attempts;
  overlayTitle.textContent = isBest ? 'Yeni rekor!' : 'Kodu çözdün!';
  overlayMsg.textContent =
    attempts === 1
      ? '1 denemede kazandın!'
      : `${attempts} denemede kazandın.`;
  showOverlayEl(overlay);
  overlayRestart.focus({ preventScroll: true });
}

function showLose(): void {
  renderCodeOverlay();
  overlayTitle.textContent = 'Süre doldu';
  overlayMsg.textContent = 'Gizli kod yukarıda — tekrar dene!';
  showOverlayEl(overlay);
  overlayRestart.focus({ preventScroll: true });
}

function hideOverlay(): void {
  hideOverlayEl(overlay);
}

// ---- New game ----

function newGame(): void {
  // Bump generation so any pending async callback bails.
  gen.bump();
  // Close palette if mid-pick during spam restart.
  activeSlot = null;
  paletteEl.classList.add('palette--hidden');
  paletteEl.setAttribute('aria-hidden', 'true');
  hideOverlay();

  code = makeCode();
  guesses = [];
  feedbacks = [];
  for (let r = 0; r < MAX_ATTEMPTS; r++) {
    guesses.push(new Array(PEGS).fill(null));
  }
  currentRow = 0;
  currentRowPegs = new Array(PEGS).fill(null);
  state = 'playing';

  renderAll();
}

function setDifficulty(d: Difficulty): void {
  if (d === difficulty) {
    // Still restart so user gets a fresh code on click (matches UX
    // expectations: tapping the active difficulty button starts a new round).
    newGame();
    return;
  }
  difficulty = d;
  colors = difficulty === 'hard' ? COLORS_HARD : COLORS_EASY;
  safeWrite(STORAGE_DIFF, difficulty);
  best = loadBest(); // best is per-storage; we keep one slot. Refresh display.
  buildPalette();
  newGame();
}

// ---- Init ----

function init(): void {
  boardEl = document.querySelector<HTMLElement>('#board')!;
  attemptEl = document.querySelector<HTMLElement>('#attempt')!;
  winsEl = document.querySelector<HTMLElement>('#wins')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  submitBtn = document.querySelector<HTMLButtonElement>('#submit')!;
  clearBtn = document.querySelector<HTMLButtonElement>('#clear')!;
  paletteEl = document.querySelector<HTMLElement>('#palette')!;
  paletteInner = document.querySelector<HTMLElement>('#palette-inner')!;
  paletteCloseBtn = document.querySelector<HTMLButtonElement>('#palette-close')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayCode = document.querySelector<HTMLElement>('#overlay-code')!;
  overlayRestart = document.querySelector<HTMLButtonElement>('#overlay-restart')!;
  diffBtns = Array.from(
    document.querySelectorAll<HTMLButtonElement>('.diff__btn'),
  );

  restartBtn.addEventListener('click', newGame);
  overlayRestart.addEventListener('click', newGame);
  submitBtn.addEventListener('click', submitGuess);
  clearBtn.addEventListener('click', clearCurrentRow);
  paletteCloseBtn.addEventListener('click', closePalette);

  diffBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const d = btn.dataset.diff;
      if (d === 'easy' || d === 'hard') setDifficulty(d);
    });
  });

  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'r') {
      newGame();
      e.preventDefault();
      return;
    }
    if (k === 'escape') {
      if (!paletteEl.classList.contains('palette--hidden')) {
        closePalette();
        e.preventDefault();
      }
      return;
    }
    if (k === 'enter' && state === 'playing') {
      if (!submitBtn.disabled) {
        submitGuess();
        e.preventDefault();
      }
      return;
    }
    if (k === 'enter' && (state === 'won' || state === 'lost')) {
      newGame();
      e.preventDefault();
    }
  });

  buildBoard();
  buildPalette();
  newGame();
}

export const game = defineGame({ init, reset: newGame });
