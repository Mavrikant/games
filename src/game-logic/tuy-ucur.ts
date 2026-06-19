import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import {
  showOverlay as showOverlayEl,
  hideOverlay as hideOverlayEl,
} from '@shared/overlay';

const STORAGE_BEST = 'tuy-ucur.best';

const CANVAS_W = 360;
const CANVAS_H = 600;

const FEATHER_R = 7;
const FEATHER_START_X = CANVAS_W / 2;
const FEATHER_START_Y = 110;

const GRAVITY = 32;
const DRAG = 1.1;
const HORIZ_DAMPING = 1.6;
const ARROW_FORCE = 320;
const PUFF_FORCE = 460;
const PUFF_MAX_RADIUS = 110;
const PUFF_LIFE = 0.55;

const WALL_THICKNESS = 16;
const WALL_GAP_BASE = 110;
const WALL_GAP_MIN = 72;
const WALL_SPACING = 170;
const SCROLL_BASE = 70;
const SCROLL_RAMP = 28;
const SCROLL_MAX = 150;

const WIND_PEAK = 110;
const WIND_CHANGE = 35;

type State = 'ready' | 'playing' | 'gameover';

interface Wall {
  y: number;
  gapX: number;
  gapW: number;
  passed: boolean;
  hue: string;
}

interface Puff {
  x: number;
  y: number;
  age: number;
}

const gen = createGenToken();

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let windIndicator!: HTMLElement;

let state: State = 'ready';
let score = 0;
let best = 0;

let featherX = FEATHER_START_X;
let featherY = FEATHER_START_Y;
let featherVX = 0;
let featherVY = 0;
let featherTilt = 0;

let walls: Wall[] = [];
let puffs: Puff[] = [];
let nextWallTopY = 0;
let scrollSpeed = SCROLL_BASE;
let elapsed = 0;
let wind = 0;
let windTarget = 0;
let windTimer = 0;

const heldKeys = new Set<'left' | 'right'>();
let touchDir: -1 | 0 | 1 = 0;
let lastFrame = 0;
let rafId: number | null = null;

const cssCache = new Map<string, string>();
function getCss(varName: string): string {
  const cached = cssCache.get(varName);
  if (cached !== undefined) return cached;
  const val = getComputedStyle(document.documentElement)
    .getPropertyValue(varName)
    .trim();
  cssCache.set(varName, val);
  return val;
}

const HUES = ['--c-pink', '--c-purple', '--c-blue', '--c-cyan', '--c-green', '--c-yellow', '--c-orange'];

function pickHue(): string {
  return HUES[Math.floor(Math.random() * HUES.length)]!;
}

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlay);
}

function hideOverlay(): void {
  hideOverlayEl(overlay);
}

function spawnWall(y: number): Wall {
  const difficulty = Math.min(1, elapsed / 50);
  const gapW = WALL_GAP_BASE - (WALL_GAP_BASE - WALL_GAP_MIN) * difficulty;
  const margin = 28;
  const minX = margin;
  const maxX = CANVAS_W - margin - gapW;
  const gapX = minX + Math.random() * (maxX - minX);
  return { y, gapX, gapW, passed: false, hue: pickHue() };
}

function seedWalls(): void {
  walls = [];
  // First wall well below the feather so the player has time to react.
  let y = FEATHER_START_Y + 220;
  while (y < CANVAS_H + 200) {
    walls.push(spawnWall(y));
    y += WALL_SPACING;
  }
  nextWallTopY = walls[walls.length - 1]!.y + WALL_SPACING;
}

function commitBest(): void {
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
    bestEl.textContent = String(best);
  }
}

function reset(): void {
  gen.bump();
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  state = 'ready';
  score = 0;
  scoreEl.textContent = '0';
  bestEl.textContent = String(best);
  featherX = FEATHER_START_X;
  featherY = FEATHER_START_Y;
  featherVX = 0;
  featherVY = 0;
  featherTilt = 0;
  puffs = [];
  elapsed = 0;
  scrollSpeed = SCROLL_BASE;
  wind = 0;
  windTarget = 0;
  windTimer = 0;
  heldKeys.clear();
  touchDir = 0;
  seedWalls();
  updateWindUI();
  draw();
  showOverlay(
    'Tüy Uçur',
    'Tüye yakın tıkla — pufla onu duvardaki boşluğa yönlendir.\nKlavye: ← → veya A/D · Boşluk ile başla',
  );
}

function start(): void {
  if (state !== 'ready') return;
  state = 'playing';
  hideOverlay();
  lastFrame = performance.now();
  if (rafId === null) {
    rafId = requestAnimationFrame(loop);
  }
}

function gameOver(): void {
  state = 'gameover';
  commitBest();
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  draw();
  showOverlay('Düşürdün!', `Skor: ${score} duvar · R: yeniden başla`);
}

function applyPuff(px: number, py: number): void {
  puffs.push({ x: px, y: py, age: 0 });
  const dx = featherX - px;
  const dy = featherY - py;
  const dist = Math.hypot(dx, dy);
  if (dist < 0.5) {
    // Click directly under feather — give a clean upward push.
    featherVY -= PUFF_FORCE * 0.5;
    return;
  }
  const falloff = Math.max(0, 1 - dist / PUFF_MAX_RADIUS);
  if (falloff <= 0) return;
  const nx = dx / dist;
  const ny = dy / dist;
  featherVX += nx * PUFF_FORCE * falloff;
  featherVY += ny * PUFF_FORCE * falloff;
}

function step(dt: number): void {
  elapsed += dt;

  // Difficulty ramp.
  scrollSpeed = Math.min(SCROLL_MAX, SCROLL_BASE + (elapsed / 60) * SCROLL_RAMP);

  // Wind drift — slow random walk to a target value, then add to feather vx.
  windTimer -= dt;
  if (windTimer <= 0) {
    windTarget = (Math.random() * 2 - 1) * WIND_PEAK;
    windTimer = 1.4 + Math.random() * 1.6;
  }
  wind += (windTarget - wind) * Math.min(1, dt * 1.4);
  updateWindUI();

  // Arrow / touch input.
  let arrowDir = 0;
  if (heldKeys.has('left')) arrowDir -= 1;
  if (heldKeys.has('right')) arrowDir += 1;
  arrowDir += touchDir;
  featherVX += arrowDir * ARROW_FORCE * dt;

  // Physics.
  featherVX += wind * dt;
  featherVY += GRAVITY * dt;
  // Drag — quadratic-ish; just exponential decay is fine for this scale.
  featherVX *= Math.max(0, 1 - HORIZ_DAMPING * dt);
  featherVY *= Math.max(0, 1 - DRAG * dt);

  featherX += featherVX * dt;
  featherY += featherVY * dt;

  // Tilt visually follows horizontal velocity.
  const targetTilt = Math.max(-0.7, Math.min(0.7, featherVX / 220));
  featherTilt += (targetTilt - featherTilt) * Math.min(1, dt * 6);

  // Side walls bounce the feather softly back rather than killing it,
  // so getting blown by the wind isn't an instant loss.
  if (featherX < FEATHER_R + 2) {
    featherX = FEATHER_R + 2;
    featherVX = Math.abs(featherVX) * 0.3;
  } else if (featherX > CANVAS_W - FEATHER_R - 2) {
    featherX = CANVAS_W - FEATHER_R - 2;
    featherVX = -Math.abs(featherVX) * 0.3;
  }

  // Feather must stay below a soft ceiling and above a hard floor.
  if (featherY < FEATHER_R + 2) {
    featherY = FEATHER_R + 2;
    featherVY = Math.abs(featherVY) * 0.4;
  }
  if (featherY > CANVAS_H + FEATHER_R) {
    // Slipped off the bottom — game over.
    gameOver();
    return;
  }

  // Walls scroll up; feather y is independent (gravity vs. visual scroll
  // are separate so the player can recover vertical position).
  for (const w of walls) {
    w.y -= scrollSpeed * dt;
  }
  // Recycle and spawn.
  walls = walls.filter((w) => w.y + WALL_THICKNESS > -40);
  while (walls.length === 0 || walls[walls.length - 1]!.y < CANVAS_H + 40) {
    const lastY = walls.length > 0 ? walls[walls.length - 1]!.y : nextWallTopY;
    walls.push(spawnWall(lastY + WALL_SPACING));
  }

  // Collision + scoring.
  for (const w of walls) {
    const top = w.y;
    const bot = w.y + WALL_THICKNESS;
    const inBand = featherY + FEATHER_R > top && featherY - FEATHER_R < bot;
    const inGap = featherX - FEATHER_R > w.gapX && featherX + FEATHER_R < w.gapX + w.gapW;
    if (inBand && !inGap) {
      gameOver();
      return;
    }
    if (!w.passed && featherY - FEATHER_R > bot) {
      w.passed = true;
      score++;
      scoreEl.textContent = String(score);
    }
  }

  // Puff lifecycle.
  for (const p of puffs) p.age += dt;
  puffs = puffs.filter((p) => p.age < PUFF_LIFE);
}

function updateWindUI(): void {
  const norm = Math.max(-1, Math.min(1, wind / WIND_PEAK));
  // Center origin (50%), translate from -50% (left max) to +50% (right max).
  const pct = norm * 50;
  windIndicator.style.transform = `translateX(${pct}%)`;
}

function draw(): void {
  ctx.fillStyle = getCss('--surface');
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  // Soft side gradient hint of vertical motion.
  drawScrollLines();

  // Walls.
  for (const w of walls) {
    drawWall(w);
  }

  // Puffs (drawn below feather for cleanest read).
  for (const p of puffs) drawPuff(p);

  drawFeather();

  // Subtle ground line at the bottom — visual signal of the kill floor.
  ctx.fillStyle = getCss('--border');
  ctx.fillRect(0, CANVAS_H - 2, CANVAS_W, 2);
}

function drawScrollLines(): void {
  // Animated dashed columns at the edges to suggest descent without
  // overwhelming the feather. Phase ties to elapsed * scrollSpeed.
  ctx.fillStyle = getCss('--surface-2');
  const phase = (elapsed * scrollSpeed) % 24;
  for (let y = -24 + phase; y < CANVAS_H; y += 24) {
    ctx.fillRect(6, y, 4, 10);
    ctx.fillRect(CANVAS_W - 10, y, 4, 10);
  }
}

function drawWall(w: Wall): void {
  const accent = getCss(w.hue);
  ctx.fillStyle = getCss('--surface-3');
  // Left part.
  ctx.fillRect(0, w.y, w.gapX, WALL_THICKNESS);
  // Right part.
  ctx.fillRect(w.gapX + w.gapW, w.y, CANVAS_W - (w.gapX + w.gapW), WALL_THICKNESS);
  // Colored top stripe.
  ctx.fillStyle = accent;
  ctx.fillRect(0, w.y, w.gapX, 3);
  ctx.fillRect(w.gapX + w.gapW, w.y, CANVAS_W - (w.gapX + w.gapW), 3);
  // Gap markers — two small posts to make the opening pop.
  ctx.fillStyle = accent;
  ctx.fillRect(w.gapX - 2, w.y - 4, 2, WALL_THICKNESS + 8);
  ctx.fillRect(w.gapX + w.gapW, w.y - 4, 2, WALL_THICKNESS + 8);
}

function drawPuff(p: Puff): void {
  const t = p.age / PUFF_LIFE;
  const r = 6 + t * PUFF_MAX_RADIUS;
  const alpha = (1 - t) * 0.55;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = getCss('--accent-2');
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = alpha * 0.6;
  ctx.fillStyle = getCss('--accent-2');
  ctx.beginPath();
  ctx.arc(p.x, p.y, Math.max(2, 6 - t * 6), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawFeather(): void {
  ctx.save();
  ctx.translate(featherX, featherY);
  ctx.rotate(featherTilt);

  // Quill (stem) — thin line.
  ctx.strokeStyle = getCss('--text-dim');
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, FEATHER_R + 4);
  ctx.lineTo(0, -FEATHER_R - 12);
  ctx.stroke();

  // Plume — soft tear-drop.
  const grad = ctx.createLinearGradient(0, -FEATHER_R - 12, 0, FEATHER_R + 6);
  grad.addColorStop(0, getCss('--c-cyan'));
  grad.addColorStop(0.55, getCss('--accent'));
  grad.addColorStop(1, getCss('--accent-strong'));
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(0, -FEATHER_R - 10);
  ctx.bezierCurveTo(-FEATHER_R - 4, -FEATHER_R, -FEATHER_R - 2, FEATHER_R + 2, 0, FEATHER_R + 4);
  ctx.bezierCurveTo(FEATHER_R + 2, FEATHER_R + 2, FEATHER_R + 4, -FEATHER_R, 0, -FEATHER_R - 10);
  ctx.fill();

  // Spine highlight.
  ctx.strokeStyle = 'rgba(255,255,255,0.4)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, -FEATHER_R - 8);
  ctx.lineTo(0, FEATHER_R + 2);
  ctx.stroke();

  ctx.restore();
}

function loop(now: number): void {
  rafId = null;
  if (state !== 'playing') return;
  const dt = Math.min(0.045, (now - lastFrame) / 1000);
  lastFrame = now;
  step(dt);
  draw();
  if (state === 'playing') {
    rafId = requestAnimationFrame(loop);
  }
}

function canvasPoint(e: MouseEvent | Touch): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const sx = CANVAS_W / rect.width;
  const sy = CANVAS_H / rect.height;
  return {
    x: (e.clientX - rect.left) * sx,
    y: (e.clientY - rect.top) * sy,
  };
}

function onCanvasPointer(e: PointerEvent): void {
  // Overlay swallows pointer events itself (it's an overlay over the
  // canvas in the same wrap) — but make sure we ignore non-playing.
  if (state === 'gameover') return;
  if (state === 'ready') start();
  const { x, y } = canvasPoint(e);
  applyPuff(x, y);
  e.preventDefault();
}

function onKeyDown(e: KeyboardEvent): void {
  const k = e.key.toLowerCase();
  if (k === 'arrowleft' || k === 'a') {
    heldKeys.add('left');
    if (state === 'ready') start();
    e.preventDefault();
  } else if (k === 'arrowright' || k === 'd') {
    heldKeys.add('right');
    if (state === 'ready') start();
    e.preventDefault();
  } else if (k === ' ' || k === 'spacebar') {
    if (state === 'ready') start();
    else if (state === 'gameover') reset();
    e.preventDefault();
  } else if (k === 'r') {
    reset();
    e.preventDefault();
  }
}

function onKeyUp(e: KeyboardEvent): void {
  const k = e.key.toLowerCase();
  if (k === 'arrowleft' || k === 'a') heldKeys.delete('left');
  else if (k === 'arrowright' || k === 'd') heldKeys.delete('right');
}

function bindTouchBtn(btn: HTMLButtonElement, dir: -1 | 1): void {
  const press = (e: Event): void => {
    e.preventDefault();
    touchDir = dir;
    if (state === 'ready') start();
  };
  const release = (): void => {
    if (touchDir === dir) touchDir = 0;
  };
  btn.addEventListener('pointerdown', press);
  btn.addEventListener('pointerup', release);
  btn.addEventListener('pointerleave', release);
  btn.addEventListener('pointercancel', release);
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  windIndicator = document.querySelector<HTMLElement>('#wind-indicator')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  canvas.addEventListener('pointerdown', onCanvasPointer);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', () => {
    heldKeys.clear();
    touchDir = 0;
  });

  restartBtn.addEventListener('click', () => reset());

  overlay.addEventListener('pointerdown', (e) => {
    if (state === 'ready') start();
    else if (state === 'gameover') reset();
    e.preventDefault();
  });

  document.querySelectorAll<HTMLButtonElement>('.touch__btn').forEach((btn) => {
    const dir = btn.dataset.dir === 'left' ? -1 : 1;
    bindTouchBtn(btn, dir);
  });

  reset();
}

export const game = defineGame({ init, reset });
