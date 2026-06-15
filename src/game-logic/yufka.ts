import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay, hideOverlay } from '@shared/overlay';

const STORAGE_BEST = 'yufka.best';

const CELLS = 16;
const W = 480;
const H = 320;
const TOP_PAD = 26;
const TABLE_Y = 290;
const CELL_W = W / CELLS;
const MAX_THICK_VIS = 1.45;
const PIN_RADIUS = 16;

const MIN_THICK = 0.06;
const TARGET_MIN = 0.34;
const TARGET_MAX = 0.56;
const LEVEL_TIME_MS = 90_000;
const HOLD_TO_WIN_MS = 350;
const LOSS_RATIO = 0.04;
const PUSH_RATE = 0.32;
const LEVEL_BONUS_MS = 8_000;

type GameState = 'ready' | 'playing' | 'gameover';

const gen = createGenToken();

let state: GameState = 'ready';
let thickness: number[] = new Array(CELLS).fill(0.5) as number[];
let cleared = 0;
let level = 1;
let best = 0;
let timeMs = LEVEL_TIME_MS;
let holdMs = 0;

let pinX = W / 2;
let lastPinX = pinX;
let pressing = false;
let lastFrameMs = 0;
let rafId = 0;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let timeEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayBtn!: HTMLButtonElement;

function generateLevel(n: number): number[] {
  const shapeIdx = (n - 1) % 6;
  const arr: number[] = new Array(CELLS).fill(0.1) as number[];
  switch (shapeIdx) {
    case 0: {
      // gentle center blob
      for (let i = 0; i < CELLS; i++) {
        const d = (i - 7.5) / 3.2;
        arr[i] = 0.13 + 1.05 * Math.exp(-d * d);
      }
      break;
    }
    case 1: {
      // off-center blob (alternates side per level)
      const center = n % 2 === 0 ? 4.5 : 11;
      for (let i = 0; i < CELLS; i++) {
        const d = (i - center) / 2.7;
        arr[i] = 0.13 + 1.1 * Math.exp(-d * d);
      }
      break;
    }
    case 2: {
      // two bumps to flatten
      for (let i = 0; i < CELLS; i++) {
        const a = Math.exp(-(((i - 3) / 1.8) ** 2));
        const b = Math.exp(-(((i - 12) / 1.8) ** 2));
        arr[i] = 0.16 + 0.9 * (a + b);
      }
      break;
    }
    case 3: {
      // sloped ramp (alternates direction)
      const up = n % 2 === 0;
      for (let i = 0; i < CELLS; i++) {
        arr[i] = 0.2 + 0.062 * (up ? i : CELLS - 1 - i);
      }
      break;
    }
    case 4: {
      // narrow tall peak
      for (let i = 0; i < CELLS; i++) {
        const d = (i - 7.5) / 1.45;
        arr[i] = 0.18 + 1.28 * Math.exp(-d * d);
      }
      break;
    }
    case 5: {
      // uniformly thick — must roll off the edges to thin
      for (let i = 0; i < CELLS; i++) arr[i] = 0.8;
      break;
    }
  }
  for (let i = 0; i < CELLS; i++) {
    arr[i] = Math.max(0.08, arr[i]!);
  }
  return arr;
}

function thicknessToY(t: number): number {
  const tt = Math.max(0, Math.min(MAX_THICK_VIS, t));
  const range = TABLE_Y - TOP_PAD;
  return TABLE_Y - (tt / MAX_THICK_VIS) * range;
}

function applyRolling(dxPixels: number): void {
  if (!pressing) return;
  const dxCells = dxPixels / CELL_W;
  const speed = Math.abs(dxCells);
  if (speed < 0.005) return;
  const dir = dxCells > 0 ? 1 : -1;

  const pinCell = Math.max(0, Math.min(CELLS - 1, Math.floor(pinX / CELL_W)));
  const cur = thickness[pinCell]!;
  if (cur <= MIN_THICK + 0.005) return;

  const shiftFrac = Math.min(0.42, speed * PUSH_RATE);
  let amount = cur * shiftFrac;
  const minBuf = MIN_THICK + 0.005;
  if (cur - amount < minBuf) amount = Math.max(0, cur - minBuf);
  if (amount <= 0) return;

  thickness[pinCell] = cur - amount;
  const tgt = pinCell + dir;
  if (tgt >= 0 && tgt < CELLS) {
    thickness[tgt] = thickness[tgt]! + amount * (1 - LOSS_RATIO);
  }
  // else: pushed off the edge → mass becomes flour, lost
}

function lerpColor(
  u: number,
  from: readonly [number, number, number],
  to: readonly [number, number, number],
): string {
  const c = (i: 0 | 1 | 2): number =>
    Math.round(from[i] + (to[i] - from[i]) * u);
  return `rgb(${c(0)},${c(1)},${c(2)})`;
}

function cellColor(t: number): string {
  if (t < TARGET_MIN) {
    const u = Math.max(
      0,
      Math.min(1, (t - MIN_THICK) / Math.max(0.01, TARGET_MIN - MIN_THICK)),
    );
    return lerpColor(u, [215, 96, 96], [232, 197, 118]);
  }
  if (t > TARGET_MAX) {
    const u = Math.min(
      1,
      (t - TARGET_MAX) / Math.max(0.01, MAX_THICK_VIS - TARGET_MAX),
    );
    return lerpColor(u, [232, 197, 118], [148, 95, 56]);
  }
  return 'rgb(232,197,118)';
}

function render(): void {
  ctx.fillStyle = '#0a0b0e';
  ctx.fillRect(0, 0, W, H);

  const bandTop = thicknessToY(TARGET_MAX);
  const bandBot = thicknessToY(TARGET_MIN);
  ctx.fillStyle = 'rgba(116, 200, 130, 0.13)';
  ctx.fillRect(0, bandTop, W, bandBot - bandTop);

  // Tear warning line
  const tearY = thicknessToY(MIN_THICK);
  ctx.strokeStyle = 'rgba(220, 80, 80, 0.5)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(0, tearY);
  ctx.lineTo(W, tearY);
  ctx.stroke();
  ctx.setLineDash([]);

  // Table surface
  ctx.fillStyle = '#3a2e21';
  ctx.fillRect(0, TABLE_Y, W, H - TABLE_Y);
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.fillRect(0, TABLE_Y, W, 2);

  // Dough cells
  for (let i = 0; i < CELLS; i++) {
    const t = thickness[i]!;
    const x = i * CELL_W;
    const y = thicknessToY(t);
    ctx.fillStyle = cellColor(t);
    ctx.fillRect(x, y, CELL_W, TABLE_Y - y);
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(x, y, CELL_W, 3);
    ctx.fillStyle = 'rgba(0,0,0,0.10)';
    ctx.fillRect(x + CELL_W - 1, y, 1, TABLE_Y - y);
  }

  // Target band edges
  ctx.strokeStyle = 'rgba(116, 200, 130, 0.55)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, bandTop);
  ctx.lineTo(W, bandTop);
  ctx.moveTo(0, bandBot);
  ctx.lineTo(W, bandBot);
  ctx.stroke();

  // Rolling pin
  const pinCellIdx = Math.max(
    0,
    Math.min(CELLS - 1, Math.floor(pinX / CELL_W)),
  );
  const pinTopY = thicknessToY(thickness[pinCellIdx]!);
  const pinY = pinTopY - PIN_RADIUS - (pressing ? 0 : 6);

  ctx.fillStyle = '#5b3b2a';
  ctx.fillRect(pinX - PIN_RADIUS - 12, pinY - 3, 12, 6);
  ctx.fillRect(pinX + PIN_RADIUS, pinY - 3, 12, 6);

  const grad = ctx.createLinearGradient(
    0,
    pinY - PIN_RADIUS,
    0,
    pinY + PIN_RADIUS,
  );
  grad.addColorStop(0, '#dec5a2');
  grad.addColorStop(1, '#a9876a');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(pinX, pinY, PIN_RADIUS, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#5b3b2a';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  if (pressing) {
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(pinX, pinY, PIN_RADIUS + 3, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Hold-to-win progress strip at top
  if (holdMs > 0) {
    const frac = Math.min(1, holdMs / HOLD_TO_WIN_MS);
    ctx.fillStyle = 'rgba(116, 200, 130, 0.85)';
    ctx.fillRect(0, 0, W * frac, 3);
  }

  // Level label
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.font = '11px system-ui, -apple-system, sans-serif';
  ctx.fillText(`Seviye ${level}`, 8, 15);
}

function loop(ts: number): void {
  rafId = 0;
  if (state !== 'playing') return;
  const myGen = gen.current();
  if (lastFrameMs === 0) lastFrameMs = ts;
  const dt = Math.min(40, ts - lastFrameMs);
  lastFrameMs = ts;

  timeMs -= dt;
  if (timeMs <= 0) {
    timeMs = 0;
    endGame('time');
    render();
    return;
  }

  const dx = pinX - lastPinX;
  applyRolling(dx);
  lastPinX = pinX;

  for (let i = 0; i < CELLS; i++) {
    if (thickness[i]! < MIN_THICK) {
      endGame('tear');
      render();
      return;
    }
  }

  let allInBand = true;
  for (let i = 0; i < CELLS; i++) {
    const t = thickness[i]!;
    if (t < TARGET_MIN || t > TARGET_MAX) {
      allInBand = false;
      break;
    }
  }
  if (allInBand) {
    holdMs += dt;
    if (holdMs >= HOLD_TO_WIN_MS) {
      advanceLevel();
    }
  } else if (holdMs > 0) {
    holdMs = Math.max(0, holdMs - dt * 0.6);
  }

  timeEl.textContent = (timeMs / 1000).toFixed(1);
  render();
  if (gen.isCurrent(myGen) && state === 'playing') {
    rafId = requestAnimationFrame(loop);
  }
}

function advanceLevel(): void {
  cleared++;
  level++;
  scoreEl.textContent = String(cleared);
  thickness = generateLevel(level);
  holdMs = 0;
  timeMs = Math.min(LEVEL_TIME_MS, timeMs + LEVEL_BONUS_MS);
  pressing = false;
  lastPinX = pinX;
}

function endGame(reason: 'tear' | 'time'): void {
  if (cleared > best) {
    best = cleared;
    safeWrite(STORAGE_BEST, best);
  }
  bestEl.textContent = String(best);
  state = 'gameover';
  pressing = false;
  gen.bump();

  if (reason === 'tear') {
    overlayTitle.textContent = 'Hamur yırtıldı';
    overlayMsg.textContent =
      `Bir hücre çok inceldi.\nGeçilen seviye: ${cleared}  ·  Rekor: ${best}`;
  } else {
    overlayTitle.textContent = 'Süre bitti';
    overlayMsg.textContent =
      `Geçilen seviye: ${cleared}  ·  Rekor: ${best}`;
  }
  overlayBtn.textContent = 'Tekrar oyna';
  showOverlay(overlay);
}

function startGame(): void {
  gen.bump();
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
  cleared = 0;
  level = 1;
  thickness = generateLevel(level);
  timeMs = LEVEL_TIME_MS;
  holdMs = 0;
  pressing = false;
  pinX = W / 2;
  lastPinX = pinX;
  lastFrameMs = 0;
  state = 'playing';
  scoreEl.textContent = '0';
  timeEl.textContent = (LEVEL_TIME_MS / 1000).toFixed(1);
  hideOverlay(overlay);
  render();
  rafId = requestAnimationFrame(loop);
}

function reset(): void {
  startGame();
}

function pointerToCanvasX(e: PointerEvent): number {
  const rect = canvas.getBoundingClientRect();
  const x = ((e.clientX - rect.left) * W) / Math.max(1, rect.width);
  return Math.max(PIN_RADIUS, Math.min(W - PIN_RADIUS, x));
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#stage')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  timeEl = document.querySelector<HTMLElement>('#time')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;

  best = safeRead<number>(STORAGE_BEST, 0);
  bestEl.textContent = String(best);
  scoreEl.textContent = '0';
  timeEl.textContent = (LEVEL_TIME_MS / 1000).toFixed(0);
  thickness = generateLevel(1);

  canvas.addEventListener('pointerdown', (e) => {
    if (state !== 'playing') return;
    pinX = pointerToCanvasX(e);
    lastPinX = pinX;
    pressing = true;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (state !== 'playing') return;
    pinX = pointerToCanvasX(e);
    e.preventDefault();
  });
  const releasePointer = (e: PointerEvent): void => {
    pressing = false;
    if (canvas.hasPointerCapture(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId);
    }
  };
  canvas.addEventListener('pointerup', releasePointer);
  canvas.addEventListener('pointercancel', releasePointer);
  canvas.addEventListener('pointerleave', () => {
    pressing = false;
  });

  restartBtn.addEventListener('click', () => startGame());
  overlayBtn.addEventListener('click', () => startGame());

  window.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 'r') {
      startGame();
      e.preventDefault();
    } else if (e.key === ' ' || e.key === 'Enter') {
      if (state !== 'playing') {
        startGame();
        e.preventDefault();
      }
    }
  });

  state = 'ready';
  overlayTitle.textContent = 'Yufka açma';
  overlayMsg.textContent =
    'Merdaneyi hamurun üstünde sürükle (basılı tut). Bastırınca hamur ' +
    'hareket yönüne doğru akar — kalın yerden ince yere doğru sıvazla. ' +
    'Tüm hücreleri yeşil banda taşırsan seviye geçersin. Çok inceltirsen ' +
    'yırtarsın.';
  overlayBtn.textContent = 'Başla';
  showOverlay(overlay);
  render();
}

export const game = defineGame({ init, reset });
