import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import {
  showOverlay as showOverlayEl,
  hideOverlay as hideOverlayEl,
} from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';

// Çini — Iznik-style tile painting puzzle. The brush paints four mirrored
// cells at once (4-fold mirror symmetry across the horizontal + vertical
// axis). Reproduce the target pattern in as few strokes as possible.
//
// PITFALLS guarded here:
// - unguarded-storage: safeRead/safeWrite wrap localStorage in try/catch.
// - module-level-dom-access: all DOM/storage access lives in init().
// - overlay-input-leak: explicit state ∈ {playing,levelWin,gameWin}; canvas
//   click + key handlers guard at the top so paint never bleeds through the
//   overlay.
// - missing-overlay-css: cini.css ships .overlay + .overlay--hidden rules.
// - stale-async-callback: no async work, but gen.bump() in restartLevel
//   defensively invalidates any hypothetical in-flight callback.
// - visual-vs-hitbox: pointerToCell() and drawBoard() share computeBoardGeom();
//   click cells line up with painted cells regardless of canvas scaling.
// - dangling-thumbnail-reference: public/thumbs/cini.svg ships alongside.

interface LevelDef {
  size: number;
  quadrant: number[][];
  minStrokes: number;
}

function mirrorTarget(q: number[][], size: number): number[][] {
  const half = size / 2;
  const target: number[][] = [];
  for (let y = 0; y < size; y++) {
    const row: number[] = [];
    for (let x = 0; x < size; x++) {
      const qx = x < half ? x : size - 1 - x;
      const qy = y < half ? y : size - 1 - y;
      row.push(q[qy]![qx]!);
    }
    target.push(row);
  }
  return target;
}

function countNonEmpty(q: number[][]): number {
  let n = 0;
  for (const row of q) for (const c of row) if (c !== 0) n++;
  return n;
}

const LEVEL_RAW: Array<{ size: number; q: number[][] }> = [
  {
    size: 4,
    q: [
      [1, 1],
      [1, 0],
    ],
  },
  {
    size: 4,
    q: [
      [1, 2],
      [2, 1],
    ],
  },
  {
    size: 6,
    q: [
      [1, 0, 2],
      [0, 1, 0],
      [2, 0, 1],
    ],
  },
  {
    size: 6,
    q: [
      [3, 1, 3],
      [1, 2, 1],
      [3, 1, 0],
    ],
  },
  {
    size: 8,
    q: [
      [0, 1, 1, 0],
      [1, 3, 3, 1],
      [1, 3, 2, 0],
      [0, 1, 0, 1],
    ],
  },
];

const LEVELS: LevelDef[] = LEVEL_RAW.map((d) => ({
  size: d.size,
  quadrant: d.q,
  minStrokes: countNonEmpty(d.q),
}));

const STORAGE_BEST = 'cini.best';
const CANVAS_PX = 480;
const TARGET_PX = 200;

type State = 'playing' | 'levelWin' | 'gameWin';

interface Snapshot {
  cells: number[][];
  strokes: number;
  totalStrokes: number;
}

const COLORS: Record<number, string> = {
  0: '#f4ecd8',
  1: '#1f4ea8',
  2: '#c9433a',
  3: '#2a9d8f',
};

const COLORS_DARK: Record<number, string> = {
  0: '#d7c9a4',
  1: '#163a7f',
  2: '#9d3128',
  3: '#1e7268',
};

const gen = createGenToken();

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let targetCanvas!: HTMLCanvasElement;
let targetCtx!: CanvasRenderingContext2D;
let levelEl!: HTMLElement;
let strokesEl!: HTMLElement;
let minEl!: HTMLElement;
let bestEl!: HTMLElement;
let overlayEl!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayBtn!: HTMLButtonElement;
let undoBtn!: HTMLButtonElement;
let resetBtn!: HTMLButtonElement;
let paletteBtns!: NodeListOf<HTMLButtonElement>;

let state: State = 'playing';
let levelIdx = 0;
let target: number[][] = [];
let cells: number[][] = [];
let strokes = 0;
let totalStrokes = 0;
let bestTotal = 0;
let currentColor = 1;
let history: Snapshot[] = [];

function setOverlay(title: string, msg: string, btn: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  overlayBtn.textContent = btn;
  showOverlayEl(overlayEl);
}

function hideOverlay(): void {
  hideOverlayEl(overlayEl);
}

function loadLevel(idx: number): void {
  const lvl = LEVELS[idx];
  if (!lvl) return;
  levelIdx = idx;
  target = mirrorTarget(lvl.quadrant, lvl.size);
  cells = Array.from({ length: lvl.size }, () =>
    Array.from({ length: lvl.size }, () => 0),
  );
  strokes = 0;
  history = [];
  state = 'playing';
  hideOverlay();
  renderHud();
  drawTarget();
  drawBoard();
}

function renderHud(): void {
  levelEl.textContent = `${levelIdx + 1}/${LEVELS.length}`;
  strokesEl.textContent = String(strokes);
  const lvl = LEVELS[levelIdx]!;
  minEl.textContent = String(lvl.minStrokes);
  bestEl.textContent = bestTotal > 0 ? String(bestTotal) : '—';
  undoBtn.disabled = history.length === 0 || state !== 'playing';
  undoBtn.setAttribute('aria-disabled', undoBtn.disabled ? 'true' : 'false');
}

function snapshot(): Snapshot {
  return {
    cells: cells.map((row) => row.slice()),
    strokes,
    totalStrokes,
  };
}

function applyClickAt(cx: number, cy: number): void {
  if (state !== 'playing') return;
  const lvl = LEVELS[levelIdx]!;
  if (cx < 0 || cx >= lvl.size || cy < 0 || cy >= lvl.size) return;
  const N = lvl.size;
  const group: Array<[number, number]> = [
    [cx, cy],
    [N - 1 - cx, cy],
    [cx, N - 1 - cy],
    [N - 1 - cx, N - 1 - cy],
  ];
  const allMatch = group.every(([x, y]) => cells[y]![x]! === currentColor);
  if (allMatch) return;
  history.push(snapshot());
  if (history.length > 200) history.shift();
  for (const [x, y] of group) {
    cells[y]![x] = currentColor;
  }
  strokes++;
  totalStrokes++;
  renderHud();
  drawBoard();
  if (checkWin()) {
    finishLevel();
  }
}

function checkWin(): boolean {
  const lvl = LEVELS[levelIdx]!;
  for (let y = 0; y < lvl.size; y++) {
    for (let x = 0; x < lvl.size; x++) {
      if (cells[y]![x]! !== target[y]![x]!) return false;
    }
  }
  return true;
}

function finishLevel(): void {
  if (levelIdx + 1 < LEVELS.length) {
    state = 'levelWin';
    setOverlay(
      `Bölüm ${levelIdx + 1} tamam`,
      `${strokes} hamle (min ${LEVELS[levelIdx]!.minStrokes}).\nDevam için Enter / Boşluk veya düğme.`,
      'Sonraki bölüm',
    );
  } else {
    state = 'gameWin';
    if (bestTotal === 0 || totalStrokes < bestTotal) {
      bestTotal = totalStrokes;
      safeWrite(STORAGE_BEST, bestTotal);
    }
    renderHud();
    setOverlay(
      'Tüm karoları boyadın!',
      `Toplam ${totalStrokes} hamle. En iyi: ${bestTotal}.\nYeniden başlamak için Enter veya R.`,
      'Yeniden başla',
    );
  }
  renderHud();
}

function undo(): void {
  if (state !== 'playing') return;
  if (history.length === 0) return;
  const s = history.pop()!;
  cells = s.cells.map((r) => r.slice());
  strokes = s.strokes;
  totalStrokes = s.totalStrokes;
  renderHud();
  drawBoard();
}

function restartLevel(): void {
  gen.bump();
  if (state === 'gameWin') {
    levelIdx = 0;
    totalStrokes = 0;
    loadLevel(0);
    return;
  }
  totalStrokes -= strokes;
  loadLevel(levelIdx);
}

function advance(): void {
  if (state === 'levelWin') {
    loadLevel(levelIdx + 1);
  } else if (state === 'gameWin') {
    levelIdx = 0;
    totalStrokes = 0;
    loadLevel(0);
  }
}

interface Geom {
  cell: number;
  ox: number;
  oy: number;
}

function computeBoardGeom(): Geom {
  const lvl = LEVELS[levelIdx]!;
  const pad = 24;
  const cell = Math.floor((CANVAS_PX - pad * 2) / lvl.size);
  const ox = Math.floor((CANVAS_PX - cell * lvl.size) / 2);
  const oy = Math.floor((CANVAS_PX - cell * lvl.size) / 2);
  return { cell, ox, oy };
}

function computeTargetGeom(): Geom {
  const lvl = LEVELS[levelIdx]!;
  const pad = 12;
  const cell = Math.floor((TARGET_PX - pad * 2) / lvl.size);
  const ox = Math.floor((TARGET_PX - cell * lvl.size) / 2);
  const oy = Math.floor((TARGET_PX - cell * lvl.size) / 2);
  return { cell, ox, oy };
}

function fillTileBg(c: CanvasRenderingContext2D, w: number, h: number): void {
  c.fillStyle = '#f4ecd8';
  c.fillRect(0, 0, w, h);
  c.strokeStyle = 'rgba(180, 156, 110, 0.16)';
  c.lineWidth = 1;
  c.beginPath();
  for (let i = 0; i < 8; i++) {
    const x = (i * 89 + 13) % w;
    const y = (i * 53 + 27) % h;
    c.moveTo(x, y);
    c.lineTo(x + 30, y + 50);
  }
  c.stroke();
}

function drawCell(
  c: CanvasRenderingContext2D,
  px: number,
  py: number,
  sz: number,
  color: number,
  small: boolean,
): void {
  if (color === 0) {
    c.strokeStyle = 'rgba(160, 130, 70, 0.22)';
    c.lineWidth = 1;
    c.strokeRect(px + 1, py + 1, sz - 2, sz - 2);
    return;
  }
  const fill = COLORS[color];
  const edge = COLORS_DARK[color];
  if (!fill || !edge) return;
  c.fillStyle = fill;
  c.fillRect(px, py, sz, sz);
  const lw = Math.max(1, sz * 0.05);
  c.strokeStyle = edge;
  c.lineWidth = lw;
  c.strokeRect(px + lw / 2, py + lw / 2, sz - lw, sz - lw);
  if (!small && sz >= 28) {
    c.fillStyle = 'rgba(255, 255, 255, 0.18)';
    c.beginPath();
    c.arc(px + sz * 0.3, py + sz * 0.3, sz * 0.08, 0, Math.PI * 2);
    c.fill();
  }
}

function drawTarget(): void {
  const lvl = LEVELS[levelIdx]!;
  const { cell, ox, oy } = computeTargetGeom();
  fillTileBg(targetCtx, TARGET_PX, TARGET_PX);
  for (let y = 0; y < lvl.size; y++) {
    for (let x = 0; x < lvl.size; x++) {
      drawCell(
        targetCtx,
        ox + x * cell,
        oy + y * cell,
        cell,
        target[y]![x]!,
        true,
      );
    }
  }
  targetCtx.strokeStyle = 'rgba(70, 50, 20, 0.45)';
  targetCtx.lineWidth = 2;
  targetCtx.strokeRect(ox - 1, oy - 1, cell * lvl.size + 2, cell * lvl.size + 2);
}

function drawBoard(): void {
  const lvl = LEVELS[levelIdx]!;
  const { cell, ox, oy } = computeBoardGeom();
  fillTileBg(ctx, CANVAS_PX, CANVAS_PX);

  ctx.strokeStyle = 'rgba(120, 90, 50, 0.18)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= lvl.size; i++) {
    ctx.beginPath();
    ctx.moveTo(ox + i * cell, oy);
    ctx.lineTo(ox + i * cell, oy + cell * lvl.size);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(ox, oy + i * cell);
    ctx.lineTo(ox + cell * lvl.size, oy + i * cell);
    ctx.stroke();
  }

  for (let y = 0; y < lvl.size; y++) {
    for (let x = 0; x < lvl.size; x++) {
      drawCell(
        ctx,
        ox + x * cell,
        oy + y * cell,
        cell,
        cells[y]![x]!,
        false,
      );
    }
  }

  const ax = ox + (cell * lvl.size) / 2;
  const ay = oy + (cell * lvl.size) / 2;
  ctx.strokeStyle = 'rgba(120, 90, 50, 0.35)';
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(ax, oy);
  ctx.lineTo(ax, oy + cell * lvl.size);
  ctx.moveTo(ox, ay);
  ctx.lineTo(ox + cell * lvl.size, ay);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.strokeStyle = 'rgba(70, 50, 20, 0.55)';
  ctx.lineWidth = 3;
  ctx.strokeRect(ox - 2, oy - 2, cell * lvl.size + 4, cell * lvl.size + 4);
}

function pointerToCell(ev: PointerEvent): { cx: number; cy: number } | null {
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  const sx = (ev.clientX - rect.left) * (canvas.width / rect.width);
  const sy = (ev.clientY - rect.top) * (canvas.height / rect.height);
  const { cell, ox, oy } = computeBoardGeom();
  const lvl = LEVELS[levelIdx]!;
  const cx = Math.floor((sx - ox) / cell);
  const cy = Math.floor((sy - oy) / cell);
  if (cx < 0 || cx >= lvl.size || cy < 0 || cy >= lvl.size) return null;
  return { cx, cy };
}

function setColor(c: number): void {
  currentColor = c;
  paletteBtns.forEach((btn) => {
    const v = Number(btn.dataset.color ?? -1);
    btn.classList.toggle('is-active', v === currentColor);
    btn.setAttribute('aria-pressed', v === currentColor ? 'true' : 'false');
  });
}

function handleCanvasPointer(ev: PointerEvent): void {
  if (state !== 'playing') return;
  ev.preventDefault();
  const c = pointerToCell(ev);
  if (!c) return;
  applyClickAt(c.cx, c.cy);
}

function handleKey(e: KeyboardEvent): void {
  const k = e.key;
  const kl = k.toLowerCase();
  if (state !== 'playing') {
    if (k === 'Enter' || k === ' ') {
      advance();
      e.preventDefault();
      return;
    }
    if (kl === 'r') {
      if (state === 'gameWin') {
        levelIdx = 0;
        totalStrokes = 0;
        loadLevel(0);
      }
      e.preventDefault();
      return;
    }
    return;
  }
  if (k >= '1' && k <= '4') {
    setColor(Number(k) - 1);
    e.preventDefault();
    return;
  }
  if (kl === 'z') {
    undo();
    e.preventDefault();
    return;
  }
  if (kl === 'r') {
    restartLevel();
    e.preventDefault();
    return;
  }
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#cini-board')!;
  ctx = canvas.getContext('2d')!;
  targetCanvas = document.querySelector<HTMLCanvasElement>('#cini-target')!;
  targetCtx = targetCanvas.getContext('2d')!;
  levelEl = document.querySelector<HTMLElement>('#cini-level')!;
  strokesEl = document.querySelector<HTMLElement>('#cini-strokes')!;
  minEl = document.querySelector<HTMLElement>('#cini-min')!;
  bestEl = document.querySelector<HTMLElement>('#cini-best')!;
  overlayEl = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;
  undoBtn = document.querySelector<HTMLButtonElement>('#cini-undo')!;
  resetBtn = document.querySelector<HTMLButtonElement>('#cini-reset')!;
  paletteBtns = document.querySelectorAll<HTMLButtonElement>('.cini-palette__btn');

  bestTotal = safeRead<number>(STORAGE_BEST, 0);

  canvas.addEventListener('pointerdown', handleCanvasPointer);
  window.addEventListener('keydown', handleKey);

  paletteBtns.forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      const c = Number(btn.dataset.color ?? -1);
      if (Number.isFinite(c) && c >= 0 && c <= 3) setColor(c);
    });
  });

  undoBtn.addEventListener('click', (ev) => {
    ev.preventDefault();
    undo();
  });
  resetBtn.addEventListener('click', (ev) => {
    ev.preventDefault();
    restartLevel();
  });
  overlayBtn.addEventListener('click', (ev) => {
    ev.preventDefault();
    advance();
  });

  setColor(1);
  loadLevel(0);
}

export const game = defineGame({ init, reset: restartLevel });
