import { defineGame } from '@shared/game-module';
import { createGenToken } from '@shared/gen-token';

// Sudoku — 9×9 grid, classic rules.
//
// Pitfalls avoided:
// - Explicit state enum (Playing | Won) → no overlay-input-leak: while the win
//   overlay is open, digit keys do nothing to the grid.
// - Timer uses setInterval guarded by a generation token; reset() bumps it so
//   any stale tick from a previous run bails out → no stale-async-callback.
// - All localStorage access wrapped in safeRead/safeWrite (try/catch) → no
//   unguarded-storage in Safari private mode.
// - DOM event delegation on the board: cell index from data attributes, not
//   from pixel math → no visual-vs-hitbox.
// - reset() and newBoard() render the puzzle with given digits + cursor before
//   any user input, so the playfield is visible immediately → no invisible-boot.
// - Given (pre-filled) cells are locked; digit input on them is silently ignored.

type Difficulty = 'easy' | 'medium' | 'hard';
type GameState = 'playing' | 'won';

interface Puzzle {
  difficulty: Difficulty;
  given: string;    // 81 chars, '0' for blank
  solution: string; // 81 chars, full solution
}

// Five verified boards (2 easy, 2 medium, 1 hard). Each solution was machine-
// solved (see scripts/find-sudoku in commit notes) and verifyPuzzles() re-checks
// at boot, so a typo would warn rather than silently mismatching. Givens vary
// from 21 (Inkala hard) to 32 (medium), all with unique solutions.
const PUZZLES: ReadonlyArray<Puzzle> = [
  // ---- Easy ----
  // Wikipedia "Sudoku" example, the canonical illustration.
  {
    difficulty: 'easy',
    given:
      '530070000' +
      '600195000' +
      '098000060' +
      '800060003' +
      '400803001' +
      '700020006' +
      '060000280' +
      '000419005' +
      '000080079',
    solution:
      '534678912' +
      '672195348' +
      '198342567' +
      '859761423' +
      '426853791' +
      '713924856' +
      '961537284' +
      '287419635' +
      '345286179',
  },
  // Peter Norvig's classic "easy" example.
  {
    difficulty: 'easy',
    given:
      '003020600' +
      '900305001' +
      '001806400' +
      '008102900' +
      '700000008' +
      '006708200' +
      '002609500' +
      '800203009' +
      '005010300',
    solution:
      '483921657' +
      '967345821' +
      '251876493' +
      '548132976' +
      '729564138' +
      '136798245' +
      '372689514' +
      '814253769' +
      '695417382',
  },
  // ---- Medium ----
  // Symmetric medium puzzle with 36 givens.
  {
    difficulty: 'medium',
    given:
      '000260701' +
      '680070090' +
      '190004500' +
      '820100040' +
      '004602900' +
      '050003028' +
      '009300074' +
      '040050036' +
      '703018000',
    solution:
      '435269781' +
      '682571493' +
      '197834562' +
      '826195347' +
      '374682915' +
      '951743628' +
      '519326874' +
      '248957136' +
      '763418259',
  },
  // Generated medium puzzle (32 givens, unique solution).
  {
    difficulty: 'medium',
    given:
      '003004000' +
      '608001075' +
      '170020000' +
      '000460520' +
      '500003907' +
      '980207003' +
      '007090050' +
      '300700000' +
      '005040039',
    solution:
      '253874691' +
      '648931275' +
      '179526384' +
      '731469528' +
      '524183967' +
      '986257413' +
      '467398152' +
      '392715846' +
      '815642739',
  },
  // ---- Hard ----
  // Arto Inkala's "world's hardest sudoku" (2012). 21 givens, fiendish.
  {
    difficulty: 'hard',
    given:
      '800000000' +
      '003600000' +
      '070090200' +
      '050007000' +
      '000045700' +
      '000100030' +
      '001000068' +
      '008500010' +
      '090000400',
    solution:
      '812753649' +
      '943682175' +
      '675491283' +
      '154237896' +
      '369845721' +
      '287169534' +
      '521974368' +
      '438526917' +
      '796318452',
  },
];

const BLOCK = 3;
const SIZE = 9;
const SCAN_DELAY_MS = 60; // delay between cell mutation and conflict re-render

const DIFFICULTY_KEY = 'sudoku.difficulty';
const bestKey = (d: Difficulty): string => `sudoku.best-${d}`;

// --- DOM ---
let boardEl!: HTMLElement;
let statusEl!: HTMLElement;
let timerEl!: HTMLElement;
let bestEl!: HTMLElement;
let hintsLeftEl!: HTMLElement;
let difficultySel!: HTMLSelectElement;
let hintBtn!: HTMLButtonElement;
let restartBtn!: HTMLButtonElement;
let newBoardBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayNewBtn!: HTMLButtonElement;
let padBtns: HTMLButtonElement[] = [];

// --- State ---
let difficulty: Difficulty = 'medium';
let puzzleIndex = 0;          // index inside PUZZLES filtered by difficulty
let given: number[] = [];     // 81 entries, 0 = blank
let solution: number[] = [];  // 81 entries
let user: number[] = [];      // user-entered digits (0 if empty, copy of `given` for fixed cells)
let cellEls: HTMLButtonElement[] = [];
let cursor: number = 0;       // 0..80, the currently-selected cell
let hintsRemaining = 3;
let state: GameState = 'playing';
let elapsedSec = 0;
let timerInterval: number | null = null;
const genToken = createGenToken();

// --- Storage helpers (guarded) ---
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

function loadDifficulty(): Difficulty {
  const raw = safeRead(DIFFICULTY_KEY);
  if (raw === 'easy' || raw === 'medium' || raw === 'hard') return raw;
  return 'medium';
}

function loadBest(d: Difficulty): number | null {
  const raw = safeRead(bestKey(d));
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function saveBest(d: Difficulty, seconds: number): void {
  safeWrite(bestKey(d), String(seconds));
}

// --- Puzzle helpers ---
function parseString(s: string): number[] {
  const out = new Array<number>(SIZE * SIZE);
  for (let i = 0; i < SIZE * SIZE; i++) {
    const ch = s[i];
    const n = ch === undefined ? 0 : Number(ch);
    out[i] = Number.isInteger(n) && n >= 0 && n <= 9 ? n : 0;
  }
  return out;
}

function puzzlesByDifficulty(d: Difficulty): Puzzle[] {
  return PUZZLES.filter((p) => p.difficulty === d);
}

function pickPuzzle(d: Difficulty): { puzzle: Puzzle; index: number } {
  const pool = puzzlesByDifficulty(d);
  if (pool.length === 0) {
    // Fallback shouldn't happen — guarantee by verifyPuzzles() at boot.
    return { puzzle: PUZZLES[0]!, index: 0 };
  }
  const index = Math.floor(Math.random() * pool.length);
  return { puzzle: pool[index]!, index };
}

function rcb(i: number): { row: number; col: number; block: number } {
  const row = Math.floor(i / SIZE);
  const col = i % SIZE;
  const block = Math.floor(row / BLOCK) * BLOCK + Math.floor(col / BLOCK);
  return { row, col, block };
}

// Returns the set of indices that conflict with cell i given the current `user`.
// A conflict means: cell j shares a row/column/block AND has same non-zero digit.
function conflictsAt(i: number, board: number[]): number[] {
  const v = board[i];
  if (v === undefined || v === 0) return [];
  const out: number[] = [];
  const { row, col, block } = rcb(i);
  for (let j = 0; j < SIZE * SIZE; j++) {
    if (j === i) continue;
    if (board[j] !== v) continue;
    const o = rcb(j);
    if (o.row === row || o.col === col || o.block === block) out.push(j);
  }
  return out;
}

// True if board has zero conflicts AND no zero cells.
function isComplete(board: number[]): boolean {
  for (let i = 0; i < SIZE * SIZE; i++) {
    if (board[i] === 0) return false;
    if (conflictsAt(i, board).length > 0) return false;
  }
  return true;
}

function verifyPuzzles(): void {
  // Sanity check at boot: each puzzle's stored `solution` should be a valid full
  // grid and consistent with `given`. Cheap (5 puzzles × ~81 cells); only warns,
  // doesn't throw — production should never hit this. Offline tests do the
  // heavier "is it actually solvable / unique?" pass before commit.
  for (let i = 0; i < PUZZLES.length; i++) {
    const p = PUZZLES[i]!;
    const g = parseString(p.given);
    const s = parseString(p.solution);
    if (s.some((x) => x === 0)) {
      console.warn(`Sudoku puzzle ${i}: solution has blanks`);
      continue;
    }
    let ok = true;
    for (let k = 0; k < SIZE * SIZE; k++) {
      if (g[k] !== 0 && g[k] !== s[k]) {
        ok = false;
        break;
      }
    }
    if (!ok) console.warn(`Sudoku puzzle ${i}: solution doesn't match given`);
    if (!isComplete(s)) console.warn(`Sudoku puzzle ${i}: solution invalid`);
  }
}

// --- Rendering ---
function buildBoard(): void {
  boardEl.innerHTML = '';
  cellEls = [];
  for (let i = 0; i < SIZE * SIZE; i++) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sk-cell';
    btn.setAttribute('role', 'gridcell');
    btn.dataset.i = String(i);
    const { row, col } = rcb(i);
    btn.setAttribute('aria-label', `Hücre ${row + 1}, ${col + 1}`);
    // Block boundaries — give the 3×3 blocks visible separation via classes.
    if (col % BLOCK === BLOCK - 1 && col !== SIZE - 1) {
      btn.classList.add('sk-cell--block-right');
    }
    if (row % BLOCK === BLOCK - 1 && row !== SIZE - 1) {
      btn.classList.add('sk-cell--block-bottom');
    }
    boardEl.appendChild(btn);
    cellEls.push(btn);
  }
}

function renderCells(): void {
  // Build conflict set so we only walk the board once.
  const conflictSet = new Set<number>();
  for (let i = 0; i < SIZE * SIZE; i++) {
    if (user[i] !== 0 && conflictsAt(i, user).length > 0) {
      conflictSet.add(i);
    }
  }

  const cursorVal = user[cursor] ?? 0;
  const { row: curRow, col: curCol, block: curBlock } = rcb(cursor);

  for (let i = 0; i < SIZE * SIZE; i++) {
    const el = cellEls[i]!;
    const v = user[i] ?? 0;
    // Reset our mutually-exclusive state classes; keep static block-edge ones.
    el.classList.remove(
      'sk-cell--given',
      'sk-cell--user',
      'sk-cell--conflict',
      'sk-cell--selected',
      'sk-cell--peer',
      'sk-cell--same',
      'sk-cell--empty',
    );
    el.textContent = v === 0 ? '' : String(v);
    if (given[i] !== 0) {
      el.classList.add('sk-cell--given');
    } else if (v !== 0) {
      el.classList.add('sk-cell--user');
    } else {
      el.classList.add('sk-cell--empty');
    }
    if (conflictSet.has(i)) el.classList.add('sk-cell--conflict');

    // Highlight: selected cell, its peers (row/col/block), and matching digits.
    if (i === cursor) {
      el.classList.add('sk-cell--selected');
    } else {
      const o = rcb(i);
      if (o.row === curRow || o.col === curCol || o.block === curBlock) {
        el.classList.add('sk-cell--peer');
      }
      if (cursorVal !== 0 && v === cursorVal) {
        el.classList.add('sk-cell--same');
      }
    }
  }
}

function renderHud(): void {
  hintsLeftEl.textContent = String(hintsRemaining);
  const best = loadBest(difficulty);
  bestEl.textContent = best === null ? '—' : formatTime(best);
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function setStatus(msg: string, kind?: 'win' | 'warn'): void {
  statusEl.textContent = msg;
  statusEl.classList.remove('sk-status--win', 'sk-status--warn');
  if (kind === 'win') statusEl.classList.add('sk-status--win');
  if (kind === 'warn') statusEl.classList.add('sk-status--warn');
}

// --- Timer ---
function startTimer(): void {
  stopTimer();
  elapsedSec = 0;
  timerEl.textContent = formatTime(elapsedSec);
  const myGen = genToken.current();
  timerInterval = window.setInterval(() => {
    if (!genToken.isCurrent(myGen)) return; // stale tick after a reset/newBoard
    if (state !== 'playing') return; // win pause
    elapsedSec++;
    timerEl.textContent = formatTime(elapsedSec);
  }, 1000);
}

function stopTimer(): void {
  if (timerInterval !== null) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

// --- Game actions ---
function placeDigit(i: number, digit: number): void {
  if (state !== 'playing') return;
  if (given[i] !== 0) {
    // Locked cell — give a tiny visual nudge.
    cellEls[i]?.classList.remove('sk-cell--bump');
    // Force reflow so the animation re-triggers if rapidly repeated.
    void cellEls[i]?.offsetWidth;
    cellEls[i]?.classList.add('sk-cell--bump');
    return;
  }
  if (digit < 0 || digit > 9) return;
  user[i] = digit;
  renderCells();
  // Auto-detect win.
  if (digit !== 0 && isComplete(user)) {
    window.setTimeout(() => {
      if (isComplete(user) && state === 'playing') winGame();
    }, SCAN_DELAY_MS);
  }
}

function moveCursor(dRow: number, dCol: number): void {
  if (state !== 'playing') return;
  const { row, col } = rcb(cursor);
  let nr = row + dRow;
  let nc = col + dCol;
  // Wrap around — more pleasant than getting stuck at edges.
  if (nr < 0) nr = SIZE - 1;
  if (nr >= SIZE) nr = 0;
  if (nc < 0) nc = SIZE - 1;
  if (nc >= SIZE) nc = 0;
  cursor = nr * SIZE + nc;
  renderCells();
}

function setCursor(i: number): void {
  if (i < 0 || i >= SIZE * SIZE) return;
  cursor = i;
  renderCells();
}

function useHint(): void {
  if (state !== 'playing') return;
  if (hintsRemaining <= 0) {
    setStatus('İpucu hakkın kalmadı. Yeni tahta için N.', 'warn');
    return;
  }
  // Prefer the currently selected cell if it's blank and not given.
  let target = -1;
  if (given[cursor] === 0 && user[cursor] === 0) {
    target = cursor;
  } else {
    // Otherwise pick any blank cell.
    const blanks: number[] = [];
    for (let i = 0; i < SIZE * SIZE; i++) {
      if (given[i] === 0 && user[i] === 0) blanks.push(i);
    }
    if (blanks.length === 0) {
      setStatus('Boş hücre kalmadı.', 'warn');
      return;
    }
    target = blanks[Math.floor(Math.random() * blanks.length)]!;
  }
  const correct = solution[target] ?? 0;
  if (correct === 0) return; // defensive — shouldn't happen
  user[target] = correct;
  cursor = target;
  hintsRemaining--;
  renderCells();
  renderHud();
  setStatus(`İpucu kullanıldı: (${Math.floor(target / SIZE) + 1}, ${(target % SIZE) + 1}) → ${correct}`);
  if (isComplete(user)) {
    window.setTimeout(() => {
      if (isComplete(user) && state === 'playing') winGame();
    }, SCAN_DELAY_MS);
  }
}

function winGame(): void {
  state = 'won';
  stopTimer();
  // Persist best time.
  const best = loadBest(difficulty);
  let isRecord = false;
  if (best === null || elapsedSec < best) {
    saveBest(difficulty, elapsedSec);
    isRecord = true;
  }
  renderHud();
  setStatus(`Çözdün! Süre: ${formatTime(elapsedSec)}`, 'win');
  overlayTitle.textContent = isRecord ? 'Yeni rekor!' : 'Tebrikler!';
  overlayMsg.textContent =
    `${labelFor(difficulty)} zorlukta ${formatTime(elapsedSec)} sürede çözdün.`;
  overlay.classList.remove('sk-overlay--hidden');
  overlay.setAttribute('aria-hidden', 'false');
  overlayNewBtn.focus({ preventScroll: true });
}

function labelFor(d: Difficulty): string {
  if (d === 'easy') return 'Kolay';
  if (d === 'hard') return 'Zor';
  return 'Orta';
}

function hideOverlay(): void {
  overlay.classList.add('sk-overlay--hidden');
  overlay.setAttribute('aria-hidden', 'true');
}

// Restart the current puzzle (preserves which puzzle is shown, clears user input).
function reset(): void {
  genToken.bump();            // invalidates any in-flight setInterval tick
  state = 'playing';
  hintsRemaining = 3;
  user = given.slice();  // copies in given digits, leaves blanks as 0
  // Set cursor on the first blank cell so the user can immediately start typing.
  cursor = 0;
  for (let i = 0; i < SIZE * SIZE; i++) {
    if (given[i] === 0) {
      cursor = i;
      break;
    }
  }
  hideOverlay();
  renderCells();
  renderHud();
  setStatus('Bir hücre seç, ardından 1-9 ile doldur. 0 veya Backspace siler.');
  startTimer();
}

// Pick a fresh puzzle (also restarts).
function newBoard(): void {
  const pick = pickPuzzle(difficulty);
  puzzleIndex = pick.index;
  given = parseString(pick.puzzle.given);
  solution = parseString(pick.puzzle.solution);
  reset();
}

// --- Event wiring ---
function attachListeners(): void {
  // Board cell selection — event delegation
  boardEl.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    const cell = target.closest<HTMLButtonElement>('.sk-cell');
    if (!cell) return;
    const i = Number(cell.dataset.i);
    if (!Number.isInteger(i)) return;
    setCursor(i);
    // Focus the board itself so keyboard input keeps working.
    boardEl.focus({ preventScroll: true });
  });

  // Digit pad buttons
  for (const btn of padBtns) {
    btn.addEventListener('click', () => {
      const n = Number(btn.dataset.num);
      if (!Number.isInteger(n)) return;
      placeDigit(cursor, n);
    });
  }

  // Difficulty change
  difficultySel.addEventListener('change', () => {
    const v = difficultySel.value;
    if (v === 'easy' || v === 'medium' || v === 'hard') {
      difficulty = v;
      safeWrite(DIFFICULTY_KEY, difficulty);
      newBoard();
    }
  });

  // Buttons
  hintBtn.addEventListener('click', useHint);
  restartBtn.addEventListener('click', reset);
  newBoardBtn.addEventListener('click', newBoard);
  overlayNewBtn.addEventListener('click', newBoard);

  // Global keyboard
  window.addEventListener('keydown', (e) => {
    // Ignore when typing in an actual form field (difficulty select, etc).
    const t = e.target as HTMLElement | null;
    if (t) {
      const tag = t.tagName;
      if (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        t.isContentEditable
      ) {
        // Selects still get arrow keys for option scrubbing — that's fine.
        return;
      }
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const key = e.key;

    // Win overlay: only N / Enter / R are meaningful — digits + arrows are no-ops.
    if (state === 'won') {
      if (key === 'n' || key === 'N' || key === 'Enter') {
        e.preventDefault();
        newBoard();
      } else if (key === 'r' || key === 'R') {
        e.preventDefault();
        reset();
      }
      return;
    }

    // Cursor moves
    if (key === 'ArrowUp') {
      moveCursor(-1, 0);
      e.preventDefault();
      return;
    }
    if (key === 'ArrowDown') {
      moveCursor(1, 0);
      e.preventDefault();
      return;
    }
    if (key === 'ArrowLeft') {
      moveCursor(0, -1);
      e.preventDefault();
      return;
    }
    if (key === 'ArrowRight') {
      moveCursor(0, 1);
      e.preventDefault();
      return;
    }
    if (key === 'Tab') {
      // Let tab move focus naturally; do not consume.
      return;
    }

    // Digits 1-9
    if (/^[1-9]$/.test(key)) {
      placeDigit(cursor, Number(key));
      e.preventDefault();
      return;
    }

    // Clear cell
    if (key === '0' || key === 'Backspace' || key === 'Delete') {
      placeDigit(cursor, 0);
      e.preventDefault();
      return;
    }

    // Hotkeys
    if (key === 'h' || key === 'H') {
      useHint();
      e.preventDefault();
      return;
    }
    if (key === 'r' || key === 'R') {
      reset();
      e.preventDefault();
      return;
    }
    if (key === 'n' || key === 'N') {
      newBoard();
      e.preventDefault();
      return;
    }
  });
}

// --- Init ---
function init(): void {
  boardEl = document.querySelector<HTMLElement>('#board')!;
  statusEl = document.querySelector<HTMLElement>('#status')!;
  timerEl = document.querySelector<HTMLElement>('#timer')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  hintsLeftEl = document.querySelector<HTMLElement>('#hints-left')!;
  difficultySel = document.querySelector<HTMLSelectElement>('#difficulty')!;
  hintBtn = document.querySelector<HTMLButtonElement>('#hint-btn')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  newBoardBtn = document.querySelector<HTMLButtonElement>('#new-board')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayNewBtn = document.querySelector<HTMLButtonElement>('#overlay-new')!;
  padBtns = Array.from(
    document.querySelectorAll<HTMLButtonElement>('.sk-pad__btn'),
  );

  verifyPuzzles();
  difficulty = loadDifficulty();
  difficultySel.value = difficulty;
  buildBoard();
  attachListeners();
  newBoard();
}

export const game = defineGame({ init, reset });

// Test hook — only used by the headless harness. Production runtime never reads
// this property; exposing it here avoids module-export gymnastics in the test
// script. Keep it minimal and read-only-by-convention.
declare global {
  interface Window {
    __sudokuTest?: {
      getState: () => GameState;
      getUser: () => readonly number[];
      getGiven: () => readonly number[];
      getSolution: () => readonly number[];
      getCursor: () => number;
      getDifficulty: () => Difficulty;
      getElapsed: () => number;
      getHintsLeft: () => number;
      reset: () => void;
      newBoard: () => void;
      setDifficulty: (d: Difficulty) => void;
      placeAt: (i: number, n: number) => void;
      useHint: () => void;
      setCursor: (i: number) => void;
      autoFillAllButOne: () => void;
      forceWin: () => void;
      puzzleCount: () => number;
    };
  }
}

if (typeof window !== 'undefined') {
  window.__sudokuTest = {
    getState: () => state,
    getUser: () => user,
    getGiven: () => given,
    getSolution: () => solution,
    getCursor: () => cursor,
    getDifficulty: () => difficulty,
    getElapsed: () => elapsedSec,
    getHintsLeft: () => hintsRemaining,
    reset,
    newBoard,
    setDifficulty: (d) => {
      difficulty = d;
      newBoard();
    },
    placeAt: (i, n) => {
      setCursor(i);
      placeDigit(i, n);
    },
    useHint,
    setCursor,
    autoFillAllButOne: () => {
      // Fill everything from solution except one blank, so a single 1-9 press
      // triggers the win path. Picks the first blank cell as the one left.
      let leftBlank = -1;
      for (let i = 0; i < SIZE * SIZE; i++) {
        if (given[i] === 0) {
          if (leftBlank === -1) {
            leftBlank = i;
            continue;
          }
          user[i] = solution[i] ?? 0;
        }
      }
      if (leftBlank !== -1) cursor = leftBlank;
      renderCells();
    },
    forceWin: () => {
      user = solution.slice();
      renderCells();
      if (isComplete(user) && state === 'playing') winGame();
    },
    puzzleCount: () => PUZZLES.length,
  };
}

// Keep referenced so TS doesn't complain (puzzleIndex is informational).
void puzzleIndex;
