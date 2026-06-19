import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import {
  showOverlay as showOverlayEl,
  hideOverlay as hideOverlayEl,
} from '@shared/overlay';

const STORAGE_BEST = 'tahterevalli.best';

const CANVAS_W = 480;
const CANVAS_H = 480;
const BEAM_CX = 240;
const BEAM_Y = 270;
const BEAM_LEN = 360;
const BEAM_HALF = BEAM_LEN / 2;
const BEAM_THICK = 14;
const PIVOT_H = 64;
const PIVOT_HALF_W = 26;
const PIVOT_MAX = 150;

const GRAVITY = 1100;
const MOMENT = 1800;
const DAMPING = 5;
const CRIT_ANGLE = (32 * Math.PI) / 180;
const PIVOT_SPEED = 220;
const SLIDE_FACTOR = 70;

const START_SPAWN = 1.8;
const MIN_SPAWN = 0.55;
const SPAWN_RAMP = 45;
const MASS_TABLE: readonly number[] = [1, 1, 2, 2, 2, 3, 3, 4];

type State = 'ready' | 'playing' | 'paused' | 'gameover';

interface Weight {
  x: number;
  mass: number;
}

interface Falling {
  x: number;
  y: number;
  vy: number;
  mass: number;
}

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let restartBtn!: HTMLButtonElement;

let state: State = 'ready';
let pivotX = 0;
let angle = 0;
let angVel = 0;
let weights: Weight[] = [];
let falling: Falling[] = [];
let elapsed = 0;
let score = 0;
let best = 0;
let nextSpawn = START_SPAWN;
const heldKeys = new Set<'left' | 'right'>();
let touchDir: -1 | 0 | 1 = 0;
let rafId: number | null = null;
let lastFrame = 0;

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlay);
}

function hideOverlay(): void {
  hideOverlayEl(overlay);
}

function massRadius(m: number): number {
  return 9 + m * 4;
}

function massColor(m: number): string {
  if (m <= 1) return getCss('--c-green');
  if (m <= 2) return getCss('--c-yellow');
  if (m <= 3) return getCss('--c-orange');
  return getCss('--c-red');
}

function reset(): void {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  state = 'ready';
  pivotX = 0;
  angle = 0;
  angVel = 0;
  weights = [];
  falling = [];
  elapsed = 0;
  score = 0;
  nextSpawn = START_SPAWN;
  heldKeys.clear();
  touchDir = 0;
  scoreEl.textContent = '0';
  bestEl.textContent = String(best);
  showOverlay('Tahterevalli', 'Boşluk: başla · ← → veya A/D ile pivotu kaydır.');
  draw();
}

function start(): void {
  if (state !== 'ready' && state !== 'paused') return;
  state = 'playing';
  hideOverlay();
  lastFrame = performance.now();
  if (rafId === null) {
    rafId = requestAnimationFrame(loop);
  }
}

function pause(): void {
  if (state !== 'playing') return;
  state = 'paused';
  showOverlay('Duraklatıldı', 'Boşluk ile devam et.');
}

function gameOver(): void {
  state = 'gameover';
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
    bestEl.textContent = String(best);
  }
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  draw();
  showOverlay('Devrildi!', `Süre: ${score} sn · R: yeniden başla`);
}

function currentSpawn(t: number): number {
  const k = Math.min(1, t / SPAWN_RAMP);
  return START_SPAWN + (MIN_SPAWN - START_SPAWN) * k;
}

function spawnFalling(): void {
  const mass = MASS_TABLE[Math.floor(Math.random() * MASS_TABLE.length)]!;
  const spread = BEAM_HALF - 18;
  const offset = (Math.random() * 2 - 1) * spread;
  falling.push({
    x: BEAM_CX + offset,
    y: 30,
    vy: 0,
    mass,
  });
}

function step(dt: number): void {
  let dir = 0;
  if (heldKeys.has('left')) dir -= 1;
  if (heldKeys.has('right')) dir += 1;
  dir += touchDir;
  if (dir !== 0) {
    pivotX += Math.sign(dir) * PIVOT_SPEED * dt;
    if (pivotX < -PIVOT_MAX) pivotX = -PIVOT_MAX;
    if (pivotX > PIVOT_MAX) pivotX = PIVOT_MAX;
  }

  for (const f of falling) {
    f.vy += GRAVITY * dt;
    f.y += f.vy * dt;
  }

  for (let i = falling.length - 1; i >= 0; i--) {
    const f = falling[i]!;
    const beamLocalX = f.x - BEAM_CX;
    const surfaceY = BEAM_Y + beamLocalX * Math.tan(angle);
    const halfReach = BEAM_HALF * Math.cos(angle);
    const r = massRadius(f.mass);
    if (f.y + r >= surfaceY && Math.abs(beamLocalX) <= halfReach) {
      const beamX = beamLocalX / Math.cos(angle);
      weights.push({ x: beamX, mass: f.mass });
      falling.splice(i, 1);
    } else if (f.y > CANVAS_H + 80) {
      falling.splice(i, 1);
    }
  }

  if (weights.length > 0) {
    const slide = Math.sin(angle) * SLIDE_FACTOR * dt;
    for (const w of weights) w.x += slide;
    weights = weights.filter((w) => Math.abs(w.x) <= BEAM_HALF);
  }

  let torque = 0;
  for (const w of weights) {
    torque += w.mass * (w.x - pivotX) * Math.cos(angle);
  }
  const angAccel = (torque - DAMPING * angVel) / MOMENT;
  angVel += angAccel * dt;
  angle += angVel * dt;

  if (Math.abs(angle) > CRIT_ANGLE) {
    angle = Math.sign(angle) * CRIT_ANGLE;
    gameOver();
    return;
  }

  nextSpawn -= dt;
  if (nextSpawn <= 0) {
    spawnFalling();
    nextSpawn = currentSpawn(elapsed);
  }

  elapsed += dt;
  const sec = Math.floor(elapsed);
  if (sec !== score) {
    score = sec;
    scoreEl.textContent = String(score);
  }
}

function loop(now: number): void {
  rafId = null;
  if (state !== 'playing') return;
  const dt = Math.min(0.04, (now - lastFrame) / 1000);
  lastFrame = now;
  step(dt);
  draw();
  if (state === 'playing') {
    rafId = requestAnimationFrame(loop);
  }
}

function draw(): void {
  ctx.fillStyle = getCss('--surface');
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  // Ground area below pivot
  ctx.fillStyle = getCss('--surface-2');
  ctx.fillRect(0, BEAM_Y + PIVOT_H + 8, CANVAS_W, CANVAS_H - (BEAM_Y + PIVOT_H + 8));

  drawAngleGauge();
  drawPivotTrack();

  const pivotWorldX = BEAM_CX + pivotX;
  const pivotWorldY = BEAM_Y;

  // Falling weights (drawn behind beam so they "land" onto it)
  for (const f of falling) {
    drawDisc(f.x, f.y, f.mass);
  }

  ctx.save();
  ctx.translate(pivotWorldX, pivotWorldY);
  ctx.rotate(angle);

  // Beam: drawn so it spans the full BEAM_LEN, centered at the beam's middle
  // (which sits at beam-frame x = -pivotX relative to the pivot).
  const beamLeftX = -BEAM_HALF - pivotX;
  ctx.fillStyle = getCss('--accent-strong');
  ctx.fillRect(beamLeftX, -BEAM_THICK, BEAM_LEN, BEAM_THICK);
  ctx.strokeStyle = getCss('--accent');
  ctx.lineWidth = 1.5;
  ctx.strokeRect(beamLeftX + 0.5, -BEAM_THICK + 0.5, BEAM_LEN - 1, BEAM_THICK - 1);

  // Center marker on beam (visual cue for beam midpoint)
  ctx.fillStyle = getCss('--text');
  ctx.globalAlpha = 0.55;
  ctx.fillRect(-pivotX - 1, -BEAM_THICK, 2, BEAM_THICK);
  ctx.globalAlpha = 1;

  // Weights stuck on the beam (drawn in beam frame so they rotate with it)
  for (const w of weights) {
    const r = massRadius(w.mass);
    ctx.fillStyle = massColor(w.mass);
    ctx.beginPath();
    ctx.arc(w.x - pivotX, -BEAM_THICK - r, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = getCss('--bg');
    ctx.lineWidth = 2;
    ctx.stroke();
    // Mass label
    ctx.fillStyle = getCss('--bg');
    ctx.font = 'bold 13px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(w.mass), w.x - pivotX, -BEAM_THICK - r + 1);
  }

  ctx.restore();

  // Pivot triangle (world frame)
  ctx.fillStyle = getCss('--accent');
  ctx.beginPath();
  ctx.moveTo(pivotWorldX, pivotWorldY);
  ctx.lineTo(pivotWorldX - PIVOT_HALF_W, pivotWorldY + PIVOT_H);
  ctx.lineTo(pivotWorldX + PIVOT_HALF_W, pivotWorldY + PIVOT_H);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = getCss('--text');
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function drawDisc(x: number, y: number, mass: number): void {
  const r = massRadius(mass);
  ctx.fillStyle = massColor(mass);
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = getCss('--bg');
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = getCss('--bg');
  ctx.font = 'bold 13px Inter, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(mass), x, y + 1);
}

function drawAngleGauge(): void {
  const gaugeY = 36;
  const gaugeW = 260;
  const gaugeX = CANVAS_W / 2 - gaugeW / 2;
  ctx.fillStyle = getCss('--surface-2');
  ctx.fillRect(gaugeX, gaugeY - 5, gaugeW, 10);
  ctx.fillStyle = getCss('--text-dim');
  ctx.fillRect(CANVAS_W / 2 - 1, gaugeY - 9, 2, 18);
  const norm = Math.max(-1, Math.min(1, angle / CRIT_ANGLE));
  const indX = CANVAS_W / 2 + (gaugeW / 2) * norm;
  ctx.fillStyle = Math.abs(norm) > 0.7 ? getCss('--c-red') : getCss('--accent-2');
  ctx.fillRect(indX - 4, gaugeY - 11, 8, 22);
}

function drawPivotTrack(): void {
  const y = BEAM_Y + PIVOT_H + 4;
  ctx.strokeStyle = getCss('--border');
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(BEAM_CX - PIVOT_MAX, y);
  ctx.lineTo(BEAM_CX + PIVOT_MAX, y);
  ctx.stroke();
  ctx.fillStyle = getCss('--border-strong');
  for (let i = -1; i <= 1; i++) {
    ctx.fillRect(BEAM_CX + i * PIVOT_MAX - 1, y - 4, 2, 8);
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

function onKeyDown(e: KeyboardEvent): void {
  const k = e.key.toLowerCase();
  if (k === 'arrowleft' || k === 'a') {
    heldKeys.add('left');
    e.preventDefault();
    if (state === 'ready') start();
  } else if (k === 'arrowright' || k === 'd') {
    heldKeys.add('right');
    e.preventDefault();
    if (state === 'ready') start();
  } else if (k === ' ' || k === 'spacebar') {
    e.preventDefault();
    if (state === 'ready') start();
    else if (state === 'playing') pause();
    else if (state === 'paused') start();
    else if (state === 'gameover') reset();
  } else if (k === 'r') {
    e.preventDefault();
    reset();
  }
}

function onKeyUp(e: KeyboardEvent): void {
  const k = e.key.toLowerCase();
  if (k === 'arrowleft' || k === 'a') heldKeys.delete('left');
  else if (k === 'arrowright' || k === 'd') heldKeys.delete('right');
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', () => {
    heldKeys.clear();
    touchDir = 0;
    if (state === 'playing') pause();
  });

  restartBtn.addEventListener('click', () => {
    reset();
  });

  overlay.addEventListener('click', () => {
    if (state === 'ready' || state === 'paused') start();
    else if (state === 'gameover') reset();
  });

  document.querySelectorAll<HTMLButtonElement>('.touch__btn').forEach((btn) => {
    const dir = btn.dataset.dir;
    const setDir = (d: -1 | 0 | 1): void => {
      touchDir = d;
      if ((d === -1 || d === 1) && state === 'ready') start();
    };
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      setDir(dir === 'left' ? -1 : 1);
    });
    btn.addEventListener('pointerup', () => setDir(0));
    btn.addEventListener('pointerleave', () => setDir(0));
    btn.addEventListener('pointercancel', () => setDir(0));
  });

  reset();
}

export const game = defineGame({ init, reset });
