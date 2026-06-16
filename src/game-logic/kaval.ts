import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';

const STORAGE_KEY = 'kaval.best';

const W = 480;
const H = 540;
const BASKET_TOP_Y = 470;
const HEAD_MIN_Y = 60;
const HEAD_MAX_Y = BASKET_TOP_Y - 14;
const HEAD_X = W / 2;

const SPRING = 110;
const DAMP = 11;

const BAND_BASE_HALF = 56;
const BAND_MIN_HALF = 22;
const BAND_BASE_AMP = 64;
const BAND_BASE_PERIOD = 6.5;
const LURK_GAIN_PER_SEC = 0.55;
const LURK_DECAY_PER_SEC = 0.42;

type GameState = 'ready' | 'playing' | 'gameover';

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlayEl!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;

let state: GameState = 'ready';
let pitchTarget = 0.5;
let headY = HEAD_MAX_Y;
let headVy = 0;
let bandCenter = (HEAD_MIN_Y + HEAD_MAX_Y) / 2;
let bandPhase = 0;
let lurk = 0;
let elapsed = 0;
let score = 0;
let best = 0;
let rafId: number | null = null;
let lastTime = 0;
let keyUp = false;
let keyDown = false;
let pointerActive = false;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp(v: number, lo: number, hi: number): number {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

function pitchToY(p: number): number {
  return lerp(HEAD_MAX_Y, HEAD_MIN_Y, clamp(p, 0, 1));
}

function bandHalfNow(): number {
  return Math.max(BAND_MIN_HALF, BAND_BASE_HALF - elapsed * 0.4);
}

function bandPeriodNow(): number {
  return Math.max(2.2, BAND_BASE_PERIOD - elapsed * 0.06);
}

function bandAmpNow(): number {
  return Math.min(150, BAND_BASE_AMP + elapsed * 0.9);
}

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlayEl);
}

function commitBest(): void {
  if (score > best) {
    best = score;
    safeWrite(STORAGE_KEY, best);
    bestEl.textContent = String(best);
  }
}

function reset(): void {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  state = 'ready';
  pitchTarget = 0.5;
  headY = HEAD_MAX_Y;
  headVy = 0;
  bandPhase = Math.random() * Math.PI * 2;
  bandCenter = (HEAD_MIN_Y + HEAD_MAX_Y) / 2;
  lurk = 0;
  elapsed = 0;
  score = 0;
  keyUp = false;
  keyDown = false;
  scoreEl.textContent = '0';
  bestEl.textContent = String(best);
  showOverlay('Kaval', 'Fareyi yukarı-aşağı kaydırarak ezgi yüksekliğini ayarla.\nKobranın başını sarı bandın içinde tut.\nBoşluk / tıkla — başla.');
  draw();
}

function startPlaying(): void {
  state = 'playing';
  hideOverlayEl(overlayEl);
  lastTime = performance.now();
  if (rafId === null) rafId = requestAnimationFrame(frame);
}

function gameOver(): void {
  state = 'gameover';
  commitBest();
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  showOverlay('Yılan ürktü!', `Skor: ${score}\nR veya Boşluk ile yeniden`);
  draw();
}

function pressGo(): void {
  if (state === 'ready') {
    startPlaying();
    return;
  }
  if (state === 'gameover') {
    reset();
    startPlaying();
  }
}

function update(dt: number): void {
  if (state !== 'playing') return;
  elapsed += dt;

  if (keyUp && !keyDown) pitchTarget = clamp(pitchTarget + dt * 0.95, 0, 1);
  else if (keyDown && !keyUp) pitchTarget = clamp(pitchTarget - dt * 0.95, 0, 1);

  const target = pitchToY(pitchTarget);
  const accel = (target - headY) * SPRING - headVy * DAMP;
  headVy += accel * dt;
  headY += headVy * dt;
  if (headY < HEAD_MIN_Y - 30) {
    headY = HEAD_MIN_Y - 30;
    headVy = Math.max(0, headVy);
  } else if (headY > HEAD_MAX_Y + 30) {
    headY = HEAD_MAX_Y + 30;
    headVy = Math.min(0, headVy);
  }

  bandPhase += dt * ((Math.PI * 2) / bandPeriodNow());
  const mid = (HEAD_MIN_Y + HEAD_MAX_Y) / 2;
  bandCenter = mid + Math.sin(bandPhase) * bandAmpNow() * 0.5;

  const half = bandHalfNow();
  const inside = Math.abs(headY - bandCenter) <= half;
  if (inside) {
    score += 1;
    scoreEl.textContent = String(score);
    lurk = Math.max(0, lurk - LURK_DECAY_PER_SEC * dt);
  } else {
    const overshoot = (Math.abs(headY - bandCenter) - half) / 80;
    const gain = LURK_GAIN_PER_SEC * (1 + clamp(overshoot, 0, 1.5));
    lurk = Math.min(1, lurk + gain * dt);
  }
  if (lurk >= 1) {
    gameOver();
  }
}

function drawBackground(): void {
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, '#2a1f12');
  grad.addColorStop(0.55, '#3d2c18');
  grad.addColorStop(1, '#1a120a');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = 'rgba(218, 165, 92, 0.08)';
  ctx.lineWidth = 1;
  for (let y = 30; y < H; y += 40) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y + 2);
    ctx.stroke();
  }

  const lampG = ctx.createRadialGradient(W / 2, 30, 4, W / 2, 30, 220);
  lampG.addColorStop(0, 'rgba(255, 210, 130, 0.32)');
  lampG.addColorStop(1, 'rgba(255, 210, 130, 0)');
  ctx.fillStyle = lampG;
  ctx.fillRect(0, 0, W, 260);
}

function drawBand(): void {
  const half = bandHalfNow();
  const y1 = bandCenter - half;
  const y2 = bandCenter + half;
  const grad = ctx.createLinearGradient(0, y1, 0, y2);
  grad.addColorStop(0, 'rgba(255, 220, 110, 0)');
  grad.addColorStop(0.5, 'rgba(255, 220, 110, 0.32)');
  grad.addColorStop(1, 'rgba(255, 220, 110, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, y1, W, y2 - y1);

  ctx.strokeStyle = 'rgba(255, 220, 110, 0.55)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 6]);
  ctx.beginPath();
  ctx.moveTo(0, bandCenter);
  ctx.lineTo(W, bandCenter);
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawBasket(): void {
  const top = BASKET_TOP_Y;
  const bottom = H - 12;
  const bx = W / 2;
  const w = 130;
  const w2 = 95;

  ctx.fillStyle = '#3a2510';
  ctx.beginPath();
  ctx.moveTo(bx - w / 2, top);
  ctx.lineTo(bx + w / 2, top);
  ctx.lineTo(bx + w2 / 2, bottom);
  ctx.lineTo(bx - w2 / 2, bottom);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = '#5b3a17';
  ctx.lineWidth = 1.2;
  for (let i = 1; i < 6; i++) {
    const t = i / 6;
    const y = top + (bottom - top) * t;
    const hw = (w / 2) * (1 - t) + (w2 / 2) * t;
    ctx.beginPath();
    ctx.moveTo(bx - hw, y);
    ctx.lineTo(bx + hw, y);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(91, 58, 23, 0.7)';
  for (let i = -3; i <= 3; i++) {
    const tx = i * 18;
    ctx.beginPath();
    ctx.moveTo(bx + tx, top);
    ctx.lineTo(bx + tx * 0.7, bottom);
    ctx.stroke();
  }

  ctx.fillStyle = '#231708';
  ctx.fillRect(bx - w / 2 - 4, top - 6, w + 8, 8);
  ctx.fillStyle = '#5b3a17';
  ctx.fillRect(bx - w / 2 - 4, top - 6, w + 8, 2);
}

function drawSnake(): void {
  const headX = HEAD_X;
  const hy = headY;
  const baseY = BASKET_TOP_Y - 4;
  const wob = Math.sin(elapsed * 3.0) * 6;

  const cp1x = headX - 38 + wob;
  const cp1y = lerp(baseY, hy, 0.35);
  const cp2x = headX + 26 - wob * 0.6;
  const cp2y = lerp(baseY, hy, 0.7);

  ctx.lineCap = 'round';

  ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
  ctx.lineWidth = 22;
  ctx.beginPath();
  ctx.moveTo(headX, baseY);
  ctx.bezierCurveTo(cp1x + 3, cp1y + 3, cp2x + 3, cp2y + 3, headX, hy + 4);
  ctx.stroke();

  ctx.strokeStyle = '#3c5a32';
  ctx.lineWidth = 18;
  ctx.beginPath();
  ctx.moveTo(headX, baseY);
  ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, headX, hy);
  ctx.stroke();

  ctx.strokeStyle = '#6a8a4c';
  ctx.lineWidth = 10;
  ctx.beginPath();
  ctx.moveTo(headX - 1, baseY);
  ctx.bezierCurveTo(cp1x - 1, cp1y, cp2x - 1, cp2y, headX - 2, hy);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(220, 230, 160, 0.55)';
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 9]);
  ctx.beginPath();
  ctx.moveTo(headX - 2, baseY);
  ctx.bezierCurveTo(cp1x - 2, cp1y, cp2x - 2, cp2y, headX - 3, hy);
  ctx.stroke();
  ctx.setLineDash([]);

  const tangentX = (headX - cp2x) * 3;
  const tangentY = (hy - cp2y) * 3;
  const tlen = Math.hypot(tangentX, tangentY) || 1;
  const dirX = tangentX / tlen;
  const dirY = tangentY / tlen;
  const normX = -dirY;
  const normY = dirX;

  ctx.save();
  ctx.translate(headX, hy);
  ctx.rotate(Math.atan2(dirY, dirX) + Math.PI / 2);

  ctx.fillStyle = '#3c5a32';
  ctx.beginPath();
  ctx.ellipse(-18, 6, 12, 16, 0, 0, Math.PI * 2);
  ctx.ellipse(18, 6, 12, 16, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#4f7340';
  ctx.beginPath();
  ctx.ellipse(0, 0, 13, 16, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#7ea257';
  ctx.beginPath();
  ctx.ellipse(0, -2, 10, 13, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#fff7d8';
  ctx.beginPath();
  ctx.arc(-4, -4, 2.4, 0, Math.PI * 2);
  ctx.arc(4, -4, 2.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#1a1006';
  ctx.beginPath();
  ctx.arc(-4, -4, 1.2, 0, Math.PI * 2);
  ctx.arc(4, -4, 1.2, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = '#c84a3a';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(0, 12);
  ctx.lineTo(-3, 18);
  ctx.moveTo(0, 12);
  ctx.lineTo(3, 18);
  ctx.stroke();

  ctx.restore();

  void normX;
  void normY;
}

function drawFlute(): void {
  const fx = 36;
  const fy = H - 80;
  ctx.save();
  ctx.translate(fx, fy);
  ctx.rotate(-0.35);
  ctx.fillStyle = '#0e0a05';
  ctx.fillRect(0, 0, 110, 11);
  ctx.fillStyle = '#a87a3a';
  ctx.fillRect(0, 1, 110, 9);
  ctx.fillStyle = '#0e0a05';
  for (let i = 0; i < 5; i++) {
    ctx.beginPath();
    ctx.arc(22 + i * 16, 5.5, 1.8, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = '#5b3a17';
  ctx.fillRect(0, 1, 6, 9);
  ctx.fillRect(104, 1, 6, 9);
  ctx.restore();

  const tipX = fx + 110 * Math.cos(-0.35);
  const tipY = fy + 110 * Math.sin(-0.35);
  const noteCount = 5;
  const t = elapsed;
  ctx.fillStyle = 'rgba(255, 220, 110, 0.55)';
  for (let i = 0; i < noteCount; i++) {
    const phase = (t * 0.6 + i / noteCount) % 1;
    const nx = tipX + 18 + phase * 36;
    const ny = tipY - 6 - phase * 22 + Math.sin(phase * Math.PI * 2 + i) * 4;
    const a = 1 - phase;
    ctx.globalAlpha = a * 0.6;
    ctx.beginPath();
    ctx.arc(nx, ny, 3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawHud(): void {
  ctx.fillStyle = 'rgba(0, 0, 0, 0.42)';
  ctx.fillRect(12, 14, 14, 240);
  ctx.fillStyle = '#202020';
  ctx.fillRect(14, 16, 10, 236);
  const meterH = 236 * lurk;
  const meterGrad = ctx.createLinearGradient(0, 16, 0, 252);
  meterGrad.addColorStop(0, '#f4d24a');
  meterGrad.addColorStop(0.6, '#e88438');
  meterGrad.addColorStop(1, '#d24336');
  ctx.fillStyle = meterGrad;
  ctx.fillRect(14, 252 - meterH, 10, meterH);
  ctx.strokeStyle = 'rgba(255, 220, 130, 0.55)';
  ctx.lineWidth = 1;
  ctx.strokeRect(14, 16, 10, 236);
  ctx.fillStyle = 'rgba(230, 200, 140, 0.85)';
  ctx.font = 'bold 9px ui-sans-serif, system-ui';
  ctx.textAlign = 'left';
  ctx.fillText('ÜRKME', 30, 26);

  if (state === 'playing') {
    ctx.fillStyle = 'rgba(255, 220, 130, 0.72)';
    ctx.font = 'bold 11px ui-sans-serif, system-ui';
    ctx.textAlign = 'right';
    ctx.fillText(`Süre ${elapsed.toFixed(1)}s`, W - 14, 22);
  }
}

function draw(): void {
  drawBackground();
  drawBand();
  drawFlute();
  drawBasket();
  drawSnake();
  drawHud();
}

function frame(now: number): void {
  rafId = null;
  const dt = Math.min(0.04, (now - lastTime) / 1000);
  lastTime = now;
  update(dt);
  draw();
  if (state === 'playing') {
    rafId = requestAnimationFrame(frame);
  }
}

function pointerToPitch(clientY: number): number {
  const rect = canvas.getBoundingClientRect();
  const yPx = clientY - rect.top;
  const yCanvas = (yPx / rect.height) * H;
  return clamp(1 - (yCanvas - HEAD_MIN_Y) / (HEAD_MAX_Y - HEAD_MIN_Y), 0, 1);
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlayEl = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;

  best = safeRead<number>(STORAGE_KEY, 0);

  window.addEventListener('keydown', (e) => {
    const k = e.key;
    if (k === 'ArrowUp' || k === 'w' || k === 'W') {
      keyUp = true;
      e.preventDefault();
    } else if (k === 'ArrowDown' || k === 's' || k === 'S') {
      keyDown = true;
      e.preventDefault();
    } else if (k === ' ' || k === 'Spacebar' || k === 'Enter') {
      pressGo();
      e.preventDefault();
    } else if (k === 'r' || k === 'R') {
      reset();
      e.preventDefault();
    }
  });

  window.addEventListener('keyup', (e) => {
    const k = e.key;
    if (k === 'ArrowUp' || k === 'w' || k === 'W') {
      keyUp = false;
    } else if (k === 'ArrowDown' || k === 's' || k === 'S') {
      keyDown = false;
    }
  });

  canvas.addEventListener('pointerdown', (e) => {
    if (state !== 'playing') {
      pressGo();
      return;
    }
    pointerActive = true;
    pitchTarget = pointerToPitch(e.clientY);
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!pointerActive || state !== 'playing') return;
    pitchTarget = pointerToPitch(e.clientY);
    e.preventDefault();
  });

  const endPointer = (e: PointerEvent) => {
    pointerActive = false;
    if (canvas.hasPointerCapture(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId);
    }
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  overlayEl.addEventListener('pointerdown', (e) => {
    pressGo();
    e.preventDefault();
  });

  restartBtn.addEventListener('click', () => {
    reset();
  });

  reset();
}

export const game = defineGame({ init, reset });
