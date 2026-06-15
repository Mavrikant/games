import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';

type State = 'ready' | 'playing' | 'gameover';
type Color = 'cyan' | 'magenta' | 'lime';
type Shape = 'round' | 'rod' | 'tail';

interface Microbe {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: Color;
  shape: Shape;
  phase: number;
  spawnMs: number;
  bloom: number;
}

const W = 480;
const H = 480;
const CX = W / 2;
const CY = H / 2;
const DISH_R = 220;
const BODY_R = 13;
const ROUND_TIME_MS = 60_000;
const MICROBE_COUNT = 16;
const HIT_FLASH_MS = 320;
const MISS_FLASH_MS = 480;
const SPAWN_FADE_MS = 260;
const STORAGE_BEST = 'mikroskop.best';

const COLORS: Color[] = ['cyan', 'magenta', 'lime'];
const SHAPES: Shape[] = ['round', 'rod', 'tail'];

const COLOR_LABEL: Record<Color, string> = {
  cyan: 'turkuaz',
  magenta: 'macenta',
  lime: 'limon',
};

const SHAPE_LABEL: Record<Shape, string> = {
  round: 'yuvarlak',
  rod: 'çubuk',
  tail: 'kuyruklu',
};

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let targetCanvas!: HTMLCanvasElement;
let targetCtx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let timeEl!: HTMLElement;
let targetTextEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;

const gen = createGenToken();
let state: State = 'ready';
let score = 0;
let best = 0;
let timeLeftMs = ROUND_TIME_MS;
let elapsedMs = 0;
let lastFrame = 0;
let nextId = 1;

let microbes: Microbe[] = [];
let target: { color: Color; shape: Shape } = { color: 'cyan', shape: 'round' };

let missFlash = 0;
let hitFlash = 0;

const cssCache = new Map<string, string>();
function getCss(name: string): string {
  const cached = cssCache.get(name);
  if (cached !== undefined) return cached;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  cssCache.set(name, v);
  return v;
}

function colorHex(c: Color): string {
  if (c === 'cyan') return getCss('--mk-cyan') || '#5eead4';
  if (c === 'magenta') return getCss('--mk-magenta') || '#f472b6';
  return getCss('--mk-lime') || '#bef264';
}

function setScore(v: number): void {
  score = Math.max(0, v);
  scoreEl.textContent = String(score);
}

function setBest(v: number): void {
  best = v;
  bestEl.textContent = String(best);
}

function setTime(ms: number): void {
  timeLeftMs = ms;
  const sec = Math.max(0, Math.ceil(ms / 1000));
  timeEl.textContent = String(sec);
}

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlay);
}

function hideOverlay(): void {
  hideOverlayEl(overlay);
}

function speedMultiplier(): number {
  return 1 + Math.min(1.6, score * 0.04);
}

function randomMicrobe(now: number): Microbe {
  const angle = Math.random() * Math.PI * 2;
  const r = Math.random() * (DISH_R - BODY_R - 6);
  const speed = 0.22 + Math.random() * 0.32;
  const dir = Math.random() * Math.PI * 2;
  return {
    id: nextId++,
    x: CX + Math.cos(angle) * r,
    y: CY + Math.sin(angle) * r,
    vx: Math.cos(dir) * speed,
    vy: Math.sin(dir) * speed,
    color: COLORS[Math.floor(Math.random() * COLORS.length)]!,
    shape: SHAPES[Math.floor(Math.random() * SHAPES.length)]!,
    phase: Math.random() * Math.PI * 2,
    spawnMs: now,
    bloom: 0,
  };
}

function ensureMatchingExists(now: number): void {
  if (microbes.some((m) => m.color === target.color && m.shape === target.shape)) return;
  const idx = Math.floor(Math.random() * microbes.length);
  if (microbes.length === 0) return;
  const fresh = randomMicrobe(now);
  fresh.color = target.color;
  fresh.shape = target.shape;
  microbes[idx] = fresh;
}

function pickNewTarget(): void {
  const prev = `${target.color}-${target.shape}`;
  for (let i = 0; i < 8; i++) {
    const c = COLORS[Math.floor(Math.random() * COLORS.length)]!;
    const s = SHAPES[Math.floor(Math.random() * SHAPES.length)]!;
    if (`${c}-${s}` !== prev) {
      target = { color: c, shape: s };
      break;
    }
  }
  targetTextEl.textContent = `${COLOR_LABEL[target.color]} · ${SHAPE_LABEL[target.shape]}`;
  drawTargetPreview();
  ensureMatchingExists(elapsedMs);
}

function reset(): void {
  gen.bump();
  state = 'ready';
  setScore(0);
  setTime(ROUND_TIME_MS);
  elapsedMs = 0;
  missFlash = 0;
  hitFlash = 0;
  microbes = [];
  for (let i = 0; i < MICROBE_COUNT; i++) {
    microbes.push(randomMicrobe(0));
  }
  pickNewTarget();
  showOverlay(
    'Mikroskop',
    'Aranan numuneye tıkla — renk ve şekil eşleşmeli. Başlamak için kaba tıkla veya Boşluk.',
  );
}

function startPlaying(): void {
  if (state === 'playing') return;
  state = 'playing';
  hideOverlay();
}

function endRound(): void {
  state = 'gameover';
  setTime(0);
  if (score > best) {
    setBest(score);
    safeWrite(STORAGE_BEST, score);
  }
  showOverlay(
    'Süre doldu',
    `${score} numune topladın. Rekor: ${best}. Tekrar için Boşluk veya R.`,
  );
}

function stepMicrobe(m: Microbe, dt: number, mult: number): void {
  const dtSec = dt / 1000;
  m.phase += dtSec * 1.6;
  const wiggle = 0.65;
  m.vx += (Math.random() - 0.5) * wiggle * dtSec * 60 * 0.06;
  m.vy += (Math.random() - 0.5) * wiggle * dtSec * 60 * 0.06;
  const sp = Math.hypot(m.vx, m.vy);
  const maxSp = 0.95 * mult;
  if (sp > maxSp) {
    m.vx = (m.vx / sp) * maxSp;
    m.vy = (m.vy / sp) * maxSp;
  } else if (sp < 0.12) {
    const a = Math.random() * Math.PI * 2;
    m.vx += Math.cos(a) * 0.05;
    m.vy += Math.sin(a) * 0.05;
  }

  const moveScale = (dt / 16.6667) * mult;
  m.x += m.vx * moveScale;
  m.y += m.vy * moveScale;

  const dx = m.x - CX;
  const dy = m.y - CY;
  const d = Math.hypot(dx, dy);
  const limit = DISH_R - BODY_R - 4;
  if (d > limit) {
    const nx = dx / d;
    const ny = dy / d;
    m.x = CX + nx * limit;
    m.y = CY + ny * limit;
    const dot = m.vx * nx + m.vy * ny;
    m.vx -= 2 * dot * nx;
    m.vy -= 2 * dot * ny;
  }

  if (m.bloom > 0) m.bloom = Math.max(0, m.bloom - dt);
}

function drawDish(): void {
  ctx.fillStyle = getCss('--mk-bg') || '#061018';
  ctx.fillRect(0, 0, W, H);

  ctx.beginPath();
  ctx.arc(CX, CY, DISH_R + 12, 0, Math.PI * 2);
  ctx.fillStyle = '#0a1622';
  ctx.fill();

  const grad = ctx.createRadialGradient(CX, CY - 60, 20, CX, CY, DISH_R);
  grad.addColorStop(0, '#102a3a');
  grad.addColorStop(0.7, '#0a1a26');
  grad.addColorStop(1, '#06121c');
  ctx.beginPath();
  ctx.arc(CX, CY, DISH_R, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.save();
  ctx.beginPath();
  ctx.arc(CX, CY, DISH_R, 0, Math.PI * 2);
  ctx.clip();
  ctx.strokeStyle = 'rgba(94, 234, 212, 0.04)';
  ctx.lineWidth = 1;
  for (let i = -DISH_R; i <= DISH_R; i += 22) {
    ctx.beginPath();
    ctx.moveTo(CX + i, CY - DISH_R);
    ctx.lineTo(CX + i, CY + DISH_R);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(CX - DISH_R, CY + i);
    ctx.lineTo(CX + DISH_R, CY + i);
    ctx.stroke();
  }
  ctx.restore();

  ctx.beginPath();
  ctx.arc(CX, CY, DISH_R, 0, Math.PI * 2);
  ctx.strokeStyle = getCss('--mk-rim') || '#1e3a52';
  ctx.lineWidth = 4;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(CX - 60, CY - 70, 70, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.025)';
  ctx.fill();
}

function drawMicrobe(c: CanvasRenderingContext2D, m: Microbe, cx: number, cy: number, baseR: number): void {
  const hex = colorHex(m.color);
  const phase = m.phase;
  const bloomScale = 1 + (m.bloom > 0 ? (m.bloom / HIT_FLASH_MS) * 0.4 : 0);

  c.save();
  c.translate(cx, cy);

  if (m.bloom > 0) {
    const a = m.bloom / HIT_FLASH_MS;
    c.fillStyle = hex;
    c.globalAlpha = 0.25 * a;
    c.beginPath();
    c.arc(0, 0, baseR * (1.8 + (1 - a) * 1.4), 0, Math.PI * 2);
    c.fill();
    c.globalAlpha = 1;
  }

  if (m.shape === 'tail') {
    c.strokeStyle = hex;
    c.globalAlpha = 0.85;
    c.lineWidth = 2;
    c.lineCap = 'round';
    c.beginPath();
    const segs = 5;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const len = baseR * 2.4;
      const wave = Math.sin(phase + t * Math.PI * 2) * 4 * (1 - t);
      const px = -baseR * 0.6 - t * len;
      const py = wave;
      if (i === 0) c.moveTo(px, py);
      else c.lineTo(px, py);
    }
    c.stroke();
    c.globalAlpha = 1;
  }

  c.fillStyle = hex;
  c.beginPath();
  if (m.shape === 'rod') {
    const len = baseR * 1.8 * bloomScale;
    const w = baseR * 0.75 * bloomScale;
    c.ellipse(0, 0, len, w, phase * 0.4, 0, Math.PI * 2);
  } else {
    c.arc(0, 0, baseR * bloomScale, 0, Math.PI * 2);
  }
  c.fill();

  c.strokeStyle = 'rgba(255,255,255,0.55)';
  c.lineWidth = 1.5;
  c.beginPath();
  if (m.shape === 'rod') {
    const len = baseR * 1.8 * bloomScale;
    const w = baseR * 0.75 * bloomScale;
    c.ellipse(0, 0, len, w, phase * 0.4, 0, Math.PI * 2);
  } else {
    c.arc(0, 0, baseR * bloomScale, 0, Math.PI * 2);
  }
  c.stroke();

  c.fillStyle = 'rgba(255,255,255,0.6)';
  c.beginPath();
  c.arc(-baseR * 0.3, -baseR * 0.3, baseR * 0.22, 0, Math.PI * 2);
  c.fill();

  c.restore();
}

function drawMicrobes(): void {
  microbes.forEach((m) => {
    const age = elapsedMs - m.spawnMs;
    const fade = age < SPAWN_FADE_MS ? age / SPAWN_FADE_MS : 1;
    ctx.globalAlpha = fade;
    drawMicrobe(ctx, m, m.x, m.y, BODY_R);
    ctx.globalAlpha = 1;
  });
}

function drawTargetPreview(): void {
  const c = targetCtx;
  c.fillStyle = getCss('--mk-dish') || '#0c1a24';
  c.fillRect(0, 0, targetCanvas.width, targetCanvas.height);

  const preview: Microbe = {
    id: 0,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    color: target.color,
    shape: target.shape,
    phase: 0,
    spawnMs: 0,
    bloom: 0,
  };
  drawMicrobe(c, preview, targetCanvas.width / 2, targetCanvas.height / 2, 18);
}

function drawFlashes(): void {
  if (missFlash > 0) {
    const a = missFlash / MISS_FLASH_MS;
    ctx.beginPath();
    ctx.arc(CX, CY, DISH_R, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(248,113,113,${0.55 * a})`;
    ctx.lineWidth = 6;
    ctx.stroke();
  }
  if (hitFlash > 0) {
    const a = hitFlash / HIT_FLASH_MS;
    ctx.beginPath();
    ctx.arc(CX, CY, DISH_R, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(110,231,183,${0.35 * a})`;
    ctx.lineWidth = 5;
    ctx.stroke();
  }
}

function drawHud(): void {
  ctx.fillStyle = 'rgba(148,163,184,0.65)';
  ctx.font = '600 12px Inter, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(`hız ×${speedMultiplier().toFixed(2)}`, CX, 10);
}

function draw(): void {
  drawDish();
  drawMicrobes();
  drawFlashes();
  drawHud();
}

function loop(now: number): void {
  if (lastFrame === 0) lastFrame = now;
  const dt = Math.min(64, now - lastFrame);
  lastFrame = now;
  elapsedMs += dt;

  if (hitFlash > 0) hitFlash = Math.max(0, hitFlash - dt);
  if (missFlash > 0) missFlash = Math.max(0, missFlash - dt);

  const frozen = missFlash > 0 && missFlash > MISS_FLASH_MS - 200;
  if (!frozen) {
    const mult = speedMultiplier();
    microbes.forEach((m) => stepMicrobe(m, dt, mult));
  }

  if (state === 'playing') {
    setTime(timeLeftMs - dt);
    if (timeLeftMs <= 0) endRound();
  }

  draw();
  requestAnimationFrame(loop);
}

function clickAt(clientX: number, clientY: number): void {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const x = (clientX - rect.left) * scaleX;
  const y = (clientY - rect.top) * scaleY;

  if (state === 'ready') {
    startPlaying();
    return;
  }
  if (state === 'gameover') {
    reset();
    return;
  }
  if (missFlash > MISS_FLASH_MS - 200) return;

  const dishD = Math.hypot(x - CX, y - CY);
  if (dishD > DISH_R) return;

  let hitIdx = -1;
  let bestDist = Infinity;
  for (let i = 0; i < microbes.length; i++) {
    const m = microbes[i]!;
    const d = Math.hypot(x - m.x, y - m.y);
    const r = m.shape === 'rod' ? BODY_R * 1.4 : BODY_R * 1.15;
    if (d < r && d < bestDist) {
      bestDist = d;
      hitIdx = i;
    }
  }

  if (hitIdx === -1) {
    missFlash = MISS_FLASH_MS;
    setScore(score - 1);
    return;
  }

  const m = microbes[hitIdx]!;
  const matches = m.color === target.color && m.shape === target.shape;
  if (matches) {
    setScore(score + 1);
    hitFlash = HIT_FLASH_MS;
    m.bloom = HIT_FLASH_MS;
    const replacement = randomMicrobe(elapsedMs);
    microbes[hitIdx] = replacement;
    pickNewTarget();
  } else {
    missFlash = MISS_FLASH_MS;
    setScore(score - 1);
  }
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  targetCanvas = document.querySelector<HTMLCanvasElement>('#target')!;
  targetCtx = targetCanvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  timeEl = document.querySelector<HTMLElement>('#time')!;
  targetTextEl = document.querySelector<HTMLElement>('#target-text')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;

  best = safeRead<number>(STORAGE_BEST, 0);
  setBest(best);

  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    clickAt(e.clientX, e.clientY);
  });

  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    const k = e.key;
    if (k === ' ' || k === 'Enter') {
      if (state === 'ready') startPlaying();
      else if (state === 'gameover') reset();
      e.preventDefault();
      return;
    }
    if (k.toLowerCase() === 'r') {
      reset();
      e.preventDefault();
    }
  });

  restartBtn.addEventListener('click', () => reset());

  reset();
  requestAnimationFrame(loop);
}

export const game = defineGame({ init, reset });
