import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';

type State = 'ready' | 'aiming' | 'rolling' | 'win' | 'gameover';

type Ball = { x: number; y: number; r: number; color: string };
type Hole = { x: number; y: number; r: number };
type Level = { cue: { x: number; y: number }; targets: Ball[]; holes: Hole[] };

const WIDTH = 480;
const HEIGHT = 320;
const BALL_R = 11;
const TARGET_R = 10;
const HOLE_R = 14;
const FRICTION = 0.985;
const STOP_SPEED = 0.05;
const MAX_DRAG = 130;
const MAX_SPEED = 9;
const STORAGE_BEST = 'karambol.best';

const COLORS = ['#ef4444', '#facc15', '#3b82f6', '#a855f7', '#f97316', '#22d3ee', '#ec4899'];

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let livesEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayBtn!: HTMLButtonElement;
let powerFill!: HTMLElement;

let state: State = 'ready';
let level = 1;
let lives = 3;
let best = 0;
let cue: Ball = { x: 0, y: 0, r: BALL_R, color: '#f8fafc' };
let cueVx = 0;
let cueVy = 0;
let targets: Ball[] = [];
let holes: Hole[] = [];
let rafHandle: number | null = null;
let aimStart = { x: 0, y: 0 };
let aimCurrent = { x: 0, y: 0 };
let pointerActive = false;

function buildLevel(n: number): Level {
  const w = WIDTH;
  const h = HEIGHT;
  const cx = w / 2;
  const cy = h / 2;
  const idx = ((n - 1) % 10) + 1;
  if (idx === 1) {
    return {
      cue: { x: cx, y: h - 60 },
      targets: [
        { x: cx, y: 80, r: TARGET_R, color: COLORS[0]! },
        { x: cx - 60, y: 110, r: TARGET_R, color: COLORS[1]! },
        { x: cx + 60, y: 110, r: TARGET_R, color: COLORS[2]! },
      ],
      holes: [],
    };
  }
  if (idx === 2) {
    return {
      cue: { x: 80, y: h - 60 },
      targets: [
        { x: w - 80, y: h - 60, r: TARGET_R, color: COLORS[0]! },
        { x: w - 80, y: 60, r: TARGET_R, color: COLORS[1]! },
        { x: 80, y: 60, r: TARGET_R, color: COLORS[2]! },
      ],
      holes: [],
    };
  }
  if (idx === 3) {
    return {
      cue: { x: cx, y: cy },
      targets: [
        { x: 50, y: 50, r: TARGET_R, color: COLORS[0]! },
        { x: w - 50, y: 50, r: TARGET_R, color: COLORS[1]! },
        { x: 50, y: h - 50, r: TARGET_R, color: COLORS[2]! },
        { x: w - 50, y: h - 50, r: TARGET_R, color: COLORS[3]! },
      ],
      holes: [],
    };
  }
  if (idx === 4) {
    return {
      cue: { x: 60, y: cy },
      targets: [
        { x: w - 60, y: cy - 80, r: TARGET_R, color: COLORS[0]! },
        { x: w - 60, y: cy, r: TARGET_R, color: COLORS[1]! },
        { x: w - 60, y: cy + 80, r: TARGET_R, color: COLORS[2]! },
        { x: cx, y: cy, r: TARGET_R, color: COLORS[3]! },
      ],
      holes: [],
    };
  }
  if (idx === 5) {
    return {
      cue: { x: cx, y: h - 50 },
      targets: [
        { x: cx, y: 60, r: TARGET_R, color: COLORS[0]! },
        { x: cx - 90, y: 90, r: TARGET_R, color: COLORS[1]! },
        { x: cx + 90, y: 90, r: TARGET_R, color: COLORS[2]! },
      ],
      holes: [{ x: cx, y: cy, r: HOLE_R }],
    };
  }
  if (idx === 6) {
    return {
      cue: { x: 60, y: 60 },
      targets: [
        { x: w - 60, y: 60, r: TARGET_R, color: COLORS[0]! },
        { x: 60, y: h - 60, r: TARGET_R, color: COLORS[1]! },
        { x: w - 60, y: h - 60, r: TARGET_R, color: COLORS[2]! },
        { x: cx, y: 50, r: TARGET_R, color: COLORS[3]! },
        { x: cx, y: h - 50, r: TARGET_R, color: COLORS[4]! },
      ],
      holes: [{ x: cx, y: cy, r: HOLE_R }],
    };
  }
  if (idx === 7) {
    return {
      cue: { x: cx, y: cy },
      targets: [
        { x: 50, y: 50, r: TARGET_R, color: COLORS[0]! },
        { x: w - 50, y: 50, r: TARGET_R, color: COLORS[1]! },
        { x: 50, y: h - 50, r: TARGET_R, color: COLORS[2]! },
        { x: w - 50, y: h - 50, r: TARGET_R, color: COLORS[3]! },
        { x: cx - 70, y: cy, r: TARGET_R, color: COLORS[4]! },
        { x: cx + 70, y: cy, r: TARGET_R, color: COLORS[5]! },
      ],
      holes: [],
    };
  }
  if (idx === 8) {
    return {
      cue: { x: 60, y: h - 60 },
      targets: [
        { x: cx - 80, y: 70, r: TARGET_R, color: COLORS[0]! },
        { x: cx, y: 70, r: TARGET_R, color: COLORS[1]! },
        { x: cx + 80, y: 70, r: TARGET_R, color: COLORS[2]! },
        { x: w - 60, y: h - 60, r: TARGET_R, color: COLORS[3]! },
      ],
      holes: [
        { x: cx, y: cy + 30, r: HOLE_R },
        { x: cx - 110, y: cy - 20, r: HOLE_R },
      ],
    };
  }
  if (idx === 9) {
    return {
      cue: { x: cx, y: h - 50 },
      targets: [
        { x: 50, y: 60, r: TARGET_R, color: COLORS[0]! },
        { x: w - 50, y: 60, r: TARGET_R, color: COLORS[1]! },
        { x: cx, y: cy - 40, r: TARGET_R, color: COLORS[2]! },
        { x: 50, y: cy + 40, r: TARGET_R, color: COLORS[3]! },
        { x: w - 50, y: cy + 40, r: TARGET_R, color: COLORS[4]! },
      ],
      holes: [{ x: cx, y: 50, r: HOLE_R }],
    };
  }
  return {
    cue: { x: cx, y: h - 40 },
    targets: [
      { x: 40, y: 40, r: TARGET_R, color: COLORS[0]! },
      { x: w - 40, y: 40, r: TARGET_R, color: COLORS[1]! },
      { x: 40, y: h - 40, r: TARGET_R, color: COLORS[2]! },
      { x: w - 40, y: h - 40, r: TARGET_R, color: COLORS[3]! },
      { x: cx, y: 40, r: TARGET_R, color: COLORS[4]! },
      { x: cx - 80, y: cy, r: TARGET_R, color: COLORS[5]! },
      { x: cx + 80, y: cy, r: TARGET_R, color: COLORS[6]! },
    ],
    holes: [
      { x: cx, y: cy - 50, r: HOLE_R },
      { x: cx, y: cy + 50, r: HOLE_R },
    ],
  };
}

function loadLevel(n: number): void {
  const lvl = buildLevel(n);
  cue = { x: lvl.cue.x, y: lvl.cue.y, r: BALL_R, color: '#f8fafc' };
  cueVx = 0;
  cueVy = 0;
  targets = lvl.targets.map((t) => ({ ...t }));
  holes = lvl.holes.map((h) => ({ ...h }));
}

function showOverlay(title: string, msg: string, btnText: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  overlayBtn.textContent = btnText;
  showOverlayEl(overlay);
}

function hideOverlay(): void {
  hideOverlayEl(overlay);
}

function setHud(): void {
  scoreEl.textContent = String(level);
  bestEl.textContent = String(best);
  livesEl.textContent = String(lives);
}

function setPowerBar(p: number): void {
  const pct = Math.max(0, Math.min(100, p * 100));
  powerFill.style.width = `${pct}%`;
}

function reset(): void {
  stopLoop();
  level = 1;
  lives = 3;
  state = 'ready';
  loadLevel(level);
  setHud();
  setPowerBar(0);
  draw();
  showOverlay(
    'Karambol',
    'Beyaz topa tıkla, sürükle, bırak.\nTek atışta tüm renkli topları cebe sok.',
    'Başla',
  );
}

function startLevel(): void {
  state = 'ready';
  loadLevel(level);
  setHud();
  setPowerBar(0);
  draw();
  hideOverlay();
}

function canvasPos(e: PointerEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((e.clientX - rect.left) / rect.width) * WIDTH,
    y: ((e.clientY - rect.top) / rect.height) * HEIGHT,
  };
}

function dist(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return Math.hypot(dx, dy);
}

function onPointerDown(e: PointerEvent): void {
  if (state !== 'ready') return;
  const p = canvasPos(e);
  aimStart = { x: cue.x, y: cue.y };
  aimCurrent = p;
  pointerActive = true;
  try { canvas.setPointerCapture(e.pointerId); } catch { /* noop */ }
  state = 'aiming';
  draw();
  e.preventDefault();
}

function onPointerMove(e: PointerEvent): void {
  if (state !== 'aiming' || !pointerActive) return;
  aimCurrent = canvasPos(e);
  const d = Math.min(MAX_DRAG, dist(aimStart.x, aimStart.y, aimCurrent.x, aimCurrent.y));
  setPowerBar(d / MAX_DRAG);
  draw();
}

function onPointerUp(e: PointerEvent): void {
  if (state !== 'aiming') return;
  pointerActive = false;
  try { canvas.releasePointerCapture(e.pointerId); } catch { /* noop */ }
  const dx = aimStart.x - aimCurrent.x;
  const dy = aimStart.y - aimCurrent.y;
  const len = Math.hypot(dx, dy);
  if (len < 6) {
    state = 'ready';
    setPowerBar(0);
    draw();
    return;
  }
  const power = Math.min(MAX_DRAG, len) / MAX_DRAG;
  const speed = power * MAX_SPEED;
  cueVx = (dx / len) * speed;
  cueVy = (dy / len) * speed;
  state = 'rolling';
  setPowerBar(0);
  startLoop();
}

function onPointerCancel(): void {
  if (state === 'aiming') {
    state = 'ready';
    pointerActive = false;
    setPowerBar(0);
    draw();
  }
}

function step(): void {
  cue.x += cueVx;
  cue.y += cueVy;

  if (cue.x - cue.r < 0) {
    cue.x = cue.r;
    cueVx = -cueVx;
  } else if (cue.x + cue.r > WIDTH) {
    cue.x = WIDTH - cue.r;
    cueVx = -cueVx;
  }
  if (cue.y - cue.r < 0) {
    cue.y = cue.r;
    cueVy = -cueVy;
  } else if (cue.y + cue.r > HEIGHT) {
    cue.y = HEIGHT - cue.r;
    cueVy = -cueVy;
  }

  for (let i = targets.length - 1; i >= 0; i--) {
    const t = targets[i]!;
    if (dist(cue.x, cue.y, t.x, t.y) < cue.r + t.r) {
      targets.splice(i, 1);
    }
  }

  for (const hole of holes) {
    if (dist(cue.x, cue.y, hole.x, hole.y) < hole.r + cue.r * 0.4) {
      cueVx = 0;
      cueVy = 0;
      cue.x = hole.x;
      cue.y = hole.y;
      endShot();
      return;
    }
  }

  cueVx *= FRICTION;
  cueVy *= FRICTION;
  if (Math.hypot(cueVx, cueVy) < STOP_SPEED) {
    cueVx = 0;
    cueVy = 0;
    endShot();
  }
}

function endShot(): void {
  stopLoop();
  if (targets.length === 0) {
    state = 'win';
    if (level > best) {
      best = level;
      safeWrite(STORAGE_BEST, best);
    }
    setHud();
    draw();
    showOverlay(
      `Seviye ${level} bitti!`,
      'Tek atışta hepsi cepte.\nSıradaki seviye için N veya butona bas.',
      'Sıradaki seviye',
    );
  } else {
    lives--;
    setHud();
    if (lives <= 0) {
      state = 'gameover';
      draw();
      showOverlay(
        'Bitti',
        `En uzak ulaştığın seviye: ${level}.\nYeniden başlamak için R veya butona bas.`,
        'Yeniden başla',
      );
    } else {
      state = 'ready';
      loadLevel(level);
      draw();
      showOverlay(
        'Tekrar dene',
        `Kalan can: ${lives}. Açı ve gücü gözden geçir.`,
        'Devam',
      );
    }
  }
}

function startLoop(): void {
  if (rafHandle !== null) return;
  const tick = (): void => {
    if (state !== 'rolling') {
      rafHandle = null;
      return;
    }
    step();
    draw();
    rafHandle = requestAnimationFrame(tick);
  };
  rafHandle = requestAnimationFrame(tick);
}

function stopLoop(): void {
  if (rafHandle !== null) {
    cancelAnimationFrame(rafHandle);
    rafHandle = null;
  }
}

function draw(): void {
  ctx.fillStyle = '#0d2818';
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  ctx.strokeStyle = '#1a4a2a';
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, WIDTH - 4, HEIGHT - 4);

  for (const hole of holes) {
    const grad = ctx.createRadialGradient(hole.x, hole.y, 0, hole.x, hole.y, hole.r);
    grad.addColorStop(0, '#000');
    grad.addColorStop(0.7, '#000');
    grad.addColorStop(1, '#0d2818');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(hole.x, hole.y, hole.r, 0, Math.PI * 2);
    ctx.fill();
  }

  for (const t of targets) {
    ctx.fillStyle = t.color;
    ctx.beginPath();
    ctx.arc(t.x, t.y, t.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.beginPath();
    ctx.arc(t.x - t.r * 0.3, t.y - t.r * 0.3, t.r * 0.35, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.fillStyle = cue.color;
  ctx.beginPath();
  ctx.arc(cue.x, cue.y, cue.r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.3)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.beginPath();
  ctx.arc(cue.x - cue.r * 0.3, cue.y - cue.r * 0.3, cue.r * 0.32, 0, Math.PI * 2);
  ctx.fill();

  if (state === 'aiming') {
    const dx = aimStart.x - aimCurrent.x;
    const dy = aimStart.y - aimCurrent.y;
    const len = Math.hypot(dx, dy);
    if (len > 4) {
      const clamp = Math.min(MAX_DRAG, len);
      const nx = dx / len;
      const ny = dy / len;
      const tipX = cue.x + nx * clamp;
      const tipY = cue.y + ny * clamp;
      ctx.strokeStyle = '#f8fafc';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(cue.x, cue.y);
      ctx.lineTo(tipX, tipY);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = '#f8fafc';
      ctx.beginPath();
      ctx.arc(tipX, tipY, 4, 0, Math.PI * 2);
      ctx.fill();

      const backX = cue.x - nx * clamp;
      const backY = cue.y - ny * clamp;
      ctx.strokeStyle = 'rgba(248, 250, 252, 0.35)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(cue.x, cue.y);
      ctx.lineTo(backX, backY);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
}

function onOverlayBtn(): void {
  if (state === 'win') {
    level++;
    startLevel();
  } else if (state === 'gameover') {
    reset();
    hideOverlay();
    state = 'ready';
    draw();
  } else {
    hideOverlay();
    state = 'ready';
    draw();
  }
}

function onKey(e: KeyboardEvent): void {
  const k = e.key.toLowerCase();
  if (k === 'r') {
    reset();
    e.preventDefault();
  } else if (k === 'n' && state === 'win') {
    level++;
    startLevel();
    e.preventDefault();
  } else if (
    (k === ' ' || k === 'enter') &&
    (state === 'ready' || state === 'win' || state === 'gameover')
  ) {
    onOverlayBtn();
    e.preventDefault();
  }
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  livesEl = document.querySelector<HTMLElement>('#lives')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;
  powerFill = document.querySelector<HTMLElement>('#power-fill')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);
  restartBtn.addEventListener('click', reset);
  overlayBtn.addEventListener('click', onOverlayBtn);
  window.addEventListener('keydown', onKey);

  reset();
}

export const game = defineGame({ init, reset });
