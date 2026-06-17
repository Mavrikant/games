import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';

const STORAGE_BEST = 'cikrik.best';

const CANVAS_W = 480;
const CANVAS_H = 640;

const WELL_LEFT = 100;
const WELL_RIGHT = 380;
const WELL_TOP = 220;
const WELL_BOTTOM = 600;
const WATER_TOP = WELL_BOTTOM - 32;

const AXLE_Y = 170;
const ROPE_X = (WELL_LEFT + WELL_RIGHT) / 2;
const BUCKET_W = 56;
const BUCKET_H = 38;
const BUCKET_TOP_MIN = WELL_TOP + 4;
const BUCKET_TOP_MAX = WATER_TOP - BUCKET_H - 4;

const WHEEL_CX = 360;
const WHEEL_CY = AXLE_Y;
const WHEEL_R = 64;

const ROUND_MS = 60_000;
const ITEM_LIFETIME_MS = 2200;
const ITEM_FADE_MS = 280;
const FLOAT_LIFETIME_MS = 900;

// Each radian of crank rotation moves the rope by this many pixels.
// Full bucket travel (~370 px) → ~6 turns (12π rad).
const ROPE_GAIN = (BUCKET_TOP_MAX - BUCKET_TOP_MIN) / (6 * Math.PI * 2);
const KEY_STEP = 26;

type Kind = 'water' | 'coin' | 'gem' | 'rock' | 'boot';

interface ItemDef {
  kind: Kind;
  color: string;
  points: number;
  weight: number;
}

const ITEMS: ItemDef[] = [
  { kind: 'water', color: '#7dd3fc', points: 1, weight: 50 },
  { kind: 'coin', color: '#fbbf24', points: 3, weight: 22 },
  { kind: 'gem', color: '#f43f5e', points: 6, weight: 6 },
  { kind: 'rock', color: '#94a3b8', points: -2, weight: 16 },
  { kind: 'boot', color: '#92400e', points: -1, weight: 6 },
];

interface Item {
  kind: Kind;
  x: number;
  y: number;
  age: number;
  caught: boolean;
}

interface FloatText {
  x: number;
  y: number;
  age: number;
  text: string;
  positive: boolean;
}

type State = 'ready' | 'playing' | 'gameover';

const gen = createGenToken();

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let timeEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;

let state: State = 'ready';
let score = 0;
let best = 0;
let bucketTop = BUCKET_TOP_MIN;
let wheelRotation = 0;
let items: Item[] = [];
let floats: FloatText[] = [];
let timeLeft = ROUND_MS;
let timeSinceSpawn = 0;
let lastFrame = 0;

let dragging = false;
let lastAngle = 0;
let pointerId: number | null = null;

function pickKind(): ItemDef {
  const total = ITEMS.reduce((s, d) => s + d.weight, 0);
  let r = Math.random() * total;
  for (const d of ITEMS) {
    r -= d.weight;
    if (r <= 0) return d;
  }
  return ITEMS[0]!;
}

function spawnItem(): void {
  const def = pickKind();
  const yMin = WELL_TOP + 30;
  const yMax = WATER_TOP - 30;
  const y = yMin + Math.random() * (yMax - yMin);
  const xOffset = (Math.random() - 0.5) * (WELL_RIGHT - WELL_LEFT - 90);
  items.push({
    kind: def.kind,
    x: ROPE_X + xOffset,
    y,
    age: 0,
    caught: false,
  });
}

function spawnIntervalMs(): number {
  const t = 1 - timeLeft / ROUND_MS;
  return 1300 - t * 600;
}

function bucketRect(): { x1: number; y1: number; x2: number; y2: number } {
  return {
    x1: ROPE_X - BUCKET_W / 2,
    x2: ROPE_X + BUCKET_W / 2,
    y1: bucketTop,
    y2: bucketTop + BUCKET_H,
  };
}

function tryCatch(): void {
  const r = bucketRect();
  for (const it of items) {
    if (it.caught) continue;
    if (it.age < 80) continue;
    if (it.age > ITEM_LIFETIME_MS - 40) continue;
    if (it.x < r.x1 - 6 || it.x > r.x2 + 6) continue;
    if (it.y < r.y1 - 4 || it.y > r.y2 + 18) continue;
    it.caught = true;
    const def = ITEMS.find((d) => d.kind === it.kind)!;
    score = Math.max(0, score + def.points);
    scoreEl.textContent = String(score);
    if (score > best) {
      best = score;
      bestEl.textContent = String(best);
      safeWrite(STORAGE_BEST, best);
    }
    floats.push({
      x: ROPE_X + BUCKET_W / 2 + 4,
      y: bucketTop + BUCKET_H / 2,
      age: 0,
      text: (def.points > 0 ? '+' : '') + def.points,
      positive: def.points > 0,
    });
  }
}

function setBucketByRotation(): void {
  bucketTop = BUCKET_TOP_MIN + wheelRotation * ROPE_GAIN;
  if (bucketTop < BUCKET_TOP_MIN) {
    bucketTop = BUCKET_TOP_MIN;
    wheelRotation = 0;
  } else if (bucketTop > BUCKET_TOP_MAX) {
    bucketTop = BUCKET_TOP_MAX;
    wheelRotation = (BUCKET_TOP_MAX - BUCKET_TOP_MIN) / ROPE_GAIN;
  }
}

function nudge(deltaPx: number): void {
  if (state !== 'playing') return;
  wheelRotation += deltaPx / ROPE_GAIN;
  setBucketByRotation();
}

function startGame(): void {
  state = 'playing';
  score = 0;
  timeLeft = ROUND_MS;
  items = [];
  floats = [];
  timeSinceSpawn = 0;
  wheelRotation = 0;
  bucketTop = BUCKET_TOP_MIN;
  scoreEl.textContent = '0';
  timeEl.textContent = String(Math.ceil(timeLeft / 1000));
  hideOverlayEl(overlay);
}

function endGame(): void {
  state = 'gameover';
  overlayTitle.textContent = 'Süre doldu';
  overlayMsg.textContent = `Skor: ${score}\nYeniden başlamak için R, Boşluk veya Yeniden başla.`;
  showOverlayEl(overlay);
}

function reset(): void {
  gen.bump();
  state = 'ready';
  score = 0;
  items = [];
  floats = [];
  timeLeft = ROUND_MS;
  timeSinceSpawn = 0;
  wheelRotation = 0;
  bucketTop = BUCKET_TOP_MIN;
  scoreEl.textContent = '0';
  timeEl.textContent = String(Math.ceil(timeLeft / 1000));
  overlayTitle.textContent = 'Çıkrık';
  overlayMsg.textContent =
    'Çarka bas ve etrafında daireler çiz. Saat yönü kovayı indirir, ters yön kaldırır. Hazırsan Boşluk veya tıkla.';
  showOverlayEl(overlay);
}

function update(dt: number): void {
  if (state !== 'playing') return;
  timeLeft -= dt;
  if (timeLeft <= 0) {
    timeLeft = 0;
    timeEl.textContent = '0';
    endGame();
    return;
  }
  timeEl.textContent = String(Math.ceil(timeLeft / 1000));

  timeSinceSpawn += dt;
  if (timeSinceSpawn >= spawnIntervalMs()) {
    timeSinceSpawn = 0;
    spawnItem();
  }

  for (const it of items) it.age += dt;
  tryCatch();
  items = items.filter((it) => !it.caught && it.age < ITEM_LIFETIME_MS);

  for (const f of floats) f.age += dt;
  floats = floats.filter((f) => f.age < FLOAT_LIFETIME_MS);
}

function draw(): void {
  ctx.fillStyle = '#0f1217';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  // Sky/wall gradient above well
  const grd = ctx.createLinearGradient(0, 0, 0, WELL_TOP);
  grd.addColorStop(0, '#1a2230');
  grd.addColorStop(1, '#0f1217');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, CANVAS_W, WELL_TOP);

  // Stone rim around well opening
  ctx.fillStyle = '#3a3a44';
  ctx.fillRect(WELL_LEFT - 16, WELL_TOP - 18, WELL_RIGHT - WELL_LEFT + 32, 22);
  ctx.fillStyle = '#52525c';
  for (let x = WELL_LEFT - 16; x < WELL_RIGHT + 16; x += 28) {
    ctx.strokeStyle = '#2a2a32';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, WELL_TOP - 18);
    ctx.lineTo(x, WELL_TOP);
    ctx.stroke();
  }

  // Well shaft
  ctx.fillStyle = '#070a0e';
  ctx.fillRect(WELL_LEFT, WELL_TOP, WELL_RIGHT - WELL_LEFT, WELL_BOTTOM - WELL_TOP);

  // Dim wall texture
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.lineWidth = 1;
  for (let y = WELL_TOP + 20; y < WELL_BOTTOM; y += 24) {
    ctx.beginPath();
    ctx.moveTo(WELL_LEFT + 4, y);
    ctx.lineTo(WELL_LEFT + 18, y);
    ctx.moveTo(WELL_RIGHT - 18, y);
    ctx.lineTo(WELL_RIGHT - 4, y);
    ctx.stroke();
  }

  // Items
  for (const it of items) {
    const def = ITEMS.find((d) => d.kind === it.kind)!;
    let alpha: number;
    if (it.age < ITEM_FADE_MS) alpha = it.age / ITEM_FADE_MS;
    else if (it.age > ITEM_LIFETIME_MS - ITEM_FADE_MS)
      alpha = Math.max(0, (ITEM_LIFETIME_MS - it.age) / ITEM_FADE_MS);
    else alpha = 1;
    ctx.globalAlpha = alpha;
    drawItem(it.x, it.y, def);
    ctx.globalAlpha = 1;
  }

  // Water at bottom
  ctx.fillStyle = '#0d4664';
  ctx.fillRect(WELL_LEFT, WATER_TOP, WELL_RIGHT - WELL_LEFT, WELL_BOTTOM - WATER_TOP);
  ctx.fillStyle = '#1d7aa6';
  ctx.fillRect(WELL_LEFT, WATER_TOP, WELL_RIGHT - WELL_LEFT, 4);
  ctx.strokeStyle = 'rgba(255,255,255,0.1)';
  ctx.lineWidth = 1;
  const t = lastFrame / 240;
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    const yy = WATER_TOP + 10 + i * 6;
    ctx.moveTo(WELL_LEFT + 4, yy);
    for (let x = WELL_LEFT + 4; x < WELL_RIGHT - 4; x += 8) {
      ctx.lineTo(x, yy + Math.sin((x + t * 40 + i * 30) * 0.06) * 1.5);
    }
    ctx.stroke();
  }

  // Rope
  ctx.strokeStyle = '#c9a86b';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(ROPE_X, AXLE_Y + 6);
  ctx.lineTo(ROPE_X, bucketTop);
  ctx.stroke();

  // Bucket
  drawBucket(ROPE_X, bucketTop);

  // Floating score text
  for (const f of floats) {
    const a = 1 - f.age / FLOAT_LIFETIME_MS;
    ctx.globalAlpha = Math.max(0, a);
    ctx.fillStyle = f.positive ? '#86efac' : '#fca5a5';
    ctx.font = 'bold 18px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(f.text, f.x, f.y - f.age * 0.05);
    ctx.globalAlpha = 1;
  }

  // Crank apparatus
  drawCrank();

  // Pointer hint while ready/gameover only? Always show subtle hint
  if (state === 'ready') {
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = '13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Çarkı parmağınla daire çizerek çevir', WHEEL_CX, WHEEL_CY + WHEEL_R + 22);
  }

  ctx.textAlign = 'start';
}

function drawCrank(): void {
  // Two posts holding the axle
  ctx.fillStyle = '#5b3a1c';
  ctx.fillRect(WELL_LEFT - 4, WELL_TOP - 110, 14, 110);
  ctx.fillRect(WELL_RIGHT - 10, WELL_TOP - 110, 14, 110);
  ctx.strokeStyle = '#2b1a08';
  ctx.lineWidth = 2;
  ctx.strokeRect(WELL_LEFT - 4, WELL_TOP - 110, 14, 110);
  ctx.strokeRect(WELL_RIGHT - 10, WELL_TOP - 110, 14, 110);

  // Spool/axle across well
  ctx.fillStyle = '#7a5631';
  ctx.fillRect(WELL_LEFT + 10, AXLE_Y - 10, WELL_RIGHT - WELL_LEFT - 20, 18);
  ctx.strokeStyle = '#2b1a08';
  ctx.lineWidth = 2;
  ctx.strokeRect(WELL_LEFT + 10, AXLE_Y - 10, WELL_RIGHT - WELL_LEFT - 20, 18);

  // Spool rope stripes (rotate with wheelRotation for feedback)
  const stripeOffset = (wheelRotation * 12) % 16;
  ctx.strokeStyle = 'rgba(0,0,0,0.25)';
  ctx.lineWidth = 1.5;
  for (let i = -2; i < 20; i++) {
    const x = WELL_LEFT + 14 + i * 16 + stripeOffset;
    if (x < WELL_LEFT + 12 || x > WELL_RIGHT - 12) continue;
    ctx.beginPath();
    ctx.moveTo(x, AXLE_Y - 9);
    ctx.lineTo(x, AXLE_Y + 7);
    ctx.stroke();
  }

  // Big hand wheel on right side
  ctx.save();
  ctx.translate(WHEEL_CX, WHEEL_CY);
  ctx.rotate(wheelRotation);

  // outer dark ring
  ctx.fillStyle = '#3a2510';
  ctx.beginPath();
  ctx.arc(0, 0, WHEEL_R, 0, Math.PI * 2);
  ctx.fill();
  // inner wood face
  ctx.fillStyle = '#8a5a2e';
  ctx.beginPath();
  ctx.arc(0, 0, WHEEL_R - 5, 0, Math.PI * 2);
  ctx.fill();
  // hub
  ctx.fillStyle = '#3a2510';
  ctx.beginPath();
  ctx.arc(0, 0, 14, 0, Math.PI * 2);
  ctx.fill();
  // spokes
  ctx.strokeStyle = '#3a2510';
  ctx.lineWidth = 5;
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * 12, Math.sin(a) * 12);
    ctx.lineTo(Math.cos(a) * (WHEEL_R - 7), Math.sin(a) * (WHEEL_R - 7));
    ctx.stroke();
  }
  // grip rim notches
  ctx.strokeStyle = '#3a2510';
  ctx.lineWidth = 2;
  for (let i = 0; i < 12; i++) {
    const a = (i * Math.PI) / 6;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * (WHEEL_R - 4), Math.sin(a) * (WHEEL_R - 4));
    ctx.lineTo(Math.cos(a) * (WHEEL_R - 12), Math.sin(a) * (WHEEL_R - 12));
    ctx.stroke();
  }
  // handle knob
  ctx.fillStyle = '#facc15';
  ctx.beginPath();
  ctx.arc(WHEEL_R - 12, 0, 10, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#7a3e02';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(WHEEL_R - 12, 0, 10, 0, Math.PI * 2);
  ctx.stroke();

  ctx.restore();
}

function drawBucket(x: number, top: number): void {
  // Rope handle arch
  ctx.strokeStyle = '#c9a86b';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x - BUCKET_W / 2 + 4, top + 2);
  ctx.quadraticCurveTo(x, top - 12, x + BUCKET_W / 2 - 4, top + 2);
  ctx.stroke();

  // Bucket body (trapezoidal)
  const halfTop = BUCKET_W / 2;
  const halfBot = BUCKET_W / 2 - 6;
  ctx.beginPath();
  ctx.moveTo(x - halfTop, top);
  ctx.lineTo(x + halfTop, top);
  ctx.lineTo(x + halfBot, top + BUCKET_H);
  ctx.lineTo(x - halfBot, top + BUCKET_H);
  ctx.closePath();
  ctx.fillStyle = '#8a5a2e';
  ctx.fill();
  ctx.strokeStyle = '#3a2510';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Bucket bands (planks)
  ctx.strokeStyle = '#5b3a1c';
  ctx.lineWidth = 1.5;
  for (let i = 1; i < 4; i++) {
    const xp = x - halfTop + (i * BUCKET_W) / 4;
    const xpBot = x - halfBot + (i * (halfBot * 2)) / 4;
    ctx.beginPath();
    ctx.moveTo(xp, top);
    ctx.lineTo(xpBot, top + BUCKET_H);
    ctx.stroke();
  }
  // Iron rings
  ctx.strokeStyle = '#cbd5e1';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x - halfTop + 1, top + 6);
  ctx.lineTo(x + halfTop - 1, top + 6);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x - halfBot - 1, top + BUCKET_H - 6);
  ctx.lineTo(x + halfBot + 1, top + BUCKET_H - 6);
  ctx.stroke();
}

function drawItem(x: number, y: number, def: ItemDef): void {
  ctx.fillStyle = def.color;
  switch (def.kind) {
    case 'water': {
      ctx.beginPath();
      ctx.arc(x, y + 4, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x, y - 9);
      ctx.lineTo(x - 7, y + 4);
      ctx.lineTo(x + 7, y + 4);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.beginPath();
      ctx.arc(x - 3, y + 1, 2.5, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'coin': {
      ctx.beginPath();
      ctx.arc(x, y, 12, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#a07000';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, 12, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = '#a07000';
      ctx.font = 'bold 13px serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('₺', x, y + 1);
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = 'start';
      break;
    }
    case 'gem': {
      ctx.beginPath();
      ctx.moveTo(x, y - 12);
      ctx.lineTo(x + 10, y);
      ctx.lineTo(x, y + 12);
      ctx.lineTo(x - 10, y);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#7f1d1d';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.beginPath();
      ctx.moveTo(x - 4, y - 6);
      ctx.lineTo(x + 1, y - 10);
      ctx.lineTo(x - 1, y - 2);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'rock': {
      ctx.beginPath();
      ctx.ellipse(x, y, 14, 10, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#475569';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.15)';
      ctx.beginPath();
      ctx.ellipse(x - 4, y - 3, 4, 2, 0, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'boot': {
      ctx.fillStyle = def.color;
      ctx.fillRect(x - 11, y - 9, 13, 14);
      ctx.fillRect(x - 11, y + 5, 21, 6);
      ctx.strokeStyle = '#3f1d04';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x - 11, y - 9, 13, 14);
      ctx.strokeRect(x - 11, y + 5, 21, 6);
      // lace dots
      ctx.fillStyle = '#fde68a';
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.arc(x - 4, y - 6 + i * 4, 1, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
  }
}

function loop(ts: number): void {
  if (!lastFrame) lastFrame = ts;
  const dt = Math.min(64, ts - lastFrame);
  lastFrame = ts;
  update(dt);
  draw();
  window.requestAnimationFrame(loop);
}

function canvasPoint(e: PointerEvent): { x: number; y: number } {
  const r = canvas.getBoundingClientRect();
  const x = ((e.clientX - r.left) / r.width) * CANVAS_W;
  const y = ((e.clientY - r.top) / r.height) * CANVAS_H;
  return { x, y };
}

function normalizeAngleDelta(d: number): number {
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function handlePointerDown(e: PointerEvent): void {
  if (state === 'ready' || state === 'gameover') {
    startGame();
  }
  const p = canvasPoint(e);
  dragging = true;
  pointerId = e.pointerId;
  lastAngle = Math.atan2(p.y - WHEEL_CY, p.x - WHEEL_CX);
  canvas.setPointerCapture?.(e.pointerId);
  e.preventDefault();
}

function handlePointerMove(e: PointerEvent): void {
  if (!dragging || e.pointerId !== pointerId) return;
  if (state !== 'playing') return;
  const p = canvasPoint(e);
  const newAngle = Math.atan2(p.y - WHEEL_CY, p.x - WHEEL_CX);
  const delta = normalizeAngleDelta(newAngle - lastAngle);
  lastAngle = newAngle;
  // Clockwise (positive delta in screen coords) lowers the bucket.
  wheelRotation += delta;
  setBucketByRotation();
}

function handlePointerUp(e: PointerEvent): void {
  if (e.pointerId !== pointerId) return;
  dragging = false;
  pointerId = null;
  canvas.releasePointerCapture?.(e.pointerId);
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  timeEl = document.querySelector<HTMLElement>('#time')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;

  best = safeRead<number>(STORAGE_BEST, 0);
  bestEl.textContent = String(best);

  restartBtn.addEventListener('click', () => {
    reset();
  });

  canvas.addEventListener('pointerdown', handlePointerDown);
  canvas.addEventListener('pointermove', handlePointerMove);
  canvas.addEventListener('pointerup', handlePointerUp);
  canvas.addEventListener('pointercancel', handlePointerUp);

  window.addEventListener('keydown', (e) => {
    const k = e.key;
    if (k === 'r' || k === 'R') {
      reset();
      e.preventDefault();
      return;
    }
    if (k === ' ' || k === 'Enter') {
      if (state === 'ready' || state === 'gameover') {
        startGame();
        e.preventDefault();
      }
      return;
    }
    if (state !== 'playing') return;
    if (k === 'ArrowUp' || k === 'w' || k === 'W') {
      nudge(-KEY_STEP);
      e.preventDefault();
    } else if (k === 'ArrowDown' || k === 's' || k === 'S') {
      nudge(KEY_STEP);
      e.preventDefault();
    }
  });

  document.querySelectorAll<HTMLButtonElement>('.touch__btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const dir = btn.dataset.dir;
      if (state === 'ready' || state === 'gameover') {
        startGame();
        return;
      }
      if (dir === 'up') nudge(-KEY_STEP * 1.5);
      else if (dir === 'down') nudge(KEY_STEP * 1.5);
    });
  });

  reset();
  window.requestAnimationFrame(loop);
}

export const game = defineGame({ init, reset });
