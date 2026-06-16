import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import {
  showOverlay as showOverlayEl,
  hideOverlay as hideOverlayEl,
} from '@shared/overlay';
import { reportGameOver } from '@shared/leaderboard';

// Damga — line-cover engraving puzzle. The board is a wooden block with two
// kinds of cells: "carve" cells must be chipped out, "keep" cells must stay
// intact. Each stroke is a straight horizontal or vertical line covering a
// run of cells. A stroke is rejected if it would touch a keep cell. The
// level ends when every carve cell is chipped; fewer strokes is better.
//
// PITFALLS guards:
// - unguarded-storage: safeRead/safeWrite (storage.ts).
// - overlay-input-leak: explicit `state` enum + handlers no-op on 'won'.
// - module-level-dom-access: all DOM access in init().
// - missing-overlay-css: damga.css defines .overlay--hidden + .overlay rules.
// - stale-dom-from-prev-state: loadLevel() rebuilds cellState before render().

const STORAGE_BEST = 'damga.best';
const SCORE_DESC = {
  gameId: 'damga',
  storageKey: STORAGE_BEST,
  direction: 'higher' as const,
};

type CellKind = 'keep' | 'carve';
type CellState = 'keep' | 'pending' | 'carved';

interface Level {
  name: string;
  // Each string is one row; '#' = carve target, '.' = keep, ' ' (space) is
  // shorthand for keep too. All rows must be equal length.
  rows: string[];
  par: number;
}

const LEVELS: Level[] = [
  {
    name: 'İlk Çentik',
    rows: [
      '........',
      '........',
      '..#####.',
      '........',
      '........',
      '........',
      '........',
      '........',
    ],
    par: 1,
  },
  {
    name: 'Artı',
    rows: [
      '........',
      '....#...',
      '....#...',
      '.#######',
      '....#...',
      '....#...',
      '....#...',
      '........',
    ],
    par: 2,
  },
  {
    name: 'Köşe',
    rows: [
      '........',
      '.#......',
      '.#......',
      '.#......',
      '.#......',
      '.#######',
      '........',
      '........',
    ],
    par: 2,
  },
  {
    name: 'T',
    rows: [
      '........',
      '.#######',
      '....#...',
      '....#...',
      '....#...',
      '....#...',
      '....#...',
      '........',
    ],
    par: 2,
  },
  {
    name: 'Aynalı',
    rows: [
      '........',
      '.#....#.',
      '.#....#.',
      '.######.',
      '.#....#.',
      '.#....#.',
      '.#....#.',
      '........',
    ],
    par: 3,
  },
  {
    name: 'Çerçeve',
    rows: [
      '........',
      '.######.',
      '.#....#.',
      '.#....#.',
      '.#....#.',
      '.#....#.',
      '.######.',
      '........',
    ],
    par: 4,
  },
  {
    name: 'E',
    rows: [
      '........',
      '.######.',
      '.#......',
      '.####...',
      '.#......',
      '.#......',
      '.######.',
      '........',
    ],
    par: 5,
  },
  {
    name: 'Damga 1',
    rows: [
      '.#.#.#.#',
      '#.#.#.#.',
      '.#.#.#.#',
      '#.#.#.#.',
      '.#.#.#.#',
      '#.#.#.#.',
      '.#.#.#.#',
      '#.#.#.#.',
    ],
    par: 8,
  },
  {
    name: 'Yıldız',
    rows: [
      '...#....',
      '...#....',
      '.######.',
      '...#....',
      '...#....',
      '.######.',
      '...#....',
      '...#....',
    ],
    par: 3,
  },
  {
    name: 'Π',
    rows: [
      '........',
      '.######.',
      '.#....#.',
      '.#....#.',
      '.#....#.',
      '.#....#.',
      '.#....#.',
      '........',
    ],
    par: 3,
  },
  {
    name: 'H',
    rows: [
      '........',
      '.#....#.',
      '.#....#.',
      '.######.',
      '.#....#.',
      '.#....#.',
      '.#....#.',
      '........',
    ],
    par: 3,
  },
  {
    name: 'Çift Pencere',
    rows: [
      '........',
      '.##..##.',
      '.##..##.',
      '........',
      '........',
      '.##..##.',
      '.##..##.',
      '........',
    ],
    par: 4,
  },
  {
    name: 'Spiral',
    rows: [
      '########',
      '.......#',
      '.#####.#',
      '.#...#.#',
      '.#.#.#.#',
      '.#.#...#',
      '.#.#####',
      '.#......',
    ],
    par: 8,
  },
];

const ROWS = 8;
const COLS = 8;

type State = 'ready' | 'playing' | 'won';

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let levelEl!: HTMLElement;
let bestEl!: HTMLElement;
let strokesEl!: HTMLElement;
let parEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayBtn!: HTMLButtonElement;

let levelIdx = 0;
let level!: Level;
let cellState: CellState[][] = [];
let best = 0;
let strokes = 0;
let state: State = 'ready';

// Drag state for stroke preview.
let dragStart: { r: number; c: number } | null = null;
let dragCurrent: { r: number; c: number } | null = null;
// `dragInvalid` flashes red briefly after a rejected stroke (set in onUp,
// cleared on next pointer down).
let dragInvalid = false;

const cssCache = new Map<string, string>();
function getCss(name: string): string {
  const c = cssCache.get(name);
  if (c !== undefined) return c;
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  cssCache.set(name, v);
  return v;
}

function rowsAt(idx: number): Level {
  return LEVELS[((idx % LEVELS.length) + LEVELS.length) % LEVELS.length]!;
}

function buildCellState(lvl: Level): CellState[][] {
  const out: CellState[][] = [];
  for (let r = 0; r < ROWS; r++) {
    const row: CellState[] = [];
    const raw = lvl.rows[r] ?? '';
    for (let c = 0; c < COLS; c++) {
      const ch = raw[c] ?? '.';
      row.push(ch === '#' ? 'pending' : 'keep');
    }
    out.push(row);
  }
  return out;
}

function totalPending(): number {
  let n = 0;
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (cellState[r]![c] === 'pending') n++;
    }
  }
  return n;
}

function cellPx(): number {
  // canvas.width is 480 logical; we render at logical pixel units and let CSS
  // scale to actual display size.
  return canvas.width / COLS;
}

function pickCell(clientX: number, clientY: number): { r: number; c: number } | null {
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  const x = (clientX - rect.left) * (canvas.width / rect.width);
  const y = (clientY - rect.top) * (canvas.height / rect.height);
  const cs = cellPx();
  const c = Math.floor(x / cs);
  const r = Math.floor(y / cs);
  if (r < 0 || r >= ROWS || c < 0 || c >= COLS) return null;
  return { r, c };
}

interface Stroke {
  cells: { r: number; c: number }[];
  valid: boolean;
}

function computeStroke(a: { r: number; c: number }, b: { r: number; c: number }): Stroke {
  // Snap to the dominant axis: whichever has the larger displacement wins;
  // ties default to horizontal. This lets a small accidental vertical
  // wobble still register as a clean horizontal stroke.
  const dr = Math.abs(b.r - a.r);
  const dc = Math.abs(b.c - a.c);
  let endR = a.r;
  let endC = a.c;
  if (dc >= dr) {
    endC = b.c;
  } else {
    endR = b.r;
  }
  const cells: { r: number; c: number }[] = [];
  if (endR === a.r) {
    const step = endC >= a.c ? 1 : -1;
    for (let c = a.c; c !== endC + step; c += step) {
      cells.push({ r: a.r, c });
    }
  } else {
    const step = endR >= a.r ? 1 : -1;
    for (let r = a.r; r !== endR + step; r += step) {
      cells.push({ r, c: a.c });
    }
  }
  let valid = true;
  for (const cell of cells) {
    if (cellState[cell.r]![cell.c] === 'keep') {
      valid = false;
      break;
    }
  }
  return { cells, valid };
}

function applyStroke(stroke: Stroke): boolean {
  if (!stroke.valid) return false;
  // A stroke that doesn't actually chip any new cell still counts toward
  // strokes — but reject zero-progress strokes silently so spamming on
  // already-carved cells doesn't pad the counter. Same direction as
  // PITFALLS#designed-lose-condition-not-wired: an inert move should be
  // either silent or penalized, not "free".
  let progressed = false;
  for (const cell of stroke.cells) {
    if (cellState[cell.r]![cell.c] === 'pending') {
      cellState[cell.r]![cell.c] = 'carved';
      progressed = true;
    }
  }
  return progressed;
}

function syncHud(): void {
  levelEl.textContent = String(levelIdx + 1);
  bestEl.textContent = String(best);
  strokesEl.textContent = String(strokes);
  parEl.textContent = String(level.par);
}

function loadLevel(idx: number): void {
  levelIdx = ((idx % LEVELS.length) + LEVELS.length) % LEVELS.length;
  level = rowsAt(levelIdx);
  cellState = buildCellState(level);
  strokes = 0;
  state = 'ready';
  dragStart = null;
  dragCurrent = null;
  dragInvalid = false;
  hideOverlayEl(overlay);
  syncHud();
  render();
}

function nextLevel(): void {
  loadLevel(levelIdx + 1);
}

function resetLevel(): void {
  loadLevel(levelIdx);
}

function commitWin(): void {
  state = 'won';
  const reached = levelIdx + 1;
  if (reached > best) {
    best = reached;
    safeWrite(STORAGE_BEST, best);
  }
  reportGameOver(SCORE_DESC, reached, { label: 'Seviye' });
  syncHud();
  const overPar = strokes - level.par;
  const note =
    overPar <= 0
      ? `Par'da bitirdin (${strokes} darbe).`
      : `${strokes} darbe — par ${level.par}. ${overPar} fazla.`;
  const nextName = rowsAt(levelIdx + 1).name;
  overlayTitle.textContent = 'Damga tamamlandı';
  overlayMsg.textContent = `${level.name} bitti.\n${note}\nSıradaki: ${nextName}`;
  overlayBtn.textContent = 'Sonraki seviye';
  showOverlayEl(overlay);
}

function render(): void {
  const w = canvas.width;
  const h = canvas.height;
  const cs = cellPx();

  // Wooden block background.
  ctx.fillStyle = getCss('--surface-2') || '#1a1a1f';
  ctx.fillRect(0, 0, w, h);

  // Cells.
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const x = c * cs;
      const y = r * cs;
      const st = cellState[r]![c]!;
      drawCell(x, y, cs, st);
    }
  }

  // Stroke preview: ghost the cells under the drag.
  if (dragStart && dragCurrent) {
    const stroke = computeStroke(dragStart, dragCurrent);
    for (const cell of stroke.cells) {
      const x = cell.c * cs;
      const y = cell.r * cs;
      ctx.save();
      ctx.globalAlpha = 0.45;
      ctx.fillStyle = stroke.valid
        ? getCss('--accent') || '#f4b860'
        : getCss('--danger') || '#e0524a';
      ctx.fillRect(x + cs * 0.12, y + cs * 0.12, cs * 0.76, cs * 0.76);
      ctx.restore();
    }
    // Stroke axis line.
    const head = stroke.cells[0]!;
    const tail = stroke.cells[stroke.cells.length - 1]!;
    ctx.strokeStyle = stroke.valid
      ? getCss('--accent-strong') || '#ffcf6a'
      : getCss('--danger') || '#e0524a';
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(head.c * cs + cs / 2, head.r * cs + cs / 2);
    ctx.lineTo(tail.c * cs + cs / 2, tail.r * cs + cs / 2);
    ctx.stroke();
  }

  if (dragInvalid) {
    // Brief red border indicates the last attempt was rejected.
    ctx.strokeStyle = getCss('--danger') || '#e0524a';
    ctx.lineWidth = 6;
    ctx.strokeRect(3, 3, w - 6, h - 6);
  }
}

function drawCell(x: number, y: number, cs: number, st: CellState): void {
  const pad = cs * 0.08;
  const cx = x + cs / 2;
  const cy = y + cs / 2;

  if (st === 'keep') {
    // Solid wood — keep zone.
    ctx.fillStyle = '#6c4a2d';
    ctx.fillRect(x + pad, y + pad, cs - pad * 2, cs - pad * 2);
    // Grain hint.
    ctx.strokeStyle = 'rgba(0,0,0,0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + pad + 2, cy);
    ctx.lineTo(x + cs - pad - 2, cy);
    ctx.stroke();
  } else if (st === 'pending') {
    // Target cell — stencil overlay on a lighter wood tone.
    ctx.fillStyle = '#b3835a';
    ctx.fillRect(x + pad, y + pad, cs - pad * 2, cs - pad * 2);
    // Crosshatch suggesting "to be carved".
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = -cs; i < cs; i += 6) {
      ctx.moveTo(x + pad + i, y + pad);
      ctx.lineTo(x + pad + i + cs * 0.6, y + cs - pad);
    }
    ctx.stroke();
    // Soft glow ring so the targets read at a glance.
    ctx.strokeStyle = getCss('--accent') || '#f4b860';
    ctx.lineWidth = 2;
    ctx.strokeRect(x + pad + 1, y + pad + 1, cs - pad * 2 - 2, cs - pad * 2 - 2);
  } else {
    // Carved — dark hollow.
    ctx.fillStyle = '#15110b';
    ctx.fillRect(x + pad * 0.5, y + pad * 0.5, cs - pad, cs - pad);
    // Chip mark.
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + pad, y + pad);
    ctx.lineTo(cx, y + cs - pad);
    ctx.moveTo(x + cs - pad, y + pad);
    ctx.lineTo(cx, cy);
    ctx.stroke();
  }
}

function onPointerDown(e: PointerEvent): void {
  if (state === 'won') return;
  const cell = pickCell(e.clientX, e.clientY);
  if (!cell) return;
  e.preventDefault();
  canvas.setPointerCapture(e.pointerId);
  dragStart = cell;
  dragCurrent = cell;
  dragInvalid = false;
  if (state === 'ready') state = 'playing';
  render();
}

function onPointerMove(e: PointerEvent): void {
  if (state === 'won') return;
  if (!dragStart) return;
  const cell = pickCell(e.clientX, e.clientY);
  if (!cell) return;
  if (dragCurrent && dragCurrent.r === cell.r && dragCurrent.c === cell.c) return;
  dragCurrent = cell;
  render();
}

function onPointerUp(e: PointerEvent): void {
  if (state === 'won') {
    dragStart = null;
    dragCurrent = null;
    return;
  }
  if (!dragStart || !dragCurrent) {
    dragStart = null;
    dragCurrent = null;
    return;
  }
  if (canvas.hasPointerCapture(e.pointerId)) {
    canvas.releasePointerCapture(e.pointerId);
  }
  const stroke = computeStroke(dragStart, dragCurrent);
  dragStart = null;
  dragCurrent = null;
  if (!stroke.valid) {
    dragInvalid = true;
    render();
    // Auto-clear the red flash after a beat.
    window.setTimeout(() => {
      dragInvalid = false;
      render();
    }, 220);
    return;
  }
  const progressed = applyStroke(stroke);
  if (!progressed) {
    // Stroke valid but redundant (all cells were already carved). Silent
    // no-op — don't count it.
    render();
    return;
  }
  strokes++;
  syncHud();
  if (totalPending() === 0) {
    commitWin();
  } else {
    render();
  }
}

function onPointerCancel(): void {
  dragStart = null;
  dragCurrent = null;
  render();
}

function onKey(e: KeyboardEvent): void {
  const k = e.key.toLowerCase();
  if (k === 'r') {
    resetLevel();
    e.preventDefault();
  } else if (k === 'n') {
    if (state === 'won') {
      nextLevel();
    } else {
      // Skip to next level without crediting — useful while testing.
      loadLevel(levelIdx + 1);
    }
    e.preventDefault();
  }
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  levelEl = document.querySelector<HTMLElement>('#level')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  strokesEl = document.querySelector<HTMLElement>('#strokes')!;
  parEl = document.querySelector<HTMLElement>('#par')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);
  canvas.addEventListener('pointerleave', (e) => {
    // Don't drop the drag just because the cursor briefly slid off; treat
    // pointerleave like pointerup so the user can release outside.
    if (dragStart) onPointerUp(e);
  });
  restartBtn.addEventListener('click', resetLevel);
  overlayBtn.addEventListener('click', () => {
    if (state === 'won') nextLevel();
    else hideOverlayEl(overlay);
  });
  window.addEventListener('keydown', onKey);

  loadLevel(0);
}

export const game = defineGame({ init, reset: resetLevel });
