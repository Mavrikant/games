// ---------------------------------------------------------------------------
// Halka Geçidi — three concentric rotating rings, each with a single gap.
// Click to launch a ball from center outward; thread all three gaps in order
// to score. Hit a wall → lose a life. 3 lives per round.
// State machine: ready | aiming | flying | gameover
// Pitfalls addressed:
//   - unguarded-storage: safeRead / safeWrite
//   - stale-async-callback: gen token bumped on reset; RAF reads token at frame
//   - overlay-input-leak: explicit state enum; only `aiming` accepts launch
//   - invisible-boot: first frame draws the ring scene immediately
//   - visual-vs-hitbox: draw() and collide() share RING_RADII + GAP_HALF_WIDTH
//   - missing-overlay-css: per-game CSS defines .overlay--hidden
// ---------------------------------------------------------------------------

import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import {
  showOverlay as showOverlayEl,
  hideOverlay as hideOverlayEl,
} from '@shared/overlay';

type State = 'ready' | 'aiming' | 'flying' | 'gameover';

interface Ring {
  rInner: number;
  rOuter: number;
  angle: number; // current rotation, radians
  speed: number; // radians per second (signed)
  passed: boolean; // true once ball has fully crossed this ring on the current flight
}

// ── Geometry constants (shared by draw + collide) ──────────────────────────
const CANVAS = 480;
const CENTER = CANVAS / 2;
const RING_WIDTH = 12; // wall thickness in px
// Ring midpoint radii (inner → outer). The wall occupies [r - w/2, r + w/2].
const RING_RADII = [110, 160, 210];
const BALL_RADIUS = 7;
const GAP_HALF_WIDTH = 0.42; // ~24° half-arc → 48° gap
const BALL_SPEED = 320; // px/s
const SAFE_RADIUS = RING_RADII[2]! + RING_WIDTH; // beyond outer ring → success
const STORAGE_KEY = 'halka-gecidi.best';

// Speed progression
const BASE_SPEEDS = [0.9, -1.3, 1.7]; // rad/s for inner, middle, outer (mixed dirs)
const SPEED_RAMP = 0.07; // each successful pass adds this multiplier
const MAX_RAMP = 1.6; // cap (rings get ~2.6× base speed)

const LIVES_START = 3;
const FLASH_MS = 320;

// ── Game state ─────────────────────────────────────────────────────────────
const gen = createGenToken();
let state: State = 'ready';
let score = 0;
let best = 0;
let lives = LIVES_START;
let ramp = 0;

let rings: Ring[] = [];
const ball = { x: CENTER, y: CENTER, vx: 0, vy: 0 };
let ballTrail: { x: number; y: number }[] = [];

let lastFrame = 0;
let flashKind: 'success' | 'fail' | null = null;
let flashUntil = 0;
let shakeUntil = 0;

// ── DOM refs ───────────────────────────────────────────────────────────────
let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let boardWrap!: HTMLElement;
let scoreEl!: HTMLElement;
let livesEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayBtn!: HTMLButtonElement;

// ── Helpers ────────────────────────────────────────────────────────────────
function getCssVar(name: string, fallback: string): string {
  try {
    const v = getComputedStyle(document.documentElement)
      .getPropertyValue(name)
      .trim();
    return v || fallback;
  } catch {
    return fallback;
  }
}

function normAngle(a: number): number {
  const tau = Math.PI * 2;
  let x = a % tau;
  if (x < 0) x += tau;
  return x;
}

function inGap(ringAngle: number, ballAngle: number): boolean {
  const tau = Math.PI * 2;
  const a = normAngle(ringAngle);
  const b = normAngle(ballAngle);
  let diff = Math.abs(a - b);
  if (diff > Math.PI) diff = tau - diff;
  return diff <= GAP_HALF_WIDTH;
}

function buildRings(): void {
  rings = RING_RADII.map((r, i) => ({
    rInner: r - RING_WIDTH / 2,
    rOuter: r + RING_WIDTH / 2,
    angle: Math.random() * Math.PI * 2,
    speed: BASE_SPEEDS[i]!,
    passed: false,
  }));
}

function applyRamp(): void {
  const mult = 1 + Math.min(ramp, MAX_RAMP);
  for (let i = 0; i < rings.length; i++) {
    const r = rings[i]!;
    r.speed = BASE_SPEEDS[i]! * mult;
  }
}

// ── State transitions ──────────────────────────────────────────────────────
function showOverlay(title: string, msgHtml: string, btnLabel: string): void {
  overlayTitle.textContent = title;
  overlayMsg.innerHTML = msgHtml;
  overlayBtn.textContent = btnLabel;
  showOverlayEl(overlay);
  overlayBtn.focus({ preventScroll: true });
}

function startGame(): void {
  gen.bump();
  state = 'aiming';
  score = 0;
  lives = LIVES_START;
  ramp = 0;
  buildRings();
  applyRamp();
  ball.x = CENTER;
  ball.y = CENTER;
  ball.vx = 0;
  ball.vy = 0;
  ballTrail = [];
  flashKind = null;
  flashUntil = 0;
  shakeUntil = 0;
  scoreEl.textContent = '0';
  livesEl.textContent = String(LIVES_START);
  bestEl.textContent = String(best);
  hideOverlayEl(overlay);
  lastFrame = performance.now();
  scheduleFrame();
}

function resetToReady(): void {
  gen.bump();
  state = 'ready';
  score = 0;
  lives = LIVES_START;
  ramp = 0;
  buildRings();
  applyRamp();
  ball.x = CENTER;
  ball.y = CENTER;
  ball.vx = 0;
  ball.vy = 0;
  ballTrail = [];
  flashKind = null;
  flashUntil = 0;
  shakeUntil = 0;
  scoreEl.textContent = '0';
  livesEl.textContent = String(LIVES_START);
  bestEl.textContent = String(best);
  // Render one static frame so the playfield is visible behind overlay.
  draw(performance.now());
  showOverlay(
    'Halka Geçidi',
    'Üç dönen halkanın boşluklarından topu <strong>sırayla</strong> geçir.<br><small>Tıkla veya dokun: o yöne fırlat. 3 can.</small>',
    'Başla',
  );
}

function endGame(): void {
  if (state === 'gameover') return;
  state = 'gameover';
  gen.bump();
  if (score > best) {
    best = score;
    safeWrite(STORAGE_KEY, best);
    bestEl.textContent = String(best);
  }
  const title = score > 0 && score >= best ? 'Yeni rekor!' : 'Bitti!';
  const msg = `Skor: <strong>${score}</strong><br>En iyi: ${best}<br><small>Boşluk veya R ile yeniden başla</small>`;
  showOverlay(title, msg, 'Tekrar oyna');
}

// ── Launch / collide ───────────────────────────────────────────────────────
function launchTowards(cx: number, cy: number): void {
  if (state !== 'aiming') return;
  const dx = cx - CENTER;
  const dy = cy - CENTER;
  const len = Math.hypot(dx, dy);
  if (len < 1e-3) return; // ignore center clicks
  const nx = dx / len;
  const ny = dy / len;
  ball.x = CENTER;
  ball.y = CENTER;
  ball.vx = nx * BALL_SPEED;
  ball.vy = ny * BALL_SPEED;
  ballTrail = [];
  for (const r of rings) r.passed = false;
  state = 'flying';
}

function checkCollisions(
  prevR: number,
  curR: number,
  ballAngle: number,
): { hit: boolean } {
  let hit = false;
  for (let i = 0; i < rings.length; i++) {
    const r = rings[i]!;
    if (r.passed) continue;
    // Ball overlaps this ring's wall annulus this frame?
    if (curR + BALL_RADIUS >= r.rInner && prevR - BALL_RADIUS < r.rOuter) {
      if (inGap(r.angle, ballAngle)) {
        // Once fully past the outer edge, count as passed.
        if (curR - BALL_RADIUS >= r.rOuter) {
          r.passed = true;
        }
      } else {
        hit = true;
        break;
      }
    }
  }
  return { hit };
}

function onSuccess(): void {
  score += 1;
  scoreEl.textContent = String(score);
  if (score > best) {
    best = score;
    safeWrite(STORAGE_KEY, best);
    bestEl.textContent = String(best);
  }
  flashKind = 'success';
  flashUntil = performance.now() + FLASH_MS;
  ramp += SPEED_RAMP;
  applyRamp();
  // Re-randomize ring angles so the next puzzle is fresh.
  for (const r of rings) r.angle = Math.random() * Math.PI * 2;
  ball.x = CENTER;
  ball.y = CENTER;
  ball.vx = 0;
  ball.vy = 0;
  ballTrail = [];
  state = 'aiming';
}

function onFail(): void {
  lives -= 1;
  livesEl.textContent = String(Math.max(lives, 0));
  flashKind = 'fail';
  flashUntil = performance.now() + FLASH_MS;
  shakeUntil = performance.now() + FLASH_MS;
  ball.x = CENTER;
  ball.y = CENTER;
  ball.vx = 0;
  ball.vy = 0;
  ballTrail = [];
  if (lives <= 0) {
    endGame();
    return;
  }
  state = 'aiming';
}

// ── Frame loop ─────────────────────────────────────────────────────────────
function scheduleFrame(): void {
  const myToken = gen.current();
  requestAnimationFrame((t) => {
    if (myToken !== gen.current()) return;
    if (state === 'ready' || state === 'gameover') return;
    frame(t);
    scheduleFrame();
  });
}

function frame(now: number): void {
  let dt = (now - lastFrame) / 1000;
  if (dt > 0.05) dt = 0.05; // clamp on tab-switch
  lastFrame = now;

  // Rings spin always (including while aiming) for visual life.
  for (const r of rings) {
    r.angle = normAngle(r.angle + r.speed * dt);
  }

  if (state === 'flying') {
    const prevX = ball.x;
    const prevY = ball.y;
    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;
    ballTrail.push({ x: ball.x, y: ball.y });
    if (ballTrail.length > 14) ballTrail.shift();
    const prevR = Math.hypot(prevX - CENTER, prevY - CENTER);
    const curR = Math.hypot(ball.x - CENTER, ball.y - CENTER);
    const ballAngle = Math.atan2(ball.y - CENTER, ball.x - CENTER);
    const { hit } = checkCollisions(prevR, curR, ballAngle);
    if (hit) {
      onFail();
    } else if (curR - BALL_RADIUS >= SAFE_RADIUS) {
      if (rings.every((r) => r.passed)) {
        onSuccess();
      } else {
        onFail();
      }
    } else if (
      ball.x < -BALL_RADIUS ||
      ball.x > CANVAS + BALL_RADIUS ||
      ball.y < -BALL_RADIUS ||
      ball.y > CANVAS + BALL_RADIUS
    ) {
      onFail();
    }
  }

  draw(now);
}

// ── Render ─────────────────────────────────────────────────────────────────
function draw(now: number): void {
  const flashing = flashKind && now < flashUntil;
  const shake = now < shakeUntil ? (Math.random() - 0.5) * 6 : 0;
  if (shake !== 0) {
    boardWrap.style.transform = `translate(${shake}px, ${shake * 0.6}px)`;
  } else {
    boardWrap.style.transform = '';
  }

  ctx.save();
  // Backdrop
  ctx.fillStyle = getCssVar('--hg-bg', '#0a0d12');
  ctx.fillRect(0, 0, CANVAS, CANVAS);

  // Subtle center glow
  const glow = ctx.createRadialGradient(
    CENTER,
    CENTER,
    0,
    CENTER,
    CENTER,
    SAFE_RADIUS,
  );
  glow.addColorStop(0, 'rgba(99, 102, 241, 0.18)');
  glow.addColorStop(1, 'rgba(99, 102, 241, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, CANVAS, CANVAS);

  // Faint guide circle at SAFE_RADIUS
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(CENTER, CENTER, SAFE_RADIUS, 0, Math.PI * 2);
  ctx.stroke();

  // Rings — draw each as arc with gap removed
  const ringColors = [
    getCssVar('--hg-ring-1', '#a78bfa'),
    getCssVar('--hg-ring-2', '#34d399'),
    getCssVar('--hg-ring-3', '#fb7185'),
  ];
  for (let i = 0; i < rings.length; i++) {
    const r = rings[i]!;
    const radius = (r.rInner + r.rOuter) / 2;
    const color = ringColors[i]!;
    ctx.lineWidth = RING_WIDTH;
    ctx.strokeStyle = color;
    ctx.lineCap = 'butt';
    const gapStart = r.angle - GAP_HALF_WIDTH;
    const gapEnd = r.angle + GAP_HALF_WIDTH;
    ctx.beginPath();
    ctx.arc(CENTER, CENTER, radius, gapEnd, gapStart + Math.PI * 2);
    ctx.stroke();

    // Gap edge dots — improve readability
    ctx.fillStyle = color;
    const gapXa = CENTER + Math.cos(gapStart) * radius;
    const gapYa = CENTER + Math.sin(gapStart) * radius;
    const gapXb = CENTER + Math.cos(gapEnd) * radius;
    const gapYb = CENTER + Math.sin(gapEnd) * radius;
    ctx.beginPath();
    ctx.arc(gapXa, gapYa, 3, 0, Math.PI * 2);
    ctx.arc(gapXb, gapYb, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  // Ball trail
  if (state === 'flying' && ballTrail.length > 0) {
    for (let i = 0; i < ballTrail.length; i++) {
      const p = ballTrail[i]!;
      const alpha = (i + 1) / ballTrail.length;
      ctx.fillStyle = `rgba(250,204,21,${alpha * 0.5})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, BALL_RADIUS * (0.4 + alpha * 0.6), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Ball
  ctx.fillStyle = getCssVar('--hg-ball', '#facc15');
  ctx.beginPath();
  ctx.arc(ball.x, ball.y, BALL_RADIUS, 0, Math.PI * 2);
  ctx.fill();

  // Center pulse when aiming
  if (state === 'aiming') {
    const pulse = 0.4 + 0.3 * Math.sin(now / 250);
    ctx.strokeStyle = `rgba(250,204,21,${pulse})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(CENTER, CENTER, BALL_RADIUS + 5, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Flash overlay
  if (flashing) {
    const remain = (flashUntil - now) / FLASH_MS;
    const alpha = Math.max(0, remain) * 0.35;
    ctx.fillStyle =
      flashKind === 'success'
        ? `rgba(52,211,153,${alpha})`
        : `rgba(251,113,133,${alpha})`;
    ctx.fillRect(0, 0, CANVAS, CANVAS);
  }
  ctx.restore();
}

// ── Input ──────────────────────────────────────────────────────────────────
function canvasCoordsFromEvent(e: PointerEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const scaleX = CANVAS / rect.width;
  const scaleY = CANVAS / rect.height;
  return {
    x: (e.clientX - rect.left) * scaleX,
    y: (e.clientY - rect.top) * scaleY,
  };
}

function onPointerDown(e: PointerEvent): void {
  if (state !== 'aiming') return;
  e.preventDefault();
  const { x, y } = canvasCoordsFromEvent(e);
  launchTowards(x, y);
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'r' || e.key === 'R') {
    e.preventDefault();
    startGame();
    return;
  }
  if (state === 'ready' || state === 'gameover') {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      startGame();
    }
  }
}

// ── Init ───────────────────────────────────────────────────────────────────
function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  boardWrap = document.querySelector<HTMLElement>('#board-wrap')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  livesEl = document.querySelector<HTMLElement>('#lives')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;

  best = safeRead<number>(STORAGE_KEY, 0);
  if (!Number.isFinite(best) || best < 0) best = 0;
  bestEl.textContent = String(best);

  canvas.addEventListener('pointerdown', onPointerDown);
  restartBtn.addEventListener('click', startGame);
  overlayBtn.addEventListener('click', startGame);
  window.addEventListener('keydown', onKey);

  resetToReady();
}

export const game = defineGame({ init, reset: resetToReady });
