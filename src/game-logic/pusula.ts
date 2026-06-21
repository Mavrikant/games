import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';
import { reportGameOver } from '@shared/leaderboard';

// PITFALLS guarded:
// - unguarded-storage: safeRead/safeWrite wrap localStorage.
// - stale-async-callback: gen.bump() cancels animation loop after reset.
// - overlay-input-leak: explicit state enum; input handlers guard on it.
// - module-level side effects: all DOM access lives in init().
// - missing-overlay-css: CSS in pusula.css defines .overlay/.overlay--hidden.
// - deadzone-blocks-keyboard-steering: discrete key input applies a fixed
//   torque impulse; no piksel-vs-unit eşik confusion.

const STORAGE_BEST = 'pusula.best';
const SCORE_DESC = {
  gameId: 'pusula',
  storageKey: STORAGE_BEST,
  direction: 'higher' as const,
};

const ROUND_MS = 60_000;
const TARGET_ROTATE_MS = 15_000;
const TARGET_TRANSITION_MS = 1500;
// Per-needle constants
const SPRING = 0.4;          // weak restoring force toward nominal centre (not target)
const DAMPING = 0.92;        // angular velocity decay each frame (per 16ms)
const TORQUE_TAP = 0.06;     // impulse per key event
const TORQUE_HOLD = 0.0035;  // continuous torque per ms while key held
const BASE_NOISE_INTERVAL_MS = 1400;
const BASE_NOISE_STRENGTH = 0.10;
const NOISE_RAMP = 0.0009;   // noise strength growth per second
const BASE_TOLERANCE_DEG = 22;
const TOLERANCE_FLOOR_DEG = 12;

type State = 'ready' | 'playing' | 'gameover';

interface Needle {
  color: 'red' | 'blue';
  angle: number;          // radians, 0 = up (north)
  vel: number;            // radians per frame-step (16ms)
  target: number;         // radians
  targetFrom: number;     // for smooth transition
  targetTo: number;
  targetT: number;        // 0..1 transition progress
  inTol: boolean;
  inputDir: 0 | -1 | 1;   // currently held direction
}

const gen = createGenToken();
let state: State = 'ready';
let score = 0;
let best = 0;
let elapsed = 0;        // ms since round start
let lastFrame = 0;      // performance.now of previous frame
let nextNoiseAt = 0;    // ms of elapsed when next noise pulse arrives
let lastTargetRotate = 0;
let syncStreakMs = 0;   // current "both in tolerance" streak

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let timeEl!: HTMLElement;
let devRedEl!: HTMLElement;
let devBlueEl!: HTMLElement;
let syncEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;

const red: Needle = {
  color: 'red',
  angle: 0, vel: 0,
  target: 0, targetFrom: 0, targetTo: 0, targetT: 1,
  inTol: false, inputDir: 0,
};
const blue: Needle = {
  color: 'blue',
  angle: Math.PI / 2, vel: 0,
  target: Math.PI / 2, targetFrom: Math.PI / 2, targetTo: Math.PI / 2, targetT: 1,
  inTol: false, inputDir: 0,
};

// --- helpers ---
function normalize(a: number): number {
  // wrap to (-PI, PI]
  let x = a;
  while (x <= -Math.PI) x += 2 * Math.PI;
  while (x > Math.PI) x -= 2 * Math.PI;
  return x;
}

function deltaAngle(from: number, to: number): number {
  return normalize(to - from);
}

function pickNewTarget(current: number): number {
  // Pick a new target at least 45° and at most 150° away from current.
  const minDelta = Math.PI / 4;
  const maxDelta = (5 * Math.PI) / 6;
  const sign = Math.random() < 0.5 ? -1 : 1;
  const mag = minDelta + Math.random() * (maxDelta - minDelta);
  return normalize(current + sign * mag);
}

function currentTarget(n: Needle): number {
  if (n.targetT >= 1) return n.targetTo;
  // Smooth (ease-in-out) interpolation between targetFrom and targetTo.
  const t = n.targetT;
  const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  return normalize(n.targetFrom + deltaAngle(n.targetFrom, n.targetTo) * e);
}

function currentToleranceDeg(): number {
  const p = Math.min(1, elapsed / ROUND_MS);
  return BASE_TOLERANCE_DEG - (BASE_TOLERANCE_DEG - TOLERANCE_FLOOR_DEG) * p;
}

function getCss(varName: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(varName)
    .trim();
  return v || fallback;
}

// --- input ---
function applyTapImpulse(n: Needle, dir: -1 | 1): void {
  n.vel += TORQUE_TAP * dir;
}

function setHold(n: Needle, dir: -1 | 0 | 1): void {
  n.inputDir = dir;
}

function startIfReady(): void {
  if (state === 'ready') {
    state = 'playing';
    hideOverlayEl(overlay);
    elapsed = 0;
    score = 0;
    syncStreakMs = 0;
    scoreEl.textContent = '0';
    timeEl.textContent = String(Math.ceil(ROUND_MS / 1000));
    nextNoiseAt = 600 + Math.random() * 800;
    lastTargetRotate = 0;
    lastFrame = performance.now();
  }
}

function onKeyDown(e: KeyboardEvent): void {
  const k = e.key.toLowerCase();
  if (k === 'r') {
    reset();
    e.preventDefault();
    return;
  }
  // Allow key handling in ready/playing only — ignore in gameover except R.
  if (state === 'gameover') return;

  let handled = true;
  if (k === 'arrowleft' || k === 'a') {
    startIfReady();
    if (state === 'playing') {
      if (red.inputDir !== -1) applyTapImpulse(red, -1);
      setHold(red, -1);
    }
  } else if (k === 'arrowright' || k === 'd') {
    startIfReady();
    if (state === 'playing') {
      if (red.inputDir !== 1) applyTapImpulse(red, 1);
      setHold(red, 1);
    }
  } else if (k === 'arrowup' || k === 'w') {
    startIfReady();
    if (state === 'playing') {
      if (blue.inputDir !== -1) applyTapImpulse(blue, -1);
      setHold(blue, -1);
    }
  } else if (k === 'arrowdown' || k === 's') {
    startIfReady();
    if (state === 'playing') {
      if (blue.inputDir !== 1) applyTapImpulse(blue, 1);
      setHold(blue, 1);
    }
  } else {
    handled = false;
  }
  if (handled) e.preventDefault();
}

function onKeyUp(e: KeyboardEvent): void {
  const k = e.key.toLowerCase();
  if (k === 'arrowleft' || k === 'a') {
    if (red.inputDir === -1) setHold(red, 0);
  } else if (k === 'arrowright' || k === 'd') {
    if (red.inputDir === 1) setHold(red, 0);
  } else if (k === 'arrowup' || k === 'w') {
    if (blue.inputDir === -1) setHold(blue, 0);
  } else if (k === 'arrowdown' || k === 's') {
    if (blue.inputDir === 1) setHold(blue, 0);
  }
}

function bindTouch(): void {
  document.querySelectorAll<HTMLButtonElement>('.touch__btn').forEach((btn) => {
    const act = btn.dataset.act;
    let needle: Needle | null = null;
    let dir: -1 | 1 = -1;
    if (act === 'red-left') { needle = red; dir = -1; }
    else if (act === 'red-right') { needle = red; dir = 1; }
    else if (act === 'blue-left') { needle = blue; dir = -1; }
    else if (act === 'blue-right') { needle = blue; dir = 1; }
    if (!needle) return;
    const n = needle;

    const press = (e: Event) => {
      e.preventDefault();
      if (state === 'gameover') return;
      startIfReady();
      if (state !== 'playing') return;
      if (n.inputDir !== dir) applyTapImpulse(n, dir);
      setHold(n, dir);
    };
    const release = (e: Event) => {
      e.preventDefault();
      if (n.inputDir === dir) setHold(n, 0);
    };
    btn.addEventListener('pointerdown', press);
    btn.addEventListener('pointerup', release);
    btn.addEventListener('pointercancel', release);
    btn.addEventListener('pointerleave', release);
  });
}

// --- simulation ---
function applyNoise(): void {
  // Strength grows with elapsed time.
  const seconds = elapsed / 1000;
  const strength = BASE_NOISE_STRENGTH + seconds * NOISE_RAMP;
  // Half the pulses hit only one needle; the other half hit both with
  // opposite signs (rotating field).
  if (Math.random() < 0.5) {
    const target = Math.random() < 0.5 ? red : blue;
    target.vel += (Math.random() < 0.5 ? -1 : 1) * (strength + Math.random() * strength * 0.6);
  } else {
    const sign = Math.random() < 0.5 ? -1 : 1;
    red.vel += sign * (strength + Math.random() * strength * 0.5);
    blue.vel -= sign * (strength + Math.random() * strength * 0.5);
  }
}

function stepNeedle(n: Needle, dtMs: number): void {
  const dtSteps = dtMs / 16; // normalize to ~60Hz frame steps
  // Hold torque (small, continuous)
  if (n.inputDir !== 0) {
    n.vel += n.inputDir * TORQUE_HOLD * dtMs;
  }
  // Weak spring toward current target (so totally unattended needle slowly
  // homes — but slow enough that player still must engage).
  const tgt = currentTarget(n);
  const restoring = deltaAngle(n.angle, tgt) * SPRING * 0.01 * dtSteps;
  n.vel += restoring;
  // Damping
  n.vel *= Math.pow(DAMPING, dtSteps);
  // Cap velocity to avoid runaway spin
  const maxVel = 0.25;
  if (n.vel > maxVel) n.vel = maxVel;
  if (n.vel < -maxVel) n.vel = -maxVel;
  // Integrate
  n.angle = normalize(n.angle + n.vel * dtSteps);
  // Advance target transition
  if (n.targetT < 1) {
    n.targetT = Math.min(1, n.targetT + dtMs / TARGET_TRANSITION_MS);
  }
}

function checkTolerance(n: Needle, tolDeg: number): boolean {
  const tgt = currentTarget(n);
  const diff = Math.abs(deltaAngle(n.angle, tgt));
  return diff <= (tolDeg * Math.PI) / 180;
}

function commitBest(): void {
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
    bestEl.textContent = String(best);
  }
}

function endRound(): void {
  if (state === 'gameover') return;
  state = 'gameover';
  // Clear holds
  setHold(red, 0);
  setHold(blue, 0);
  commitBest();
  reportGameOver(SCORE_DESC, score);
  overlayTitle.textContent = 'Süre doldu';
  overlayMsg.textContent = `Puan: ${score}  ·  Rekor: ${best}  ·  R: yeniden başla`;
  showOverlayEl(overlay);
  draw(); // final paint
}

function reset(): void {
  gen.bump();
  state = 'ready';
  score = 0;
  elapsed = 0;
  syncStreakMs = 0;
  red.angle = 0; red.vel = 0;
  red.targetFrom = red.targetTo = red.target = 0; red.targetT = 1;
  blue.angle = Math.PI / 2; blue.vel = 0;
  blue.targetFrom = blue.targetTo = blue.target = Math.PI / 2; blue.targetT = 1;
  setHold(red, 0);
  setHold(blue, 0);
  scoreEl.textContent = '0';
  bestEl.textContent = String(best);
  timeEl.textContent = String(Math.ceil(ROUND_MS / 1000));
  devRedEl.textContent = '0°';
  devBlueEl.textContent = '0°';
  syncEl.textContent = '0.0sn';
  overlayTitle.textContent = 'Pusula';
  overlayMsg.textContent =
    'Kırmızı iğneyi ← → ile, mavi iğneyi ↑ ↓ ile kendi hedef dilimleri içinde tut. Başlamak için herhangi bir ok tuşuna bas.';
  showOverlayEl(overlay);
  draw();
  // Start animation loop with fresh gen token.
  const myGen = gen.current();
  const tick = (now: number) => {
    if (!gen.isCurrent(myGen)) return;
    if (lastFrame === 0) lastFrame = now;
    const dt = Math.min(64, now - lastFrame); // clamp to avoid huge steps after tab-switch
    lastFrame = now;
    update(dt);
    draw();
    requestAnimationFrame(tick);
  };
  lastFrame = 0;
  requestAnimationFrame(tick);
}

function update(dtMs: number): void {
  if (state !== 'playing') {
    // Even while ready: gentle drift visualization (no noise pulses).
    stepNeedle(red, dtMs);
    stepNeedle(blue, dtMs);
    return;
  }
  elapsed += dtMs;
  if (elapsed >= ROUND_MS) {
    elapsed = ROUND_MS;
    timeEl.textContent = '0';
    endRound();
    return;
  }
  timeEl.textContent = String(Math.max(0, Math.ceil((ROUND_MS - elapsed) / 1000)));

  // Periodic target rotation (after first 5s, every TARGET_ROTATE_MS).
  if (elapsed > 5000 && elapsed - lastTargetRotate >= TARGET_ROTATE_MS) {
    lastTargetRotate = elapsed;
    // Rotate one or both targets to keep player busy.
    if (Math.random() < 0.7) {
      red.targetFrom = currentTarget(red);
      red.targetTo = pickNewTarget(red.targetFrom);
      red.targetT = 0;
    }
    if (Math.random() < 0.7) {
      blue.targetFrom = currentTarget(blue);
      blue.targetTo = pickNewTarget(blue.targetFrom);
      blue.targetT = 0;
    }
  }

  // Noise pulses
  while (elapsed >= nextNoiseAt) {
    applyNoise();
    const seconds = elapsed / 1000;
    // Pulses arrive more frequently as time passes.
    const minInterval = Math.max(450, BASE_NOISE_INTERVAL_MS - seconds * 18);
    nextNoiseAt += minInterval + Math.random() * minInterval * 0.6;
  }

  stepNeedle(red, dtMs);
  stepNeedle(blue, dtMs);

  const tol = currentToleranceDeg();
  red.inTol = checkTolerance(red, tol);
  blue.inTol = checkTolerance(blue, tol);

  // Scoring: +1 per needle in tolerance per ~16ms of real time, ×2 if both.
  // Use dtMs/16 so score accumulates at ~60/sec per needle, ~120/sec if both.
  const ticks = dtMs / 16;
  let gained = 0;
  if (red.inTol) gained += ticks;
  if (blue.inTol) gained += ticks;
  if (red.inTol && blue.inTol) {
    gained += ticks; // synchrony bonus
    syncStreakMs += dtMs;
  } else {
    syncStreakMs = 0;
  }
  score += Math.round(gained);
  scoreEl.textContent = String(score);

  // Live deviation readouts
  const redDev = Math.round(
    (Math.abs(deltaAngle(red.angle, currentTarget(red))) * 180) / Math.PI,
  );
  const blueDev = Math.round(
    (Math.abs(deltaAngle(blue.angle, currentTarget(blue))) * 180) / Math.PI,
  );
  devRedEl.textContent = `${redDev}°`;
  devBlueEl.textContent = `${blueDev}°`;
  syncEl.textContent = `${(syncStreakMs / 1000).toFixed(1)}sn`;
}

// --- drawing ---
function draw(): void {
  const w = canvas.width;
  const h = canvas.height;
  const cx = w / 2;
  const cy = h / 2;
  const radius = Math.min(w, h) * 0.42;

  ctx.fillStyle = getCss('--surface', '#101218');
  ctx.fillRect(0, 0, w, h);

  // Outer ring
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fillStyle = '#0c0e14';
  ctx.fill();
  ctx.strokeStyle = getCss('--border', '#2a2f3a');
  ctx.lineWidth = 2;
  ctx.stroke();

  // Tick marks every 30°, longer every 90°
  ctx.save();
  ctx.translate(cx, cy);
  ctx.strokeStyle = getCss('--text-dim', '#8a93a4');
  for (let i = 0; i < 12; i++) {
    const ang = (i * Math.PI) / 6 - Math.PI / 2; // 0 deg ⇒ top
    const major = i % 3 === 0;
    const inner = radius * (major ? 0.86 : 0.92);
    const outer = radius * 0.99;
    ctx.lineWidth = major ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo(Math.cos(ang) * inner, Math.sin(ang) * inner);
    ctx.lineTo(Math.cos(ang) * outer, Math.sin(ang) * outer);
    ctx.stroke();
  }
  ctx.restore();

  // Cardinal labels
  ctx.save();
  ctx.fillStyle = getCss('--text', '#dfe5f2');
  ctx.font = '14px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const labelR = radius * 0.78;
  ctx.fillText('N', cx, cy - labelR);
  ctx.fillText('E', cx + labelR, cy);
  ctx.fillText('S', cx, cy + labelR);
  ctx.fillText('W', cx - labelR, cy);
  ctx.restore();

  // Target arcs (current target + tolerance band)
  const tolRad = (currentToleranceDeg() * Math.PI) / 180;
  drawTargetArc(cx, cy, radius * 0.94, currentTarget(red), tolRad, '#ef4444', red.inTol);
  drawTargetArc(cx, cy, radius * 0.84, currentTarget(blue), tolRad, '#3b82f6', blue.inTol);

  // Hub
  ctx.beginPath();
  ctx.arc(cx, cy, 12, 0, Math.PI * 2);
  ctx.fillStyle = '#161a23';
  ctx.fill();
  ctx.strokeStyle = '#2a2f3a';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Needles (blue behind, red on top)
  drawNeedle(cx, cy, radius * 0.78, blue.angle, '#3b82f6', '#1e3a8a', false);
  drawNeedle(cx, cy, radius * 0.92, red.angle, '#ef4444', '#7f1d1d', true);

  // Centre cap
  ctx.beginPath();
  ctx.arc(cx, cy, 5, 0, Math.PI * 2);
  ctx.fillStyle = '#dfe5f2';
  ctx.fill();
}

function drawTargetArc(
  cx: number,
  cy: number,
  r: number,
  centreAngle: number,
  halfWidth: number,
  color: string,
  active: boolean,
): void {
  // Game angle: 0 = up (N). Canvas arc 0 = right (E). Convert.
  const canvasMid = centreAngle - Math.PI / 2;
  const start = canvasMid - halfWidth;
  const end = canvasMid + halfWidth;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, start, end);
  ctx.lineWidth = 14;
  ctx.strokeStyle = active ? color : `${color}88`;
  ctx.lineCap = 'butt';
  ctx.stroke();
  // Tick at exact target
  ctx.beginPath();
  const tx = cx + Math.cos(canvasMid) * (r + 9);
  const ty = cy + Math.sin(canvasMid) * (r + 9);
  const tx2 = cx + Math.cos(canvasMid) * (r - 9);
  const ty2 = cy + Math.sin(canvasMid) * (r - 9);
  ctx.moveTo(tx, ty);
  ctx.lineTo(tx2, ty2);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
}

function drawNeedle(
  cx: number,
  cy: number,
  length: number,
  angle: number,
  color: string,
  tailColor: string,
  isPrimary: boolean,
): void {
  const canvasAng = angle - Math.PI / 2;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(canvasAng);
  const w = isPrimary ? 8 : 6;
  // Tail
  ctx.beginPath();
  ctx.moveTo(-length * 0.45, 0);
  ctx.lineTo(0, -w / 2);
  ctx.lineTo(0, w / 2);
  ctx.closePath();
  ctx.fillStyle = tailColor;
  ctx.fill();
  // Head
  ctx.beginPath();
  ctx.moveTo(length, 0);
  ctx.lineTo(0, -w / 2);
  ctx.lineTo(0, w / 2);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  // Outline
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(0,0,0,0.4)';
  ctx.beginPath();
  ctx.moveTo(-length * 0.45, 0);
  ctx.lineTo(length, 0);
  ctx.stroke();
  ctx.restore();
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  timeEl = document.querySelector<HTMLElement>('#time')!;
  devRedEl = document.querySelector<HTMLElement>('#dev-red')!;
  devBlueEl = document.querySelector<HTMLElement>('#dev-blue')!;
  syncEl = document.querySelector<HTMLElement>('#sync')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;

  best = safeRead<number>(STORAGE_BEST, 0);
  bestEl.textContent = String(best);
  timeEl.textContent = String(Math.ceil(ROUND_MS / 1000));

  restartBtn.addEventListener('click', reset);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  // Release any held input if window loses focus (e.g., tab switch).
  window.addEventListener('blur', () => {
    setHold(red, 0);
    setHold(blue, 0);
  });

  bindTouch();
  reset();
}

export const game = defineGame({ init, reset });
