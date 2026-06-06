import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';
import { reportGameOver } from '@shared/leaderboard';

type State = 'ready' | 'playing' | 'gameover';

interface Plate {
  energy: number;
  rotation: number;
  flashUntil: number;
}

const STORAGE_BEST = 'tabak-cevir.best';
const SCORE_DESC = { gameId: 'tabak-cevir', storageKey: STORAGE_BEST, direction: 'higher' as const };
const START_PLATES = 5;
const MAX_PLATES = 9;
const ENERGY_FULL = 100;
const TAP_GAIN = 70;
const ADD_PLATE_EVERY_MS = 14_000;
const PLATE_RADIUS_BASE = 34;
const POLE_HEIGHT = 220;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let platesEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let startBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;

let state: State = 'ready';
let plates: Plate[] = [];
let score = 0;
let best = 0;
let startTime = 0;
let lastFrame = 0;
let nextPlateAt = 0;
let rafId = 0;

function plateX(i: number, count: number): number {
  const w = canvas.width;
  const margin = 60;
  if (count === 1) return w / 2;
  const step = (w - 2 * margin) / (count - 1);
  return margin + step * i;
}

function plateBaseY(): number {
  return canvas.height - 24;
}

function plateTopY(): number {
  return plateBaseY() - POLE_HEIGHT;
}

function plateRadius(count: number): number {
  if (count <= 6) return PLATE_RADIUS_BASE;
  return PLATE_RADIUS_BASE - (count - 6) * 2;
}

function decayRate(): number {
  const t = (performance.now() - startTime) / 1000;
  return 5 + Math.min(20, t * 0.25) + plates.length * 0.6;
}

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  startBtn.textContent = state === 'gameover' ? 'Tekrar oyna' : 'Başla';
  showOverlayEl(overlay);
}

function hideOverlay(): void {
  hideOverlayEl(overlay);
}

function makePlate(): Plate {
  return { energy: ENERGY_FULL, rotation: Math.random() * Math.PI * 2, flashUntil: 0 };
}

function reset(): void {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
  state = 'ready';
  plates = [];
  for (let i = 0; i < START_PLATES; i++) plates.push(makePlate());
  score = 0;
  scoreEl.textContent = '0';
  bestEl.textContent = String(best);
  platesEl.textContent = String(plates.length);
  draw();
  showOverlay('Tabak Çevir', 'Tabaklara tıklayarak başla. Hiçbiri düşmesin!');
}

function start(): void {
  if (state === 'playing') return;
  state = 'playing';
  startTime = performance.now();
  lastFrame = startTime;
  nextPlateAt = startTime + ADD_PLATE_EVERY_MS;
  for (const p of plates) p.energy = ENERGY_FULL;
  hideOverlay();
  rafId = requestAnimationFrame(loop);
}

function gameOver(reason: string): void {
  if (state !== 'playing') return;
  state = 'gameover';
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
  if (score > best) {
    best = score;
    bestEl.textContent = String(best);
    safeWrite(STORAGE_BEST, best);
  }
  reportGameOver(SCORE_DESC, score);
  draw();
  showOverlay('Tabak Düştü!', `${reason}\nSkor: ${score} · Rekor: ${best}`);
}

function tapPlate(i: number): void {
  if (state !== 'playing') return;
  const p = plates[i];
  if (!p || p.energy <= 0) return;
  p.energy = Math.min(ENERGY_FULL, p.energy + TAP_GAIN);
  p.flashUntil = performance.now() + 220;
}

function pickPlate(px: number, py: number): number {
  const count = plates.length;
  const r = plateRadius(count);
  const top = plateTopY();
  const base = plateBaseY();
  for (let i = 0; i < count; i++) {
    const cx = plateX(i, count);
    const dx = px - cx;
    const dyTop = py - top;
    if (Math.abs(dx) <= r * 1.6 && dyTop * dyTop + dx * dx <= (r * 2.2) * (r * 2.2)) {
      return i;
    }
    if (Math.abs(dx) <= Math.max(12, r * 0.6) && py >= top && py <= base) {
      return i;
    }
  }
  return -1;
}

function loop(now: number): void {
  if (state !== 'playing') return;
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;

  const rate = decayRate();
  for (const p of plates) {
    if (p.energy <= 0) continue;
    p.energy -= rate * dt;
    const spinSpeed = 0.6 + (p.energy / ENERGY_FULL) * 4.2;
    p.rotation += spinSpeed * dt;
    if (p.energy <= 0) {
      p.energy = 0;
      gameOver('Bir tabak yere düştü.');
      return;
    }
  }

  score = Math.floor((now - startTime) / 100);
  scoreEl.textContent = String(score);

  if (plates.length < MAX_PLATES && now >= nextPlateAt) {
    plates.push(makePlate());
    plates[plates.length - 1]!.energy = ENERGY_FULL;
    platesEl.textContent = String(plates.length);
    nextPlateAt = now + ADD_PLATE_EVERY_MS;
  }

  draw();
  rafId = requestAnimationFrame(loop);
}

function energyColor(e: number): string {
  if (e > 60) return getCss('--plate-ok');
  if (e > 30) return getCss('--plate-warn');
  return getCss('--plate-danger');
}

function draw(): void {
  ctx.fillStyle = getCss('--surface');
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = getCss('--stage-floor');
  ctx.fillRect(0, plateBaseY(), canvas.width, canvas.height - plateBaseY());

  const count = plates.length;
  const r = plateRadius(count);
  const top = plateTopY();
  const base = plateBaseY();
  const now = performance.now();

  for (let i = 0; i < count; i++) {
    const p = plates[i]!;
    const x = plateX(i, count);
    const energyFrac = Math.max(0, p.energy / ENERGY_FULL);
    const wobble = (1 - energyFrac) * 14;
    const sway = Math.sin(now / 180 + i * 1.3) * wobble;

    ctx.strokeStyle = getCss('--pole');
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(x, base);
    ctx.lineTo(x + sway * 0.3, top);
    ctx.stroke();

    const cx = x + sway * 0.3;
    const cy = top;
    const tilt = sway * 0.05;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(tilt);

    const flashing = now < p.flashUntil;
    ctx.fillStyle = flashing ? getCss('--plate-flash') : energyColor(p.energy);
    ctx.beginPath();
    ctx.ellipse(0, 0, r, r * 0.35, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = getCss('--plate-rim');
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = getCss('--plate-pattern');
    const segs = 6;
    for (let s = 0; s < segs; s++) {
      const a = (s / segs) * Math.PI * 2 + p.rotation;
      const px = Math.cos(a) * r * 0.55;
      const py = Math.sin(a) * r * 0.18;
      ctx.beginPath();
      ctx.arc(px, py, 2.4, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();

    const barW = r * 1.6;
    const barH = 6;
    const bx = cx - barW / 2;
    const by = cy + r * 0.6 + 10;
    ctx.fillStyle = getCss('--bar-bg');
    ctx.fillRect(bx, by, barW, barH);
    ctx.fillStyle = energyColor(p.energy);
    ctx.fillRect(bx, by, barW * energyFrac, barH);

    ctx.fillStyle = getCss('--text-dim');
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(String(i + 1), cx, by + barH + 14);
  }

  if (state === 'playing') {
    const t = (performance.now() - startTime) / 1000;
    ctx.fillStyle = getCss('--text-dim');
    ctx.font = '600 13px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`${t.toFixed(1)}s · hız ×${(decayRate() / 5).toFixed(2)}`, 14, 22);
  }
}

const cssCache = new Map<string, string>();
function getCss(varName: string): string {
  const cached = cssCache.get(varName);
  if (cached !== undefined) return cached;
  const val = getComputedStyle(document.documentElement)
    .getPropertyValue(varName)
    .trim();
  cssCache.set(varName, val);
  return val;
}

function canvasCoords(e: PointerEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const sx = canvas.width / rect.width;
  const sy = canvas.height / rect.height;
  return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy };
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  platesEl = document.querySelector<HTMLElement>('#plates')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  startBtn = document.querySelector<HTMLButtonElement>('#start')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  canvas.addEventListener('pointerdown', (e) => {
    if (state === 'ready') {
      start();
      return;
    }
    if (state === 'gameover') {
      reset();
      start();
      return;
    }
    const { x, y } = canvasCoords(e);
    const i = pickPlate(x, y);
    if (i >= 0) tapPlate(i);
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'r' || e.key === 'R') {
      reset();
      e.preventDefault();
      return;
    }
    if (state === 'ready' || state === 'gameover') {
      if (e.key === ' ' || e.key === 'Enter') {
        if (state === 'gameover') reset();
        start();
        e.preventDefault();
      }
      return;
    }
    if (e.key >= '1' && e.key <= '9') {
      const i = parseInt(e.key, 10) - 1;
      tapPlate(i);
      e.preventDefault();
    }
  });

  startBtn.addEventListener('click', () => {
    if (state === 'gameover') reset();
    start();
  });
  restartBtn.addEventListener('click', reset);

  reset();
}

export const game = defineGame({ init, reset });
