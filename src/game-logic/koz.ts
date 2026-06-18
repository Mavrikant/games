import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';
import { reportGameOver } from '@shared/leaderboard';

// PITFALLS guarded:
// - unguarded-storage: safeRead/safeWrite wrap localStorage.
// - stale-async-callback: gen.bump() in reset() cancels in-flight RAFs/timeouts.
// - overlay-input-leak: input handlers gate on `state` and `pointerdown` lives
//   on the overlay too so the gameover screen can also start a new run.
// - module-level side effects: all DOM access lives in init().

const STORAGE_BEST = 'koz.best';
const SCORE_DESC = { gameId: 'koz', storageKey: STORAGE_BEST, direction: 'higher' as const };

const EMBER_COUNT = 7;
const RING_RADIUS = 150;
const BOOST_TO = 100;
const NEIGHBOR_DRAIN = 22;
const BASE_DECAY = 4.5;
const DECAY_RAMP_PER_SEC = 0.06;
const WIND_INITIAL_DELAY = 6;
const WIND_PERIOD_INITIAL = 11;
const WIND_PERIOD_FLOOR = 4.5;
const WIND_PERIOD_DECAY = 0.025;
const WIND_WARN = 1.0;
const WIND_HIT = 28;

type State = 'ready' | 'playing' | 'gameover';

type Ember = {
  intensity: number;
  flash: number;
  x: number;
  y: number;
};

type Wind = {
  warnUntil: number;
  hitAt: number;
  dirX: number;
  dirY: number;
};

const gen = createGenToken();
let state: State = 'ready';

let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let aliveEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;

let embers: Ember[] = [];
let elapsed = 0;
let best = 0;
let nextWindAt = 0;
let wind: Wind | null = null;
let lastTs = 0;

function fmtTime(seconds: number): string {
  return seconds.toFixed(1);
}

function layoutEmbers(): void {
  embers = [];
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  for (let i = 0; i < EMBER_COUNT; i++) {
    const a = (i / EMBER_COUNT) * Math.PI * 2 - Math.PI / 2;
    embers.push({
      intensity: 70 + Math.random() * 20,
      flash: 0,
      x: cx + Math.cos(a) * RING_RADIUS,
      y: cy + Math.sin(a) * RING_RADIUS,
    });
  }
}

function aliveCount(): number {
  let n = 0;
  for (const e of embers) if (e.intensity > 0) n++;
  return n;
}

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlay);
}

function hideOverlay(): void {
  hideOverlayEl(overlay);
}

function startRun(): void {
  state = 'playing';
  elapsed = 0;
  nextWindAt = WIND_INITIAL_DELAY;
  wind = null;
  hideOverlay();
}

function endRun(): void {
  state = 'gameover';
  if (elapsed > best) {
    best = elapsed;
    safeWrite(STORAGE_BEST, best);
  }
  reportGameOver(SCORE_DESC, elapsed);
  showOverlay(
    'Ateş söndü',
    `Süre: ${fmtTime(elapsed)} sn · En iyi: ${fmtTime(best)} sn\nYeniden başlamak için tıkla veya R'ye bas.`,
  );
}

function reset(): void {
  gen.bump();
  state = 'ready';
  elapsed = 0;
  wind = null;
  nextWindAt = WIND_INITIAL_DELAY;
  lastTs = 0;
  layoutEmbers();
  showOverlay(
    'Köz',
    'Yedi kor sönüyor. Bir kora tıkladığında o yoğunluğunu kazanır ama iki komşusu oksijensiz kalır. Mümkün olduğunca uzun süre canlı tut.\nBaşlamak için bir kora tıkla veya 1-7 tuşlarına bas.',
  );
  updateHud();
}

function updateHud(): void {
  scoreEl.textContent = fmtTime(elapsed);
  bestEl.textContent = fmtTime(best);
  const a = aliveCount();
  aliveEl.textContent = `${a}/${EMBER_COUNT}`;
}

function fan(i: number): void {
  if (state === 'gameover') return;
  if (i < 0 || i >= embers.length) return;
  const target = embers[i]!;
  if (target.intensity <= 0) return;
  if (state === 'ready') startRun();
  target.intensity = BOOST_TO;
  target.flash = 1;
  const leftIdx = (i - 1 + EMBER_COUNT) % EMBER_COUNT;
  const rightIdx = (i + 1) % EMBER_COUNT;
  for (const ni of [leftIdx, rightIdx]) {
    const n = embers[ni]!;
    if (n.intensity > 0) {
      n.intensity = Math.max(0, n.intensity - NEIGHBOR_DRAIN);
    }
  }
}

function scheduleWind(): void {
  const angle = Math.random() * Math.PI * 2;
  wind = {
    warnUntil: elapsed + WIND_WARN,
    hitAt: elapsed + WIND_WARN,
    dirX: Math.cos(angle),
    dirY: Math.sin(angle),
  };
}

function applyWind(w: Wind): void {
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  for (const e of embers) {
    if (e.intensity <= 0) continue;
    const rx = e.x - cx;
    const ry = e.y - cy;
    const dot = rx * w.dirX + ry * w.dirY;
    if (dot < 0) continue;
    const norm = dot / RING_RADIUS;
    const hit = WIND_HIT * Math.max(0.2, norm);
    e.intensity = Math.max(0, e.intensity - hit);
    e.flash = Math.max(e.flash, 0.6);
  }
}

function step(dt: number): void {
  if (state !== 'playing') return;
  elapsed += dt;
  const decay = BASE_DECAY + DECAY_RAMP_PER_SEC * elapsed;
  for (const e of embers) {
    if (e.intensity > 0) {
      e.intensity = Math.max(0, e.intensity - decay * dt);
    }
    if (e.flash > 0) e.flash = Math.max(0, e.flash - dt * 2);
  }

  if (wind && elapsed >= wind.hitAt) {
    applyWind(wind);
    wind = null;
    const period = Math.max(
      WIND_PERIOD_FLOOR,
      WIND_PERIOD_INITIAL - WIND_PERIOD_DECAY * elapsed * elapsed * 0.5,
    );
    nextWindAt = elapsed + period;
  } else if (!wind && elapsed >= nextWindAt) {
    scheduleWind();
  }

  if (aliveCount() <= 1) {
    endRun();
  }
}

function drawBackground(): void {
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const grad = ctx.createRadialGradient(cx, cy, 8, cx, cy, canvas.width * 0.65);
  grad.addColorStop(0, '#1f1410');
  grad.addColorStop(0.55, '#141014');
  grad.addColorStop(1, '#08070a');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.save();
  ctx.globalAlpha = 0.18;
  ctx.strokeStyle = '#3a2a22';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, RING_RADIUS, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function emberColor(intensity: number): string {
  if (intensity <= 0) return '#2a1a14';
  const t = Math.max(0, Math.min(1, intensity / 100));
  const hue = 12 + t * 38;
  const sat = 70 + t * 25;
  const light = 30 + t * 30;
  return `hsl(${hue} ${sat}% ${light}%)`;
}

function drawEmbers(): void {
  for (let i = 0; i < embers.length; i++) {
    const e = embers[i]!;
    const alive = e.intensity > 0;
    const t = Math.max(0, Math.min(1, e.intensity / 100));
    const baseR = 13;
    const glowR = baseR + t * 10;

    if (alive) {
      ctx.save();
      const halo = ctx.createRadialGradient(e.x, e.y, glowR * 0.4, e.x, e.y, glowR * 3.4);
      const a = (0.35 + 0.55 * t) * (0.7 + e.flash * 0.6);
      halo.addColorStop(0, `hsla(${18 + t * 30}, 90%, 55%, ${a.toFixed(3)})`);
      halo.addColorStop(1, 'hsla(18, 90%, 30%, 0)');
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(e.x, e.y, glowR * 3.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    ctx.beginPath();
    ctx.fillStyle = emberColor(e.intensity);
    ctx.arc(e.x, e.y, baseR, 0, Math.PI * 2);
    ctx.fill();

    if (alive && t > 0.5) {
      ctx.beginPath();
      ctx.fillStyle = `hsla(48, 90%, 75%, ${(t - 0.5) * 1.4})`;
      ctx.arc(e.x - baseR * 0.25, e.y - baseR * 0.3, baseR * 0.4, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.fillStyle = alive ? 'rgba(255,232,196,0.65)' : 'rgba(180,150,140,0.45)';
    ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(i + 1), e.x, e.y + baseR + 14);
  }
}

function drawWindWarning(): void {
  if (!wind) return;
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const half = canvas.width / 2 - 18;
  const tipX = cx + wind.dirX * half;
  const tipY = cy + wind.dirY * half;
  const baseX = cx + wind.dirX * (half - 28);
  const baseY = cy + wind.dirY * (half - 28);
  const remain = Math.max(0, wind.hitAt - elapsed) / WIND_WARN;
  const alpha = 0.4 + (1 - remain) * 0.5;

  ctx.save();
  ctx.strokeStyle = `rgba(255, 180, 130, ${alpha.toFixed(3)})`;
  ctx.fillStyle = `rgba(255, 180, 130, ${alpha.toFixed(3)})`;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(baseX, baseY);
  ctx.lineTo(tipX, tipY);
  ctx.stroke();

  const ang = Math.atan2(wind.dirY, wind.dirX);
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(tipX - Math.cos(ang - 0.5) * 14, tipY - Math.sin(ang - 0.5) * 14);
  ctx.lineTo(tipX - Math.cos(ang + 0.5) * 14, tipY - Math.sin(ang + 0.5) * 14);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function draw(): void {
  drawBackground();
  drawEmbers();
  if (state === 'playing') drawWindWarning();
}

function loop(ts: number): void {
  if (lastTs === 0) lastTs = ts;
  const dt = Math.min(0.05, (ts - lastTs) / 1000);
  lastTs = ts;
  step(dt);
  draw();
  updateHud();
  requestAnimationFrame(loop);
}

function pickEmberAt(px: number, py: number): number {
  let bestIdx = -1;
  let bestDist = 36 * 36;
  for (let i = 0; i < embers.length; i++) {
    const e = embers[i]!;
    const dx = e.x - px;
    const dy = e.y - py;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestDist) {
      bestDist = d2;
      bestIdx = i;
    }
  }
  return bestIdx;
}

function onPointer(ev: PointerEvent): void {
  if (state === 'gameover') {
    reset();
    return;
  }
  const rect = canvas.getBoundingClientRect();
  const px = ((ev.clientX - rect.left) / rect.width) * canvas.width;
  const py = ((ev.clientY - rect.top) / rect.height) * canvas.height;
  const i = pickEmberAt(px, py);
  if (i >= 0) fan(i);
}

function onKey(ev: KeyboardEvent): void {
  const k = ev.key.toLowerCase();
  if (k === 'r') {
    reset();
    ev.preventDefault();
    return;
  }
  if (state === 'gameover') return;
  if (k >= '1' && k <= '7') {
    fan(parseInt(k, 10) - 1);
    ev.preventDefault();
  }
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  aliveEl = document.querySelector<HTMLElement>('#alive')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  canvas.addEventListener('pointerdown', onPointer);
  overlay.addEventListener('pointerdown', onPointer);
  restartBtn.addEventListener('click', reset);
  window.addEventListener('keydown', onKey);

  reset();
  requestAnimationFrame(loop);
}

export const game = defineGame({ init, reset });
