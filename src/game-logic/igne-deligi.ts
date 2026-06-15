import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';

type State = 'ready' | 'playing' | 'gameover';

const W = 480;
const H = 600;
const NEEDLE_LEN = 360;
const NEEDLE_X1 = (W - NEEDLE_LEN) / 2;
const NEEDLE_X2 = NEEDLE_X1 + NEEDLE_LEN;
const EYE_X = W / 2;
const NEEDLE_BASE_Y = H / 2 + 30;

const ROUND_TIME_MS = 60_000;
const MISS_TREMOR_MS = 260;
const PASS_FLASH_MS = 320;
const SLIDE_MS = 360;
const GUST_FLASH_MS = 220;
const TRAIL_LIFE_MS = 360;
const TRAIL_MAX = 60;

const STORAGE_BEST = 'igne-deligi.best';

interface Stage {
  eyeR: number;
  windAmp: number;
  windFreq: number;
  gustChance: number;
  gustAmp: number;
}

const STAGES: Stage[] = [
  { eyeR: 22, windAmp: 6, windFreq: 1.0, gustChance: 0, gustAmp: 0 },
  { eyeR: 18, windAmp: 12, windFreq: 1.4, gustChance: 0, gustAmp: 0 },
  { eyeR: 14, windAmp: 20, windFreq: 1.8, gustChance: 0.18, gustAmp: 14 },
  { eyeR: 11, windAmp: 28, windFreq: 2.2, gustChance: 0.32, gustAmp: 22 },
  { eyeR: 9, windAmp: 36, windFreq: 2.6, gustChance: 0.5, gustAmp: 30 },
  { eyeR: 7, windAmp: 44, windFreq: 3.0, gustChance: 0.66, gustAmp: 38 },
];

function stageFor(s: number): Stage {
  const idx = Math.min(STAGES.length - 1, Math.floor(s / 2));
  return STAGES[idx]!;
}

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let timeEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;

const gen = createGenToken();
let state: State = 'ready';
let score = 0;
let best = 0;
let timeLeftMs = ROUND_TIME_MS;

let cursorX = W / 2;
let cursorY = H / 2 + 140;
let prevCursorX = cursorX;
let prevCursorY = cursorY;
let cursorActive = false;
const trail: { x: number; y: number; t: number }[] = [];

let elapsedMs = 0;
let gustOffset = 0;
let gustVel = 0;
let nextGustMs = 0;
let needleSlideX = 0;
let slideTimer = 0;
let slideDir: 0 | 1 = 0;

let passFlashMs = 0;
let missTremor = 0;
let gustFlashMs = 0;

let lastFrame = 0;

const cssCache = new Map<string, string>();
function getCss(name: string): string {
  const cached = cssCache.get(name);
  if (cached !== undefined) return cached;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  cssCache.set(name, v);
  return v;
}

function setScoreEl(v: number): void {
  score = v;
  scoreEl.textContent = String(score);
}

function setBestEl(v: number): void {
  best = v;
  bestEl.textContent = String(best);
}

function setTimeEl(ms: number): void {
  timeLeftMs = ms;
  const sec = Math.max(0, Math.ceil(ms / 1000));
  timeEl.textContent = String(sec);
}

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlay);
}

function hideOverlay(): void {
  hideOverlayEl(overlay);
}

function reset(): void {
  gen.bump();
  state = 'ready';
  setScoreEl(0);
  setTimeEl(ROUND_TIME_MS);
  elapsedMs = 0;
  gustOffset = 0;
  gustVel = 0;
  nextGustMs = 1800;
  needleSlideX = 0;
  slideTimer = 0;
  slideDir = 0;
  passFlashMs = 0;
  missTremor = 0;
  gustFlashMs = 0;
  trail.length = 0;
  showOverlay(
    'İğne Deliği',
    'İğnenin gözünden ipi geçir — üstten alta ya da alttan üste, tam gözün içinde. Başlamak için Boşluk.',
  );
}

function startPlaying(): void {
  if (state === 'playing') return;
  state = 'playing';
  hideOverlay();
  prevCursorX = cursorX;
  prevCursorY = cursorY;
}

function endRound(): void {
  state = 'gameover';
  setTimeEl(0);
  if (score > best) {
    setBestEl(score);
    safeWrite(STORAGE_BEST, score);
  }
  showOverlay(
    'Süre doldu',
    `${score} iplik geçti. Rekor: ${best}. Tekrar için Boşluk veya R.`,
  );
}

function currentNeedleY(): number {
  const st = stageFor(score);
  const wind = Math.sin((elapsedMs / 1000) * st.windFreq * Math.PI * 2) * st.windAmp;
  return NEEDLE_BASE_Y + wind + gustOffset;
}

function currentNeedleX(): number {
  return needleSlideX;
}

function tickSlide(dt: number): void {
  if (slideTimer <= 0) return;
  slideTimer = Math.max(0, slideTimer - dt);
  const t = 1 - slideTimer / SLIDE_MS;
  if (slideDir === 1) {
    if (t < 0.5) {
      needleSlideX = (t / 0.5) * (W + 100);
    } else {
      needleSlideX = -(W + 100) + ((t - 0.5) / 0.5) * (W + 100);
    }
    if (slideTimer === 0) {
      needleSlideX = 0;
      slideDir = 0;
    }
  }
}

function tickGust(dt: number): void {
  const dtSec = dt / 1000;
  const k = 18;
  const d = 5;
  const acc = -k * gustOffset - d * gustVel;
  gustVel += acc * dtSec;
  gustOffset += gustVel * dtSec;
  if (Math.abs(gustOffset) < 0.05 && Math.abs(gustVel) < 0.1) {
    gustOffset = 0;
    gustVel = 0;
  }

  const st = stageFor(score);
  if (st.gustChance <= 0 || st.gustAmp <= 0) return;
  nextGustMs -= dt;
  if (nextGustMs <= 0) {
    if (Math.random() < st.gustChance) {
      const dir = Math.random() < 0.5 ? -1 : 1;
      gustVel += dir * st.gustAmp * 6;
      gustFlashMs = GUST_FLASH_MS;
    }
    nextGustMs = 1300 + Math.random() * 1600;
  }
}

function trySegmentPass(): void {
  if (state !== 'playing') return;
  if (slideTimer > 0) return;
  const needleY = currentNeedleY();
  const needleX = currentNeedleX();
  const x1 = NEEDLE_X1 + needleX;
  const x2 = NEEDLE_X2 + needleX;
  const cx = EYE_X + needleX;

  const py = prevCursorY;
  const cy = cursorY;
  if (py === cy) return;
  const crossedDown = py <= needleY && cy > needleY;
  const crossedUp = py >= needleY && cy < needleY;
  if (!crossedDown && !crossedUp) return;

  const t = (needleY - py) / (cy - py);
  if (t < 0 || t > 1) return;
  const crossX = prevCursorX + t * (cursorX - prevCursorX);

  const onNeedle = crossX >= x1 && crossX <= x2;
  if (!onNeedle) return;

  const st = stageFor(score);
  const distFromEye = Math.abs(crossX - cx);
  if (distFromEye <= st.eyeR) {
    setScoreEl(score + 1);
    passFlashMs = PASS_FLASH_MS;
    slideTimer = SLIDE_MS;
    slideDir = 1;
  } else {
    missTremor = MISS_TREMOR_MS;
  }
}

function updateCursorFromEvent(clientX: number, clientY: number): void {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const nx = (clientX - rect.left) * scaleX;
  const ny = (clientY - rect.top) * scaleY;
  prevCursorX = cursorX;
  prevCursorY = cursorY;
  cursorX = nx;
  cursorY = ny;
  cursorActive = true;
  trail.push({ x: cursorX, y: cursorY, t: elapsedMs });
  if (trail.length > TRAIL_MAX) trail.shift();
  trySegmentPass();
}

function drawNeedle(): void {
  const needleX = currentNeedleX();
  const x1 = NEEDLE_X1 + needleX;
  const x2 = NEEDLE_X2 + needleX;
  const cx = EYE_X + needleX;
  const y = currentNeedleY();

  const st = stageFor(score);
  const eyeR = st.eyeR;
  const gap = eyeR + 4;

  ctx.strokeStyle = getCss('--igne-needle');
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(x1, y);
  ctx.lineTo(cx - gap, y);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx + gap, y);
  ctx.lineTo(x2, y);
  ctx.stroke();

  ctx.fillStyle = getCss('--igne-needle');
  ctx.beginPath();
  ctx.moveTo(x2 + 6, y);
  ctx.lineTo(x2 - 6, y - 4);
  ctx.lineTo(x2 - 6, y + 4);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = passFlashMs > 0 ? getCss('--igne-pass') : getCss('--igne-eye');
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(cx, y, eyeR, 0, Math.PI * 2);
  ctx.stroke();

  if (passFlashMs > 0) {
    const a = passFlashMs / PASS_FLASH_MS;
    ctx.strokeStyle = `rgba(110, 231, 183, ${0.5 * a})`;
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(cx, y, eyeR + 6 + (1 - a) * 14, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 1;
  }

  if (missTremor > 0) {
    const a = missTremor / MISS_TREMOR_MS;
    ctx.strokeStyle = `rgba(248, 113, 113, ${0.55 * a})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, y, eyeR + 4, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawTrail(): void {
  if (trail.length < 2) return;
  ctx.strokeStyle = getCss('--igne-thread');
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let i = 1; i < trail.length; i++) {
    const a = trail[i - 1]!;
    const b = trail[i]!;
    const age = elapsedMs - b.t;
    if (age > TRAIL_LIFE_MS) continue;
    const alpha = 1 - age / TRAIL_LIFE_MS;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = 2 + alpha * 1.5;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.lineWidth = 1;
}

function drawCursor(): void {
  if (!cursorActive) return;
  const tremor = missTremor > 0 ? (missTremor / MISS_TREMOR_MS) * 3 : 0;
  const dx = tremor ? (Math.random() - 0.5) * tremor : 0;
  const dy = tremor ? (Math.random() - 0.5) * tremor : 0;

  ctx.fillStyle = getCss('--igne-thread');
  ctx.beginPath();
  ctx.arc(cursorX + dx, cursorY + dy, 4.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cursorX + dx, cursorY + dy, 8, 0, Math.PI * 2);
  ctx.stroke();
}

function drawWindIndicator(): void {
  if (gustFlashMs <= 0) return;
  const a = gustFlashMs / GUST_FLASH_MS;
  ctx.fillStyle = `rgba(251, 191, 36, ${0.55 * a})`;
  ctx.font = '600 12px Inter, system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'top';
  ctx.fillText('rüzgâr', W - 14, 14);
}

function drawHints(): void {
  if (state !== 'playing') return;
  ctx.fillStyle = getCss('--text-dim');
  ctx.font = '600 12px Inter, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const st = stageFor(score);
  ctx.fillText(`göz çapı: ${st.eyeR}px`, W / 2, 14);
}

function draw(): void {
  ctx.fillStyle = getCss('--surface');
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = getCss('--border');
  ctx.lineWidth = 1;
  for (let x = 30; x < W; x += 30) {
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, H);
    ctx.stroke();
  }
  for (let y = 30; y < H; y += 30) {
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(W, y + 0.5);
    ctx.stroke();
  }

  drawTrail();
  drawNeedle();
  drawCursor();
  drawHints();
  drawWindIndicator();
}

function loop(now: number): void {
  if (lastFrame === 0) lastFrame = now;
  const dt = Math.min(64, now - lastFrame);
  lastFrame = now;
  elapsedMs += dt;
  tickGust(dt);
  tickSlide(dt);
  if (passFlashMs > 0) passFlashMs = Math.max(0, passFlashMs - dt);
  if (missTremor > 0) missTremor = Math.max(0, missTremor - dt);
  if (gustFlashMs > 0) gustFlashMs = Math.max(0, gustFlashMs - dt);
  if (state === 'playing') {
    setTimeEl(timeLeftMs - dt);
    if (timeLeftMs <= 0) {
      endRound();
    }
  }
  draw();
  requestAnimationFrame(loop);
}

function bindInput(): void {
  canvas.addEventListener('pointermove', (e) => {
    updateCursorFromEvent(e.clientX, e.clientY);
  });
  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (state === 'ready') {
      startPlaying();
    } else if (state === 'gameover') {
      reset();
    }
    updateCursorFromEvent(e.clientX, e.clientY);
  });
  canvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
  }, { passive: false });

  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    const k = e.key;
    if (k === ' ' || k === 'Enter') {
      if (state === 'ready') {
        startPlaying();
      } else if (state === 'gameover') {
        reset();
      }
      e.preventDefault();
      return;
    }
    if (k.toLowerCase() === 'r') {
      reset();
      e.preventDefault();
    }
  });

  restartBtn.addEventListener('click', () => {
    reset();
  });
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  timeEl = document.querySelector<HTMLElement>('#time')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;

  best = safeRead<number>(STORAGE_BEST, 0);
  setBestEl(best);

  bindInput();
  reset();
  requestAnimationFrame(loop);
}

export const game = defineGame({ init, reset });
