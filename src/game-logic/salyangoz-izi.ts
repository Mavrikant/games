import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay, hideOverlay } from '@shared/overlay';

const STORAGE_BEST = 'salyangoz-izi.best';

const COLS = 14;
const ROWS = 10;
const CELL = 36;
const START_TIME_MS = 25_000;
const LEAF_BONUS_MS = 3_000;
const TRAIL_FADE_MS = 5_000;
const BASE_STEP_MS = 220;
const BOOST_STEP_MS = 110;
const LEAVES_ON_BOARD = 3;

type State = 'ready' | 'playing' | 'paused' | 'gameover';
type Dir = { x: number; y: number };
type Cell = { x: number; y: number };

const DIRS: Record<string, Dir> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

const gen = createGenToken();
let state: State = 'ready';
let score = 0;
let best = 0;

let snail: Cell = { x: 0, y: 0 };
let dir: Dir = DIRS.right!;
let pendingDir: Dir | null = null;
let trail: number[][] = []; // trail[y][x] = timestamp when slime was laid (0 = none)
let leaves: Cell[] = [];

let lastStepAt = 0;
let timeRemainingMs = START_TIME_MS;
let lastFrameAt = 0;
let boostedThisStep = false;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let timeEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlayEl!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayText!: HTMLElement;

function loadBest(): number {
  const v = safeRead<number>(STORAGE_BEST, 0);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

function commitBest(): void {
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
}

function freshTrail(): number[][] {
  return Array.from({ length: ROWS }, () => new Array<number>(COLS).fill(0));
}

function cellOccupiedBySnail(c: Cell): boolean {
  return c.x === snail.x && c.y === snail.y;
}

function spawnLeaf(): void {
  for (let attempt = 0; attempt < 100; attempt++) {
    const x = Math.floor(Math.random() * COLS);
    const y = Math.floor(Math.random() * ROWS);
    if (cellOccupiedBySnail({ x, y })) continue;
    if (leaves.some((l) => l.x === x && l.y === y)) continue;
    leaves.push({ x, y });
    return;
  }
}

function ensureLeaves(): void {
  while (leaves.length < LEAVES_ON_BOARD) spawnLeaf();
}

function setOverlay(title: string, text: string): void {
  overlayTitle.textContent = title;
  overlayText.textContent = text;
  showOverlay(overlayEl);
}

function syncHud(): void {
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
  timeEl.textContent = String(Math.max(0, Math.ceil(timeRemainingMs / 1000)));
}

function reset(): void {
  gen.bump();
  state = 'ready';
  score = 0;
  trail = freshTrail();
  snail = { x: Math.floor(COLS / 2), y: Math.floor(ROWS / 2) };
  dir = DIRS.right!;
  pendingDir = null;
  leaves = [];
  ensureLeaves();
  timeRemainingMs = START_TIME_MS;
  lastStepAt = 0;
  lastFrameAt = 0;
  boostedThisStep = false;
  setOverlay(
    'Salyangoz İzi',
    'Ok tuşları veya WASD ile yön ver. Taze izlerine değince hızlanırsın. Başlamak için bir yön tuşuna bas.',
  );
  syncHud();
  draw();
}

function startPlaying(): void {
  if (state === 'playing') return;
  hideOverlay(overlayEl);
  state = 'playing';
  lastStepAt = performance.now();
  lastFrameAt = lastStepAt;
}

function gameOver(): void {
  commitBest();
  state = 'gameover';
  setOverlay(
    'Süre bitti',
    `Skor: ${score} · Rekor: ${best}\nYeniden başlamak için R'ye bas veya düğmeye dokun.`,
  );
  syncHud();
}

function setPaused(paused: boolean): void {
  if (state !== 'playing' && state !== 'paused') return;
  if (paused && state === 'playing') {
    state = 'paused';
    setOverlay('Duraklatıldı', 'Devam etmek için Boşluk tuşuna bas.');
  } else if (!paused && state === 'paused') {
    hideOverlay(overlayEl);
    state = 'playing';
    const now = performance.now();
    lastStepAt = now;
    lastFrameAt = now;
  }
}

function wrap(value: number, max: number): number {
  return ((value % max) + max) % max;
}

function stepSnail(now: number): void {
  if (pendingDir) {
    dir = pendingDir;
    pendingDir = null;
  }
  // Drop slime at current cell before stepping out.
  trail[snail.y]![snail.x] = now;
  snail = {
    x: wrap(snail.x + dir.x, COLS),
    y: wrap(snail.y + dir.y, ROWS),
  };

  // Boost decision: stepping ONTO a fresh slime cell? next step is fast.
  const incomingAge = now - (trail[snail.y]![snail.x] ?? 0);
  boostedThisStep = trail[snail.y]![snail.x]! > 0 && incomingAge < TRAIL_FADE_MS;

  // Collect leaf if present.
  const idx = leaves.findIndex((l) => l.x === snail.x && l.y === snail.y);
  if (idx !== -1) {
    leaves.splice(idx, 1);
    score += 1;
    timeRemainingMs += LEAF_BONUS_MS;
    ensureLeaves();
  }
}

function loop(now: number): void {
  if (state !== 'playing') {
    requestAnimationFrame(loop);
    return;
  }

  const dt = Math.min(now - lastFrameAt, 200);
  lastFrameAt = now;
  timeRemainingMs -= dt;
  if (timeRemainingMs <= 0) {
    timeRemainingMs = 0;
    syncHud();
    draw();
    gameOver();
    requestAnimationFrame(loop);
    return;
  }

  const interval = boostedThisStep ? BOOST_STEP_MS : BASE_STEP_MS;
  if (now - lastStepAt >= interval) {
    lastStepAt = now;
    stepSnail(now);
  }

  syncHud();
  draw();
  requestAnimationFrame(loop);
}

function getCss(varName: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  return v || fallback;
}

function drawGrid(bg: string, line: string): void {
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = line;
  ctx.lineWidth = 1;
  for (let i = 1; i < COLS; i++) {
    const x = i * CELL + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, ROWS * CELL);
    ctx.stroke();
  }
  for (let j = 1; j < ROWS; j++) {
    const y = j * CELL + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(COLS * CELL, y);
    ctx.stroke();
  }
}

function drawTrail(now: number): void {
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const t = trail[y]![x]!;
      if (t === 0) continue;
      const age = now - t;
      if (age >= TRAIL_FADE_MS) {
        trail[y]![x] = 0;
        continue;
      }
      const k = 1 - age / TRAIL_FADE_MS;
      ctx.fillStyle = `rgba(180, 220, 255, ${(0.55 * k).toFixed(3)})`;
      ctx.fillRect(x * CELL + 4, y * CELL + 4, CELL - 8, CELL - 8);
      ctx.fillStyle = `rgba(225, 240, 255, ${(0.35 * k).toFixed(3)})`;
      ctx.fillRect(x * CELL + 10, y * CELL + 10, CELL - 20, CELL - 20);
    }
  }
}

function drawLeaf(cx: number, cy: number, accent: string): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.ellipse(0, 0, CELL * 0.32, CELL * 0.18, -Math.PI / 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(-CELL * 0.22, CELL * 0.22);
  ctx.lineTo(CELL * 0.22, -CELL * 0.22);
  ctx.stroke();
  ctx.restore();
}

function drawSnail(cx: number, cy: number, color: string): void {
  ctx.save();
  ctx.translate(cx, cy);
  // Shell
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(0, 0, CELL * 0.34, 0, Math.PI * 2);
  ctx.fill();
  // Spiral
  ctx.strokeStyle = 'rgba(0,0,0,0.45)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let a = 0; a < Math.PI * 3; a += 0.2) {
    const r = (CELL * 0.3 * a) / (Math.PI * 3);
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (a === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  // Antennae pointing forward
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  const fx = dir.x * CELL * 0.4;
  const fy = dir.y * CELL * 0.4;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(fx + dir.y * 4, fy - dir.x * 4);
  ctx.moveTo(0, 0);
  ctx.lineTo(fx - dir.y * 4, fy + dir.x * 4);
  ctx.stroke();
  ctx.restore();
}

function draw(): void {
  const now = performance.now();
  const bg = getCss('--surface', '#11151b');
  const line = getCss('--border', 'rgba(255,255,255,0.06)');
  const accent = getCss('--accent', '#7fe57c');
  const snailColor = getCss('--text', '#f5f3e6');
  drawGrid(bg, line);
  drawTrail(now);
  for (const l of leaves) {
    drawLeaf(l.x * CELL + CELL / 2, l.y * CELL + CELL / 2, accent);
  }
  drawSnail(snail.x * CELL + CELL / 2, snail.y * CELL + CELL / 2, snailColor);
}

function handleDirInput(next: Dir): void {
  if (state === 'gameover') return;
  if (state === 'ready') {
    dir = next;
    pendingDir = null;
    startPlaying();
    return;
  }
  if (state === 'paused') return;
  // Allow any direction (no anti-180 rule — body is transient trail, not solid).
  pendingDir = next;
}

function handleKey(e: KeyboardEvent): void {
  const k = e.key.toLowerCase();
  if (k === 'arrowup' || k === 'w') {
    handleDirInput(DIRS.up!);
    e.preventDefault();
    return;
  }
  if (k === 'arrowdown' || k === 's') {
    handleDirInput(DIRS.down!);
    e.preventDefault();
    return;
  }
  if (k === 'arrowleft' || k === 'a') {
    handleDirInput(DIRS.left!);
    e.preventDefault();
    return;
  }
  if (k === 'arrowright' || k === 'd') {
    handleDirInput(DIRS.right!);
    e.preventDefault();
    return;
  }
  if (k === ' ' || k === 'spacebar') {
    if (state === 'playing') setPaused(true);
    else if (state === 'paused') setPaused(false);
    e.preventDefault();
    return;
  }
  if (k === 'r') {
    reset();
    e.preventDefault();
  }
}

function handlePointer(e: PointerEvent): void {
  if (state === 'gameover') {
    reset();
    return;
  }
  if (state === 'ready' || state === 'paused') {
    // Tap from a direction hint: pick direction from the click position
    // relative to snail. Touch users without keyboard can still play.
    const rect = canvas.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * canvas.width;
    const py = ((e.clientY - rect.top) / rect.height) * canvas.height;
    const sx = snail.x * CELL + CELL / 2;
    const sy = snail.y * CELL + CELL / 2;
    const dx = px - sx;
    const dy = py - sy;
    if (Math.abs(dx) > Math.abs(dy)) {
      handleDirInput(dx >= 0 ? DIRS.right! : DIRS.left!);
    } else {
      handleDirInput(dy >= 0 ? DIRS.down! : DIRS.up!);
    }
    return;
  }
  // playing: same intent — choose direction from tap location vs snail.
  const rect = canvas.getBoundingClientRect();
  const px = ((e.clientX - rect.left) / rect.width) * canvas.width;
  const py = ((e.clientY - rect.top) / rect.height) * canvas.height;
  const sx = snail.x * CELL + CELL / 2;
  const sy = snail.y * CELL + CELL / 2;
  const dx = px - sx;
  const dy = py - sy;
  if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
  if (Math.abs(dx) > Math.abs(dy)) {
    handleDirInput(dx >= 0 ? DIRS.right! : DIRS.left!);
  } else {
    handleDirInput(dy >= 0 ? DIRS.down! : DIRS.up!);
  }
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  timeEl = document.querySelector<HTMLElement>('#time')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlayEl = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayText = document.querySelector<HTMLElement>('#overlay-text')!;

  best = loadBest();

  restartBtn.addEventListener('click', reset);
  window.addEventListener('keydown', handleKey);
  canvas.addEventListener('pointerdown', handlePointer);
  overlayEl.addEventListener('pointerdown', (e) => {
    // Overlay sits on top of the canvas, so it must own its own start/restart
    // input path — otherwise the ready/paused/gameover screens are unreachable
    // for touch users (PITFALLS#unreachable-start-state).
    if (state === 'gameover') {
      reset();
      e.preventDefault();
      return;
    }
    if (state === 'ready') {
      startPlaying();
      e.preventDefault();
      return;
    }
    if (state === 'paused') {
      setPaused(false);
      e.preventDefault();
    }
  });

  reset();
  requestAnimationFrame(loop);
}

export const game = defineGame({ init, reset });
