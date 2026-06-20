// ---------------------------------------------------------------------------
// Çubuk Dengele — inverted pendulum balancer. A heavy rod is pivoted on a
// small cart at the bottom of the field; the player slides the cart left and
// right to keep the rod within ±FALL_ANGLE of vertical. Wind gusts apply
// angular impulses periodically. Score = seconds survived (×10) + streak
// bonuses. Each level (every LEVEL_PERIOD_S seconds) makes the rod longer,
// heavier (slower omega response), and the wind stronger.
//
// State machine: ready | playing | gameover
//
// Pitfalls explicitly addressed:
//  - module-level-dom-access:    all DOM access inside init()
//  - unguarded-storage:          @shared/storage safeRead/safeWrite
//  - stale-async-callback:       gen-token; RAF re-reads token each frame
//  - overlay-input-leak:         state enum guards every input handler
//  - missing-overlay-css:        per-game CSS defines .overlay--hidden
//  - visual-vs-hitbox:           draw() reads ROD_LEN/etc through helpers
//                                derived from the same physics constants
//  - invisible-boot:             resetToReady() draws a static scene under
//                                the overlay so cold boot shows the game
//  - hud-counter-synced-only-at-lifecycle-edges:
//                                score/level HUD updated each frame
//  - unreachable-start-state:    overlay button + Space/Enter both start
//  - designed-lose-condition-not-wired:
//                                |theta| > FALL_ANGLE explicitly endGame()
// ---------------------------------------------------------------------------

import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import {
  showOverlay as showOverlayEl,
  hideOverlay as hideOverlayEl,
} from '@shared/overlay';

type State = 'ready' | 'playing' | 'gameover';

// ── Geometry (canvas px) — shared by draw + physics ────────────────────────
const CANVAS = 480;
const GROUND_Y = 420;
const CART_W = 80;
const CART_H = 18;
const PIVOT_Y = GROUND_Y - CART_H; // y of cart's top edge
const HALF_RANGE = (CANVAS - CART_W) / 2; // cart x bounds: [-HALF_RANGE, +HALF_RANGE]

// ── Physics constants ──────────────────────────────────────────────────────
const BASE_ROD_LEN = 200; // px, level 1
const ROD_LEN_PER_LEVEL = 12; // px added per level
const ROD_LEN_MAX = 320;
const BASE_GRAVITY = 11.0; // synthetic g/L coefficient (tuned)
const FALL_ANGLE = (70 * Math.PI) / 180; // ~1.22 rad — game over
const CART_ACCEL = 1900; // px / s² (keyboard)
const CART_MAX_V = 760; // px / s
const CART_FRICTION = 6.0; // velocity decay per second when no input
const AIR_DAMPING = 0.6; // omega decay per second (gentle)
const POINTER_FOLLOW_K = 14.0; // spring-like (1/s) when finger-dragging
const WIND_BASE_MAG = 1.8; // rad / s² (level 1)
const WIND_LEVEL_GAIN = 0.35; // per level
const WIND_BURST_MS = 700; // wind active duration per gust
const WIND_INTERVAL_MIN_MS = 2800;
const WIND_INTERVAL_MAX_MS = 5200;

// ── Scoring constants ──────────────────────────────────────────────────────
const SCORE_PER_SEC = 10;
const STREAK_BONUS = 15; // when |theta| stays small for STREAK_SECS
const STREAK_SECS = 5;
const STREAK_QUIET_ANGLE = (12 * Math.PI) / 180; // "calm" threshold
const LEVEL_PERIOD_S = 15; // seconds per level

const STORAGE_KEY = 'cubuk-dengele.best';

// ── Mutable state ──────────────────────────────────────────────────────────
const gen = createGenToken();
let state: State = 'ready';
let score = 0;
let best = 0;
let level = 1;

// Physics state
let cartX = 0;
let cartV = 0;
let theta = 0; // radians, 0 = straight up, positive = leaning right
let omega = 0;

// Input
let keyLeft = false;
let keyRight = false;
let pointerActive = false;
let pointerTargetX = 0;

// Wind
let windActiveUntil = 0;
let nextWindAt = 0;
let windMag = 0; // current gust magnitude (signed)

// Timing
let lastFrame = 0;
let runStartedAt = 0;
let calmAccumulator = 0;
let streakAwardedAt = 0;
let lastScoreShown = -1;
let lastLevelShown = -1;

// DOM refs (assigned in init)
let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let boardWrap!: HTMLElement;
let scoreEl!: HTMLElement;
let levelEl!: HTMLElement;
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

function rodLen(): number {
  return Math.min(BASE_ROD_LEN + (level - 1) * ROD_LEN_PER_LEVEL, ROD_LEN_MAX);
}

function gravityCoef(): number {
  // Effective angular-acceleration multiplier: g / L. Longer rod → falls
  // slower but moves a longer arc → still feels harder because tip displaces
  // farther per radian. Plus we add a baseline weighting.
  return BASE_GRAVITY / (rodLen() / BASE_ROD_LEN);
}

function windPeakMag(): number {
  return WIND_BASE_MAG + (level - 1) * WIND_LEVEL_GAIN;
}

function pivotPx(): { x: number; y: number } {
  return { x: CANVAS / 2 + cartX, y: PIVOT_Y };
}

function scheduleNextWind(now: number): void {
  const span = WIND_INTERVAL_MAX_MS - WIND_INTERVAL_MIN_MS;
  nextWindAt = now + WIND_INTERVAL_MIN_MS + Math.random() * span;
}

// ── State transitions ──────────────────────────────────────────────────────
function showStartOverlay(): void {
  overlayTitle.textContent = 'Çubuk Dengele';
  overlayMsg.innerHTML =
    'Arabayı kaydır, üstündeki <strong>ağır çubuk dik kalsın</strong>.<br>' +
    '<small>← / → · A / D · veya sahada parmakla sürükle</small>';
  overlayBtn.textContent = 'Başla';
  showOverlayEl(overlay);
  overlayBtn.focus({ preventScroll: true });
}

function showGameOverOverlay(): void {
  const isRecord = score > 0 && score >= best;
  overlayTitle.textContent = isRecord ? 'Yeni rekor!' : 'Çubuk düştü';
  overlayMsg.innerHTML =
    `Skor: <strong>${score}</strong> · Seviye: ${level}<br>` +
    `En iyi: ${best}<br>` +
    '<small>Boşluk · Enter · R ile yeniden başla</small>';
  overlayBtn.textContent = 'Tekrar oyna';
  showOverlayEl(overlay);
  overlayBtn.focus({ preventScroll: true });
}

function resetToReady(): void {
  gen.bump();
  state = 'ready';
  score = 0;
  level = 1;
  cartX = 0;
  cartV = 0;
  // Tiny lean so the pendulum looks "alive" on the title screen.
  theta = 0.06;
  omega = 0;
  keyLeft = false;
  keyRight = false;
  pointerActive = false;
  windActiveUntil = 0;
  windMag = 0;
  calmAccumulator = 0;
  streakAwardedAt = 0;
  runStartedAt = 0;
  scoreEl.textContent = '0';
  levelEl.textContent = '1';
  bestEl.textContent = String(best);
  lastScoreShown = 0;
  lastLevelShown = 1;
  // Render one static frame so the playfield is visible behind the overlay
  // (PITFALLS#invisible-boot).
  draw(performance.now());
  showStartOverlay();
}

function startGame(): void {
  gen.bump();
  state = 'playing';
  score = 0;
  level = 1;
  cartX = 0;
  cartV = 0;
  theta = (Math.random() - 0.5) * 0.08; // small random initial lean
  omega = 0;
  keyLeft = false;
  keyRight = false;
  pointerActive = false;
  windActiveUntil = 0;
  windMag = 0;
  calmAccumulator = 0;
  streakAwardedAt = 0;
  scoreEl.textContent = '0';
  levelEl.textContent = '1';
  bestEl.textContent = String(best);
  lastScoreShown = 0;
  lastLevelShown = 1;
  const now = performance.now();
  runStartedAt = now;
  lastFrame = now;
  scheduleNextWind(now);
  hideOverlayEl(overlay);
  scheduleFrame();
}

function endGame(): void {
  if (state === 'gameover') return;
  state = 'gameover';
  gen.bump();
  if (score > best) {
    best = score;
    safeWrite(STORAGE_KEY, best);
  }
  bestEl.textContent = String(best);
  showGameOverOverlay();
}

// ── Frame loop ─────────────────────────────────────────────────────────────
function scheduleFrame(): void {
  const myToken = gen.current();
  requestAnimationFrame((t) => {
    if (myToken !== gen.current()) return;
    if (state !== 'playing') return;
    frame(t);
    scheduleFrame();
  });
}

function frame(now: number): void {
  let dt = (now - lastFrame) / 1000;
  if (dt > 0.05) dt = 0.05; // clamp on tab-switch / hitch
  if (dt < 0) dt = 0;
  lastFrame = now;

  // Wind scheduler ---------------------------------------------------------
  if (now >= nextWindAt) {
    const dir = Math.random() < 0.5 ? -1 : 1;
    const strength = 0.55 + Math.random() * 0.45;
    windMag = dir * windPeakMag() * strength;
    windActiveUntil = now + WIND_BURST_MS;
    scheduleNextWind(now);
  }
  const windActive = now < windActiveUntil;

  // Cart kinematics --------------------------------------------------------
  let cartA = 0;
  if (pointerActive) {
    const dx = pointerTargetX - cartX;
    // Spring toward pointer, clamped to CART_ACCEL.
    cartA = Math.max(
      -CART_ACCEL,
      Math.min(CART_ACCEL, dx * POINTER_FOLLOW_K - cartV * 2),
    );
  } else if (keyLeft && !keyRight) {
    cartA = -CART_ACCEL;
  } else if (keyRight && !keyLeft) {
    cartA = CART_ACCEL;
  } else {
    // Friction: decay velocity toward zero.
    cartA = -cartV * CART_FRICTION;
  }
  cartV += cartA * dt;
  if (cartV > CART_MAX_V) cartV = CART_MAX_V;
  if (cartV < -CART_MAX_V) cartV = -CART_MAX_V;
  cartX += cartV * dt;
  let hitWall = false;
  if (cartX > HALF_RANGE) {
    cartX = HALF_RANGE;
    if (cartV > 0) cartV = 0;
    hitWall = true;
  }
  if (cartX < -HALF_RANGE) {
    cartX = -HALF_RANGE;
    if (cartV < 0) cartV = 0;
    hitWall = true;
  }

  // Pendulum dynamics ------------------------------------------------------
  // The effective acceleration the rod's pivot experiences is `cartA`,
  // saturated by wall contact. When the cart hits a wall, treat its
  // acceleration as zero so the rod no longer benefits from cart push past
  // that frame — otherwise the player could "pin" the cart against a wall
  // and exploit infinite reaction force.
  const effCartA = hitWall ? 0 : cartA;
  const g = gravityCoef();
  // alpha = g * sin(theta) - (a_cart / L) * cos(theta) + wind
  const len = rodLen();
  let alpha = g * Math.sin(theta) - (effCartA / len) * Math.cos(theta);
  if (windActive) alpha += windMag;
  // Apply
  omega += alpha * dt;
  // Damping (omega decays toward 0 by AIR_DAMPING per second).
  omega -= omega * AIR_DAMPING * dt;
  theta += omega * dt;

  // Score + level ----------------------------------------------------------
  const elapsedS = (now - runStartedAt) / 1000;
  const newScore = Math.floor(elapsedS * SCORE_PER_SEC);
  if (newScore > score) score = newScore;
  const newLevel = 1 + Math.floor(elapsedS / LEVEL_PERIOD_S);
  if (newLevel > level) level = newLevel;

  // Streak bonus -----------------------------------------------------------
  if (Math.abs(theta) < STREAK_QUIET_ANGLE) {
    calmAccumulator += dt;
    if (calmAccumulator >= STREAK_SECS && now - streakAwardedAt > 200) {
      score += STREAK_BONUS;
      streakAwardedAt = now;
      calmAccumulator = 0;
    }
  } else {
    calmAccumulator = 0;
  }

  // HUD sync (PITFALLS#hud-counter-synced-only-at-lifecycle-edges) ---------
  if (score !== lastScoreShown) {
    scoreEl.textContent = String(score);
    lastScoreShown = score;
  }
  if (level !== lastLevelShown) {
    levelEl.textContent = String(level);
    lastLevelShown = level;
  }

  // Lose check (PITFALLS#designed-lose-condition-not-wired) ---------------
  if (Math.abs(theta) >= FALL_ANGLE) {
    // Snap angle to the wall so the failed frame draws coherently.
    theta = theta > 0 ? FALL_ANGLE : -FALL_ANGLE;
    omega = 0;
    draw(now);
    endGame();
    return;
  }

  draw(now);
}

// ── Render ─────────────────────────────────────────────────────────────────
function draw(now: number): void {
  // Backdrop -------------------------------------------------------------
  ctx.save();
  ctx.fillStyle = getCssVar('--cd-bg', '#0d1117');
  ctx.fillRect(0, 0, CANVAS, CANVAS);

  // Sky-glow at top (visual breathing room).
  const skyGrad = ctx.createLinearGradient(0, 0, 0, GROUND_Y);
  skyGrad.addColorStop(0, 'rgba(124, 92, 255, 0.16)');
  skyGrad.addColorStop(1, 'rgba(124, 92, 255, 0)');
  ctx.fillStyle = skyGrad;
  ctx.fillRect(0, 0, CANVAS, GROUND_Y);

  // Wall guides — light vertical lines at cart bounds.
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(CART_W / 2, 0);
  ctx.lineTo(CART_W / 2, GROUND_Y);
  ctx.moveTo(CANVAS - CART_W / 2, 0);
  ctx.lineTo(CANVAS - CART_W / 2, GROUND_Y);
  ctx.stroke();

  // Ground line
  ctx.strokeStyle = getCssVar('--cd-ground', '#3a3f55');
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, GROUND_Y);
  ctx.lineTo(CANVAS, GROUND_Y);
  ctx.stroke();

  // Ground ticks
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 20; x < CANVAS; x += 30) {
    ctx.moveTo(x, GROUND_Y);
    ctx.lineTo(x - 8, GROUND_Y + 10);
  }
  ctx.stroke();

  // Wind indicator (top edge) --------------------------------------------
  const windActive = now < windActiveUntil && state === 'playing';
  if (windActive) {
    const cx = CANVAS / 2;
    const cy = 32;
    const intensity = Math.min(1, Math.abs(windMag) / 5);
    const len = 60 * intensity;
    const dir = Math.sign(windMag);
    ctx.strokeStyle =
      dir > 0
        ? 'rgba(251, 113, 133, 0.85)'
        : 'rgba(56, 189, 248, 0.85)';
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx - dir * len, cy);
    ctx.lineTo(cx + dir * len, cy);
    // Arrowhead
    ctx.moveTo(cx + dir * len, cy);
    ctx.lineTo(cx + dir * (len - 12), cy - 8);
    ctx.moveTo(cx + dir * len, cy);
    ctx.lineTo(cx + dir * (len - 12), cy + 8);
    ctx.stroke();
    // Label
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = '600 11px system-ui, ui-sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('RÜZGAR', cx, cy - 18);
  }

  // Pivot tilt-warning ring when nearing fall angle.
  const tiltFrac = Math.min(1, Math.abs(theta) / FALL_ANGLE);
  const pivot = pivotPx();
  if (state === 'playing' && tiltFrac > 0.55) {
    const alpha = (tiltFrac - 0.55) / 0.45;
    ctx.fillStyle = `rgba(251, 113, 133, ${alpha * 0.18})`;
    ctx.fillRect(0, 0, CANVAS, CANVAS);
  }

  // Rod ------------------------------------------------------------------
  const len = rodLen();
  const tipX = pivot.x + Math.sin(theta) * len;
  const tipY = pivot.y - Math.cos(theta) * len;
  ctx.strokeStyle = getCssVar('--cd-rod', '#a78bfa');
  ctx.lineWidth = 8;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(pivot.x, pivot.y);
  ctx.lineTo(tipX, tipY);
  ctx.stroke();

  // Inner highlight on rod
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(pivot.x, pivot.y);
  ctx.lineTo(tipX, tipY);
  ctx.stroke();

  // Weight at tip (radius grows with level → visually heavier).
  const weightR = 16 + Math.min(8, (level - 1) * 1.2);
  const weightColor =
    tiltFrac > 0.7
      ? getCssVar('--cd-weight-danger', '#fb7185')
      : getCssVar('--cd-weight', '#facc15');
  ctx.fillStyle = weightColor;
  ctx.beginPath();
  ctx.arc(tipX, tipY, weightR, 0, Math.PI * 2);
  ctx.fill();
  // Weight outline
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Cart -----------------------------------------------------------------
  ctx.fillStyle = getCssVar('--cd-cart', '#38bdf8');
  ctx.fillRect(pivot.x - CART_W / 2, pivot.y, CART_W, CART_H);
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  ctx.fillRect(pivot.x - CART_W / 2, pivot.y + CART_H - 4, CART_W, 4);
  // Wheels
  ctx.fillStyle = '#1c1f2e';
  ctx.beginPath();
  ctx.arc(pivot.x - CART_W / 2 + 14, GROUND_Y, 6, 0, Math.PI * 2);
  ctx.arc(pivot.x + CART_W / 2 - 14, GROUND_Y, 6, 0, Math.PI * 2);
  ctx.fill();

  // Pivot dot
  ctx.fillStyle = '#0d1117';
  ctx.beginPath();
  ctx.arc(pivot.x, pivot.y, 4, 0, Math.PI * 2);
  ctx.fill();

  // Tilt-meter (bottom-right): a small arc with a needle for theta.
  drawTiltMeter(theta);

  ctx.restore();
}

function drawTiltMeter(angle: number): void {
  const cx = CANVAS - 40;
  const cy = GROUND_Y - 14;
  const r = 26;
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 4;
  ctx.beginPath();
  // Arc spanning -FALL_ANGLE..+FALL_ANGLE, drawn upward (center at cy).
  ctx.arc(cx, cy, r, -Math.PI / 2 - FALL_ANGLE, -Math.PI / 2 + FALL_ANGLE);
  ctx.stroke();
  // Safe zone (green)
  ctx.strokeStyle = 'rgba(52,211,153,0.5)';
  ctx.beginPath();
  ctx.arc(
    cx,
    cy,
    r,
    -Math.PI / 2 - STREAK_QUIET_ANGLE,
    -Math.PI / 2 + STREAK_QUIET_ANGLE,
  );
  ctx.stroke();
  // Needle
  const nAngle = Math.max(-FALL_ANGLE, Math.min(FALL_ANGLE, angle));
  const nx = cx + Math.sin(nAngle) * r;
  const ny = cy - Math.cos(nAngle) * r;
  ctx.strokeStyle =
    Math.abs(nAngle) > FALL_ANGLE * 0.7
      ? 'rgba(251,113,133,0.95)'
      : 'rgba(250,204,21,0.95)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(nx, ny);
  ctx.stroke();
  ctx.fillStyle = '#0d1117';
  ctx.beginPath();
  ctx.arc(cx, cy, 3, 0, Math.PI * 2);
  ctx.fill();
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
  if (state !== 'playing') return;
  e.preventDefault();
  const { x } = canvasCoordsFromEvent(e);
  pointerActive = true;
  pointerTargetX = Math.max(-HALF_RANGE, Math.min(HALF_RANGE, x - CANVAS / 2));
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {
    // setPointerCapture can throw if the pointer event is synthetic; ignore.
  }
}

function onPointerMove(e: PointerEvent): void {
  if (!pointerActive) return;
  const { x } = canvasCoordsFromEvent(e);
  pointerTargetX = Math.max(-HALF_RANGE, Math.min(HALF_RANGE, x - CANVAS / 2));
}

function onPointerUp(e: PointerEvent): void {
  pointerActive = false;
  try {
    canvas.releasePointerCapture(e.pointerId);
  } catch {
    // ignore
  }
}

function onKeyDown(e: KeyboardEvent): void {
  // Restart on R from any state (PITFALLS#unreachable-start-state — always
  // a guaranteed transition path).
  if (e.key === 'r' || e.key === 'R') {
    e.preventDefault();
    startGame();
    return;
  }
  // Start on Space/Enter from ready or gameover.
  if (state === 'ready' || state === 'gameover') {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      startGame();
    }
    return;
  }
  if (state !== 'playing') return;
  if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') {
    e.preventDefault();
    keyLeft = true;
  } else if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') {
    e.preventDefault();
    keyRight = true;
  }
}

function onKeyUp(e: KeyboardEvent): void {
  if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') {
    keyLeft = false;
  } else if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') {
    keyRight = false;
  }
}

// ── Init ───────────────────────────────────────────────────────────────────
function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  boardWrap = document.querySelector<HTMLElement>('#board-wrap')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  levelEl = document.querySelector<HTMLElement>('#level')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;

  // Avoid 'never read' TS errors when extra state (boardWrap) is held for
  // future shake effects — referenced via a no-op read here.
  void boardWrap;

  const stored = safeRead<number>(STORAGE_KEY, 0);
  best = Number.isFinite(stored) && stored >= 0 ? stored : 0;
  bestEl.textContent = String(best);

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  restartBtn.addEventListener('click', startGame);
  overlayBtn.addEventListener('click', startGame);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  resetToReady();
}

export const game = defineGame({ init, reset: resetToReady });
