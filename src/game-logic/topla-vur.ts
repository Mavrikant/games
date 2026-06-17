import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay, hideOverlay } from '@shared/overlay';

const STORAGE_BEST = 'topla-vur.best';

const CANVAS_W = 480;
const CANVAS_H = 560;
const NUM_RADIUS = 24;
const COLS = 6;
const ROUND_MS = 60_000;
const SPAWN_MIN_MS = 380;
const SPAWN_MAX_MS = 980;
const FALL_BASE = 70;
const FALL_MAX_BONUS = 110;
const TARGET_MIN = 9;
const TARGET_MAX = 22;
const POP_FLASH_MS = 280;
const BAD_FLASH_MS = 320;
const STREAK_THRESHOLD = 3;

type State = 'ready' | 'playing' | 'gameover';

type FallingNumber = {
  id: number;
  x: number;
  y: number;
  vy: number;
  value: number;
  alive: boolean;
};

type Flash = { remaining: number; color: string };

const gen = createGenToken();
let state: State = 'ready';
let score = 0;
let best = 0;
let target = TARGET_MIN;
let bucket = 0;
let bucketItems: number[] = [];
let streak = 0;
let timeLeft = ROUND_MS;
let numbers: FallingNumber[] = [];
let nextId = 1;
let spawnTimer = 0;
let popFlash: Flash | null = null;
let lastFrame = 0;
let rafHandle: number | null = null;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let targetEl!: HTMLElement;
let bucketEl!: HTMLElement;
let timeEl!: HTMLElement;
let streakEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let clearBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayBtn!: HTMLButtonElement;

const cssCache = new Map<string, string>();
function getCss(varName: string, fallback: string): string {
  const cached = cssCache.get(varName);
  if (cached) return cached;
  const val = getComputedStyle(document.documentElement)
    .getPropertyValue(varName)
    .trim();
  const out = val || fallback;
  cssCache.set(varName, out);
  return out;
}

function pickTarget(): number {
  let next = TARGET_MIN + Math.floor(Math.random() * (TARGET_MAX - TARGET_MIN + 1));
  if (next === target) {
    next = TARGET_MIN + ((next - TARGET_MIN + 3) % (TARGET_MAX - TARGET_MIN + 1));
  }
  return next;
}

function spawnInterval(): number {
  const t = Math.min(1, score / 40);
  return SPAWN_MAX_MS - (SPAWN_MAX_MS - SPAWN_MIN_MS) * t;
}

function spawnNumber(): void {
  const col = Math.floor(Math.random() * COLS);
  const x = (col + 0.5) * (CANVAS_W / COLS);
  // Bias toward small values for solvability; larger numbers rarer.
  const r = Math.random();
  let value: number;
  if (r < 0.55) value = 1 + Math.floor(Math.random() * 5);
  else value = 6 + Math.floor(Math.random() * 4);
  const speed = FALL_BASE + Math.random() * 30 + Math.min(FALL_MAX_BONUS, score * 2.5);
  numbers.push({
    id: nextId++,
    x,
    y: -NUM_RADIUS,
    vy: speed,
    value,
    alive: true,
  });
}

function commitBest(): void {
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
}

function renderHUD(): void {
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
  targetEl.textContent = String(target);
  if (bucketItems.length === 0) {
    bucketEl.textContent = '0';
  } else {
    bucketEl.textContent = `${bucket} (${bucketItems.join('+')})`;
  }
  bucketEl.classList.toggle('bucket--over', bucket > target);
  bucketEl.classList.toggle('bucket--match', bucket === target && bucket > 0);
  timeEl.textContent = String(Math.max(0, Math.ceil(timeLeft / 1000)));
  streakEl.textContent = streak >= STREAK_THRESHOLD ? `×${streak}` : '–';
}

function clearBucket(silent: boolean): void {
  bucket = 0;
  bucketItems = [];
  if (!silent) {
    streak = 0;
  }
}

function onMatch(): void {
  streak += 1;
  const bonus = streak >= STREAK_THRESHOLD ? 2 : 1;
  score += bonus;
  commitBest();
  popFlash = { remaining: POP_FLASH_MS, color: '#7be3a6' };
  target = pickTarget();
  clearBucket(true);
}

function onOvershoot(): void {
  score = Math.max(0, score - 1);
  streak = 0;
  popFlash = { remaining: BAD_FLASH_MS, color: '#ff8585' };
  target = pickTarget();
  clearBucket(true);
}

function tryHit(value: number): void {
  bucketItems.push(value);
  bucket += value;
  if (bucket === target) {
    onMatch();
  } else if (bucket > target) {
    onOvershoot();
  }
  renderHUD();
}

function step(dt: number): void {
  if (state !== 'playing') return;
  timeLeft -= dt;
  if (popFlash) {
    popFlash.remaining -= dt;
    if (popFlash.remaining <= 0) popFlash = null;
  }
  spawnTimer -= dt;
  if (spawnTimer <= 0) {
    spawnNumber();
    spawnTimer = spawnInterval();
  }
  for (const n of numbers) {
    if (!n.alive) continue;
    n.y += (n.vy * dt) / 1000;
    if (n.y > CANVAS_H + NUM_RADIUS) {
      n.alive = false;
    }
  }
  numbers = numbers.filter((n) => n.alive);
  if (timeLeft <= 0) {
    timeLeft = 0;
    finishRound();
  }
}

function draw(): void {
  const w = CANVAS_W;
  const h = CANVAS_H;
  ctx.fillStyle = getCss('--bg-1', '#10131a');
  ctx.fillRect(0, 0, w, h);

  // Column guide lines
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.lineWidth = 1;
  for (let i = 1; i < COLS; i++) {
    const x = i * (w / COLS);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }

  // Bottom danger line
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  ctx.setLineDash([5, 6]);
  ctx.beginPath();
  ctx.moveTo(0, h - 8);
  ctx.lineTo(w, h - 8);
  ctx.stroke();
  ctx.setLineDash([]);

  // Numbers
  for (const n of numbers) {
    if (!n.alive) continue;
    drawNumber(n.x, n.y, n.value);
  }

  // Flash overlay (pop or bust)
  if (popFlash) {
    const lifetime = popFlash.color === '#7be3a6' ? POP_FLASH_MS : BAD_FLASH_MS;
    const k = popFlash.remaining / lifetime;
    ctx.fillStyle = popFlash.color;
    ctx.globalAlpha = 0.18 * k;
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = popFlash.color;
    ctx.globalAlpha = 0.6 * k;
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, w - 4, h - 4);
    ctx.globalAlpha = 1;
  }

  // Big target hint in the centre-top corner
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  ctx.font = 'bold 120px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(target), w / 2, 80);

  // "bucket" mini-display at the bottom
  drawBucket();
}

function drawNumber(x: number, y: number, value: number): void {
  // Pre-classify by whether this number could fit into bucket without overshoot.
  const remaining = target - bucket;
  const safe = bucket + value <= target;
  const exact = bucket + value === target;
  const accent = exact
    ? getCss('--success', '#7be3a6')
    : safe
      ? getCss('--accent', '#7aa8ff')
      : '#cf6b6b';
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.arc(x, y, NUM_RADIUS, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = '#0e1014';
  ctx.font = 'bold 24px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(value), x, y + 1);
  void remaining;
}

function drawBucket(): void {
  const w = CANVAS_W;
  const h = CANVAS_H;
  const barY = h - 44;
  const barH = 32;
  const padX = 18;
  ctx.fillStyle = 'rgba(0,0,0,0.30)';
  ctx.fillRect(padX, barY, w - padX * 2, barH);
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  ctx.lineWidth = 1;
  ctx.strokeRect(padX, barY, w - padX * 2, barH);

  const ratio = target > 0 ? Math.min(1, bucket / target) : 0;
  const fillW = (w - padX * 2) * ratio;
  const fillColor =
    bucket === target && bucket > 0
      ? getCss('--success', '#7be3a6')
      : bucket > target
        ? '#cf6b6b'
        : getCss('--accent', '#7aa8ff');
  ctx.fillStyle = fillColor;
  ctx.fillRect(padX, barY, fillW, barH);

  ctx.fillStyle = '#fff';
  ctx.font = 'bold 16px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const label = `Kova ${bucket} / Hedef ${target}`;
  ctx.fillText(label, padX + 10, barY + barH / 2);

  if (bucketItems.length > 0) {
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = '14px system-ui, -apple-system, sans-serif';
    ctx.fillText(bucketItems.join(' + '), w - padX - 10, barY + barH / 2);
  }
}

function loop(t: number): void {
  if (rafHandle === null) return;
  const myGen = gen.current();
  if (!gen.isCurrent(myGen)) {
    rafHandle = null;
    return;
  }
  const dt = Math.min(40, t - lastFrame);
  lastFrame = t;
  step(dt);
  draw();
  renderHUD();
  if (state === 'playing') {
    rafHandle = requestAnimationFrame(loop);
  } else {
    rafHandle = null;
  }
}

function startRaf(): void {
  if (rafHandle !== null) return;
  lastFrame = performance.now();
  rafHandle = requestAnimationFrame(loop);
}

function stopRaf(): void {
  if (rafHandle !== null) {
    cancelAnimationFrame(rafHandle);
    rafHandle = null;
  }
}

function showReadyOverlay(): void {
  overlayTitle.textContent = 'Topla Vur';
  overlayMsg.textContent =
    'Düşen sayılara tıkla, kovayı HEDEF rakamına tam denk getir.\n' +
    'Aşarsan kova sıfırlanır ve -1 puan.\n' +
    'Üst üste 3 doğru = seri bonusu (+2 puan).\n' +
    'Boşluk: kovayı temizle veya başla. R: yeniden.';
  overlayBtn.textContent = 'Başla';
  showOverlay(overlay);
}

function showGameOverOverlay(): void {
  overlayTitle.textContent = 'Süre Bitti';
  const fresh = score === best && best > 0;
  overlayMsg.textContent =
    `Skor: ${score}` +
    (fresh ? '  ·  Yeni rekor!' : `\nRekor: ${best}`) +
    '\nBoşluk veya Enter ile tekrar dene.';
  overlayBtn.textContent = 'Tekrar dene';
  showOverlay(overlay);
}

function startRound(): void {
  hideOverlay(overlay);
  state = 'playing';
  score = 0;
  streak = 0;
  bucket = 0;
  bucketItems = [];
  numbers = [];
  spawnTimer = 0;
  timeLeft = ROUND_MS;
  target = TARGET_MIN + Math.floor(Math.random() * (TARGET_MAX - TARGET_MIN + 1));
  popFlash = null;
  renderHUD();
  startRaf();
}

function finishRound(): void {
  state = 'gameover';
  stopRaf();
  commitBest();
  draw();
  renderHUD();
  showGameOverOverlay();
}

function reset(): void {
  gen.bump();
  stopRaf();
  state = 'ready';
  score = 0;
  streak = 0;
  bucket = 0;
  bucketItems = [];
  numbers = [];
  spawnTimer = 0;
  timeLeft = ROUND_MS;
  target = TARGET_MIN + Math.floor(Math.random() * (TARGET_MAX - TARGET_MIN + 1));
  popFlash = null;
  renderHUD();
  draw();
  showReadyOverlay();
}

function canvasPointFromEvent(e: PointerEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const sx = canvas.width / rect.width;
  const sy = canvas.height / rect.height;
  return {
    x: (e.clientX - rect.left) * sx,
    y: (e.clientY - rect.top) * sy,
  };
}

function onPointerDown(e: PointerEvent): void {
  if (state === 'ready' || state === 'gameover') {
    e.preventDefault();
    startRound();
    return;
  }
  if (state !== 'playing') return;
  const pt = canvasPointFromEvent(e);
  let hit: FallingNumber | null = null;
  let bestDist = NUM_RADIUS + 6;
  for (const n of numbers) {
    if (!n.alive) continue;
    const d = Math.hypot(n.x - pt.x, n.y - pt.y);
    if (d < bestDist) {
      hit = n;
      bestDist = d;
    }
  }
  if (hit) {
    e.preventDefault();
    hit.alive = false;
    tryHit(hit.value);
  }
}

function onKey(e: KeyboardEvent): void {
  const k = e.key.toLowerCase();
  if (k === 'r') {
    e.preventDefault();
    reset();
    return;
  }
  if (state === 'ready' || state === 'gameover') {
    if (k === ' ' || k === 'enter' || k === 'spacebar') {
      e.preventDefault();
      startRound();
    }
    return;
  }
  if (k === ' ' || k === 'spacebar') {
    e.preventDefault();
    if (bucketItems.length > 0) {
      clearBucket(false);
      renderHUD();
    }
  }
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  targetEl = document.querySelector<HTMLElement>('#target')!;
  bucketEl = document.querySelector<HTMLElement>('#bucket')!;
  timeEl = document.querySelector<HTMLElement>('#time')!;
  streakEl = document.querySelector<HTMLElement>('#streak')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  clearBtn = document.querySelector<HTMLButtonElement>('#clear')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  canvas.addEventListener('pointerdown', onPointerDown);
  restartBtn.addEventListener('click', () => reset());
  clearBtn.addEventListener('click', () => {
    if (state !== 'playing') return;
    if (bucketItems.length > 0) {
      clearBucket(false);
      renderHUD();
    }
  });
  overlayBtn.addEventListener('click', () => {
    if (state === 'ready' || state === 'gameover') startRound();
  });
  window.addEventListener('keydown', onKey);

  reset();
}

export const game = defineGame({ init, reset });
