import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import {
  showOverlay as showOverlayEl,
  hideOverlay as hideOverlayEl,
} from '@shared/overlay';

type State = 'ready' | 'playing' | 'gameover';
type AimPhase = 'idle' | 'aiming';
type BalloonKind = 'white' | 'gold' | 'bomb';

const STORAGE_BEST = 'sapan.best';

const W = 480;
const H = 540;
const ORIGIN_X = 90;
const ORIGIN_Y = 380;
const REST_Y = ORIGIN_Y - 8;
const PULL_MAX = 80;
const PULL_MIN_FIRE = 14;
const POWER = 6;
const GRAVITY = 700;
const PROJECTILE_R = 6;

const ROUND_MS = 60_000;
const WIND_PERIOD_MS = 7_000;
const WIND_MAX = 170;

const SPAWN_PERIOD_MS = 1100;
const MAX_BALLOONS = 7;
const GROUND_Y = H - 90;

interface Projectile {
  x: number;
  y: number;
  vx: number;
  vy: number;
  alive: boolean;
  trail: { x: number; y: number }[];
}

interface Balloon {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  kind: BalloonKind;
  alive: boolean;
  swayPhase: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  color: string;
}

const gen = createGenToken();

let state: State = 'ready';
let aimPhase: AimPhase = 'idle';
let pullX = 0;
let pullY = 0;

let projectiles: Projectile[] = [];
let balloons: Balloon[] = [];
let particles: Particle[] = [];

let wind = 0;
let windTarget = 0;
let windSinceShiftMs = 0;

let elapsedMs = 0;
let spawnCounterMs = 0;
let score = 0;
let best = 0;
let activePointerId: number | null = null;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let timeEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;

let animHandle: number | null = null;
let lastFrame = 0;

// --- helpers ---

function canvasPoint(e: PointerEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const sx = canvas.width / rect.width;
  const sy = canvas.height / rect.height;
  return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy };
}

function clampPull(dx: number, dy: number): [number, number] {
  const len = Math.hypot(dx, dy);
  if (len <= PULL_MAX) return [dx, dy];
  const k = PULL_MAX / len;
  return [dx * k, dy * k];
}

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlay);
}

function hideOverlay(): void {
  hideOverlayEl(overlay);
}

function commitBest(): void {
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
}

function updateHUD(): void {
  scoreEl.textContent = String(score);
  const tLeft = Math.max(0, (ROUND_MS - elapsedMs) / 1000);
  timeEl.textContent = tLeft.toFixed(1);
  bestEl.textContent = best > 0 ? String(best) : '—';
}

// --- lifecycle ---

function reset(): void {
  gen.bump();
  state = 'ready';
  aimPhase = 'idle';
  pullX = 0;
  pullY = 0;
  projectiles = [];
  balloons = [];
  particles = [];
  wind = 0;
  windTarget = 0;
  windSinceShiftMs = 0;
  elapsedMs = 0;
  spawnCounterMs = 0;
  score = 0;
  activePointerId = null;
  stopLoop();
  updateHUD();
  draw();
  showOverlay(
    'Sapan',
    'Sapan çatalına bas, geri-aşağı çek ve bırak.\nBeyaz balon +1, altın +5, bomba −3.\nBaşlamak için tıkla veya Space.',
  );
}

function startPlaying(): void {
  if (state !== 'ready') return;
  state = 'playing';
  hideOverlay();
  windTarget = (Math.random() * 2 - 1) * WIND_MAX * 0.6;
  spawnBalloon();
  startLoop();
}

function endGame(): void {
  state = 'gameover';
  stopLoop();
  commitBest();
  updateHUD();
  draw();
  showOverlay(
    'Süre doldu',
    `Skor: ${score}\nEn iyi: ${best}\nTekrar için tıkla, Space ya da R.`,
  );
}

function startLoop(): void {
  if (animHandle !== null) return;
  lastFrame = performance.now();
  const myGen = gen.current();
  const loop = (now: number): void => {
    if (!gen.isCurrent(myGen)) {
      animHandle = null;
      return;
    }
    const dt = Math.min(50, now - lastFrame);
    lastFrame = now;
    tick(dt);
    animHandle = requestAnimationFrame(loop);
  };
  animHandle = requestAnimationFrame(loop);
}

function stopLoop(): void {
  if (animHandle !== null) {
    cancelAnimationFrame(animHandle);
    animHandle = null;
  }
}

// --- world ---

function spawnBalloon(): void {
  const roll = Math.random();
  let kind: BalloonKind;
  if (roll < 0.16) kind = 'bomb';
  else if (roll < 0.29) kind = 'gold';
  else kind = 'white';

  const r = kind === 'gold' ? 17 : kind === 'bomb' ? 16 : 22;
  const x = 80 + Math.random() * (W - 140);
  const y = H + r + 8;
  const vy = -(40 + Math.random() * 55);
  const vx = (Math.random() * 2 - 1) * 10;
  balloons.push({
    x,
    y,
    vx,
    vy,
    r,
    kind,
    alive: true,
    swayPhase: Math.random() * Math.PI * 2,
  });
}

function onHit(b: Balloon): void {
  let color: string;
  if (b.kind === 'white') {
    score += 1;
    color = '#e5e7eb';
  } else if (b.kind === 'gold') {
    score += 5;
    color = '#fbbf24';
  } else {
    score -= 3;
    color = '#ef4444';
  }
  for (let i = 0; i < 14; i++) {
    const ang = Math.random() * Math.PI * 2;
    const sp = 70 + Math.random() * 140;
    particles.push({
      x: b.x,
      y: b.y,
      vx: Math.cos(ang) * sp,
      vy: Math.sin(ang) * sp,
      life: 1,
      color,
    });
  }
}

function tick(dt: number): void {
  if (state !== 'playing') return;
  elapsedMs += dt;

  // wind shift
  windSinceShiftMs += dt;
  if (windSinceShiftMs >= WIND_PERIOD_MS) {
    windSinceShiftMs = 0;
    windTarget = (Math.random() * 2 - 1) * WIND_MAX;
  }
  wind += (windTarget - wind) * Math.min(1, dt / 600);

  // spawning
  spawnCounterMs += dt;
  const liveCount = balloons.reduce((n, b) => (b.alive ? n + 1 : n), 0);
  if (spawnCounterMs >= SPAWN_PERIOD_MS && liveCount < MAX_BALLOONS) {
    spawnCounterMs = 0;
    spawnBalloon();
  }

  const s = dt / 1000;

  // balloons
  for (const b of balloons) {
    if (!b.alive) continue;
    b.swayPhase += s * 2.2;
    b.x += b.vx * s + Math.sin(b.swayPhase) * 18 * s;
    b.y += b.vy * s;
    if (b.y + b.r * 1.2 < 0) b.alive = false;
    if (b.x < -40 || b.x > W + 40) b.alive = false;
  }

  // projectiles
  for (const p of projectiles) {
    if (!p.alive) continue;
    p.vy += GRAVITY * s;
    p.vx += wind * s;
    p.x += p.vx * s;
    p.y += p.vy * s;
    p.trail.push({ x: p.x, y: p.y });
    if (p.trail.length > 14) p.trail.shift();
    if (p.y > H + 50 || p.x < -50 || p.x > W + 50) p.alive = false;
    if (p.y > GROUND_Y - 1 && p.vy > 0) p.alive = false;
  }

  // collisions
  for (const p of projectiles) {
    if (!p.alive) continue;
    for (const b of balloons) {
      if (!b.alive) continue;
      const dx = p.x - b.x;
      const dy = p.y - b.y;
      if (dx * dx + dy * dy < (b.r + PROJECTILE_R) * (b.r + PROJECTILE_R)) {
        b.alive = false;
        p.alive = false;
        onHit(b);
        break;
      }
    }
  }

  // cleanup
  balloons = balloons.filter((b) => b.alive);
  projectiles = projectiles.filter((p) => p.alive);

  // particles
  for (const part of particles) {
    part.x += part.vx * s;
    part.y += part.vy * s;
    part.vy += 220 * s;
    part.life -= s / 0.6;
  }
  particles = particles.filter((p) => p.life > 0);

  if (elapsedMs >= ROUND_MS) {
    endGame();
    return;
  }

  updateHUD();
  draw();
}

// --- input ---

function onPointerDown(e: PointerEvent): void {
  if (state === 'ready') {
    startPlaying();
    return;
  }
  if (state === 'gameover') {
    reset();
    return;
  }
  if (state !== 'playing') return;
  if (activePointerId !== null) return;
  activePointerId = e.pointerId;
  const p = canvasPoint(e);
  const [px, py] = clampPull(p.x - ORIGIN_X, p.y - REST_Y);
  pullX = px;
  pullY = py;
  aimPhase = 'aiming';
  e.preventDefault();
  if (typeof canvas.setPointerCapture === 'function') {
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }
}

function onPointerMove(e: PointerEvent): void {
  if (state !== 'playing') return;
  if (aimPhase !== 'aiming') return;
  if (activePointerId !== null && e.pointerId !== activePointerId) return;
  const p = canvasPoint(e);
  const [px, py] = clampPull(p.x - ORIGIN_X, p.y - REST_Y);
  pullX = px;
  pullY = py;
  e.preventDefault();
}

function onPointerUp(e: PointerEvent): void {
  if (aimPhase !== 'aiming') return;
  if (activePointerId !== null && e.pointerId !== activePointerId) return;
  const len = Math.hypot(pullX, pullY);
  if (state === 'playing' && len >= PULL_MIN_FIRE) {
    projectiles.push({
      x: ORIGIN_X,
      y: REST_Y,
      vx: -pullX * POWER,
      vy: -pullY * POWER,
      alive: true,
      trail: [],
    });
  }
  pullX = 0;
  pullY = 0;
  aimPhase = 'idle';
  activePointerId = null;
}

function onPointerCancel(): void {
  pullX = 0;
  pullY = 0;
  aimPhase = 'idle';
  activePointerId = null;
}

function onKey(e: KeyboardEvent): void {
  const k = e.key.toLowerCase();
  if (k === 'r') {
    reset();
    e.preventDefault();
    return;
  }
  if (k === ' ' || k === 'enter') {
    if (state === 'ready') {
      startPlaying();
      e.preventDefault();
    } else if (state === 'gameover') {
      reset();
      startPlaying();
      e.preventDefault();
    }
  }
}

// --- rendering ---

const cssCache = new Map<string, string>();
function getCss(name: string, fallback: string): string {
  const cached = cssCache.get(name);
  if (cached !== undefined && cached !== '') return cached;
  const v =
    getComputedStyle(document.documentElement).getPropertyValue(name).trim() ||
    fallback;
  cssCache.set(name, v);
  return v;
}

function draw(): void {
  // sky gradient
  const grd = ctx.createLinearGradient(0, 0, 0, H);
  grd.addColorStop(0, '#0c1726');
  grd.addColorStop(0.6, '#1a2940');
  grd.addColorStop(1, '#0f1623');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, W, H);

  // sparse stars
  ctx.fillStyle = 'rgba(255,255,255,0.22)';
  for (let i = 0; i < 36; i++) {
    const sx = (i * 53) % W;
    const sy = (i * 89) % (GROUND_Y - 20);
    ctx.fillRect(sx, sy, 1, 1);
  }

  // ground
  ctx.fillStyle = '#0a1015';
  ctx.fillRect(0, GROUND_Y, W, H - GROUND_Y);
  ctx.fillStyle = '#2a313d';
  ctx.fillRect(0, GROUND_Y, W, 1);

  // wind indicator
  drawWindIndicator();

  // balloons
  for (const b of balloons) {
    if (b.alive) drawBalloon(b);
  }

  // projectile trails
  for (const p of projectiles) {
    if (!p.alive) continue;
    ctx.strokeStyle = 'rgba(203,213,225,0.4)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < p.trail.length; i++) {
      const pt = p.trail[i]!;
      if (i === 0) ctx.moveTo(pt.x, pt.y);
      else ctx.lineTo(pt.x, pt.y);
    }
    ctx.stroke();
  }

  // slingshot frame
  drawSlingshot();

  // aim preview
  const aiming = aimPhase === 'aiming' && state === 'playing';
  if (aiming) {
    const tipX = ORIGIN_X + pullX;
    const tipY = REST_Y + pullY;
    // bands stretched
    ctx.strokeStyle = '#a16a3a';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(ORIGIN_X - 18, ORIGIN_Y - 36);
    ctx.lineTo(tipX, tipY);
    ctx.moveTo(ORIGIN_X + 18, ORIGIN_Y - 36);
    ctx.lineTo(tipX, tipY);
    ctx.stroke();
    // stone
    ctx.fillStyle = '#cbd5e1';
    ctx.beginPath();
    ctx.arc(tipX, tipY, PROJECTILE_R, 0, Math.PI * 2);
    ctx.fill();
    // trajectory preview
    const v0x = -pullX * POWER;
    const v0y = -pullY * POWER;
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    for (let i = 1; i <= 14; i++) {
      const t = i * 0.05;
      const px = tipX + v0x * t + 0.5 * wind * t * t;
      const py = tipY + v0y * t + 0.5 * GRAVITY * t * t;
      if (py > GROUND_Y || px < 0 || px > W) break;
      ctx.beginPath();
      ctx.arc(px, py, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
    // power bar
    const pct = Math.min(1, Math.hypot(pullX, pullY) / PULL_MAX);
    ctx.fillStyle = '#10141c';
    ctx.fillRect(20, GROUND_Y + 12, 130, 12);
    ctx.fillStyle =
      pct < 0.7 ? '#34d399' : pct < 0.95 ? '#fbbf24' : '#fb7185';
    ctx.fillRect(20, GROUND_Y + 12, 130 * pct, 12);
    ctx.strokeStyle = '#2a313d';
    ctx.lineWidth = 1;
    ctx.strokeRect(20, GROUND_Y + 12, 130, 12);
    ctx.fillStyle = '#9aa0aa';
    ctx.font = '500 11px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('Güç', 20, GROUND_Y + 38);
  } else {
    // bands at rest
    ctx.strokeStyle = '#a16a3a';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(ORIGIN_X - 18, ORIGIN_Y - 36);
    ctx.lineTo(ORIGIN_X, REST_Y);
    ctx.moveTo(ORIGIN_X + 18, ORIGIN_Y - 36);
    ctx.lineTo(ORIGIN_X, REST_Y);
    ctx.stroke();
    if (state !== 'gameover') {
      ctx.fillStyle = '#cbd5e1';
      ctx.beginPath();
      ctx.arc(ORIGIN_X, REST_Y, PROJECTILE_R, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // projectiles in flight (stones)
  for (const p of projectiles) {
    if (!p.alive) continue;
    ctx.fillStyle = '#e5e7eb';
    ctx.beginPath();
    ctx.arc(p.x, p.y, PROJECTILE_R, 0, Math.PI * 2);
    ctx.fill();
  }

  // particles
  for (const part of particles) {
    if (part.life <= 0) continue;
    ctx.globalAlpha = Math.max(0, part.life);
    ctx.fillStyle = part.color;
    ctx.beginPath();
    ctx.arc(part.x, part.y, 2.4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // top-right timer
  if (state === 'playing') {
    const tLeft = Math.max(0, (ROUND_MS - elapsedMs) / 1000);
    ctx.fillStyle = tLeft < 10 ? '#fb7185' : '#9aa0aa';
    ctx.font = '700 13px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(`${tLeft.toFixed(1)} sn`, W - 12, 60);
  }
}

function drawSlingshot(): void {
  // base
  ctx.fillStyle = '#2a313d';
  ctx.fillRect(ORIGIN_X - 24, GROUND_Y - 4, 48, 8);
  // post
  ctx.fillStyle = '#7c5024';
  ctx.fillRect(ORIGIN_X - 5, ORIGIN_Y - 6, 10, GROUND_Y - (ORIGIN_Y - 6));
  // left fork
  ctx.save();
  ctx.translate(ORIGIN_X, ORIGIN_Y - 6);
  ctx.rotate(-0.5);
  ctx.fillRect(-5, -34, 10, 36);
  ctx.restore();
  // right fork
  ctx.save();
  ctx.translate(ORIGIN_X, ORIGIN_Y - 6);
  ctx.rotate(0.5);
  ctx.fillRect(-5, -34, 10, 36);
  ctx.restore();
  // fork tips
  ctx.fillStyle = '#5a3a18';
  ctx.beginPath();
  ctx.arc(ORIGIN_X - 18, ORIGIN_Y - 36, 4, 0, Math.PI * 2);
  ctx.arc(ORIGIN_X + 18, ORIGIN_Y - 36, 4, 0, Math.PI * 2);
  ctx.fill();
}

function drawBalloon(b: Balloon): void {
  let main: string, hl: string, str: string;
  if (b.kind === 'gold') {
    main = '#fbbf24';
    hl = '#fef3c7';
    str = '#92400e';
  } else if (b.kind === 'bomb') {
    main = '#1f2937';
    hl = '#475569';
    str = '#ef4444';
  } else {
    main = '#e5e7eb';
    hl = '#ffffff';
    str = '#6b7280';
  }
  // body
  ctx.fillStyle = main;
  ctx.beginPath();
  ctx.ellipse(b.x, b.y, b.r, b.r * 1.15, 0, 0, Math.PI * 2);
  ctx.fill();
  // highlight
  ctx.globalAlpha = 0.4;
  ctx.fillStyle = hl;
  ctx.beginPath();
  ctx.ellipse(
    b.x - b.r * 0.32,
    b.y - b.r * 0.5,
    b.r * 0.26,
    b.r * 0.42,
    0,
    0,
    Math.PI * 2,
  );
  ctx.fill();
  ctx.globalAlpha = 1;
  // knot
  ctx.fillStyle = main;
  ctx.beginPath();
  ctx.moveTo(b.x - 4, b.y + b.r * 1.15);
  ctx.lineTo(b.x + 4, b.y + b.r * 1.15);
  ctx.lineTo(b.x, b.y + b.r * 1.15 + 6);
  ctx.closePath();
  ctx.fill();
  // string
  ctx.strokeStyle = str;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(b.x, b.y + b.r * 1.15 + 6);
  ctx.quadraticCurveTo(
    b.x + 6,
    b.y + b.r * 1.15 + 22,
    b.x,
    b.y + b.r * 1.15 + 36,
  );
  ctx.stroke();
  // bomb fuse + spark
  if (b.kind === 'bomb') {
    ctx.strokeStyle = '#9aa0aa';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(b.x - b.r * 0.34, b.y - b.r * 0.7);
    ctx.lineTo(b.x - b.r * 0.45, b.y - b.r * 1.05);
    ctx.stroke();
    ctx.fillStyle = '#fbbf24';
    ctx.beginPath();
    ctx.arc(b.x - b.r * 0.45, b.y - b.r * 1.05, 2.8, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawWindIndicator(): void {
  const cx = W / 2;
  const cy = 28;
  // bg
  ctx.fillStyle = '#10141c';
  ctx.fillRect(cx - 80, cy - 8, 160, 16);
  ctx.strokeStyle = '#2a313d';
  ctx.lineWidth = 1;
  ctx.strokeRect(cx - 80, cy - 8, 160, 16);
  // center tick
  ctx.fillStyle = '#2a313d';
  ctx.fillRect(cx - 0.5, cy - 8, 1, 16);
  // arrow
  const frac = Math.max(-1, Math.min(1, wind / WIND_MAX));
  const arrowLen = frac * 72;
  if (Math.abs(arrowLen) > 2) {
    const sign = arrowLen >= 0 ? 1 : -1;
    const col = arrowLen > 0 ? '#60a5fa' : '#fbbf24';
    ctx.strokeStyle = col;
    ctx.fillStyle = col;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + arrowLen, cy);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx + arrowLen, cy);
    ctx.lineTo(cx + arrowLen - 7 * sign, cy - 5);
    ctx.lineTo(cx + arrowLen - 7 * sign, cy + 5);
    ctx.closePath();
    ctx.fill();
  } else {
    ctx.fillStyle = '#9aa0aa';
    ctx.beginPath();
    ctx.arc(cx, cy, 2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = '#9aa0aa';
  ctx.font = '500 11px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Rüzgâr', cx, cy + 24);
  // suppress unused getCss to keep theming entry available
  void getCss;
}

// --- init ---

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  timeEl = document.querySelector<HTMLElement>('#time')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('keydown', onKey);

  restartBtn.addEventListener('click', () => {
    reset();
  });

  overlay.addEventListener('click', () => {
    if (state === 'ready') startPlaying();
    else if (state === 'gameover') {
      reset();
      startPlaying();
    }
  });

  reset();
}

export const game = defineGame({ init, reset });
