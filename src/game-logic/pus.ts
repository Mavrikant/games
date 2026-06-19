import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay, hideOverlay } from '@shared/overlay';

const STORAGE_BEST = 'pus.best';
const TOTAL_TIME_MS = 60_000;
const PRE_REVEAL_BASE_MS = 1800;
const PRE_REVEAL_SHRINK_MS = 80;
const PRE_REVEAL_MIN_MS = 700;
const FLASHLIGHT_BASE = 78;
const FLASHLIGHT_SHRINK = 4;
const FLASHLIGHT_MIN = 32;
const CLICK_TOLERANCE = 26;
const GEMS_BASE = 3;
const GEM_RADIUS = 9;
const GEM_MIN_DIST = 64;
const BOARD_MARGIN = 38;

type State = 'ready' | 'preReveal' | 'playing' | 'gameover';

interface Gem {
  x: number;
  y: number;
  collected: boolean;
  pulse: number;
}

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let roundEl!: HTMLElement;
let timeEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;

let state: State = 'ready';
let score = 0;
let best = 0;
let round = 1;
let gems: Gem[] = [];
let runStartedAt = 0;
let preRevealEndsAt = 0;
let mouseX = 240;
let mouseY = 240;
let pointerInside = false;

function showStartOverlay(): void {
  overlayTitle.textContent = 'Pus';
  overlayMsg.textContent =
    'Önce gemler kısa süre görünür — yerlerini ezberle.\nSonra sis çöker; el feneriyle hatırladığın noktayı tıkla.\nBaşlamak için tıkla veya boşluğa bas.';
  showOverlay(overlay);
}

function showGameOverOverlay(): void {
  overlayTitle.textContent = 'Süre doldu';
  overlayMsg.textContent =
    `Topladığın gem: ${score}\nEn iyi: ${best}\nTekrar için tıkla, boşluğa bas veya R.`;
  showOverlay(overlay);
}

function flashlightRadius(): number {
  return Math.max(FLASHLIGHT_MIN, FLASHLIGHT_BASE - (round - 1) * FLASHLIGHT_SHRINK);
}

function preRevealDuration(): number {
  return Math.max(PRE_REVEAL_MIN_MS, PRE_REVEAL_BASE_MS - (round - 1) * PRE_REVEAL_SHRINK_MS);
}

function gemCountForRound(): number {
  return GEMS_BASE + (round - 1);
}

function dist(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}

function placeGems(): void {
  gems = [];
  const target = gemCountForRound();
  const w = canvas.width;
  const h = canvas.height;
  let attempts = 0;
  while (gems.length < target && attempts < 800) {
    attempts++;
    const x = BOARD_MARGIN + Math.random() * (w - BOARD_MARGIN * 2);
    const y = BOARD_MARGIN + Math.random() * (h - BOARD_MARGIN * 2);
    let ok = true;
    for (const g of gems) {
      if (dist(x, y, g.x, g.y) < GEM_MIN_DIST) {
        ok = false;
        break;
      }
    }
    if (ok) gems.push({ x, y, collected: false, pulse: 0 });
  }
}

function startRun(): void {
  hideOverlay(overlay);
  score = 0;
  round = 1;
  scoreEl.textContent = '0';
  roundEl.textContent = '1';
  runStartedAt = performance.now();
  pointerInside = false;
  mouseX = canvas.width / 2;
  mouseY = canvas.height / 2;
  beginRound();
}

function beginRound(): void {
  roundEl.textContent = String(round);
  state = 'preReveal';
  placeGems();
  preRevealEndsAt = performance.now() + preRevealDuration();
}

function timeLeftMs(): number {
  return Math.max(0, TOTAL_TIME_MS - (performance.now() - runStartedAt));
}

function endRun(): void {
  state = 'gameover';
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
  showGameOverOverlay();
}

function reset(): void {
  state = 'ready';
  score = 0;
  round = 1;
  gems = [];
  scoreEl.textContent = '0';
  roundEl.textContent = '1';
  timeEl.textContent = String(Math.ceil(TOTAL_TIME_MS / 1000));
  showStartOverlay();
}

function tryCollect(x: number, y: number): boolean {
  if (state !== 'playing') return false;
  let nearest: Gem | null = null;
  let nearestDist = Infinity;
  for (const g of gems) {
    if (g.collected) continue;
    const d = dist(x, y, g.x, g.y);
    if (d < nearestDist) {
      nearestDist = d;
      nearest = g;
    }
  }
  if (nearest && nearestDist <= CLICK_TOLERANCE) {
    nearest.collected = true;
    nearest.pulse = 1;
    score++;
    scoreEl.textContent = String(score);
    if (gems.every((g) => g.collected)) {
      round++;
      beginRound();
    }
    return true;
  }
  return false;
}

function getCssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

let surfaceColor = '#0e1014';
let textColor = '#e5e7eb';
let gemColor = '#fbbf24';
let collectedColor = '#34d399';
let flashColor = '#f8fafc';
let fogColor = '#06080c';
let accentColor = '#60a5fa';

function cacheColors(): void {
  surfaceColor = getCssVar('--surface', '#0e1014');
  textColor = getCssVar('--text', '#e5e7eb');
  gemColor = getCssVar('--pus-gem', '#fbbf24');
  collectedColor = getCssVar('--pus-gem-collected', '#34d399');
  flashColor = getCssVar('--pus-flashlight', '#f8fafc');
  fogColor = getCssVar('--pus-fog', '#06080c');
  accentColor = getCssVar('--accent', '#60a5fa');
}

function drawGem(g: Gem, full: boolean): void {
  const color = g.collected ? collectedColor : gemColor;
  const alpha = full ? 1 : g.collected ? 0.55 : 1;
  ctx.save();
  ctx.globalAlpha = alpha;
  const halo = ctx.createRadialGradient(g.x, g.y, 0, g.x, g.y, GEM_RADIUS * 2.4);
  halo.addColorStop(0, color + 'cc');
  halo.addColorStop(1, color + '00');
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(g.x, g.y, GEM_RADIUS * 2.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(g.x, g.y - GEM_RADIUS);
  ctx.lineTo(g.x + GEM_RADIUS, g.y);
  ctx.lineTo(g.x, g.y + GEM_RADIUS);
  ctx.lineTo(g.x - GEM_RADIUS, g.y);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.beginPath();
  ctx.moveTo(g.x - GEM_RADIUS * 0.45, g.y - GEM_RADIUS * 0.15);
  ctx.lineTo(g.x, g.y - GEM_RADIUS * 0.55);
  ctx.lineTo(g.x + GEM_RADIUS * 0.1, g.y - GEM_RADIUS * 0.15);
  ctx.lineTo(g.x - GEM_RADIUS * 0.15, g.y + GEM_RADIUS * 0.15);
  ctx.closePath();
  ctx.fill();
  if (g.collected && g.pulse > 0) {
    ctx.strokeStyle = collectedColor;
    ctx.globalAlpha = g.pulse;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(g.x, g.y, GEM_RADIUS + (1 - g.pulse) * 22, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function drawCursor(): void {
  if (!pointerInside) return;
  ctx.save();
  ctx.strokeStyle = flashColor;
  ctx.globalAlpha = 0.7;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(mouseX, mouseY, 4, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawBoardBackground(): void {
  ctx.fillStyle = surfaceColor;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  const step = 60;
  ctx.beginPath();
  for (let x = step; x < canvas.width; x += step) {
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, canvas.height);
  }
  for (let y = step; y < canvas.height; y += step) {
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(canvas.width, y + 0.5);
  }
  ctx.stroke();
  ctx.restore();
}

function drawPreRevealHint(): void {
  const remaining = preRevealEndsAt - performance.now();
  const ratio = Math.max(0, Math.min(1, remaining / preRevealDuration()));
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(canvas.width / 2 - 90, 8, 180, 26);
  ctx.fillStyle = accentColor;
  ctx.fillRect(canvas.width / 2 - 88, 10, 176 * ratio, 22);
  ctx.fillStyle = textColor;
  ctx.font = '600 13px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('Ezberle…', canvas.width / 2, 21);
  ctx.restore();
}

function drawFogWithHole(): void {
  const r = flashlightRadius();
  const cx = mouseX;
  const cy = mouseY;
  ctx.save();
  ctx.fillStyle = fogColor;
  ctx.globalAlpha = 0.96;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.globalCompositeOperation = 'destination-out';
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  grad.addColorStop(0, 'rgba(0,0,0,1)');
  grad.addColorStop(0.55, 'rgba(0,0,0,0.97)');
  grad.addColorStop(0.85, 'rgba(0,0,0,0.55)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.save();
  ctx.strokeStyle = flashColor;
  ctx.globalAlpha = 0.18;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function draw(): void {
  drawBoardBackground();

  if (state === 'ready' || state === 'gameover') {
    for (const g of gems) drawGem(g, false);
    return;
  }

  if (state === 'preReveal') {
    for (const g of gems) drawGem(g, true);
    drawPreRevealHint();
    return;
  }

  drawFogWithHole();

  for (const g of gems) {
    if (!g.collected) continue;
    drawGem(g, false);
    if (g.pulse > 0) g.pulse = Math.max(0, g.pulse - 0.04);
  }

  const r = flashlightRadius();
  for (const g of gems) {
    if (g.collected) continue;
    if (dist(g.x, g.y, mouseX, mouseY) <= r) {
      drawGem(g, true);
    }
  }

  drawCursor();
}

function loop(): void {
  if (state === 'preReveal' && performance.now() >= preRevealEndsAt) {
    state = 'playing';
  }

  if (state === 'playing' || state === 'preReveal') {
    const remaining = timeLeftMs();
    timeEl.textContent = String(Math.ceil(remaining / 1000));
    if (remaining <= 0) endRun();
  }

  draw();
  requestAnimationFrame(loop);
}

function canvasCoords(clientX: number, clientY: number): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return {
    x: (clientX - rect.left) * scaleX,
    y: (clientY - rect.top) * scaleY,
  };
}

function onPointerMove(e: PointerEvent): void {
  const { x, y } = canvasCoords(e.clientX, e.clientY);
  mouseX = x;
  mouseY = y;
  pointerInside = true;
}

function onPointerLeave(): void {
  pointerInside = false;
}

function onPointerDown(e: PointerEvent): void {
  const { x, y } = canvasCoords(e.clientX, e.clientY);
  mouseX = x;
  mouseY = y;
  pointerInside = true;

  if (state === 'ready' || state === 'gameover') {
    startRun();
    return;
  }
  if (state === 'playing') {
    tryCollect(x, y);
  }
}

function onKey(e: KeyboardEvent): void {
  const k = e.key;
  if (k === 'r' || k === 'R') {
    e.preventDefault();
    reset();
    return;
  }
  if (k === ' ' || k === 'Enter') {
    if (state === 'ready' || state === 'gameover') {
      e.preventDefault();
      startRun();
    }
  }
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  roundEl = document.querySelector<HTMLElement>('#round')!;
  timeEl = document.querySelector<HTMLElement>('#time')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;

  best = safeRead<number>(STORAGE_BEST, 0);
  cacheColors();

  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('pointerdown', onPointerDown);
  overlay.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    if (state === 'ready' || state === 'gameover') startRun();
  });
  restartBtn.addEventListener('click', () => reset());
  window.addEventListener('keydown', onKey);

  reset();
  requestAnimationFrame(loop);
}

export const game = defineGame({ init, reset });
