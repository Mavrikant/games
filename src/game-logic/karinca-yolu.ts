import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import {
  showOverlay as showOverlayEl,
  hideOverlay as hideOverlayEl,
} from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';

const STORAGE_BEST = 'karinca-yolu.best';

const COLS = 24;
const ROWS = 24;
const CELL = 20;
const CANVAS_W = COLS * CELL;
const CANVAS_H = ROWS * CELL;
// Nest occupies a 2x2 block centered on the board.
const NEST_X = 11;
const NEST_Y = 11;

const TIME_LIMIT_MS = 90_000;
const ANT_SPAWN_INTERVAL_MS = 700;
const MAX_ANTS = 12;
const ANT_STEP_MS = 220;
const FOOD_SPAWN_INTERVAL_MS = 3500;
const MAX_FOOD = 5;
const PHERO_PAINT = 1.0;
const PHERO_DECAY_PER_MS = 0.00022; // ~0.22/sec → ~4.5s to fade from full.

type State = 'ready' | 'playing' | 'gameover';
type Food = { x: number; y: number };
type Ant = {
  gx: number;
  gy: number;
  px: number;
  py: number;
  stepT: number; // 0..1 lerp progress between px,py and gx,gy
  carrying: boolean;
  hx: number; // last cell — used to avoid immediate backtrack
  hy: number;
};

const gen = createGenToken();
let state: State = 'ready';
let score = 0;
let best = 0;
let timeLeft = TIME_LIMIT_MS;
let phero = new Float32Array(COLS * ROWS);
let ants: Ant[] = [];
let foods: Food[] = [];
let antSpawnTimer = ANT_SPAWN_INTERVAL_MS;
let foodSpawnTimer = FOOD_SPAWN_INTERVAL_MS;
let painting = false;
let pointerCx = -1;
let pointerCy = -1;
let lastPaintCx = -1;
let lastPaintCy = -1;
let lastFrame = 0;
let rafHandle: number | null = null;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let timerEl!: HTMLElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayBtn!: HTMLButtonElement;
let restartBtn!: HTMLButtonElement;

function idx(x: number, y: number): number {
  return y * COLS + x;
}

function inBounds(x: number, y: number): boolean {
  return x >= 0 && x < COLS && y >= 0 && y < ROWS;
}

function isNestCell(x: number, y: number): boolean {
  return x >= NEST_X && x < NEST_X + 2 && y >= NEST_Y && y < NEST_Y + 2;
}

function distToNest(x: number, y: number): number {
  // Manhattan distance to nearest nest cell.
  const dx = Math.max(0, Math.max(NEST_X - x, x - (NEST_X + 1)));
  const dy = Math.max(0, Math.max(NEST_Y - y, y - (NEST_Y + 1)));
  return dx + dy;
}

function spawnFood(): void {
  if (foods.length >= MAX_FOOD) return;
  // Try a few times to find a border-ish cell far from nest and not on existing food.
  for (let attempt = 0; attempt < 40; attempt++) {
    const side = Math.floor(Math.random() * 4);
    let x = 0;
    let y = 0;
    if (side === 0) {
      x = 1 + Math.floor(Math.random() * (COLS - 2));
      y = 1 + Math.floor(Math.random() * 2);
    } else if (side === 1) {
      x = 1 + Math.floor(Math.random() * (COLS - 2));
      y = ROWS - 2 - Math.floor(Math.random() * 2);
    } else if (side === 2) {
      x = 1 + Math.floor(Math.random() * 2);
      y = 1 + Math.floor(Math.random() * (ROWS - 2));
    } else {
      x = COLS - 2 - Math.floor(Math.random() * 2);
      y = 1 + Math.floor(Math.random() * (ROWS - 2));
    }
    if (isNestCell(x, y)) continue;
    if (distToNest(x, y) < 7) continue;
    if (foods.some((f) => f.x === x && f.y === y)) continue;
    foods.push({ x, y });
    return;
  }
}

function spawnAnt(): void {
  if (ants.length >= MAX_ANTS) return;
  const gx = NEST_X + Math.floor(Math.random() * 2);
  const gy = NEST_Y + Math.floor(Math.random() * 2);
  ants.push({
    gx,
    gy,
    px: gx,
    py: gy,
    stepT: 0,
    carrying: false,
    hx: gx,
    hy: gy,
  });
}

const NEIGHBORS: Array<[number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

function stepAnt(a: Ant): void {
  let nx = a.gx;
  let ny = a.gy;

  if (a.carrying) {
    // Greedy toward nest (Manhattan), random tiebreak.
    let bestD = Infinity;
    const candidates: Array<[number, number]> = [];
    for (const [dx, dy] of NEIGHBORS) {
      const x = a.gx + dx;
      const y = a.gy + dy;
      if (!inBounds(x, y)) continue;
      const d = distToNest(x, y);
      if (d < bestD) {
        bestD = d;
        candidates.length = 0;
        candidates.push([x, y]);
      } else if (d === bestD) {
        candidates.push([x, y]);
      }
    }
    if (candidates.length === 0) return;
    const pick = candidates[Math.floor(Math.random() * candidates.length)]!;
    nx = pick[0];
    ny = pick[1];
  } else {
    // Foraging: prefer high-pheromone neighbor with anti-backtrack bias.
    type Cand = { x: number; y: number; w: number };
    const cands: Cand[] = [];
    let total = 0;
    for (const [dx, dy] of NEIGHBORS) {
      const x = a.gx + dx;
      const y = a.gy + dy;
      if (!inBounds(x, y)) continue;
      // Avoid wandering into the nest while foraging — wastes ants.
      if (isNestCell(x, y)) continue;
      // Base weight: pheromone^2 (strong gradient bias) + small exploration term.
      const p = phero[idx(x, y)] ?? 0;
      let w = p * p * 60 + 0.12;
      // Heavy penalty for immediate backtrack — keeps ants moving forward.
      if (x === a.hx && y === a.hy) w *= 0.15;
      cands.push({ x, y, w });
      total += w;
    }
    if (cands.length === 0) {
      // Fully blocked (e.g., 4 nest neighbors) → just stay.
      return;
    }
    let r = Math.random() * total;
    let chosen = cands[0]!;
    for (const c of cands) {
      r -= c.w;
      if (r <= 0) {
        chosen = c;
        break;
      }
    }
    nx = chosen.x;
    ny = chosen.y;
  }

  a.hx = a.gx;
  a.hy = a.gy;
  a.px = a.gx;
  a.py = a.gy;
  a.gx = nx;
  a.gy = ny;
  a.stepT = 0;

  if (a.carrying) {
    if (isNestCell(a.gx, a.gy)) {
      a.carrying = false;
      score += 1;
      if (score > best) {
        best = score;
        safeWrite(STORAGE_BEST, best);
      }
    }
  } else {
    const fi = foods.findIndex((f) => f.x === a.gx && f.y === a.gy);
    if (fi >= 0) {
      foods.splice(fi, 1);
      a.carrying = true;
      // After grabbing food the ant should head home; clear backtrack memory.
      a.hx = a.gx;
      a.hy = a.gy;
    }
  }
}

function paintAt(cx: number, cy: number): void {
  if (!inBounds(cx, cy)) return;
  if (isNestCell(cx, cy)) return;
  phero[idx(cx, cy)] = PHERO_PAINT;
}

function paintLine(x0: number, y0: number, x1: number, y1: number): void {
  // Bresenham-ish cell walk so fast drags don't leave gaps.
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  let x = x0;
  let y = y0;
  // Cap iterations defensively.
  for (let i = 0; i < COLS + ROWS; i++) {
    paintAt(x, y);
    if (x === x1 && y === y1) return;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
  }
}

function applyPainting(): void {
  if (!painting) return;
  if (pointerCx < 0 || pointerCy < 0) return;
  if (lastPaintCx < 0) {
    paintAt(pointerCx, pointerCy);
  } else if (lastPaintCx !== pointerCx || lastPaintCy !== pointerCy) {
    paintLine(lastPaintCx, lastPaintCy, pointerCx, pointerCy);
  } else {
    // Same cell as last frame — keep it refreshed against decay.
    paintAt(pointerCx, pointerCy);
  }
  lastPaintCx = pointerCx;
  lastPaintCy = pointerCy;
}

function updateGame(dt: number): void {
  // Pheromone decay.
  const decay = PHERO_DECAY_PER_MS * dt;
  for (let i = 0; i < phero.length; i++) {
    const v = phero[i]!;
    if (v > 0) phero[i] = v > decay ? v - decay : 0;
  }

  applyPainting();

  antSpawnTimer -= dt;
  if (antSpawnTimer <= 0) {
    spawnAnt();
    antSpawnTimer = ANT_SPAWN_INTERVAL_MS;
  }

  foodSpawnTimer -= dt;
  if (foodSpawnTimer <= 0) {
    spawnFood();
    foodSpawnTimer = FOOD_SPAWN_INTERVAL_MS;
  }

  for (const a of ants) {
    a.stepT += dt / ANT_STEP_MS;
    if (a.stepT >= 1) {
      a.stepT = 0;
      stepAnt(a);
    }
  }

  timeLeft -= dt;
  if (timeLeft <= 0) {
    timeLeft = 0;
    finishRound();
    return;
  }
  updateHud();
}

function updateHud(): void {
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
  timerEl.textContent = String(Math.max(0, Math.ceil(timeLeft / 1000)));
}

function drawBackground(): void {
  ctx.fillStyle = '#1a160e';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  // Subtle soil texture with diagonal hatch.
  ctx.strokeStyle = 'rgba(70, 50, 30, 0.18)';
  ctx.lineWidth = 1;
  for (let i = 1; i < COLS; i++) {
    ctx.beginPath();
    ctx.moveTo(i * CELL, 0);
    ctx.lineTo(i * CELL, CANVAS_H);
    ctx.stroke();
  }
  for (let i = 1; i < ROWS; i++) {
    ctx.beginPath();
    ctx.moveTo(0, i * CELL);
    ctx.lineTo(CANVAS_W, i * CELL);
    ctx.stroke();
  }
}

function drawPheromone(): void {
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const v = phero[idx(x, y)]!;
      if (v <= 0.02) continue;
      const a = Math.min(0.85, v * 0.85 + 0.05);
      ctx.fillStyle = `rgba(255, 188, 70, ${a})`;
      ctx.fillRect(x * CELL + 1, y * CELL + 1, CELL - 2, CELL - 2);
    }
  }
}

function drawNest(): void {
  const cx = (NEST_X + 1) * CELL;
  const cy = (NEST_Y + 1) * CELL;
  // Outer mound (soft circle).
  ctx.fillStyle = '#8a6238';
  ctx.beginPath();
  ctx.arc(cx, cy, CELL * 1.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#a87a4a';
  ctx.beginPath();
  ctx.arc(cx, cy, CELL * 1.0, 0, Math.PI * 2);
  ctx.fill();
  // Entrance hole.
  ctx.fillStyle = '#2a1a0a';
  ctx.beginPath();
  ctx.arc(cx, cy, CELL * 0.45, 0, Math.PI * 2);
  ctx.fill();
}

function drawFood(): void {
  for (const f of foods) {
    const cx = (f.x + 0.5) * CELL;
    const cy = (f.y + 0.5) * CELL;
    // Leaf body (rotated ellipse).
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(Math.PI / 4);
    const grad = ctx.createLinearGradient(-CELL * 0.5, 0, CELL * 0.5, 0);
    grad.addColorStop(0, '#5fbf4f');
    grad.addColorStop(1, '#8ee47c');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.ellipse(0, 0, CELL * 0.48, CELL * 0.28, 0, 0, Math.PI * 2);
    ctx.fill();
    // Vein.
    ctx.strokeStyle = '#2c6a24';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(-CELL * 0.4, 0);
    ctx.lineTo(CELL * 0.4, 0);
    ctx.stroke();
    ctx.restore();
  }
}

function drawAnts(): void {
  for (const a of ants) {
    const fx = (a.px + (a.gx - a.px) * a.stepT + 0.5) * CELL;
    const fy = (a.py + (a.gy - a.py) * a.stepT + 0.5) * CELL;
    // Body.
    ctx.fillStyle = '#0d0d0d';
    ctx.beginPath();
    ctx.arc(fx, fy, 3.6, 0, Math.PI * 2);
    ctx.fill();
    // Head dot in motion direction.
    const dxm = a.gx - a.px;
    const dym = a.gy - a.py;
    const hd = Math.hypot(dxm, dym) || 1;
    const headX = fx + (dxm / hd) * 3.2;
    const headY = fy + (dym / hd) * 3.2;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.arc(headX, headY, 2.2, 0, Math.PI * 2);
    ctx.fill();
    // Cargo (green leaf bit) when carrying.
    if (a.carrying) {
      ctx.fillStyle = '#7be36c';
      ctx.beginPath();
      ctx.arc(fx, fy - 4.2, 2.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#2c6a24';
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(fx - 2, fy - 4.2);
      ctx.lineTo(fx + 2, fy - 4.2);
      ctx.stroke();
    }
  }
}

function draw(): void {
  drawBackground();
  drawPheromone();
  drawNest();
  drawFood();
  drawAnts();
}

function showReadyOverlay(): void {
  overlayTitle.textContent = 'Karınca Yolu';
  overlayMsg.textContent =
    'Izgaraya parmağınla sürükle, koku izi çiz.\nKarıncalar izi takip edip yiyeceği yuvaya getirir.\nİzler zamanla soluyor — yenilemen gerek.\nSüre: 90 sn.';
  overlayBtn.textContent = 'Başla';
  showOverlayEl(overlay);
}

function showGameOverOverlay(): void {
  overlayTitle.textContent = 'Süre Bitti';
  const fresh = score > 0 && score >= best;
  overlayMsg.textContent =
    `Yuvaya getirilen: ${score}` +
    (fresh ? '  ·  Yeni rekor!' : `\nRekor: ${best}`);
  overlayBtn.textContent = 'Tekrar dene';
  showOverlayEl(overlay);
}

function resetWorld(): void {
  phero = new Float32Array(COLS * ROWS);
  ants = [];
  foods = [];
  antSpawnTimer = 100;
  foodSpawnTimer = 600;
  painting = false;
  pointerCx = -1;
  pointerCy = -1;
  lastPaintCx = -1;
  lastPaintCy = -1;
  // Seed a couple of foods so the player has something to aim at.
  spawnFood();
  spawnFood();
}

function reset(): void {
  gen.bump();
  stopRaf();
  state = 'ready';
  score = 0;
  timeLeft = TIME_LIMIT_MS;
  resetWorld();
  updateHud();
  draw();
  showReadyOverlay();
}

function startRound(): void {
  hideOverlayEl(overlay);
  state = 'playing';
  score = 0;
  timeLeft = TIME_LIMIT_MS;
  resetWorld();
  // Pre-spawn one ant so the player gets immediate feedback (<250ms).
  spawnAnt();
  updateHud();
  draw();
  stopRaf();
  startRaf();
}

function finishRound(): void {
  state = 'gameover';
  stopRaf();
  painting = false;
  updateHud();
  draw();
  showGameOverOverlay();
}

function startRaf(): void {
  if (rafHandle !== null) return;
  const myGen = gen.current();
  lastFrame = performance.now();
  const loop = (t: number): void => {
    if (!gen.isCurrent(myGen)) {
      rafHandle = null;
      return;
    }
    const dt = Math.min(40, t - lastFrame);
    lastFrame = t;
    if (state === 'playing') {
      updateGame(dt);
      draw();
      rafHandle = requestAnimationFrame(loop);
    } else {
      rafHandle = null;
    }
  };
  rafHandle = requestAnimationFrame(loop);
}

function stopRaf(): void {
  if (rafHandle !== null) {
    cancelAnimationFrame(rafHandle);
    rafHandle = null;
  }
}

function pointFromEvent(e: PointerEvent): { cx: number; cy: number } {
  const rect = canvas.getBoundingClientRect();
  const sx = canvas.width / rect.width;
  const sy = canvas.height / rect.height;
  const x = (e.clientX - rect.left) * sx;
  const y = (e.clientY - rect.top) * sy;
  return { cx: Math.floor(x / CELL), cy: Math.floor(y / CELL) };
}

function onPointerDown(e: PointerEvent): void {
  e.preventDefault();
  if (state === 'ready' || state === 'gameover') {
    startRound();
    return;
  }
  if (state !== 'playing') return;
  painting = true;
  lastPaintCx = -1;
  lastPaintCy = -1;
  const { cx, cy } = pointFromEvent(e);
  pointerCx = cx;
  pointerCy = cy;
  paintAt(cx, cy);
  lastPaintCx = cx;
  lastPaintCy = cy;
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {
    // Some browsers reject if not allowed; safe to ignore.
  }
}

function onPointerMove(e: PointerEvent): void {
  if (state !== 'playing' || !painting) return;
  const { cx, cy } = pointFromEvent(e);
  pointerCx = cx;
  pointerCy = cy;
}

function onPointerUp(e: PointerEvent): void {
  painting = false;
  pointerCx = -1;
  pointerCy = -1;
  lastPaintCx = -1;
  lastPaintCy = -1;
  try {
    canvas.releasePointerCapture(e.pointerId);
  } catch {
    // Already released — fine.
  }
}

function onKey(e: KeyboardEvent): void {
  const k = e.key.toLowerCase();
  if (k === 'r') {
    reset();
    e.preventDefault();
    return;
  }
  if (state === 'ready' || state === 'gameover') {
    if (k === ' ' || k === 'enter') {
      startRound();
      e.preventDefault();
    }
  }
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  timerEl = document.querySelector<HTMLElement>('#timer')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  restartBtn.addEventListener('click', reset);
  overlayBtn.addEventListener('click', () => startRound());
  window.addEventListener('keydown', onKey);

  reset();
}

export const game = defineGame({ init, reset });
