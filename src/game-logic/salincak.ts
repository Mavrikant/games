import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';

type GameState = 'ready' | 'playing' | 'gameover';

const CANVAS_W = 480;
const CANVAS_H = 600;

const PIVOT_X = CANVAS_W / 2;
const PIVOT_Y = 120;
const CHAIN_LEN = 240;
const FOOT_OFFSET = 22;
const GROUND_Y = CANVAS_H - 80;

const G = 980;
const DAMPING = 0.05;
const PUMP_BOOST = 1.05;
const BRAKE_FACTOR = 0.93;
const FADE_ANGLE_DEG = 60;
const FADE_ANGLE = (FADE_ANGLE_DEG * Math.PI) / 180;
const MAX_ANGLE_DEG = 95;
const MAX_ANGLE = (MAX_ANGLE_DEG * Math.PI) / 180;

const STORAGE_BEST = 'salincak.best';

const gen = createGenToken();

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let angleEl!: HTMLElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let restartBtn!: HTMLButtonElement;

let state: GameState = 'ready';

let theta = 0;
let omega = 0;
let lastTime = 0;
let lastOmegaSign: -1 | 0 | 1 = 0;
let pumpedThisHalf = false;

let score = 0;
let best = 0;

interface Apple {
  angleAbs: number;
  side: -1 | 1;
  collected: boolean;
}
let apple: Apple | null = null;

interface Flash {
  type: 'good' | 'bad';
  time: number;
}
let lastFlash: Flash | null = null;

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  color: string;
}
let particles: Particle[] = [];
let chainShake = 0;
let bgPhase = 0;

const cssCache = new Map<string, string>();
function getCss(name: string): string {
  const c = cssCache.get(name);
  if (c !== undefined) return c;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  cssCache.set(name, v);
  return v;
}

function nextAppleDeg(): number {
  // 20, 30, 40, 50, 60, 70, 80, then random 62..86
  if (score < 7) return 20 + score * 10;
  return 62 + Math.random() * 24;
}

function setApple(deg: number): void {
  apple = {
    angleAbs: (deg * Math.PI) / 180,
    side: Math.random() < 0.5 ? -1 : 1,
    collected: false,
  };
}

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlay);
}
function hideOverlay(): void {
  hideOverlayEl(overlay);
}

function updateHud(): void {
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
  const deg = Math.round((Math.abs(theta) * 180) / Math.PI);
  angleEl.textContent = `${deg}°`;
}

function bumpBest(): void {
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
}

function reset(): void {
  gen.bump();
  state = 'ready';
  theta = 0;
  omega = 0;
  lastTime = 0;
  lastOmegaSign = 0;
  pumpedThisHalf = false;
  score = 0;
  particles = [];
  chainShake = 0;
  lastFlash = null;
  setApple(nextAppleDeg());
  updateHud();
  showOverlay(
    'Salıncak',
    'Boşluk veya tıkla → pompala.\nHer yarım turda BİR KEZ, aşağıdan hızla geçerken bas.\nElmaları topla — çok yükselme, zincir kopar.',
  );
}

function startPlaying(): void {
  if (state === 'gameover') {
    reset();
    return;
  }
  if (state === 'ready') {
    state = 'playing';
    hideOverlay();
    // Tiny initial impulse so the swing starts moving and the player
    // can begin pumping.
    omega = 0.55;
    lastOmegaSign = 1;
    pumpedThisHalf = false;
  }
}

function gameOver(reason: string): void {
  state = 'gameover';
  chainShake = 1;
  bumpBest();
  showOverlay(
    'Zincir koptu!',
    `${reason}\nElma: ${score} · Rekor: ${best}\nBoşluk, Enter veya R ile tekrar dene.`,
  );
}

function spawnPuff(kind: 'good' | 'bad'): void {
  const foot = getFootScreen(theta);
  const col = kind === 'good' ? getCss('--slc-good') : getCss('--slc-bad');
  for (let i = 0; i < 8; i++) {
    particles.push({
      x: foot.x,
      y: foot.y,
      vx: (Math.random() - 0.5) * 140,
      vy: -Math.random() * 140 - 40,
      life: 0.55,
      maxLife: 0.55,
      color: col,
    });
  }
}

function spawnAppleBurst(a: Apple): void {
  const pos = applePos(a);
  const cols = [getCss('--slc-apple'), getCss('--slc-good'), '#fef3c7'];
  for (let i = 0; i < 18; i++) {
    const ang = Math.random() * Math.PI * 2;
    const sp = Math.random() * 220 + 60;
    particles.push({
      x: pos.x,
      y: pos.y,
      vx: Math.cos(ang) * sp,
      vy: Math.sin(ang) * sp - 60,
      life: 0.75,
      maxLife: 0.75,
      color: cols[Math.floor(Math.random() * cols.length)]!,
    });
  }
}

function applePos(a: Apple): { x: number; y: number } {
  const r = CHAIN_LEN + FOOT_OFFSET + 18;
  const signed = a.angleAbs * a.side;
  return {
    x: PIVOT_X + r * Math.sin(signed),
    y: PIVOT_Y + r * Math.cos(signed),
  };
}

function getFootScreen(t: number): { x: number; y: number } {
  const r = CHAIN_LEN + FOOT_OFFSET;
  return {
    x: PIVOT_X + r * Math.sin(t),
    y: PIVOT_Y + r * Math.cos(t),
  };
}

function pump(): void {
  if (state === 'ready' || state === 'gameover') {
    startPlaying();
    return;
  }
  if (state !== 'playing') return;

  const absT = Math.abs(theta);
  const eff = Math.max(0, 1 - absT / FADE_ANGLE);

  // Already pumped this half-cycle, or near the apex → press becomes a brake.
  if (pumpedThisHalf || eff < 0.05) {
    omega *= BRAKE_FACTOR;
    lastFlash = { type: 'bad', time: 0 };
    spawnPuff('bad');
    return;
  }

  const dir: -1 | 1 = omega >= 0 ? 1 : -1;
  const boost = PUMP_BOOST * eff;
  omega += dir * boost;
  pumpedThisHalf = true;
  lastFlash = { type: 'good', time: 0 };
  spawnPuff('good');
}

function physicsStep(dt: number): void {
  // Pendulum equation
  const alpha = -(G / CHAIN_LEN) * Math.sin(theta);
  omega += alpha * dt;

  // Air + pivot damping (rate per second, integrated)
  omega -= DAMPING * omega * dt;

  theta += omega * dt;

  // Half-cycle reset: tracks when swing crosses through bottom
  const sign: -1 | 0 | 1 = omega > 0.01 ? 1 : omega < -0.01 ? -1 : 0;
  if (sign !== 0 && sign !== lastOmegaSign) {
    lastOmegaSign = sign;
    pumpedThisHalf = false;
  }

  // Apple grab: foot must reach apple's amplitude on apple's side
  if (apple && !apple.collected) {
    const onSide = Math.sign(theta) === apple.side;
    const reached = Math.abs(theta) >= apple.angleAbs - 0.015;
    if (onSide && reached) {
      apple.collected = true;
      score += 1;
      bumpBest();
      updateHud();
      spawnAppleBurst(apple);
      const myGen = gen.current();
      setTimeout(() => {
        if (!gen.isCurrent(myGen)) return;
        setApple(nextAppleDeg());
      }, 320);
    }
  }

  if (Math.abs(theta) > MAX_ANGLE) {
    gameOver('Çok hızlı pompaladın — zincir kopar.');
  }
}

function drawSky(): void {
  const grad = ctx.createLinearGradient(0, 0, 0, GROUND_Y);
  grad.addColorStop(0, getCss('--slc-sky-top'));
  grad.addColorStop(1, getCss('--slc-sky-bot'));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, CANVAS_W, GROUND_Y);

  // Sun
  ctx.fillStyle = getCss('--slc-sun');
  ctx.beginPath();
  ctx.arc(CANVAS_W - 70, 80, 26, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255, 235, 150, 0.35)';
  ctx.beginPath();
  ctx.arc(CANVAS_W - 70, 80, 40, 0, Math.PI * 2);
  ctx.fill();

  // Slow drifting clouds
  ctx.fillStyle = getCss('--slc-cloud');
  drawCloud(60 + Math.sin(bgPhase * 0.13) * 8, 60);
  drawCloud(320 + Math.cos(bgPhase * 0.09) * 10, 100);
  drawCloud(180 + Math.sin(bgPhase * 0.07 + 1) * 6, 40);
}

function drawCloud(x: number, y: number): void {
  ctx.beginPath();
  ctx.ellipse(x, y, 24, 10, 0, 0, Math.PI * 2);
  ctx.ellipse(x + 22, y + 4, 18, 8, 0, 0, Math.PI * 2);
  ctx.ellipse(x - 22, y + 4, 16, 7, 0, 0, Math.PI * 2);
  ctx.fill();
}

function drawGround(): void {
  ctx.fillStyle = getCss('--slc-grass');
  ctx.fillRect(0, GROUND_Y, CANVAS_W, CANVAS_H - GROUND_Y);
  ctx.fillStyle = getCss('--slc-grass-dark');
  ctx.fillRect(0, GROUND_Y, CANVAS_W, 4);
  // Grass tufts
  for (let x = 12; x < CANVAS_W; x += 22) {
    ctx.fillRect(x, GROUND_Y - 4, 1, 4);
    ctx.fillRect(x + 7, GROUND_Y - 3, 1, 3);
  }
}

function drawArcPath(): void {
  const r = CHAIN_LEN + FOOT_OFFSET + 4;
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  ctx.lineWidth = 1.2;
  ctx.setLineDash([4, 6]);
  ctx.beginPath();
  ctx.arc(PIVOT_X, PIVOT_Y, r, Math.PI / 2 - MAX_ANGLE, Math.PI / 2 + MAX_ANGLE);
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawFrame(): void {
  ctx.strokeStyle = getCss('--slc-frame');
  ctx.lineWidth = 9;
  ctx.lineCap = 'round';
  // Left post (A-frame)
  ctx.beginPath();
  ctx.moveTo(PIVOT_X - 120, GROUND_Y);
  ctx.lineTo(PIVOT_X - 8, PIVOT_Y);
  ctx.stroke();
  // Right post
  ctx.beginPath();
  ctx.moveTo(PIVOT_X + 120, GROUND_Y);
  ctx.lineTo(PIVOT_X + 8, PIVOT_Y);
  ctx.stroke();
  // Top beam
  ctx.lineWidth = 11;
  ctx.beginPath();
  ctx.moveTo(PIVOT_X - 90, PIVOT_Y - 2);
  ctx.lineTo(PIVOT_X + 90, PIVOT_Y - 2);
  ctx.stroke();
  // Pivot dot
  ctx.fillStyle = getCss('--slc-pivot');
  ctx.beginPath();
  ctx.arc(PIVOT_X, PIVOT_Y, 5, 0, Math.PI * 2);
  ctx.fill();
}

function drawSwing(): void {
  const seatX = PIVOT_X + CHAIN_LEN * Math.sin(theta);
  const seatY = PIVOT_Y + CHAIN_LEN * Math.cos(theta);

  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);
  const beamHalf = 14;
  const seatHalf = 22;

  // Seat ends (rotated to swing's tilt)
  const seatLx = seatX - seatHalf * cosT;
  const seatLy = seatY + seatHalf * sinT;
  const seatRx = seatX + seatHalf * cosT;
  const seatRy = seatY - seatHalf * sinT;

  const shake = chainShake > 0 ? (Math.random() - 0.5) * chainShake * 6 : 0;

  // Chains
  ctx.strokeStyle = getCss('--slc-chain');
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(PIVOT_X - beamHalf + shake, PIVOT_Y);
  ctx.lineTo(seatLx + shake, seatLy);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(PIVOT_X + beamHalf + shake, PIVOT_Y);
  ctx.lineTo(seatRx + shake, seatRy);
  ctx.stroke();

  // Seat plank
  ctx.save();
  ctx.translate(seatX + shake, seatY);
  ctx.rotate(-theta);
  ctx.fillStyle = getCss('--slc-seat');
  ctx.fillRect(-26, -3, 52, 8);
  ctx.fillStyle = getCss('--slc-seat-edge');
  ctx.fillRect(-26, -3, 52, 2);
  ctx.restore();

  drawKid(seatX + shake, seatY, -theta);
}

function drawKid(sx: number, sy: number, rot: number): void {
  ctx.save();
  ctx.translate(sx, sy - 2);
  ctx.rotate(rot);

  // legExt = how extended legs are (1 = straight out, 0.4 = tucked)
  const legExt = Math.max(0.35, 1 - Math.abs(theta) / (Math.PI * 0.55));

  // Torso
  ctx.fillStyle = getCss('--slc-shirt');
  ctx.beginPath();
  ctx.ellipse(0, -18, 8, 14, 0, 0, Math.PI * 2);
  ctx.fill();

  // Head
  ctx.fillStyle = getCss('--slc-skin');
  ctx.beginPath();
  ctx.arc(0, -36, 8, 0, Math.PI * 2);
  ctx.fill();

  // Hair (top half)
  ctx.fillStyle = getCss('--slc-hair');
  ctx.beginPath();
  ctx.arc(0, -38, 8, Math.PI, 0);
  ctx.fill();

  // Eye
  ctx.fillStyle = '#222';
  ctx.beginPath();
  ctx.arc(2, -36, 1.4, 0, Math.PI * 2);
  ctx.fill();

  // Smile
  ctx.strokeStyle = '#222';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(1, -33, 2.2, 0.1, Math.PI - 0.1);
  ctx.stroke();

  // Arms reaching to chains
  ctx.strokeStyle = getCss('--slc-skin');
  ctx.lineWidth = 3.5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(-6, -22);
  ctx.lineTo(-14, -14);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(6, -22);
  ctx.lineTo(14, -14);
  ctx.stroke();

  // Legs (extend based on legExt)
  ctx.strokeStyle = getCss('--slc-pants');
  ctx.lineWidth = 4.5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(-4, -4);
  ctx.lineTo(-6, 4 + 16 * legExt);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(4, -4);
  ctx.lineTo(6, 4 + 16 * legExt);
  ctx.stroke();

  // Shoes
  ctx.fillStyle = getCss('--slc-shoe');
  ctx.fillRect(-10, 4 + 16 * legExt - 1, 7, 4);
  ctx.fillRect(3, 4 + 16 * legExt - 1, 7, 4);

  ctx.restore();
}

function drawApple(): void {
  if (!apple || apple.collected) return;
  const pos = applePos(apple);
  const ampDelta = apple.angleAbs - Math.abs(theta);
  const closeness = Math.max(0, Math.min(1, 1 - ampDelta / 0.22));

  // Halo (pulses, grows with proximity)
  const t = performance.now() / 240;
  const haloR = 14 + closeness * 6 + Math.sin(t) * 1.5;
  ctx.fillStyle = `rgba(254, 240, 138, ${0.12 + closeness * 0.18})`;
  ctx.beginPath();
  ctx.arc(pos.x, pos.y, haloR, 0, Math.PI * 2);
  ctx.fill();

  // Apple
  ctx.fillStyle = getCss('--slc-apple');
  ctx.beginPath();
  ctx.arc(pos.x, pos.y, 10, 0, Math.PI * 2);
  ctx.fill();
  // Apple shadow side
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.beginPath();
  ctx.arc(pos.x + 3, pos.y + 2, 7, 0, Math.PI * 2);
  ctx.fill();
  // Apple shine
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.beginPath();
  ctx.arc(pos.x - 3, pos.y - 4, 2.2, 0, Math.PI * 2);
  ctx.fill();
  // Stem
  ctx.strokeStyle = getCss('--slc-apple-stem');
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(pos.x, pos.y - 9);
  ctx.lineTo(pos.x + 2, pos.y - 14);
  ctx.stroke();
  // Leaf
  ctx.fillStyle = getCss('--slc-apple-leaf');
  ctx.beginPath();
  ctx.ellipse(pos.x + 6, pos.y - 13, 4, 2, 0.5, 0, Math.PI * 2);
  ctx.fill();

  // Target angle ring on the arc path for guidance
  const r = CHAIN_LEN + FOOT_OFFSET + 4;
  const signed = apple.angleAbs * apple.side;
  // Canvas arc starts at +x axis (right), rotates clockwise.
  // Foot at theta=θ sits on the arc at canvas angle (π/2 - θ).
  const startAng = Math.PI / 2 - signed - 0.05;
  const endAng = Math.PI / 2 - signed + 0.05;
  ctx.strokeStyle = `rgba(255, 240, 150, ${0.4 + closeness * 0.4})`;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(PIVOT_X, PIVOT_Y, r, startAng, endAng);
  ctx.stroke();
}

function drawPhaseRing(): void {
  if (state !== 'playing') return;
  const cx = 38;
  const cy = CANVAS_H - 40;
  const r = 22;

  ctx.fillStyle = 'rgba(10, 11, 14, 0.55)';
  ctx.beginPath();
  ctx.arc(cx, cy, r + 5, 0, Math.PI * 2);
  ctx.fill();

  const absT = Math.abs(theta);
  const eff = Math.max(0, 1 - absT / FADE_ANGLE);
  const wouldBrake = pumpedThisHalf || eff < 0.05;

  let label = 'BAS';
  let color = getCss('--slc-good');
  if (wouldBrake) {
    label = 'FREN';
    color = getCss('--slc-bad');
  } else if (eff < 0.5) {
    color = getCss('--slc-warn');
  }

  const portion = wouldBrake ? 1 : eff;
  ctx.strokeStyle = color;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + portion * Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = '#fff';
  ctx.font = '700 11px Inter, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, cx, cy);
}

function drawAmpBar(): void {
  if (state !== 'playing') return;
  const w = 110;
  const h = 8;
  const x = CANVAS_W - w - 18;
  const y = CANVAS_H - 40;

  ctx.fillStyle = 'rgba(10, 11, 14, 0.5)';
  ctx.fillRect(x - 4, y - 4, w + 8, h + 8);

  ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
  ctx.fillRect(x, y, w, h);

  const amp = Math.min(1, Math.abs(theta) / MAX_ANGLE);
  let barCol = getCss('--slc-good');
  if (amp > 0.85) barCol = getCss('--slc-bad');
  else if (amp > 0.65) barCol = getCss('--slc-warn');
  ctx.fillStyle = barCol;
  ctx.fillRect(x, y, w * amp, h);

  // Apple target marker
  if (apple && !apple.collected) {
    const tx = x + w * (apple.angleAbs / MAX_ANGLE);
    ctx.fillStyle = '#fef3c7';
    ctx.fillRect(tx - 1, y - 3, 2, h + 6);
  }
  // Danger marker at 90°
  const dx = x + w * (Math.PI / 2 / MAX_ANGLE);
  ctx.strokeStyle = 'rgba(252, 165, 165, 0.7)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(dx, y - 3);
  ctx.lineTo(dx, y + h + 3);
  ctx.stroke();
}

function drawParticles(): void {
  for (const p of particles) {
    const a = Math.max(0, p.life / p.maxLife);
    ctx.fillStyle = p.color;
    ctx.globalAlpha = a;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 2.6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawFlash(): void {
  if (!lastFlash) return;
  const k = 1 - lastFlash.time / 0.5;
  if (k <= 0) return;
  const col =
    lastFlash.type === 'good'
      ? `rgba(134, 239, 172, ${k * 0.16})`
      : `rgba(252, 165, 165, ${k * 0.16})`;
  ctx.fillStyle = col;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
}

function draw(): void {
  drawSky();
  drawGround();
  drawArcPath();
  drawFrame();
  drawApple();
  drawSwing();
  drawParticles();
  drawAmpBar();
  drawPhaseRing();
  drawFlash();
}

function updateNonPhysics(dt: number): void {
  bgPhase += dt;
  for (const p of particles) {
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vy += 380 * dt;
    p.life -= dt;
  }
  particles = particles.filter((p) => p.life > 0);
  if (lastFlash) {
    lastFlash.time += dt;
    if (lastFlash.time >= 0.5) lastFlash = null;
  }
  if (chainShake > 0) chainShake = Math.max(0, chainShake - dt * 1.6);
}

function loop(now: number): void {
  if (lastTime === 0) lastTime = now;
  const dtMs = Math.min(50, now - lastTime);
  lastTime = now;
  const dt = dtMs / 1000;

  if (state === 'playing') {
    physicsStep(dt);
    updateHud();
  }
  updateNonPhysics(dt);
  draw();
  requestAnimationFrame(loop);
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  angleEl = document.querySelector<HTMLElement>('#angle')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    pump();
  });

  overlay.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    pump();
  });

  window.addEventListener('keydown', (e) => {
    const k = e.key;
    if (k === ' ' || k === 'Enter' || k === 'ArrowUp') {
      e.preventDefault();
      pump();
      return;
    }
    if (k.toLowerCase() === 'r') {
      e.preventDefault();
      reset();
    }
  });

  restartBtn.addEventListener('click', () => reset());

  reset();
  requestAnimationFrame(loop);
}

export const game = defineGame({ init, reset });
