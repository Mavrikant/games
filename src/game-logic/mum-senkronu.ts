import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';

// PITFALLS guarded by this module:
// - unguarded-storage:    safeRead/safeWrite wrap localStorage.
// - stale-async-callback: gen.bump() in reset() invalidates pending RAF.
// - overlay-input-leak:   explicit `state` enum; pointer handler guards state.
// - module-level-dom-access: all queries + listeners live inside init().
// - hud-counter-synced-only-at-lifecycle-edges: score/level DOM written
//   immediately whenever the underlying var changes (see commitScore, setLevel).

const STORAGE_BEST = 'mum-senkronu.best';

type State = 'ready' | 'playing' | 'gameover';

interface Candle {
  brightness: number;
  decayPerSec: number;
}

const BOARD_W = 480;
const BOARD_H = 480;

const SYNC_THRESHOLD = 0.72;
const SYNC_HOLD_MS = 800;
const RELIGHT_TO = 1;
const NEIGHBOR_BONUS = 0.18;
const DEATH_DARK_MS = 2400;

const gen = createGenToken();

let state: State = 'ready';
let score = 0;
let best = 0;
let level = 1;
let candles: Candle[] = [];
let darknessTimers: number[] = [];
let syncProgressMs = 0;
let lastTs = 0;
let rafHandle = 0;
let myToken = 0;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let levelEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlayEl!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let syncFill!: HTMLElement;

const cssCache = new Map<string, string>();
function css(name: string): string {
  const cached = cssCache.get(name);
  if (cached !== undefined) return cached;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  cssCache.set(name, v || '#fff');
  return cssCache.get(name)!;
}

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.innerHTML = msg;
  showOverlayEl(overlayEl);
}
function hideOverlay(): void {
  hideOverlayEl(overlayEl);
}

function candleCountForLevel(lv: number): number {
  return Math.min(7, 4 + Math.floor((lv - 1) / 3));
}

function makeCandles(lv: number): Candle[] {
  const n = candleCountForLevel(lv);
  const baseLo = 0.16 + lv * 0.012;
  const baseHi = 0.30 + lv * 0.030;
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const rate = baseLo + Math.random() * (baseHi - baseLo);
    out.push({ brightness: 0.35 + Math.random() * 0.25, decayPerSec: rate });
  }
  return out;
}

function setLevel(lv: number): void {
  level = lv;
  levelEl.textContent = String(level);
}

function commitScore(): void {
  scoreEl.textContent = String(score);
  if (score > best) {
    best = score;
    bestEl.textContent = String(best);
    safeWrite(STORAGE_BEST, best);
  }
}

function reset(): void {
  gen.bump();
  myToken = gen.current();
  cancelAnimationFrame(rafHandle);
  state = 'ready';
  score = 0;
  setLevel(1);
  candles = makeCandles(1);
  darknessTimers = candles.map(() => 0);
  syncProgressMs = 0;
  syncFill.style.width = '0%';
  commitScore();
  draw();
  showOverlay(
    'Mum Senkronu',
    'Her mum kendi hızında söner. Hepsinin alevini aynı anda zirvede tut — kısa süre öyle kalırsan seviye atlarsın. Bir mum tamamen söner ve yanmadan kalırsa oyun biter.<br/><br/>Başlamak için herhangi bir muma dokun.',
  );
}

function startPlaying(): void {
  if (state !== 'ready') return;
  state = 'playing';
  syncProgressMs = 0;
  syncFill.style.width = '0%';
  hideOverlay();
  lastTs = performance.now();
  myToken = gen.current();
  rafHandle = requestAnimationFrame(loop);
}

function nextLevel(): void {
  score += 1;
  commitScore();
  setLevel(level + 1);
  candles = makeCandles(level);
  darknessTimers = candles.map(() => 0);
  syncProgressMs = 0;
  syncFill.style.width = '0%';
}

function endGame(reason: string): void {
  state = 'gameover';
  cancelAnimationFrame(rafHandle);
  commitScore();
  showOverlay(
    'Oyun bitti',
    `${reason}<br/>Skor: ${score} · Seviye: ${level}<br/>R veya Yeniden başla ile tekrar dene.`,
  );
}

function allBright(): boolean {
  for (const c of candles) {
    if (c.brightness < SYNC_THRESHOLD) return false;
  }
  return true;
}

function loop(ts: number): void {
  if (state !== 'playing' || myToken !== gen.current()) return;
  const dtRaw = ts - lastTs;
  lastTs = ts;
  const dt = Math.min(dtRaw, 80);
  const dtSec = dt / 1000;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    c.brightness -= c.decayPerSec * dtSec;
    if (c.brightness <= 0) {
      c.brightness = 0;
      darknessTimers[i] = (darknessTimers[i] ?? 0) + dt;
      if ((darknessTimers[i] ?? 0) >= DEATH_DARK_MS) {
        endGame('Bir mum tamamen söndü.');
        draw();
        return;
      }
    } else {
      darknessTimers[i] = 0;
    }
  }

  if (allBright()) {
    syncProgressMs += dt;
    if (syncProgressMs >= SYNC_HOLD_MS) {
      nextLevel();
    }
  } else if (syncProgressMs > 0) {
    syncProgressMs = Math.max(0, syncProgressMs - dt * 2);
  }
  syncFill.style.width = ((syncProgressMs / SYNC_HOLD_MS) * 100).toFixed(1) + '%';

  draw();
  rafHandle = requestAnimationFrame(loop);
}

interface CandleRect { cx: number; baseY: number; w: number; h: number; slot: number; }

function candleRect(i: number, n: number): CandleRect {
  const margin = 36;
  const slot = (BOARD_W - margin * 2) / n;
  const cx = margin + slot * (i + 0.5);
  const w = Math.min(54, slot * 0.55);
  const h = 180;
  const baseY = BOARD_H * 0.78;
  return { cx, baseY, w, h, slot };
}

function draw(): void {
  const grad = ctx.createLinearGradient(0, 0, 0, BOARD_H);
  grad.addColorStop(0, css('--ms-bg-top'));
  grad.addColorStop(1, css('--ms-bg-bot'));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, BOARD_W, BOARD_H);

  ctx.strokeStyle = css('--ms-table');
  ctx.lineWidth = 2;
  const tableY = BOARD_H * 0.78 + 10;
  ctx.beginPath();
  ctx.moveTo(20, tableY);
  ctx.lineTo(BOARD_W - 20, tableY);
  ctx.stroke();

  for (let i = 0; i < candles.length; i++) {
    drawCandle(i, candles[i]!);
  }
}

function drawCandle(i: number, c: Candle): void {
  const { cx, baseY, w, h } = candleRect(i, candles.length);
  const wax = css('--ms-wax');
  const wax2 = css('--ms-wax-dim');
  const wickColor = css('--ms-wick');

  const flameY = baseY - h - 6;
  const glowR = 70 + 60 * c.brightness;
  const halo = ctx.createRadialGradient(cx, flameY, 0, cx, flameY, glowR);
  const a = 0.55 * c.brightness;
  halo.addColorStop(0, `rgba(255, 196, 96, ${a})`);
  halo.addColorStop(0.4, `rgba(255, 140, 60, ${a * 0.45})`);
  halo.addColorStop(1, 'rgba(255, 140, 60, 0)');
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(cx, flameY, glowR, 0, Math.PI * 2);
  ctx.fill();

  const waxGrad = ctx.createLinearGradient(cx - w / 2, 0, cx + w / 2, 0);
  waxGrad.addColorStop(0, wax2);
  waxGrad.addColorStop(0.5, wax);
  waxGrad.addColorStop(1, wax2);
  ctx.fillStyle = waxGrad;
  roundedRect(cx - w / 2, baseY - h, w, h, 6);
  ctx.fill();

  ctx.fillStyle = wax;
  ctx.beginPath();
  ctx.ellipse(cx, baseY - h, w / 2, 4, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = wickColor;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx, baseY - h - 2);
  ctx.lineTo(cx, baseY - h - 12);
  ctx.stroke();

  const flameH = 4 + 36 * c.brightness;
  const flameW = 8 + 16 * c.brightness;
  const flameTop = baseY - h - 12 - flameH;

  if (c.brightness > 0.02) {
    ctx.fillStyle = `rgba(255, 170, 60, ${0.55 + 0.4 * c.brightness})`;
    ctx.beginPath();
    ctx.moveTo(cx, flameTop);
    ctx.quadraticCurveTo(cx + flameW, baseY - h - 12 - flameH * 0.3, cx, baseY - h - 8);
    ctx.quadraticCurveTo(cx - flameW, baseY - h - 12 - flameH * 0.3, cx, flameTop);
    ctx.fill();
    ctx.fillStyle = `rgba(255, 240, 200, ${0.85 * c.brightness})`;
    ctx.beginPath();
    ctx.moveTo(cx, flameTop + flameH * 0.3);
    ctx.quadraticCurveTo(cx + flameW * 0.55, baseY - h - 14 - flameH * 0.25, cx, baseY - h - 12);
    ctx.quadraticCurveTo(cx - flameW * 0.55, baseY - h - 14 - flameH * 0.25, cx, flameTop + flameH * 0.3);
    ctx.fill();
  } else {
    ctx.fillStyle = 'rgba(255, 90, 50, 0.6)';
    ctx.beginPath();
    ctx.arc(cx, baseY - h - 10, 2, 0, Math.PI * 2);
    ctx.fill();
  }

  const gaugeX = cx + w / 2 + 6;
  const gaugeY0 = baseY - 4;
  const gaugeY1 = baseY - h + 4;
  const gaugeH = gaugeY0 - gaugeY1;
  ctx.strokeStyle = css('--ms-gauge');
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(gaugeX, gaugeY0);
  ctx.lineTo(gaugeX, gaugeY1);
  ctx.stroke();
  const fillTop = gaugeY0 - gaugeH * c.brightness;
  ctx.strokeStyle =
    c.brightness >= SYNC_THRESHOLD
      ? css('--ms-bright')
      : c.brightness > 0.3
        ? css('--ms-mid')
        : css('--ms-dim');
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(gaugeX, gaugeY0);
  ctx.lineTo(gaugeX, fillTop);
  ctx.stroke();
  const tY = gaugeY0 - gaugeH * SYNC_THRESHOLD;
  ctx.strokeStyle = css('--ms-gauge-mark');
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(gaugeX - 4, tY);
  ctx.lineTo(gaugeX + 4, tY);
  ctx.stroke();

  ctx.fillStyle = css('--ms-label');
  ctx.font = '12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(String(i + 1), cx, baseY + 16);
}

function roundedRect(x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function candleAt(canvasX: number, canvasY: number): number {
  for (let i = 0; i < candles.length; i++) {
    const { cx, baseY, w, h, slot } = candleRect(i, candles.length);
    const hitW = Math.max(w + 16, slot * 0.9);
    const left = cx - hitW / 2;
    const right = cx + hitW / 2;
    const top = baseY - h - 60;
    const bot = baseY + 28;
    if (canvasX >= left && canvasX <= right && canvasY >= top && canvasY <= bot) {
      return i;
    }
  }
  return -1;
}

function lightCandle(i: number): void {
  if (i < 0 || i >= candles.length) return;
  candles[i]!.brightness = RELIGHT_TO;
  darknessTimers[i] = 0;
  if (i - 1 >= 0) {
    const left = candles[i - 1]!;
    left.brightness = Math.min(1, left.brightness + NEIGHBOR_BONUS);
    darknessTimers[i - 1] = 0;
  }
  if (i + 1 < candles.length) {
    const right = candles[i + 1]!;
    right.brightness = Math.min(1, right.brightness + NEIGHBOR_BONUS);
    darknessTimers[i + 1] = 0;
  }
}

function handlePointer(clientX: number, clientY: number): void {
  if (state === 'gameover') return;
  const rect = canvas.getBoundingClientRect();
  const x = ((clientX - rect.left) / rect.width) * BOARD_W;
  const y = ((clientY - rect.top) / rect.height) * BOARD_H;
  const idx = candleAt(x, y);
  if (idx < 0) return;
  if (state === 'ready') startPlaying();
  lightCandle(idx);
  // Immediate redraw → guarantees <250ms visual feedback on first ready→playing
  // transition before the first RAF tick (PITFALLS#invisible-boot).
  draw();
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  levelEl = document.querySelector<HTMLElement>('#level')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlayEl = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  syncFill = document.querySelector<HTMLElement>('#sync-fill')!;

  best = safeRead<number>(STORAGE_BEST, 0);
  bestEl.textContent = String(best);

  restartBtn.addEventListener('click', () => {
    reset();
  });

  canvas.addEventListener('pointerdown', (e) => {
    handlePointer(e.clientX, e.clientY);
    e.preventDefault();
  });

  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    const k = e.key.toLowerCase();
    if (k === 'r') {
      reset();
      e.preventDefault();
      return;
    }
    if (k === ' ' || k === 'spacebar' || k === 'enter') {
      if (state === 'ready') startPlaying();
      else if (state === 'gameover') reset();
      e.preventDefault();
      return;
    }
    if (state === 'gameover') return;
    const n = Number(k);
    if (Number.isInteger(n) && n >= 1 && n <= candles.length) {
      if (state === 'ready') startPlaying();
      lightCandle(n - 1);
      draw();
      e.preventDefault();
    }
  });

  overlayEl.addEventListener('click', (e) => {
    if (e.target !== overlayEl) return;
    if (state === 'ready') {
      // Backdrop tap doesn't auto-start; player should tap an actual candle
      // (this avoids accidental starts when dismissing the intro overlay).
      return;
    }
    if (state === 'gameover') reset();
  });

  reset();
}

export const game = defineGame({ init, reset });
