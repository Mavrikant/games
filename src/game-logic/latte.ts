import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';

const STORAGE_BEST = 'latte.best';

type State = 'ready' | 'pouring' | 'scoring' | 'gameover';

const CANVAS = 480;
const CUP_CX = 240;
const CUP_CY = 240;
const CUP_R = 200;
const ROUND_DURATION_MS = 10_000;
const ROTATION_PERIOD_MS = 7_000;
const BRUSH_R = 11;
const POUR_RATE_MS = 28;
const MAX_ROUNDS = 3;

interface Target {
  name: string;
  mask: (x: number, y: number) => boolean;
}

const TARGETS: Target[] = [
  {
    name: 'Halka',
    mask: (x, y) => {
      const r = Math.hypot(x, y);
      return r > 95 && r < 140;
    },
  },
  {
    name: 'Kalp',
    mask: (x, y) => {
      const sx = x / 110;
      const sy = -y / 110 + 0.25;
      const expr = Math.pow(sx * sx + sy * sy - 1, 3) - sx * sx * Math.pow(sy, 3);
      return expr <= 0;
    },
  },
  {
    name: 'Yıldız',
    mask: (x, y) => {
      const r = Math.hypot(x, y);
      if (r > 160) return false;
      if (r < 22) return true;
      const angle = Math.atan2(y, x);
      const starR = 70 + 75 * Math.max(0, Math.cos(5 * angle - Math.PI / 2));
      return r < starR;
    },
  },
];

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let roundEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;

let state: State = 'ready';
let bestTotal = 0;
let totalScore = 0;
let roundIdx = 0;
let lastRoundScore = 0;
const roundScores: number[] = [];

let foamCanvas!: HTMLCanvasElement;
let foamCtx!: CanvasRenderingContext2D;

let cupRotation = 0;
let roundStartTime = 0;
let lastFrameTime = 0;
let lastPourTime = 0;
let mouseX = -100;
let mouseY = -100;
let mouseInside = false;
let mouseDown = false;
let scoreTimer: number | null = null;

function showText(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlay);
}

function hideText(): void {
  hideOverlayEl(overlay);
}

function clearFoam(): void {
  foamCtx.clearRect(0, 0, foamCanvas.width, foamCanvas.height);
}

function startRound(): void {
  state = 'pouring';
  roundStartTime = performance.now();
  lastPourTime = 0;
  clearFoam();
  hideText();
  roundEl.textContent = `${roundIdx + 1}/${MAX_ROUNDS}`;
  scheduleEnd();
  draw();
}

function scheduleEnd(): void {
  if (scoreTimer !== null) clearTimeout(scoreTimer);
  scoreTimer = window.setTimeout(() => {
    scoreTimer = null;
    if (state === 'pouring') endRound();
  }, ROUND_DURATION_MS);
}

function endRound(): void {
  if (scoreTimer !== null) {
    clearTimeout(scoreTimer);
    scoreTimer = null;
  }
  lastRoundScore = computeScore();
  roundScores.push(lastRoundScore);
  totalScore += lastRoundScore;
  scoreEl.textContent = String(totalScore);

  if (roundIdx >= MAX_ROUNDS - 1) {
    state = 'gameover';
    if (totalScore > bestTotal) {
      bestTotal = totalScore;
      bestEl.textContent = String(bestTotal);
      safeWrite(STORAGE_BEST, bestTotal);
    }
    const lines = roundScores.map((s, i) => `${TARGETS[i]!.name}: ${s}`).join(' · ');
    showText('Servis!', `Toplam ${totalScore}\n${lines}\n\nYeniden başlamak için tıkla.`);
  } else {
    state = 'scoring';
    const nextName = TARGETS[roundIdx + 1]!.name;
    showText(
      `${TARGETS[roundIdx]!.name}: ${lastRoundScore} puan`,
      `Sonraki desen: ${nextName}\nDevam etmek için tıkla / boşluk.`,
    );
  }
}

function nextRound(): void {
  roundIdx++;
  startRound();
}

function computeScore(): number {
  const target = TARGETS[roundIdx]!;
  const w = foamCanvas.width;
  const h = foamCanvas.height;
  const imgData = foamCtx.getImageData(0, 0, w, h);
  const data = imgData.data;
  const cx = w / 2;
  const cy = h / 2;
  let intersection = 0;
  let foamOnly = 0;
  let targetSize = 0;
  const step = 3;
  for (let py = 0; py < h; py += step) {
    for (let px = 0; px < w; px += step) {
      const lx = px - cx;
      const ly = py - cy;
      if (lx * lx + ly * ly > CUP_R * CUP_R) continue;
      const inTarget = target.mask(lx, ly);
      const alphaIdx = (py * w + px) * 4 + 3;
      const hasFoam = (data[alphaIdx] ?? 0) > 110;
      if (inTarget) targetSize++;
      if (hasFoam && inTarget) intersection++;
      else if (hasFoam && !inTarget) foamOnly++;
    }
  }
  if (targetSize === 0) return 0;
  const raw = (intersection - 0.45 * foamOnly) / targetSize;
  return Math.max(0, Math.min(100, Math.round(100 * raw)));
}

function pour(): void {
  if (!mouseInside) return;
  const dx = mouseX - CUP_CX;
  const dy = mouseY - CUP_CY;
  if (dx * dx + dy * dy > CUP_R * CUP_R) return;
  const cos = Math.cos(-cupRotation);
  const sin = Math.sin(-cupRotation);
  const lx = dx * cos - dy * sin;
  const ly = dx * sin + dy * cos;
  const fx = lx + foamCanvas.width / 2;
  const fy = ly + foamCanvas.height / 2;
  const grad = foamCtx.createRadialGradient(fx, fy, 0, fx, fy, BRUSH_R);
  grad.addColorStop(0, 'rgba(248, 240, 220, 0.95)');
  grad.addColorStop(0.7, 'rgba(244, 232, 205, 0.85)');
  grad.addColorStop(1, 'rgba(244, 232, 205, 0)');
  foamCtx.fillStyle = grad;
  foamCtx.beginPath();
  foamCtx.arc(fx, fy, BRUSH_R, 0, Math.PI * 2);
  foamCtx.fill();
}

function loop(): void {
  requestAnimationFrame(loop);
  const now = performance.now();
  const dt = now - lastFrameTime;
  lastFrameTime = now;

  if (state === 'pouring') {
    cupRotation += (dt / ROTATION_PERIOD_MS) * Math.PI * 2;
    if (mouseDown && now - lastPourTime > POUR_RATE_MS) {
      pour();
      lastPourTime = now;
    }
  }

  draw();
}

function draw(): void {
  ctx.fillStyle = '#13110f';
  ctx.fillRect(0, 0, CANVAS, CANVAS);

  // Saucer shadow under cup
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.beginPath();
  ctx.ellipse(CUP_CX, CUP_CY + CUP_R + 4, CUP_R + 14, 14, 0, 0, Math.PI * 2);
  ctx.fill();

  // Cup contents (clipped circle)
  ctx.save();
  ctx.beginPath();
  ctx.arc(CUP_CX, CUP_CY, CUP_R, 0, Math.PI * 2);
  ctx.clip();

  const grad = ctx.createRadialGradient(
    CUP_CX - 50, CUP_CY - 60, 20,
    CUP_CX, CUP_CY, CUP_R,
  );
  grad.addColorStop(0, '#6f4a30');
  grad.addColorStop(0.55, '#3f2615');
  grad.addColorStop(1, '#1f110a');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, CANVAS, CANVAS);

  // Rotated cup-local layer: target hint + foam
  ctx.translate(CUP_CX, CUP_CY);
  ctx.rotate(cupRotation);
  drawTargetHint();
  ctx.drawImage(
    foamCanvas,
    -foamCanvas.width / 2,
    -foamCanvas.height / 2,
  );

  ctx.restore();

  // Rim
  ctx.strokeStyle = '#c89968';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(CUP_CX, CUP_CY, CUP_R, 0, Math.PI * 2);
  ctx.stroke();

  // Highlight gloss on rim
  ctx.strokeStyle = 'rgba(255, 220, 170, 0.35)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(CUP_CX, CUP_CY, CUP_R - 3, Math.PI * 1.05, Math.PI * 1.65);
  ctx.stroke();

  // 12 o'clock orientation marker (rotates with cup)
  ctx.save();
  ctx.translate(CUP_CX, CUP_CY);
  ctx.rotate(cupRotation);
  ctx.fillStyle = '#e8c89a';
  ctx.beginPath();
  ctx.arc(0, -CUP_R + 8, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Cursor (pitcher tip)
  if (mouseInside) {
    const inside = (mouseX - CUP_CX) ** 2 + (mouseY - CUP_CY) ** 2 < CUP_R * CUP_R;
    ctx.strokeStyle = mouseDown && inside
      ? 'rgba(255, 245, 215, 0.95)'
      : 'rgba(255, 245, 215, 0.55)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(mouseX, mouseY, BRUSH_R + 3, 0, Math.PI * 2);
    ctx.stroke();
    if (mouseDown && inside) {
      ctx.strokeStyle = 'rgba(255, 245, 215, 0.25)';
      ctx.beginPath();
      ctx.arc(mouseX, mouseY, BRUSH_R + 8, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // Round timer bar
  if (state === 'pouring') {
    const elapsed = performance.now() - roundStartTime;
    const frac = Math.max(0, 1 - elapsed / ROUND_DURATION_MS);
    const barW = CANVAS - 80;
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(40, CANVAS - 26, barW, 10);
    ctx.fillStyle = frac > 0.3 ? '#e8c89a' : '#d96a4a';
    ctx.fillRect(40, CANVAS - 26, barW * frac, 10);
  }
}

function drawTargetHint(): void {
  if (state !== 'pouring' && state !== 'scoring') return;
  const target = TARGETS[roundIdx];
  if (!target) return;
  ctx.fillStyle = 'rgba(255, 240, 200, 0.07)';
  const step = 4;
  for (let py = -CUP_R; py < CUP_R; py += step) {
    for (let px = -CUP_R; px < CUP_R; px += step) {
      if (px * px + py * py > CUP_R * CUP_R) continue;
      if (target.mask(px, py)) {
        ctx.fillRect(px, py, step, step);
      }
    }
  }
}

function reset(): void {
  if (scoreTimer !== null) {
    clearTimeout(scoreTimer);
    scoreTimer = null;
  }
  state = 'ready';
  roundIdx = 0;
  totalScore = 0;
  lastRoundScore = 0;
  roundScores.length = 0;
  cupRotation = 0;
  mouseDown = false;
  scoreEl.textContent = '0';
  bestEl.textContent = String(bestTotal);
  roundEl.textContent = `1/${MAX_ROUNDS}`;
  clearFoam();
  showText(
    'Latte',
    'Dönen kahveye süt akıt — desen kahveyle birlikte dönüyor.\nFareyi basılı tut, hedef parlak alanı doldur.\n\nBaşlamak için tıkla.',
  );
}

function handleStart(): void {
  if (state === 'ready') {
    startRound();
  } else if (state === 'scoring') {
    nextRound();
  } else if (state === 'gameover') {
    reset();
    startRound();
  }
}

function updateMouseFromEvent(e: PointerEvent | MouseEvent): void {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  mouseX = (e.clientX - rect.left) * scaleX;
  mouseY = (e.clientY - rect.top) * scaleY;
  mouseInside = true;
}

function onPointerDown(e: PointerEvent): void {
  e.preventDefault();
  updateMouseFromEvent(e);
  if (state !== 'pouring') {
    handleStart();
    return;
  }
  mouseDown = true;
  pour();
  lastPourTime = performance.now();
}

function onPointerMove(e: PointerEvent): void {
  updateMouseFromEvent(e);
}

function onPointerUp(): void {
  mouseDown = false;
}

function onPointerLeave(): void {
  mouseInside = false;
  mouseDown = false;
}

function onKey(e: KeyboardEvent): void {
  const k = e.key.toLowerCase();
  if (k === ' ' || k === 'enter') {
    handleStart();
    e.preventDefault();
  } else if (k === 'r') {
    reset();
    e.preventDefault();
  }
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  roundEl = document.querySelector<HTMLElement>('#round')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;

  foamCanvas = document.createElement('canvas');
  foamCanvas.width = CUP_R * 2;
  foamCanvas.height = CUP_R * 2;
  foamCtx = foamCanvas.getContext('2d', { willReadFrequently: true })!;

  bestTotal = safeRead<number>(STORAGE_BEST, 0);

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerleave', onPointerLeave);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('keydown', onKey);
  restartBtn.addEventListener('click', () => reset());
  overlay.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handleStart();
  });

  lastFrameTime = performance.now();
  reset();
  requestAnimationFrame(loop);
}

export const game = defineGame({ init, reset });
