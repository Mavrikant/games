import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import {
  showOverlay as showOverlayEl,
  hideOverlay as hideOverlayEl,
} from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';

type State = 'ready' | 'playing' | 'gameover';

const STORAGE_BEST = 'hava-balonu.best';

const W = 480;
const H = 480;

const Y_MIN = 50;
const Y_MAX = 440;

const FUEL_MAX = 100;
const FUEL_BASE_DRAIN = 1.6;
const FUEL_THRUST_DRAIN = 3.6;
const FUEL_PER_FLAG = 22;

const NEUTRAL_HEAT = 0.42;
const HEAT_UP_RATE = 1.6;
const HEAT_DOWN_RATE = 0.55;
const MAX_VY = 110;
const VY_LERP = 2.6;

const BALLOON_R = 18;
const FLAG_R = 14;

interface Band {
  top: number;
  bottom: number;
  vx: number;
  label: string;
  hue: number;
}

const BANDS: Band[] = [
  { top: 50, bottom: 145, vx: 75, label: '→ HIZLI', hue: 198 },
  { top: 145, bottom: 245, vx: -28, label: '← yavaş', hue: 282 },
  { top: 245, bottom: 345, vx: 30, label: '→ yavaş', hue: 24 },
  { top: 345, bottom: 440, vx: -78, label: '← HIZLI', hue: 158 },
];

interface Flag {
  x: number;
  y: number;
  bob: number;
}

interface Balloon {
  x: number;
  y: number;
  vy: number;
  heat: number;
}

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let fuelEl!: HTMLElement;
let bestEl!: HTMLElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let restartBtn!: HTMLButtonElement;

const gen = createGenToken();
let state: State = 'ready';
let score = 0;
let best = 0;
let fuel = FUEL_MAX;
let thrust = false;
let elapsed = 0;

let balloon: Balloon = { x: 80, y: 250, vy: 0, heat: NEUTRAL_HEAT };
let flags: Flag[] = [];

let lastFrame = 0;
let rafId: number | null = null;

function setScore(v: number): void {
  score = v;
  scoreEl.textContent = String(score);
}

function setFuel(v: number): void {
  fuel = Math.max(0, Math.min(FUEL_MAX, v));
  fuelEl.textContent = String(Math.round(fuel));
}

function setBest(v: number): void {
  best = v;
  bestEl.textContent = String(best);
}

function setOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlay);
}

function clearOverlay(): void {
  hideOverlayEl(overlay);
}

function bandAt(y: number): Band {
  for (const b of BANDS) {
    if (y >= b.top && y < b.bottom) return b;
  }
  return BANDS[BANDS.length - 1]!;
}

function spawnFlag(avoidX: number): Flag {
  const margin = 60;
  const minDistFromBalloon = 140;
  for (let attempt = 0; attempt < 24; attempt++) {
    const x = margin + Math.random() * (W - 2 * margin);
    const y = Y_MIN + 22 + Math.random() * (Y_MAX - Y_MIN - 44);
    const dx = Math.abs(x - avoidX);
    const wrapped = Math.min(dx, W - dx);
    if (wrapped >= minDistFromBalloon) {
      return { x, y, bob: Math.random() * Math.PI * 2 };
    }
  }
  return {
    x: (avoidX + W / 2) % W,
    y: Y_MIN + 30 + Math.random() * (Y_MAX - Y_MIN - 60),
    bob: 0,
  };
}

function ensureFlags(): void {
  while (flags.length < 3) {
    flags.push(spawnFlag(balloon.x));
  }
}

function reset(): void {
  gen.bump();
  stopLoop();
  state = 'ready';
  thrust = false;
  elapsed = 0;
  balloon = { x: 80, y: 250, vy: 0, heat: NEUTRAL_HEAT };
  flags = [];
  ensureFlags();
  setScore(0);
  setFuel(FUEL_MAX);
  draw();
  setOverlay(
    'Hava Balonu',
    "Brülör (Boşluk / ↑) ile yüksel, bırak — inersin.\nHer irtifada rüzgar farklı yönde eser; bayrağa ulaşmak için doğru bandı seç.\nBayrak topla, yakıt kazan.\n\nBaşlamak için tıkla ya da Boşluk'a bas.",
  );
}

function startGame(): void {
  if (state === 'playing') return;
  state = 'playing';
  thrust = false;
  elapsed = 0;
  balloon = { x: 80, y: 250, vy: 0, heat: NEUTRAL_HEAT };
  flags = [];
  ensureFlags();
  setScore(0);
  setFuel(FUEL_MAX);
  clearOverlay();
  lastFrame = performance.now();
  startLoop();
}

function endGame(): void {
  state = 'gameover';
  stopLoop();
  thrust = false;
  if (score > best) {
    setBest(score);
    safeWrite(STORAGE_BEST, best);
  }
  setOverlay(
    'Yakıt bitti',
    `Toplanan bayrak: ${score} · Rekor: ${best}\nTekrar denemek için tıkla ya da Boşluk'a bas.`,
  );
  draw();
}

function startLoop(): void {
  if (rafId !== null) return;
  const myGen = gen.current();
  const step = (now: number): void => {
    if (!gen.isCurrent(myGen) || state !== 'playing') {
      rafId = null;
      return;
    }
    const dt = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;
    update(dt);
    draw();
    rafId = requestAnimationFrame(step);
  };
  rafId = requestAnimationFrame(step);
}

function stopLoop(): void {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

function update(dt: number): void {
  elapsed += dt;

  if (thrust) {
    balloon.heat = Math.min(1, balloon.heat + dt * HEAT_UP_RATE);
  } else {
    balloon.heat = Math.max(0, balloon.heat - dt * HEAT_DOWN_RATE);
  }

  const targetVy = (NEUTRAL_HEAT - balloon.heat) * MAX_VY * 2;
  balloon.vy += (targetVy - balloon.vy) * Math.min(1, dt * VY_LERP);
  balloon.y += balloon.vy * dt;

  if (balloon.y < Y_MIN) {
    balloon.y = Y_MIN;
    if (balloon.vy < 0) balloon.vy = 0;
  } else if (balloon.y > Y_MAX) {
    balloon.y = Y_MAX;
    if (balloon.vy > 0) balloon.vy = 0;
  }

  const band = bandAt(balloon.y);
  balloon.x += band.vx * dt;
  if (balloon.x < -BALLOON_R) balloon.x += W + BALLOON_R * 2;
  if (balloon.x > W + BALLOON_R) balloon.x -= W + BALLOON_R * 2;

  let drain = FUEL_BASE_DRAIN;
  if (thrust) drain += FUEL_THRUST_DRAIN;
  setFuel(fuel - drain * dt);

  for (let i = flags.length - 1; i >= 0; i--) {
    const f = flags[i]!;
    f.bob += dt * 2.4;
    const dx = Math.abs(f.x - balloon.x);
    const dxWrap = Math.min(dx, W - dx);
    const dy = f.y - balloon.y;
    const reach = BALLOON_R + FLAG_R;
    if (dxWrap * dxWrap + dy * dy <= reach * reach) {
      flags.splice(i, 1);
      setScore(score + 1);
      setFuel(fuel + FUEL_PER_FLAG);
      flags.push(spawnFlag(balloon.x));
    }
  }

  if (fuel <= 0) {
    setFuel(0);
    endGame();
  }
}

function drawSky(): void {
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, '#0b1c3a');
  grad.addColorStop(0.55, '#1d3b6b');
  grad.addColorStop(1, '#f4a261');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  for (let i = 0; i < 30; i++) {
    const x = (i * 53.7) % W;
    const y = (i * 31.1) % 200;
    const a = ((i * 17) % 60) / 240 + 0.08;
    ctx.fillStyle = `rgba(255,255,255,${a.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(x, y, 1.2 + (i % 3) * 0.4, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawArrow(x: number, y: number, dir: number, size: number): void {
  ctx.beginPath();
  ctx.moveTo(x - (size / 2) * dir, y - size / 3);
  ctx.lineTo(x + (size / 2) * dir, y);
  ctx.lineTo(x - (size / 2) * dir, y + size / 3);
  ctx.closePath();
  ctx.fill();
}

function drawBands(): void {
  for (const b of BANDS) {
    ctx.fillStyle = `hsla(${b.hue}, 70%, 60%, 0.07)`;
    ctx.fillRect(0, b.top, W, b.bottom - b.top);
    ctx.strokeStyle = `hsla(${b.hue}, 70%, 70%, 0.25)`;
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.moveTo(0, b.top);
    ctx.lineTo(W, b.top);
    ctx.stroke();
    ctx.setLineDash([]);

    const dir = b.vx > 0 ? 1 : -1;
    const speed = Math.min(1, Math.abs(b.vx) / 80);
    const arrowCount = Math.round(3 + speed * 4);
    const cy = (b.top + b.bottom) / 2;
    const offset = (elapsed * b.vx * 0.5) % 80;
    ctx.fillStyle = `hsla(${b.hue}, 80%, 70%, ${(0.25 + speed * 0.35).toFixed(3)})`;
    for (let i = 0; i < arrowCount; i++) {
      const x = (i * 80 + offset + W * 2) % W;
      drawArrow(x, cy, dir, 12 + speed * 6);
    }

    ctx.fillStyle = `hsla(${b.hue}, 70%, 80%, 0.55)`;
    ctx.font = '600 10px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(b.label, 8, b.top + 14);
  }
}

function drawFlag(f: Flag): void {
  const sway = Math.sin(f.bob) * 2;
  const poleX = f.x;
  const topY = f.y - 18;
  const baseY = f.y + 16;

  ctx.strokeStyle = '#cbd5f5';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(poleX, topY);
  ctx.lineTo(poleX, baseY);
  ctx.stroke();

  ctx.fillStyle = '#fde047';
  ctx.beginPath();
  ctx.moveTo(poleX, topY);
  ctx.lineTo(poleX + 18 + sway, topY + 7);
  ctx.lineTo(poleX, topY + 14);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = 'rgba(253, 224, 71, 0.18)';
  ctx.beginPath();
  ctx.arc(f.x, f.y, FLAG_R + 6, 0, Math.PI * 2);
  ctx.fill();
}

function drawBalloon(b: Balloon): void {
  const wobble = Math.sin(elapsed * 1.6) * 0.6;

  if (thrust) {
    const flameH = 14 + Math.sin(elapsed * 30) * 4;
    const grad = ctx.createRadialGradient(b.x, b.y + 24, 2, b.x, b.y + 24 + flameH, 16);
    grad.addColorStop(0, 'rgba(255, 240, 160, 0.95)');
    grad.addColorStop(0.5, 'rgba(251, 146, 60, 0.7)');
    grad.addColorStop(1, 'rgba(239, 68, 68, 0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.ellipse(b.x, b.y + 24 + flameH * 0.4, 7, flameH, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.strokeStyle = 'rgba(203, 213, 245, 0.6)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(b.x - 6, b.y + 6);
  ctx.lineTo(b.x - 4, b.y + 22);
  ctx.moveTo(b.x + 6, b.y + 6);
  ctx.lineTo(b.x + 4, b.y + 22);
  ctx.stroke();

  ctx.fillStyle = '#7c2d12';
  ctx.fillRect(b.x - 7, b.y + 22, 14, 8);
  ctx.strokeStyle = '#451a03';
  ctx.lineWidth = 1;
  ctx.strokeRect(b.x - 7, b.y + 22, 14, 8);

  const balloonGrad = ctx.createRadialGradient(
    b.x - BALLOON_R * 0.4,
    b.y - BALLOON_R * 0.5,
    2,
    b.x,
    b.y,
    BALLOON_R * 1.4,
  );
  balloonGrad.addColorStop(0, '#fef3c7');
  balloonGrad.addColorStop(0.4, '#f97316');
  balloonGrad.addColorStop(1, '#9a3412');
  ctx.fillStyle = balloonGrad;
  ctx.beginPath();
  ctx.ellipse(b.x + wobble * 0.3, b.y, BALLOON_R, BALLOON_R + 2, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = 'rgba(124, 45, 18, 0.6)';
  ctx.lineWidth = 1;
  for (let i = -2; i <= 2; i++) {
    const offset = (i / 2) * BALLOON_R;
    ctx.beginPath();
    ctx.ellipse(b.x + offset * 0.5, b.y, Math.abs(offset) * 0.6 + 1, BALLOON_R + 2, 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  const heatColor = `hsla(${(1 - b.heat) * 60 + 200}, 80%, 70%, 0.85)`;
  ctx.fillStyle = heatColor;
  ctx.beginPath();
  ctx.arc(b.x, b.y - BALLOON_R - 6, 3, 0, Math.PI * 2);
  ctx.fill();
}

function drawHeatGauge(): void {
  const gx = W - 22;
  const gy = 60;
  const gh = 120;
  const gw = 8;

  ctx.fillStyle = 'rgba(15, 23, 42, 0.55)';
  ctx.fillRect(gx, gy, gw, gh);
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.45)';
  ctx.lineWidth = 1;
  ctx.strokeRect(gx, gy, gw, gh);

  const fillH = gh * balloon.heat;
  const grad = ctx.createLinearGradient(0, gy + gh - fillH, 0, gy + gh);
  grad.addColorStop(0, '#fde047');
  grad.addColorStop(1, '#dc2626');
  ctx.fillStyle = grad;
  ctx.fillRect(gx, gy + gh - fillH, gw, fillH);

  const neutralY = gy + gh - gh * NEUTRAL_HEAT;
  ctx.strokeStyle = '#94a3b8';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(gx - 3, neutralY);
  ctx.lineTo(gx + gw + 3, neutralY);
  ctx.stroke();

  ctx.fillStyle = 'rgba(226, 232, 240, 0.7)';
  ctx.font = '600 9px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText('ISI', gx + gw, gy - 4);
}

function drawFuelBar(): void {
  const fx = 16;
  const fy = 16;
  const fw = W - 32 - 28;
  const fh = 6;

  ctx.fillStyle = 'rgba(15, 23, 42, 0.55)';
  ctx.fillRect(fx, fy, fw, fh);
  const ratio = fuel / FUEL_MAX;
  const hue = ratio > 0.5 ? 150 : ratio > 0.25 ? 45 : 0;
  ctx.fillStyle = `hsl(${hue}, 80%, 55%)`;
  ctx.fillRect(fx, fy, fw * ratio, fh);
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.45)';
  ctx.lineWidth = 1;
  ctx.strokeRect(fx, fy, fw, fh);
}

function drawBalloonWrap(): void {
  drawBalloon(balloon);
  if (balloon.x < BALLOON_R + 4) {
    const ghost = { ...balloon, x: balloon.x + W };
    drawBalloon(ghost);
  } else if (balloon.x > W - BALLOON_R - 4) {
    const ghost = { ...balloon, x: balloon.x - W };
    drawBalloon(ghost);
  }
}

function draw(): void {
  drawSky();
  drawBands();
  for (const f of flags) drawFlag(f);
  drawBalloonWrap();
  drawFuelBar();
  drawHeatGauge();
}

function setThrust(on: boolean): void {
  if (state !== 'playing') {
    thrust = false;
    return;
  }
  thrust = on;
}

function onKeyDown(e: KeyboardEvent): void {
  const k = e.key;
  if (k === ' ' || k === 'ArrowUp' || k === 'Spacebar' || k === 'Up') {
    e.preventDefault();
    if (state === 'ready' || state === 'gameover') {
      startGame();
      return;
    }
    setThrust(true);
    return;
  }
  if (k === 'r' || k === 'R') {
    e.preventDefault();
    reset();
  }
}

function onKeyUp(e: KeyboardEvent): void {
  const k = e.key;
  if (k === ' ' || k === 'ArrowUp' || k === 'Spacebar' || k === 'Up') {
    e.preventDefault();
    setThrust(false);
  }
}

function onPointerDown(e: PointerEvent): void {
  e.preventDefault();
  if (state === 'ready' || state === 'gameover') {
    startGame();
    return;
  }
  setThrust(true);
}

function onPointerUp(): void {
  setThrust(false);
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  fuelEl = document.querySelector<HTMLElement>('#fuel')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;

  setBest(safeRead<number>(STORAGE_BEST, 0));

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointerleave', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  overlay.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (state === 'ready' || state === 'gameover') startGame();
  });
  restartBtn.addEventListener('click', () => {
    reset();
  });
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', () => {
    setThrust(false);
  });

  reset();
}

export const game = defineGame({ init, reset });
