import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import {
  showOverlay as showOverlayEl,
  hideOverlay as hideOverlayEl,
} from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';

const STORAGE_BEST = 'supur.best';

const W = 640;
const H = 280;

const START_X = 60;
const STONE_R = 14;
const HOUSE_X = 540;
const HOUSE_Y = H / 2;
const RINGS: ReadonlyArray<{ r: number; pts: number; fill: string }> = [
  { r: 78, pts: 1, fill: '--supur-ring-1' },
  { r: 56, pts: 2, fill: '--supur-ring-2' },
  { r: 34, pts: 3, fill: '--supur-ring-3' },
  { r: 14, pts: 5, fill: '--supur-ring-4' },
];

const TOTAL_SHOTS = 6;

// Friction coefficient (px/s^2 deceleration applied to horizontal velocity).
const FRICTION_NORMAL = 95;
const FRICTION_SWEEP = 32;
// Drift damping per frame when sweeping (multiplier).
const DRIFT_DAMP_SWEEP = 0.93;

type State = 'ready' | 'sliding' | 'between' | 'gameover';

const gen = createGenToken();

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let shotEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;

let state: State = 'ready';
let score = 0;
let best = 0;
let shotIndex = 0;
let sweeping = false;
let lastShotPts = 0;

let stone = {
  x: START_X,
  y: HOUSE_Y,
  vx: 0,
  vy: 0,
};
const placed: Array<{ x: number; y: number; pts: number }> = [];

let lastT = 0;
let rafHandle = 0;
let currentGen = 0;

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlay);
}

function hideOverlay(): void {
  hideOverlayEl(overlay);
}

const cssCache = new Map<string, string>();
function getCss(name: string): string {
  let v = cssCache.get(name);
  if (v !== undefined) return v;
  v =
    getComputedStyle(document.documentElement)
      .getPropertyValue(name)
      .trim() || '#888';
  cssCache.set(name, v);
  return v;
}

function setHud(): void {
  scoreEl.textContent = String(score);
  shotEl.textContent = `${Math.min(shotIndex + 1, TOTAL_SHOTS)}/${TOTAL_SHOTS}`;
  bestEl.textContent = String(best);
}

function newStone(): void {
  // Speed and drift scale slightly with shot index for ramp.
  const ramp = shotIndex / (TOTAL_SHOTS - 1); // 0..1
  // Horizontal velocity randomized — needs sweeping at right times to land in house.
  const baseV = 245 + Math.random() * 55; // 245..300
  // Without sweeping (friction 95) a stone travels ~baseV^2/(2*95) = ~315..474 px
  // House center is at x=540 - START_X=60 → 480 px. So baseline lands near or just short of house.
  // With sweep the player can extend reach by ~30-40%.
  const drift = (Math.random() * 2 - 1) * (30 + 40 * ramp); // ±30..±70
  stone = {
    x: START_X,
    y: HOUSE_Y,
    vx: baseV,
    vy: drift,
  };
}

function scoreFor(x: number, y: number): number {
  const dx = x - HOUSE_X;
  const dy = y - HOUSE_Y;
  const d = Math.hypot(dx, dy);
  // RINGS sorted outer→inner. Walk inner→outer to award largest pts first.
  for (let i = RINGS.length - 1; i >= 0; i--) {
    const ring = RINGS[i]!;
    if (d <= ring.r + STONE_R * 0.4) return ring.pts;
  }
  return 0;
}

function step(dt: number): void {
  // Friction opposes horizontal velocity.
  const fric = sweeping ? FRICTION_SWEEP : FRICTION_NORMAL;
  const sign = Math.sign(stone.vx);
  const decel = fric * dt;
  if (Math.abs(stone.vx) <= decel) stone.vx = 0;
  else stone.vx -= sign * decel;

  // Sweeping also tames lateral drift slightly per frame.
  if (sweeping) {
    // Per-frame damp scaled to a 60fps reference so it's frame-rate independent.
    const k = Math.pow(DRIFT_DAMP_SWEEP, dt * 60);
    stone.vy *= k;
  }

  stone.x += stone.vx * dt;
  stone.y += stone.vy * dt;

  // Bounce off top/bottom walls of the lane.
  const top = 20;
  const bottom = H - 20;
  if (stone.y - STONE_R < top) {
    stone.y = top + STONE_R;
    stone.vy = Math.abs(stone.vy) * 0.6;
  }
  if (stone.y + STONE_R > bottom) {
    stone.y = bottom - STONE_R;
    stone.vy = -Math.abs(stone.vy) * 0.6;
  }

  // Out the back end of the rink: end shot with 0 points.
  if (stone.x - STONE_R > W + 10) {
    endShot(0, true);
    return;
  }

  // Stopped: end shot, score by position.
  if (stone.vx === 0) {
    const pts = scoreFor(stone.x, stone.y);
    endShot(pts, false);
  }
}

function endShot(pts: number, off: boolean): void {
  if (state !== 'sliding') return;
  state = 'between';
  lastShotPts = pts;
  score += pts;
  if (!off && pts > 0) {
    placed.push({ x: stone.x, y: stone.y, pts });
  }
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
  setHud();
  draw();
  shotIndex++;

  if (shotIndex >= TOTAL_SHOTS) {
    // Brief pause then game over.
    const myGen = currentGen;
    window.setTimeout(() => {
      if (myGen !== currentGen) return;
      state = 'gameover';
      showOverlay(
        'Bitti!',
        `Toplam ${score} puan · Rekor: ${best}\nBoşluk veya R ile tekrar oyna.`,
      );
    }, 900);
    return;
  }

  // Short pause showing where this shot landed, then next.
  const msg = off
    ? `Pistten geçti · 0 puan`
    : pts === 0
      ? `Hedef dışı · 0 puan`
      : `+${pts} puan`;
  showOverlay(`Atış ${shotIndex} bitti`, `${msg}\nBoşluk: sıradaki atış`);
  setHud();
}

function loop(timestamp: number, myGen: number): void {
  if (myGen !== currentGen) return;
  if (state !== 'sliding') return;

  const dt = Math.min(0.05, (timestamp - lastT) / 1000);
  lastT = timestamp;
  step(dt);
  draw();

  if (state === 'sliding') {
    rafHandle = requestAnimationFrame((t) => loop(t, myGen));
  }
}

function startShot(): void {
  if (state === 'gameover') return;
  if (shotIndex >= TOTAL_SHOTS) return;
  hideOverlay();
  newStone();
  state = 'sliding';
  lastT = performance.now();
  setHud();
  const myGen = currentGen;
  rafHandle = requestAnimationFrame((t) => loop(t, myGen));
}

function draw(): void {
  // Ice background.
  ctx.fillStyle = getCss('--supur-ice');
  ctx.fillRect(0, 0, W, H);

  // Lane edge stripes (top/bottom guards).
  ctx.fillStyle = getCss('--supur-edge');
  ctx.fillRect(0, 0, W, 20);
  ctx.fillRect(0, H - 20, W, 20);

  // Center line.
  ctx.strokeStyle = getCss('--supur-line');
  ctx.lineWidth = 1;
  ctx.setLineDash([6, 6]);
  ctx.beginPath();
  ctx.moveTo(0, HOUSE_Y);
  ctx.lineTo(W, HOUSE_Y);
  ctx.stroke();
  ctx.setLineDash([]);

  // House rings outer → inner.
  for (const ring of RINGS) {
    ctx.fillStyle = getCss(ring.fill);
    ctx.beginPath();
    ctx.arc(HOUSE_X, HOUSE_Y, ring.r, 0, Math.PI * 2);
    ctx.fill();
  }
  // Tee mark (cross).
  ctx.strokeStyle = getCss('--supur-line');
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(HOUSE_X - 6, HOUSE_Y);
  ctx.lineTo(HOUSE_X + 6, HOUSE_Y);
  ctx.moveTo(HOUSE_X, HOUSE_Y - 6);
  ctx.lineTo(HOUSE_X, HOUSE_Y + 6);
  ctx.stroke();

  // Hog line (where stones can be released).
  ctx.strokeStyle = getCss('--supur-line');
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(140, 24);
  ctx.lineTo(140, H - 24);
  ctx.stroke();
  ctx.setLineDash([]);

  // Already placed stones from previous shots.
  for (const p of placed) {
    drawStone(p.x, p.y, false);
  }

  // Active stone (only during sliding or between).
  if (state === 'sliding' || state === 'between') {
    drawStone(stone.x, stone.y, true);
    if (state === 'sliding' && sweeping) {
      drawBroom();
    }
  }

  // Last-shot score popup.
  if (state === 'between' && lastShotPts > 0) {
    ctx.fillStyle = getCss('--text');
    ctx.font = 'bold 16px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`+${lastShotPts}`, stone.x, stone.y - 22);
    ctx.textAlign = 'start';
  }
}

function drawStone(x: number, y: number, active: boolean): void {
  // Body.
  ctx.fillStyle = getCss('--supur-stone');
  ctx.beginPath();
  ctx.arc(x, y, STONE_R, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = getCss('--supur-stone-rim');
  ctx.lineWidth = 2;
  ctx.stroke();
  // Handle on top.
  ctx.fillStyle = active
    ? getCss('--supur-handle-active')
    : getCss('--supur-handle');
  ctx.fillRect(x - 5, y - STONE_R - 2, 10, 6);
  ctx.beginPath();
  ctx.arc(x, y - STONE_R + 1, 4, 0, Math.PI * 2);
  ctx.fill();
}

function drawBroom(): void {
  // Brush bristles ahead of the stone in the direction of motion.
  const dirX = Math.sign(stone.vx) || 1;
  const bx = stone.x + dirX * (STONE_R + 14);
  const by = stone.y;
  // Animated jitter for sweep effect.
  const t = performance.now() / 80;
  const jx = Math.sin(t) * 2;

  ctx.fillStyle = getCss('--supur-broom');
  ctx.beginPath();
  ctx.ellipse(bx + jx, by, 12, 8, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = getCss('--supur-broom-rim');
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Ice shavings.
  ctx.fillStyle = getCss('--supur-shaving');
  for (let i = 0; i < 4; i++) {
    const angle = Math.random() * Math.PI * 2;
    const r = 3 + Math.random() * 6;
    ctx.beginPath();
    ctx.arc(bx + Math.cos(angle) * r, by + Math.sin(angle) * r, 1.2, 0, Math.PI * 2);
    ctx.fill();
  }
}

function reset(): void {
  gen.bump();
  currentGen = gen.current();
  if (rafHandle) cancelAnimationFrame(rafHandle);
  rafHandle = 0;
  state = 'ready';
  score = 0;
  shotIndex = 0;
  lastShotPts = 0;
  sweeping = false;
  placed.length = 0;
  stone = { x: START_X, y: HOUSE_Y, vx: 0, vy: 0 };
  setHud();
  draw();
  showOverlay(
    'Süpür',
    `${TOTAL_SHOTS} taşı süpürerek tam hedefe yerleştir.\nBOŞLUK ile başla, tıkla&tut ile süpür.`,
  );
}

function setSweeping(on: boolean): void {
  if (state !== 'sliding') {
    sweeping = false;
    return;
  }
  sweeping = on;
}

function onKey(e: KeyboardEvent): void {
  const k = e.key.toLowerCase();
  if (k === 'r') {
    reset();
    e.preventDefault();
    return;
  }
  if (k === ' ') {
    e.preventDefault();
    if (state === 'ready' || state === 'between') {
      startShot();
      return;
    }
    if (state === 'sliding') {
      setSweeping(true);
      return;
    }
    if (state === 'gameover') {
      reset();
      return;
    }
  }
}

function onKeyUp(e: KeyboardEvent): void {
  if (e.key === ' ') {
    setSweeping(false);
  }
}

function onPointerDown(e: PointerEvent): void {
  e.preventDefault();
  if (state === 'ready' || state === 'between') {
    startShot();
    return;
  }
  if (state === 'sliding') {
    setSweeping(true);
    return;
  }
  if (state === 'gameover') {
    reset();
  }
}

function onPointerUp(): void {
  setSweeping(false);
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  shotEl = document.querySelector<HTMLElement>('#shot')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;

  best = safeRead<number>(STORAGE_BEST, 0);
  currentGen = gen.current();

  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKeyUp);
  canvas.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  // Touch leaving the canvas should also stop sweeping.
  canvas.addEventListener('pointerleave', onPointerUp);

  restartBtn.addEventListener('click', () => {
    reset();
  });

  reset();
}

export const game = defineGame({ init, reset });
