// Zar Yolcusu — roll a six-sided die across a 5×5 grid to deliver the right
// face onto each goal cell. The die's orientation is the puzzle: every roll
// permutes which face ends up on top, so reaching a goal physically isn't
// enough — you must arrive with the requested value showing.

import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import {
  showOverlay as showOverlayEl,
  hideOverlay as hideOverlayEl,
} from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';
import { reportGameOver } from '@shared/leaderboard';

const SIZE = 5;
const GOAL_COUNT = 3;
const STORAGE_BEST = 'zar-yolcusu.best';
const SCORE_DESC = {
  gameId: 'zar-yolcusu',
  storageKey: STORAGE_BEST,
  direction: 'lower' as const,
};
const WIN_DELAY_MS = 380;
const PIP_LAYOUT: Record<number, [number, number][]> = {
  1: [[1, 1]],
  2: [
    [0, 0],
    [2, 2],
  ],
  3: [
    [0, 0],
    [1, 1],
    [2, 2],
  ],
  4: [
    [0, 0],
    [0, 2],
    [2, 0],
    [2, 2],
  ],
  5: [
    [0, 0],
    [0, 2],
    [1, 1],
    [2, 0],
    [2, 2],
  ],
  6: [
    [0, 0],
    [0, 2],
    [1, 0],
    [1, 2],
    [2, 0],
    [2, 2],
  ],
};

type GameState = 'playing' | 'won';
type Die = { t: number; b: number; n: number; s: number; e: number; w: number };
type Goal = { r: number; c: number; value: number; collected: boolean };
type Pos = { r: number; c: number };

let boardEl!: HTMLElement;
let movesEl!: HTMLElement;
let goalsEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayRestart!: HTMLButtonElement;

let cellEls: HTMLDivElement[] = [];
let dieEl!: HTMLDivElement;
let diePipsEl!: HTMLDivElement;

let die: Die = makeDie();
let diePos: Pos = { r: 0, c: 0 };
let goals: Goal[] = [];
let moves = 0;
let best: number | null = null;
let state: GameState = 'playing';

const gen = createGenToken();

function makeDie(): Die {
  return { t: 1, b: 6, n: 2, s: 5, e: 3, w: 4 };
}

function rollNorth(d: Die): Die {
  return { t: d.s, b: d.n, n: d.t, s: d.b, e: d.e, w: d.w };
}
function rollSouth(d: Die): Die {
  return { t: d.n, b: d.s, n: d.b, s: d.t, e: d.e, w: d.w };
}
function rollEast(d: Die): Die {
  return { t: d.w, b: d.e, n: d.n, s: d.s, e: d.t, w: d.b };
}
function rollWest(d: Die): Die {
  return { t: d.e, b: d.w, n: d.n, s: d.s, e: d.b, w: d.t };
}

function loadBest(): number | null {
  const v = safeRead<number>(STORAGE_BEST, 0);
  return Number.isFinite(v) && v > 0 ? v : null;
}

function saveBest(): void {
  if (best !== null) safeWrite(STORAGE_BEST, best);
}

function idx(r: number, c: number): number {
  return r * SIZE + c;
}

function randInt(maxExclusive: number): number {
  return Math.floor(Math.random() * maxExclusive);
}

function newPuzzle(): void {
  die = makeDie();
  diePos = { r: 2, c: 2 };
  goals = [];
  const used = new Set<number>();
  used.add(idx(diePos.r, diePos.c));
  while (goals.length < GOAL_COUNT) {
    const r = randInt(SIZE);
    const c = randInt(SIZE);
    const k = idx(r, c);
    if (used.has(k)) continue;
    used.add(k);
    // Avoid value 1 only at start since the die starts top=1 on center;
    // any value is reachable from any cell with enough rolls, so just pick
    // freely. Adjacent-1 puzzles still need an extra trip to reset.
    const value = 1 + randInt(6);
    goals.push({ r, c, value, collected: false });
  }
}

function buildBoard(): void {
  boardEl.innerHTML = '';
  cellEls = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const cell = document.createElement('div');
      cell.className = 'zy-cell';
      cell.setAttribute('role', 'gridcell');
      cell.dataset.r = String(r);
      cell.dataset.c = String(c);
      boardEl.appendChild(cell);
      cellEls.push(cell);
    }
  }
  dieEl = document.createElement('div');
  dieEl.className = 'zy-die';
  dieEl.setAttribute('aria-label', 'Zar');
  diePipsEl = document.createElement('div');
  diePipsEl.className = 'zy-die__pips';
  dieEl.appendChild(diePipsEl);
  boardEl.appendChild(dieEl);
}

function renderGoals(): void {
  for (const cell of cellEls) {
    cell.classList.remove('zy-cell--goal', 'zy-cell--done');
    cell.textContent = '';
  }
  for (const g of goals) {
    const cell = cellEls[idx(g.r, g.c)]!;
    cell.classList.add('zy-cell--goal');
    cell.textContent = String(g.value);
    if (g.collected) cell.classList.add('zy-cell--done');
  }
}

function renderDie(): void {
  const cellSize = 100 / SIZE;
  dieEl.style.left = `${diePos.c * cellSize}%`;
  dieEl.style.top = `${diePos.r * cellSize}%`;
  renderPips();
}

function renderPips(): void {
  const layout = PIP_LAYOUT[die.t] ?? [];
  diePipsEl.innerHTML = '';
  for (const [row, col] of layout) {
    const pip = document.createElement('span');
    pip.className = 'zy-die__pip';
    pip.style.gridRow = String(row + 1);
    pip.style.gridColumn = String(col + 1);
    diePipsEl.appendChild(pip);
  }
}

function renderMoves(): void {
  movesEl.textContent = String(moves);
}

function renderGoalsCount(): void {
  const collected = goals.filter((g) => g.collected).length;
  goalsEl.textContent = `${collected}/${goals.length}`;
}

function renderBest(): void {
  bestEl.textContent = best === null ? '—' : String(best);
}

function tryRoll(dr: number, dc: number): void {
  if (state !== 'playing') return;
  const nr = diePos.r + dr;
  const nc = diePos.c + dc;
  if (nr < 0 || nr >= SIZE || nc < 0 || nc >= SIZE) return;
  if (dr === -1) die = rollNorth(die);
  else if (dr === 1) die = rollSouth(die);
  else if (dc === 1) die = rollEast(die);
  else if (dc === -1) die = rollWest(die);
  diePos = { r: nr, c: nc };
  moves++;
  renderMoves();
  renderDie();
  checkGoals();
}

function checkGoals(): void {
  let collectedNow = false;
  for (const g of goals) {
    if (g.collected) continue;
    if (g.r === diePos.r && g.c === diePos.c && g.value === die.t) {
      g.collected = true;
      collectedNow = true;
      const cell = cellEls[idx(g.r, g.c)]!;
      cell.classList.add('zy-cell--pop');
      window.setTimeout(() => cell.classList.remove('zy-cell--pop'), 320);
    }
  }
  if (collectedNow) {
    renderGoals();
    renderGoalsCount();
  }
  if (goals.every((g) => g.collected)) {
    state = 'won';
    const winMoves = moves;
    const myGen = gen.current();
    window.setTimeout(() => {
      if (!gen.isCurrent(myGen)) return;
      showWin(winMoves);
    }, WIN_DELAY_MS);
  }
}

function showWin(winMoves: number): void {
  const isBest = best === null || winMoves < best;
  if (isBest) {
    best = winMoves;
    saveBest();
    renderBest();
  }
  overlayTitle.textContent = isBest
    ? 'Yeni rekor!'
    : 'Tüm hedeflere ulaştın!';
  overlayMsg.textContent = `${winMoves} hamlede topladın.`;
  reportGameOver(SCORE_DESC, winMoves, { label: 'Hamle' });
  showOverlayEl(overlay);
  overlayRestart.focus({ preventScroll: true });
}

function hideOverlay(): void {
  hideOverlayEl(overlay);
}

function startGame(): void {
  gen.bump();
  state = 'playing';
  moves = 0;
  newPuzzle();
  hideOverlay();
  renderGoals();
  renderGoalsCount();
  renderMoves();
  renderBest();
  renderDie();
}

function onKeyDown(e: KeyboardEvent): void {
  const k = e.key;
  if (k === 'r' || k === 'R') {
    startGame();
    e.preventDefault();
    return;
  }
  if (state === 'won') {
    if (k === 'Enter' || k === ' ') {
      startGame();
      e.preventDefault();
    }
    return;
  }
  if (k === 'ArrowUp' || k === 'w' || k === 'W') {
    tryRoll(-1, 0);
    e.preventDefault();
  } else if (k === 'ArrowDown' || k === 's' || k === 'S') {
    tryRoll(1, 0);
    e.preventDefault();
  } else if (k === 'ArrowLeft' || k === 'a' || k === 'A') {
    tryRoll(0, -1);
    e.preventDefault();
  } else if (k === 'ArrowRight' || k === 'd' || k === 'D') {
    tryRoll(0, 1);
    e.preventDefault();
  }
}

function onBoardPointerDown(e: PointerEvent): void {
  if (state !== 'playing') return;
  const rect = boardEl.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const cellSize = rect.width / SIZE;
  const dieCx = (diePos.c + 0.5) * cellSize;
  const dieCy = (diePos.r + 0.5) * cellSize;
  const dx = x - dieCx;
  const dy = y - dieCy;
  if (Math.abs(dx) < cellSize * 0.18 && Math.abs(dy) < cellSize * 0.18) return;
  if (Math.abs(dx) > Math.abs(dy)) {
    tryRoll(0, dx > 0 ? 1 : -1);
  } else {
    tryRoll(dy > 0 ? 1 : -1, 0);
  }
}

function init(): void {
  boardEl = document.querySelector<HTMLElement>('#board')!;
  movesEl = document.querySelector<HTMLElement>('#moves')!;
  goalsEl = document.querySelector<HTMLElement>('#goals')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayRestart = document.querySelector<HTMLButtonElement>('#overlay-restart')!;

  best = loadBest();

  buildBoard();

  restartBtn.addEventListener('click', startGame);
  overlayRestart.addEventListener('click', startGame);
  window.addEventListener('keydown', onKeyDown);
  boardEl.addEventListener('pointerdown', onBoardPointerDown);

  startGame();
}

export const game = defineGame({ init, reset: startGame });
