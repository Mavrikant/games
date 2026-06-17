// Nonogram: 5×5 logic puzzle. Each row/column has clues showing the lengths
// of consecutive filled runs. Click to try filling — wrong cells flash red,
// auto-mark as X, and cost a life. Solve a puzzle, advance to the next.
// Three mistakes end the run; score is the number of puzzles completed.
//
// PITFALLS this implementation defends against (read docs/PITFALLS.md first):
// - unguarded-storage: safeRead/safeWrite wrap localStorage in try/catch.
// - stale-async-callback: gen.bump() in reset() cancels the wrong-flash
//   timeout so a rapid R after a miss doesn't repaint the new cell as X.
// - overlay-input-leak: explicit `state` enum; every handler returns early
//   when state !== 'playing'.
// - module-level side effects: all DOM access lives in init().
// - missing-overlay-css: per-game CSS defines `.overlay--hidden`.
// - visual-vs-hitbox: filled vs empty cell hit-test uses the same cells
//   array; no separate "hit map".
// - invisible-boot: first puzzle is rendered synchronously in init().

import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay, hideOverlay } from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';
import { reportGameOver } from '@shared/leaderboard';

const SIZE = 5;
const MAX_LIVES = 3;
const STORAGE_BEST = 'nonogram.best';
const SCORE_DESC = {
  gameId: 'nonogram',
  storageKey: STORAGE_BEST,
  direction: 'higher' as const,
};
const WRONG_FLASH_MS = 320;

type Cell = 0 | 1; // 0 = empty, 1 = filled (in the solution)
type CellState = 'blank' | 'filled' | 'marked'; // player-visible state

interface Puzzle {
  name: string;
  // 5x5 grid, row-major. 1 = filled in solution, 0 = empty.
  solution: ReadonlyArray<Cell>;
}

// Hand-designed 5×5 nonograms. Each has a unique recognizable shape so the
// reveal feels rewarding. Order is shuffled per session.
const PUZZLES: ReadonlyArray<Puzzle> = [
  {
    name: 'Kalp',
    // .###.  -> Heart
    // #####
    // #####
    // .###.
    // ..#..
    solution: [
      0, 1, 1, 1, 0,
      1, 1, 1, 1, 1,
      1, 1, 1, 1, 1,
      0, 1, 1, 1, 0,
      0, 0, 1, 0, 0,
    ],
  },
  {
    name: 'Yıldız',
    // ..#..
    // .###.
    // #####
    // .###.
    // .#.#.
    solution: [
      0, 0, 1, 0, 0,
      0, 1, 1, 1, 0,
      1, 1, 1, 1, 1,
      0, 1, 1, 1, 0,
      0, 1, 0, 1, 0,
    ],
  },
  {
    name: 'Ev',
    // ..#..
    // .###.
    // #####
    // #.#.#
    // #.#.#
    solution: [
      0, 0, 1, 0, 0,
      0, 1, 1, 1, 0,
      1, 1, 1, 1, 1,
      1, 0, 1, 0, 1,
      1, 0, 1, 0, 1,
    ],
  },
  {
    name: 'Mantar',
    // .###.
    // #####
    // #####
    // ..#..
    // .###.
    solution: [
      0, 1, 1, 1, 0,
      1, 1, 1, 1, 1,
      1, 1, 1, 1, 1,
      0, 0, 1, 0, 0,
      0, 1, 1, 1, 0,
    ],
  },
  {
    name: 'Balık',
    // .....
    // .###.
    // ####.
    // .###.
    // ..#..
    solution: [
      0, 0, 0, 0, 0,
      0, 1, 1, 1, 0,
      1, 1, 1, 1, 0,
      0, 1, 1, 1, 0,
      0, 0, 1, 0, 0,
    ],
  },
  {
    name: 'Ağaç',
    // ..#..
    // .###.
    // #####
    // .###.
    // ..#..
    solution: [
      0, 0, 1, 0, 0,
      0, 1, 1, 1, 0,
      1, 1, 1, 1, 1,
      0, 1, 1, 1, 0,
      0, 0, 1, 0, 0,
    ],
  },
  {
    name: 'Çapa',
    // ..#..
    // .###.
    // ..#..
    // #.#.#
    // .###.
    solution: [
      0, 0, 1, 0, 0,
      0, 1, 1, 1, 0,
      0, 0, 1, 0, 0,
      1, 0, 1, 0, 1,
      0, 1, 1, 1, 0,
    ],
  },
  {
    name: 'Çiçek',
    // .#.#.
    // ##.##
    // ..#..
    // .###.
    // ..#..
    solution: [
      0, 1, 0, 1, 0,
      1, 1, 0, 1, 1,
      0, 0, 1, 0, 0,
      0, 1, 1, 1, 0,
      0, 0, 1, 0, 0,
    ],
  },
  {
    name: 'Tava',
    // .....
    // .####
    // .####
    // .####
    // #....
    solution: [
      0, 0, 0, 0, 0,
      0, 1, 1, 1, 1,
      0, 1, 1, 1, 1,
      0, 1, 1, 1, 1,
      1, 0, 0, 0, 0,
    ],
  },
  {
    name: 'Anahtar',
    // .##..
    // #..#.
    // .##..
    // .#...
    // .###.
    solution: [
      0, 1, 1, 0, 0,
      1, 0, 0, 1, 0,
      0, 1, 1, 0, 0,
      0, 1, 0, 0, 0,
      0, 1, 1, 1, 0,
    ],
  },
  {
    name: 'Ay',
    // ..##.
    // .#.##
    // .#..#
    // .#.##
    // ..##.
    solution: [
      0, 0, 1, 1, 0,
      0, 1, 0, 1, 1,
      0, 1, 0, 0, 1,
      0, 1, 0, 1, 1,
      0, 0, 1, 1, 0,
    ],
  },
  {
    name: 'Şemsiye',
    // .###.
    // #####
    // ..#..
    // ..#..
    // .##..
    solution: [
      0, 1, 1, 1, 0,
      1, 1, 1, 1, 1,
      0, 0, 1, 0, 0,
      0, 0, 1, 0, 0,
      0, 1, 1, 0, 0,
    ],
  },
];

type State = 'playing' | 'won' | 'gameover';

const gen = createGenToken();

let state: State = 'playing';

let order: number[] = [];          // shuffled puzzle indices
let puzzleCursor = 0;               // next index into `order`
let puzzle!: Puzzle;
let cells: CellState[] = [];        // player-visible state per cell
let lives = MAX_LIVES;
let solved = 0;
let best = 0;

// DOM refs (populated in init).
let solvedEl!: HTMLElement;
let livesEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let puzzleNameEl!: HTMLElement;
let cornerEl!: HTMLElement;
let colHintsEl!: HTMLElement;
let rowHintsEl!: HTMLElement;
let gridEl!: HTMLElement;
let cellEls: HTMLButtonElement[] = [];
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayNext!: HTMLButtonElement;

// ---------- puzzle helpers ----------

function shuffledOrder(): number[] {
  const a = PUZZLES.map((_, i) => i);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

function rowClue(sol: ReadonlyArray<Cell>, r: number): number[] {
  return runsOf(sliceRow(sol, r));
}

function colClue(sol: ReadonlyArray<Cell>, c: number): number[] {
  return runsOf(sliceCol(sol, c));
}

function sliceRow(sol: ReadonlyArray<Cell>, r: number): Cell[] {
  const out: Cell[] = [];
  for (let c = 0; c < SIZE; c++) out.push(sol[r * SIZE + c]!);
  return out;
}

function sliceCol(sol: ReadonlyArray<Cell>, c: number): Cell[] {
  const out: Cell[] = [];
  for (let r = 0; r < SIZE; r++) out.push(sol[r * SIZE + c]!);
  return out;
}

function runsOf(line: Cell[]): number[] {
  const runs: number[] = [];
  let run = 0;
  for (const v of line) {
    if (v === 1) run++;
    else if (run > 0) {
      runs.push(run);
      run = 0;
    }
  }
  if (run > 0) runs.push(run);
  if (runs.length === 0) runs.push(0);
  return runs;
}

// ---------- render ----------

function renderHud(): void {
  solvedEl.textContent = String(solved);
  livesEl.textContent =
    '●'.repeat(lives) + '○'.repeat(Math.max(0, MAX_LIVES - lives));
  bestEl.textContent = best > 0 ? String(best) : '—';
}

function renderHints(): void {
  // Column hints: SIZE columns, each with its run-length list stacked.
  colHintsEl.innerHTML = '';
  for (let c = 0; c < SIZE; c++) {
    const col = document.createElement('div');
    col.className = 'ng-col-hint';
    const runs = colClue(puzzle.solution, c);
    for (const n of runs) {
      const span = document.createElement('span');
      span.textContent = String(n);
      col.appendChild(span);
    }
    colHintsEl.appendChild(col);
  }

  // Row hints: SIZE rows on the left.
  rowHintsEl.innerHTML = '';
  for (let r = 0; r < SIZE; r++) {
    const row = document.createElement('div');
    row.className = 'ng-row-hint';
    const runs = rowClue(puzzle.solution, r);
    for (const n of runs) {
      const span = document.createElement('span');
      span.textContent = String(n);
      row.appendChild(span);
    }
    rowHintsEl.appendChild(row);
  }
}

function buildGrid(): void {
  gridEl.innerHTML = '';
  cellEls = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ng-cell';
      btn.setAttribute('role', 'gridcell');
      btn.setAttribute('aria-label', `Hücre ${r + 1},${c + 1}`);
      btn.dataset.r = String(r);
      btn.dataset.c = String(c);
      btn.addEventListener('pointerdown', onCellPointerDown);
      btn.addEventListener('contextmenu', (e) => e.preventDefault());
      gridEl.appendChild(btn);
      cellEls.push(btn);
    }
  }
}

function renderGrid(): void {
  for (let i = 0; i < cellEls.length; i++) {
    const el = cellEls[i]!;
    const cs = cells[i]!;
    el.classList.toggle('ng-cell--filled', cs === 'filled');
    el.classList.toggle('ng-cell--marked', cs === 'marked');
    el.classList.remove('ng-cell--wrong');
    el.setAttribute(
      'aria-pressed',
      cs === 'filled' ? 'true' : cs === 'marked' ? 'mixed' : 'false',
    );
  }
}

function renderPuzzleName(): void {
  // Hide name until solved, so it doesn't spoil the picture.
  puzzleNameEl.textContent = state === 'won' ? puzzle.name : '?';
}

// ---------- interaction ----------

// Long-press tracking for touch users — they can't right-click to mark.
let pointerDownAt = 0;
let pointerDownIdx = -1;
let longPressTimer: number | null = null;
const LONG_PRESS_MS = 360;

function onCellPointerDown(e: PointerEvent): void {
  if (state !== 'playing') return;
  const target = e.currentTarget as HTMLButtonElement | null;
  if (!target) return;
  const r = Number(target.dataset.r);
  const c = Number(target.dataset.c);
  if (!Number.isInteger(r) || !Number.isInteger(c)) return;
  const i = r * SIZE + c;

  // Right-click → mark/unmark.
  if (e.button === 2) {
    e.preventDefault();
    toggleMark(i);
    return;
  }
  // Middle button: ignore.
  if (e.button !== 0) return;

  e.preventDefault();
  pointerDownAt = Date.now();
  pointerDownIdx = i;

  // Touch / pen long press → mark.
  if (e.pointerType !== 'mouse') {
    if (longPressTimer !== null) window.clearTimeout(longPressTimer);
    const myGen = gen.current();
    longPressTimer = window.setTimeout(() => {
      longPressTimer = null;
      if (!gen.isCurrent(myGen)) return;
      if (pointerDownIdx !== i) return; // moved/cancelled
      toggleMark(i);
      pointerDownIdx = -1; // consumed → pointerup is a no-op
    }, LONG_PRESS_MS);

    // Cancel long-press if pointer moves or leaves.
    const cancelLong = () => {
      if (longPressTimer !== null) {
        window.clearTimeout(longPressTimer);
        longPressTimer = null;
      }
      target.removeEventListener('pointercancel', cancelLong);
      target.removeEventListener('pointerleave', cancelLong);
      target.removeEventListener('pointermove', onMove);
    };
    const onMove = (ev: PointerEvent) => {
      // Real drag (>8px) cancels.
      const dx = ev.movementX || 0;
      const dy = ev.movementY || 0;
      if (Math.abs(dx) + Math.abs(dy) > 8) cancelLong();
    };
    target.addEventListener('pointercancel', cancelLong);
    target.addEventListener('pointerleave', cancelLong);
    target.addEventListener('pointermove', onMove);
    target.addEventListener(
      'pointerup',
      () => {
        cancelLong();
        if (pointerDownIdx !== i) return; // long press consumed it
        if (Date.now() - pointerDownAt >= LONG_PRESS_MS) return;
        tryFill(i);
      },
      { once: true },
    );
    return;
  }

  // Mouse left-click → fill immediately on pointerup.
  target.addEventListener(
    'pointerup',
    () => {
      if (state !== 'playing') return;
      tryFill(i);
    },
    { once: true },
  );
}

function tryFill(i: number): void {
  if (state !== 'playing') return;
  const cs = cells[i];
  if (cs === 'filled' || cs === 'marked') return; // already decided
  const wantFilled = puzzle.solution[i] === 1;
  if (wantFilled) {
    cells[i] = 'filled';
    renderGrid();
    if (isSolved()) {
      onSolved();
    }
  } else {
    // Miss. Auto-mark + flash + lose a life.
    cells[i] = 'marked';
    renderGrid();
    flashWrong(i);
    lives -= 1;
    renderHud();
    if (lives <= 0) onGameOver();
  }
}

function toggleMark(i: number): void {
  if (state !== 'playing') return;
  const cs = cells[i];
  if (cs === 'filled') return; // can't mark a known-correct cell
  cells[i] = cs === 'marked' ? 'blank' : 'marked';
  renderGrid();
}

function flashWrong(i: number): void {
  const el = cellEls[i];
  if (!el) return;
  el.classList.add('ng-cell--wrong');
  const myGen = gen.current();
  window.setTimeout(() => {
    if (!gen.isCurrent(myGen)) return;
    el.classList.remove('ng-cell--wrong');
  }, WRONG_FLASH_MS);
}

function isSolved(): boolean {
  for (let i = 0; i < SIZE * SIZE; i++) {
    if (puzzle.solution[i] === 1 && cells[i] !== 'filled') return false;
  }
  return true;
}

// ---------- state transitions ----------

function onSolved(): void {
  state = 'won';
  solved += 1;
  if (solved > best) {
    best = solved;
    safeWrite(STORAGE_BEST, best);
  }
  renderHud();
  renderPuzzleName();
  overlayTitle.textContent = `${puzzle.name}!`;
  overlayMsg.textContent =
    `Bulmaca çözüldü. Kalan canın: ${lives}/${MAX_LIVES}.\n` +
    `Çözdüğün bulmaca: ${solved}`;
  overlayNext.textContent = 'Sıradaki';
  showOverlay(overlay);
  // Defer focus so iOS keyboard / focus ring renders cleanly.
  overlayNext.focus({ preventScroll: true });
}

function onGameOver(): void {
  state = 'gameover';
  renderHud();
  renderPuzzleName();
  overlayTitle.textContent = 'Bitti';
  overlayMsg.textContent =
    `Doğru cevap: ${puzzle.name}.\n` +
    `Bu turda ${solved} bulmaca çözdün.`;
  overlayNext.textContent = 'Yeniden başla';
  reportGameOver(SCORE_DESC, solved, { label: 'Bulmaca' });
  showOverlay(overlay);
  overlayNext.focus({ preventScroll: true });
}

function nextPuzzle(): void {
  if (order.length === 0) order = shuffledOrder();
  if (puzzleCursor >= order.length) {
    order = shuffledOrder();
    puzzleCursor = 0;
  }
  const idx = order[puzzleCursor]!;
  puzzleCursor += 1;
  puzzle = PUZZLES[idx]!;
  cells = new Array(SIZE * SIZE).fill('blank') as CellState[];
  state = 'playing';
  hideOverlay(overlay);
  renderHints();
  renderGrid();
  renderPuzzleName();
}

function skip(): void {
  // Player gives up on current puzzle. No score change, no life cost; just
  // jumps to a new puzzle. Only valid mid-game.
  if (state !== 'playing') return;
  gen.bump();
  nextPuzzle();
}

function startRun(): void {
  // Begin a fresh score-tracking run from puzzle #0.
  gen.bump();
  lives = MAX_LIVES;
  solved = 0;
  order = shuffledOrder();
  puzzleCursor = 0;
  renderHud();
  nextPuzzle();
}

function onOverlayPrimary(): void {
  if (state === 'won') {
    nextPuzzle();
  } else if (state === 'gameover') {
    startRun();
  }
}

// ---------- init ----------

function init(): void {
  solvedEl = document.querySelector<HTMLElement>('#solved')!;
  livesEl = document.querySelector<HTMLElement>('#lives')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  puzzleNameEl = document.querySelector<HTMLElement>('#puzzle-name')!;
  cornerEl = document.querySelector<HTMLElement>('#ng-corner')!;
  colHintsEl = document.querySelector<HTMLElement>('#ng-col-hints')!;
  rowHintsEl = document.querySelector<HTMLElement>('#ng-row-hints')!;
  gridEl = document.querySelector<HTMLElement>('#ng-grid')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayNext = document.querySelector<HTMLButtonElement>('#overlay-next')!;

  best = safeRead<number>(STORAGE_BEST, 0);
  if (!Number.isFinite(best) || best < 0) best = 0;

  // Decorative — keeps the grid alignment when col/row hint cells are empty.
  cornerEl.setAttribute('aria-hidden', 'true');

  restartBtn.addEventListener('click', startRun);
  overlayNext.addEventListener('click', onOverlayPrimary);
  // Prevent the page's context menu from showing inside the board.
  gridEl.addEventListener('contextmenu', (e) => e.preventDefault());

  window.addEventListener('keydown', (e) => {
    if (e.key === 'r' || e.key === 'R') {
      startRun();
      e.preventDefault();
    } else if (e.key === 'n' || e.key === 'N') {
      if (state === 'playing') {
        skip();
        e.preventDefault();
      }
    } else if (e.key === 'Enter' || e.key === ' ') {
      if (state === 'won' || state === 'gameover') {
        onOverlayPrimary();
        e.preventDefault();
      }
    }
  });

  buildGrid();
  startRun();
}

export const game = defineGame({ init, reset: startRun });
