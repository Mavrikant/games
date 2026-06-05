// Tetris — vanilla TS, Canvas/DOM, SRS-lite rotation, 7-bag randomizer.

import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';
import { reportGameOver } from '@shared/leaderboard';

type PieceKind = 'I' | 'O' | 'T' | 'S' | 'Z' | 'J' | 'L';
type Cell = PieceKind | null;
type Matrix = number[][]; // 0 = empty, 1 = block

const COLS = 10;
const ROWS = 20;
const HIDDEN_ROWS = 2; // spawn buffer above visible area
const TOTAL_ROWS = ROWS + HIDDEN_ROWS;

const STORAGE_KEY = 'tetris.highScore';
const SCORE_DESC = { gameId: 'tetris', storageKey: STORAGE_KEY, direction: 'higher' as const };

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let nextCanvas!: HTMLCanvasElement;
let nextCtx!: CanvasRenderingContext2D;
let holdCanvas!: HTMLCanvasElement;
let holdCtx!: CanvasRenderingContext2D;

let scoreEl!: HTMLElement;
let linesEl!: HTMLElement;
let levelEl!: HTMLElement;
let bestEl!: HTMLElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let pauseBtn!: HTMLButtonElement;

// Logical (game-space) cell size. The drawing surface is rescaled to the
// element's CSS size times devicePixelRatio in `resizeCanvases`, so this
// remains the right unit for game-space math. Filled in init() since it
// depends on the live canvas width.
let CELL = 0;
let NEXT_LOGICAL = 0;
let HOLD_LOGICAL = 0;

// --- Piece definitions (SRS canonical shapes, rotation index 0) ---
const SHAPES: Record<PieceKind, Matrix[]> = {
  I: [
    [
      [0, 0, 0, 0],
      [1, 1, 1, 1],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ],
    [
      [0, 0, 1, 0],
      [0, 0, 1, 0],
      [0, 0, 1, 0],
      [0, 0, 1, 0],
    ],
    [
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [1, 1, 1, 1],
      [0, 0, 0, 0],
    ],
    [
      [0, 1, 0, 0],
      [0, 1, 0, 0],
      [0, 1, 0, 0],
      [0, 1, 0, 0],
    ],
  ],
  O: [
    [
      [1, 1],
      [1, 1],
    ],
    [
      [1, 1],
      [1, 1],
    ],
    [
      [1, 1],
      [1, 1],
    ],
    [
      [1, 1],
      [1, 1],
    ],
  ],
  T: [
    [
      [0, 1, 0],
      [1, 1, 1],
      [0, 0, 0],
    ],
    [
      [0, 1, 0],
      [0, 1, 1],
      [0, 1, 0],
    ],
    [
      [0, 0, 0],
      [1, 1, 1],
      [0, 1, 0],
    ],
    [
      [0, 1, 0],
      [1, 1, 0],
      [0, 1, 0],
    ],
  ],
  S: [
    [
      [0, 1, 1],
      [1, 1, 0],
      [0, 0, 0],
    ],
    [
      [0, 1, 0],
      [0, 1, 1],
      [0, 0, 1],
    ],
    [
      [0, 0, 0],
      [0, 1, 1],
      [1, 1, 0],
    ],
    [
      [1, 0, 0],
      [1, 1, 0],
      [0, 1, 0],
    ],
  ],
  Z: [
    [
      [1, 1, 0],
      [0, 1, 1],
      [0, 0, 0],
    ],
    [
      [0, 0, 1],
      [0, 1, 1],
      [0, 1, 0],
    ],
    [
      [0, 0, 0],
      [1, 1, 0],
      [0, 1, 1],
    ],
    [
      [0, 1, 0],
      [1, 1, 0],
      [1, 0, 0],
    ],
  ],
  J: [
    [
      [1, 0, 0],
      [1, 1, 1],
      [0, 0, 0],
    ],
    [
      [0, 1, 1],
      [0, 1, 0],
      [0, 1, 0],
    ],
    [
      [0, 0, 0],
      [1, 1, 1],
      [0, 0, 1],
    ],
    [
      [0, 1, 0],
      [0, 1, 0],
      [1, 1, 0],
    ],
  ],
  L: [
    [
      [0, 0, 1],
      [1, 1, 1],
      [0, 0, 0],
    ],
    [
      [0, 1, 0],
      [0, 1, 0],
      [0, 1, 1],
    ],
    [
      [0, 0, 0],
      [1, 1, 1],
      [1, 0, 0],
    ],
    [
      [1, 1, 0],
      [0, 1, 0],
      [0, 1, 0],
    ],
  ],
};

// SRS wall-kick data (JLSTZ). I-piece uses its own table.
const KICKS_JLSTZ: Record<string, Array<[number, number]>> = {
  '0>1': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '1>0': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  '1>2': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  '2>1': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '2>3': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  '3>2': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '3>0': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '0>3': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
};

const KICKS_I: Record<string, Array<[number, number]>> = {
  '0>1': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
  '1>0': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
  '1>2': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
  '2>1': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
  '2>3': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
  '3>2': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
  '3>0': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
  '0>3': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
};

interface ActivePiece {
  kind: PieceKind;
  rot: number;
  x: number; // top-left of bounding box
  y: number;
}

let grid: Cell[][] = createGrid();
let active: ActivePiece | null = null;
let nextQueue: PieceKind[] = [];
let bag: PieceKind[] = [];
let hold: PieceKind | null = null;
let holdLocked = false;
let score = 0;
let lines = 0;
let level = 1;
let best = readBest();
let alive = false;
let paused = false;
let started = false;
let lastTime = 0;
let dropAccum = 0;
let rafHandle = 0;

function createGrid(): Cell[][] {
  return Array.from({ length: TOTAL_ROWS }, () =>
    Array.from({ length: COLS }, () => null as Cell),
  );
}

function readBest(): number {
  const v = safeRead<number>(STORAGE_KEY, 0);
  return Number.isFinite(v) && v >= 0 ? v : 0;
}

function refillBag(): void {
  const pieces: PieceKind[] = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];
  // Fisher-Yates shuffle
  for (let i = pieces.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = pieces[i]!;
    const b = pieces[j]!;
    pieces[i] = b;
    pieces[j] = a;
  }
  bag.push(...pieces);
}

function nextPiece(): PieceKind {
  if (bag.length === 0) refillBag();
  return bag.shift()!;
}

function ensureQueue(): void {
  while (nextQueue.length < 3) nextQueue.push(nextPiece());
}

function spawn(kind?: PieceKind): void {
  ensureQueue();
  const k = kind ?? nextQueue.shift()!;
  ensureQueue();
  const shape = SHAPES[k][0]!;
  const w = shape[0]!.length;
  // Find topmost filled row of the spawn shape so the piece appears at the
  // top of the visible playfield instead of being hidden inside the buffer.
  let topFilledRow = 0;
  for (let r = 0; r < shape.length; r++) {
    if (shape[r]!.some((v) => v === 1)) {
      topFilledRow = r;
      break;
    }
  }
  const piece: ActivePiece = {
    kind: k,
    rot: 0,
    x: Math.floor((COLS - w) / 2),
    y: HIDDEN_ROWS - topFilledRow,
  };
  // Reset gravity accumulator so the freshly spawned piece doesn't drop a
  // row immediately because of leftover time from the previous piece.
  dropAccum = 0;
  if (collides(piece, grid)) {
    // Game over
    active = piece;
    die();
    return;
  }
  active = piece;
  holdLocked = false;
}

function shapeOf(p: ActivePiece): Matrix {
  return SHAPES[p.kind][p.rot]!;
}

function collides(p: ActivePiece, g: Cell[][]): boolean {
  const m = shapeOf(p);
  for (let r = 0; r < m.length; r++) {
    const row = m[r]!;
    for (let c = 0; c < row.length; c++) {
      if (!row[c]) continue;
      const x = p.x + c;
      const y = p.y + r;
      if (x < 0 || x >= COLS || y >= TOTAL_ROWS) return true;
      if (y < 0) continue; // above field is fine
      if (g[y]![x] !== null) return true;
    }
  }
  return false;
}

function tryMove(dx: number, dy: number): boolean {
  if (!active) return false;
  const moved: ActivePiece = { ...active, x: active.x + dx, y: active.y + dy };
  if (!collides(moved, grid)) {
    active = moved;
    return true;
  }
  return false;
}

function tryRotate(dir: 1 | -1): boolean {
  if (!active) return false;
  if (active.kind === 'O') return true; // no-op
  const from = active.rot;
  const to = ((from + dir) % 4 + 4) % 4;
  const key = `${from}>${to}`;
  const kicks = active.kind === 'I' ? KICKS_I[key]! : KICKS_JLSTZ[key]!;
  for (const [dx, dy] of kicks) {
    const candidate: ActivePiece = {
      ...active,
      rot: to,
      x: active.x + dx,
      // SRS y-axis: positive y is up in spec, our grid has positive y down.
      // Flip the kick's y component to match.
      y: active.y - dy,
    };
    if (!collides(candidate, grid)) {
      active = candidate;
      return true;
    }
  }
  return false;
}

function lockPiece(): void {
  if (!active) return;
  const m = shapeOf(active);
  for (let r = 0; r < m.length; r++) {
    const row = m[r]!;
    for (let c = 0; c < row.length; c++) {
      if (!row[c]) continue;
      const x = active.x + c;
      const y = active.y + r;
      if (y >= 0 && y < TOTAL_ROWS && x >= 0 && x < COLS) {
        grid[y]![x] = active.kind;
      }
    }
  }
  const cleared = clearLines();
  scoreLines(cleared);
  // Lock-out / block-out check: if locked entirely in hidden zone, top out
  if (cleared === 0 && active.y < HIDDEN_ROWS - 0) {
    // Check if any visible cells were actually placed
    let anyVisible = false;
    for (let r = 0; r < m.length; r++) {
      const row = m[r]!;
      for (let c = 0; c < row.length; c++) {
        if (row[c] && active.y + r >= HIDDEN_ROWS) anyVisible = true;
      }
    }
    if (!anyVisible) {
      die();
      return;
    }
  }
  spawn();
}

function clearLines(): number {
  let cleared = 0;
  for (let y = TOTAL_ROWS - 1; y >= 0; y--) {
    const row = grid[y]!;
    if (row.every((c) => c !== null)) {
      grid.splice(y, 1);
      grid.unshift(Array.from({ length: COLS }, () => null as Cell));
      cleared++;
      y++; // re-check this index
    }
  }
  return cleared;
}

function scoreLines(n: number): void {
  if (n === 0) return;
  const base = [0, 100, 300, 500, 800][n] ?? 0;
  score += base * level;
  lines += n;
  const newLevel = Math.floor(lines / 10) + 1;
  if (newLevel !== level) level = newLevel;
  updateHud();
}

function dropInterval(): number {
  // Classic Tetris gravity curve (ms per gravity step)
  const speeds = [
    800, 720, 630, 550, 470, 380, 300, 220, 130, 100, 80, 80, 80, 70, 70, 70,
    50, 50, 50, 30,
  ];
  return speeds[Math.min(level - 1, speeds.length - 1)]!;
}

function hardDrop(): void {
  if (!active) return;
  let dist = 0;
  while (tryMove(0, 1)) dist++;
  score += dist * 2;
  updateHud();
  lockPiece();
}

function softDrop(): void {
  if (tryMove(0, 1)) {
    score += 1;
    updateHud();
  } else {
    lockPiece();
  }
}

function holdPiece(): void {
  if (!active || holdLocked) return;
  const current = active.kind;
  if (hold === null) {
    hold = current;
    spawn();
  } else {
    const swap = hold;
    hold = current;
    spawn(swap);
  }
  holdLocked = true;
  drawHold();
}

function die(): void {
  alive = false;
  stopLoop();
  if (score > best) {
    best = score;
    safeWrite(STORAGE_KEY, best);
  }
  reportGameOver(SCORE_DESC, score);
  updateHud();
  draw();
  showOverlay('Oyun bitti', `Skor: ${score} · R ile yeniden başla`);
}

function reset(): void {
  grid = createGrid();
  bag = [];
  nextQueue = [];
  hold = null;
  holdLocked = false;
  score = 0;
  lines = 0;
  level = 1;
  alive = true;
  paused = false;
  started = false;
  dropAccum = 0;
  updatePauseBtn();
  resizeAllCanvases();
  ensureQueue();
  spawn();
  updateHud();
  draw();
  drawNext();
  drawHold();
  showOverlay('Tetris', 'Başlamak için bir tuşa bas (mobilde dokunmatik kontrolleri kullan).');
  stopLoop();
}

function updatePauseBtn(): void {
  if (!started || !alive) {
    pauseBtn.textContent = 'Duraklat';
    pauseBtn.setAttribute('aria-pressed', 'false');
    pauseBtn.disabled = !alive;
    return;
  }
  pauseBtn.disabled = false;
  pauseBtn.textContent = paused ? 'Devam et' : 'Duraklat';
  pauseBtn.setAttribute('aria-pressed', String(paused));
}

function togglePause(): void {
  if (!alive || !started) return;
  paused = !paused;
  if (paused) showOverlay('Duraklatıldı', 'Devam için Duraklat düğmesine veya P tuşuna bas.');
  else {
    hideOverlay();
    lastTime = performance.now();
  }
  updatePauseBtn();
}

function updateHud(): void {
  scoreEl.textContent = String(score);
  linesEl.textContent = String(lines);
  levelEl.textContent = String(level);
  bestEl.textContent = String(best);
}

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlay);
}

function hideOverlay(): void {
  hideOverlayEl(overlay);
}

// --- Rendering ---
const cssCache = new Map<string, string>();
function getCss(name: string): string {
  const cached = cssCache.get(name);
  if (cached !== undefined) return cached;
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  cssCache.set(name, v);
  return v;
}

function colorFor(k: PieceKind): string {
  switch (k) {
    case 'I':
      return getCss('--t-i');
    case 'O':
      return getCss('--t-o');
    case 'T':
      return getCss('--t-t');
    case 'S':
      return getCss('--t-s');
    case 'Z':
      return getCss('--t-z');
    case 'J':
      return getCss('--t-j');
    case 'L':
      return getCss('--t-l');
  }
}

function drawBlock(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  color: string,
  ghost = false,
): void {
  const pad = 1;
  if (ghost) {
    c.fillStyle = 'transparent';
    c.strokeStyle = color;
    c.lineWidth = 2;
    c.strokeRect(x + pad + 1, y + pad + 1, size - pad * 2 - 2, size - pad * 2 - 2);
    return;
  }
  c.fillStyle = color;
  c.fillRect(x + pad, y + pad, size - pad * 2, size - pad * 2);
  // small highlight
  c.fillStyle = 'rgba(255,255,255,0.18)';
  c.fillRect(x + pad, y + pad, size - pad * 2, 3);
}

function draw(): void {
  // Draw in logical pixels — `resizeCanvases` has applied a DPR transform
  // so canvas.width/height in raw pixels are larger than the COLS*CELL grid.
  const W = COLS * CELL;
  const H = ROWS * CELL + HIDDEN_ROWS * CELL - HIDDEN_ROWS * CELL; // = ROWS*CELL
  ctx.fillStyle = getCss('--surface');
  ctx.fillRect(0, 0, W, H);

  // grid lines
  ctx.strokeStyle = getCss('--t-grid');
  ctx.lineWidth = 1;
  for (let i = 1; i < COLS; i++) {
    ctx.beginPath();
    ctx.moveTo(i * CELL, 0);
    ctx.lineTo(i * CELL, H);
    ctx.stroke();
  }
  for (let i = 1; i < ROWS; i++) {
    ctx.beginPath();
    ctx.moveTo(0, i * CELL);
    ctx.lineTo(W, i * CELL);
    ctx.stroke();
  }

  // locked cells (only visible portion)
  for (let y = HIDDEN_ROWS; y < TOTAL_ROWS; y++) {
    const row = grid[y]!;
    for (let x = 0; x < COLS; x++) {
      const c = row[x];
      if (c !== null) {
        drawBlock(ctx, x * CELL, (y - HIDDEN_ROWS) * CELL, CELL, colorFor(c));
      }
    }
  }

  // ghost piece
  if (active && alive) {
    const ghost: ActivePiece = { ...active };
    while (!collides({ ...ghost, y: ghost.y + 1 }, grid)) ghost.y++;
    const m = shapeOf(ghost);
    const color = colorFor(ghost.kind);
    for (let r = 0; r < m.length; r++) {
      const row = m[r]!;
      for (let c = 0; c < row.length; c++) {
        if (!row[c]) continue;
        const gx = ghost.x + c;
        const gy = ghost.y + r;
        if (gy >= HIDDEN_ROWS) {
          drawBlock(
            ctx,
            gx * CELL,
            (gy - HIDDEN_ROWS) * CELL,
            CELL,
            color,
            true,
          );
        }
      }
    }
  }

  // active piece
  if (active) {
    const m = shapeOf(active);
    const color = colorFor(active.kind);
    for (let r = 0; r < m.length; r++) {
      const row = m[r]!;
      for (let c = 0; c < row.length; c++) {
        if (!row[c]) continue;
        const gx = active.x + c;
        const gy = active.y + r;
        if (gy >= HIDDEN_ROWS) {
          drawBlock(ctx, gx * CELL, (gy - HIDDEN_ROWS) * CELL, CELL, color);
        }
      }
    }
  }
}

function drawMini(
  c: CanvasRenderingContext2D,
  logicalSize: number,
  kind: PieceKind | null,
): void {
  // Mini canvases are square. `logicalSize` is the logical width/height
  // (300 for board, 120 for next/hold) — the actual pixel dims may be
  // larger due to DPR but `resizeCanvases` has set up the transform.
  c.fillStyle = getCss('--surface-2');
  c.fillRect(0, 0, logicalSize, logicalSize);
  if (!kind) return;
  const shape = SHAPES[kind][0]!;
  // Find bounding box
  let minR = shape.length;
  let maxR = -1;
  let minC = shape[0]!.length;
  let maxC = -1;
  for (let r = 0; r < shape.length; r++) {
    for (let cc = 0; cc < shape[r]!.length; cc++) {
      if (shape[r]![cc]) {
        if (r < minR) minR = r;
        if (r > maxR) maxR = r;
        if (cc < minC) minC = cc;
        if (cc > maxC) maxC = cc;
      }
    }
  }
  const w = maxC - minC + 1;
  const h = maxR - minR + 1;
  const size = Math.min(logicalSize / 5, logicalSize / 5);
  const offX = (logicalSize - w * size) / 2;
  const offY = (logicalSize - h * size) / 2;
  const color = colorFor(kind);
  for (let r = minR; r <= maxR; r++) {
    for (let cc = minC; cc <= maxC; cc++) {
      if (shape[r]![cc]) {
        drawBlock(
          c,
          offX + (cc - minC) * size,
          offY + (r - minR) * size,
          size,
          color,
        );
      }
    }
  }
}

function drawNext(): void {
  drawMini(nextCtx, NEXT_LOGICAL, nextQueue[0] ?? null);
}

function drawHold(): void {
  drawMini(holdCtx, HOLD_LOGICAL, hold);
}

// --- DPR-aware canvas sizing ---
// Without this the canvas would be drawn at its 300x600 bitmap and
// stretched/squashed by CSS, producing a blurry, soft picture on
// retina-class mobile screens. Resize the backing store to CSS pixels
// times DPR and scale the context so all game math stays in logical units.
function resizeCanvas(
  cv: HTMLCanvasElement,
  c: CanvasRenderingContext2D,
  logicalW: number,
  logicalH: number,
): void {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const rect = cv.getBoundingClientRect();
  // Fall back to the logical size when CSS-driven sizing hasn't kicked in
  // yet (e.g. element hidden offscreen during early init).
  const cssW = Math.max(1, Math.round(rect.width || logicalW));
  const cssH = Math.max(1, Math.round(rect.height || logicalH));
  const targetW = Math.round(cssW * dpr);
  const targetH = Math.round(cssH * dpr);
  if (cv.width !== targetW || cv.height !== targetH) {
    cv.width = targetW;
    cv.height = targetH;
  }
  // Scale so 1 unit in the context = 1 logical game pixel regardless of CSS.
  const scaleX = targetW / logicalW;
  const scaleY = targetH / logicalH;
  c.setTransform(scaleX, 0, 0, scaleY, 0, 0);
  c.imageSmoothingEnabled = false;
}

function resizeAllCanvases(): void {
  resizeCanvas(canvas, ctx, COLS * CELL, ROWS * CELL);
  resizeCanvas(nextCanvas, nextCtx, NEXT_LOGICAL, NEXT_LOGICAL);
  resizeCanvas(holdCanvas, holdCtx, HOLD_LOGICAL, HOLD_LOGICAL);
}

// --- Loop ---
function loop(t: number): void {
  if (!alive || paused) {
    rafHandle = requestAnimationFrame(loop);
    return;
  }
  const dt = t - lastTime;
  lastTime = t;
  dropAccum += dt;
  const interval = dropInterval();
  while (dropAccum >= interval) {
    dropAccum -= interval;
    if (!tryMove(0, 1)) {
      lockPiece();
      if (!alive) {
        rafHandle = requestAnimationFrame(loop);
        return;
      }
      drawNext();
      drawHold();
    }
  }
  draw();
  rafHandle = requestAnimationFrame(loop);
}

function startLoop(): void {
  if (rafHandle !== 0) return;
  lastTime = performance.now();
  dropAccum = 0;
  rafHandle = requestAnimationFrame(loop);
}

function stopLoop(): void {
  if (rafHandle !== 0) {
    cancelAnimationFrame(rafHandle);
    rafHandle = 0;
  }
}

function startIfNeeded(): void {
  if (!started && alive) {
    started = true;
    hideOverlay();
    startLoop();
    updatePauseBtn();
  }
}

// --- Input (wired up by init()) ---
function onKeyDown(e: KeyboardEvent): void {
  const k = e.key.toLowerCase();
  if (k === 'r') {
    reset();
    e.preventDefault();
    return;
  }
  if (k === 'p') {
    togglePause();
    e.preventDefault();
    return;
  }
  if (!alive) return;

  if (k === 'arrowleft') {
    startIfNeeded();
    if (!paused) {
      tryMove(-1, 0);
      draw();
    }
    e.preventDefault();
  } else if (k === 'arrowright') {
    startIfNeeded();
    if (!paused) {
      tryMove(1, 0);
      draw();
    }
    e.preventDefault();
  } else if (k === 'arrowdown') {
    startIfNeeded();
    if (!paused) {
      softDrop();
      draw();
      drawNext();
    }
    e.preventDefault();
  } else if (k === 'arrowup' || k === 'x') {
    startIfNeeded();
    if (!paused) {
      tryRotate(1);
      draw();
    }
    e.preventDefault();
  } else if (k === 'z') {
    startIfNeeded();
    if (!paused) {
      tryRotate(-1);
      draw();
    }
    e.preventDefault();
  } else if (k === ' ') {
    startIfNeeded();
    if (!paused) {
      hardDrop();
      draw();
      drawNext();
    }
    e.preventDefault();
  } else if (k === 'c' || k === 'shift') {
    startIfNeeded();
    if (!paused) {
      holdPiece();
      draw();
    }
    e.preventDefault();
  }
}

// --- Touch / pointer controls ---
// Tetris is fundamentally an auto-repeat game: holding ←/→ should keep
// shifting the piece. We use pointerdown/up so the same handlers cover
// touch, mouse, and pen, and we kick off a DAS-like repeat for the
// directional actions. preventDefault stops iOS Safari from intercepting
// the gesture as a scroll, double-tap zoom, or text selection.
const REPEAT_INITIAL_MS = 170;
const REPEAT_INTERVAL_MS = 60;
const SOFT_DROP_INTERVAL_MS = 45;
const REPEATABLE = new Set<string>(['left', 'right', 'down']);

interface RepeatState {
  initialTimer: number;
  intervalTimer: number;
}
const activeRepeats = new Map<HTMLButtonElement, RepeatState>();

function performAct(act: string | undefined): void {
  if (!act || !alive || paused) return;
  if (act === 'left') tryMove(-1, 0);
  else if (act === 'right') tryMove(1, 0);
  else if (act === 'down') softDrop();
  else if (act === 'rotate') tryRotate(1);
  else if (act === 'rotate-ccw') tryRotate(-1);
  else if (act === 'drop') hardDrop();
  else if (act === 'hold') holdPiece();
  draw();
  drawNext();
}

function stopRepeat(btn: HTMLButtonElement): void {
  const r = activeRepeats.get(btn);
  if (!r) return;
  window.clearTimeout(r.initialTimer);
  window.clearInterval(r.intervalTimer);
  activeRepeats.delete(btn);
  btn.classList.remove('touch__btn--pressed');
}

function stopAllRepeats(): void {
  for (const btn of Array.from(activeRepeats.keys())) stopRepeat(btn);
}

function wireTouchButtons(): void {
  document.querySelectorAll<HTMLButtonElement>('.touch__btn').forEach((btn) => {
  const act: string | undefined = btn.dataset.act;
  // pointerdown gives us a single event for touch+mouse+pen and fires
  // immediately (no 300ms click delay on iOS).
  btn.addEventListener(
    'pointerdown',
    (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();
      // Trigger button visual feedback even if held.
      btn.classList.add('touch__btn--pressed');
      if (!alive) return;
      startIfNeeded();
      performAct(act);
      if (act && REPEATABLE.has(act)) {
        // DAS-style: hold the button → after a short delay, start repeating
        // until release. Soft drop repeats faster for that "rain" feel.
        const intervalMs = act === 'down' ? SOFT_DROP_INTERVAL_MS : REPEAT_INTERVAL_MS;
        const initialTimer = window.setTimeout(() => {
          const intervalTimer = window.setInterval(() => {
            performAct(act);
          }, intervalMs);
          const prev = activeRepeats.get(btn);
          if (prev) {
            window.clearTimeout(prev.initialTimer);
            window.clearInterval(prev.intervalTimer);
          }
          activeRepeats.set(btn, { initialTimer: 0, intervalTimer });
        }, REPEAT_INITIAL_MS);
        activeRepeats.set(btn, { initialTimer, intervalTimer: 0 });
      }
      // Try to capture the pointer so pointerup fires reliably even if
      // the finger drifts off the button.
      try {
        btn.setPointerCapture(e.pointerId);
      } catch {
        /* unsupported, ignore */
      }
    },
    { passive: false },
  );
  const release = (e: Event) => {
    e.preventDefault();
    stopRepeat(btn);
  };
  btn.addEventListener('pointerup', release);
  btn.addEventListener('pointercancel', release);
  btn.addEventListener('pointerleave', () => stopRepeat(btn));
  // Suppress the legacy click event so we don't fire actions twice on
  // browsers that synthesize click after pointerup.
  btn.addEventListener('click', (e) => e.preventDefault());
  // Prevent context menu on long-press (iOS / Android).
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
  });
}

// --- Resize handling ---
// Re-DPR the canvases whenever layout changes (orientation, browser
// chrome show/hide, viewport resize). Keep the call cheap because
// browsers fire resize while the user drags the address bar.
let resizeRafHandle = 0;
function onResize(): void {
  if (resizeRafHandle) return;
  resizeRafHandle = requestAnimationFrame(() => {
    resizeRafHandle = 0;
    resizeAllCanvases();
    draw();
    drawNext();
    drawHold();
  });
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  nextCanvas = document.querySelector<HTMLCanvasElement>('#next')!;
  nextCtx = nextCanvas.getContext('2d')!;
  holdCanvas = document.querySelector<HTMLCanvasElement>('#hold')!;
  holdCtx = holdCanvas.getContext('2d')!;

  scoreEl = document.querySelector<HTMLElement>('#score')!;
  linesEl = document.querySelector<HTMLElement>('#lines')!;
  levelEl = document.querySelector<HTMLElement>('#level')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  pauseBtn = document.querySelector<HTMLButtonElement>('#pause')!;

  CELL = canvas.width / COLS;
  NEXT_LOGICAL = nextCanvas.width;
  HOLD_LOGICAL = holdCanvas.width;

  window.addEventListener('keydown', onKeyDown);
  wireTouchButtons();

  // If the page loses focus / user switches tabs / pointer leaves the
  // window, stop any auto-repeat to avoid surprise inputs on return.
  window.addEventListener('blur', stopAllRepeats);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopAllRepeats();
  });

  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);

  restartBtn.addEventListener('click', () => {
    stopAllRepeats();
    reset();
  });

  pauseBtn.addEventListener('click', () => {
    if (!alive) return;
    if (!started) {
      startIfNeeded();
      togglePause();
      return;
    }
    togglePause();
  });

  reset();
}

export const game = defineGame({ init, reset });
