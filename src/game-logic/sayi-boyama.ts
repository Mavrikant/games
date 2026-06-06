// Sayı Boyama (Nonogram / Picross): paint the hidden picture so that every
// row and column matches its number clues. Win = all row AND column clues
// satisfied by the currently filled cells (✕ marks are player aids only).
//
// PITFALLS guarded here (read docs/PITFALLS.md before editing):
// - module-level-dom-access: every querySelector/listener lives in init().
// - unguarded-storage: best times go through safeRead/safeWrite.
// - stale-async-callback / invisible-boot: the running timer interval is
//   cleared in startGame() before a fresh puzzle is generated, so no tick
//   from the previous round leaks into the new one.
// - overlay-input-leak: an explicit `state` enum guards every input handler.

import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay, hideOverlay } from '@shared/overlay';
import { reportGameOver } from '@shared/leaderboard';

const SIZES = [5, 10] as const;
// Global leaderboard tracks the 10×10 board only — one fixed size so times are
// comparable. Lower time (seconds) is better.
const SCORE_DESC = { gameId: 'sayi-boyama-10', storageKey: 'sayi-boyama.best.10', direction: 'lower' as const };
const FILL_DENSITY = 0.55;

type CellState = 0 | 1 | 2; // 0 empty, 1 filled, 2 crossed
type GameState = 'playing' | 'won';
type Mode = 'fill' | 'cross';

let size = 10;
let solution: boolean[] = [];
let cells: CellState[] = [];
let rowClues: number[][] = [];
let colClues: number[][] = [];

let cellEls: HTMLButtonElement[] = [];
let topClueEls: HTMLElement[] = [];
let sideClueEls: HTMLElement[] = [];

let state: GameState = 'playing';
let mode: Mode = 'fill';

let started = false;
let startTime = 0;
let elapsed = 0;
let timerId: number | null = null;

let best: number | null = null;

let boardEl!: HTMLElement;
let timeEl!: HTMLElement;
let bestEl!: HTMLElement;
let modeBtn!: HTMLButtonElement;
let sizeBtn!: HTMLButtonElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayRestart!: HTMLButtonElement;

function bestKey(): string {
  return `sayi-boyama.best.${size}`;
}

function loadBest(): number | null {
  const v = safeRead<number>(bestKey(), 0);
  return Number.isFinite(v) && v > 0 ? v : null;
}

function idx(r: number, c: number): number {
  return r * size + c;
}

// Runs of consecutive `true` values; empty line -> [].
function lineClue(values: boolean[]): number[] {
  const runs: number[] = [];
  let run = 0;
  for (const v of values) {
    if (v) {
      run++;
    } else if (run > 0) {
      runs.push(run);
      run = 0;
    }
  }
  if (run > 0) runs.push(run);
  return runs;
}

function rowValues(g: boolean[], r: number): boolean[] {
  const out: boolean[] = [];
  for (let c = 0; c < size; c++) out.push(g[idx(r, c)]!);
  return out;
}

function colValues(g: boolean[], c: number): boolean[] {
  const out: boolean[] = [];
  for (let r = 0; r < size; r++) out.push(g[idx(r, c)]!);
  return out;
}

function arraysEqual(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function generatePuzzle(): void {
  solution = new Array(size * size);
  for (let i = 0; i < solution.length; i++) {
    solution[i] = Math.random() < FILL_DENSITY;
  }
  // Avoid a fully blank board (trivial / no clues at all).
  if (solution.every((v) => !v)) {
    solution[Math.floor(Math.random() * solution.length)] = true;
  }
  rowClues = [];
  colClues = [];
  for (let r = 0; r < size; r++) rowClues.push(lineClue(rowValues(solution, r)));
  for (let c = 0; c < size; c++) colClues.push(lineClue(colValues(solution, c)));
  cells = new Array(size * size).fill(0);
}

function clueText(clue: number[]): number[] {
  return clue.length === 0 ? [0] : clue;
}

function buildBoard(): void {
  boardEl.innerHTML = '';
  cellEls = [];
  topClueEls = [];
  sideClueEls = [];

  boardEl.style.gridTemplateColumns = `auto repeat(${size}, 1fr)`;
  boardEl.style.setProperty('--ng-fs', size <= 5 ? '15px' : '11px');

  // Row 1: corner + column clues.
  const corner = document.createElement('div');
  corner.className = 'ng-corner';
  corner.setAttribute('aria-hidden', 'true');
  boardEl.appendChild(corner);

  for (let c = 0; c < size; c++) {
    const el = document.createElement('div');
    el.className = 'ng-clue ng-clue--top';
    for (const n of clueText(colClues[c]!)) {
      const span = document.createElement('span');
      span.textContent = String(n);
      el.appendChild(span);
    }
    boardEl.appendChild(el);
    topClueEls.push(el);
  }

  // Remaining rows: side clue + cells.
  for (let r = 0; r < size; r++) {
    const side = document.createElement('div');
    side.className = 'ng-clue ng-clue--side';
    for (const n of clueText(rowClues[r]!)) {
      const span = document.createElement('span');
      span.textContent = String(n);
      side.appendChild(span);
    }
    boardEl.appendChild(side);
    sideClueEls.push(side);

    for (let c = 0; c < size; c++) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ng-cell';
      btn.setAttribute('role', 'gridcell');
      btn.setAttribute('aria-label', `Hücre ${r + 1}, ${c + 1}`);
      const i = idx(r, c);
      btn.dataset.i = String(i);
      btn.addEventListener('click', () => applyAt(i, mode));
      btn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        applyAt(i, 'cross');
      });
      boardEl.appendChild(btn);
      cellEls.push(btn);
    }
  }
}

function renderCell(i: number): void {
  const btn = cellEls[i]!;
  const s = cells[i]!;
  btn.classList.toggle('ng-cell--fill', s === 1);
  btn.classList.toggle('ng-cell--cross', s === 2);
  btn.setAttribute('aria-pressed', s === 1 ? 'true' : 'false');
}

function renderAllCells(): void {
  for (let i = 0; i < cellEls.length; i++) renderCell(i);
}

function filledLine(values: CellState[]): boolean[] {
  return values.map((s) => s === 1);
}

function rowStates(r: number): CellState[] {
  const out: CellState[] = [];
  for (let c = 0; c < size; c++) out.push(cells[idx(r, c)]!);
  return out;
}

function colStates(c: number): CellState[] {
  const out: CellState[] = [];
  for (let r = 0; r < size; r++) out.push(cells[idx(r, c)]!);
  return out;
}

function rowDone(r: number): boolean {
  return arraysEqual(lineClue(filledLine(rowStates(r))), rowClues[r]!);
}

function colDone(c: number): boolean {
  return arraysEqual(lineClue(filledLine(colStates(c))), colClues[c]!);
}

function updateClueStatus(): void {
  for (let r = 0; r < size; r++) {
    sideClueEls[r]!.classList.toggle('ng-clue--done', rowDone(r));
  }
  for (let c = 0; c < size; c++) {
    topClueEls[c]!.classList.toggle('ng-clue--done', colDone(c));
  }
}

function isSolved(): boolean {
  for (let r = 0; r < size; r++) if (!rowDone(r)) return false;
  for (let c = 0; c < size; c++) if (!colDone(c)) return false;
  return true;
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function renderTime(): void {
  timeEl.textContent = formatTime(elapsed);
}

function renderBest(): void {
  bestEl.textContent = best === null ? '—' : formatTime(best);
}

function stopTimer(): void {
  if (timerId !== null) {
    window.clearInterval(timerId);
    timerId = null;
  }
}

function startTimer(): void {
  stopTimer();
  startTime = Date.now();
  timerId = window.setInterval(() => {
    elapsed = Math.floor((Date.now() - startTime) / 1000);
    renderTime();
  }, 250);
}

function applyAt(i: number, action: Mode): void {
  if (state !== 'playing') return;
  if (!started) {
    started = true;
    startTimer();
  }
  const cur = cells[i]!;
  if (action === 'fill') {
    cells[i] = cur === 1 ? 0 : 1;
  } else {
    cells[i] = cur === 2 ? 0 : 2;
  }
  renderCell(i);
  updateClueStatus();

  if (isSolved()) win();
}

function win(): void {
  state = 'won';
  stopTimer();
  elapsed = started ? Math.floor((Date.now() - startTime) / 1000) : 0;
  renderTime();

  const isRecord = best === null || elapsed < best;
  if (isRecord) {
    best = elapsed;
    safeWrite(bestKey(), best);
    renderBest();
  }
  if (size === 10) reportGameOver(SCORE_DESC, elapsed, { label: 'Süre', unit: 'sn' });
  overlayTitle.textContent = isRecord ? 'Yeni rekor!' : 'Tamamlandı!';
  overlayMsg.textContent = `${size}×${size} bulmacayı ${formatTime(elapsed)} sürede çözdün.`;
  showOverlay(overlay);
  overlayRestart.focus({ preventScroll: true });
}

function setMode(next: Mode): void {
  mode = next;
  modeBtn.textContent = mode === 'fill' ? 'Mod: Boya' : 'Mod: İşaret';
  modeBtn.setAttribute('aria-pressed', mode === 'cross' ? 'true' : 'false');
}

function startGame(): void {
  stopTimer();
  state = 'playing';
  started = false;
  elapsed = 0;
  generatePuzzle();
  buildBoard();
  renderAllCells();
  updateClueStatus();
  renderTime();
  renderBest();
  hideOverlay(overlay);
}

function cycleSize(): void {
  const cur = SIZES.indexOf(size as (typeof SIZES)[number]);
  size = SIZES[(cur + 1) % SIZES.length]!;
  sizeBtn.textContent = `${size}×${size}`;
  best = loadBest();
  startGame();
}

function init(): void {
  boardEl = document.querySelector<HTMLElement>('#board')!;
  timeEl = document.querySelector<HTMLElement>('#time')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  modeBtn = document.querySelector<HTMLButtonElement>('#mode')!;
  sizeBtn = document.querySelector<HTMLButtonElement>('#size')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayRestart = document.querySelector<HTMLButtonElement>('#overlay-restart')!;

  sizeBtn.textContent = `${size}×${size}`;
  setMode('fill');
  best = loadBest();

  modeBtn.addEventListener('click', () => setMode(mode === 'fill' ? 'cross' : 'fill'));
  sizeBtn.addEventListener('click', cycleSize);
  restartBtn.addEventListener('click', startGame);
  overlayRestart.addEventListener('click', startGame);

  window.addEventListener('keydown', (e) => {
    if (e.key === 'r' || e.key === 'R') {
      startGame();
      e.preventDefault();
    } else if (e.key === 'm' || e.key === 'M') {
      setMode(mode === 'fill' ? 'cross' : 'fill');
      e.preventDefault();
    } else if (e.key === 'Enter' && state === 'won') {
      startGame();
      e.preventDefault();
    }
  });

  startGame();
}

export const game = defineGame({ init, reset: startGame });
