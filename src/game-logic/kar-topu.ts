// Kar Topu — a downhill snowball where size and agility are a tradeoff.
// Collected snow grows the ball; bigger ball turns slower and scores faster.
// The world auto-scrolls, the player only steers.

import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';

const STORAGE_BEST = 'kar-topu.best';

const WORLD_W = 480;
const WORLD_H = 640;
const BALL_Y = 500;
const BALL_R_MIN = 12;
const BALL_R_MAX = 52;
const BASE_SCROLL = 3.4;
const SIZE_SCROLL_BOOST = 1.6;
const BASE_TURN = 6.2;
const MIN_TURN = 1.7;
const TREE_TRUNK_R = 9;
const SNOW_R = 13;
const SPAWN_TREE_MIN = 22;
const SPAWN_TREE_MAX = 48;
const SPAWN_SNOW_MIN = 30;
const SPAWN_SNOW_MAX = 70;
const SNOW_GROWTH = 1.6;

type State = 'ready' | 'playing' | 'gameover';
type Tree = { x: number; y: number };
type Snow = { x: number; y: number; r: number };

const gen = createGenToken();

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let distEl!: HTMLElement;
let sizeEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayStart!: HTMLButtonElement;

let state: State = 'ready';
let ballX = WORLD_W / 2;
let ballR = BALL_R_MIN;
let trees: Tree[] = [];
let snows: Snow[] = [];
let scrollOffset = 0; // accumulated world scroll → distance scoring base
let distance = 0; // meters (scaled)
let best = 0;
let leftHeld = false;
let rightHeld = false;
let pointerActive = false;
let pointerTargetX = WORLD_W / 2;
let lastFrameMs = 0;
let nextTreeIn = 28;
let nextSnowIn = 50;
let rafHandle = 0;
let starsCache: Array<{ x: number; y: number; r: number }> = [];

function sizeFactor(): number {
  return (ballR - BALL_R_MIN) / (BALL_R_MAX - BALL_R_MIN);
}

function currentTurnSpeed(): number {
  const f = sizeFactor();
  return BASE_TURN + (MIN_TURN - BASE_TURN) * f;
}

function currentScrollSpeed(): number {
  return BASE_SCROLL + SIZE_SCROLL_BOOST * sizeFactor();
}

function loadBest(): number {
  const v = safeRead<number>(STORAGE_BEST, 0);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function commitBest(): void {
  if (distance > best) {
    best = Math.floor(distance);
    safeWrite(STORAGE_BEST, best);
  }
}

function buildStars(): void {
  // Static "snow flecks on the slope" — cosmetic, regenerated on reset.
  starsCache = [];
  for (let i = 0; i < 60; i++) {
    starsCache.push({
      x: Math.random() * WORLD_W,
      y: Math.random() * WORLD_H,
      r: 0.6 + Math.random() * 1.2,
    });
  }
}

function spawnTree(): void {
  // Avoid spawning on top of the ball's current X to keep things fair on
  // the first frame after the ball moves: just bias toward an even split.
  const x = 24 + Math.random() * (WORLD_W - 48);
  trees.push({ x, y: -20 });
}

function spawnSnow(): void {
  const x = 24 + Math.random() * (WORLD_W - 48);
  snows.push({ x, y: -20, r: SNOW_R });
}

function reset(): void {
  gen.bump();
  state = 'ready';
  ballX = WORLD_W / 2;
  ballR = BALL_R_MIN;
  trees = [];
  snows = [];
  scrollOffset = 0;
  distance = 0;
  leftHeld = false;
  rightHeld = false;
  pointerActive = false;
  pointerTargetX = WORLD_W / 2;
  nextTreeIn = 28;
  nextSnowIn = 50;
  buildStars();
  showReadyOverlay();
  renderHud();
  draw();
}

function showReadyOverlay(): void {
  overlayTitle.textContent = 'Kar Topu';
  overlayMsg.textContent =
    'Yokuştan aşağı dön. Karları topla, çamlardan kaç. Başlamak için tıkla veya bir ok tuşuna bas.';
  overlayStart.textContent = 'Başla';
  showOverlayEl(overlay);
}

function showGameOverOverlay(): void {
  const isBest = Math.floor(distance) >= best && distance > 0;
  overlayTitle.textContent = isBest ? 'Yeni rekor!' : 'Çam çarptı';
  overlayMsg.textContent = `${Math.floor(distance)} metre. Tekrar denemek için tıkla veya R'ye bas.`;
  overlayStart.textContent = 'Yeniden başla';
  showOverlayEl(overlay);
}

function startGame(): void {
  if (state === 'playing') return;
  gen.bump();
  state = 'playing';
  ballX = WORLD_W / 2;
  ballR = BALL_R_MIN;
  trees = [];
  snows = [];
  scrollOffset = 0;
  distance = 0;
  pointerTargetX = ballX;
  nextTreeIn = 28;
  nextSnowIn = 50;
  hideOverlayEl(overlay);
  lastFrameMs = 0;
  scheduleFrame();
  renderHud();
}

function endGame(): void {
  state = 'gameover';
  commitBest();
  cancelFrame();
  draw();
  renderHud();
  showGameOverOverlay();
}

function renderHud(): void {
  distEl.textContent = `${Math.floor(distance)} m`;
  const mult = ballR / BALL_R_MIN;
  sizeEl.textContent = `${mult.toFixed(1)}×`;
  bestEl.textContent = best > 0 ? `${best} m` : '—';
}

function scheduleFrame(): void {
  const myGen = gen.current();
  rafHandle = window.requestAnimationFrame((t) => {
    if (!gen.isCurrent(myGen)) return;
    if (state !== 'playing') return;
    tick(t);
    scheduleFrame();
  });
}

function cancelFrame(): void {
  if (rafHandle !== 0) {
    window.cancelAnimationFrame(rafHandle);
    rafHandle = 0;
  }
}

function tick(t: number): void {
  if (lastFrameMs === 0) {
    lastFrameMs = t;
    return;
  }
  const dtMs = Math.min(48, t - lastFrameMs);
  lastFrameMs = t;
  const dt = dtMs / (1000 / 60); // normalised "frames at 60fps"

  // --- Steering ---
  const turn = currentTurnSpeed();
  if (pointerActive) {
    const delta = pointerTargetX - ballX;
    const step = Math.sign(delta) * Math.min(Math.abs(delta), turn * dt);
    ballX += step;
  } else {
    if (leftHeld) ballX -= turn * dt;
    if (rightHeld) ballX += turn * dt;
  }
  ballX = Math.max(ballR, Math.min(WORLD_W - ballR, ballX));

  // --- Scroll & spawn ---
  const scroll = currentScrollSpeed() * dt;
  scrollOffset += scroll;
  // Score grows with size — that's the deal: bigger ball, more meters/sec.
  distance += (scroll / 6) * (1 + 0.9 * sizeFactor());

  nextTreeIn -= scroll;
  if (nextTreeIn <= 0) {
    spawnTree();
    nextTreeIn = SPAWN_TREE_MIN + Math.random() * (SPAWN_TREE_MAX - SPAWN_TREE_MIN);
  }
  nextSnowIn -= scroll;
  if (nextSnowIn <= 0) {
    spawnSnow();
    nextSnowIn = SPAWN_SNOW_MIN + Math.random() * (SPAWN_SNOW_MAX - SPAWN_SNOW_MIN);
  }

  for (const tr of trees) tr.y += scroll;
  for (const sn of snows) sn.y += scroll;

  // --- Collisions ---
  // Snow: collected and removed; ball grows. Check before trees so the same
  // frame can't both grow you and kill you in an ambiguous order.
  for (let i = snows.length - 1; i >= 0; i--) {
    const sn = snows[i]!;
    if (sn.y - sn.r > WORLD_H + 30) {
      snows.splice(i, 1);
      continue;
    }
    const dx = sn.x - ballX;
    const dy = sn.y - BALL_Y;
    if (Math.hypot(dx, dy) < sn.r + ballR) {
      snows.splice(i, 1);
      ballR = Math.min(BALL_R_MAX, ballR + SNOW_GROWTH);
    }
  }

  for (let i = trees.length - 1; i >= 0; i--) {
    const tr = trees[i]!;
    if (tr.y - 40 > WORLD_H + 30) {
      trees.splice(i, 1);
      continue;
    }
    const dx = tr.x - ballX;
    const dy = tr.y - BALL_Y;
    if (Math.hypot(dx, dy) < TREE_TRUNK_R + ballR) {
      draw();
      renderHud();
      endGame();
      return;
    }
  }

  draw();
  renderHud();
}

function draw(): void {
  // Background — soft snow gradient + diagonal motion lines.
  const g = ctx.createLinearGradient(0, 0, 0, WORLD_H);
  g.addColorStop(0, '#d5e8f7');
  g.addColorStop(1, '#9fc1e0');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, WORLD_W, WORLD_H);

  // Subtle flecks scrolling with the world for motion feedback.
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  for (const s of starsCache) {
    const y = (s.y + scrollOffset * 0.6) % WORLD_H;
    ctx.beginPath();
    ctx.arc(s.x, y, s.r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Snow tufts (still active).
  for (const sn of snows) {
    drawSnowTuft(sn.x, sn.y, sn.r);
  }

  // Trees.
  for (const tr of trees) {
    drawTree(tr.x, tr.y);
  }

  // Ball with shading + size ring (so the player can read radius easily).
  drawBall(ballX, BALL_Y, ballR);
}

function drawSnowTuft(x: number, y: number, r: number): void {
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.beginPath();
  ctx.arc(x - r * 0.4, y, r * 0.7, 0, Math.PI * 2);
  ctx.arc(x + r * 0.4, y, r * 0.7, 0, Math.PI * 2);
  ctx.arc(x, y - r * 0.3, r * 0.65, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(120,140,170,0.35)';
  ctx.lineWidth = 1;
  ctx.stroke();
}

function drawTree(x: number, y: number): void {
  // Trunk
  ctx.fillStyle = '#5a3a1c';
  ctx.fillRect(x - 4, y, 8, 14);
  // Foliage triangles (3 stacked, top smallest).
  const layers = [
    { h: 28, w: 30, dy: -2 },
    { h: 24, w: 24, dy: -22 },
    { h: 20, w: 18, dy: -38 },
  ];
  for (const layer of layers) {
    const grad = ctx.createLinearGradient(x, y + layer.dy - layer.h, x, y + layer.dy);
    grad.addColorStop(0, '#3a8a4b');
    grad.addColorStop(1, '#1c5a2a');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(x, y + layer.dy - layer.h);
    ctx.lineTo(x - layer.w, y + layer.dy);
    ctx.lineTo(x + layer.w, y + layer.dy);
    ctx.closePath();
    ctx.fill();
  }
  // Snowy cap.
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.beginPath();
  ctx.arc(x, y - 64, 4, 0, Math.PI * 2);
  ctx.fill();
}

function drawBall(x: number, y: number, r: number): void {
  // Shadow on slope.
  ctx.fillStyle = 'rgba(40,60,90,0.25)';
  ctx.beginPath();
  ctx.ellipse(x + r * 0.25, y + r * 0.9, r * 0.9, r * 0.32, 0, 0, Math.PI * 2);
  ctx.fill();

  // Ball body — radial gradient.
  const grad = ctx.createRadialGradient(x - r * 0.4, y - r * 0.5, r * 0.2, x, y, r);
  grad.addColorStop(0, '#ffffff');
  grad.addColorStop(0.7, '#e8eef5');
  grad.addColorStop(1, '#a9bdd2');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();

  // Outline so it doesn't disappear against snow background.
  ctx.strokeStyle = 'rgba(60,80,110,0.55)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Wobble lines to fake rolling motion.
  ctx.strokeStyle = 'rgba(60,80,110,0.25)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  const phase = (scrollOffset * 0.05) % (Math.PI * 2);
  ctx.arc(x, y, r * 0.65, phase, phase + Math.PI * 0.6);
  ctx.stroke();
}

function onKeyDown(e: KeyboardEvent): void {
  const k = e.key;
  if (k === 'r' || k === 'R') {
    reset();
    e.preventDefault();
    return;
  }
  if (state === 'ready' || state === 'gameover') {
    if (
      k === 'ArrowLeft' ||
      k === 'ArrowRight' ||
      k === 'ArrowUp' ||
      k === 'ArrowDown' ||
      k === 'a' ||
      k === 'A' ||
      k === 'd' ||
      k === 'D' ||
      k === ' ' ||
      k === 'Enter'
    ) {
      startGame();
      // Pre-apply the direction press so the very first frame already steers.
      if (k === 'ArrowLeft' || k === 'a' || k === 'A') leftHeld = true;
      if (k === 'ArrowRight' || k === 'd' || k === 'D') rightHeld = true;
      e.preventDefault();
      return;
    }
  }
  if (state !== 'playing') return;
  if (k === 'ArrowLeft' || k === 'a' || k === 'A') {
    leftHeld = true;
    e.preventDefault();
  } else if (k === 'ArrowRight' || k === 'd' || k === 'D') {
    rightHeld = true;
    e.preventDefault();
  }
}

function onKeyUp(e: KeyboardEvent): void {
  const k = e.key;
  if (k === 'ArrowLeft' || k === 'a' || k === 'A') leftHeld = false;
  if (k === 'ArrowRight' || k === 'd' || k === 'D') rightHeld = false;
}

function pointerToCanvasX(clientX: number): number {
  const rect = canvas.getBoundingClientRect();
  const scale = WORLD_W / rect.width;
  return (clientX - rect.left) * scale;
}

function onPointerDown(e: PointerEvent): void {
  if (state === 'ready' || state === 'gameover') {
    startGame();
  }
  if (state !== 'playing') return;
  pointerActive = true;
  pointerTargetX = pointerToCanvasX(e.clientX);
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {
    // Some browsers / non-mouse devices may refuse — non-fatal.
  }
  e.preventDefault();
}

function onPointerMove(e: PointerEvent): void {
  if (!pointerActive) return;
  pointerTargetX = pointerToCanvasX(e.clientX);
}

function onPointerUp(e: PointerEvent): void {
  pointerActive = false;
  try {
    canvas.releasePointerCapture(e.pointerId);
  } catch {
    // ignore
  }
}

function onOverlayClick(): void {
  if (state === 'ready' || state === 'gameover') {
    startGame();
  }
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  distEl = document.querySelector<HTMLElement>('#distance')!;
  sizeEl = document.querySelector<HTMLElement>('#size')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayStart = document.querySelector<HTMLButtonElement>('#overlay-start')!;

  best = loadBest();

  restartBtn.addEventListener('click', () => reset());
  overlayStart.addEventListener('click', onOverlayClick);

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);

  reset();
}

export const game = defineGame({ init, reset });
