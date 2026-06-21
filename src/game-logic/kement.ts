import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import {
  showOverlay as showOverlayEl,
  hideOverlay as hideOverlayEl,
} from '@shared/overlay';

type State = 'ready' | 'playing' | 'gameover';
interface Target {
  x: number;
  y: number;
  r: number;
  vx: number;
  vy: number;
  hue: number;
  alive: boolean;
}
interface Lasso {
  x: number;
  y: number;
  r: number;
  hideAt: number;
  caught: number;
}

const STORAGE_KEY = 'kement.best';
const GAME_MS = 60_000;
const SPAWN_MIN_MS = 600;
const SPAWN_MAX_MS = 1100;
const COOLDOWN_MS = 380;
const MIN_RADIUS = 22;
const MAX_RADIUS = 96;
const CHARGE_RATE = 260;
const LASSO_VISIBLE_MS = 480;
const PLAY_TOP = 36;
const PLAY_BOTTOM_PAD = 80;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let timeEl!: HTMLElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let restartBtn!: HTMLButtonElement;

let state: State = 'ready';
let score = 0;
let best = 0;
let remainingMs = GAME_MS;
let targets: Target[] = [];
let aimX = 240;
let aimY = 380;
let chargeStart: number | null = null;
let nextShotAt = 0;
let nextSpawnAt = 0;
let activeLasso: Lasso | null = null;
let rafHandle: number | null = null;
let lastT = 0;
let lastFlashAt = 0;
let lastFlashAmount = 0;

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlay);
}

function hideOverlay(): void {
  hideOverlayEl(overlay);
}

function playableHeight(): number {
  return canvas.height - PLAY_TOP - PLAY_BOTTOM_PAD;
}

function spawnTarget(): void {
  const fromLeft = Math.random() < 0.5;
  const r = rand(11, 17);
  const speed = rand(45, 105);
  const x = fromLeft ? -25 : canvas.width + 25;
  const y = PLAY_TOP + rand(20, playableHeight() - 20);
  const vx = fromLeft ? speed : -speed;
  const vy = rand(-28, 28);
  const hue = Math.floor(rand(0, 360));
  targets.push({ x, y, r, vx, vy, hue, alive: true });
}

function updateTargets(dt: number): void {
  for (const t of targets) {
    if (!t.alive) continue;
    t.x += t.vx * dt;
    t.y += t.vy * dt;
    const top = PLAY_TOP + t.r;
    const bot = PLAY_TOP + playableHeight() - t.r;
    if (t.y < top) {
      t.y = top;
      t.vy = -t.vy;
    } else if (t.y > bot) {
      t.y = bot;
      t.vy = -t.vy;
    }
  }
  const margin = 40;
  targets = targets.filter(
    (t) => t.alive && t.x > -margin && t.x < canvas.width + margin,
  );
}

function currentChargeRadius(now: number): number {
  if (chargeStart === null) return MIN_RADIUS;
  return Math.min(
    MAX_RADIUS,
    MIN_RADIUS + ((now - chargeStart) * CHARGE_RATE) / 1000,
  );
}

function castLasso(now: number): void {
  if (state !== 'playing' || chargeStart === null) {
    chargeStart = null;
    return;
  }
  const radius = currentChargeRadius(now);
  let caught = 0;
  for (const t of targets) {
    if (!t.alive) continue;
    const d = Math.hypot(t.x - aimX, t.y - aimY);
    if (d <= radius) {
      t.alive = false;
      caught++;
    }
  }
  if (caught > 0) {
    const gained = caught * caught;
    score += gained;
    scoreEl.textContent = String(score);
    lastFlashAt = now;
    lastFlashAmount = gained;
  }
  activeLasso = {
    x: aimX,
    y: aimY,
    r: radius,
    hideAt: now + LASSO_VISIBLE_MS,
    caught,
  };
  nextShotAt = now + COOLDOWN_MS;
  chargeStart = null;
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

function draw(now: number): void {
  const w = canvas.width;
  const h = canvas.height;

  ctx.fillStyle = getCss('--surface');
  ctx.fillRect(0, 0, w, h);

  ctx.fillStyle = getCss('--bg');
  ctx.fillRect(0, 0, w, PLAY_TOP);
  ctx.fillRect(0, h - PLAY_BOTTOM_PAD, w, PLAY_BOTTOM_PAD);

  ctx.strokeStyle = getCss('--border');
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, PLAY_TOP);
  ctx.lineTo(w, PLAY_TOP);
  ctx.moveTo(0, h - PLAY_BOTTOM_PAD);
  ctx.lineTo(w, h - PLAY_BOTTOM_PAD);
  ctx.stroke();

  for (const t of targets) {
    if (!t.alive) continue;
    ctx.fillStyle = `hsl(${t.hue}, 72%, 60%)`;
    ctx.beginPath();
    ctx.arc(t.x, t.y, t.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `hsla(${t.hue}, 80%, 85%, 0.7)`;
    ctx.beginPath();
    ctx.arc(t.x - t.r * 0.3, t.y - t.r * 0.3, t.r * 0.3, 0, Math.PI * 2);
    ctx.fill();
  }

  if (state === 'playing') {
    const charging = chargeStart !== null;
    const radius = currentChargeRadius(now);
    const cooling = now < nextShotAt;
    ctx.save();
    ctx.lineWidth = charging ? 3 : 2;
    ctx.setLineDash(charging ? [] : [8, 6]);
    ctx.globalAlpha = cooling && !charging ? 0.35 : 1;
    ctx.strokeStyle = charging ? getCss('--accent') : getCss('--text-muted');
    ctx.beginPath();
    ctx.arc(aimX, aimY, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    ctx.fillStyle = charging ? getCss('--accent') : getCss('--text-muted');
    ctx.globalAlpha = cooling && !charging ? 0.35 : 1;
    ctx.beginPath();
    ctx.arc(aimX, aimY, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  if (activeLasso) {
    if (now >= activeLasso.hideAt) {
      activeLasso = null;
    } else {
      const a = Math.max(0, (activeLasso.hideAt - now) / LASSO_VISIBLE_MS);
      ctx.save();
      ctx.strokeStyle = getCss('--accent');
      ctx.globalAlpha = 0.25 + 0.6 * a;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(activeLasso.x, activeLasso.y, activeLasso.r, 0, Math.PI * 2);
      ctx.stroke();
      if (activeLasso.caught > 0) {
        ctx.strokeStyle = getCss('--accent');
        ctx.globalAlpha = a;
        ctx.lineWidth = 2;
        const grow = activeLasso.r + (1 - a) * 22;
        ctx.beginPath();
        ctx.arc(activeLasso.x, activeLasso.y, grow, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  const flashAge = now - lastFlashAt;
  if (lastFlashAmount > 0 && flashAge < 700) {
    const a = 1 - flashAge / 700;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.fillStyle = getCss('--accent');
    ctx.font = 'bold 28px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`+${lastFlashAmount}`, w / 2, PLAY_TOP + 36 - flashAge * 0.04);
    ctx.restore();
  }
}

function loop(t: number): void {
  const dt = Math.min(0.05, (t - lastT) / 1000);
  lastT = t;

  if (state === 'playing') {
    remainingMs -= dt * 1000;
    if (remainingMs <= 0) {
      remainingMs = 0;
      timeEl.textContent = '0';
      endGame();
    } else {
      timeEl.textContent = String(Math.ceil(remainingMs / 1000));
    }

    if (t >= nextSpawnAt) {
      spawnTarget();
      nextSpawnAt = t + rand(SPAWN_MIN_MS, SPAWN_MAX_MS);
    }

    updateTargets(dt);
  }

  draw(t);
  rafHandle = requestAnimationFrame(loop);
}

function startGame(): void {
  state = 'playing';
  hideOverlay();
  score = 0;
  scoreEl.textContent = '0';
  targets = [];
  remainingMs = GAME_MS;
  timeEl.textContent = String(Math.ceil(remainingMs / 1000));
  chargeStart = null;
  activeLasso = null;
  nextShotAt = 0;
  lastFlashAmount = 0;
  const now = performance.now();
  nextSpawnAt = now;
  for (let i = 0; i < 3; i++) spawnTarget();
}

function endGame(): void {
  state = 'gameover';
  chargeStart = null;
  if (score > best) {
    best = score;
    safeWrite(STORAGE_KEY, best);
    bestEl.textContent = String(best);
  }
  showOverlay(
    'Süre doldu',
    `Skor: ${score}\nTekrar denemek için tıkla ya da Boşluk’a bas.`,
  );
}

function reset(): void {
  state = 'ready';
  score = 0;
  targets = [];
  scoreEl.textContent = '0';
  remainingMs = GAME_MS;
  timeEl.textContent = String(Math.ceil(remainingMs / 1000));
  chargeStart = null;
  activeLasso = null;
  nextShotAt = 0;
  lastFlashAmount = 0;
  showOverlay(
    'Kement',
    'Halkayı şişirmek için basılı tut, bırakınca yakala.\nBaşlamak için tıkla ya da Boşluk’a bas.',
  );
}

function pointerPos(e: PointerEvent): { x: number; y: number } {
  const r = canvas.getBoundingClientRect();
  const sx = canvas.width / r.width;
  const sy = canvas.height / r.height;
  return { x: (e.clientX - r.left) * sx, y: (e.clientY - r.top) * sy };
}

function clampAim(): void {
  if (aimX < 0) aimX = 0;
  else if (aimX > canvas.width) aimX = canvas.width;
  if (aimY < PLAY_TOP) aimY = PLAY_TOP;
  else if (aimY > canvas.height - PLAY_BOTTOM_PAD)
    aimY = canvas.height - PLAY_BOTTOM_PAD;
}

function handleStartTap(): void {
  if (state === 'ready') {
    startGame();
  } else if (state === 'gameover') {
    startGame();
  }
}

function onPointerDown(e: PointerEvent): void {
  e.preventDefault();
  const p = pointerPos(e);
  aimX = p.x;
  aimY = p.y;
  clampAim();
  if (state !== 'playing') {
    handleStartTap();
    return;
  }
  const now = performance.now();
  if (now < nextShotAt) return;
  chargeStart = now;
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {
    /* ignore */
  }
}

function onPointerMove(e: PointerEvent): void {
  const p = pointerPos(e);
  aimX = p.x;
  aimY = p.y;
  clampAim();
}

function onPointerUp(e: PointerEvent): void {
  if (chargeStart === null) return;
  const p = pointerPos(e);
  aimX = p.x;
  aimY = p.y;
  clampAim();
  castLasso(performance.now());
  try {
    canvas.releasePointerCapture(e.pointerId);
  } catch {
    /* ignore */
  }
}

function onPointerCancel(): void {
  chargeStart = null;
}

function onKeyDown(e: KeyboardEvent): void {
  const k = e.key.toLowerCase();
  if (k === 'r') {
    reset();
    e.preventDefault();
    return;
  }
  if (k === ' ' || k === 'enter') {
    if (state !== 'playing') {
      handleStartTap();
      e.preventDefault();
      return;
    }
    if (e.repeat) {
      e.preventDefault();
      return;
    }
    const now = performance.now();
    if (chargeStart === null && now >= nextShotAt) {
      chargeStart = now;
    }
    e.preventDefault();
    return;
  }
  if (state === 'playing') {
    const step = 28;
    if (k === 'arrowleft' || k === 'a') {
      aimX -= step;
      clampAim();
      e.preventDefault();
    } else if (k === 'arrowright' || k === 'd') {
      aimX += step;
      clampAim();
      e.preventDefault();
    } else if (k === 'arrowup' || k === 'w') {
      aimY -= step;
      clampAim();
      e.preventDefault();
    } else if (k === 'arrowdown' || k === 's') {
      aimY += step;
      clampAim();
      e.preventDefault();
    }
  }
}

function onKeyUp(e: KeyboardEvent): void {
  const k = e.key.toLowerCase();
  if ((k === ' ' || k === 'enter') && chargeStart !== null) {
    castLasso(performance.now());
    e.preventDefault();
  }
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  timeEl = document.querySelector<HTMLElement>('#time')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;

  best = safeRead<number>(STORAGE_KEY, 0);
  bestEl.textContent = String(best);

  aimX = canvas.width / 2;
  aimY = PLAY_TOP + playableHeight() / 2;

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);
  overlay.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handleStartTap();
  });

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  restartBtn.addEventListener('click', () => {
    reset();
  });

  reset();
  lastT = performance.now();
  rafHandle = requestAnimationFrame(loop);
}

export const game = defineGame({ init, reset });
