import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';

type GameState = 'ready' | 'playing' | 'gameover';

const CANVAS_W = 480;
const CANVAS_H = 640;
const N = 4;
const STORAGE_BEST = 'sigorta.best';

const BAR_TOP = 70;
const BAR_BOTTOM = 540;
const BAR_HEIGHT = BAR_BOTTOM - BAR_TOP;
const BAR_WIDTH = 72;
const BAR_GAP = (CANVAS_W - BAR_WIDTH * N) / (N + 1);

const VENT_AMOUNT = 40;
const COOLDOWN_MS = 1400;
const FAIL_LOAD = 100;

const BASE_RATE_MIN = 2.6;
const BASE_RATE_MAX = 4.4;
const RATE_GROWTH_PER_SEC = 0.018;
const SURGE_MIN_MS = 4200;
const SURGE_MAX_MS = 7800;
const SURGE_AMOUNT_MIN = 14;
const SURGE_AMOUNT_MAX = 24;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let timeEl!: HTMLElement;
let bestEl!: HTMLElement;
let peakEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
const ventBtns: HTMLButtonElement[] = [];

let state: GameState = 'ready';
let loads: number[] = new Array(N).fill(0);
let baseRates: number[] = new Array(N).fill(BASE_RATE_MIN);
let cooldownMs: number[] = new Array(N).fill(0);
let elapsedMs = 0;
let best = 0;
let nextSurgeMs = 0;
let surgeFlashMs: number[] = new Array(N).fill(0);
let ventFlashMs: number[] = new Array(N).fill(0);
let lastFrameTime = 0;

const cssCache = new Map<string, string>();
function getCss(name: string): string {
  const cached = cssCache.get(name);
  if (cached !== undefined) return cached;
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  cssCache.set(name, v);
  return v;
}

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlay);
}

function hideOverlay(): void {
  hideOverlayEl(overlay);
}

function formatTime(sec: number): string {
  return sec.toFixed(1);
}

function loadBest(): number {
  const v = safeRead<number>(STORAGE_BEST, 0);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function scheduleNextSurge(): void {
  nextSurgeMs = SURGE_MIN_MS + Math.random() * (SURGE_MAX_MS - SURGE_MIN_MS);
}

function randomizeBaseRates(): void {
  for (let i = 0; i < N; i++) {
    baseRates[i] = BASE_RATE_MIN + Math.random() * (BASE_RATE_MAX - BASE_RATE_MIN);
  }
}

function reset(): void {
  state = 'ready';
  loads = new Array(N).fill(0);
  cooldownMs = new Array(N).fill(0);
  surgeFlashMs = new Array(N).fill(0);
  ventFlashMs = new Array(N).fill(0);
  elapsedMs = 0;
  randomizeBaseRates();
  scheduleNextSurge();
  timeEl.textContent = '0.0';
  bestEl.textContent = formatTime(best);
  peakEl.textContent = '0%';
  showOverlay(
    'Sigorta',
    'Devreyi (1-4) boşalt — akım komşulara akar. %100’e dayanma!',
  );
}

function gameOver(): void {
  state = 'gameover';
  const sec = elapsedMs / 1000;
  if (sec > best) {
    best = sec;
    safeWrite(STORAGE_BEST, best);
    bestEl.textContent = formatTime(best);
  }
  showOverlay(
    'Sigorta attı!',
    `Süre: ${formatTime(sec)} sn · Tekrar için bir devreye dokun veya R`,
  );
}

function vent(i: number): void {
  if (state === 'gameover') {
    reset();
    return;
  }
  if (i < 0 || i >= N) return;
  if (cooldownMs[i]! > 0) return;
  if (state === 'ready') {
    state = 'playing';
    hideOverlay();
  }
  const actual = Math.min(VENT_AMOUNT, loads[i]!);
  loads[i] = Math.max(0, loads[i]! - VENT_AMOUNT);
  ventFlashMs[i] = 240;
  cooldownMs[i] = COOLDOWN_MS;
  const leftIdx = i - 1;
  const rightIdx = i + 1;
  const hasLeft = leftIdx >= 0;
  const hasRight = rightIdx < N;
  let leftShare = 0;
  let rightShare = 0;
  if (hasLeft && hasRight) {
    leftShare = actual * 0.5;
    rightShare = actual * 0.5;
  } else if (hasLeft) {
    leftShare = actual;
  } else if (hasRight) {
    rightShare = actual;
  }
  if (hasLeft) {
    loads[leftIdx] = Math.min(FAIL_LOAD + 5, loads[leftIdx]! + leftShare);
  }
  if (hasRight) {
    loads[rightIdx] = Math.min(FAIL_LOAD + 5, loads[rightIdx]! + rightShare);
  }
}

function tick(dt: number): void {
  if (state !== 'playing') {
    for (let i = 0; i < N; i++) {
      if (cooldownMs[i]! > 0) cooldownMs[i] = Math.max(0, cooldownMs[i]! - dt);
      if (ventFlashMs[i]! > 0) ventFlashMs[i] = Math.max(0, ventFlashMs[i]! - dt);
      if (surgeFlashMs[i]! > 0) surgeFlashMs[i] = Math.max(0, surgeFlashMs[i]! - dt);
    }
    return;
  }
  elapsedMs += dt;
  const sec = elapsedMs / 1000;
  const growthMul = 1 + sec * RATE_GROWTH_PER_SEC;
  const dtSec = dt / 1000;

  let peak = 0;
  for (let i = 0; i < N; i++) {
    loads[i] = loads[i]! + baseRates[i]! * growthMul * dtSec;
    if (cooldownMs[i]! > 0) cooldownMs[i] = Math.max(0, cooldownMs[i]! - dt);
    if (ventFlashMs[i]! > 0) ventFlashMs[i] = Math.max(0, ventFlashMs[i]! - dt);
    if (surgeFlashMs[i]! > 0) surgeFlashMs[i] = Math.max(0, surgeFlashMs[i]! - dt);
    if (loads[i]! > peak) peak = loads[i]!;
  }

  nextSurgeMs -= dt;
  if (nextSurgeMs <= 0) {
    const idx = Math.floor(Math.random() * N);
    const amount = SURGE_AMOUNT_MIN + Math.random() * (SURGE_AMOUNT_MAX - SURGE_AMOUNT_MIN);
    loads[idx] = Math.min(FAIL_LOAD + 5, loads[idx]! + amount);
    surgeFlashMs[idx] = 420;
    scheduleNextSurge();
  }

  timeEl.textContent = formatTime(sec);
  peakEl.textContent = `${Math.min(100, Math.round(peak))}%`;

  if (peak >= FAIL_LOAD) {
    gameOver();
  }
}

function loadColor(value: number): string {
  if (value < 50) return getCss('--sigorta-safe');
  if (value < 75) return getCss('--sigorta-warn');
  if (value < 90) return getCss('--sigorta-hot');
  return getCss('--sigorta-crit');
}

function drawBar(i: number): void {
  const x = BAR_GAP + i * (BAR_WIDTH + BAR_GAP);
  const value = Math.max(0, Math.min(FAIL_LOAD, loads[i]!));
  const fillH = (value / FAIL_LOAD) * BAR_HEIGHT;

  ctx.fillStyle = getCss('--surface-2');
  ctx.fillRect(x, BAR_TOP, BAR_WIDTH, BAR_HEIGHT);
  ctx.strokeStyle = getCss('--border-strong');
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, BAR_TOP + 0.5, BAR_WIDTH - 1, BAR_HEIGHT - 1);

  const color = loadColor(value);
  ctx.fillStyle = color;
  ctx.fillRect(x + 4, BAR_BOTTOM - fillH, BAR_WIDTH - 8, fillH);

  ctx.strokeStyle = getCss('--border');
  ctx.lineWidth = 1;
  for (const t of [50, 75, 90]) {
    const y = BAR_BOTTOM - (t / FAIL_LOAD) * BAR_HEIGHT;
    ctx.beginPath();
    ctx.moveTo(x + 2, y);
    ctx.lineTo(x + BAR_WIDTH - 2, y);
    ctx.stroke();
  }

  const surge = surgeFlashMs[i]!;
  if (surge > 0) {
    const alpha = surge / 420;
    ctx.fillStyle = `rgba(248, 113, 113, ${0.45 * alpha})`;
    ctx.fillRect(x, BAR_TOP, BAR_WIDTH, BAR_HEIGHT);
  }

  const vf = ventFlashMs[i]!;
  if (vf > 0) {
    const alpha = vf / 240;
    ctx.strokeStyle = `rgba(125, 211, 252, ${0.95 * alpha})`;
    ctx.lineWidth = 3;
    ctx.strokeRect(x + 2, BAR_TOP + 2, BAR_WIDTH - 4, BAR_HEIGHT - 4);
    ctx.lineWidth = 1;
  }

  ctx.font = '700 16px Inter, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = getCss('--text');
  ctx.fillText(`${Math.round(value)}%`, x + BAR_WIDTH / 2, BAR_TOP - 18);

  ctx.font = '600 13px Inter, system-ui, sans-serif';
  ctx.fillStyle = getCss('--text-dim');
  ctx.fillText(`Devre ${i + 1}`, x + BAR_WIDTH / 2, BAR_TOP - 38);

  const hotkeyY = BAR_BOTTOM + 28;
  ctx.font = '700 20px Inter, system-ui, sans-serif';
  ctx.fillStyle = cooldownMs[i]! > 0 ? getCss('--text-dim') : getCss('--accent');
  ctx.fillText(String(i + 1), x + BAR_WIDTH / 2, hotkeyY);

  const cdY = hotkeyY + 18;
  const cdW = BAR_WIDTH - 8;
  ctx.fillStyle = getCss('--border');
  ctx.fillRect(x + 4, cdY, cdW, 4);
  const cdProgress = cooldownMs[i]! > 0 ? 1 - cooldownMs[i]! / COOLDOWN_MS : 1;
  ctx.fillStyle = cdProgress >= 1 ? getCss('--accent') : getCss('--text-dim');
  ctx.fillRect(x + 4, cdY, cdW * cdProgress, 4);
}

function drawBleedHints(): void {
  ctx.font = '600 11px Inter, system-ui, sans-serif';
  ctx.fillStyle = getCss('--text-muted');
  ctx.textBaseline = 'middle';
  const y = BAR_TOP + BAR_HEIGHT / 2;
  for (let i = 0; i < N; i++) {
    const x = BAR_GAP + i * (BAR_WIDTH + BAR_GAP);
    if (i > 0) {
      ctx.textAlign = 'right';
      ctx.fillText('←', x - 2, y);
    }
    if (i < N - 1) {
      ctx.textAlign = 'left';
      ctx.fillText('→', x + BAR_WIDTH + 2, y);
    }
  }
}

function draw(): void {
  ctx.fillStyle = getCss('--surface');
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  drawBleedHints();
  for (let i = 0; i < N; i++) drawBar(i);
}

function loop(now: number): void {
  if (lastFrameTime === 0) lastFrameTime = now;
  const dt = Math.min(64, now - lastFrameTime);
  lastFrameTime = now;
  tick(dt);
  draw();
  requestAnimationFrame(loop);
}

function bindVentBtn(btn: HTMLButtonElement, idx: number): void {
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    vent(idx);
  });
  btn.addEventListener('click', (e) => {
    e.preventDefault();
  });
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  timeEl = document.querySelector<HTMLElement>('#time')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  peakEl = document.querySelector<HTMLElement>('#peak')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  for (let i = 0; i < N; i++) {
    const btn = document.querySelector<HTMLButtonElement>(`#vent-${i + 1}`)!;
    ventBtns.push(btn);
    bindVentBtn(btn, i);
  }

  best = loadBest();

  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    const k = e.key;
    if (k === '1' || k === '2' || k === '3' || k === '4') {
      vent(Number(k) - 1);
      e.preventDefault();
      return;
    }
    const lower = k.toLowerCase();
    if (lower === 'r') {
      reset();
      e.preventDefault();
      return;
    }
    if (k === ' ' || k === 'Enter') {
      if (state === 'ready') {
        state = 'playing';
        hideOverlay();
        e.preventDefault();
      } else if (state === 'gameover') {
        reset();
        e.preventDefault();
      }
    }
  });

  restartBtn.addEventListener('click', () => reset());

  reset();
  requestAnimationFrame(loop);
}

export const game = defineGame({ init, reset });
