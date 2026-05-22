// Tek Taş (English Peg Solitaire). 7x7 grid with corners removed (33 valid
// holes in a plus shape). All holes start with pegs except the center, which
// is empty. A move: pick a peg, jump it orthogonally over an adjacent peg
// into an empty hole two cells away; the jumped-over peg is removed.
// Win = 1 peg left (ideal: at center). Lose = no legal jumps remain.

import { defineGame } from '@shared/game-module';
import {
  showOverlay as showOverlayEl,
  hideOverlay as hideOverlayEl,
} from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';

const SIZE = 7;
const CENTER = 3;

const LAYOUT: ReadonlyArray<ReadonlyArray<0 | 1>> = [
  [0, 0, 1, 1, 1, 0, 0],
  [0, 0, 1, 1, 1, 0, 0],
  [1, 1, 1, 1, 1, 1, 1],
  [1, 1, 1, 1, 1, 1, 1],
  [1, 1, 1, 1, 1, 1, 1],
  [0, 0, 1, 1, 1, 0, 0],
  [0, 0, 1, 1, 1, 0, 0],
];

type Cell = 'invalid' | 'empty' | 'peg';
type State = 'playing' | 'won' | 'stuck';

interface Snapshot {
  board: Cell[];
  pegs: number;
  moves: number;
}

const gen = createGenToken();

let boardState: Cell[] = [];
let cellEls: (HTMLButtonElement | null)[] = [];
let selected: number | null = null;
let pegs = 0;
let moves = 0;
let state: State = 'playing';
const history: Snapshot[] = [];

let boardEl!: HTMLElement;
let pegsEl!: HTMLElement;
let movesEl!: HTMLElement;
let statusEl!: HTMLElement;
let undoBtn!: HTMLButtonElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayRestart!: HTMLButtonElement;

function idx(r: number, c: number): number {
  return r * SIZE + c;
}

function initBoard(): void {
  boardState = new Array(SIZE * SIZE).fill('invalid') as Cell[];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (LAYOUT[r]![c] === 1) {
        boardState[idx(r, c)] = 'peg';
      }
    }
  }
  boardState[idx(CENTER, CENTER)] = 'empty';
  pegs = 32;
  moves = 0;
}

function buildBoard(): void {
  boardEl.innerHTML = '';
  cellEls = new Array(SIZE * SIZE).fill(null);
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const i = idx(r, c);
      if (boardState[i] === 'invalid') {
        const blocker = document.createElement('div');
        blocker.className = 'tt-cell tt-cell--blocked';
        blocker.setAttribute('aria-hidden', 'true');
        boardEl.appendChild(blocker);
        continue;
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tt-cell';
      btn.setAttribute('role', 'gridcell');
      btn.dataset.r = String(r);
      btn.dataset.c = String(c);
      btn.addEventListener('click', () => onCellClick(r, c));
      boardEl.appendChild(btn);
      cellEls[i] = btn;
    }
  }
}

function renderCells(): void {
  for (let i = 0; i < cellEls.length; i++) {
    const el = cellEls[i];
    if (!el) continue;
    const cell = boardState[i]!;
    el.classList.toggle('tt-cell--peg', cell === 'peg');
    el.classList.toggle('tt-cell--empty', cell === 'empty');
    el.classList.toggle('tt-cell--selected', selected === i);
    el.classList.toggle(
      'tt-cell--target',
      selected !== null && cell === 'empty' && isLegalJump(selected, i),
    );
    el.setAttribute('aria-label', cell === 'peg' ? 'taş' : 'boş');
  }
}

function renderHud(): void {
  pegsEl.textContent = String(pegs);
  movesEl.textContent = String(moves);
  undoBtn.disabled = history.length === 0;
}

function isLegalJump(from: number, to: number): boolean {
  if (boardState[from] !== 'peg' || boardState[to] !== 'empty') return false;
  const fr = Math.floor(from / SIZE);
  const fc = from % SIZE;
  const tr = Math.floor(to / SIZE);
  const tc = to % SIZE;
  const dr = tr - fr;
  const dc = tc - fc;
  if (!((Math.abs(dr) === 2 && dc === 0) || (Math.abs(dc) === 2 && dr === 0))) {
    return false;
  }
  const mr = fr + dr / 2;
  const mc = fc + dc / 2;
  return boardState[idx(mr, mc)] === 'peg';
}

function hasAnyLegalMove(): boolean {
  for (let i = 0; i < boardState.length; i++) {
    if (boardState[i] !== 'peg') continue;
    const r = Math.floor(i / SIZE);
    const c = i % SIZE;
    const deltas: Array<[number, number]> = [
      [-2, 0],
      [2, 0],
      [0, -2],
      [0, 2],
    ];
    for (const [dr, dc] of deltas) {
      const tr = r + dr;
      const tc = c + dc;
      if (tr < 0 || tr >= SIZE || tc < 0 || tc >= SIZE) continue;
      if (isLegalJump(i, idx(tr, tc))) return true;
    }
  }
  return false;
}

function snapshot(): Snapshot {
  return { board: [...boardState], pegs, moves };
}

function restore(s: Snapshot): void {
  boardState = [...s.board];
  pegs = s.pegs;
  moves = s.moves;
}

function performJump(from: number, to: number): void {
  history.push(snapshot());
  if (history.length > 200) history.shift();
  const fr = Math.floor(from / SIZE);
  const fc = from % SIZE;
  const tr = Math.floor(to / SIZE);
  const tc = to % SIZE;
  const mid = idx((fr + tr) / 2, (fc + tc) / 2);
  boardState[from] = 'empty';
  boardState[mid] = 'empty';
  boardState[to] = 'peg';
  pegs--;
  moves++;
  selected = null;
}

function onCellClick(r: number, c: number): void {
  if (state !== 'playing') return;
  const i = idx(r, c);
  const cell = boardState[i]!;

  if (cell === 'peg') {
    selected = selected === i ? null : i;
    renderCells();
    return;
  }
  if (cell === 'empty' && selected !== null) {
    if (isLegalJump(selected, i)) {
      performJump(selected, i);
      renderCells();
      renderHud();
      checkEnd();
      return;
    }
    selected = null;
    renderCells();
  }
}

function checkEnd(): void {
  if (pegs === 1) {
    state = 'won';
    const centerWin = boardState[idx(CENTER, CENTER)] === 'peg';
    showEnd(
      centerWin ? 'Kusursuz!' : 'Tek taş kaldı!',
      centerWin
        ? `Son taşı ortaya getirdin (${moves} hamle).`
        : `${moves} hamle. Son taş ortada değil — bir dahaki sefere?`,
    );
    return;
  }
  if (!hasAnyLegalMove()) {
    state = 'stuck';
    showEnd(
      'Sıkıştın',
      `${pegs} taş kaldı, geçerli hamle yok. Geri al ile başka bir yol dene.`,
    );
  }
}

function showEnd(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlay);
  overlayRestart.focus({ preventScroll: true });
  renderHud();
}

function hideOverlay(): void {
  hideOverlayEl(overlay);
}

function undo(): void {
  if (history.length === 0) return;
  if (state !== 'playing') {
    state = 'playing';
    hideOverlay();
  }
  const prev = history.pop()!;
  restore(prev);
  selected = null;
  renderCells();
  renderHud();
  statusEl.textContent = 'Geri alındı.';
}

function reset(): void {
  gen.bump();
  state = 'playing';
  selected = null;
  history.length = 0;
  hideOverlay();
  initBoard();
  buildBoard();
  renderCells();
  renderHud();
  statusEl.textContent = 'Bir taş seç, sonra atlama hedefini tıkla.';
}

function init(): void {
  boardEl = document.querySelector<HTMLElement>('#board')!;
  pegsEl = document.querySelector<HTMLElement>('#pegs')!;
  movesEl = document.querySelector<HTMLElement>('#moves')!;
  statusEl = document.querySelector<HTMLElement>('#status')!;
  undoBtn = document.querySelector<HTMLButtonElement>('#undo')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayRestart = document.querySelector<HTMLButtonElement>('#overlay-restart')!;

  restartBtn.addEventListener('click', reset);
  overlayRestart.addEventListener('click', reset);
  undoBtn.addEventListener('click', undo);

  window.addEventListener('keydown', (e) => {
    if (e.key === 'r' || e.key === 'R') {
      reset();
      e.preventDefault();
    } else if (e.key === 'u' || e.key === 'U') {
      undo();
      e.preventDefault();
    } else if (e.key === 'Escape') {
      if (selected !== null) {
        selected = null;
        renderCells();
        e.preventDefault();
      }
    }
  });

  reset();
}

export const game = defineGame({ init, reset });
