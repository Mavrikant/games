import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import {
  showOverlay as showOverlayEl,
  hideOverlay as hideOverlayEl,
} from '@shared/overlay';

type Cell = 0 | 1 | 2; // 0 = empty, 1 = sun, 2 = moon
type Constraint = 0 | 1 | 2; // 0 = none, 1 = equal, 2 = differ
type Difficulty = 'easy' | 'medium' | 'hard';
type State = 'playing' | 'won';

const N = 6;
const STORAGE_DIFF = 'ay-gunes.difficulty';
const STORAGE_BEST: Record<Difficulty, string> = {
  easy: 'ay-gunes.best-easy',
  medium: 'ay-gunes.best-medium',
  hard: 'ay-gunes.best-hard',
};

interface Puzzle {
  initial: Cell[];
  fixed: boolean[];
  hCon: Constraint[]; // length N * (N-1)
  vCon: Constraint[]; // length (N-1) * N
}

let state: State = 'playing';
let difficulty: Difficulty = 'easy';
let puzzle: Puzzle = makePuzzle('easy');
let cells: Cell[] = [];
let errors: boolean[] = [];
let hConErr: boolean[] = [];
let vConErr: boolean[] = [];
let moves = 0;
let bestMoves: Record<Difficulty, number> = { easy: 0, medium: 0, hard: 0 };

let boardEl!: HTMLElement;
let movesEl!: HTMLElement;
let bestEl!: HTMLElement;
let diffSel!: HTMLSelectElement;
let restartBtn!: HTMLButtonElement;
let newBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayNewBtn!: HTMLButtonElement;

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
  return arr;
}

function fillBacktrack(grid: Cell[], idx: number): boolean {
  if (idx === N * N) return true;
  const r = Math.floor(idx / N);
  const c = idx % N;
  const opts: Cell[] = shuffle<Cell>([1, 2]);
  for (const v of opts) {
    grid[idx] = v;
    if (validForFilling(grid, r, c)) {
      if (fillBacktrack(grid, idx + 1)) return true;
    }
  }
  grid[idx] = 0;
  return false;
}

function validForFilling(grid: Cell[], r: number, c: number): boolean {
  const v = grid[r * N + c];
  if (c >= 2 && grid[r * N + c - 1] === v && grid[r * N + c - 2] === v) return false;
  if (r >= 2 && grid[(r - 1) * N + c] === v && grid[(r - 2) * N + c] === v) return false;
  if (c === N - 1) {
    let suns = 0;
    for (let x = 0; x < N; x++) if (grid[r * N + x] === 1) suns++;
    if (suns !== N / 2) return false;
  }
  if (r === N - 1) {
    let suns = 0;
    for (let y = 0; y < N; y++) if (grid[y * N + c] === 1) suns++;
    if (suns !== N / 2) return false;
  }
  return true;
}

function generateSolution(): Cell[] {
  const g = new Array<Cell>(N * N).fill(0);
  fillBacktrack(g, 0);
  return g;
}

function makePuzzle(diff: Difficulty): Puzzle {
  const solution = generateSolution();

  let clueCount: number;
  let constraintCount: number;
  if (diff === 'easy') {
    clueCount = 20;
    constraintCount = 4;
  } else if (diff === 'medium') {
    clueCount = 15;
    constraintCount = 6;
  } else {
    clueCount = 10;
    constraintCount = 9;
  }

  const order = shuffle([...Array(N * N).keys()]);
  const fixed = new Array<boolean>(N * N).fill(false);
  for (let k = 0; k < clueCount; k++) fixed[order[k]!] = true;
  const initial = solution.map((v, i) => (fixed[i] ? v : 0)) as Cell[];

  const hCon = new Array<Constraint>(N * (N - 1)).fill(0);
  const vCon = new Array<Constraint>((N - 1) * N).fill(0);

  type Edge = { kind: 'h' | 'v'; idx: number; a: number; b: number };
  const edges: Edge[] = [];
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N - 1; c++) {
      edges.push({ kind: 'h', idx: r * (N - 1) + c, a: r * N + c, b: r * N + c + 1 });
    }
  }
  for (let r = 0; r < N - 1; r++) {
    for (let c = 0; c < N; c++) {
      edges.push({ kind: 'v', idx: r * N + c, a: r * N + c, b: (r + 1) * N + c });
    }
  }
  shuffle(edges);

  let added = 0;
  for (const e of edges) {
    if (added >= constraintCount) break;
    // Prefer placing constraints touching at least one non-clue cell.
    if (fixed[e.a] && fixed[e.b]) continue;
    const con: Constraint = solution[e.a] === solution[e.b] ? 1 : 2;
    if (e.kind === 'h') hCon[e.idx] = con;
    else vCon[e.idx] = con;
    added++;
  }

  return { initial, fixed, hCon, vCon };
}

function loadDifficulty(): Difficulty {
  const raw = safeRead<string>(STORAGE_DIFF, 'easy');
  if (raw === 'medium' || raw === 'hard') return raw;
  return 'easy';
}

function loadBests(): void {
  bestMoves = {
    easy: safeRead<number>(STORAGE_BEST.easy, 0),
    medium: safeRead<number>(STORAGE_BEST.medium, 0),
    hard: safeRead<number>(STORAGE_BEST.hard, 0),
  };
}

function buildBoard(): void {
  boardEl.innerHTML = '';

  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ag-cell';
      btn.dataset.idx = String(r * N + c);
      btn.setAttribute('role', 'gridcell');
      btn.setAttribute('aria-label', `Satır ${r + 1}, sütun ${c + 1}`);
      btn.style.gridRow = String(2 * r + 1);
      btn.style.gridColumn = String(2 * c + 1);
      boardEl.appendChild(btn);

      if (c < N - 1) {
        const h = document.createElement('div');
        h.className = 'ag-con ag-con--h';
        h.dataset.hc = String(r * (N - 1) + c);
        h.setAttribute('aria-hidden', 'true');
        h.style.gridRow = String(2 * r + 1);
        h.style.gridColumn = String(2 * c + 2);
        boardEl.appendChild(h);
      }
      if (r < N - 1) {
        const v = document.createElement('div');
        v.className = 'ag-con ag-con--v';
        v.dataset.vc = String(r * N + c);
        v.setAttribute('aria-hidden', 'true');
        v.style.gridRow = String(2 * r + 2);
        v.style.gridColumn = String(2 * c + 1);
        boardEl.appendChild(v);
      }
    }
  }

  boardEl.addEventListener('click', onBoardClick);
}

function onBoardClick(e: MouseEvent): void {
  if (state !== 'playing') return;
  const target = e.target as HTMLElement;
  const btn = target.closest<HTMLButtonElement>('.ag-cell');
  if (!btn) return;
  const idx = Number(btn.dataset.idx);
  if (!Number.isInteger(idx) || idx < 0 || idx >= N * N) return;
  if (puzzle.fixed[idx]) return;
  const prev = cells[idx]!;
  const next: Cell = prev === 0 ? 1 : prev === 1 ? 2 : 0;
  cells[idx] = next;
  moves++;
  computeErrors();
  render();
  if (isWin()) onWin();
}

function computeErrors(): void {
  errors = new Array<boolean>(N * N).fill(false);
  hConErr = new Array<boolean>(N * (N - 1)).fill(false);
  vConErr = new Array<boolean>((N - 1) * N).fill(false);

  // Three-in-a-row in rows
  for (let r = 0; r < N; r++) {
    for (let c = 0; c <= N - 3; c++) {
      const i1 = r * N + c;
      const i2 = r * N + c + 1;
      const i3 = r * N + c + 2;
      const v = cells[i1]!;
      if (v !== 0 && cells[i2] === v && cells[i3] === v) {
        errors[i1] = errors[i2] = errors[i3] = true;
      }
    }
  }
  // Three-in-a-row in cols
  for (let c = 0; c < N; c++) {
    for (let r = 0; r <= N - 3; r++) {
      const i1 = r * N + c;
      const i2 = (r + 1) * N + c;
      const i3 = (r + 2) * N + c;
      const v = cells[i1]!;
      if (v !== 0 && cells[i2] === v && cells[i3] === v) {
        errors[i1] = errors[i2] = errors[i3] = true;
      }
    }
  }
  // Row balance overflow
  for (let r = 0; r < N; r++) {
    let suns = 0;
    let moons = 0;
    for (let c = 0; c < N; c++) {
      if (cells[r * N + c] === 1) suns++;
      else if (cells[r * N + c] === 2) moons++;
    }
    if (suns > N / 2 || moons > N / 2) {
      const tooMany: Cell = suns > N / 2 ? 1 : 2;
      for (let c = 0; c < N; c++) if (cells[r * N + c] === tooMany) errors[r * N + c] = true;
    }
  }
  // Col balance overflow
  for (let c = 0; c < N; c++) {
    let suns = 0;
    let moons = 0;
    for (let r = 0; r < N; r++) {
      if (cells[r * N + c] === 1) suns++;
      else if (cells[r * N + c] === 2) moons++;
    }
    if (suns > N / 2 || moons > N / 2) {
      const tooMany: Cell = suns > N / 2 ? 1 : 2;
      for (let r = 0; r < N; r++) if (cells[r * N + c] === tooMany) errors[r * N + c] = true;
    }
  }
  // Horizontal constraints
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N - 1; c++) {
      const idx = r * (N - 1) + c;
      const k = puzzle.hCon[idx]!;
      if (k === 0) continue;
      const a = cells[r * N + c]!;
      const b = cells[r * N + c + 1]!;
      if (a === 0 || b === 0) continue;
      if ((k === 1 && a !== b) || (k === 2 && a === b)) {
        hConErr[idx] = true;
        errors[r * N + c] = true;
        errors[r * N + c + 1] = true;
      }
    }
  }
  // Vertical constraints
  for (let r = 0; r < N - 1; r++) {
    for (let c = 0; c < N; c++) {
      const idx = r * N + c;
      const k = puzzle.vCon[idx]!;
      if (k === 0) continue;
      const a = cells[r * N + c]!;
      const b = cells[(r + 1) * N + c]!;
      if (a === 0 || b === 0) continue;
      if ((k === 1 && a !== b) || (k === 2 && a === b)) {
        vConErr[idx] = true;
        errors[r * N + c] = true;
        errors[(r + 1) * N + c] = true;
      }
    }
  }
}

function isWin(): boolean {
  for (let i = 0; i < N * N; i++) if (cells[i] === 0) return false;
  for (let i = 0; i < errors.length; i++) if (errors[i]) return false;
  for (let i = 0; i < hConErr.length; i++) if (hConErr[i]) return false;
  for (let i = 0; i < vConErr.length; i++) if (vConErr[i]) return false;
  return true;
}

function render(): void {
  for (let i = 0; i < N * N; i++) {
    const btn = boardEl.querySelector<HTMLButtonElement>(`[data-idx="${i}"]`);
    if (!btn) continue;
    const v = cells[i]!;
    btn.textContent = v === 1 ? '☀' : v === 2 ? '☾' : '';
    btn.classList.toggle('ag-cell--sun', v === 1);
    btn.classList.toggle('ag-cell--moon', v === 2);
    btn.classList.toggle('ag-cell--fixed', puzzle.fixed[i] === true);
    btn.classList.toggle('ag-cell--error', errors[i] === true);
    btn.disabled = puzzle.fixed[i] === true || state === 'won';
  }
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N - 1; c++) {
      const idx = r * (N - 1) + c;
      const el = boardEl.querySelector<HTMLDivElement>(`[data-hc="${idx}"]`);
      if (!el) continue;
      const k = puzzle.hCon[idx]!;
      el.textContent = k === 1 ? '=' : k === 2 ? '×' : '';
      el.classList.toggle('ag-con--eq', k === 1);
      el.classList.toggle('ag-con--ne', k === 2);
      el.classList.toggle('ag-con--err', hConErr[idx] === true);
    }
  }
  for (let r = 0; r < N - 1; r++) {
    for (let c = 0; c < N; c++) {
      const idx = r * N + c;
      const el = boardEl.querySelector<HTMLDivElement>(`[data-vc="${idx}"]`);
      if (!el) continue;
      const k = puzzle.vCon[idx]!;
      el.textContent = k === 1 ? '=' : k === 2 ? '×' : '';
      el.classList.toggle('ag-con--eq', k === 1);
      el.classList.toggle('ag-con--ne', k === 2);
      el.classList.toggle('ag-con--err', vConErr[idx] === true);
    }
  }
  movesEl.textContent = String(moves);
  const b = bestMoves[difficulty];
  bestEl.textContent = b > 0 ? String(b) : '—';
}

function onWin(): void {
  state = 'won';
  const prev = bestMoves[difficulty];
  const beaten = prev === 0 || moves < prev;
  if (beaten) {
    bestMoves[difficulty] = moves;
    safeWrite(STORAGE_BEST[difficulty], moves);
  }
  overlayTitle.textContent = 'Tebrikler!';
  overlayMsg.textContent = beaten
    ? `Yeni rekor: ${moves} hamle`
    : `${moves} hamle ile bitirdin · rekor ${prev}`;
  showOverlayEl(overlay);
  render();
}

function startPuzzle(newOne: boolean): void {
  if (newOne) puzzle = makePuzzle(difficulty);
  cells = puzzle.initial.slice() as Cell[];
  state = 'playing';
  moves = 0;
  computeErrors();
  hideOverlayEl(overlay);
  render();
}

function reset(): void {
  startPuzzle(false);
}

function newBoard(): void {
  startPuzzle(true);
}

function setDifficulty(d: Difficulty): void {
  difficulty = d;
  safeWrite(STORAGE_DIFF, d);
  diffSel.value = d;
  startPuzzle(true);
}

function init(): void {
  boardEl = document.querySelector<HTMLElement>('#board')!;
  movesEl = document.querySelector<HTMLElement>('#moves')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  diffSel = document.querySelector<HTMLSelectElement>('#difficulty')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  newBtn = document.querySelector<HTMLButtonElement>('#new-board')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayNewBtn = document.querySelector<HTMLButtonElement>('#overlay-new')!;

  loadBests();
  difficulty = loadDifficulty();
  diffSel.value = difficulty;

  buildBoard();

  diffSel.addEventListener('change', () => {
    const v = diffSel.value;
    if (v === 'easy' || v === 'medium' || v === 'hard') setDifficulty(v);
  });
  restartBtn.addEventListener('click', reset);
  newBtn.addEventListener('click', newBoard);
  overlayNewBtn.addEventListener('click', newBoard);

  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLSelectElement) return;
    const k = e.key.toLowerCase();
    if (k === 'r') {
      reset();
      e.preventDefault();
    } else if (k === 'n') {
      newBoard();
      e.preventDefault();
    }
  });

  puzzle = makePuzzle(difficulty);
  startPuzzle(false);
}

export const game = defineGame({ init, reset });
