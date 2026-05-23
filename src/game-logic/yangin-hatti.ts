import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';

// PITFALLS guarded here (docs/PITFALLS.md):
// - unguarded-storage: safeRead/safeWrite only.
// - module-level-dom-access: all DOM/storage access inside init().
// - overlay-input-leak: explicit `state` enum; every handler guards on it.
// - stale-async-callback: game is fully turn-based & synchronous — no timers,
//   so there is no in-flight callback to outlive a reset.
// - visual-vs-hitbox: draw() and the click handler share one cellSize, so the
//   painted square and its hit area are identical.

const COLS = 15;
const ROWS = 12;
const DIGS_PER_TURN = 4;
const EMPTY_COUNT = 7;
const STORAGE_BEST = 'yangin-hatti.best';

const enum Cell {
  Tree,
  Fire,
  Break,
  Empty,
  House,
}

type State = 'ready' | 'playing' | 'won' | 'lost';

const COLORS: Record<Cell, string> = {
  [Cell.Tree]: '#2f9e44',
  [Cell.Fire]: '#ff5722',
  [Cell.Break]: '#6b4423',
  [Cell.Empty]: '#39414d',
  [Cell.House]: '#4dabf7',
};

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let treesEl!: HTMLElement;
let digsEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let advanceBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayBtn!: HTMLButtonElement;

let cellSize = 0;
let grid: Cell[] = [];
let turnBreaks = new Set<number>(); // breaks dug this turn (undoable)
let digsLeft = DIGS_PER_TURN;
let best = 0;
let state: State = 'ready';

const idx = (c: number, r: number): number => r * COLS + c;
const inBounds = (c: number, r: number): boolean =>
  c >= 0 && c < COLS && r >= 0 && r < ROWS;

function neighbours(i: number): number[] {
  const c = i % COLS;
  const r = (i / COLS) | 0;
  const out: number[] = [];
  if (inBounds(c - 1, r)) out.push(idx(c - 1, r));
  if (inBounds(c + 1, r)) out.push(idx(c + 1, r));
  if (inBounds(c, r - 1)) out.push(idx(c, r - 1));
  if (inBounds(c, r + 1)) out.push(idx(c, r + 1));
  return out;
}

function countTrees(): number {
  let n = 0;
  for (const cell of grid) if (cell === Cell.Tree) n++;
  return n;
}

// Cells that will catch fire on the next advance (also used for containment).
function threatened(): Set<number> {
  const out = new Set<number>();
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] !== Cell.Fire) continue;
    for (const n of neighbours(i)) {
      if (grid[n] === Cell.Tree || grid[n] === Cell.House) out.add(n);
    }
  }
  return out;
}

function randInt(n: number): number {
  return Math.floor(Math.random() * n);
}

function buildMap(): void {
  grid = new Array(COLS * ROWS).fill(Cell.Tree);

  // Village: a 2x2 house cluster tucked into a random corner.
  const left = Math.random() < 0.5;
  const top = Math.random() < 0.5;
  const hc = left ? 1 : COLS - 3;
  const hr = top ? 1 : ROWS - 3;
  for (let dr = 0; dr < 2; dr++) {
    for (let dc = 0; dc < 2; dc++) grid[idx(hc + dc, hr + dr)] = Cell.House;
  }

  // Fire starts near the opposite corner so the village is the far target.
  const fc = left ? COLS - 3 + randInt(2) : 1 + randInt(2);
  const fr = top ? ROWS - 3 + randInt(2) : 1 + randInt(2);
  const fire = idx(fc, fr);

  // Scatter a few natural clearings (non-burnable), away from fire & houses.
  let placed = 0;
  let guard = 0;
  while (placed < EMPTY_COUNT && guard++ < 500) {
    const i = randInt(grid.length);
    if (grid[i] !== Cell.Tree) continue;
    if (i === fire) continue;
    if (neighbours(fire).includes(i)) continue; // keep fire able to spread
    grid[i] = Cell.Empty;
    placed++;
  }

  grid[fire] = Cell.Fire;
}

function showOverlay(title: string, msg: string, btnLabel: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  overlayBtn.textContent = btnLabel;
  showOverlayEl(overlay);
}

function syncHud(): void {
  treesEl.textContent = String(countTrees());
  digsEl.textContent = String(digsLeft);
  bestEl.textContent = String(best);
}

function reset(): void {
  buildMap();
  turnBreaks = new Set();
  digsLeft = DIGS_PER_TURN;
  state = 'ready';
  syncHud();
  draw();
  showOverlay(
    'Yangın Hattı',
    'Alevi söndüremezsin, sadece çevreleyebilirsin.\nTıkla: ağaç kesip hat aç (her hat 1 ağaca mâl olur).\nBoşluk: turu ilerlet — alev bir kare yayılır.\nMavi köyü kurtar, kalan yeşili büyüt.',
    'Başla',
  );
}

function start(): void {
  if (state !== 'ready') return;
  state = 'playing';
  hideOverlayEl(overlay);
  draw();
}

function dig(i: number): void {
  if (state !== 'playing') return;
  if (grid[i] === Cell.Tree && digsLeft > 0) {
    grid[i] = Cell.Break;
    turnBreaks.add(i);
    digsLeft--;
  } else if (grid[i] === Cell.Break && turnBreaks.has(i)) {
    grid[i] = Cell.Tree; // undo a break dug this turn
    turnBreaks.delete(i);
    digsLeft++;
  } else {
    return;
  }
  syncHud();
  draw();
}

function advance(): void {
  if (state !== 'playing') return;

  // Breaks dug this turn become permanent.
  turnBreaks.clear();

  // Fire spreads one orthogonal ring simultaneously.
  const igniting = threatened();
  let houseBurned = false;
  for (const i of igniting) {
    if (grid[i] === Cell.House) houseBurned = true;
    grid[i] = Cell.Fire;
  }

  digsLeft = DIGS_PER_TURN;

  if (houseBurned) {
    state = 'lost';
  } else if (threatened().size === 0) {
    state = 'won';
  }

  if (state === 'won' || state === 'lost') {
    const saved = countTrees();
    if (saved > best) {
      best = saved;
      safeWrite(STORAGE_BEST, best);
    }
  }

  syncHud();
  draw();

  if (state === 'won') {
    showOverlay(
      'Köy kurtuldu!',
      `Alev çevrelendi. Kurtardığın ağaç: ${countTrees()}\nBoşluk veya Yeniden başla ile yeni harita.`,
      'Yeniden başla',
    );
  } else if (state === 'lost') {
    showOverlay(
      'Köy yandı',
      `Alev evlere ulaştı. Kalan ağaç: ${countTrees()}\nBoşluk veya Yeniden başla ile tekrar dene.`,
      'Tekrar dene',
    );
  }
}

function draw(): void {
  ctx.fillStyle = COLORS[Cell.Empty];
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const threat = state === 'playing' ? threatened() : new Set<number>();

  for (let i = 0; i < grid.length; i++) {
    const c = i % COLS;
    const r = (i / COLS) | 0;
    const x = c * cellSize;
    const y = r * cellSize;
    const cell = grid[i]!;

    ctx.fillStyle = COLORS[cell];
    ctx.fillRect(x + 1, y + 1, cellSize - 2, cellSize - 2);

    if (cell === Cell.Fire) {
      // Brighter ember core so fire reads instantly.
      ctx.fillStyle = '#ffd166';
      const m = cellSize * 0.32;
      ctx.fillRect(x + m, y + m, cellSize - 2 * m, cellSize - 2 * m);
    } else if (cell === Cell.House) {
      // Roof mark.
      ctx.fillStyle = '#1c2027';
      ctx.fillRect(
        x + cellSize * 0.32,
        y + cellSize * 0.28,
        cellSize * 0.36,
        cellSize * 0.18,
      );
    } else if (cell === Cell.Break) {
      // Furrow line to read as dug earth.
      ctx.strokeStyle = '#3d2812';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + 4, y + cellSize * 0.5);
      ctx.lineTo(x + cellSize - 4, y + cellSize * 0.5);
      ctx.stroke();
    }

    if (threat.has(i)) {
      ctx.strokeStyle = '#ff8a3d';
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 2, y + 2, cellSize - 4, cellSize - 4);
    }
  }
}

function cellAtEvent(e: MouseEvent): number | null {
  const rect = canvas.getBoundingClientRect();
  const x = (e.clientX - rect.left) * (canvas.width / rect.width);
  const y = (e.clientY - rect.top) * (canvas.height / rect.height);
  const c = Math.floor(x / cellSize);
  const r = Math.floor(y / cellSize);
  if (!inBounds(c, r)) return null;
  return idx(c, r);
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  treesEl = document.querySelector<HTMLElement>('#trees')!;
  digsEl = document.querySelector<HTMLElement>('#digs')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  advanceBtn = document.querySelector<HTMLButtonElement>('#advance')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;

  cellSize = canvas.width / COLS;
  best = safeRead<number>(STORAGE_BEST, 0);

  canvas.addEventListener('click', (e) => {
    const i = cellAtEvent(e);
    if (i !== null) dig(i);
  });

  advanceBtn.addEventListener('click', () => {
    if (state === 'ready') start();
    else if (state === 'playing') advance();
    else reset();
  });

  overlayBtn.addEventListener('click', () => {
    if (state === 'ready') start();
    else reset();
  });

  restartBtn.addEventListener('click', reset);

  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k === ' ' || k === 'enter') {
      if (state === 'ready') start();
      else if (state === 'playing') advance();
      else reset();
      e.preventDefault();
    } else if (k === 'r') {
      reset();
      e.preventDefault();
    }
  });

  reset();
}

export const game = defineGame({ init, reset });
