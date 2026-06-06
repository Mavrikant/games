import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import {
  showOverlay as showOverlayEl,
  hideOverlay as hideOverlayEl,
} from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';
import { reportGameOver } from '@shared/leaderboard';

type State = 'ready' | 'playing' | 'gameover';

const STORAGE_BEST = 'ip-cambazi.best';
const SCORE_DESC = { gameId: 'ip-cambazi', storageKey: STORAGE_BEST, direction: 'higher' as const };
const MAX_TILT = (62 * Math.PI) / 180;
const GRAVITY_K = 3.0;
const HOLD_RATE = 4.4;
const TAP_KICK = 0.42;
const DAMPING_PER_SEC = 1.2;
const WALK_SPEED = 5.0;
const WIND_FIRST_DELAY = 1.6;
const WIND_MIN_INTERVAL = 1.0;
const WIND_MAX_INTERVAL_START = 2.8;
const WIND_MAX_INTERVAL_END = 1.1;
const WIND_STRENGTH_START = 0.32;
const WIND_STRENGTH_END = 1.35;
const RAMP_DISTANCE = 240;
const POLE_HALF_LEN = 95;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let windEl!: HTMLElement;
let overlayEl!: HTMLElement;
let overlayTitleEl!: HTMLElement;
let overlayMsgEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;

const gen = createGenToken();

let state: State = 'ready';
let theta = 0;
let omega = 0;
let distance = 0;
let best = 0;
let lastTime = 0;
let nextWindAt = 0;
let currentWind = 0;
let windPulseEnd = 0;
let rafHandle = 0;
let walkPhase = 0;

const keys = { left: false, right: false };
let pointerLeft = false;
let pointerRight = false;

function showOverlay(title: string, msg: string): void {
  overlayTitleEl.textContent = title;
  overlayMsgEl.textContent = msg;
  showOverlayEl(overlayEl);
}

function hideOverlay(): void {
  hideOverlayEl(overlayEl);
}

function difficultyT(): number {
  return Math.min(1, distance / RAMP_DISTANCE);
}

function scheduleNextWind(now: number, firstGust = false): void {
  if (firstGust) {
    nextWindAt = now + WIND_FIRST_DELAY * 1000;
    return;
  }
  const t = difficultyT();
  const maxInterval =
    WIND_MAX_INTERVAL_START +
    (WIND_MAX_INTERVAL_END - WIND_MAX_INTERVAL_START) * t;
  const interval =
    WIND_MIN_INTERVAL + Math.random() * (maxInterval - WIND_MIN_INTERVAL);
  nextWindAt = now + interval * 1000;
}

function triggerWind(now: number): void {
  const t = difficultyT();
  const strength =
    WIND_STRENGTH_START + (WIND_STRENGTH_END - WIND_STRENGTH_START) * t;
  const dir = Math.random() < 0.5 ? -1 : 1;
  const impulse = dir * (0.45 + Math.random() * 0.75) * strength;
  omega += impulse;
  currentWind = impulse;
  windPulseEnd = now + 650;
  windEl.textContent = impulse > 0 ? '→' : '←';
  scheduleNextWind(now);
}

function step(now: number): void {
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;

  if (now >= nextWindAt) triggerWind(now);
  if (now >= windPulseEnd && currentWind !== 0) {
    currentWind = 0;
    windEl.textContent = '—';
  }

  const leaningLeft = keys.left || pointerLeft;
  const leaningRight = keys.right || pointerRight;
  if (leaningLeft) omega -= HOLD_RATE * dt;
  if (leaningRight) omega += HOLD_RATE * dt;

  omega += GRAVITY_K * Math.sin(theta) * dt;
  omega *= Math.exp(-DAMPING_PER_SEC * dt);
  theta += omega * dt;

  distance += WALK_SPEED * dt;
  walkPhase += dt * 4;
  scoreEl.textContent = String(Math.floor(distance));

  if (Math.abs(theta) >= MAX_TILT) {
    theta = Math.sign(theta) * MAX_TILT;
    fall();
    return;
  }
  draw();
}

function fall(): void {
  state = 'gameover';
  cancelLoop();
  const finalScore = Math.floor(distance);
  if (finalScore > best) {
    best = finalScore;
    safeWrite(STORAGE_BEST, best);
    bestEl.textContent = String(best);
  }
  reportGameOver(SCORE_DESC, finalScore, { label: 'Mesafe', unit: 'm' });
  draw();
  showOverlay(
    'Düştün!',
    `Mesafe: ${finalScore} m · Tekrar denemek için R veya yön tuşu.`,
  );
}

function cancelLoop(): void {
  if (rafHandle !== 0) {
    cancelAnimationFrame(rafHandle);
    rafHandle = 0;
  }
}

function startLoop(): void {
  lastTime = performance.now();
  scheduleNextWind(lastTime, true);
  const myGen = gen.current();
  const loop = (now: number): void => {
    if (!gen.isCurrent(myGen)) return;
    if (state !== 'playing') return;
    step(now);
    if (state === 'playing') rafHandle = requestAnimationFrame(loop);
  };
  rafHandle = requestAnimationFrame(loop);
}

function start(): void {
  if (state !== 'ready') return;
  state = 'playing';
  hideOverlay();
  startLoop();
}

function reset(): void {
  gen.bump();
  cancelLoop();
  state = 'ready';
  theta = 0;
  omega = 0;
  distance = 0;
  walkPhase = 0;
  currentWind = 0;
  windPulseEnd = 0;
  nextWindAt = 0;
  keys.left = false;
  keys.right = false;
  pointerLeft = false;
  pointerRight = false;
  scoreEl.textContent = '0';
  bestEl.textContent = String(best);
  windEl.textContent = '—';
  draw();
  showOverlay(
    'İp Cambazı',
    '← / → veya A / D ile dengeyi koru. Başlamak için bir yön tuşuna bas.',
  );
}

function draw(): void {
  const w = canvas.width;
  const h = canvas.height;

  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, '#1a1340');
  sky.addColorStop(0.55, '#5d3a73');
  sky.addColorStop(0.85, '#c97a5a');
  sky.addColorStop(1, '#f3b27a');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);

  drawStars(w, h);
  drawSun(w, h);
  drawMountains(w, h, 0.62, '#2a2042', -distance * 6);
  drawMountains(w, h, 0.72, '#1a1430', -distance * 12);

  const ropeY = h * 0.78;
  drawRope(w, ropeY);

  drawPosts(w, h, ropeY);

  const cx = w / 2;
  ctx.save();
  ctx.translate(cx, ropeY);
  ctx.rotate(theta);
  drawWalker();
  ctx.restore();

  if (currentWind !== 0) drawWindStreaks(currentWind, w, h);

  drawTiltMeter(w);
}

function drawStars(w: number, h: number): void {
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  const seeds = [
    [40, 30], [90, 70], [160, 40], [220, 90], [300, 50],
    [360, 80], [420, 30], [55, 110], [180, 130], [275, 120],
    [340, 150], [410, 110], [120, 165], [240, 180], [380, 200],
  ];
  for (const [x, y] of seeds) {
    ctx.fillRect(
      (x! / 480) * w,
      (y! / 480) * h,
      1.5,
      1.5,
    );
  }
}

function drawSun(w: number, h: number): void {
  const cx = w * 0.78;
  const cy = h * 0.55;
  const r = w * 0.07;
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 2.5);
  g.addColorStop(0, 'rgba(255, 220, 160, 0.95)');
  g.addColorStop(0.4, 'rgba(255, 170, 100, 0.55)');
  g.addColorStop(1, 'rgba(255, 140, 80, 0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 2.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ffd9a8';
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
}

function drawMountains(
  w: number,
  h: number,
  yRatio: number,
  color: string,
  scrollPx: number,
): void {
  const baseY = h * yRatio;
  const peakSpacing = 80;
  const off = ((scrollPx % peakSpacing) + peakSpacing) % peakSpacing;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(-off, h);
  ctx.lineTo(-off, baseY);
  const peakHeights = [40, 70, 55, 85, 50, 75, 60, 90, 45];
  let x = -off;
  let i = 0;
  while (x <= w + peakSpacing) {
    const ph = peakHeights[(i + Math.floor(scrollPx / peakSpacing)) % peakHeights.length]!;
    ctx.lineTo(x + peakSpacing / 2, baseY - ph);
    ctx.lineTo(x + peakSpacing, baseY);
    x += peakSpacing;
    i++;
  }
  ctx.lineTo(w + 10, h);
  ctx.closePath();
  ctx.fill();
}

function drawRope(w: number, ropeY: number): void {
  ctx.strokeStyle = '#d4a574';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(0, ropeY);
  ctx.lineTo(w, ropeY);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(80, 40, 20, 0.55)';
  ctx.lineWidth = 1;
  const tick = 14;
  const off = ((distance * 30) % tick + tick) % tick;
  for (let x = -off; x < w; x += tick) {
    ctx.beginPath();
    ctx.moveTo(x, ropeY - 2);
    ctx.lineTo(x + 4, ropeY + 2);
    ctx.stroke();
  }
}

function drawPosts(w: number, h: number, ropeY: number): void {
  ctx.fillStyle = '#3a2a1a';
  ctx.fillRect(-12, ropeY, 14, h - ropeY);
  ctx.fillRect(w - 2, ropeY, 14, h - ropeY);
}

function drawWalker(): void {
  const bodyH = 60;
  const headR = 8;
  const armY = -bodyH * 0.55;

  ctx.strokeStyle = '#fafafa';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';

  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, -bodyH);
  ctx.stroke();

  ctx.fillStyle = '#fafafa';
  ctx.beginPath();
  ctx.arc(0, -bodyH - headR + 2, headR, 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(0, armY);
  ctx.lineTo(-14, armY - 6);
  ctx.moveTo(0, armY);
  ctx.lineTo(14, armY - 6);
  ctx.stroke();

  const swing = state === 'playing' ? Math.sin(walkPhase) * 5 : 0;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(-5 + swing, 14);
  ctx.moveTo(0, 0);
  ctx.lineTo(5 - swing, 14);
  ctx.stroke();

  ctx.strokeStyle = '#c7884a';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(-POLE_HALF_LEN, armY - 6);
  ctx.lineTo(POLE_HALF_LEN, armY - 6);
  ctx.stroke();

  ctx.fillStyle = '#c7884a';
  ctx.beginPath();
  ctx.arc(-POLE_HALF_LEN, armY - 6, 3.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(POLE_HALF_LEN, armY - 6, 3.5, 0, Math.PI * 2);
  ctx.fill();
}

function drawWindStreaks(wind: number, w: number, h: number): void {
  ctx.save();
  ctx.strokeStyle = `rgba(220, 230, 255, ${Math.min(0.55, Math.abs(wind) * 0.45)})`;
  ctx.lineWidth = 1;
  const dir = wind > 0 ? 1 : -1;
  const tNow = performance.now();
  for (let i = 0; i < 16; i++) {
    const y = ((i / 16) * h + (tNow * 0.15) % 40) % h;
    const baseX = (i * 73 + tNow * 0.6) % (w + 80);
    const startX = dir > 0 ? baseX - 40 : w - baseX + 40;
    ctx.beginPath();
    ctx.moveTo(startX, y);
    ctx.lineTo(startX + dir * 32, y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawTiltMeter(w: number): void {
  const mw = Math.min(220, w * 0.5);
  const mh = 8;
  const mx = (w - mw) / 2;
  const my = 14;
  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  ctx.fillRect(mx, my, mw, mh);
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.fillRect(mx + mw / 2 - 1, my - 3, 2, mh + 6);
  const t = Math.max(-1, Math.min(1, theta / MAX_TILT));
  const cx = mx + mw / 2 + (t * mw) / 2;
  const dangerous = Math.abs(t) > 0.7;
  ctx.fillStyle = dangerous ? '#fb7185' : '#34d399';
  ctx.fillRect(cx - 3, my - 3, 6, mh + 6);
}

function onKey(e: KeyboardEvent, down: boolean): void {
  const k = e.key.toLowerCase();
  let handled = true;
  if (k === 'arrowleft' || k === 'a') {
    keys.left = down;
    if (down) handleStartTrigger(-1);
  } else if (k === 'arrowright' || k === 'd') {
    keys.right = down;
    if (down) handleStartTrigger(+1);
  } else if (k === 'r' && down) {
    reset();
  } else if ((k === ' ' || k === 'enter') && down) {
    if (state === 'ready') start();
    else if (state === 'gameover') {
      reset();
      start();
    }
  } else {
    handled = false;
  }
  if (handled) e.preventDefault();
}

function handleStartTrigger(sign: -1 | 1): void {
  if (state === 'gameover') {
    reset();
    start();
    omega += sign * TAP_KICK;
    return;
  }
  if (state === 'ready') {
    start();
  }
  omega += sign * TAP_KICK;
}

function setupPointer(): void {
  const update = (ev: PointerEvent, down: boolean): void => {
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const isLeft = x < rect.width / 2;
    if (down) {
      if (isLeft) {
        pointerLeft = true;
        pointerRight = false;
        handleStartTrigger(-1);
      } else {
        pointerRight = true;
        pointerLeft = false;
        handleStartTrigger(+1);
      }
    } else {
      pointerLeft = false;
      pointerRight = false;
    }
  };
  canvas.addEventListener('pointerdown', (e) => {
    update(e, true);
    e.preventDefault();
  });
  canvas.addEventListener('pointerup', (e) => update(e, false));
  canvas.addEventListener('pointercancel', (e) => update(e, false));
  canvas.addEventListener('pointerleave', (e) => update(e, false));
}

function setupTouchButtons(): void {
  document.querySelectorAll<HTMLButtonElement>('.touch__btn').forEach((btn) => {
    const dir = btn.dataset['dir'] === 'left' ? -1 : 1;
    const setHeld = (held: boolean): void => {
      if (dir === -1) pointerLeft = held;
      else pointerRight = held;
    };
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      setHeld(true);
      handleStartTrigger(dir as -1 | 1);
    });
    btn.addEventListener('pointerup', () => setHeld(false));
    btn.addEventListener('pointercancel', () => setHeld(false));
    btn.addEventListener('pointerleave', () => setHeld(false));
  });
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  windEl = document.querySelector<HTMLElement>('#wind')!;
  overlayEl = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitleEl = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsgEl = document.querySelector<HTMLElement>('#overlay-msg')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  window.addEventListener('keydown', (e) => onKey(e, true));
  window.addEventListener('keyup', (e) => onKey(e, false));
  setupPointer();
  setupTouchButtons();
  restartBtn.addEventListener('click', reset);

  reset();
}

export const game = defineGame({ init, reset });
