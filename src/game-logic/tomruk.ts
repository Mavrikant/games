import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import {
  showOverlay as showOverlayEl,
  hideOverlay as hideOverlayEl,
} from '@shared/overlay';

// PITFALLS guarded here (see docs/PITFALLS.md):
// - unguarded-storage: storage goes through safeRead/safeWrite.
// - overlay-input-leak: every input handler tops out with a state guard.
// - invisible-boot: first step shifts visible lumberjack + log within one
//   frame; reset() resets every per-life accumulator.
// - module-level side effects: all DOM access lives in init().
// - missing-overlay-css: .overlay / .overlay--hidden defined in tomruk.css.

const STORAGE_BEST = 'tomruk.best';

type State = 'ready' | 'playing' | 'gameover';
type Side = 'left' | 'right';

const W = 480;
const H = 480;

const WATER_Y = 360;
const LOG_CX = W / 2;
const LOG_CY = 332;
const LOG_R = 92;

// Physics constants.
const FALL_THRESHOLD = 1.05; // radians off-top → fall (~60°).
const STEP_SIZE = 0.34; // angular shift per step on log surface.
const STEP_IMPULSE = 0.55; // counter-spin recoil (Newton 3rd law).
const STEP_COOLDOWN_MS = 200;
const FRICTION_PER_SEC = 1.05; // log spin decays exponentially.
const GRAVITY_GAIN_BASE = 2.1; // sin(balance) → angular accel.
const GRAVITY_RAMP_PER_SEC = 0.014; // gradual difficulty.

// Wave events.
const WAVE_MIN_GAP_S = 5.0;
const WAVE_MAX_GAP_S = 9.0;
const WAVE_WARNING_S = 1.4;
const WAVE_IMPULSE_MIN = 1.05;
const WAVE_IMPULSE_MAX = 1.75;
const WAVE_RAMP_DENOM = 35; // adds up to ~+0.4 per 35s.

// Visual / animation.
const STEP_ANIM_MS = 180;
const FALL_ANIM_MS = 900;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let timeEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayStartBtn!: HTMLButtonElement;

let state: State = 'ready';
let best = 0;
let elapsedMs = 0;
let balance = 0; // lumberjack angular position relative to log top (rad).
let spin = 0; // log angular velocity (rad/s, +CW from viewer).
let logPhase = 0; // accumulated log rotation (rad) — only for visuals.
let stepCooldownMs = 0;
let stepAnimMs = 0;
let stepAnimSide: Side | null = null;

let pendingWave: { dir: 1 | -1; impulse: number; remainingMs: number } | null =
  null;
let nextWaveS = 0;

// Fall animation.
let fallAnimMs = 0;
let fallStartBalance = 0;
let fallDir: 1 | -1 = 1;

// Water ripples for ambient motion (purely visual).
let waterPhase = 0;

let rafId = 0;
let lastFrameMs = 0;

const cssCache = new Map<string, string>();
function getCss(name: string, fallback: string): string {
  const cached = cssCache.get(name);
  if (cached !== undefined) return cached || fallback;
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  cssCache.set(name, v);
  return v || fallback;
}

function setTime(ms: number): void {
  elapsedMs = ms;
  timeEl.textContent = String(Math.floor(ms / 1000));
}

function setBest(v: number): void {
  best = v;
  bestEl.textContent = String(best);
}

function scheduleNextWave(): void {
  nextWaveS = WAVE_MIN_GAP_S + Math.random() * (WAVE_MAX_GAP_S - WAVE_MIN_GAP_S);
}

function startWaveWarning(): void {
  const dir: 1 | -1 = Math.random() < 0.5 ? -1 : 1;
  const rampBoost = Math.min(0.4, elapsedMs / 1000 / WAVE_RAMP_DENOM);
  const impulse =
    WAVE_IMPULSE_MIN +
    Math.random() * (WAVE_IMPULSE_MAX - WAVE_IMPULSE_MIN) +
    rampBoost;
  pendingWave = { dir, impulse, remainingMs: WAVE_WARNING_S * 1000 };
}

function applyWave(): void {
  if (pendingWave === null) return;
  spin += pendingWave.dir * pendingWave.impulse;
  pendingWave = null;
  scheduleNextWave();
}

function stepLumber(side: Side): void {
  if (state === 'ready') {
    startPlaying();
    return;
  }
  if (state === 'gameover') {
    if (fallAnimMs > 0) return; // wait for fall animation to finish.
    reset();
    startPlaying();
    return;
  }
  if (state !== 'playing') return;
  if (stepCooldownMs > 0) return;

  if (side === 'left') {
    balance -= STEP_SIZE;
    spin += STEP_IMPULSE; // log rolls CW under feet that walked CCW.
  } else {
    balance += STEP_SIZE;
    spin -= STEP_IMPULSE;
  }
  stepCooldownMs = STEP_COOLDOWN_MS;
  stepAnimMs = STEP_ANIM_MS;
  stepAnimSide = side;
}

function endGame(): void {
  state = 'gameover';
  fallAnimMs = FALL_ANIM_MS;
  fallStartBalance = balance;
  fallDir = balance > 0 ? 1 : -1;

  const seconds = Math.floor(elapsedMs / 1000);
  if (seconds > best) {
    setBest(seconds);
    safeWrite(STORAGE_BEST, seconds);
  }
  overlayTitle.textContent = 'Suya düştün';
  overlayMsg.textContent =
    `Süre: ${seconds} sn · Rekor: ${best} sn\n` +
    `Tekrar oynamak için Boşluk'a bas ya da bir yöne adım at.`;
  overlayStartBtn.textContent = 'Tekrar oyna';
  // Delay overlay show until fall animation finishes so the splash is visible.
}

function gravityGain(): number {
  return GRAVITY_GAIN_BASE + GRAVITY_RAMP_PER_SEC * (elapsedMs / 1000);
}

function physicsStep(dtMs: number): void {
  const dt = dtMs / 1000;
  setTime(elapsedMs + dtMs);

  // Log surface carries lumberjack (spin moves position).
  balance += spin * dt;

  // Gravity creates torque around log's axis when off-balance.
  spin += gravityGain() * Math.sin(balance) * dt;

  // Friction damps log spin (water drag).
  spin *= Math.exp(-FRICTION_PER_SEC * dt);

  // Integrate log phase for visual rotation (just for marks).
  logPhase += spin * dt;

  // Wave handling.
  if (pendingWave !== null) {
    pendingWave.remainingMs -= dtMs;
    if (pendingWave.remainingMs <= 0) {
      applyWave();
    }
  } else {
    nextWaveS -= dt;
    if (nextWaveS <= 0) startWaveWarning();
  }

  // Cooldown + anim timers.
  if (stepCooldownMs > 0) {
    stepCooldownMs = Math.max(0, stepCooldownMs - dtMs);
  }
  if (stepAnimMs > 0) {
    stepAnimMs = Math.max(0, stepAnimMs - dtMs);
    if (stepAnimMs === 0) stepAnimSide = null;
  }

  if (Math.abs(balance) > FALL_THRESHOLD) {
    endGame();
  }
}

function fallStep(dtMs: number): void {
  if (fallAnimMs <= 0) return;
  fallAnimMs = Math.max(0, fallAnimMs - dtMs);
  if (fallAnimMs === 0) {
    showOverlayEl(overlay);
  }
}

// ----- Drawing ----------------------------------------------------------

function drawSky(): void {
  const sky = ctx.createLinearGradient(0, 0, 0, WATER_Y);
  sky.addColorStop(0, '#0f172a');
  sky.addColorStop(0.55, '#1e3a5f');
  sky.addColorStop(1, '#2d4d6e');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, WATER_Y);

  // Distant moon / sun (subtle).
  ctx.save();
  ctx.globalAlpha = 0.18;
  ctx.fillStyle = '#fef3c7';
  ctx.beginPath();
  ctx.arc(86, 90, 28, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawWater(): void {
  const water = ctx.createLinearGradient(0, WATER_Y, 0, H);
  water.addColorStop(0, '#0b2e4c');
  water.addColorStop(1, '#06192c');
  ctx.fillStyle = water;
  ctx.fillRect(0, WATER_Y, W, H - WATER_Y);

  // Wavy lines.
  ctx.save();
  ctx.strokeStyle = 'rgba(148, 197, 230, 0.22)';
  ctx.lineWidth = 1.5;
  for (let row = 0; row < 5; row++) {
    const y = WATER_Y + 14 + row * 18;
    ctx.beginPath();
    for (let x = 0; x <= W; x += 8) {
      const yy =
        y +
        Math.sin((x + waterPhase * (40 + row * 8)) * 0.05 + row) *
          (1.2 + row * 0.4);
      if (x === 0) ctx.moveTo(x, yy);
      else ctx.lineTo(x, yy);
    }
    ctx.stroke();
  }
  ctx.restore();

  // Reflection of log (soft ellipse under it).
  ctx.save();
  ctx.fillStyle = 'rgba(15, 32, 50, 0.55)';
  ctx.beginPath();
  ctx.ellipse(LOG_CX, WATER_Y + 8, LOG_R + 18, 7, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawWaveWarning(): void {
  if (pendingWave === null) return;
  const t = 1 - pendingWave.remainingMs / (WAVE_WARNING_S * 1000);
  const intensity = 0.4 + 0.6 * t;
  ctx.save();
  ctx.fillStyle = `rgba(248, 113, 113, ${0.25 + 0.35 * intensity})`;
  // A swelling crest on the side the wave comes from.
  const side = pendingWave.dir === 1 ? 'left' : 'right';
  // Wave hits log from one side → impulse direction is dir. If dir=+1, log
  // spins CW after impulse, which the player must counter by stepping LEFT.
  // The swell visually appears on the side the wave originates from, which is
  // OPPOSITE of dir (a wave from the left side pushes the log clockwise).
  const baseX = side === 'left' ? 0 : W;
  const peakX = side === 'left' ? 40 + 50 * t : W - 40 - 50 * t;
  ctx.beginPath();
  ctx.moveTo(baseX, WATER_Y - 4);
  ctx.quadraticCurveTo(
    (baseX + peakX) / 2,
    WATER_Y - 28 - 10 * intensity,
    peakX,
    WATER_Y - 4,
  );
  ctx.lineTo(peakX, H);
  ctx.lineTo(baseX, H);
  ctx.closePath();
  ctx.fill();

  // Arrow indicating push direction.
  ctx.strokeStyle = `rgba(254, 226, 226, ${0.6 + 0.4 * t})`;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  const aY = WATER_Y - 30;
  const startX = side === 'left' ? 14 : W - 14;
  const endX = side === 'left' ? 60 : W - 60;
  ctx.beginPath();
  ctx.moveTo(startX, aY);
  ctx.lineTo(endX, aY);
  ctx.stroke();
  // Arrowhead.
  const headLen = 10;
  const headDir = endX > startX ? 1 : -1;
  ctx.beginPath();
  ctx.moveTo(endX, aY);
  ctx.lineTo(endX - headDir * headLen, aY - 6);
  ctx.moveTo(endX, aY);
  ctx.lineTo(endX - headDir * headLen, aY + 6);
  ctx.stroke();
  ctx.restore();
}

function drawLog(submerged: number): void {
  // Log cross-section: circle with annual rings + bark.
  ctx.save();
  ctx.translate(LOG_CX, LOG_CY);
  ctx.rotate(logPhase);

  // Bark/outer ring.
  const grad = ctx.createRadialGradient(-20, -22, 6, 0, 0, LOG_R);
  grad.addColorStop(0, '#d6a96b');
  grad.addColorStop(0.7, '#9a6a36');
  grad.addColorStop(1, '#5a3a1a');
  ctx.beginPath();
  ctx.arc(0, 0, LOG_R, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#3e2812';
  ctx.stroke();

  // Annual rings.
  ctx.strokeStyle = 'rgba(64, 38, 18, 0.55)';
  ctx.lineWidth = 1;
  for (let r = 14; r < LOG_R - 6; r += 11) {
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  // One bold mark so spin reads instantly.
  ctx.beginPath();
  ctx.arc(0, 0, LOG_R - 4, -0.18, 0.18);
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#3e2812';
  ctx.stroke();

  // Knot at center (the heartwood).
  ctx.beginPath();
  ctx.arc(0, 0, 8, 0, Math.PI * 2);
  ctx.fillStyle = '#6b3f1a';
  ctx.fill();

  ctx.restore();

  // Slight submersion overlay (water clips bottom of log).
  ctx.save();
  ctx.fillStyle = 'rgba(7, 26, 44, 0.55)';
  ctx.beginPath();
  ctx.rect(0, WATER_Y, W, H - WATER_Y);
  ctx.clip();
  ctx.beginPath();
  ctx.arc(LOG_CX, LOG_CY, LOG_R, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Highlight at the top of the log to mark the "balance crown".
  if (state === 'playing' || state === 'ready') {
    const mag = Math.min(1, Math.abs(balance) / FALL_THRESHOLD);
    const crownColor =
      mag < 0.4
        ? 'rgba(110, 231, 183, 0.55)'
        : mag < 0.75
          ? 'rgba(251, 191, 36, 0.65)'
          : 'rgba(248, 113, 113, 0.75)';
    ctx.save();
    ctx.translate(LOG_CX, LOG_CY);
    ctx.beginPath();
    ctx.arc(0, -LOG_R, 14 - mag * 4, 0, Math.PI * 2);
    ctx.fillStyle = crownColor;
    ctx.fill();
    ctx.restore();
  }
  void submerged;
}

function lumberPosition(): { x: number; y: number; angle: number } {
  // Lumberjack's feet sit on the log circle at the angle `balance` from top.
  const a = balance;
  const fx = LOG_CX + Math.sin(a) * LOG_R;
  const fy = LOG_CY - Math.cos(a) * LOG_R;
  return { x: fx, y: fy, angle: a };
}

function drawLumber(): void {
  const accent = getCss('--tm-accent', '#dc2626');
  const denim = getCss('--tm-denim', '#1e3a8a');
  const skin = '#e6c5a3';
  const beard = '#3b2418';
  const boot = '#2b1b0c';

  let bodyAngle: number;
  let fx: number;
  let fy: number;

  if (fallAnimMs > 0) {
    // Falling: continue rotating with last-known direction, drop into water.
    const t = 1 - fallAnimMs / FALL_ANIM_MS;
    const a = fallStartBalance + fallDir * (Math.PI * 0.6) * t;
    // Slide along an arc that drops below water line.
    fx = LOG_CX + Math.sin(a) * LOG_R + fallDir * 30 * t;
    fy = LOG_CY - Math.cos(a) * LOG_R + 120 * t * t;
    bodyAngle = a + fallDir * 1.4 * t;
  } else {
    const pos = lumberPosition();
    fx = pos.x;
    fy = pos.y;
    bodyAngle = pos.angle;
  }

  ctx.save();
  ctx.translate(fx, fy);
  ctx.rotate(bodyAngle);

  // Step animation: small offset to one leg.
  const stepT = stepAnimMs / STEP_ANIM_MS;
  const lift = stepAnimSide === null ? 0 : Math.sin(stepT * Math.PI) * 4;
  const leftLift = stepAnimSide === 'left' ? lift : 0;
  const rightLift = stepAnimSide === 'right' ? lift : 0;

  // Boots (planted on log surface).
  ctx.fillStyle = boot;
  ctx.fillRect(-12, -8 - leftLift, 9, 8);
  ctx.fillRect(3, -8 - rightLift, 9, 8);

  // Legs (denim).
  ctx.fillStyle = denim;
  ctx.fillRect(-11, -28 - leftLift, 7, 22);
  ctx.fillRect(4, -28 - rightLift, 7, 22);

  // Belt.
  ctx.fillStyle = '#3a2410';
  ctx.fillRect(-13, -30, 26, 4);

  // Torso (red flannel shirt).
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.moveTo(-14, -30);
  ctx.lineTo(14, -30);
  ctx.lineTo(13, -58);
  ctx.lineTo(-13, -58);
  ctx.closePath();
  ctx.fill();

  // Flannel pattern (cross-hatch).
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.25)';
  ctx.lineWidth = 1;
  for (let yy = -54; yy < -30; yy += 5) {
    ctx.beginPath();
    ctx.moveTo(-14, yy);
    ctx.lineTo(14, yy);
    ctx.stroke();
  }
  for (let xx = -12; xx < 14; xx += 6) {
    ctx.beginPath();
    ctx.moveTo(xx, -58);
    ctx.lineTo(xx, -30);
    ctx.stroke();
  }

  // Arms — outstretched for balance, tilt slightly toward the side opposite
  // to the balance angle so it reads as "counter-leaning".
  const armSwing = Math.max(-0.6, Math.min(0.6, -bodyAngle * 0.8));
  ctx.save();
  ctx.translate(0, -52);
  ctx.fillStyle = accent;
  ctx.rotate(armSwing);
  ctx.fillRect(-26, -3, 18, 6);
  ctx.fillRect(8, -3, 18, 6);
  // Hands.
  ctx.fillStyle = skin;
  ctx.beginPath();
  ctx.arc(-28, 0, 4, 0, Math.PI * 2);
  ctx.arc(28, 0, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Neck.
  ctx.fillStyle = skin;
  ctx.fillRect(-4, -64, 8, 6);

  // Head.
  ctx.beginPath();
  ctx.arc(0, -70, 8, 0, Math.PI * 2);
  ctx.fill();

  // Beard.
  ctx.fillStyle = beard;
  ctx.beginPath();
  ctx.arc(0, -67, 7, 0.3, Math.PI - 0.3);
  ctx.fill();

  // Knit cap.
  ctx.fillStyle = '#0f766e';
  ctx.beginPath();
  ctx.moveTo(-8, -71);
  ctx.lineTo(8, -71);
  ctx.lineTo(7, -80);
  ctx.lineTo(-7, -80);
  ctx.closePath();
  ctx.fill();
  // Pom-pom.
  ctx.beginPath();
  ctx.arc(0, -82, 3, 0, Math.PI * 2);
  ctx.fillStyle = '#fef3c7';
  ctx.fill();

  ctx.restore();
}

function drawSplash(): void {
  if (fallAnimMs <= 0) return;
  const t = 1 - fallAnimMs / FALL_ANIM_MS;
  if (t < 0.4) return;
  const pt = (t - 0.4) / 0.6;
  ctx.save();
  ctx.globalAlpha = 1 - pt;
  ctx.fillStyle = 'rgba(220, 240, 255, 0.85)';
  const cx = LOG_CX + fallDir * (40 + 60 * pt);
  const cy = WATER_Y + 10;
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2;
    const r = 4 + Math.random() * 3;
    ctx.beginPath();
    ctx.arc(
      cx + Math.cos(a) * (16 + pt * 28),
      cy + Math.sin(a) * (4 + pt * 6),
      r,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }
  ctx.restore();
}

function drawBalanceBar(): void {
  // Bottom strip showing |balance| / threshold.
  const barX = 40;
  const barY = H - 18;
  const barW = W - 80;
  const barH = 8;
  ctx.save();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.fillRect(barX, barY, barW, barH);

  // Center marker.
  const cx = barX + barW / 2;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
  ctx.fillRect(cx - 1, barY - 3, 2, barH + 6);

  // Bar fill from center based on signed balance.
  const half = barW / 2;
  const frac = Math.max(-1, Math.min(1, balance / FALL_THRESHOLD));
  const fillW = Math.abs(frac) * half;
  const startX = frac >= 0 ? cx : cx - fillW;
  const abs = Math.abs(frac);
  const fillColor =
    abs < 0.4 ? '#34d399' : abs < 0.75 ? '#fbbf24' : '#f87171';
  ctx.fillStyle = fillColor;
  ctx.fillRect(startX, barY, fillW, barH);

  // Tick marks at danger zones.
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx - half * 0.75, barY - 2);
  ctx.lineTo(cx - half * 0.75, barY + barH + 2);
  ctx.moveTo(cx + half * 0.75, barY - 2);
  ctx.lineTo(cx + half * 0.75, barY + barH + 2);
  ctx.stroke();

  // Label.
  ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
  ctx.font = '600 9px Inter, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('DENGE', cx, barY - 6);

  ctx.restore();
}

function drawCooldownHint(): void {
  if (state !== 'playing') return;
  if (stepCooldownMs <= 0) return;
  ctx.save();
  const frac = stepCooldownMs / STEP_COOLDOWN_MS;
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.5)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(28, 28, 10, -Math.PI / 2, -Math.PI / 2 + (1 - frac) * Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function draw(): void {
  drawSky();
  drawWater();
  drawWaveWarning();
  drawLog(0);
  drawLumber();
  drawSplash();
  drawBalanceBar();
  drawCooldownHint();
}

function tick(now: number): void {
  const dtMs = lastFrameMs === 0 ? 16 : Math.min(50, now - lastFrameMs);
  lastFrameMs = now;
  waterPhase += dtMs * 0.001;

  if (state === 'playing') {
    physicsStep(dtMs);
  } else if (state === 'gameover') {
    fallStep(dtMs);
  } else if (state === 'ready') {
    // Subtle idle bob — log gently rocks but does not unbalance the lumber.
    waterPhase += 0; // already advanced above.
  }

  draw();
  rafId = requestAnimationFrame(tick);
}

function startPlaying(): void {
  state = 'playing';
  hideOverlayEl(overlay);
  elapsedMs = 0;
  setTime(0);
  balance = 0;
  spin = 0;
  logPhase = 0;
  stepCooldownMs = 0;
  stepAnimMs = 0;
  stepAnimSide = null;
  pendingWave = null;
  fallAnimMs = 0;
  scheduleNextWave();
}

function reset(): void {
  state = 'ready';
  elapsedMs = 0;
  setTime(0);
  balance = 0;
  spin = 0;
  logPhase = 0;
  stepCooldownMs = 0;
  stepAnimMs = 0;
  stepAnimSide = null;
  pendingWave = null;
  fallAnimMs = 0;
  scheduleNextWave();
  overlayTitle.textContent = 'Tomruk';
  overlayMsg.textContent =
    'Su üstünde dönen kütüğün üzerinde ayakta kal. Sol/Sağ ok ile adım at — ' +
    'tomruk altından kayar, dalga gelir, dengeyi bul.\n' +
    'Başlamak için Boşluk\'a bas ya da bir yöne adım at.';
  overlayStartBtn.textContent = 'Başla';
  showOverlayEl(overlay);
  draw();
}

function onKey(e: KeyboardEvent): void {
  if (e.repeat) return;
  const k = e.key;
  if (k === 'ArrowLeft' || k === 'a' || k === 'A') {
    stepLumber('left');
    e.preventDefault();
    return;
  }
  if (k === 'ArrowRight' || k === 'd' || k === 'D') {
    stepLumber('right');
    e.preventDefault();
    return;
  }
  if (k === ' ' || k === 'Enter') {
    if (state === 'ready') {
      startPlaying();
    } else if (state === 'gameover' && fallAnimMs === 0) {
      reset();
      startPlaying();
    }
    e.preventDefault();
    return;
  }
  if (k === 'r' || k === 'R') {
    reset();
    e.preventDefault();
  }
}

function pickSideFromCanvas(e: PointerEvent): Side {
  const rect = canvas.getBoundingClientRect();
  const px = (e.clientX - rect.left) * (canvas.width / rect.width);
  return px < W / 2 ? 'left' : 'right';
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  timeEl = document.querySelector<HTMLElement>('#time')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayStartBtn =
    document.querySelector<HTMLButtonElement>('#overlay-start')!;

  best = safeRead<number>(STORAGE_BEST, 0);
  setBest(best);

  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (state === 'ready') {
      startPlaying();
      return;
    }
    if (state === 'gameover') {
      if (fallAnimMs > 0) return;
      reset();
      startPlaying();
      return;
    }
    stepLumber(pickSideFromCanvas(e));
  });

  overlay.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (state === 'ready') {
      startPlaying();
    } else if (state === 'gameover' && fallAnimMs === 0) {
      reset();
      startPlaying();
    }
  });
  overlayStartBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (state === 'ready') {
      startPlaying();
    } else if (state === 'gameover' && fallAnimMs === 0) {
      reset();
      startPlaying();
    }
  });

  restartBtn.addEventListener('click', () => {
    reset();
  });

  window.addEventListener('keydown', onKey);

  reset();
  if (rafId !== 0) cancelAnimationFrame(rafId);
  lastFrameMs = 0;
  rafId = requestAnimationFrame(tick);
}

export const game = defineGame({ init, reset });
