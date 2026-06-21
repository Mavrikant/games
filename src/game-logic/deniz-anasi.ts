import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import {
  showOverlay as showOverlayEl,
  hideOverlay as hideOverlayEl,
} from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';

const STORAGE_BEST = 'deniz-anasi.best';

const CANVAS_W = 480;
const CANVAS_H = 640;

const JELLY_X = 130;
const JELLY_R = 18;
const GRAVITY = 220;
const PULSE_VY = -260;
const DRAG = 0.985;
const MAX_VY = 320;

const PULSE_COOLDOWN_MS = 520;
const RING_DURATION_MS = 480;
const RING_MAX_R = 130;
const STUN_DURATION_MS = 1200;

const KRILL_R = 3.5;
const KRILL_SPAWN_MIN_MS = 380;
const KRILL_SPAWN_MAX_MS = 720;
const KRILL_SPEED_MIN = 70;
const KRILL_SPEED_MAX = 130;

const FISH_R = 13;
const FISH_SPAWN_BASE_MS = 1900;
const FISH_SPAWN_MIN_MS = 700;
const FISH_SPEED_MIN = 90;
const FISH_SPEED_MAX = 170;

const FOG_CEILING = 60;
const FOG_FLOOR = CANVAS_H - 80;

type State = 'ready' | 'playing' | 'gameover';
type Krill = { x: number; y: number; vx: number; phase: number; alive: boolean };
type Fish = {
  x: number;
  y: number;
  vx: number;
  baseVx: number;
  stunUntil: number;
  eaten: boolean;
  eatT: number;
  hue: number;
  alive: boolean;
};
type Ring = { x: number; y: number; age: number };
type Bubble = { x: number; y: number; r: number; vy: number };

const gen = createGenToken();
let state: State = 'ready';
let score = 0;
let best = 0;
let stunCount = 0;
let elapsed = 0;
let cooldown = 0;
let cooldownShake = 0;
let pulseFlash = 0;
let bellSquash = 0;

let jellyY = CANVAS_H * 0.45;
let jellyVy = 0;

let krillSpawn = 600;
let fishSpawn = FISH_SPAWN_BASE_MS;

let krills: Krill[] = [];
let fishes: Fish[] = [];
let rings: Ring[] = [];
let bubbles: Bubble[] = [];

let lastFrame = 0;
let rafHandle: number | null = null;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let stunsEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayBtn!: HTMLButtonElement;

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function makeBubbles(): Bubble[] {
  const out: Bubble[] = [];
  for (let i = 0; i < 22; i++) {
    out.push({
      x: Math.random() * CANVAS_W,
      y: Math.random() * CANVAS_H,
      r: rand(1.2, 3.2),
      vy: rand(8, 26),
    });
  }
  return out;
}

function fishSpawnInterval(): number {
  // ramp from base down to min over ~50s
  const t = Math.min(1, elapsed / 50000);
  return FISH_SPAWN_BASE_MS - (FISH_SPAWN_BASE_MS - FISH_SPAWN_MIN_MS) * t;
}

function fishSpeedRange(): { min: number; max: number } {
  const t = Math.min(1, elapsed / 60000);
  return {
    min: FISH_SPEED_MIN + 50 * t,
    max: FISH_SPEED_MAX + 90 * t,
  };
}

function spawnKrill(): void {
  const y = rand(40, CANVAS_H - 40);
  const speed = rand(KRILL_SPEED_MIN, KRILL_SPEED_MAX);
  krills.push({
    x: CANVAS_W + 8,
    y,
    vx: -speed,
    phase: Math.random() * Math.PI * 2,
    alive: true,
  });
}

function spawnFish(): void {
  const y = rand(80, CANVAS_H - 80);
  const { min, max } = fishSpeedRange();
  const speed = rand(min, max);
  fishes.push({
    x: CANVAS_W + 28,
    y,
    vx: -speed,
    baseVx: -speed,
    stunUntil: 0,
    eaten: false,
    eatT: 0,
    hue: rand(8, 32),
    alive: true,
  });
}

function updateHud(): void {
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
  stunsEl.textContent = String(stunCount);
}

function showReadyOverlay(): void {
  overlayTitle.textContent = 'Deniz Anası';
  overlayMsg.textContent =
    'Tek tuş, çift iş: nabız hem yukarı iter\nhem de etrafa biyoluminesans halka yayar.\n' +
    'Halkadaki balıklar 1.2 sn donar — dokunmak yerine yutarsın (+5).\n' +
    'Donmamış balık = oyun biter. Krill (+1) için dal.\n' +
    'Boşluk / tıklama: nabız at.';
  overlayBtn.textContent = 'Başla';
  showOverlayEl(overlay);
}

function showGameOverOverlay(): void {
  overlayTitle.textContent = 'Balık Yedi';
  const fresh = score === best && best > 0;
  overlayMsg.textContent =
    `Skor: ${score}` +
    (fresh ? '  ·  Yeni rekor!' : `\nRekor: ${best}`) +
    `\nDondurulan: ${stunCount}`;
  overlayBtn.textContent = 'Tekrar dene';
  showOverlayEl(overlay);
}

function commitBest(): void {
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
}

function resetWorld(): void {
  jellyY = CANVAS_H * 0.45;
  jellyVy = 0;
  cooldown = 0;
  cooldownShake = 0;
  pulseFlash = 0;
  bellSquash = 0;
  krillSpawn = 600;
  fishSpawn = FISH_SPAWN_BASE_MS;
  elapsed = 0;
  score = 0;
  stunCount = 0;
  krills = [];
  fishes = [];
  rings = [];
}

function reset(): void {
  gen.bump();
  stopRaf();
  commitBest();
  resetWorld();
  state = 'ready';
  updateHud();
  draw();
  showReadyOverlay();
  startAmbientRaf();
}

function startRound(): void {
  hideOverlayEl(overlay);
  resetWorld();
  state = 'playing';
  updateHud();
  lastFrame = performance.now();
  stopRaf();
  startRaf();
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
    update(dt);
    draw();
    if (state === 'playing') {
      rafHandle = requestAnimationFrame(loop);
    } else {
      rafHandle = null;
    }
  };
  rafHandle = requestAnimationFrame(loop);
}

function startAmbientRaf(): void {
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
    ambientUpdate(dt);
    draw();
    if (state === 'ready') {
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

function ambientUpdate(dt: number): void {
  for (const b of bubbles) {
    b.y -= b.vy * (dt / 1000);
    if (b.y < -4) {
      b.y = CANVAS_H + rand(0, 30);
      b.x = Math.random() * CANVAS_W;
    }
  }
  // Idle jellyfish gentle bob
  jellyY += Math.sin(performance.now() * 0.0015) * 0.4;
}

function pulse(): void {
  if (state !== 'playing') return;
  if (cooldown > 0) {
    cooldownShake = 220;
    return;
  }
  jellyVy = PULSE_VY;
  cooldown = PULSE_COOLDOWN_MS;
  pulseFlash = 240;
  bellSquash = 200;
  rings.push({ x: JELLY_X, y: jellyY, age: 0 });
  // Stun any fish within max ring radius at moment of pulse.
  const now = performance.now();
  for (const f of fishes) {
    if (f.eaten) continue;
    const dx = f.x - JELLY_X;
    const dy = f.y - jellyY;
    if (Math.hypot(dx, dy) <= RING_MAX_R + FISH_R) {
      if (f.stunUntil < now + STUN_DURATION_MS) {
        f.stunUntil = now + STUN_DURATION_MS;
        stunCount += 1;
      }
    }
  }
}

function update(dt: number): void {
  elapsed += dt;
  cooldown = Math.max(0, cooldown - dt);
  cooldownShake = Math.max(0, cooldownShake - dt);
  pulseFlash = Math.max(0, pulseFlash - dt);
  bellSquash = Math.max(0, bellSquash - dt);

  // Jellyfish physics
  jellyVy += GRAVITY * (dt / 1000);
  jellyVy *= DRAG;
  if (jellyVy > MAX_VY) jellyVy = MAX_VY;
  jellyY += jellyVy * (dt / 1000);

  // Soft clamp at edges
  if (jellyY < JELLY_R + 4) {
    jellyY = JELLY_R + 4;
    jellyVy = Math.max(0, jellyVy) + 20;
  }
  if (jellyY > CANVAS_H - JELLY_R - 4) {
    jellyY = CANVAS_H - JELLY_R - 4;
    jellyVy = Math.min(0, jellyVy) - 30;
  }

  // Bubbles drift up
  for (const b of bubbles) {
    b.y -= b.vy * (dt / 1000);
    if (b.y < -4) {
      b.y = CANVAS_H + rand(0, 30);
      b.x = Math.random() * CANVAS_W;
    }
  }

  // Rings expand
  for (const r of rings) r.age += dt;
  rings = rings.filter((r) => r.age < RING_DURATION_MS);

  // Spawn
  krillSpawn -= dt;
  if (krillSpawn <= 0) {
    spawnKrill();
    krillSpawn = rand(KRILL_SPAWN_MIN_MS, KRILL_SPAWN_MAX_MS);
  }
  fishSpawn -= dt;
  if (fishSpawn <= 0) {
    spawnFish();
    fishSpawn = fishSpawnInterval();
  }

  const now = performance.now();

  // Krill update
  for (const k of krills) {
    if (!k.alive) continue;
    k.x += k.vx * (dt / 1000);
    k.phase += dt * 0.006;
    k.y += Math.sin(k.phase) * 0.3;
    if (k.x < -8) {
      k.alive = false;
      continue;
    }
    const dx = k.x - JELLY_X;
    const dy = k.y - jellyY;
    if (Math.hypot(dx, dy) <= JELLY_R + KRILL_R) {
      k.alive = false;
      score += 1;
    }
  }
  krills = krills.filter((k) => k.alive);

  // Fish update
  for (const f of fishes) {
    if (!f.alive) continue;
    if (f.eaten) {
      f.eatT += dt;
      if (f.eatT > 260) f.alive = false;
      continue;
    }
    const isStunned = f.stunUntil > now;
    if (isStunned) {
      // Stunned: slow drift downward, dim red->blue
      f.x += f.baseVx * 0.15 * (dt / 1000);
      f.y += 22 * (dt / 1000);
    } else {
      f.x += f.vx * (dt / 1000);
      // small vertical wander to make pulse aiming non-trivial
      f.y += Math.sin((f.x + f.hue) * 0.04) * 0.4;
    }
    if (f.x < -32 || f.y > CANVAS_H + 30) {
      f.alive = false;
      continue;
    }
    const dx = f.x - JELLY_X;
    const dy = f.y - jellyY;
    if (Math.hypot(dx, dy) <= JELLY_R + FISH_R - 2) {
      if (isStunned) {
        f.eaten = true;
        f.eatT = 0;
        score += 5;
      } else {
        gameOver();
        return;
      }
    }
  }
  fishes = fishes.filter((f) => f.alive);

  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
  updateHud();
}

function gameOver(): void {
  state = 'gameover';
  stopRaf();
  commitBest();
  updateHud();
  draw();
  showGameOverOverlay();
}

function draw(): void {
  const w = canvas.width;
  const h = canvas.height;

  // Background gradient (deep ocean)
  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, '#062338');
  bg.addColorStop(0.55, '#04122a');
  bg.addColorStop(1, '#020817');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  // Light beams from above
  ctx.save();
  ctx.globalAlpha = 0.12;
  ctx.fillStyle = '#6ec3ff';
  for (let i = 0; i < 5; i++) {
    const cx = (i * 130 + (performance.now() * 0.02) % 130) % w;
    ctx.beginPath();
    ctx.moveTo(cx - 30, 0);
    ctx.lineTo(cx + 30, 0);
    ctx.lineTo(cx + 90, h);
    ctx.lineTo(cx - 90, h);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();

  // Bubbles
  for (const b of bubbles) {
    ctx.fillStyle = 'rgba(170, 220, 255, 0.18)';
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Ceiling/floor murk
  const top = ctx.createLinearGradient(0, 0, 0, FOG_CEILING);
  top.addColorStop(0, 'rgba(255,255,255,0.10)');
  top.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = top;
  ctx.fillRect(0, 0, w, FOG_CEILING);

  const floor = ctx.createLinearGradient(0, FOG_FLOOR, 0, h);
  floor.addColorStop(0, 'rgba(0,0,0,0)');
  floor.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = floor;
  ctx.fillRect(0, FOG_FLOOR, w, h - FOG_FLOOR);

  // Krill
  for (const k of krills) {
    ctx.fillStyle = 'rgba(255, 240, 180, 0.95)';
    ctx.beginPath();
    ctx.arc(k.x, k.y, KRILL_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 240, 180, 0.4)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(k.x + 2, k.y);
    ctx.lineTo(k.x + 7, k.y - Math.sin(k.phase) * 2);
    ctx.stroke();
  }

  // Fish
  const now = performance.now();
  for (const f of fishes) {
    const stunned = f.stunUntil > now;
    drawFish(f, stunned, now);
  }

  // Rings (expanding glow)
  for (const r of rings) {
    const t = r.age / RING_DURATION_MS;
    const radius = RING_MAX_R * t;
    const alpha = (1 - t) * 0.55;
    const grad = ctx.createRadialGradient(r.x, r.y, radius * 0.4, r.x, r.y, radius);
    grad.addColorStop(0, `rgba(120, 220, 255, 0)`);
    grad.addColorStop(0.6, `rgba(140, 230, 255, ${alpha * 0.45})`);
    grad.addColorStop(1, `rgba(180, 240, 255, 0)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(r.x, r.y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = `rgba(200, 245, 255, ${alpha})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(r.x, r.y, radius, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Jellyfish
  drawJellyfish();

  // Cooldown bar
  if (state === 'playing') {
    const cwBar = 64;
    const chBar = 4;
    const cxBar = w - 14 - cwBar;
    const cyBar = 12;
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    ctx.fillRect(cxBar, cyBar, cwBar, chBar);
    ctx.fillStyle = cooldown > 0 ? '#ffb84d' : '#7be3a6';
    ctx.fillRect(
      cxBar,
      cyBar,
      cwBar * (cooldown > 0 ? 1 - cooldown / PULSE_COOLDOWN_MS : 1),
      chBar,
    );
  }
  if (cooldownShake > 0) {
    ctx.strokeStyle = `rgba(255,120,120,${cooldownShake / 250})`;
    ctx.lineWidth = 2;
    ctx.strokeRect(2, 2, w - 4, h - 4);
  }
}

function drawJellyfish(): void {
  const x = JELLY_X;
  const y = jellyY;
  const squash = 1 - bellSquash / 400; // 1 -> 0.5 momentarily
  const bellW = JELLY_R * 1.6;
  const bellH = JELLY_R * 1.1 * squash;

  // Soft glow
  if (pulseFlash > 0) {
    const a = pulseFlash / 260;
    const glow = ctx.createRadialGradient(x, y, 4, x, y, JELLY_R * 4.5);
    glow.addColorStop(0, `rgba(180, 240, 255, ${0.55 * a})`);
    glow.addColorStop(1, `rgba(180, 240, 255, 0)`);
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(x, y, JELLY_R * 4.5, 0, Math.PI * 2);
    ctx.fill();
  } else {
    const glow = ctx.createRadialGradient(x, y, 4, x, y, JELLY_R * 2.6);
    glow.addColorStop(0, 'rgba(200, 235, 255, 0.25)');
    glow.addColorStop(1, 'rgba(200, 235, 255, 0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(x, y, JELLY_R * 2.6, 0, Math.PI * 2);
    ctx.fill();
  }

  // Tentacles
  ctx.strokeStyle = 'rgba(220, 200, 255, 0.6)';
  ctx.lineWidth = 1.6;
  const tNow = performance.now();
  for (let i = -3; i <= 3; i++) {
    ctx.beginPath();
    const tx = x + i * 4;
    ctx.moveTo(tx, y + bellH * 0.6);
    for (let s = 1; s <= 6; s++) {
      const ty = y + bellH * 0.6 + s * 5;
      const wob = Math.sin(tNow * 0.005 + i + s * 0.6) * 3;
      ctx.lineTo(tx + wob, ty);
    }
    ctx.stroke();
  }

  // Bell
  const bellGrad = ctx.createRadialGradient(x, y - 4, 2, x, y, bellW);
  bellGrad.addColorStop(0, 'rgba(255, 230, 255, 0.95)');
  bellGrad.addColorStop(0.7, 'rgba(200, 170, 255, 0.85)');
  bellGrad.addColorStop(1, 'rgba(140, 110, 220, 0.7)');
  ctx.fillStyle = bellGrad;
  ctx.beginPath();
  ctx.ellipse(x, y, bellW, bellH, 0, Math.PI, 0, false);
  ctx.lineTo(x + bellW, y + bellH * 0.45);
  ctx.lineTo(x - bellW, y + bellH * 0.45);
  ctx.closePath();
  ctx.fill();

  // Bell rim
  ctx.strokeStyle = 'rgba(255, 240, 255, 0.85)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.ellipse(x, y, bellW, bellH, 0, Math.PI, 0, false);
  ctx.stroke();
}

function drawFish(f: Fish, stunned: boolean, now: number): void {
  ctx.save();
  ctx.translate(f.x, f.y);
  const flip = f.vx > 0 ? -1 : 1;
  ctx.scale(flip, 1);

  let alpha = 1;
  if (f.eaten) {
    const t = f.eatT / 260;
    alpha = 1 - t;
    const s = 1 + t * 0.4;
    ctx.scale(s, s);
  }

  // Body
  if (stunned) {
    ctx.fillStyle = `rgba(120, 210, 255, ${0.9 * alpha})`;
  } else {
    ctx.fillStyle = `hsla(${f.hue}, 70%, 55%, ${alpha})`;
  }
  ctx.beginPath();
  ctx.ellipse(0, 0, FISH_R, FISH_R * 0.6, 0, 0, Math.PI * 2);
  ctx.fill();

  // Tail
  ctx.beginPath();
  ctx.moveTo(FISH_R - 2, 0);
  ctx.lineTo(FISH_R + 10, -FISH_R * 0.5);
  ctx.lineTo(FISH_R + 10, FISH_R * 0.5);
  ctx.closePath();
  ctx.fill();

  // Eye
  ctx.fillStyle = `rgba(255,255,255,${alpha})`;
  ctx.beginPath();
  ctx.arc(-FISH_R * 0.5, -FISH_R * 0.15, 2.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = `rgba(20,20,20,${alpha})`;
  ctx.beginPath();
  ctx.arc(-FISH_R * 0.5, -FISH_R * 0.15, 1.2, 0, Math.PI * 2);
  ctx.fill();

  if (stunned) {
    // Stun sparkle: three small stars above
    ctx.fillStyle = `rgba(180, 240, 255, ${0.6 + 0.4 * Math.sin(now * 0.02)})`;
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.arc(-4 + i * 4, -FISH_R - 4, 1.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

function onPointerDown(e: PointerEvent): void {
  e.preventDefault();
  if (state === 'ready' || state === 'gameover') {
    startRound();
    return;
  }
  pulse();
}

function onKey(e: KeyboardEvent): void {
  const k = e.key;
  if (k === 'r' || k === 'R') {
    reset();
    e.preventDefault();
    return;
  }
  if (state === 'ready' || state === 'gameover') {
    if (k === ' ' || k === 'Enter') {
      startRound();
      e.preventDefault();
    }
    return;
  }
  if (state === 'playing' && (k === ' ' || k === 'ArrowUp' || k === 'w' || k === 'W')) {
    pulse();
    e.preventDefault();
  }
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  stunsEl = document.querySelector<HTMLElement>('#stuns')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;

  best = safeRead<number>(STORAGE_BEST, 0);
  bubbles = makeBubbles();

  canvas.addEventListener('pointerdown', onPointerDown);
  restartBtn.addEventListener('click', reset);
  overlayBtn.addEventListener('click', () => startRound());
  window.addEventListener('keydown', onKey);

  reset();
}

export const game = defineGame({ init, reset });
