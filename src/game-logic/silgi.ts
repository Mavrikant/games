// Silgi — set-cover puzzle. Click anywhere to press a fixed-radius eraser
// circle; every dot inside the circle is removed at once. Each level adds
// more dots, but the per-level click budget grows only slightly. Score =
// number of fully cleared levels.
//
// PITFALLS guarded:
// - module-level-dom-access: all DOM/storage access lives in init().
// - unguarded-storage: safeRead/safeWrite wrap localStorage.
// - stale-async-callback: gen.bump() cancels the RAF loop on reset.
// - overlay-input-leak: pointer and key handlers gate on state.
// - missing-overlay-css: per-game CSS defines .overlay--hidden.
// - unreachable-start-state: overlay has both a Start button and Space/Enter.
// - visual-vs-hitbox: ERASE_RADIUS feeds both preview and hit-test.

import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay, hideOverlay } from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';

const W = 480;
const H = 480;
const ERASE_RADIUS = 56;
const STORAGE_BEST = 'silgi.best';
const FADE_MS = 280;
const STAMP_MS = 360;

type State = 'ready' | 'playing' | 'gameover';
interface Dot {
  x: number;
  y: number;
  r: number;
  alive: boolean;
  fade: number;
}
interface Stamp {
  x: number;
  y: number;
  age: number;
}

const gen = createGenToken();

let state: State = 'ready';
let level = 1;
let cleared = 0;
let best = 0;
let dots: Dot[] = [];
let stamps: Stamp[] = [];
let clicks = 0;
let budget = 0;
let pointerX = -100;
let pointerY = -100;
let pointerInside = false;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let levelEl!: HTMLElement;
let clicksEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayBtn!: HTMLButtonElement;

function dotCountForLevel(n: number): number {
  return 16 + (n - 1) * 3;
}

function budgetForLevel(n: number): number {
  const c = dotCountForLevel(n);
  return Math.ceil(c / 3) + 3;
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function generateDots(count: number): Dot[] {
  const out: Dot[] = [];
  const clusters = Math.max(3, Math.round(count / 5));
  const perCluster: number[] = new Array(clusters).fill(0);
  for (let i = 0; i < count; i++) perCluster[i % clusters]!++;

  const margin = 28;
  for (let c = 0; c < clusters; c++) {
    const cx = rand(margin + 30, W - margin - 30);
    const cy = rand(margin + 30, H - margin - 30);
    const want = perCluster[c]!;
    let placed = 0;
    let attempts = 0;
    const maxAttempts = want * 60;
    while (placed < want && attempts++ < maxAttempts) {
      const angle = Math.random() * Math.PI * 2;
      const r = Math.random() * 46 + 4;
      const x = cx + Math.cos(angle) * r;
      const y = cy + Math.sin(angle) * r;
      if (x < margin || x > W - margin) continue;
      if (y < margin || y > H - margin) continue;
      let tooClose = false;
      for (const d of out) {
        if ((d.x - x) * (d.x - x) + (d.y - y) * (d.y - y) < 17 * 17) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) continue;
      out.push({ x, y, r: rand(4.5, 6.5), alive: true, fade: -1 });
      placed++;
    }
  }
  let topUpAttempts = 0;
  while (out.length < count && topUpAttempts++ < 800) {
    const x = rand(margin, W - margin);
    const y = rand(margin, H - margin);
    let tooClose = false;
    for (const d of out) {
      if ((d.x - x) * (d.x - x) + (d.y - y) * (d.y - y) < 17 * 17) {
        tooClose = true;
        break;
      }
    }
    if (tooClose) continue;
    out.push({ x, y, r: rand(4.5, 6.5), alive: true, fade: -1 });
  }
  return out;
}

function setupLevel(n: number): void {
  budget = budgetForLevel(n);
  clicks = 0;
  dots = generateDots(dotCountForLevel(n));
  stamps = [];
  updateHud();
}

function updateHud(): void {
  levelEl.textContent = String(level);
  clicksEl.textContent = `${clicks}/${budget}`;
  bestEl.textContent = String(best);
}

function showStartOverlay(): void {
  overlayTitle.textContent = 'Silgi';
  overlayMsg.textContent =
    'Tahtaya dokun — silgi dairesi içindeki tüm noktaları kaldırır.\n' +
    'Boşluk veya Enter ile başla. R: yeniden.';
  overlayBtn.textContent = 'Başla';
  showOverlay(overlay);
}

function startGame(): void {
  cleared = 0;
  level = 1;
  setupLevel(level);
  state = 'playing';
  hideOverlay(overlay);
}

function reset(): void {
  gen.bump();
  state = 'ready';
  cleared = 0;
  level = 1;
  setupLevel(level);
  showStartOverlay();
  startLoop();
}

function levelComplete(): void {
  cleared = level;
  if (cleared > best) {
    best = cleared;
    safeWrite(STORAGE_BEST, best);
  }
  level++;
  setupLevel(level);
}

function gameOver(): void {
  state = 'gameover';
  overlayTitle.textContent = 'Bitti';
  overlayMsg.textContent =
    `Tamamlanan seviye: ${cleared}\nBu el rekor: ${best}.\n` +
    'Tekrar başlamak için butona bas veya R.';
  overlayBtn.textContent = 'Tekrar başla';
  showOverlay(overlay);
}

function handleStamp(x: number, y: number): void {
  if (state !== 'playing') return;
  if (clicks >= budget) return;
  clicks++;
  stamps.push({ x, y, age: 0 });
  const r2 = ERASE_RADIUS * ERASE_RADIUS;
  for (const d of dots) {
    if (!d.alive) continue;
    const dx = d.x - x;
    const dy = d.y - y;
    if (dx * dx + dy * dy <= r2) {
      d.alive = false;
      d.fade = 0;
    }
  }
  updateHud();

  const remaining = dots.some((d) => d.alive);
  if (!remaining) {
    levelComplete();
    return;
  }
  if (clicks >= budget) {
    gameOver();
  }
}

function pointerCoords(e: PointerEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const sx = canvas.width / rect.width;
  const sy = canvas.height / rect.height;
  return {
    x: (e.clientX - rect.left) * sx,
    y: (e.clientY - rect.top) * sy,
  };
}

function onPointerMove(e: PointerEvent): void {
  const { x, y } = pointerCoords(e);
  pointerX = x;
  pointerY = y;
  pointerInside = x >= 0 && x <= W && y >= 0 && y <= H;
}

function onPointerLeave(): void {
  pointerInside = false;
}

function onPointerDown(e: PointerEvent): void {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  e.preventDefault();
  if (state === 'ready' || state === 'gameover') {
    onOverlayBtn();
    return;
  }
  const { x, y } = pointerCoords(e);
  pointerX = x;
  pointerY = y;
  pointerInside = true;
  handleStamp(x, y);
}

function onOverlayBtn(): void {
  if (state === 'gameover') {
    reset();
    queueMicrotask(startGame);
    return;
  }
  if (state === 'ready') {
    startGame();
  }
}

function onKey(e: KeyboardEvent): void {
  const k = e.key;
  if (k === 'r' || k === 'R') {
    e.preventDefault();
    reset();
    return;
  }
  if ((k === ' ' || k === 'Enter') && state !== 'playing') {
    e.preventDefault();
    onOverlayBtn();
  }
}

function tick(dtMs: number): void {
  for (const d of dots) {
    if (!d.alive && d.fade >= 0) d.fade += dtMs;
  }
  for (const s of stamps) s.age += dtMs;
  stamps = stamps.filter((s) => s.age < STAMP_MS);
}

function render(): void {
  ctx.clearRect(0, 0, W, H);

  ctx.fillStyle = '#0d1018';
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = 'rgba(255,255,255,0.025)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 6; i++) {
    const x = (W * i) / 6;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
    const y = (H * i) / 6;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }

  for (const d of dots) {
    if (d.alive) {
      ctx.fillStyle = 'rgba(232,237,255,0.18)';
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r + 4, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#e8edff';
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      ctx.fill();
    } else if (d.fade >= 0 && d.fade < FADE_MS) {
      const t = d.fade / FADE_MS;
      const alpha = 1 - t;
      const r = d.r * (1 + t * 1.4);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#f9a8d4';
      ctx.beginPath();
      ctx.arc(d.x, d.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  for (const s of stamps) {
    const t = s.age / STAMP_MS;
    if (t >= 1) continue;
    const r = ERASE_RADIUS * (0.85 + t * 0.4);
    const alpha = (1 - t) * 0.6;
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = '#f472b6';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
    ctx.stroke();

    ctx.globalAlpha = alpha * 0.35;
    ctx.fillStyle = '#f472b6';
    ctx.beginPath();
    ctx.arc(s.x, s.y, ERASE_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  if (state === 'playing' && pointerInside && clicks < budget) {
    ctx.fillStyle = 'rgba(244,114,182,0.10)';
    ctx.beginPath();
    ctx.arc(pointerX, pointerY, ERASE_RADIUS, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = 'rgba(244,114,182,0.85)';
    ctx.lineWidth = 1.6;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.arc(pointerX, pointerY, ERASE_RADIUS, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = '#f472b6';
    ctx.beginPath();
    ctx.arc(pointerX, pointerY, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }

  if (state === 'playing') {
    const remaining = dots.reduce((n, d) => (d.alive ? n + 1 : n), 0);
    ctx.font = '600 11px system-ui, -apple-system, sans-serif';
    ctx.fillStyle = 'rgba(232,237,255,0.45)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`Kalan ${remaining}`, 12, 12);
  }
}

function startLoop(): void {
  const myGen = gen.current();
  let last = 0;
  function frame(now: number): void {
    if (!gen.isCurrent(myGen)) return;
    const dt = last === 0 ? 16 : Math.min(64, now - last);
    last = now;
    tick(dt);
    render();
    window.requestAnimationFrame(frame);
  }
  window.requestAnimationFrame(frame);
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  levelEl = document.querySelector<HTMLElement>('#level')!;
  clicksEl = document.querySelector<HTMLElement>('#clicks')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  restartBtn.addEventListener('click', reset);
  overlayBtn.addEventListener('click', onOverlayBtn);
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('keydown', onKey);

  reset();
}

export const game = defineGame({ init, reset });
