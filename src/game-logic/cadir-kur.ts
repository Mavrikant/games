import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay, hideOverlay } from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';

// Çadır Kur — Tents and Trees logic puzzle. The puzzle generator places K
// pairwise non-adjacent tents (king-move) on an N×N grid, then assigns each
// tent an orthogonal tree neighbour. Row/column tent counts become the
// public clues; the player rebuilds the placement.
//
// PITFALLS guards:
// - unguarded-storage: safeRead/safeWrite for high score persistence.
// - stale-async-callback: gen.bump() on reset + explicit clearInterval for
//   the wall-clock timer (the only periodic side effect).
// - overlay-input-leak: explicit state enum; the win overlay swallows
//   gameplay input via top-of-handler `state !== 'playing'` guards.
// - module-level side effects: all DOM access lives in init().
// - stale-dom-from-prev-state: renderBoard() rebuilds the grid from scratch
//   before each level, then paintAll() syncs cell visuals.

const STORAGE_BEST = 'cadir-kur.best';

type CellState = 'empty' | 'tree' | 'tent' | 'grass';
type State = 'playing' | 'won';

interface Puzzle {
  n: number;
  trees: number[];
  rowClues: number[];
  colClues: number[];
  solution: number[]; // cell indices that should hold a tent
}

const gen = createGenToken();

let state: State = 'playing';
let level = 1;
let bestLevel = 0;
let moves = 0;
let hintsLeft = 3;
let startTime = 0;
let timerId: number | null = null;

let puzzle: Puzzle = { n: 0, trees: [], rowClues: [], colClues: [], solution: [] };
let cells: CellState[] = [];

let levelEl!: HTMLElement;
let movesEl!: HTMLElement;
let timeEl!: HTMLElement;
let hintsEl!: HTMLElement;
let hintBtn!: HTMLButtonElement;
let restartBtn!: HTMLButtonElement;
let nextBtn!: HTMLButtonElement;
let boardEl!: HTMLElement;
let overlayEl!: HTMLElement;
let overlayTitleEl!: HTMLElement;
let overlayMsgEl!: HTMLElement;
let overlayNextBtn!: HTMLButtonElement;

let cellEls: HTMLButtonElement[] = [];
let rowClueEls: HTMLElement[] = [];
let colClueEls: HTMLElement[] = [];

function idx(n: number, r: number, c: number): number {
  return r * n + c;
}
function rOf(n: number, i: number): number {
  return Math.floor(i / n);
}
function cOf(n: number, i: number): number {
  return i % n;
}

function neighbors4(n: number, i: number): number[] {
  const r = rOf(n, i);
  const c = cOf(n, i);
  const out: number[] = [];
  if (r > 0) out.push(idx(n, r - 1, c));
  if (r < n - 1) out.push(idx(n, r + 1, c));
  if (c > 0) out.push(idx(n, r, c - 1));
  if (c < n - 1) out.push(idx(n, r, c + 1));
  return out;
}

function neighbors8(n: number, i: number): number[] {
  const r = rOf(n, i);
  const c = cOf(n, i);
  const out: number[] = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nr >= n || nc < 0 || nc >= n) continue;
      out.push(idx(n, nr, nc));
    }
  }
  return out;
}

function shuffled<T>(arr: readonly T[]): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

function levelConfig(lvl: number): { n: number; k: number } {
  if (lvl <= 1) return { n: 5, k: 4 };
  if (lvl === 2) return { n: 6, k: 5 };
  if (lvl === 3) return { n: 6, k: 6 };
  if (lvl === 4) return { n: 7, k: 7 };
  if (lvl === 5) return { n: 7, k: 9 };
  if (lvl === 6) return { n: 8, k: 10 };
  if (lvl === 7) return { n: 8, k: 12 };
  return { n: 9, k: 14 };
}

function generatePuzzle(n: number, k: number): Puzzle {
  for (let attempt = 0; attempt < 400; attempt++) {
    const tents: number[] = [];
    const blocked = new Set<number>();
    const order = shuffled(Array.from({ length: n * n }, (_, i) => i));
    for (const i of order) {
      if (tents.length === k) break;
      if (blocked.has(i)) continue;
      tents.push(i);
      blocked.add(i);
      for (const j of neighbors8(n, i)) blocked.add(j);
    }
    if (tents.length !== k) continue;

    const trees = new Set<number>();
    let ok = true;
    for (const t of tents) {
      const candidates = neighbors4(n, t).filter(
        (j) => !tents.includes(j) && !trees.has(j),
      );
      if (candidates.length === 0) {
        ok = false;
        break;
      }
      const pick = candidates[Math.floor(Math.random() * candidates.length)]!;
      trees.add(pick);
    }
    if (!ok) continue;

    const rowClues = new Array<number>(n).fill(0);
    const colClues = new Array<number>(n).fill(0);
    for (const t of tents) {
      rowClues[rOf(n, t)]! += 1;
      colClues[cOf(n, t)]! += 1;
    }

    return {
      n,
      trees: [...trees].sort((a, b) => a - b),
      rowClues,
      colClues,
      solution: tents.slice().sort((a, b) => a - b),
    };
  }
  // Should never happen with reasonable k; return a minimal fallback.
  return {
    n,
    trees: [],
    rowClues: new Array<number>(n).fill(0),
    colClues: new Array<number>(n).fill(0),
    solution: [],
  };
}

function makeClueCell(text: string, kind: 'row' | 'col' | 'corner'): HTMLElement {
  const el = document.createElement('div');
  el.className = `ck-clue ck-clue--${kind}`;
  el.textContent = text;
  return el;
}

function renderBoard(): void {
  boardEl.innerHTML = '';
  cellEls = [];
  rowClueEls = [];
  colClueEls = [];
  const n = puzzle.n;
  boardEl.style.setProperty('--ck-n', String(n));

  boardEl.appendChild(makeClueCell('', 'corner'));
  for (let c = 0; c < n; c++) {
    const el = makeClueCell(String(puzzle.colClues[c]!), 'col');
    boardEl.appendChild(el);
    colClueEls.push(el);
  }

  for (let r = 0; r < n; r++) {
    const rc = makeClueCell(String(puzzle.rowClues[r]!), 'row');
    boardEl.appendChild(rc);
    rowClueEls.push(rc);

    for (let c = 0; c < n; c++) {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'ck-cell';
      cell.setAttribute('role', 'gridcell');
      cell.setAttribute('aria-label', `${r + 1}. satır ${c + 1}. sütun`);
      cell.dataset['i'] = String(idx(n, r, c));
      boardEl.appendChild(cell);
      cellEls.push(cell);
    }
  }
}

function paintCell(i: number): void {
  const el = cellEls[i]!;
  const c = cells[i]!;
  el.classList.toggle('ck-cell--tree', c === 'tree');
  el.classList.toggle('ck-cell--tent', c === 'tent');
  el.classList.toggle('ck-cell--grass', c === 'grass');
  el.classList.toggle('ck-cell--empty', c === 'empty');
  el.classList.remove('ck-cell--bad');
  if (c === 'tree') el.textContent = '🌲';
  else if (c === 'tent') el.textContent = '⛺';
  else if (c === 'grass') el.textContent = '·';
  else el.textContent = '';
}

function countInRow(r: number, target: CellState): number {
  const n = puzzle.n;
  let k = 0;
  for (let c = 0; c < n; c++) if (cells[idx(n, r, c)] === target) k++;
  return k;
}

function countInCol(c: number, target: CellState): number {
  const n = puzzle.n;
  let k = 0;
  for (let r = 0; r < n; r++) if (cells[idx(n, r, c)] === target) k++;
  return k;
}

function updateClueColors(): void {
  const n = puzzle.n;
  for (let r = 0; r < n; r++) {
    const tents = countInRow(r, 'tent');
    const want = puzzle.rowClues[r]!;
    const el = rowClueEls[r]!;
    el.classList.toggle('ck-clue--ok', tents === want);
    el.classList.toggle('ck-clue--over', tents > want);
  }
  for (let c = 0; c < n; c++) {
    const tents = countInCol(c, 'tent');
    const want = puzzle.colClues[c]!;
    const el = colClueEls[c]!;
    el.classList.toggle('ck-clue--ok', tents === want);
    el.classList.toggle('ck-clue--over', tents > want);
  }
}

function highlightAdjacencyViolations(): void {
  const n = puzzle.n;
  const tents = cells
    .map((c, i) => (c === 'tent' ? i : -1))
    .filter((x) => x >= 0);
  for (const t of tents) {
    for (const j of neighbors8(n, t)) {
      if (cells[j] === 'tent') {
        cellEls[t]!.classList.add('ck-cell--bad');
        cellEls[j]!.classList.add('ck-cell--bad');
      }
    }
  }
}

function paintAll(): void {
  for (let i = 0; i < cells.length; i++) paintCell(i);
  highlightAdjacencyViolations();
  updateClueColors();
}

function updateHUD(): void {
  levelEl.textContent = String(level);
  movesEl.textContent = String(moves);
  hintsEl.textContent = String(hintsLeft);
}

function fmtTime(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function tickTime(): void {
  if (state !== 'playing') return;
  const sec = Math.floor((Date.now() - startTime) / 1000);
  timeEl.textContent = fmtTime(sec);
}

function startTimer(): void {
  stopTimer();
  startTime = Date.now();
  timeEl.textContent = '0:00';
  timerId = window.setInterval(tickTime, 1000);
}

function stopTimer(): void {
  if (timerId !== null) {
    window.clearInterval(timerId);
    timerId = null;
  }
}

function tentTreesMatchable(): boolean {
  // Bipartite matching: each tree must be matched to a distinct
  // orthogonally adjacent tent.
  const n = puzzle.n;
  const tentList: number[] = [];
  const treeList: number[] = [];
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] === 'tent') tentList.push(i);
    if (cells[i] === 'tree') treeList.push(i);
  }
  if (tentList.length !== treeList.length) return false;

  const tentIndex = new Map<number, number>();
  tentList.forEach((t, i) => tentIndex.set(t, i));

  // tentMatch[i] = tree-array index, or -1
  const tentMatch = new Array<number>(tentList.length).fill(-1);

  function tryAug(treeArrIdx: number, visited: Uint8Array): boolean {
    const tree = treeList[treeArrIdx]!;
    for (const nb of neighbors4(n, tree)) {
      const ti = tentIndex.get(nb);
      if (ti === undefined) continue;
      if (visited[ti]) continue;
      visited[ti] = 1;
      if (tentMatch[ti] === -1 || tryAug(tentMatch[ti]!, visited)) {
        tentMatch[ti] = treeArrIdx;
        return true;
      }
    }
    return false;
  }

  for (let i = 0; i < treeList.length; i++) {
    const visited = new Uint8Array(tentList.length);
    if (!tryAug(i, visited)) return false;
  }
  return true;
}

function checkWin(): boolean {
  const n = puzzle.n;
  // (1) row/col tent counts
  for (let r = 0; r < n; r++) {
    if (countInRow(r, 'tent') !== puzzle.rowClues[r]) return false;
  }
  for (let c = 0; c < n; c++) {
    if (countInCol(c, 'tent') !== puzzle.colClues[c]) return false;
  }
  // (2) no two tents touch (king-move)
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] !== 'tent') continue;
    for (const j of neighbors8(n, i)) {
      if (cells[j] === 'tent') return false;
    }
  }
  // (3) bipartite matching tree↔tent
  return tentTreesMatchable();
}

function onWin(): void {
  state = 'won';
  stopTimer();
  if (level > bestLevel) {
    bestLevel = level;
    safeWrite(STORAGE_BEST, bestLevel);
  }
  const finalTime = timeEl.textContent ?? '0:00';
  overlayTitleEl.textContent = 'Bölüm tamam!';
  overlayMsgEl.textContent = `${moves} hamle, süre ${finalTime}.\nSonraki bölüme geçebilirsin.`;
  showOverlay(overlayEl);
}

function placeAt(i: number, mode: 'tent' | 'grass'): void {
  if (state !== 'playing') return;
  const cur = cells[i];
  if (cur === 'tree') return;
  if (cur === mode) {
    cells[i] = 'empty';
  } else {
    cells[i] = mode;
  }
  moves += 1;
  updateHUD();
  paintAll();
  if (checkWin()) onWin();
}

function applyHint(): void {
  if (state !== 'playing') return;
  if (hintsLeft <= 0) return;
  const candidates: number[] = [];
  for (const s of puzzle.solution) {
    if (cells[s] !== 'tent') candidates.push(s);
  }
  if (candidates.length === 0) return;
  const pick = candidates[Math.floor(Math.random() * candidates.length)]!;
  cells[pick] = 'tent';
  hintsLeft -= 1;
  moves += 1;
  updateHUD();
  paintAll();
  if (checkWin()) onWin();
}

function newLevel(advance: boolean): void {
  gen.bump();
  stopTimer();
  hideOverlay(overlayEl);

  if (advance && state === 'won') level += 1;
  state = 'playing';
  moves = 0;
  hintsLeft = 3;

  const { n, k } = levelConfig(level);
  puzzle = generatePuzzle(n, k);
  cells = new Array<CellState>(puzzle.n * puzzle.n).fill('empty');
  for (const t of puzzle.trees) cells[t] = 'tree';

  renderBoard();
  paintAll();
  updateHUD();
  startTimer();
}

function resetLevel(): void {
  // Same puzzle, fresh attempt.
  gen.bump();
  stopTimer();
  hideOverlay(overlayEl);
  state = 'playing';
  moves = 0;
  hintsLeft = 3;
  cells = new Array<CellState>(puzzle.n * puzzle.n).fill('empty');
  for (const t of puzzle.trees) cells[t] = 'tree';
  paintAll();
  updateHUD();
  startTimer();
}

function onBoardClick(e: MouseEvent): void {
  const target = e.target;
  if (!(target instanceof HTMLElement)) return;
  if (!target.classList.contains('ck-cell')) return;
  const raw = target.dataset['i'];
  if (raw === undefined) return;
  const i = Number(raw);
  if (!Number.isFinite(i)) return;
  const mode: 'tent' | 'grass' = e.shiftKey ? 'grass' : 'tent';
  placeAt(i, mode);
}

function onBoardContext(e: MouseEvent): void {
  e.preventDefault();
  const target = e.target;
  if (!(target instanceof HTMLElement)) return;
  if (!target.classList.contains('ck-cell')) return;
  const raw = target.dataset['i'];
  if (raw === undefined) return;
  const i = Number(raw);
  if (!Number.isFinite(i)) return;
  placeAt(i, 'grass');
}

function onKey(e: KeyboardEvent): void {
  const k = e.key.toLowerCase();
  if (k === 'r') {
    e.preventDefault();
    resetLevel();
  } else if (k === 'n') {
    e.preventDefault();
    // 'N' always advances by 1; if you press N while playing, you skip.
    state = 'won';
    newLevel(true);
  } else if (k === 'h') {
    e.preventDefault();
    applyHint();
  }
}

function reset(): void {
  // Defensive entry point used by GameModule. Same as resetLevel.
  resetLevel();
}

function init(): void {
  levelEl = document.querySelector<HTMLElement>('#level')!;
  movesEl = document.querySelector<HTMLElement>('#moves')!;
  timeEl = document.querySelector<HTMLElement>('#time')!;
  hintsEl = document.querySelector<HTMLElement>('#hints')!;
  hintBtn = document.querySelector<HTMLButtonElement>('#hint-btn')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  nextBtn = document.querySelector<HTMLButtonElement>('#next-btn')!;
  boardEl = document.querySelector<HTMLElement>('#board')!;
  overlayEl = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitleEl = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsgEl = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayNextBtn = document.querySelector<HTMLButtonElement>('#overlay-next')!;

  bestLevel = safeRead<number>(STORAGE_BEST, 0);
  if (bestLevel > 0) level = Math.min(bestLevel, 4); // start near last best, cap

  boardEl.addEventListener('click', onBoardClick);
  boardEl.addEventListener('contextmenu', onBoardContext);
  restartBtn.addEventListener('click', resetLevel);
  hintBtn.addEventListener('click', applyHint);
  nextBtn.addEventListener('click', () => {
    state = 'won';
    newLevel(true);
  });
  overlayNextBtn.addEventListener('click', () => {
    newLevel(true);
  });
  window.addEventListener('keydown', onKey);

  newLevel(false);
}

export const game = defineGame({ init, reset });
