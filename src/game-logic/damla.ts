import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import {
  showOverlay as showOverlayEl,
  hideOverlay as hideOverlayEl,
} from '@shared/overlay';

const STORAGE_BEST = 'damla.best';

const COLS = 7;
const MIN_TARGET = 2;
const MAX_TARGET = 6;
const DROP_BUDGET = 35;
const PERIOD_MS = 3200;
const FALL_SPEED = 520;

const W = 480;
const H = 480;
const TOP_BAND = 60;
const FLOOR_Y = H - 24;
const STAL_UNIT = 26;
const COL_W = W / COLS;

type State = 'ready' | 'playing' | 'won' | 'lost';
type Drop = { x: number; y: number; col: number };

let state: State = 'ready';
let stalagHeight: number[] = [];
let target: number[] = [];
let broken: boolean[] = [];
let dropsLeft = DROP_BUDGET;
let best = 0;
let activeDrops: Drop[] = [];
let rafHandle: number | null = null;
let lastT = 0;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let dropsEl!: HTMLElement;
let bestEl!: HTMLElement;
let matchedEl!: HTMLElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let restartBtn!: HTMLButtonElement;

function colCenterX(c: number): number {
  return c * COL_W + COL_W / 2;
}

function stalactiteX(now: number): number {
  const margin = 30;
  const t = (now % PERIOD_MS) / PERIOD_MS;
  const wave = (Math.sin(t * Math.PI * 2) + 1) / 2;
  return margin + wave * (W - 2 * margin);
}

function columnAt(x: number): number {
  return Math.min(COLS - 1, Math.max(0, Math.floor(x / COL_W)));
}

function isMatched(c: number): boolean {
  return !broken[c] && stalagHeight[c] === target[c];
}

function matchedCount(): number {
  let n = 0;
  for (let c = 0; c < COLS; c++) if (isMatched(c)) n++;
  return n;
}

function updateHUD(): void {
  dropsEl.textContent = String(dropsLeft);
  bestEl.textContent = String(best);
  matchedEl.textContent = `${matchedCount()}/${COLS}`;
}

function showInfo(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlay);
}

function newPuzzle(): void {
  target = [];
  for (let i = 0; i < COLS; i++) {
    const range = MAX_TARGET - MIN_TARGET + 1;
    target.push(MIN_TARGET + Math.floor(Math.random() * range));
  }
  stalagHeight = new Array(COLS).fill(0);
  broken = new Array(COLS).fill(false);
  activeDrops = [];
  dropsLeft = DROP_BUDGET;
}

function reset(): void {
  state = 'ready';
  newPuzzle();
  updateHUD();
  showInfo(
    'Damla',
    'Boşluk veya tıkla ile damlayı bırak. Her sütunu kesik çizgideki hedef yüksekliğe getir, taşırma.',
  );
  startLoop();
}

function startLoop(): void {
  if (rafHandle !== null) return;
  lastT = performance.now();
  rafHandle = requestAnimationFrame(loop);
}

function checkEndConditions(): void {
  if (state !== 'playing' && state !== 'ready') return;
  if (matchedCount() === COLS) {
    state = 'won';
    finalizeWin();
    return;
  }
  if (broken.some((b) => b)) {
    state = 'lost';
    finalizeLoss('Bir sütunu taşırdın.');
    return;
  }
  if (dropsLeft <= 0 && activeDrops.length === 0) {
    state = 'lost';
    finalizeLoss('Damlalar tükendi.');
  }
}

function finalizeWin(): void {
  const score = COLS * 100 + dropsLeft * 10;
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
  updateHUD();
  showInfo(
    'Tüm sütunlar dolu!',
    `Skor: ${score} · Boşluk veya tıkla ile yeni bulmaca.`,
  );
}

function finalizeLoss(reason: string): void {
  updateHUD();
  showInfo(
    'Oyun bitti',
    `${reason} Eşleşen: ${matchedCount()}/${COLS} · Boşluk veya tıkla ile yeni bulmaca.`,
  );
}

function releaseDrop(): void {
  if (state === 'won' || state === 'lost') return;
  if (dropsLeft <= 0) return;
  const x = stalactiteX(performance.now());
  const col = columnAt(x);
  activeDrops.push({ x, y: TOP_BAND - 2, col });
  dropsLeft -= 1;
  if (state === 'ready') {
    state = 'playing';
    hideOverlayEl(overlay);
  }
  updateHUD();
}

function tickDrops(dt: number): void {
  if (activeDrops.length === 0) return;
  let mutated = false;
  const survivors: Drop[] = [];
  for (const d of activeDrops) {
    d.y += (FALL_SPEED * dt) / 1000;
    const h = stalagHeight[d.col] ?? 0;
    const surfaceY = FLOOR_Y - h * STAL_UNIT;
    if (d.y >= surfaceY - 4) {
      if (!broken[d.col]) {
        stalagHeight[d.col] = h + 1;
        if ((stalagHeight[d.col] ?? 0) > (target[d.col] ?? 0)) {
          broken[d.col] = true;
        }
      }
      mutated = true;
    } else {
      survivors.push(d);
    }
  }
  activeDrops = survivors;
  if (mutated) {
    updateHUD();
    checkEndConditions();
  }
}

function loop(t: number): void {
  const dt = Math.min(50, t - lastT);
  lastT = t;
  if (state === 'playing' || state === 'ready') {
    tickDrops(dt);
  }
  draw(t);
  rafHandle = requestAnimationFrame(loop);
}

const cssCache = new Map<string, string>();
function getCss(varName: string, fallback: string): string {
  const cached = cssCache.get(varName);
  if (cached !== undefined) return cached;
  const val = getComputedStyle(document.documentElement)
    .getPropertyValue(varName)
    .trim();
  const out = val || fallback;
  cssCache.set(varName, out);
  return out;
}

function draw(now: number): void {
  ctx.fillStyle = getCss('--bg', '#0a0b10');
  ctx.fillRect(0, 0, W, H);

  const grd = ctx.createLinearGradient(0, 0, 0, TOP_BAND);
  grd.addColorStop(0, '#1a1f2e');
  grd.addColorStop(1, '#0c0e16');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, W, TOP_BAND);

  for (let c = 0; c < COLS; c++) {
    ctx.fillStyle =
      c % 2 === 0 ? 'rgba(255,255,255,0.018)' : 'rgba(255,255,255,0.03)';
    ctx.fillRect(c * COL_W, TOP_BAND, COL_W, FLOOR_Y - TOP_BAND);
  }

  for (let c = 0; c < COLS; c++) {
    const targetY = FLOOR_Y - (target[c] ?? 0) * STAL_UNIT;
    const matched = isMatched(c);
    const overflowed = broken[c] === true;
    const markColor = overflowed ? '#dc2626' : matched ? '#22c55e' : '#facc15';
    ctx.strokeStyle = markColor;
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(c * COL_W + 8, targetY);
    ctx.lineTo((c + 1) * COL_W - 8, targetY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = markColor;
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(String(target[c] ?? 0), colCenterX(c), targetY - 5);
  }

  ctx.strokeStyle = '#3a4255';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, FLOOR_Y);
  ctx.lineTo(W, FLOOR_Y);
  ctx.stroke();

  for (let c = 0; c < COLS; c++) {
    const h = stalagHeight[c] ?? 0;
    if (h === 0) continue;
    const cx = colCenterX(c);
    const baseW = COL_W * 0.72;
    const topW = baseW * 0.28;
    const topY = FLOOR_Y - h * STAL_UNIT;
    const overflowed = broken[c] === true;
    const matched = isMatched(c);
    ctx.fillStyle = overflowed
      ? '#dc2626'
      : matched
        ? '#22c55e'
        : '#60a5fa';
    ctx.beginPath();
    ctx.moveTo(cx - baseW / 2, FLOOR_Y);
    ctx.lineTo(cx - topW / 2, topY);
    ctx.lineTo(cx + topW / 2, topY);
    ctx.lineTo(cx + baseW / 2, FLOOR_Y);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    ctx.beginPath();
    ctx.moveTo(cx - baseW / 2 + 6, FLOOR_Y);
    ctx.lineTo(cx - topW / 2, topY);
    ctx.lineTo(cx - topW / 2 + 2, topY);
    ctx.lineTo(cx - baseW / 2 + 12, FLOOR_Y);
    ctx.closePath();
    ctx.fill();
  }

  const sx = stalactiteX(now);
  if (state === 'ready' || state === 'playing') {
    const col = columnAt(sx);
    const surfaceY = FLOOR_Y - (stalagHeight[col] ?? 0) * STAL_UNIT;
    ctx.strokeStyle = 'rgba(148,163,184,0.22)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 5]);
    ctx.beginPath();
    ctx.moveTo(sx, TOP_BAND - 4);
    ctx.lineTo(sx, surfaceY);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.fillStyle = '#94a3b8';
  ctx.beginPath();
  ctx.moveTo(sx - 16, 0);
  ctx.lineTo(sx + 16, 0);
  ctx.lineTo(sx + 5, TOP_BAND - 12);
  ctx.lineTo(sx, TOP_BAND - 4);
  ctx.lineTo(sx - 5, TOP_BAND - 12);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#cbd5e1';
  ctx.beginPath();
  ctx.arc(sx, TOP_BAND - 6, 2.5, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#38bdf8';
  for (const d of activeDrops) {
    ctx.beginPath();
    ctx.ellipse(d.x, d.y, 4, 6, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  for (const d of activeDrops) {
    ctx.beginPath();
    ctx.ellipse(d.x - 1.2, d.y - 1.6, 1, 1.6, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

function onKeyDown(e: KeyboardEvent): void {
  const k = e.key.toLowerCase();
  if (k === ' ' || k === 'enter' || e.key === 'Spacebar') {
    if (state === 'won' || state === 'lost') {
      reset();
    } else {
      releaseDrop();
    }
    e.preventDefault();
  } else if (k === 'r') {
    reset();
    e.preventDefault();
  }
}

function onCanvasPointer(e: PointerEvent): void {
  if (state === 'won' || state === 'lost') {
    reset();
  } else {
    releaseDrop();
  }
  e.preventDefault();
}

function onOverlayPointer(e: PointerEvent): void {
  if (state === 'won' || state === 'lost') {
    reset();
  } else {
    releaseDrop();
  }
  e.preventDefault();
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  dropsEl = document.querySelector<HTMLElement>('#drops')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  matchedEl = document.querySelector<HTMLElement>('#matched')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  window.addEventListener('keydown', onKeyDown);
  canvas.addEventListener('pointerdown', onCanvasPointer);
  overlay.addEventListener('pointerdown', onOverlayPointer);
  restartBtn.addEventListener('click', reset);

  reset();
}

export const game = defineGame({ init, reset });
