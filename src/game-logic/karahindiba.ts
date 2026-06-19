import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import {
  showOverlay as showOverlayEl,
  hideOverlay as hideOverlayEl,
} from '@shared/overlay';

// Karahindiba: charge-and-release dandelion puff. Read the live wind arrow,
// tilt the stem to angle the cone, release at the right moment so the
// seeds drift onto the colored flower beds.
//
// PITFALLS guarded here:
// - unguarded-storage: safeRead/safeWrite wrap localStorage in try/catch.
// - stale-async-callback: gen.bump() in reset()/finishRound() invalidates
//   any in-flight RAF chain.
// - overlay-input-leak: every input handler guards on `state`.
// - visual-vs-hitbox: BED_RADIUS is the single source of truth for both
//   the bed sprite and the landing test.
// - hud-counter-synced-only-at-lifecycle-edges: updateHud() runs every
//   frame so score & timer DOM stay in sync.
// - deadzone-blocks-keyboard-steering: tilt uses pure key-held flags
//   (no shared piksel/birim threshold).

const STORAGE_BEST = 'karahindiba.best';

const CANVAS_W = 480;
const CANVAS_H = 600;

// Dandelion stem + flower position (screen coords).
const STEM_BASE_X = CANVAS_W / 2;
const STEM_BASE_Y = CANVAS_H - 28;
const STEM_LEN = 70;            // visual + emission origin distance.

// Stem tilt (radians). Negative = leans left, positive = leans right.
const TILT_MAX = 0.55;          // ~31°, enough to redirect a puff.
const TILT_SPEED = 1.4;         // rad / sec while a tilt key is held.

// Charge & emission.
const CHARGE_MS_FULL = 700;     // hold this long → full puff.
const SEEDS_MIN = 4;            // released at 0% charge.
const SEEDS_MAX = 9;            // released at 100% charge.
const SEED_BASE_SPEED = 90;     // px/sec at 0% charge.
const SEED_MAX_SPEED = 220;     // px/sec at 100% charge.
const SEED_CONE_HALF = 0.32;    // half-angle of the spray cone (rad, ~18°).
const SEED_LIFETIME = 7500;     // ms max in-flight (fail-safe).

// Wind. Horizontal only; the seeds + drag handle vertical motion.
const WIND_CHANGE_MIN = 2800;   // ms between wind retargets.
const WIND_CHANGE_MAX = 5200;
const WIND_MAX = 75;            // px/sec lateral force at peak.
const WIND_SLEW = 60;           // how fast wind eases to target (px/sec/sec).

// Seed physics.
const SEED_GRAVITY = 18;        // px/sec^2 — very gentle (dandelion floats).
const SEED_DRAG = 0.55;         // air drag coefficient.

// Beds.
const BED_COUNT = 5;
const BED_RADIUS = 26;          // visual + hitbox.
const BED_MIN_Y = 110;
const BED_MAX_Y = 380;
const BED_MIN_X = 60;
const BED_MAX_X = CANVAS_W - 60;
const BED_MIN_SPACING = 78;     // beds can't overlap visually.
const BED_FILL_TARGET = 3;      // seeds needed to "bloom" a bed.
const BED_BLOOM_BONUS = 5;      // bonus on completion.

// Round.
const ROUND_TIME_MS = 30_000;
const PUFF_COOLDOWN_MS = 220;   // tiny gap so a single hold can't auto-fire twice.

// Palette.
const BED_COLORS = [
  '#f59e0b', // amber
  '#ec4899', // pink
  '#a855f7', // violet
  '#22d3ee', // cyan
  '#84cc16', // lime
];

type State = 'ready' | 'playing' | 'gameover';

type Seed = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;       // ms in flight.
  twirl: number;     // visual rotation phase.
  twirlSpeed: number;
  alive: boolean;
};

type Bed = {
  x: number;
  y: number;
  color: string;
  filled: number;    // seeds planted (0..BED_FILL_TARGET).
  bloomed: boolean;
  pulse: number;     // ms remaining of recent-hit flash.
  petals: { angle: number; len: number; w: number }[];
};

type WindParticle = {
  x: number;
  y: number;
  life: number;
};

const gen = createGenToken();

let state: State = 'ready';
let score = 0;
let best = 0;
let timeLeftMs = ROUND_TIME_MS;

let stemTilt = 0;
let leftHeld = false;
let rightHeld = false;

let charging = false;
let chargeStart = 0;
let chargeT = 0;              // 0..1.
let lastPuffAt = 0;

let windVx = 0;
let windTargetVx = 0;
let nextWindChangeAt = 0;
let windParticles: WindParticle[] = [];
let nextWindParticleAt = 0;

let seeds: Seed[] = [];
let beds: Bed[] = [];

let rafHandle: number | null = null;
let lastFrameTs = 0;
let pointerDown = false;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let timeEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayBtn!: HTMLButtonElement;

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function clamp(v: number, min: number, max: number): number {
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

function makePetals(): { angle: number; len: number; w: number }[] {
  const n = 6 + Math.floor(Math.random() * 3);
  const out: { angle: number; len: number; w: number }[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      angle: (i / n) * Math.PI * 2 + rand(-0.1, 0.1),
      len: rand(11, 15),
      w: rand(6.5, 9),
    });
  }
  return out;
}

function makeBeds(): Bed[] {
  const out: Bed[] = [];
  let safety = 0;
  while (out.length < BED_COUNT && safety < 400) {
    safety++;
    const x = rand(BED_MIN_X, BED_MAX_X);
    const y = rand(BED_MIN_Y, BED_MAX_Y);
    let collides = false;
    for (const b of out) {
      const dx = b.x - x;
      const dy = b.y - y;
      if (dx * dx + dy * dy < BED_MIN_SPACING * BED_MIN_SPACING) {
        collides = true;
        break;
      }
    }
    if (collides) continue;
    const color = BED_COLORS[out.length % BED_COLORS.length]!;
    out.push({
      x,
      y,
      color,
      filled: 0,
      bloomed: false,
      pulse: 0,
      petals: makePetals(),
    });
  }
  return out;
}

function spawnReplacementBed(): void {
  // Keep ~BED_COUNT unbloomed targets on screen so the round stays active.
  // Bloomed beds remain as decoration; they no longer count as targets.
  const empty = beds.filter((b) => !b.bloomed).length;
  if (empty >= BED_COUNT) return;
  let safety = 0;
  while (safety < 200) {
    safety++;
    const x = rand(BED_MIN_X, BED_MAX_X);
    const y = rand(BED_MIN_Y, BED_MAX_Y);
    let ok = true;
    for (const b of beds) {
      const dx = b.x - x;
      const dy = b.y - y;
      if (dx * dx + dy * dy < BED_MIN_SPACING * BED_MIN_SPACING) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const usedColors = new Set(beds.filter((b) => !b.bloomed).map((b) => b.color));
    const fresh = BED_COLORS.find((c) => !usedColors.has(c)) ?? BED_COLORS[0]!;
    beds.push({
      x,
      y,
      color: fresh,
      filled: 0,
      bloomed: false,
      pulse: 0,
      petals: makePetals(),
    });
    return;
  }
}

function commitBest(): void {
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
}

function updateHud(): void {
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
  const s = Math.max(0, Math.ceil(timeLeftMs / 1000));
  timeEl.textContent = String(s);
}

function showReadyOverlay(): void {
  overlayTitle.textContent = 'Karahindiba';
  overlayMsg.textContent =
    'Karahindiba sapını ← / → ile eğ, BOŞLUK\'u (ya da ekrana) basılı tut → gücü topla, bırak → tohumları savur.\n' +
    'Rüzgâr tohumları yana savurur — oku, zamanla.\n' +
    'Her renkli tarha 3 tohum düşür → tarh çiçek açar (+5 bonus).\n' +
    '30 saniyede ne kadar çok tarh açabilirsen o kadar skor.';
  overlayBtn.textContent = 'Başla';
  showOverlayEl(overlay);
}

function showGameOverOverlay(): void {
  overlayTitle.textContent = 'Süre doldu';
  const fresh = score > 0 && score === best;
  overlayMsg.textContent =
    `Skor: ${score}` +
    (fresh ? '  ·  Yeni rekor!' : `\nRekor: ${best}`) +
    '\n\nBOŞLUK / Enter ya da Tekrar dene.';
  overlayBtn.textContent = 'Tekrar dene';
  showOverlayEl(overlay);
}

function pickWindTarget(): number {
  // Bias toward non-zero wind so the read-the-wind step matters; allow
  // brief calm interludes.
  const sign = Math.random() < 0.5 ? -1 : 1;
  const mag = Math.random() < 0.18 ? rand(0, 12) : rand(28, WIND_MAX);
  return sign * mag;
}

function resetRoundFields(): void {
  score = 0;
  timeLeftMs = ROUND_TIME_MS;
  stemTilt = 0;
  leftHeld = false;
  rightHeld = false;
  charging = false;
  chargeT = 0;
  lastPuffAt = 0;
  seeds = [];
  beds = makeBeds();
  windVx = 0;
  windTargetVx = pickWindTarget();
  nextWindChangeAt = performance.now() + rand(WIND_CHANGE_MIN, WIND_CHANGE_MAX);
  windParticles = [];
  nextWindParticleAt = 0;
  pointerDown = false;
}

function reset(): void {
  gen.bump();
  stopRaf();
  state = 'ready';
  commitBest();
  resetRoundFields();
  updateHud();
  draw();
  showReadyOverlay();
}

function startRound(): void {
  if (state === 'playing') return;
  hideOverlayEl(overlay);
  state = 'playing';
  resetRoundFields();
  updateHud();
  startRaf();
}

function startRaf(): void {
  if (rafHandle !== null) return;
  const myGen = gen.current();
  lastFrameTs = performance.now();
  const loop = (t: number): void => {
    if (!gen.isCurrent(myGen)) {
      rafHandle = null;
      return;
    }
    const dt = Math.min(40, t - lastFrameTs);
    lastFrameTs = t;
    update(dt);
    draw();
    if (state === 'playing') {
      rafHandle = requestAnimationFrame(loop);
    } else {
      rafHandle = null;
    }
  };
  rafHandle = requestAnimationFrame(loop);
}

function stopRaf(): void {
  if (rafHandle !== null) {
    cancelAnimationFrame(rafHandle);
    rafHandle = null;
  }
}

function update(dt: number): void {
  if (state !== 'playing') return;
  const now = performance.now();

  // Timer.
  timeLeftMs -= dt;
  if (timeLeftMs <= 0) {
    timeLeftMs = 0;
    finishRound();
    return;
  }

  const sec = dt / 1000;

  // Stem tilt — discrete keys, no piksel/unit conflict.
  // Pointer-down overrides keyboard tilt (handled in applyPointerTilt).
  if (!pointerDown) {
    if (leftHeld && !rightHeld) {
      stemTilt = clamp(stemTilt - TILT_SPEED * sec, -TILT_MAX, TILT_MAX);
    } else if (rightHeld && !leftHeld) {
      stemTilt = clamp(stemTilt + TILT_SPEED * sec, -TILT_MAX, TILT_MAX);
    } else {
      if (Math.abs(stemTilt) < 0.005) stemTilt = 0;
      else stemTilt *= Math.pow(0.6, sec);
    }
  }

  // Charge meter.
  if (charging) {
    const elapsed = now - chargeStart;
    chargeT = clamp(elapsed / CHARGE_MS_FULL, 0, 1);
  }

  // Wind: ease current toward target, retarget periodically.
  const diff = windTargetVx - windVx;
  const slewStep = WIND_SLEW * sec;
  if (Math.abs(diff) <= slewStep) {
    windVx = windTargetVx;
  } else {
    windVx += Math.sign(diff) * slewStep;
  }
  if (now >= nextWindChangeAt) {
    windTargetVx = pickWindTarget();
    nextWindChangeAt = now + rand(WIND_CHANGE_MIN, WIND_CHANGE_MAX);
  }

  // Spawn ambient wind streak particles for visual feedback.
  if (now >= nextWindParticleAt && Math.abs(windVx) > 5) {
    nextWindParticleAt = now + 60 + Math.random() * 80;
    windParticles.push({
      x: windVx > 0 ? -5 : CANVAS_W + 5,
      y: rand(40, CANVAS_H - 80),
      life: 1,
    });
  }
  for (const p of windParticles) {
    p.x += windVx * sec;
    p.life -= sec * 0.6;
  }
  windParticles = windParticles.filter(
    (p) => p.life > 0 && p.x > -20 && p.x < CANVAS_W + 20,
  );

  // Tick seeds.
  for (const s of seeds) {
    if (!s.alive) continue;
    s.age += dt;
    if (s.age > SEED_LIFETIME) {
      s.alive = false;
      continue;
    }
    // Drag + wind.
    s.vx += (windVx - s.vx * SEED_DRAG) * sec;
    s.vy += (SEED_GRAVITY - s.vy * SEED_DRAG) * sec;
    s.x += s.vx * sec;
    s.y += s.vy * sec;
    s.twirl += s.twirlSpeed * sec;

    if (s.x < -20 || s.x > CANVAS_W + 20 || s.y > CANVAS_H + 20) {
      s.alive = false;
      continue;
    }

    // Bed hit-test: a seed lands when it enters a bed circle while
    // descending. BED_RADIUS is the same value the sprite uses.
    if (s.vy > 0) {
      for (const b of beds) {
        if (b.bloomed) continue;
        const dx = b.x - s.x;
        const dy = b.y - s.y;
        if (dx * dx + dy * dy < BED_RADIUS * BED_RADIUS) {
          s.alive = false;
          b.filled++;
          b.pulse = 320;
          score += 1;
          if (b.filled >= BED_FILL_TARGET) {
            b.bloomed = true;
            score += BED_BLOOM_BONUS;
            spawnReplacementBed();
          }
          commitBest();
          break;
        }
      }
    }
  }
  // Drop dead seeds — keeps `seeds.length` representing live entities.
  seeds = seeds.filter((s) => s.alive);

  // Tick bed pulses.
  for (const b of beds) {
    if (b.pulse > 0) b.pulse = Math.max(0, b.pulse - dt);
  }

  updateHud();
}

function tryStartCharge(): void {
  if (state !== 'playing') return;
  const now = performance.now();
  if (now - lastPuffAt < PUFF_COOLDOWN_MS) return;
  if (charging) return;
  charging = true;
  chargeStart = now;
  chargeT = 0;
}

function tryReleasePuff(): void {
  if (!charging) return;
  charging = false;
  if (state !== 'playing') {
    chargeT = 0;
    return;
  }
  const now = performance.now();
  const tipX = STEM_BASE_X + Math.sin(stemTilt) * STEM_LEN;
  const tipY = STEM_BASE_Y - Math.cos(stemTilt) * STEM_LEN;
  const aim = stemTilt; // 0 = straight up; ± = lean.
  const n = Math.round(SEEDS_MIN + (SEEDS_MAX - SEEDS_MIN) * chargeT);
  const speed = SEED_BASE_SPEED + (SEED_MAX_SPEED - SEED_BASE_SPEED) * chargeT;
  for (let i = 0; i < n; i++) {
    const k = n === 1 ? 0 : i / (n - 1) - 0.5; // -0.5..0.5
    const a = aim + k * 2 * SEED_CONE_HALF + rand(-0.04, 0.04);
    const v = speed * (0.85 + Math.random() * 0.3);
    seeds.push({
      x: tipX,
      y: tipY,
      vx: Math.sin(a) * v,
      vy: -Math.cos(a) * v,
      age: 0,
      twirl: Math.random() * Math.PI * 2,
      twirlSpeed: rand(-3, 3),
      alive: true,
    });
  }
  lastPuffAt = now;
  chargeT = 0;
}

function finishRound(): void {
  state = 'gameover';
  charging = false;
  chargeT = 0;
  leftHeld = false;
  rightHeld = false;
  pointerDown = false;
  stopRaf();
  commitBest();
  updateHud();
  draw();
  showGameOverOverlay();
}

// --- Input ---

function onKeyDown(e: KeyboardEvent): void {
  const k = e.key;
  const lk = k.toLowerCase();
  if (lk === 'r') {
    reset();
    e.preventDefault();
    return;
  }
  if (state === 'ready' || state === 'gameover') {
    if (k === ' ' || k === 'Enter') {
      startRound();
      e.preventDefault();
    }
    return;
  }
  // Playing.
  if (k === ' ') {
    e.preventDefault();
    if (!e.repeat) tryStartCharge();
    return;
  }
  if (k === 'ArrowLeft' || lk === 'a') {
    leftHeld = true;
    e.preventDefault();
    return;
  }
  if (k === 'ArrowRight' || lk === 'd') {
    rightHeld = true;
    e.preventDefault();
    return;
  }
}

function onKeyUp(e: KeyboardEvent): void {
  const k = e.key;
  const lk = k.toLowerCase();
  if (state !== 'playing') {
    if (k === ' ') charging = false;
    if (k === 'ArrowLeft' || lk === 'a') leftHeld = false;
    if (k === 'ArrowRight' || lk === 'd') rightHeld = false;
    return;
  }
  if (k === ' ') {
    e.preventDefault();
    tryReleasePuff();
    return;
  }
  if (k === 'ArrowLeft' || lk === 'a') {
    leftHeld = false;
    e.preventDefault();
    return;
  }
  if (k === 'ArrowRight' || lk === 'd') {
    rightHeld = false;
    e.preventDefault();
    return;
  }
}

function pointToCanvas(e: PointerEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const sx = canvas.width / rect.width;
  const sy = canvas.height / rect.height;
  return {
    x: (e.clientX - rect.left) * sx,
    y: (e.clientY - rect.top) * sy,
  };
}

function onPointerDown(e: PointerEvent): void {
  e.preventDefault();
  if (state === 'ready' || state === 'gameover') {
    startRound();
    return;
  }
  if (state !== 'playing') return;
  pointerDown = true;
  const pt = pointToCanvas(e);
  applyPointerTilt(pt.x);
  tryStartCharge();
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {
    /* ignored */
  }
}

function onPointerMove(e: PointerEvent): void {
  if (!pointerDown || state !== 'playing') return;
  const pt = pointToCanvas(e);
  applyPointerTilt(pt.x);
}

function onPointerUp(e: PointerEvent): void {
  e.preventDefault();
  pointerDown = false;
  if (state !== 'playing') return;
  tryReleasePuff();
  try {
    canvas.releasePointerCapture(e.pointerId);
  } catch {
    /* ignored */
  }
}

function applyPointerTilt(px: number): void {
  // Pointer X relative to stem base → tilt range.
  const offset = (px - STEM_BASE_X) / (CANVAS_W / 2); // -1..1
  stemTilt = clamp(offset, -1, 1) * TILT_MAX;
}

// --- Render ---

function draw(): void {
  // Sky gradient: dusk → light blue.
  const g = ctx.createLinearGradient(0, 0, 0, CANVAS_H);
  g.addColorStop(0, '#1b2a4a');
  g.addColorStop(0.45, '#3b5ea0');
  g.addColorStop(0.85, '#a3c9ef');
  g.addColorStop(1, '#cfe1d2');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  drawHills();
  drawGround();
  drawWindParticles();

  for (const b of beds) drawBed(b);
  drawDandelion();
  for (const s of seeds) drawSeed(s);
  drawWindArrow();

  if (state === 'playing' && charging) drawChargeBar();
}

function drawHills(): void {
  ctx.fillStyle = 'rgba(40, 60, 90, 0.55)';
  ctx.beginPath();
  ctx.moveTo(0, 430);
  ctx.quadraticCurveTo(120, 380, 240, 420);
  ctx.quadraticCurveTo(360, 460, 480, 410);
  ctx.lineTo(480, 600);
  ctx.lineTo(0, 600);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = 'rgba(60, 100, 80, 0.65)';
  ctx.beginPath();
  ctx.moveTo(0, 480);
  ctx.quadraticCurveTo(160, 440, 280, 475);
  ctx.quadraticCurveTo(400, 510, 480, 470);
  ctx.lineTo(480, 600);
  ctx.lineTo(0, 600);
  ctx.closePath();
  ctx.fill();
}

function drawGround(): void {
  const grad = ctx.createLinearGradient(0, CANVAS_H - 60, 0, CANVAS_H);
  grad.addColorStop(0, '#4d7a3a');
  grad.addColorStop(1, '#2a4a1e');
  ctx.fillStyle = grad;
  ctx.fillRect(0, CANVAS_H - 50, CANVAS_W, 50);
  ctx.strokeStyle = 'rgba(40, 80, 30, 0.75)';
  ctx.lineWidth = 1.2;
  for (let x = 0; x < CANVAS_W; x += 7) {
    const h = 6 + ((x * 53) % 7);
    ctx.beginPath();
    ctx.moveTo(x, CANVAS_H - 50);
    ctx.lineTo(x + 1.5, CANVAS_H - 50 - h);
    ctx.stroke();
  }
}

function drawWindParticles(): void {
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
  ctx.lineWidth = 1;
  for (const p of windParticles) {
    const len = 8 + Math.abs(windVx) * 0.06;
    const dx = windVx > 0 ? -len : len;
    ctx.globalAlpha = p.life * 0.5;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + dx, p.y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function drawBed(b: Bed): void {
  if (b.bloomed) {
    drawBloomedBed(b);
    return;
  }
  ctx.save();
  ctx.translate(b.x, b.y);

  if (b.pulse > 0) {
    const t = b.pulse / 320;
    ctx.fillStyle = hexToRgba(b.color, 0.35 * t);
    ctx.beginPath();
    ctx.arc(0, 0, BED_RADIUS + 14 * t, 0, Math.PI * 2);
    ctx.fill();
  }

  const soil = ctx.createRadialGradient(0, -3, 2, 0, 0, BED_RADIUS);
  soil.addColorStop(0, '#7a5736');
  soil.addColorStop(1, '#3a2415');
  ctx.fillStyle = soil;
  ctx.beginPath();
  ctx.arc(0, 0, BED_RADIUS, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = b.color;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(0, 0, BED_RADIUS, 0, Math.PI * 2);
  ctx.stroke();

  // Fill progress: dots around the ring representing planted seeds.
  for (let i = 0; i < BED_FILL_TARGET; i++) {
    const a = -Math.PI / 2 + (i / BED_FILL_TARGET) * Math.PI * 2;
    const dx = Math.cos(a) * (BED_RADIUS - 7);
    const dy = Math.sin(a) * (BED_RADIUS - 7);
    if (i < b.filled) {
      ctx.fillStyle = b.color;
    } else {
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
    }
    ctx.beginPath();
    ctx.arc(dx, dy, 3.4, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

function drawBloomedBed(b: Bed): void {
  ctx.save();
  ctx.translate(b.x, b.y);
  ctx.fillStyle = '#3a2415';
  ctx.beginPath();
  ctx.arc(0, 0, BED_RADIUS * 0.7, 0, Math.PI * 2);
  ctx.fill();

  for (const p of b.petals) {
    ctx.save();
    ctx.rotate(p.angle);
    ctx.fillStyle = b.color;
    ctx.beginPath();
    ctx.ellipse(p.len * 0.5, 0, p.len * 0.65, p.w * 0.55, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = hexToRgba('#ffffff', 0.35);
    ctx.lineWidth = 0.8;
    ctx.stroke();
    ctx.restore();
  }
  ctx.fillStyle = '#fde68a';
  ctx.beginPath();
  ctx.arc(0, 0, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#a16207';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}

function drawDandelion(): void {
  const tipX = STEM_BASE_X + Math.sin(stemTilt) * STEM_LEN;
  const tipY = STEM_BASE_Y - Math.cos(stemTilt) * STEM_LEN;

  // Stem.
  ctx.strokeStyle = '#3d6a2a';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(STEM_BASE_X, STEM_BASE_Y);
  ctx.quadraticCurveTo(
    STEM_BASE_X + Math.sin(stemTilt * 0.4) * STEM_LEN * 0.5,
    STEM_BASE_Y - STEM_LEN * 0.55,
    tipX,
    tipY,
  );
  ctx.stroke();

  // Two little leaves at the base.
  ctx.fillStyle = '#558a3b';
  ctx.beginPath();
  ctx.ellipse(STEM_BASE_X - 10, STEM_BASE_Y - 8, 9, 3, -0.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(STEM_BASE_X + 10, STEM_BASE_Y - 12, 9, 3, 0.6, 0, Math.PI * 2);
  ctx.fill();

  // Puff head: a fuzzy ball that grows while charging.
  const r = 14 + (charging ? chargeT * 6 : 0);
  const halo = ctx.createRadialGradient(tipX, tipY, 1, tipX, tipY, r + 8);
  halo.addColorStop(0, 'rgba(255,255,255,0.55)');
  halo.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(tipX, tipY, r + 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(245, 245, 245, 0.9)';
  ctx.beginPath();
  ctx.arc(tipX, tipY, r, 0, Math.PI * 2);
  ctx.fill();
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2;
    const rr = r * (0.55 + (i % 3) * 0.12);
    const px = tipX + Math.cos(a) * rr;
    const py = tipY + Math.sin(a) * rr;
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.beginPath();
    ctx.arc(px, py, 1.4, 0, Math.PI * 2);
    ctx.fill();
  }

  // Aim guide while charging.
  if (state === 'playing' && charging) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.setLineDash([4, 5]);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    const reach = 80 + chargeT * 60;
    ctx.lineTo(tipX + Math.sin(stemTilt) * reach, tipY - Math.cos(stemTilt) * reach);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }
}

function drawSeed(s: Seed): void {
  ctx.save();
  ctx.translate(s.x, s.y);
  ctx.rotate(s.twirl);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.lineWidth = 1;
  ctx.lineCap = 'round';
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(a) * 5, Math.sin(a) * 5);
    ctx.stroke();
  }
  ctx.fillStyle = '#6b4a2a';
  ctx.beginPath();
  ctx.arc(0, 0, 1.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawWindArrow(): void {
  const cx = CANVAS_W / 2;
  const cy = 22;
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  roundRect(cx - 80, cy - 14, 160, 28, 14);
  ctx.fill();

  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.font = '11px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  ctx.fillText('rüzgâr', cx - 36, cy);

  const arrowLen = clamp(Math.abs(windVx) * 0.7, 6, 60);
  const dir = windVx >= 0 ? 1 : -1;
  const startX = cx - 30 * dir;
  const endX = cx - 30 * dir + arrowLen * dir;
  ctx.strokeStyle = '#f8fafc';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(startX, cy);
  ctx.lineTo(endX, cy);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(endX, cy);
  ctx.lineTo(endX - 6 * dir, cy - 5);
  ctx.lineTo(endX - 6 * dir, cy + 5);
  ctx.closePath();
  ctx.fillStyle = '#f8fafc';
  ctx.fill();

  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  const strength = Math.round(Math.abs(windVx));
  ctx.fillText(`${strength}`, cx + 50, cy);
}

function drawChargeBar(): void {
  const w = 120;
  const h = 8;
  const x = CANVAS_W - w - 16;
  const y = CANVAS_H - 76;
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  roundRect(x - 2, y - 2, w + 4, h + 4, 6);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  roundRect(x, y, w, h, 4);
  ctx.fill();
  const fillW = w * chargeT;
  const hue = 60 - chargeT * 40;
  ctx.fillStyle = `hsl(${hue},90%,62%)`;
  roundRect(x, y, fillW, h, 4);
  ctx.fill();
}

function roundRect(x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.startsWith('#') ? hex.slice(1) : hex;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  timeEl = document.querySelector<HTMLElement>('#time')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  restartBtn.addEventListener('click', reset);
  overlayBtn.addEventListener('click', () => startRound());
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  // Lose focus → release sticky keys / charge.
  window.addEventListener('blur', () => {
    charging = false;
    chargeT = 0;
    leftHeld = false;
    rightHeld = false;
    pointerDown = false;
  });

  reset();
}

export const game = defineGame({ init, reset });
