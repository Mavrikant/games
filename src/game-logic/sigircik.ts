import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';

const STORAGE_BEST = 'sigircik.best';

const INITIAL_BIRDS = 14;
const MIN_BIRDS_TO_LOSE = 3;
const W = 480;
const H = 480;

const MAX_SPEED = 2.2;
const MAX_FORCE = 0.08;
const NEIGHBOR_RADIUS = 50;
const SEPARATION_RADIUS = 18;
const ALIGN_WEIGHT = 1.0;
const COHESION_WEIGHT = 0.9;
const SEPARATION_WEIGHT = 1.6;
const CURSOR_WEIGHT = 0.55;
const CURSOR_INFLUENCE_RADIUS = 220;

const SCATTER_DURATION_MS = 600;
const SCATTER_FORCE = 0.55;

const HAWK_BASE_INTERVAL_MS = 5200;
const HAWK_KILL_RADIUS = 18;
const HAWK_SPEED = 4.4;

type State = 'ready' | 'playing' | 'gameover';

interface Bird {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface Hawk {
  x: number;
  y: number;
  vx: number;
  vy: number;
  warnUntil: number;
  spawnAt: number;
}

const gen = createGenToken();
let state: State = 'ready';
let score = 0;
let best = 0;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let flockCountEl!: HTMLElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let startBtn!: HTMLButtonElement;
let restartBtn!: HTMLButtonElement;

let birds: Bird[] = [];
let hawk: Hawk | null = null;
let cursor = { x: W / 2, y: H / 2, active: false };
let scatterUntil = 0;
let nextHawkAt = 0;
let runStartedAt = 0;
let lastTickAt = 0;

const cssCache = new Map<string, string>();
function getCss(name: string, fallback: string): string {
  const cached = cssCache.get(name);
  if (cached !== undefined && cached !== '') return cached;
  const val = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const v = val === '' ? fallback : val;
  cssCache.set(name, v);
  return v;
}

function showOverlayWith(title: string, msg: string, btnText: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  startBtn.textContent = btnText;
  showOverlayEl(overlay);
}

function spawnFlock(): void {
  birds = [];
  for (let i = 0; i < INITIAL_BIRDS; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 0.6 + Math.random() * 0.8;
    birds.push({
      x: W / 2 + (Math.random() - 0.5) * 140,
      y: H / 2 + (Math.random() - 0.5) * 140,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
    });
  }
}

function scheduleNextHawk(now: number): void {
  const survived = (now - runStartedAt) / 1000;
  const ramp = Math.max(0.55, 1 - survived / 90);
  nextHawkAt = now + HAWK_BASE_INTERVAL_MS * ramp + Math.random() * 1500;
}

function spawnHawk(now: number): void {
  if (birds.length === 0) return;
  let cx = 0;
  let cy = 0;
  for (const b of birds) {
    cx += b.x;
    cy += b.y;
  }
  cx /= birds.length;
  cy /= birds.length;

  const edge = Math.floor(Math.random() * 4);
  let sx = 0;
  let sy = 0;
  if (edge === 0) {
    sx = Math.random() * W;
    sy = -30;
  } else if (edge === 1) {
    sx = W + 30;
    sy = Math.random() * H;
  } else if (edge === 2) {
    sx = Math.random() * W;
    sy = H + 30;
  } else {
    sx = -30;
    sy = Math.random() * H;
  }

  const dx = cx - sx;
  const dy = cy - sy;
  const len = Math.hypot(dx, dy) || 1;
  hawk = {
    x: sx,
    y: sy,
    vx: (dx / len) * HAWK_SPEED,
    vy: (dy / len) * HAWK_SPEED,
    warnUntil: now + 900,
    spawnAt: now,
  };
}

function start(): void {
  if (state === 'playing') return;
  gen.bump();
  state = 'playing';
  score = 0;
  scatterUntil = 0;
  hawk = null;
  spawnFlock();
  cursor = { x: W / 2, y: H / 2, active: false };
  const now = performance.now();
  runStartedAt = now;
  lastTickAt = now;
  scheduleNextHawk(now);
  scoreEl.textContent = '0';
  bestEl.textContent = String(best);
  flockCountEl.textContent = String(birds.length);
  hideOverlayEl(overlay);
  loop(gen.current());
}

function reset(): void {
  gen.bump();
  state = 'ready';
  score = 0;
  birds = [];
  hawk = null;
  scatterUntil = 0;
  scoreEl.textContent = '0';
  bestEl.textContent = String(best);
  flockCountEl.textContent = String(INITIAL_BIRDS);
  draw();
  showOverlayWith(
    'Sığırcık',
    'Sürüyü işaretçine doğru çek. Atmaca dalarken Boşluk veya tıklama ile dağıt.',
    'Başla',
  );
}

function endGame(): void {
  if (state !== 'playing') return;
  gen.bump();
  state = 'gameover';
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
    bestEl.textContent = String(best);
  }
  showOverlayWith(
    'Bitti!',
    `${score} saniye dayandın. Tekrar denemek için Başla'ya tıkla veya R'ye bas.`,
    'Tekrar dene',
  );
}

function steer(b: Bird, targetVx: number, targetVy: number): { fx: number; fy: number } {
  const len = Math.hypot(targetVx, targetVy);
  if (len < 0.0001) return { fx: 0, fy: 0 };
  const sx = (targetVx / len) * MAX_SPEED - b.vx;
  const sy = (targetVy / len) * MAX_SPEED - b.vy;
  const mag = Math.hypot(sx, sy);
  if (mag > MAX_FORCE) {
    return { fx: (sx / mag) * MAX_FORCE, fy: (sy / mag) * MAX_FORCE };
  }
  return { fx: sx, fy: sy };
}

function updateBirds(now: number, dt: number): void {
  const scattering = now < scatterUntil;
  const cursorActive = cursor.active;

  for (let i = 0; i < birds.length; i++) {
    const b = birds[i]!;

    let alignX = 0;
    let alignY = 0;
    let cohX = 0;
    let cohY = 0;
    let sepX = 0;
    let sepY = 0;
    let neighborCount = 0;
    let sepCount = 0;

    for (let j = 0; j < birds.length; j++) {
      if (j === i) continue;
      const o = birds[j]!;
      const dx = o.x - b.x;
      const dy = o.y - b.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < NEIGHBOR_RADIUS * NEIGHBOR_RADIUS) {
        alignX += o.vx;
        alignY += o.vy;
        cohX += o.x;
        cohY += o.y;
        neighborCount++;
        if (d2 < SEPARATION_RADIUS * SEPARATION_RADIUS) {
          const d = Math.sqrt(d2) || 0.001;
          sepX -= dx / d;
          sepY -= dy / d;
          sepCount++;
        }
      }
    }

    let ax = 0;
    let ay = 0;
    if (neighborCount > 0) {
      alignX /= neighborCount;
      alignY /= neighborCount;
      const a = steer(b, alignX, alignY);
      ax += a.fx * ALIGN_WEIGHT;
      ay += a.fy * ALIGN_WEIGHT;

      cohX = cohX / neighborCount - b.x;
      cohY = cohY / neighborCount - b.y;
      const c = steer(b, cohX, cohY);
      ax += c.fx * COHESION_WEIGHT;
      ay += c.fy * COHESION_WEIGHT;
    }
    if (sepCount > 0) {
      const s = steer(b, sepX, sepY);
      ax += s.fx * SEPARATION_WEIGHT;
      ay += s.fy * SEPARATION_WEIGHT;
    }

    if (cursorActive) {
      const dx = cursor.x - b.x;
      const dy = cursor.y - b.y;
      const d = Math.hypot(dx, dy);
      if (d < CURSOR_INFLUENCE_RADIUS && d > 0.01) {
        const c = steer(b, dx, dy);
        ax += c.fx * CURSOR_WEIGHT;
        ay += c.fy * CURSOR_WEIGHT;
      }
    }

    if (scattering) {
      const dx = b.x - cursor.x;
      const dy = b.y - cursor.y;
      const d = Math.hypot(dx, dy) || 0.01;
      const falloff = Math.max(0, 1 - d / 260);
      ax += (dx / d) * SCATTER_FORCE * falloff;
      ay += (dy / d) * SCATTER_FORCE * falloff;
    }

    if (b.x < 24) ax += 0.15 * (24 - b.x) / 24;
    if (b.x > W - 24) ax -= 0.15 * (b.x - (W - 24)) / 24;
    if (b.y < 24) ay += 0.15 * (24 - b.y) / 24;
    if (b.y > H - 24) ay -= 0.15 * (b.y - (H - 24)) / 24;

    b.vx += ax;
    b.vy += ay;
    const sp = Math.hypot(b.vx, b.vy);
    if (sp > MAX_SPEED) {
      b.vx = (b.vx / sp) * MAX_SPEED;
      b.vy = (b.vy / sp) * MAX_SPEED;
    }
    b.x += b.vx * dt;
    b.y += b.vy * dt;

    if (b.x < 0) b.x = 0;
    if (b.x > W) b.x = W;
    if (b.y < 0) b.y = 0;
    if (b.y > H) b.y = H;
  }
}

function updateHawk(now: number, dt: number): void {
  if (!hawk) {
    if (now >= nextHawkAt) {
      spawnHawk(now);
    }
    return;
  }
  if (now < hawk.warnUntil) {
    return;
  }
  hawk.x += hawk.vx * dt;
  hawk.y += hawk.vy * dt;

  const killR2 = HAWK_KILL_RADIUS * HAWK_KILL_RADIUS;
  birds = birds.filter((b) => {
    const dx = b.x - hawk!.x;
    const dy = b.y - hawk!.y;
    return dx * dx + dy * dy > killR2;
  });
  flockCountEl.textContent = String(birds.length);

  if (hawk.x < -60 || hawk.x > W + 60 || hawk.y < -60 || hawk.y > H + 60) {
    hawk = null;
    scheduleNextHawk(now);
  }
}

function draw(): void {
  const bg = getCss('--surface', '#13151b');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  const dawn1 = getCss('--sigircik-sky-1', '#1a1b2e');
  const dawn2 = getCss('--sigircik-sky-2', '#2d2a4a');
  const grd = ctx.createLinearGradient(0, 0, 0, H);
  grd.addColorStop(0, dawn1);
  grd.addColorStop(1, dawn2);
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, W, H);

  const now = performance.now();

  if (state === 'playing' && now < scatterUntil && cursor.active) {
    const t = (scatterUntil - now) / SCATTER_DURATION_MS;
    ctx.beginPath();
    ctx.strokeStyle = `rgba(255, 200, 120, ${0.45 * t})`;
    ctx.lineWidth = 3;
    ctx.arc(cursor.x, cursor.y, (1 - t) * 90 + 18, 0, Math.PI * 2);
    ctx.stroke();
  }

  if (state === 'playing' && cursor.active) {
    ctx.beginPath();
    ctx.fillStyle = 'rgba(180, 220, 255, 0.20)';
    ctx.arc(cursor.x, cursor.y, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.fillStyle = 'rgba(220, 240, 255, 0.85)';
    ctx.arc(cursor.x, cursor.y, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  const birdColor = getCss('--sigircik-bird', '#f1f3f8');
  for (const b of birds) {
    const ang = Math.atan2(b.vy, b.vx);
    const cos = Math.cos(ang);
    const sin = Math.sin(ang);
    const len = 8;
    const wid = 4;
    ctx.beginPath();
    ctx.fillStyle = birdColor;
    ctx.moveTo(b.x + cos * len, b.y + sin * len);
    ctx.lineTo(b.x - cos * len * 0.4 - sin * wid, b.y - sin * len * 0.4 + cos * wid);
    ctx.lineTo(b.x - cos * len * 0.4 + sin * wid, b.y - sin * len * 0.4 - cos * wid);
    ctx.closePath();
    ctx.fill();
  }

  if (hawk) {
    if (now < hawk.warnUntil) {
      const blink = Math.sin((now - hawk.spawnAt) / 70) * 0.5 + 0.5;
      ctx.beginPath();
      ctx.fillStyle = `rgba(255, 90, 90, ${0.55 + blink * 0.4})`;
      ctx.arc(hawk.x, hawk.y, 14, 0, Math.PI * 2);
      ctx.fill();
      const tx = hawk.x + hawk.vx * 22;
      const ty = hawk.y + hawk.vy * 22;
      ctx.strokeStyle = `rgba(255, 90, 90, ${0.35 + blink * 0.3})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(hawk.x, hawk.y);
      ctx.lineTo(tx, ty);
      ctx.stroke();
    } else {
      const ang = Math.atan2(hawk.vy, hawk.vx);
      const cos = Math.cos(ang);
      const sin = Math.sin(ang);
      ctx.beginPath();
      ctx.fillStyle = getCss('--sigircik-hawk', '#d23a3a');
      const len = 14;
      const wid = 8;
      ctx.moveTo(hawk.x + cos * len, hawk.y + sin * len);
      ctx.lineTo(hawk.x - cos * len * 0.3 - sin * wid, hawk.y - sin * len * 0.3 + cos * wid);
      ctx.lineTo(hawk.x - cos * len * 0.6, hawk.y - sin * len * 0.6);
      ctx.lineTo(hawk.x - cos * len * 0.3 + sin * wid, hawk.y - sin * len * 0.3 - cos * wid);
      ctx.closePath();
      ctx.fill();
    }
  }
}

function loop(myGen: number): void {
  if (!gen.isCurrent(myGen)) return;
  if (state !== 'playing') return;

  const now = performance.now();
  const dt = Math.min(2.5, (now - lastTickAt) / 16.6);
  lastTickAt = now;

  updateBirds(now, dt);
  updateHawk(now, dt);

  const seconds = Math.floor((now - runStartedAt) / 1000);
  if (seconds !== score) {
    score = seconds;
    scoreEl.textContent = String(score);
  }

  draw();

  if (birds.length <= MIN_BIRDS_TO_LOSE - 1) {
    endGame();
    return;
  }

  requestAnimationFrame(() => loop(myGen));
}

function triggerScatter(): void {
  if (state !== 'playing') return;
  const now = performance.now();
  scatterUntil = now + SCATTER_DURATION_MS;
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  flockCountEl = document.querySelector<HTMLElement>('#flock-count')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  startBtn = document.querySelector<HTMLButtonElement>('#start-btn')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;

  best = safeRead<number>(STORAGE_BEST, 0);
  bestEl.textContent = String(best);

  function pointerToCanvas(ev: PointerEvent): { x: number; y: number } {
    const r = canvas.getBoundingClientRect();
    return {
      x: ((ev.clientX - r.left) / r.width) * W,
      y: ((ev.clientY - r.top) / r.height) * H,
    };
  }

  canvas.addEventListener('pointermove', (ev) => {
    const p = pointerToCanvas(ev);
    cursor.x = p.x;
    cursor.y = p.y;
    cursor.active = true;
  });
  canvas.addEventListener('pointerleave', () => {
    cursor.active = false;
  });
  canvas.addEventListener('pointerdown', (ev) => {
    const p = pointerToCanvas(ev);
    cursor.x = p.x;
    cursor.y = p.y;
    cursor.active = true;
    if (state === 'ready' || state === 'gameover') {
      start();
    } else {
      triggerScatter();
    }
    ev.preventDefault();
  });

  startBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    start();
  });
  restartBtn.addEventListener('click', () => {
    reset();
  });

  window.addEventListener('keydown', (ev) => {
    const k = ev.key.toLowerCase();
    if (k === ' ' || k === 'spacebar' || ev.code === 'Space') {
      if (state === 'ready' || state === 'gameover') {
        start();
      } else {
        triggerScatter();
      }
      ev.preventDefault();
    } else if (k === 'r') {
      reset();
      ev.preventDefault();
    } else if (k === 'enter' && (state === 'ready' || state === 'gameover')) {
      start();
      ev.preventDefault();
    }
  });

  reset();
}

export const game = defineGame({ init, reset });
