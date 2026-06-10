import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';

const W = 480;
const H = 640;
const PIN_R = 5;
const BALL_R = 7;
const GRAV = 0.32;
const REST = 0.55;
const BUCKETS = 9;
const BUCKET_W = W / BUCKETS;
const BUCKET_TOP_Y = 552;
const PIN_AREA_TOP = 96;
const PIN_AREA_BOTTOM = 520;
const PIN_ROWS = 8;
const PIN_SPACING_X = W / 10;
const PIN_ROW_H = (PIN_AREA_BOTTOM - PIN_AREA_TOP) / (PIN_ROWS - 1);
const CURSOR_Y = 56;
const BALLS_PER_GAME = 10;
const STORAGE_BEST = 'top-dustur.best';

type State = 'ready' | 'aiming' | 'falling' | 'gameover';

interface Pin {
  x: number;
  y: number;
  flash: number;
}

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let ballsEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let dropBtn!: HTMLButtonElement;
let startBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;

let state: State = 'ready';
let pins: Pin[] = [];
let cursorX = W / 2;
let ballX = W / 2;
let ballY = CURSOR_Y;
let ballVx = 0;
let ballVy = 0;
let score = 0;
let best = 0;
let ballsLeft = BALLS_PER_GAME;
let targetIdx = 4;
let streak = 0;
let lastResultMsg = '';
let lastResultTimer = 0;
const bucketFlash: number[] = new Array(BUCKETS).fill(0);
let leftKey = false;
let rightKey = false;

function buildPins(): void {
  pins = [];
  for (let r = 0; r < PIN_ROWS; r++) {
    const y = PIN_AREA_TOP + r * PIN_ROW_H;
    const offsetRow = r % 2 === 0;
    const pinsInRow = offsetRow ? 10 : 9;
    const startX = offsetRow ? PIN_SPACING_X / 2 : PIN_SPACING_X;
    for (let i = 0; i < pinsInRow; i++) {
      pins.push({ x: startX + i * PIN_SPACING_X, y, flash: 0 });
    }
  }
}

function pickTarget(): void {
  let next = Math.floor(Math.random() * BUCKETS);
  if (next === targetIdx) {
    next = (next + 1 + Math.floor(Math.random() * (BUCKETS - 1))) % BUCKETS;
  }
  targetIdx = next;
}

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlay);
}

function hideOverlay(): void {
  hideOverlayEl(overlay);
}

function syncHud(): void {
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
  ballsEl.textContent = String(ballsLeft);
}

function reset(): void {
  state = 'ready';
  score = 0;
  ballsLeft = BALLS_PER_GAME;
  streak = 0;
  lastResultMsg = '';
  lastResultTimer = 0;
  bucketFlash.fill(0);
  cursorX = W / 2;
  ballX = cursorX;
  ballY = CURSOR_Y;
  ballVx = 0;
  ballVy = 0;
  buildPins();
  pickTarget();
  syncHud();
  showOverlay(
    'Top Düşür',
    'Fare/ok ile nişan al, tıkla veya Boşluk ile topu bırak.\nVurgulanan HEDEF kovaya isabet et.',
  );
}

function startGame(): void {
  if (state === 'gameover') reset();
  if (state !== 'ready') return;
  state = 'aiming';
  hideOverlay();
}

function dropBall(): void {
  if (state !== 'aiming') return;
  if (ballsLeft <= 0) return;
  ballX = cursorX;
  ballY = CURSOR_Y + BALL_R;
  ballVx = (Math.random() - 0.5) * 0.4;
  ballVy = 0;
  state = 'falling';
}

function landBall(bucketIdx: number): void {
  const dist = Math.abs(bucketIdx - targetIdx);
  let gained: number;
  if (dist === 0) gained = 100;
  else if (dist === 1) gained = 50;
  else if (dist === 2) gained = 20;
  else gained = 5;

  if (dist === 0) {
    streak += 1;
    const bonus = streak >= 2 ? 50 * (streak - 1) : 0;
    gained += bonus;
    lastResultMsg = streak >= 2 ? `Tam isabet × ${streak}!  +${gained}` : `Tam isabet!  +${gained}`;
  } else {
    streak = 0;
    if (dist === 1) lastResultMsg = `Yakın!  +${gained}`;
    else if (dist === 2) lastResultMsg = `Az kaldı.  +${gained}`;
    else lastResultMsg = `Kaçtı.  +${gained}`;
  }

  score += gained;
  ballsLeft -= 1;
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
  bucketFlash[bucketIdx] = 1;
  lastResultTimer = 70;
  syncHud();

  if (ballsLeft <= 0) {
    state = 'gameover';
    showOverlay(
      'Tur bitti',
      `Skor: ${score}\nRekor: ${best}\n"Başla" ile yeniden.`,
    );
  } else {
    pickTarget();
    state = 'aiming';
  }
}

function step(): void {
  for (const p of pins) {
    if (p.flash > 0) p.flash = Math.max(0, p.flash - 0.05);
  }
  for (let i = 0; i < bucketFlash.length; i++) {
    const v = bucketFlash[i]!;
    if (v > 0) bucketFlash[i] = Math.max(0, v - 0.02);
  }
  if (lastResultTimer > 0) lastResultTimer -= 1;

  if (state === 'aiming') {
    const speed = 4.2;
    if (leftKey) cursorX -= speed;
    if (rightKey) cursorX += speed;
    cursorX = Math.max(BALL_R + 4, Math.min(W - BALL_R - 4, cursorX));
  }

  if (state === 'falling') {
    ballVy += GRAV;
    ballX += ballVx;
    ballY += ballVy;

    if (ballX < BALL_R) {
      ballX = BALL_R;
      ballVx = Math.abs(ballVx) * REST;
    }
    if (ballX > W - BALL_R) {
      ballX = W - BALL_R;
      ballVx = -Math.abs(ballVx) * REST;
    }

    for (const pin of pins) {
      const dx = ballX - pin.x;
      const dy = ballY - pin.y;
      const dist = Math.hypot(dx, dy);
      const minDist = PIN_R + BALL_R;
      if (dist < minDist) {
        const safeDist = dist || 0.001;
        const nx = dx / safeDist;
        const ny = dy / safeDist;
        const dot = ballVx * nx + ballVy * ny;
        ballVx = (ballVx - 2 * dot * nx) * REST;
        ballVy = (ballVy - 2 * dot * ny) * REST;
        ballVx += (Math.random() - 0.5) * 0.5;
        const overlap = minDist - dist;
        ballX += nx * overlap;
        ballY += ny * overlap;
        pin.flash = 1;
      }
    }

    if (ballY >= BUCKET_TOP_Y - BALL_R) {
      const idx = Math.max(0, Math.min(BUCKETS - 1, Math.floor(ballX / BUCKET_W)));
      landBall(idx);
    }
  }
}

const cssCache = new Map<string, string>();
function getCss(varName: string, fallback: string): string {
  const cached = cssCache.get(varName);
  if (cached !== undefined) return cached || fallback;
  const val = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  cssCache.set(varName, val);
  return val || fallback;
}

function draw(): void {
  const bg = getCss('--surface', '#14171c');
  const bg2 = getCss('--surface-2', '#1c2027');
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, bg);
  grad.addColorStop(1, bg2);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = 'rgba(129, 140, 248, 0.05)';
  ctx.fillRect(0, PIN_AREA_TOP - 8, W, PIN_AREA_BOTTOM - PIN_AREA_TOP + 24);

  const accent = getCss('--accent', '#818cf8');
  const accent2 = getCss('--accent-2', '#38bdf8');

  if (state === 'aiming') {
    ctx.strokeStyle = 'rgba(129, 140, 248, 0.28)';
    ctx.setLineDash([3, 6]);
    ctx.beginPath();
    ctx.moveTo(cursorX, CURSOR_Y + BALL_R);
    ctx.lineTo(cursorX, PIN_AREA_TOP - 6);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(cursorX, CURSOR_Y, BALL_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
    ctx.beginPath();
    ctx.arc(cursorX - 2, CURSOR_Y - 2, 2.2, 0, Math.PI * 2);
    ctx.fill();
  }

  for (const p of pins) {
    if (p.flash > 0) {
      ctx.fillStyle = `rgba(56, 189, 248, ${0.25 + p.flash * 0.55})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, PIN_R + 1 + p.flash * 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#aab3c2';
    ctx.beginPath();
    ctx.arc(p.x, p.y, PIN_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.beginPath();
    ctx.arc(p.x - 1.4, p.y - 1.4, 1.6, 0, Math.PI * 2);
    ctx.fill();
  }

  for (let i = 0; i < BUCKETS; i++) {
    const x0 = i * BUCKET_W;
    const isTarget = i === targetIdx;
    const dist = Math.abs(i - targetIdx);
    const flash = bucketFlash[i]!;

    let fill: string;
    if (isTarget) fill = 'rgba(99, 102, 241, 0.55)';
    else if (dist === 1) fill = 'rgba(56, 189, 248, 0.22)';
    else if (dist === 2) fill = 'rgba(56, 189, 248, 0.10)';
    else fill = 'rgba(255, 255, 255, 0.04)';

    ctx.fillStyle = fill;
    ctx.fillRect(x0 + 1, BUCKET_TOP_Y, BUCKET_W - 2, H - BUCKET_TOP_Y);

    if (flash > 0) {
      ctx.fillStyle = `rgba(52, 211, 153, ${0.55 * flash})`;
      ctx.fillRect(x0 + 1, BUCKET_TOP_Y, BUCKET_W - 2, H - BUCKET_TOP_Y);
    }

    ctx.fillStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.fillRect(x0, BUCKET_TOP_Y, 1, H - BUCKET_TOP_Y);

    const points = dist === 0 ? 100 : dist === 1 ? 50 : dist === 2 ? 20 : 5;
    ctx.fillStyle = isTarget ? '#ffffff' : dist <= 2 ? '#cdd5e2' : '#6c7585';
    ctx.font = '700 15px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(points), x0 + BUCKET_W / 2, BUCKET_TOP_Y + 26);

    if (isTarget) {
      ctx.fillStyle = '#a5b4fc';
      ctx.font = '700 9px Inter, system-ui, sans-serif';
      ctx.fillText('HEDEF', x0 + BUCKET_W / 2, H - 14);
    }
  }
  ctx.fillStyle = 'rgba(255, 255, 255, 0.18)';
  ctx.fillRect(W - 1, BUCKET_TOP_Y, 1, H - BUCKET_TOP_Y);
  ctx.fillRect(0, BUCKET_TOP_Y, W, 1);

  if (state === 'falling') {
    ctx.fillStyle = accent2;
    ctx.beginPath();
    ctx.arc(ballX, ballY, BALL_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.beginPath();
    ctx.arc(ballX - 2, ballY - 2, 2.4, 0, Math.PI * 2);
    ctx.fill();
  }

  if (lastResultTimer > 0 && lastResultMsg) {
    const alpha = Math.min(1, lastResultTimer / 30);
    ctx.font = '700 15px Inter, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    const textW = ctx.measureText(lastResultMsg).width;
    const padX = 14;
    const boxW = textW + padX * 2;
    const boxX = (W - boxW) / 2;
    ctx.fillStyle = `rgba(20, 23, 28, ${0.82 * alpha})`;
    ctx.strokeStyle = `rgba(129, 140, 248, ${0.45 * alpha})`;
    ctx.lineWidth = 1;
    const boxY = 14;
    const boxH = 28;
    ctx.fillRect(boxX, boxY, boxW, boxH);
    ctx.strokeRect(boxX + 0.5, boxY + 0.5, boxW - 1, boxH - 1);
    ctx.fillStyle = `rgba(245, 246, 248, ${alpha})`;
    ctx.textAlign = 'center';
    ctx.fillText(lastResultMsg, W / 2, boxY + boxH / 2 + 1);
  }

  if (streak >= 2) {
    ctx.fillStyle = 'rgba(52, 211, 153, 0.9)';
    ctx.font = '700 12px Inter, system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText(`Seri × ${streak}`, W - 14, 14);
  }
}

function loop(): void {
  step();
  draw();
  requestAnimationFrame(loop);
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  ballsEl = document.querySelector<HTMLElement>('#balls')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  dropBtn = document.querySelector<HTMLButtonElement>('#drop')!;
  startBtn = document.querySelector<HTMLButtonElement>('#start-btn')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  canvas.addEventListener('pointermove', (e) => {
    if (state !== 'aiming') return;
    const rect = canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * W;
    cursorX = Math.max(BALL_R + 4, Math.min(W - BALL_R - 4, x));
  });

  canvas.addEventListener('pointerdown', (e) => {
    if (state === 'aiming') {
      const rect = canvas.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * W;
      cursorX = Math.max(BALL_R + 4, Math.min(W - BALL_R - 4, x));
      dropBall();
      e.preventDefault();
    }
  });

  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'arrowleft' || k === 'a') {
      leftKey = true;
      e.preventDefault();
    } else if (k === 'arrowright' || k === 'd') {
      rightKey = true;
      e.preventDefault();
    } else if (k === ' ' || k === 'enter') {
      if (state === 'ready' || state === 'gameover') startGame();
      else if (state === 'aiming') dropBall();
      e.preventDefault();
    } else if (k === 'r') {
      reset();
      e.preventDefault();
    }
  });

  window.addEventListener('keyup', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'arrowleft' || k === 'a') leftKey = false;
    else if (k === 'arrowright' || k === 'd') rightKey = false;
  });

  restartBtn.addEventListener('click', reset);
  startBtn.addEventListener('click', startGame);
  dropBtn.addEventListener('click', () => {
    if (state === 'ready' || state === 'gameover') startGame();
    else if (state === 'aiming') dropBall();
  });

  reset();
  loop();
}

export const game = defineGame({ init, reset });
