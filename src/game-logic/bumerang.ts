import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay, hideOverlay } from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';

// PITFALLS guarded:
// - unguarded-storage: safeRead/safeWrite wrap localStorage.
// - stale-async-callback: single setInterval loop + gen.bump() in reset().
// - overlay-input-leak: explicit `state` enum guards every input handler.
// - module-level-dom-access: all DOM/storage in init().
// - missing-overlay-css: per-game CSS defines .overlay--hidden visual rule.

const STORAGE_BEST = 'bumerang.best';

const W = 480;
const H = 600;
const PLAYER_X = W / 2;
const PLAYER_Y = 540;
const PLAYER_R = 14;
const BOOMERANG_R = 11;
const BALLOON_R = 18;
const CATCH_R = 42;
const FLIGHT_TICKS = 90;
const CATCH_OPEN = FLIGHT_TICKS - 10;
const CATCH_CLOSE = FLIGHT_TICKS + 18;
const MIN_POWER = 0.35;
const FULL_CHARGE_TICKS = 60;
const MAX_BALLOONS = 5;
const RESPAWN_TICKS = 75;
const TICK_MS = 16;

type State = 'ready' | 'aiming' | 'flying' | 'gameover';
type BalloonColor = 'red' | 'blue' | 'gold';

interface Balloon {
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: BalloonColor;
  alive: boolean;
  respawnAt: number;
}

interface Boomerang {
  x: number;
  y: number;
  rot: number;
  age: number;
  hitsThisFlight: number;
  p0x: number;
  p0y: number;
  p1x: number;
  p1y: number;
  p2x: number;
  p2y: number;
  p3x: number;
  p3y: number;
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
let score = 0;
let best = 0;
let lives = 3;
let powerCharge = 0;
let mouseX = PLAYER_X;
let mouseY = PLAYER_Y - 120;
let isHolding = false;
let boomerang: Boomerang | null = null;
let balloons: Balloon[] = [];
let particles: Particle[] = [];
let tickCount = 0;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let livesEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayBtn!: HTMLButtonElement;

let tickHandle: number | null = null;

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function pickColor(): BalloonColor {
  const r = Math.random();
  if (r < 0.1) return 'gold';
  if (r < 0.35) return 'blue';
  return 'red';
}

function colorOf(c: BalloonColor): string {
  if (c === 'gold') return '#fbbf24';
  if (c === 'blue') return '#60a5fa';
  return '#f87171';
}

function scoreOf(c: BalloonColor): number {
  if (c === 'gold') return 50;
  if (c === 'blue') return 20;
  return 10;
}

function makeBalloon(): Balloon {
  return {
    x: rand(50, W - 50),
    y: rand(80, 360),
    vx: rand(-0.8, 0.8),
    vy: rand(-0.25, 0.25),
    color: pickColor(),
    alive: true,
    respawnAt: 0,
  };
}

function spawnBalloons(): void {
  balloons = [];
  for (let i = 0; i < MAX_BALLOONS; i++) balloons.push(makeBalloon());
}

function spawnBurst(x: number, y: number, color: string): void {
  for (let i = 0; i < 12; i++) {
    const a = Math.random() * Math.PI * 2;
    const s = 1 + Math.random() * 3;
    particles.push({
      x,
      y,
      vx: Math.cos(a) * s,
      vy: Math.sin(a) * s,
      life: 26,
      color,
    });
  }
}

function commitBest(): void {
  if (score > best) {
    best = score;
    bestEl.textContent = String(best);
    safeWrite(STORAGE_BEST, best);
  }
}

function reset(): void {
  gen.bump();
  state = 'ready';
  score = 0;
  lives = 3;
  powerCharge = 0;
  isHolding = false;
  boomerang = null;
  particles = [];
  tickCount = 0;
  scoreEl.textContent = '0';
  livesEl.textContent = '3';
  spawnBalloons();
  overlayTitle.textContent = 'Bumerang';
  overlayMsg.textContent =
    'Fareyle nişan al · tıkla-tut → güç şarjı · bırak → fırlat. Geri gelirken yeşil halka içinde tıkla → yakala (+bonus).';
  overlayBtn.textContent = 'Başla';
  showOverlay(overlay);
  draw();
  ensureLoop();
}

function startGame(): void {
  if (state === 'gameover') {
    score = 0;
    lives = 3;
    scoreEl.textContent = '0';
    livesEl.textContent = '3';
    spawnBalloons();
    particles = [];
  } else if (state !== 'ready') {
    return;
  }
  state = 'aiming';
  hideOverlay(overlay);
}

function ensureLoop(): void {
  if (tickHandle !== null) return;
  tickHandle = window.setInterval(loop, TICK_MS);
}

function aimAngle(): number {
  const dx = mouseX - PLAYER_X;
  const dy = mouseY - PLAYER_Y;
  let a = Math.atan2(dy, dx);
  // Clamp at ±45° from straight up so the lasso-shaped loop stays inside
  // the canvas at max power instead of swinging off the side edges.
  if (a > -Math.PI / 4) a = -Math.PI / 4;
  if (a < -3 * Math.PI / 4) a = -3 * Math.PI / 4;
  return a;
}

function chargeToPower(): number {
  return Math.min(1, powerCharge / FULL_CHARGE_TICKS);
}

function throwBoomerang(): void {
  const power = Math.max(MIN_POWER, chargeToPower());
  const ang = aimAngle();
  const forwardDist = 170 + power * 130;
  const lateralDist = 130 + power * 95;
  const tx = Math.cos(ang);
  const ty = Math.sin(ang);
  // Perp pointing upward in screen (negative y), keeping loop above player.
  let px: number;
  let py: number;
  if (tx >= 0) {
    px = ty;
    py = -tx;
  } else {
    px = -ty;
    py = tx;
  }
  const sx = PLAYER_X;
  const sy = PLAYER_Y - PLAYER_R - 2;
  const p1x = sx + tx * forwardDist;
  const p1y = sy + ty * forwardDist;
  const p2x = p1x + px * lateralDist;
  const p2y = p1y + py * lateralDist;
  boomerang = {
    x: sx,
    y: sy,
    rot: 0,
    age: 0,
    hitsThisFlight: 0,
    p0x: sx,
    p0y: sy,
    p1x,
    p1y,
    p2x,
    p2y,
    p3x: sx,
    p3y: sy,
  };
  state = 'flying';
  powerCharge = 0;
  isHolding = false;
}

function updateBoomerang(): void {
  if (!boomerang) return;
  boomerang.age++;
  boomerang.rot += 0.5;
  // Cubic Bezier path P0 → P1 → P2 → P3 (with P0 == P3 == player). The
  // perpendicular control direction is chosen so the loop always stays in
  // the upper half of the canvas — a pure rotating-velocity model would
  // sweep the boomerang below the player on its return leg.
  const t = Math.min(1, boomerang.age / FLIGHT_TICKS);
  const u = 1 - t;
  const u2 = u * u;
  const u3 = u2 * u;
  const t2 = t * t;
  const t3 = t2 * t;
  boomerang.x =
    u3 * boomerang.p0x +
    3 * u2 * t * boomerang.p1x +
    3 * u * t2 * boomerang.p2x +
    t3 * boomerang.p3x;
  boomerang.y =
    u3 * boomerang.p0y +
    3 * u2 * t * boomerang.p1y +
    3 * u * t2 * boomerang.p2y +
    t3 * boomerang.p3y;

  for (const b of balloons) {
    if (!b.alive) continue;
    const dx = boomerang.x - b.x;
    const dy = boomerang.y - b.y;
    const d2 = dx * dx + dy * dy;
    const r = BOOMERANG_R + BALLOON_R;
    if (d2 < r * r) {
      b.alive = false;
      b.respawnAt = tickCount + RESPAWN_TICKS;
      score += scoreOf(b.color);
      scoreEl.textContent = String(score);
      boomerang.hitsThisFlight++;
      spawnBurst(b.x, b.y, colorOf(b.color));
      commitBest();
    }
  }

  if (boomerang.age > CATCH_CLOSE) {
    spawnBurst(boomerang.x, boomerang.y, '#9ca3af');
    loseLife();
  }
}

function attemptCatch(): boolean {
  if (!boomerang) return false;
  if (boomerang.age < CATCH_OPEN || boomerang.age > CATCH_CLOSE) return false;
  const dx = boomerang.x - PLAYER_X;
  const dy = boomerang.y - PLAYER_Y;
  const d2 = dx * dx + dy * dy;
  if (d2 < CATCH_R * CATCH_R) {
    const bonus = 25 + boomerang.hitsThisFlight * 15;
    score += bonus;
    scoreEl.textContent = String(score);
    commitBest();
    spawnBurst(PLAYER_X, PLAYER_Y, '#4ade80');
    boomerang = null;
    state = 'aiming';
    return true;
  }
  return false;
}

function loseLife(): void {
  lives--;
  livesEl.textContent = String(lives);
  boomerang = null;
  if (lives <= 0) {
    state = 'gameover';
    overlayTitle.textContent = 'Bitti!';
    overlayMsg.textContent = `Skor: ${score}\nRekor: ${best}`;
    overlayBtn.textContent = 'Tekrar';
    showOverlay(overlay);
  } else {
    state = 'aiming';
  }
}

function updateBalloons(): void {
  for (const b of balloons) {
    if (!b.alive) {
      if (tickCount >= b.respawnAt) {
        const fresh = makeBalloon();
        b.x = fresh.x;
        b.y = fresh.y;
        b.vx = fresh.vx;
        b.vy = fresh.vy;
        b.color = fresh.color;
        b.alive = true;
      }
      continue;
    }
    b.x += b.vx;
    b.y += b.vy;
    if (b.x < 30) { b.x = 30; b.vx = Math.abs(b.vx); }
    if (b.x > W - 30) { b.x = W - 30; b.vx = -Math.abs(b.vx); }
    if (b.y < 60) { b.y = 60; b.vy = Math.abs(b.vy); }
    if (b.y > 400) { b.y = 400; b.vy = -Math.abs(b.vy); }
  }
}

function updateParticles(): void {
  for (const p of particles) {
    p.x += p.vx;
    p.y += p.vy;
    p.vy += 0.12;
    p.life--;
  }
  particles = particles.filter((p) => p.life > 0);
}

function loop(): void {
  tickCount++;

  if (state === 'aiming' && isHolding && !boomerang) {
    powerCharge++;
  }

  if (state === 'flying') {
    updateBoomerang();
  }

  if (state !== 'gameover') {
    updateBalloons();
  }
  updateParticles();

  draw();
}

function getCssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function draw(): void {
  const grd = ctx.createLinearGradient(0, 0, 0, H);
  grd.addColorStop(0, '#1e293b');
  grd.addColorStop(0.7, '#0f172a');
  grd.addColorStop(1, '#1f2937');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = 'rgba(255,255,255,0.03)';
  ctx.lineWidth = 1;
  for (let y = 40; y < H; y += 40) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }
  for (let x = 40; x < W; x += 40) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
  }

  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, PLAYER_Y + PLAYER_R + 4);
  ctx.lineTo(W, PLAYER_Y + PLAYER_R + 4);
  ctx.stroke();

  for (const b of balloons) {
    if (!b.alive) continue;
    ctx.fillStyle = colorOf(b.color);
    ctx.beginPath();
    ctx.arc(b.x, b.y, BALLOON_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(b.x, b.y + BALLOON_R);
    ctx.lineTo(b.x + 2, b.y + BALLOON_R + 16);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.beginPath();
    ctx.arc(b.x - 5, b.y - 5, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  for (const p of particles) {
    const alpha = Math.min(1, p.life / 18);
    ctx.fillStyle = p.color;
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  if (
    state === 'flying' &&
    boomerang &&
    boomerang.age >= CATCH_OPEN &&
    boomerang.age <= CATCH_CLOSE
  ) {
    const pulse = 0.5 + 0.5 * Math.sin(tickCount * 0.5);
    ctx.strokeStyle = 'rgba(74, 222, 128, 0.85)';
    ctx.lineWidth = 3 + pulse * 2;
    ctx.beginPath();
    ctx.arc(PLAYER_X, PLAYER_Y, CATCH_R, 0, Math.PI * 2);
    ctx.stroke();
  }

  const playerColor = getCssVar('--accent', '#22d3ee');
  ctx.fillStyle = playerColor;
  ctx.beginPath();
  ctx.arc(PLAYER_X, PLAYER_Y, PLAYER_R, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.beginPath();
  ctx.arc(PLAYER_X, PLAYER_Y - 3, 4, 0, Math.PI * 2);
  ctx.fill();

  if (state === 'aiming' && !boomerang) {
    const ang = aimAngle();
    const power = chargeToPower();
    const len = 80 + power * 110;
    ctx.strokeStyle = isHolding
      ? `rgba(251, 191, 36, ${0.55 + power * 0.4})`
      : 'rgba(255,255,255,0.28)';
    ctx.lineWidth = isHolding ? 3 + power * 3 : 2;
    ctx.setLineDash(isHolding ? [] : [8, 6]);
    ctx.beginPath();
    ctx.moveTo(PLAYER_X, PLAYER_Y);
    ctx.lineTo(PLAYER_X + Math.cos(ang) * len, PLAYER_Y + Math.sin(ang) * len);
    ctx.stroke();
    ctx.setLineDash([]);

    const tipX = PLAYER_X + Math.cos(ang) * len;
    const tipY = PLAYER_Y + Math.sin(ang) * len;
    const ah = 8;
    ctx.fillStyle = isHolding ? '#fbbf24' : 'rgba(255,255,255,0.35)';
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(
      tipX - Math.cos(ang - 0.3) * ah,
      tipY - Math.sin(ang - 0.3) * ah,
    );
    ctx.lineTo(
      tipX - Math.cos(ang + 0.3) * ah,
      tipY - Math.sin(ang + 0.3) * ah,
    );
    ctx.closePath();
    ctx.fill();

    if (isHolding) {
      const mw = 90;
      const mx = PLAYER_X - mw / 2;
      const my = PLAYER_Y + 30;
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fillRect(mx, my, mw, 8);
      ctx.fillStyle = power < 0.7 ? '#22d3ee' : '#fbbf24';
      ctx.fillRect(mx, my, mw * power, 8);
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 1;
      ctx.strokeRect(mx, my, mw, 8);
    }
  }

  if (boomerang) {
    ctx.save();
    ctx.translate(boomerang.x, boomerang.y);
    ctx.rotate(boomerang.rot);
    ctx.fillStyle = '#fde047';
    ctx.strokeStyle = '#92400e';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, -BOOMERANG_R);
    ctx.lineTo(BOOMERANG_R * 0.9, BOOMERANG_R * 0.2);
    ctx.lineTo(BOOMERANG_R * 0.3, BOOMERANG_R * 0.55);
    ctx.lineTo(0, 0);
    ctx.lineTo(-BOOMERANG_R * 0.3, BOOMERANG_R * 0.55);
    ctx.lineTo(-BOOMERANG_R * 0.9, BOOMERANG_R * 0.2);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}

function onPointerDown(e: PointerEvent): void {
  e.preventDefault();
  if (state === 'ready' || state === 'gameover') {
    startGame();
    return;
  }
  if (state === 'flying') {
    attemptCatch();
    return;
  }
  if (state === 'aiming' && !boomerang) {
    isHolding = true;
    powerCharge = 0;
  }
}

function onPointerUp(): void {
  if (state === 'aiming' && isHolding && !boomerang) {
    throwBoomerang();
  }
  isHolding = false;
}

function onPointerMove(e: PointerEvent): void {
  const rect = canvas.getBoundingClientRect();
  mouseX = ((e.clientX - rect.left) / rect.width) * W;
  mouseY = ((e.clientY - rect.top) / rect.height) * H;
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  livesEl = document.querySelector<HTMLElement>('#lives')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;

  best = safeRead<number>(STORAGE_BEST, 0);
  bestEl.textContent = String(best);

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);

  restartBtn.addEventListener('click', reset);
  overlayBtn.addEventListener('click', startGame);

  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'r') {
      reset();
      e.preventDefault();
    } else if (k === ' ' || k === 'enter') {
      if (state === 'ready' || state === 'gameover') {
        startGame();
        e.preventDefault();
      }
    }
  });

  reset();
}

export const game = defineGame({ init, reset });
