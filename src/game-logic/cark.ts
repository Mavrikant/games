import { defineGame } from '@shared/game-module';
import { reportGameOver } from '@shared/leaderboard';
import { safeRead, safeWrite } from '@shared/storage';
import {
  showOverlay as showOverlayEl,
  hideOverlay as hideOverlayEl,
} from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';

type State = 'ready' | 'playing' | 'gameover';

const STORAGE_BEST = 'cark.best';
const SCORE_DESC = { gameId: 'cark', storageKey: STORAGE_BEST, direction: 'higher' as const };

const W = 480;
const H = 480;
const CX = 240;
const CY = 240;

const RING_RADII = [88, 138, 188];
const OUTER_LIMIT = 230;
const PARTICLE_SPEED = 540;
const AIM_RADIUS = 56;
const PASS_TOLERANCE = 0.01;
const GAME_TIME = 60;
const COMBO_FOR_TIER = 5;
const TWO_PI = Math.PI * 2;

const RING_COLORS = ['#fbbf24', '#22d3ee', '#a78bfa'];

interface Ring {
  radius: number;
  angle: number;
  speed: number;
  gap: number;
}

interface Particle {
  angle: number;
  r: number;
  passedRing: number;
  blockedAt: number;
  alive: boolean;
  trail: { x: number; y: number; t: number }[];
}

interface FlashRing {
  ringIndex: number;
  angle: number;
  t: number;
  hit: boolean;
}

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

let rings: Ring[] = [];
let particles: Particle[] = [];
let flashes: FlashRing[] = [];
let aimAngle = -Math.PI / 2;
let canFireUntil = 0;
let centerPulse = 0;

let lastFrame = 0;
let rafId: number | null = null;

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

function setOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlay);
}

function clearOverlay(): void {
  hideOverlayEl(overlay);
}

function tierFromScore(s: number): number {
  return Math.floor(s / COMBO_FOR_TIER);
}

function gapForTier(tier: number): number {
  const start = (62 * Math.PI) / 180;
  const min = (22 * Math.PI) / 180;
  return Math.max(min, start - tier * (4 * Math.PI) / 180);
}

function speedScaleForTier(tier: number): number {
  return 1 + tier * 0.085;
}

function buildRings(): void {
  const tier = tierFromScore(score);
  const gap = gapForTier(tier);
  const scale = speedScaleForTier(tier);
  const baseSpeeds = [0.95, -1.25, 1.55];
  rings = RING_RADII.map((radius, i) => ({
    radius,
    angle: Math.random() * TWO_PI,
    speed: (baseSpeeds[i] ?? 1) * scale,
    gap,
  }));
}

function normalizeAngle(a: number): number {
  let n = a % TWO_PI;
  if (n < 0) n += TWO_PI;
  return n;
}

function angularDistance(a: number, b: number): number {
  const d = Math.abs(normalizeAngle(a) - normalizeAngle(b));
  return Math.min(d, TWO_PI - d);
}

function isInGap(ring: Ring, angle: number): boolean {
  return angularDistance(ring.angle, angle) <= ring.gap / 2 + PASS_TOLERANCE;
}

function reset(): void {
  gen.bump();
  stopLoop();
  state = 'ready';
  setScore(0);
  setTime(GAME_TIME);
  particles = [];
  flashes = [];
  centerPulse = 0;
  canFireUntil = 0;
  buildRings();
  draw();
  setOverlay(
    'Çark',
    'Üç halkanın açıklıkları aynı yöne hizalandığında ateş et.\nFareyle nişan al, tıkla veya boşluğa bas. 60 saniye.',
  );
}

function startGame(): void {
  if (state === 'playing') return;
  state = 'playing';
  setScore(0);
  setTime(GAME_TIME);
  particles = [];
  flashes = [];
  buildRings();
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
    'Süre bitti',
    `Skor: ${score} · Rekor: ${best}\nTekrar denemek için tıkla veya boşluğa bas.`,
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

  for (const ring of rings) {
    ring.angle = normalizeAngle(ring.angle + ring.speed * dt);
  }

  if (centerPulse > 0) centerPulse = Math.max(0, centerPulse - dt * 4);

  for (const p of particles) {
    if (!p.alive) continue;
    const prevR = p.r;
    p.r += PARTICLE_SPEED * dt;
    p.trail.push({
      x: CX + Math.cos(p.angle) * p.r,
      y: CY + Math.sin(p.angle) * p.r,
      t: 1,
    });
    if (p.trail.length > 14) p.trail.shift();

    for (let i = p.passedRing; i < rings.length; i++) {
      const ring = rings[i]!;
      if (prevR < ring.radius && p.r >= ring.radius) {
        if (isInGap(ring, p.angle)) {
          p.passedRing = i + 1;
          flashes.push({ ringIndex: i, angle: p.angle, t: 0.45, hit: true });
        } else {
          p.alive = false;
          p.blockedAt = i;
          p.r = ring.radius;
          flashes.push({ ringIndex: i, angle: p.angle, t: 0.55, hit: false });
          break;
        }
      }
    }

    if (p.alive && p.r >= OUTER_LIMIT) {
      p.alive = false;
      setScore(score + 1);
      const tier = tierFromScore(score);
      const newGap = gapForTier(tier);
      const newScale = speedScaleForTier(tier);
      const baseSpeeds = [0.95, -1.25, 1.55];
      for (let i = 0; i < rings.length; i++) {
        const ring = rings[i]!;
        ring.gap = newGap;
        ring.speed = (baseSpeeds[i] ?? 1) * newScale;
      }
      centerPulse = 1;
    }
  }

  for (const f of flashes) f.t -= dt;
  flashes = flashes.filter((f) => f.t > 0);
  particles = particles.filter(
    (p) => p.alive || p.trail.length > 0,
  );
  for (const p of particles) {
    if (!p.alive) {
      p.trail = p.trail.map((pt) => ({ ...pt, t: pt.t - dt * 3 }));
      p.trail = p.trail.filter((pt) => pt.t > 0);
    }
  }
}

function fire(): void {
  if (state !== 'playing') return;
  const now = performance.now();
  if (now < canFireUntil) return;
  canFireUntil = now + 110;
  particles.push({
    angle: aimAngle,
    r: AIM_RADIUS - 6,
    passedRing: 0,
    blockedAt: -1,
    alive: true,
    trail: [],
  });
}

function onPointerMove(e: PointerEvent): void {
  const rect = canvas.getBoundingClientRect();
  const sx = canvas.width / rect.width;
  const sy = canvas.height / rect.height;
  const px = (e.clientX - rect.left) * sx;
  const py = (e.clientY - rect.top) * sy;
  const dx = px - CX;
  const dy = py - CY;
  if (dx * dx + dy * dy < 36) return;
  aimAngle = Math.atan2(dy, dx);
  if (state !== 'playing') draw();
}

function onPointerDown(e: PointerEvent): void {
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
  if (state === 'playing') {
    onPointerMove(e);
    fire();
  }
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
      return;
    }
    if (state === 'gameover') {
      reset();
      startGame();
      e.preventDefault();
      return;
    }
    if (state === 'playing') {
      fire();
      e.preventDefault();
      return;
    }
  }
  if (state === 'playing') {
    const step = (3 * Math.PI) / 180;
    if (k === 'a' || k === 'arrowleft') {
      aimAngle -= step;
      e.preventDefault();
    } else if (k === 'd' || k === 'arrowright') {
      aimAngle += step;
      e.preventDefault();
    }
  }
}

const cssCache = new Map<string, string>();
function getCss(varName: string, fallback: string): string {
  const cached = cssCache.get(varName);
  if (cached !== undefined) return cached || fallback;
  const val = getComputedStyle(document.documentElement)
    .getPropertyValue(varName)
    .trim();
  cssCache.set(varName, val);
  return val || fallback;
}

function drawRing(ring: Ring, color: string): void {
  ctx.lineWidth = 8;
  ctx.lineCap = 'round';
  const halfGap = ring.gap / 2;
  const start = ring.angle + halfGap;
  const end = ring.angle - halfGap + TWO_PI;
  ctx.strokeStyle = color;
  ctx.shadowBlur = 12;
  ctx.shadowColor = color;
  ctx.beginPath();
  ctx.arc(CX, CY, ring.radius, start, end);
  ctx.stroke();
  ctx.shadowBlur = 0;

  ctx.lineWidth = 2;
  ctx.strokeStyle = `${color}33`;
  const gapStart = ring.angle - halfGap;
  const gapEnd = ring.angle + halfGap;
  ctx.beginPath();
  ctx.arc(CX, CY, ring.radius, gapStart, gapEnd);
  ctx.stroke();

  const tickLen = 6;
  const tx0 = CX + Math.cos(ring.angle) * (ring.radius - tickLen);
  const ty0 = CY + Math.sin(ring.angle) * (ring.radius - tickLen);
  const tx1 = CX + Math.cos(ring.angle) * (ring.radius + tickLen);
  const ty1 = CY + Math.sin(ring.angle) * (ring.radius + tickLen);
  ctx.lineWidth = 2;
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.moveTo(tx0, ty0);
  ctx.lineTo(tx1, ty1);
  ctx.stroke();
}

function drawAim(): void {
  const accent = getCss('--cark-accent', '#f5f6f8');
  const tipR = AIM_RADIUS;
  const baseR = 12;

  const tipX = CX + Math.cos(aimAngle) * tipR;
  const tipY = CY + Math.sin(aimAngle) * tipR;
  const baseX = CX + Math.cos(aimAngle) * baseR;
  const baseY = CY + Math.sin(aimAngle) * baseR;

  ctx.strokeStyle = accent;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(baseX, baseY);
  ctx.lineTo(tipX, tipY);
  ctx.stroke();

  const headLen = 10;
  const headAngle = 0.5;
  const hx1 = tipX - Math.cos(aimAngle - headAngle) * headLen;
  const hy1 = tipY - Math.sin(aimAngle - headAngle) * headLen;
  const hx2 = tipX - Math.cos(aimAngle + headAngle) * headLen;
  const hy2 = tipY - Math.sin(aimAngle + headAngle) * headLen;
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(hx1, hy1);
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(hx2, hy2);
  ctx.stroke();

  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.arc(CX, CY, 6 + centerPulse * 4, 0, TWO_PI);
  ctx.fill();
}

function drawAimPreview(): void {
  if (state !== 'playing') return;
  const previewColor = 'rgba(245,246,248,0.10)';
  ctx.strokeStyle = previewColor;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 6]);
  ctx.beginPath();
  ctx.moveTo(CX + Math.cos(aimAngle) * AIM_RADIUS, CY + Math.sin(aimAngle) * AIM_RADIUS);
  ctx.lineTo(
    CX + Math.cos(aimAngle) * (OUTER_LIMIT + 14),
    CY + Math.sin(aimAngle) * (OUTER_LIMIT + 14),
  );
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawParticle(p: Particle): void {
  for (let i = 0; i < p.trail.length; i++) {
    const pt = p.trail[i]!;
    const k = (i + 1) / p.trail.length;
    ctx.fillStyle = `rgba(245, 246, 248, ${(k * pt.t * 0.45).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 2 + k * 2, 0, TWO_PI);
    ctx.fill();
  }
  if (p.alive) {
    const x = CX + Math.cos(p.angle) * p.r;
    const y = CY + Math.sin(p.angle) * p.r;
    ctx.fillStyle = '#fef3c7';
    ctx.shadowBlur = 14;
    ctx.shadowColor = '#fbbf24';
    ctx.beginPath();
    ctx.arc(x, y, 4.5, 0, TWO_PI);
    ctx.fill();
    ctx.shadowBlur = 0;
  }
}

function drawFlash(f: FlashRing): void {
  const ring = rings[f.ringIndex];
  if (!ring) return;
  const x = CX + Math.cos(f.angle) * ring.radius;
  const y = CY + Math.sin(f.angle) * ring.radius;
  const alpha = Math.max(0, Math.min(1, f.t / 0.45));
  if (f.hit) {
    ctx.strokeStyle = `rgba(167, 243, 208, ${(alpha * 0.85).toFixed(3)})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 8 + (1 - alpha) * 16, 0, TWO_PI);
    ctx.stroke();
  } else {
    ctx.strokeStyle = `rgba(248, 113, 113, ${(alpha * 0.85).toFixed(3)})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 6 + (1 - alpha) * 14, 0, TWO_PI);
    ctx.stroke();
    ctx.fillStyle = `rgba(248, 113, 113, ${(alpha * 0.35).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, TWO_PI);
    ctx.fill();
  }
}

function draw(): void {
  const bg = getCss('--cark-bg', '#070a12');
  const grid = getCss('--cark-grid', '#10172a');

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(CX, CY, OUTER_LIMIT, 0, TWO_PI);
  ctx.stroke();
  for (let i = 0; i < 12; i++) {
    const a = (i * Math.PI) / 6;
    const inner = 30;
    const outer = OUTER_LIMIT + 4;
    ctx.beginPath();
    ctx.moveTo(CX + Math.cos(a) * inner, CY + Math.sin(a) * inner);
    ctx.lineTo(CX + Math.cos(a) * outer, CY + Math.sin(a) * outer);
    ctx.stroke();
  }

  for (let i = 0; i < rings.length; i++) {
    const ring = rings[i]!;
    const color = RING_COLORS[i] ?? '#fbbf24';
    drawRing(ring, color);
  }

  drawAimPreview();

  for (const f of flashes) drawFlash(f);
  for (const p of particles) drawParticle(p);

  drawAim();

  const tier = tierFromScore(score);
  if (tier > 0) {
    ctx.fillStyle = 'rgba(245,246,248,0.45)';
    ctx.font = '11px ui-monospace, monospace';
    ctx.textAlign = 'right';
    ctx.fillText(`tier ${tier}`, W - 12, 18);
    ctx.textAlign = 'left';
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

  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerdown', onPointerDown);
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
