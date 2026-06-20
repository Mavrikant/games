import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';

const STORAGE_BEST = 'kovan.best';

type State = 'ready' | 'playing' | 'gameover';

const COLS = 5;
const ROWS = 6;
const HEX_SIZE = 28;
const MAX_LEVEL = 3;
const TICK_START_MS = 1000;
const TICK_MIN_MS = 220;
const TICK_DECAY = 0.985;
const SCORE_PER_LEVEL = [0, 1, 4, 9];

const gen = createGenToken();
let state: State = 'ready';
let score = 0;
let best = 0;
let tickMs = TICK_START_MS;
let tickHandle: number | null = null;
let burstCell: number | null = null;
let burstFrame = 0;

const cells: number[] = new Array(COLS * ROWS).fill(0);
const cellGlow: number[] = new Array(COLS * ROWS).fill(0);
let lastTickedIdx: number | null = null;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let startBtn!: HTMLButtonElement;
let overlayEl!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;

const hexW = Math.sqrt(3) * HEX_SIZE;
const hexRowH = 1.5 * HEX_SIZE;
const gridPadX = (360 - (hexW * COLS + hexW / 2)) / 2;
const gridPadY = (360 - (HEX_SIZE * 2 + hexRowH * (ROWS - 1))) / 2;

function hexCenter(col: number, row: number): { x: number; y: number } {
  const offset = row % 2 === 1 ? hexW / 2 : 0;
  const x = gridPadX + hexW / 2 + col * hexW + offset;
  const y = gridPadY + HEX_SIZE + row * hexRowH;
  return { x, y };
}

function hexPath(cx: number, cy: number, r: number): void {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const angle = -Math.PI / 2 + (Math.PI / 3) * i;
    const x = cx + r * Math.cos(angle);
    const y = cy + r * Math.sin(angle);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function pointInHex(px: number, py: number, cx: number, cy: number, r: number): boolean {
  const dx = Math.abs(px - cx);
  const dy = Math.abs(py - cy);
  if (dy > r) return false;
  const apothem = (Math.sqrt(3) / 2) * r;
  if (dx > apothem) return false;
  return dy <= r * (1 - dx / apothem / 2) + 0.5;
}

function hitTest(px: number, py: number): number {
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const idx = row * COLS + col;
      const { x, y } = hexCenter(col, row);
      if (pointInHex(px, py, x, y, HEX_SIZE - 1)) return idx;
    }
  }
  return -1;
}

function levelColor(level: number): string {
  if (level === 0) return '#1f1a0e';
  if (level === 1) return '#7a5c1c';
  if (level === 2) return '#d6951c';
  return '#fbbf24';
}

function levelRingColor(level: number): string {
  if (level === 0) return '#3a3018';
  if (level === 1) return '#a47422';
  if (level === 2) return '#f4ad24';
  return '#fde68a';
}

function showOverlay(title: string, msg: string, startLabel: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  startBtn.textContent = startLabel;
  showOverlayEl(overlayEl);
}

function hideOverlay(): void {
  hideOverlayEl(overlayEl);
}

function pickRandomCell(): number {
  return Math.floor(Math.random() * cells.length);
}

function startGame(): void {
  gen.bump();
  for (let i = 0; i < cells.length; i++) {
    cells[i] = 0;
    cellGlow[i] = 0;
  }
  lastTickedIdx = null;
  burstCell = null;
  score = 0;
  tickMs = TICK_START_MS;
  state = 'playing';
  scoreEl.textContent = '0';
  hideOverlay();
  scheduleNextTick();
  scheduleDraw();
}

function scheduleNextTick(): void {
  if (state !== 'playing') return;
  const myGen = gen.current();
  tickHandle = window.setTimeout(() => {
    if (!gen.isCurrent(myGen)) return;
    if (state !== 'playing') return;
    runTick();
    tickMs = Math.max(TICK_MIN_MS, tickMs * TICK_DECAY);
    scheduleNextTick();
  }, tickMs);
}

function runTick(): void {
  const idx = pickRandomCell();
  lastTickedIdx = idx;
  if (cells[idx] === undefined) return;
  if (cells[idx]! >= MAX_LEVEL) {
    burst(idx);
    return;
  }
  cells[idx]!++;
  cellGlow[idx] = 1;
}

function burst(idx: number): void {
  state = 'gameover';
  burstCell = idx;
  burstFrame = 0;
  if (tickHandle !== null) {
    clearTimeout(tickHandle);
    tickHandle = null;
  }
  if (score > best) {
    best = score;
    bestEl.textContent = String(best);
    safeWrite(STORAGE_BEST, best);
  }
  showOverlay(
    'Kovan patladı!',
    `Skor: ${score}\nDolu bir hücreye yeniden bal aktı. Yeniden başla.`,
    'Tekrar başla',
  );
}

function harvest(idx: number): void {
  const lvl = cells[idx];
  if (lvl === undefined || lvl === 0) return;
  score += SCORE_PER_LEVEL[lvl]!;
  cells[idx] = 0;
  cellGlow[idx] = 0;
  scoreEl.textContent = String(score);
}

function onPointerDown(e: PointerEvent): void {
  if (state !== 'playing') return;
  const rect = canvas.getBoundingClientRect();
  const sx = canvas.width / rect.width;
  const sy = canvas.height / rect.height;
  const px = (e.clientX - rect.left) * sx;
  const py = (e.clientY - rect.top) * sy;
  const idx = hitTest(px, py);
  if (idx < 0) return;
  harvest(idx);
}

function drawCss(varName: string, fallback: string): string {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
    return v || fallback;
  } catch {
    return fallback;
  }
}

let rafHandle: number | null = null;

function scheduleDraw(): void {
  if (rafHandle !== null) return;
  rafHandle = requestAnimationFrame(drawFrame);
}

function drawFrame(): void {
  rafHandle = null;
  draw();
  let needsMore = false;
  for (let i = 0; i < cellGlow.length; i++) {
    if (cellGlow[i]! > 0) {
      cellGlow[i] = Math.max(0, cellGlow[i]! - 0.04);
      if (cellGlow[i]! > 0) needsMore = true;
    }
  }
  if (state === 'gameover' && burstCell !== null && burstFrame < 30) {
    burstFrame++;
    needsMore = true;
  }
  if (needsMore || state === 'playing') scheduleDraw();
}

function draw(): void {
  ctx.fillStyle = drawCss('--surface', '#13161b');
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const idx = row * COLS + col;
      const { x, y } = hexCenter(col, row);
      const level = cells[idx]!;
      const glow = cellGlow[idx]!;

      hexPath(x, y, HEX_SIZE - 2);
      ctx.fillStyle = levelColor(level);
      ctx.fill();

      if (level > 0) {
        hexPath(x, y, (HEX_SIZE - 4) * (0.45 + 0.18 * level));
        const grad = ctx.createRadialGradient(x, y - 4, 2, x, y, HEX_SIZE);
        grad.addColorStop(0, levelRingColor(level));
        grad.addColorStop(1, levelColor(level));
        ctx.fillStyle = grad;
        ctx.fill();
      }

      ctx.lineWidth = level === MAX_LEVEL ? 2.5 : 1.5;
      ctx.strokeStyle = level === MAX_LEVEL ? '#fef3c7' : '#2a2316';
      hexPath(x, y, HEX_SIZE - 2);
      ctx.stroke();

      if (glow > 0) {
        ctx.save();
        ctx.globalAlpha = glow * 0.6;
        hexPath(x, y, HEX_SIZE - 1);
        ctx.fillStyle = '#fff7d6';
        ctx.fill();
        ctx.restore();
      }

      if (idx === burstCell) {
        const t = burstFrame / 30;
        ctx.save();
        ctx.globalAlpha = 1 - t;
        ctx.fillStyle = '#ef4444';
        hexPath(x, y, (HEX_SIZE - 2) * (1 + t * 1.4));
        ctx.fill();
        ctx.restore();
      }
    }
  }

  if (state === 'playing' && lastTickedIdx !== null) {
    const row = Math.floor(lastTickedIdx / COLS);
    const col = lastTickedIdx % COLS;
    const { x, y } = hexCenter(col, row);
    ctx.save();
    ctx.strokeStyle = '#fef3c7';
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = 1.5;
    hexPath(x, y, HEX_SIZE + 1);
    ctx.stroke();
    ctx.restore();
  }
}

function reset(): void {
  gen.bump();
  if (tickHandle !== null) {
    clearTimeout(tickHandle);
    tickHandle = null;
  }
  state = 'ready';
  score = 0;
  tickMs = TICK_START_MS;
  for (let i = 0; i < cells.length; i++) {
    cells[i] = 0;
    cellGlow[i] = 0;
  }
  lastTickedIdx = null;
  burstCell = null;
  scoreEl.textContent = '0';
  bestEl.textContent = String(best);
  showOverlay(
    'Kovan',
    'Arılar petek hücrelerini dolduruyor. Tıkla → hasat et. Dolu bir hücreye yeniden bal akarsa kovan patlar. Hücre ne kadar doluyken hasat edersen skor o kadar yüksek (1 / 4 / 9).',
    'Başla',
  );
  scheduleDraw();
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  startBtn = document.querySelector<HTMLButtonElement>('#start')!;
  overlayEl = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;

  best = safeRead<number>(STORAGE_BEST, 0);
  bestEl.textContent = String(best);

  restartBtn.addEventListener('click', reset);
  startBtn.addEventListener('click', () => {
    if (state === 'playing') return;
    startGame();
  });
  canvas.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'r' || e.key === 'R') {
      reset();
      e.preventDefault();
    } else if ((e.key === ' ' || e.key === 'Enter') && state !== 'playing') {
      startGame();
      e.preventDefault();
    }
  });

  reset();
}

export const game = defineGame({ init, reset });
