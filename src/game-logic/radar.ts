import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';
import { reportGameOver } from '@shared/leaderboard';

type State = 'ready' | 'playing' | 'gameover';

interface Target {
  x: number;
  y: number;
  vx: number;
  vy: number;
  exposure: number;
  alive: boolean;
  spawnIn: number;
}

interface Noise {
  x: number;
  y: number;
  life: number;
  total: number;
}

const W = 480;
const H = 480;
const CX = 240;
const CY = 240;
const RADAR_R = 220;
const TARGET_BOUND = RADAR_R - 18;
const SWEEP_PERIOD = 3.2;
const SWEEP_TAIL = Math.PI * 0.55;
const TARGET_COUNT = 3;
const HIT_RADIUS = 22;
const GAME_TIME = 60;
const FADE_TIME = 1.6;
const SPAWN_DELAY = 1.0;
const NOISE_MIN_GAP = 2.0;
const NOISE_MAX_GAP = 4.5;
const NOISE_LIFETIME = 0.7;
const MISS_PENALTY = 1;
const NOISE_PENALTY = 2;
const STORAGE_BEST = 'radar.best';
const SCORE_DESC = { gameId: 'radar', storageKey: STORAGE_BEST, direction: 'higher' as const };

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let timeEl!: HTMLElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let restartBtn!: HTMLButtonElement;

const gen = createGenToken();
let state: State = 'ready';
let score = 0;
let best = 0;
let timeLeft = GAME_TIME;

let sweepAngle = 0;
let prevSweepAngle = 0;
let targets: Target[] = [];
let noises: Noise[] = [];
let nextNoiseIn = 0;
let lastFrame = 0;
let rafId: number | null = null;
let flashUntil = 0;
let flashKind: 'hit' | 'miss' | 'noise' = 'hit';

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function randomTargetSeed(): { x: number; y: number; vx: number; vy: number } {
  const angle = rand(0, Math.PI * 2);
  const radius = rand(60, TARGET_BOUND - 10);
  const x = Math.cos(angle) * radius;
  const y = Math.sin(angle) * radius;
  const speed = rand(28, 58);
  const heading = rand(0, Math.PI * 2);
  return {
    x,
    y,
    vx: Math.cos(heading) * speed,
    vy: Math.sin(heading) * speed,
  };
}

function makeTarget(initial: boolean): Target {
  const seed = randomTargetSeed();
  return {
    x: seed.x,
    y: seed.y,
    vx: seed.vx,
    vy: seed.vy,
    exposure: 0,
    alive: true,
    spawnIn: initial ? 0 : SPAWN_DELAY,
  };
}

function resetTargets(): void {
  targets = [];
  for (let i = 0; i < TARGET_COUNT; i++) targets.push(makeTarget(true));
}

function setOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlay);
}

function clearOverlay(): void {
  hideOverlayEl(overlay);
}

function setScore(v: number): void {
  score = v;
  scoreEl.textContent = String(score);
}

function setBest(v: number): void {
  best = v;
  bestEl.textContent = String(best);
}

function setTime(v: number): void {
  timeLeft = v;
  timeEl.textContent = String(Math.max(0, Math.ceil(timeLeft)));
}

function reset(): void {
  gen.bump();
  stopLoop();
  state = 'ready';
  setScore(0);
  setTime(GAME_TIME);
  sweepAngle = 0;
  prevSweepAngle = 0;
  resetTargets();
  noises = [];
  nextNoiseIn = rand(NOISE_MIN_GAP, NOISE_MAX_GAP);
  flashUntil = 0;
  draw();
  setOverlay('Radar', 'Tarama başlasın diye ekrana tıkla.\nVeya boşluğa bas.');
}

function startGame(): void {
  if (state === 'playing') return;
  state = 'playing';
  setScore(0);
  setTime(GAME_TIME);
  resetTargets();
  noises = [];
  nextNoiseIn = rand(NOISE_MIN_GAP, NOISE_MAX_GAP);
  clearOverlay();
  lastFrame = performance.now();
  startLoop();
}

function endGame(): void {
  state = 'gameover';
  stopLoop();
  if (score > best) {
    setBest(score);
    safeWrite(STORAGE_BEST, best);
  }
  reportGameOver(SCORE_DESC, score);
  setOverlay(
    'Tarama bitti',
    `Skor: ${score} · Rekor: ${best}\nYeniden başlamak için tıkla veya R.`,
  );
  draw();
}

function startLoop(): void {
  if (rafId !== null) return;
  const myGen = gen.current();
  const step = (now: number): void => {
    if (!gen.isCurrent(myGen) || state !== 'playing') {
      rafId = null;
      return;
    }
    const dt = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;
    update(dt);
    draw();
    rafId = requestAnimationFrame(step);
  };
  rafId = requestAnimationFrame(step);
}

function stopLoop(): void {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

function update(dt: number): void {
  setTime(timeLeft - dt);
  if (timeLeft <= 0) {
    setTime(0);
    endGame();
    return;
  }

  prevSweepAngle = sweepAngle;
  sweepAngle = (sweepAngle + (Math.PI * 2 * dt) / SWEEP_PERIOD) % (Math.PI * 2);

  for (const t of targets) {
    if (!t.alive) {
      t.spawnIn -= dt;
      if (t.spawnIn <= 0) {
        const seed = randomTargetSeed();
        t.x = seed.x;
        t.y = seed.y;
        t.vx = seed.vx;
        t.vy = seed.vy;
        t.exposure = 0;
        t.alive = true;
      }
      continue;
    }

    t.x += t.vx * dt;
    t.y += t.vy * dt;
    const d = Math.hypot(t.x, t.y);
    if (d > TARGET_BOUND) {
      const nx = t.x / d;
      const ny = t.y / d;
      t.x = nx * TARGET_BOUND;
      t.y = ny * TARGET_BOUND;
      const dot = t.vx * nx + t.vy * ny;
      t.vx -= 2 * dot * nx;
      t.vy -= 2 * dot * ny;
    }

    if (sweptOver(t)) t.exposure = 1;
    t.exposure = Math.max(0, t.exposure - dt / FADE_TIME);
  }

  nextNoiseIn -= dt;
  if (nextNoiseIn <= 0) {
    spawnNoise();
    nextNoiseIn = rand(NOISE_MIN_GAP, NOISE_MAX_GAP);
  }
  for (const n of noises) n.life -= dt;
  noises = noises.filter((n) => n.life > 0);
}

function sweptOver(t: Target): boolean {
  const a = Math.atan2(t.y, t.x);
  const angle = a < 0 ? a + Math.PI * 2 : a;
  const prev = prevSweepAngle;
  const cur = sweepAngle;
  if (prev <= cur) return angle >= prev && angle <= cur;
  return angle >= prev || angle <= cur;
}

function spawnNoise(): void {
  const angle = rand(0, Math.PI * 2);
  const radius = rand(40, TARGET_BOUND - 5);
  noises.push({
    x: Math.cos(angle) * radius,
    y: Math.sin(angle) * radius,
    life: NOISE_LIFETIME,
    total: NOISE_LIFETIME,
  });
}

function onPointer(e: PointerEvent): void {
  e.preventDefault();
  if (state === 'ready') {
    startGame();
    return;
  }
  if (state === 'gameover') {
    reset();
    startGame();
    return;
  }
  if (state !== 'playing') return;

  const rect = canvas.getBoundingClientRect();
  const sx = canvas.width / rect.width;
  const sy = canvas.height / rect.height;
  const px = (e.clientX - rect.left) * sx;
  const py = (e.clientY - rect.top) * sy;
  const lx = px - CX;
  const ly = py - CY;
  if (Math.hypot(lx, ly) > RADAR_R + 10) return;

  let hit: Target | null = null;
  let hitDist = HIT_RADIUS + 1;
  for (const t of targets) {
    if (!t.alive) continue;
    const d = Math.hypot(t.x - lx, t.y - ly);
    if (d < hitDist) {
      hit = t;
      hitDist = d;
    }
  }
  if (hit) {
    hit.alive = false;
    hit.spawnIn = SPAWN_DELAY;
    hit.exposure = 0;
    setScore(score + 1);
    flash('hit');
    return;
  }

  let noiseHit: Noise | null = null;
  let noiseDist = HIT_RADIUS + 1;
  for (const n of noises) {
    const d = Math.hypot(n.x - lx, n.y - ly);
    if (d < noiseDist) {
      noiseHit = n;
      noiseDist = d;
    }
  }
  if (noiseHit) {
    noiseHit.life = 0;
    setScore(Math.max(0, score - NOISE_PENALTY));
    flash('noise');
    return;
  }

  setScore(Math.max(0, score - MISS_PENALTY));
  flash('miss');
}

function flash(kind: 'hit' | 'miss' | 'noise'): void {
  flashKind = kind;
  flashUntil = performance.now() + 220;
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

function draw(): void {
  const bg = getCss('--radar-bg') || '#021207';
  const grid = getCss('--radar-grid') || '#064e1e';
  const dim = getCss('--radar-dim') || '#14532d';
  const glow = getCss('--radar-glow') || '#4ade80';

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  ctx.save();
  ctx.beginPath();
  ctx.arc(CX, CY, RADAR_R, 0, Math.PI * 2);
  ctx.clip();

  ctx.fillStyle = 'rgba(20, 83, 45, 0.18)';
  ctx.beginPath();
  ctx.arc(CX, CY, RADAR_R, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = grid;
  ctx.lineWidth = 1;
  for (let i = 1; i <= 4; i++) {
    ctx.beginPath();
    ctx.arc(CX, CY, (RADAR_R / 4) * i, 0, Math.PI * 2);
    ctx.stroke();
  }
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    ctx.beginPath();
    ctx.moveTo(CX, CY);
    ctx.lineTo(CX + Math.cos(a) * RADAR_R, CY + Math.sin(a) * RADAR_R);
    ctx.stroke();
  }

  const segs = 28;
  for (let i = 0; i < segs; i++) {
    const a0 = sweepAngle - (SWEEP_TAIL * i) / segs;
    const a1 = sweepAngle - (SWEEP_TAIL * (i + 1)) / segs;
    const alpha = (1 - i / segs) * 0.32;
    ctx.fillStyle = `rgba(74, 222, 128, ${alpha.toFixed(3)})`;
    ctx.beginPath();
    ctx.moveTo(CX, CY);
    ctx.arc(CX, CY, RADAR_R, a1, a0);
    ctx.closePath();
    ctx.fill();
  }
  ctx.strokeStyle = glow;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(CX, CY);
  ctx.lineTo(CX + Math.cos(sweepAngle) * RADAR_R, CY + Math.sin(sweepAngle) * RADAR_R);
  ctx.stroke();

  for (const t of targets) {
    if (!t.alive || t.exposure <= 0) continue;
    const px = CX + t.x;
    const py = CY + t.y;
    const e = t.exposure;
    ctx.fillStyle = `rgba(209, 250, 229, ${e.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(px, py, 4.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = `rgba(74, 222, 128, ${(e * 0.7).toFixed(3)})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(px, py, 9 + (1 - e) * 10, 0, Math.PI * 2);
    ctx.stroke();
  }

  for (const n of noises) {
    const k = n.life / n.total;
    const px = CX + n.x;
    const py = CY + n.y;
    ctx.fillStyle = `rgba(248, 113, 113, ${(k * 0.85).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(px, py, 3 + k * 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = `rgba(248, 113, 113, ${(k * 0.45).toFixed(3)})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(px, py, 10 + (1 - k) * 8, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.restore();

  ctx.strokeStyle = dim;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(CX, CY, RADAR_R, 0, Math.PI * 2);
  ctx.stroke();

  if (performance.now() < flashUntil) {
    const c =
      flashKind === 'hit'
        ? 'rgba(74, 222, 128, 0.22)'
        : flashKind === 'noise'
          ? 'rgba(248, 113, 113, 0.22)'
          : 'rgba(248, 113, 113, 0.10)';
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.arc(CX, CY, RADAR_R, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.fillStyle = glow;
  ctx.font = '11px ui-monospace, monospace';
  ctx.textAlign = 'left';
  ctx.fillText(
    `AZ ${Math.round((sweepAngle * 180) / Math.PI).toString().padStart(3, '0')}°`,
    12,
    18,
  );
  ctx.textAlign = 'right';
  ctx.fillText(`R-${RADAR_R}`, W - 12, 18);
}

function onKey(e: KeyboardEvent): void {
  const k = e.key.toLowerCase();
  if (k === 'r') {
    reset();
    e.preventDefault();
    return;
  }
  if (k === ' ' || k === 'enter') {
    if (state === 'ready') {
      startGame();
      e.preventDefault();
    } else if (state === 'gameover') {
      reset();
      startGame();
      e.preventDefault();
    }
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

  setBest(safeRead<number>(STORAGE_BEST, 0));

  canvas.addEventListener('pointerdown', onPointer);
  overlay.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (state === 'ready') startGame();
    else if (state === 'gameover') {
      reset();
      startGame();
    }
  });
  restartBtn.addEventListener('click', () => {
    reset();
  });
  window.addEventListener('keydown', onKey);

  reset();
}

export const game = defineGame({ init, reset });

void H;
