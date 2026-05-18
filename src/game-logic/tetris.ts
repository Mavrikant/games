// Tetris — vanilla TS, Canvas/DOM, SRS-lite rotation, 7-bag randomizer.

type PieceKind = 'I' | 'O' | 'T' | 'S' | 'Z' | 'J' | 'L';
type Cell = PieceKind | null;
type Matrix = number[][]; // 0 = empty, 1 = block

const COLS = 10;
const ROWS = 20;
const HIDDEN_ROWS = 2; // spawn buffer above visible area
const TOTAL_ROWS = ROWS + HIDDEN_ROWS;

const STORAGE_KEY = 'tetris.highScore';

const canvas = document.querySelector<HTMLCanvasElement>('#board')!;
const ctx = canvas.getContext('2d')!;
const nextCanvas = document.querySelector<HTMLCanvasElement>('#next')!;
const nextCtx = nextCanvas.getContext('2d')!;
const holdCanvas = document.querySelector<HTMLCanvasElement>('#hold')!;
const holdCtx = holdCanvas.getContext('2d')!;

const scoreEl = document.querySelector<HTMLElement>('#score')!;
const linesEl = document.querySelector<HTMLElement>('#lines')!;
const levelEl = document.querySelector<HTMLElement>('#level')!;
const bestEl = document.querySelector<HTMLElement>('#best')!;
const overlay = document.querySelector<HTMLElement>('#overlay')!;
const overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
const overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
const restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;

const CELL = canvas.width / COLS; // 30px

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
let best = Number(localStorage.getItem(STORAGE_KEY) ?? '0') || 0;
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
  const piece: ActivePiece = {
    kind: k,
    rot: 0,
    x: Math.floor((COLS - w) / 2),
    y: 0, // top of hidden buffer
  };
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
    try {
      localStorage.setItem(STORAGE_KEY, String(best));
    } catch {
      /* ignore */
    }
  }
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
  ensureQueue();
  spawn();
  updateHud();
  draw();
  drawNext();
  drawHold();
  showOverlay('Tetris', 'Başlamak için bir tuşa bas (← → ↓ Z X Boşluk).');
  stopLoop();
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
  overlay.classList.remove('overlay--hidden');
}

function hideOverlay(): void {
  overlay.classList.add('overlay--hidden');
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
  ctx.fillStyle = getCss('--surface');
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // grid lines
  ctx.strokeStyle = getCss('--t-grid');
  ctx.lineWidth = 1;
  for (let i = 1; i < COLS; i++) {
    ctx.beginPath();
    ctx.moveTo(i * CELL, 0);
    ctx.lineTo(i * CELL, canvas.height);
    ctx.stroke();
  }
  for (let i = 1; i < ROWS; i++) {
    ctx.beginPath();
    ctx.moveTo(0, i * CELL);
    ctx.lineTo(canvas.width, i * CELL);
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
  cv: HTMLCanvasElement,
  kind: PieceKind | null,
): void {
  c.fillStyle = getCss('--surface-2');
  c.fillRect(0, 0, cv.width, cv.height);
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
  const size = Math.min(cv.width / 5, cv.height / 5);
  const offX = (cv.width - w * size) / 2;
  const offY = (cv.height - h * size) / 2;
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
  drawMini(nextCtx, nextCanvas, nextQueue[0] ?? null);
}

function drawHold(): void {
  drawMini(holdCtx, holdCanvas, hold);
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
  }
}

// --- Input ---
window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k === 'r') {
    reset();
    e.preventDefault();
    return;
  }
  if (k === 'p') {
    if (alive && started) {
      paused = !paused;
      if (paused) showOverlay('Duraklatıldı', 'Devam için P tuşuna bas.');
      else {
        hideOverlay();
        lastTime = performance.now();
      }
    }
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
});

// Touch buttons
document.querySelectorAll<HTMLButtonElement>('.touch__btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (!alive) return;
    startIfNeeded();
    if (paused) return;
    const act = btn.dataset.act;
    if (act === 'left') tryMove(-1, 0);
    else if (act === 'right') tryMove(1, 0);
    else if (act === 'down') softDrop();
    else if (act === 'rotate') tryRotate(1);
    else if (act === 'drop') hardDrop();
    draw();
    drawNext();
  });
});

restartBtn.addEventListener('click', () => {
  reset();
});

reset();
