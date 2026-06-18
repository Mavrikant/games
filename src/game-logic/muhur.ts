import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import {
  showOverlay as showOverlayEl,
  hideOverlay as hideOverlayEl,
} from '@shared/overlay';

// Mühür — Wax Seal. Drip molten wax onto an envelope's target ring, let it
// cool to the green band, then slam the brass die. Position, size and
// temperature multiplicatively score each envelope. 6 envelopes per round;
// each round shrinks the target ring, narrows the temperature band and
// tightens the per-envelope timer.
//
// PITFALLS guarded here:
//   - unguarded-storage: safeRead/safeWrite wrap localStorage.
//   - stale-async-callback: gen.bump() on every reset; RAF loop & stamp
//     animations check the token before mutating state.
//   - overlay-input-leak: explicit `state` enum guards every handler; the
//     stamp button is also `disabled` while the overlay is visible.
//   - missing-overlay-css: `.overlay--hidden` + `.overlay` rules ship in
//     the per-game CSS.
//   - module-level-dom-access: all DOM access lives in init().
//   - visual-vs-hitbox: target ring radius/position is the same `targetX,
//     targetY, targetR` triple consumed by render + scoring.
//   - invisible-boot: reset() draws the first envelope + target so the
//     scene is visible before the player taps Başla.
//   - hud-counter-synced-only-at-lifecycle-edges: updateHud() is called on
//     every envelope completion, not just round end.
//   - designed-lose-condition-not-wired: per-envelope timeout fires
//     finishEnvelope({ stamped: false }) explicitly.

const STORAGE_BEST = 'muhur.best';

// ---- Canvas geometry ----

const W = 480;
const H = 640;

const ENVELOPE_X = 40;
const ENVELOPE_Y = 90;
const ENVELOPE_W = W - 2 * ENVELOPE_X;
const ENVELOPE_H = 360;

const CANDLE_Y = 40; // Top of candle flame
const POOL_GROW_PER_SEC = 16; // pool radius grows per second while holding
const POOL_MAX_R = 44;
const POOL_MIN_R = 6; // minimum to be considered "any wax"

const COOL_PER_SEC = 30; // temperature drops this many units per second

const TARGET_DEFAULT_R = 24;
const ENVELOPES_PER_ROUND = 6;
const ENVELOPE_TIME_BASE = 6.0; // seconds at round 1

const STAMP_ANIM_MS = 360;

// ---- Types ----

type State = 'ready' | 'playing' | 'roundOver' | 'gameover';

interface Envelope {
  targetX: number;
  targetY: number;
  targetR: number;
  poolX: number;
  poolY: number;
  poolR: number;
  poolTemp: number; // 0..100
  dripping: boolean;
  hasPool: boolean;
  timeLeft: number; // seconds
  stamped: boolean;
  finished: boolean;
  score: number;
}

interface RoundConfig {
  targetR: number;
  timePerEnv: number;
  tempBandMin: number;
  tempBandMax: number;
}

// ---- DOM refs ----

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let roundEl!: HTMLElement;
let letterEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let stampBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayAction!: HTMLButtonElement;

// ---- Mutable state ----

const gen = createGenToken();

let state: State = 'ready';
let round = 1;
let envelopeIdx = 0;
let totalScore = 0;
let best = 0;
let mouseX = W / 2;
let mouseY = ENVELOPE_Y + ENVELOPE_H / 2;
let mouseInside = false;
let pointerHeld = false;
let pointerId: number | null = null;
let env: Envelope | null = null;

let lastFrameMs = 0;
let animHandle: number | null = null;

let stampAnimStart = 0; // ms; 0 = not animating

// ---- Storage ----

function loadBest(): number {
  const raw = safeRead<number>(STORAGE_BEST, 0);
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0
    ? Math.floor(raw)
    : 0;
}

function commitBest(roundScore: number): void {
  if (roundScore > best) {
    best = roundScore;
    safeWrite(STORAGE_BEST, best);
  }
}

// ---- Round config (difficulty curve) ----

function configForRound(r: number): RoundConfig {
  // Round 1 = easiest. Shrink target, shorten timer, narrow temp band.
  const targetR = Math.max(14, TARGET_DEFAULT_R - (r - 1) * 1.5);
  const timePerEnv = Math.max(3.2, ENVELOPE_TIME_BASE - (r - 1) * 0.4);
  // Band starts wide (25..70) and narrows toward (40..60).
  const widen = Math.max(0, 12 - (r - 1) * 2);
  const tempBandMin = 40 - widen;
  const tempBandMax = 60 + widen;
  return { targetR, timePerEnv, tempBandMin, tempBandMax };
}

// ---- Envelope ----

function newEnvelope(): Envelope {
  const cfg = configForRound(round);
  const pad = 60;
  const tx = ENVELOPE_X + pad + Math.random() * (ENVELOPE_W - 2 * pad);
  const ty = ENVELOPE_Y + pad + Math.random() * (ENVELOPE_H - 2 * pad);
  return {
    targetX: tx,
    targetY: ty,
    targetR: cfg.targetR,
    poolX: 0,
    poolY: 0,
    poolR: 0,
    poolTemp: 0,
    dripping: false,
    hasPool: false,
    timeLeft: cfg.timePerEnv,
    stamped: false,
    finished: false,
    score: 0,
  };
}

// ---- Drawing ----

function drawDesk(): void {
  // Background: dark wood gradient already set via CSS, but draw subtle
  // grain.
  ctx.fillStyle = '#1a110a';
  ctx.fillRect(0, 0, W, H);
  // wood grain stripes
  ctx.strokeStyle = 'rgba(60, 36, 18, 0.4)';
  ctx.lineWidth = 1;
  for (let y = 0; y < H; y += 28) {
    ctx.beginPath();
    ctx.moveTo(0, y + Math.sin(y * 0.1) * 3);
    for (let x = 0; x < W; x += 12) {
      ctx.lineTo(x, y + Math.sin((x + y) * 0.04) * 2);
    }
    ctx.stroke();
  }
}

function drawEnvelope(): void {
  // Cream parchment
  ctx.fillStyle = '#f3e3c0';
  ctx.strokeStyle = '#8a7448';
  ctx.lineWidth = 2;
  roundRect(ctx, ENVELOPE_X, ENVELOPE_Y, ENVELOPE_W, ENVELOPE_H, 8);
  ctx.fill();
  ctx.stroke();

  // Faint flap diagonals to look like a folded letter
  ctx.strokeStyle = 'rgba(138, 116, 72, 0.35)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(ENVELOPE_X, ENVELOPE_Y);
  ctx.lineTo(ENVELOPE_X + ENVELOPE_W / 2, ENVELOPE_Y + 60);
  ctx.lineTo(ENVELOPE_X + ENVELOPE_W, ENVELOPE_Y);
  ctx.stroke();

  // Decorative calligraphic lines
  ctx.strokeStyle = 'rgba(99, 80, 50, 0.32)';
  ctx.lineWidth = 1.5;
  for (let i = 0; i < 5; i++) {
    const yy = ENVELOPE_Y + 110 + i * 22;
    ctx.beginPath();
    ctx.moveTo(ENVELOPE_X + 28, yy);
    const len = ENVELOPE_W - 56 - (i * 14) - Math.random() * 0;
    ctx.lineTo(ENVELOPE_X + 28 + Math.max(40, len * 0.85), yy);
    ctx.stroke();
  }
}

function drawTarget(e: Envelope): void {
  // Faded target ring + crosshair
  ctx.save();
  ctx.strokeStyle = 'rgba(170, 70, 70, 0.45)';
  ctx.lineWidth = 2;
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  ctx.arc(e.targetX, e.targetY, e.targetR, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  // small inner dot
  ctx.fillStyle = 'rgba(170, 70, 70, 0.5)';
  ctx.beginPath();
  ctx.arc(e.targetX, e.targetY, 2.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawWaxPool(e: Envelope, now: number): void {
  if (!e.hasPool || e.poolR < 1) return;
  const r = e.poolR;
  const x = e.poolX;
  const y = e.poolY;
  // Temperature → color: 100 = bright orange, 0 = dark brown.
  const t = Math.max(0, Math.min(100, e.poolTemp)) / 100;
  const innerR = 240 + (255 - 240) * t;
  const innerG = 70 + (180 - 70) * t;
  const innerB = 30 + (80 - 30) * t;
  const outerR = 90 + (180 - 90) * t;
  const outerG = 16 + (60 - 16) * t;
  const outerB = 16 + (24 - 16) * t;

  const grad = ctx.createRadialGradient(
    x - r * 0.3,
    y - r * 0.3,
    r * 0.2,
    x,
    y,
    r,
  );
  grad.addColorStop(0, `rgb(${innerR | 0}, ${innerG | 0}, ${innerB | 0})`);
  grad.addColorStop(1, `rgb(${outerR | 0}, ${outerG | 0}, ${outerB | 0})`);
  ctx.fillStyle = grad;
  ctx.beginPath();
  // Slightly bumpy edge for liquid wax look
  const bumps = 14;
  for (let i = 0; i <= bumps; i++) {
    const ang = (i / bumps) * Math.PI * 2;
    const wobble =
      1 +
      Math.sin(ang * 3 + now * 0.004 + e.poolX * 0.02) *
        0.04 *
        (1 - 0.6 * (1 - t));
    const px = x + Math.cos(ang) * r * wobble;
    const py = y + Math.sin(ang) * r * wobble;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();

  // Hot highlight
  if (t > 0.4) {
    ctx.fillStyle = `rgba(255, 230, 180, ${0.18 * t})`;
    ctx.beginPath();
    ctx.arc(x - r * 0.35, y - r * 0.35, r * 0.4, 0, Math.PI * 2);
    ctx.fill();
  }

  // Size guide ring (around the pool, glows green when matching target)
  if (env) {
    const sizeDelta = Math.abs(r - env.targetR);
    const close = sizeDelta < 4;
    ctx.strokeStyle = close
      ? 'rgba(98, 220, 120, 0.85)'
      : 'rgba(255, 255, 255, 0.25)';
    ctx.lineWidth = close ? 2 : 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.arc(x, y, r + 4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

function drawCandle(now: number): void {
  // Position: mouseX clamped horizontally; vertical is fixed near top
  const cx = clamp(mouseX, ENVELOPE_X + 10, ENVELOPE_X + ENVELOPE_W - 10);
  const cy = CANDLE_Y;
  const tilt = pointerHeld ? 0.55 : 0;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(tilt);

  // Candle body
  const cw = 22;
  const ch = 56;
  ctx.fillStyle = '#dc2626';
  ctx.strokeStyle = '#7f1d1d';
  ctx.lineWidth = 1.5;
  ctx.fillRect(-cw / 2, 0, cw, ch);
  ctx.strokeRect(-cw / 2, 0, cw, ch);
  // wax rim drip
  ctx.fillStyle = '#b91c1c';
  ctx.fillRect(-cw / 2, 0, cw, 4);

  // Wick
  ctx.strokeStyle = '#3a2a14';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, -8);
  ctx.stroke();

  // Flame (flickers)
  const flick = 1 + Math.sin(now * 0.02) * 0.05;
  const flameGrad = ctx.createRadialGradient(0, -14, 1, 0, -14, 14 * flick);
  flameGrad.addColorStop(0, 'rgba(255, 250, 180, 0.95)');
  flameGrad.addColorStop(0.45, 'rgba(255, 170, 60, 0.85)');
  flameGrad.addColorStop(1, 'rgba(255, 50, 30, 0)');
  ctx.fillStyle = flameGrad;
  ctx.beginPath();
  ctx.ellipse(0, -14, 8 * flick, 14 * flick, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();

  // Falling drip strand while held (after rotation so always vertical)
  if (pointerHeld && env && !env.finished) {
    const dripX = cx + Math.sin(tilt) * 30;
    const dripY = cy + Math.cos(tilt) * 30;
    ctx.strokeStyle = 'rgba(220, 38, 38, 0.7)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(dripX, dripY);
    ctx.lineTo(env.poolX, env.poolY);
    ctx.stroke();
    // small drop blob at tip
    ctx.fillStyle = '#dc2626';
    ctx.beginPath();
    ctx.arc(dripX, dripY + 4, 3, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawThermometer(e: Envelope): void {
  // Thermometer on the right side
  const tx = W - 28;
  const ty = ENVELOPE_Y + 20;
  const tw = 14;
  const th = ENVELOPE_H - 60;
  // Frame
  ctx.fillStyle = 'rgba(40, 30, 18, 0.9)';
  ctx.strokeStyle = '#8a7448';
  ctx.lineWidth = 1.5;
  roundRect(ctx, tx - tw / 2, ty, tw, th, 6);
  ctx.fill();
  ctx.stroke();

  // Green target band
  const cfg = configForRound(round);
  const bandTopT = cfg.tempBandMax / 100;
  const bandBotT = cfg.tempBandMin / 100;
  // y goes from top (cold) to bottom (hot)? We'll put hot at top.
  const yTop = ty + (1 - bandTopT) * th;
  const yBot = ty + (1 - bandBotT) * th;
  ctx.fillStyle = 'rgba(98, 220, 120, 0.32)';
  ctx.fillRect(tx - tw / 2, yTop, tw, yBot - yTop);
  ctx.strokeStyle = 'rgba(98, 220, 120, 0.8)';
  ctx.lineWidth = 1;
  ctx.strokeRect(tx - tw / 2, yTop, tw, yBot - yTop);

  // Current temperature
  if (e.hasPool) {
    const t = Math.max(0, Math.min(100, e.poolTemp)) / 100;
    const yy = ty + (1 - t) * th;
    // Color shifts hot→cold
    const r = (240 * t + 90 * (1 - t)) | 0;
    const g = (60 * t + 18 * (1 - t)) | 0;
    const b = (30 * t + 24 * (1 - t)) | 0;
    ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
    ctx.fillRect(tx - tw / 2 + 1, yy, tw - 2, th - (yy - ty) - 1);
    // Marker
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(tx - tw / 2 - 4, yy);
    ctx.lineTo(tx + tw / 2 + 4, yy);
    ctx.stroke();
  }

  // Label
  ctx.fillStyle = 'rgba(240, 220, 180, 0.7)';
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('ISI', tx, ty - 6);
}

function drawTimerBar(e: Envelope): void {
  const cfg = configForRound(round);
  const tx = ENVELOPE_X;
  const ty = ENVELOPE_Y + ENVELOPE_H + 14;
  const tw = ENVELOPE_W;
  const th = 8;
  ctx.fillStyle = 'rgba(40, 30, 18, 0.9)';
  ctx.fillRect(tx, ty, tw, th);
  const frac = Math.max(0, e.timeLeft / cfg.timePerEnv);
  const filled = tw * frac;
  ctx.fillStyle = frac > 0.35 ? '#d4a017' : frac > 0.15 ? '#e76f51' : '#dc2626';
  ctx.fillRect(tx, ty, filled, th);
  ctx.strokeStyle = 'rgba(212, 160, 23, 0.7)';
  ctx.lineWidth = 1;
  ctx.strokeRect(tx, ty, tw, th);
}

function drawStampAnimation(now: number): void {
  if (!stampAnimStart) return;
  const t = Math.min(1, (now - stampAnimStart) / STAMP_ANIM_MS);
  if (t >= 1) {
    stampAnimStart = 0;
    return;
  }
  if (!env) return;
  // Stamp falls from top to pool position, then bounces back.
  // Drop in first half, retract in second half.
  const fall = t < 0.5 ? t / 0.5 : 1 - (t - 0.5) / 0.5;
  const fromY = -40;
  const toY = env.poolY;
  const sy = fromY + (toY - fromY) * fall;
  const sx = env.poolX;

  // Brass cylindrical stamp body
  const sw = 64;
  const sh = 70;
  ctx.fillStyle = '#5a4209';
  ctx.fillRect(sx - sw / 2, sy - sh, sw, sh - 14);
  ctx.fillStyle = '#a87f1d';
  roundRect(ctx, sx - sw / 2, sy - sh, sw, sh - 14, 6);
  ctx.fill();
  ctx.strokeStyle = '#3a2a06';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Stamp head (the part hitting wax)
  ctx.fillStyle = '#c8951b';
  ctx.beginPath();
  ctx.ellipse(sx, sy - 4, sw / 2 - 4, 10, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#5a4209';
  ctx.stroke();

  // Handle on top
  ctx.fillStyle = '#3a2a06';
  ctx.fillRect(sx - 8, sy - sh - 14, 16, 14);
  ctx.fillStyle = '#8b6914';
  ctx.beginPath();
  ctx.arc(sx, sy - sh - 14, 14, Math.PI, 2 * Math.PI);
  ctx.fill();
  ctx.strokeStyle = '#3a2a06';
  ctx.stroke();
}

function drawStampedSeal(e: Envelope): void {
  // After successful stamp, the pool is replaced with an embossed shape.
  if (!e.stamped || !e.hasPool) return;
  const x = e.poolX;
  const y = e.poolY;
  const r = e.poolR;
  // Dark red sealed wax + embossed star pattern
  ctx.fillStyle = '#7f1d1d';
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#3a0a0a';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Embossed crest: simple star
  ctx.fillStyle = '#a73030';
  ctx.beginPath();
  const points = 8;
  for (let i = 0; i < points * 2; i++) {
    const ang = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2;
    const rr = i % 2 === 0 ? r * 0.6 : r * 0.28;
    const px = x + Math.cos(ang) * rr;
    const py = y + Math.sin(ang) * rr;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#5a0808';
  ctx.beginPath();
  ctx.arc(x, y, r * 0.18, 0, Math.PI * 2);
  ctx.fill();
}

function drawScoreFloater(e: Envelope): void {
  if (!e.finished) return;
  const x = e.poolX;
  const y = e.poolY - e.poolR - 18;
  ctx.fillStyle = e.score > 70 ? '#62dc78' : e.score > 30 ? '#d4a017' : '#dc2626';
  ctx.font = 'bold 18px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`+${e.score}`, x, y);
}

function roundRect(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  c.beginPath();
  c.moveTo(x + r, y);
  c.lineTo(x + w - r, y);
  c.quadraticCurveTo(x + w, y, x + w, y + r);
  c.lineTo(x + w, y + h - r);
  c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  c.lineTo(x + r, y + h);
  c.quadraticCurveTo(x, y + h, x, y + h - r);
  c.lineTo(x, y + r);
  c.quadraticCurveTo(x, y, x + r, y);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function draw(now: number): void {
  drawDesk();
  drawEnvelope();
  if (env) {
    if (!env.stamped) drawTarget(env);
    drawWaxPool(env, now);
    if (env.stamped) drawStampedSeal(env);
    drawThermometer(env);
    drawTimerBar(env);
    drawScoreFloater(env);
  }
  if (state === 'playing') {
    drawCandle(now);
  }
  drawStampAnimation(now);

  // Hint text rendered just above the timer bar (well above the stamp btn).
  ctx.fillStyle = 'rgba(240, 220, 180, 0.6)';
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  let hint = '';
  if (state === 'playing' && env) {
    if (!env.hasPool && !pointerHeld) {
      hint = 'Mumu hedef üstüne getir, basılı tut → balmumu damlat';
    } else if (env.dripping) {
      hint = 'Bırak: damla durur, balmumu soğumaya başlar';
    } else if (env.hasPool && !env.stamped) {
      hint = 'Isı yeşil banda gelince Damgala (Boşluk)';
    }
  }
  ctx.fillText(hint, W / 2, ENVELOPE_Y + ENVELOPE_H + 36);
}

// ---- Scoring ----

function scoreEnvelope(e: Envelope): number {
  if (!e.hasPool || e.poolR < POOL_MIN_R) return 0;
  const cfg = configForRound(round);
  // Position: distance from pool center to target center.
  const dx = e.poolX - e.targetX;
  const dy = e.poolY - e.targetY;
  const posErr = Math.hypot(dx, dy);
  const posScore = Math.max(0, 1 - posErr / 38);
  // Size: how close pool radius matches target radius.
  const sizeErr = Math.abs(e.poolR - e.targetR);
  const sizeScore = Math.max(0, 1 - sizeErr / 16);
  // Temperature: inside band = 1, falls off linearly outside.
  let tempScore: number;
  if (e.poolTemp >= cfg.tempBandMin && e.poolTemp <= cfg.tempBandMax) {
    tempScore = 1;
  } else if (e.poolTemp > cfg.tempBandMax) {
    const over = e.poolTemp - cfg.tempBandMax;
    tempScore = Math.max(0, 1 - over / 35);
  } else {
    const under = cfg.tempBandMin - e.poolTemp;
    tempScore = Math.max(0, 1 - under / 30);
  }
  const raw = 100 * posScore * sizeScore * tempScore;
  return Math.round(raw);
}

// ---- Lifecycle ----

function nextEnvelope(): void {
  if (envelopeIdx >= ENVELOPES_PER_ROUND) {
    finishRound();
    return;
  }
  env = newEnvelope();
  envelopeIdx++;
  pointerHeld = false; // pointer is per-envelope; if mouse still down user can re-press
  pointerId = null;
  stampAnimStart = 0;
  updateHud();
  updateStampBtn();
}

function startEnvelopeTimerTick(dtSec: number): void {
  if (!env || env.finished) return;
  env.timeLeft -= dtSec;
  if (env.timeLeft <= 0) {
    env.timeLeft = 0;
    finishEnvelope({ stamped: false });
  }
}

function finishEnvelope(opts: { stamped: boolean }): void {
  if (!env || env.finished) return;
  if (opts.stamped) {
    env.stamped = true;
    env.score = scoreEnvelope(env);
  } else {
    env.stamped = false;
    env.score = 0;
  }
  env.finished = true;
  totalScore += env.score;
  updateHud();
  updateStampBtn();
  // Brief delay before the next envelope so the player sees the result.
  const myGen = gen.current();
  window.setTimeout(() => {
    if (!gen.isCurrent(myGen)) return;
    if (state !== 'playing') return;
    nextEnvelope();
  }, opts.stamped ? 900 : 600);
}

function finishRound(): void {
  state = 'roundOver';
  commitBest(totalScore);
  updateHud();
  updateStampBtn();
  showOverlayWith(
    `Tur ${round} bitti`,
    `Tur skoru: ${totalScore}\nEn iyi tek tur: ${best}\nBir sonraki tur daha zor.`,
    `Tur ${round + 1} →`,
  );
}

function startNextRound(): void {
  round++;
  envelopeIdx = 0;
  totalScore = 0;
  state = 'playing';
  hideOverlay();
  nextEnvelope();
}

function startSession(): void {
  if (state !== 'ready' && state !== 'gameover') return;
  round = 1;
  envelopeIdx = 0;
  totalScore = 0;
  state = 'playing';
  hideOverlay();
  nextEnvelope();
}

// ---- HUD ----

function updateHud(): void {
  scoreEl.textContent = String(totalScore);
  roundEl.textContent = String(round);
  const idxDisplay = Math.min(envelopeIdx, ENVELOPES_PER_ROUND);
  letterEl.textContent = `${idxDisplay}/${ENVELOPES_PER_ROUND}`;
  bestEl.textContent = best > 0 ? String(best) : '—';
}

function updateStampBtn(): void {
  const canStamp =
    state === 'playing' &&
    !!env &&
    env.hasPool &&
    !env.dripping &&
    !env.finished &&
    !env.stamped;
  stampBtn.disabled = !canStamp;
}

// ---- Overlay ----

function showOverlayWith(title: string, msg: string, actionLabel: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  overlayAction.textContent = actionLabel;
  showOverlayEl(overlay);
  updateStampBtn();
  try {
    overlayAction.focus({ preventScroll: true });
  } catch {
    /* ignore */
  }
}

function hideOverlay(): void {
  hideOverlayEl(overlay);
  updateStampBtn();
}

// ---- Reset ----

function reset(): void {
  gen.bump();
  stopLoop();
  state = 'ready';
  round = 1;
  envelopeIdx = 0;
  totalScore = 0;
  pointerHeld = false;
  pointerId = null;
  stampAnimStart = 0;
  env = newEnvelope();
  // Show the first envelope behind the overlay so the canvas is not blank
  // before the player taps Başla (PITFALLS#invisible-boot).
  updateHud();
  // We still need a frame to display it.
  startLoop();
  showOverlayWith(
    'Mühür',
    'Eski bir yazıhanedesin. Mektupları balmumu damgasıyla mühürle.\nMumu hedefin üzerine getir, basılı tut → damla, balmumu yeşil banda gelince Damgala\'ya bas.\nKonum, boyut ve ısı — üçü birden puanlar.',
    'Başla',
  );
}

// ---- Loop ----

function startLoop(): void {
  if (animHandle !== null) return;
  const myGen = gen.current();
  lastFrameMs = performance.now();
  const loop = (now: number): void => {
    if (!gen.isCurrent(myGen)) {
      animHandle = null;
      return;
    }
    const dt = Math.max(0, Math.min(0.05, (now - lastFrameMs) / 1000));
    lastFrameMs = now;
    if (state === 'playing' && env && !env.finished) {
      // Drip / cool / timer
      if (pointerHeld && mouseInside && !env.stamped) {
        if (!env.hasPool) {
          env.hasPool = true;
          env.poolX = clamp(
            mouseX,
            ENVELOPE_X + 12,
            ENVELOPE_X + ENVELOPE_W - 12,
          );
          env.poolY = clamp(
            mouseY,
            ENVELOPE_Y + 16,
            ENVELOPE_Y + ENVELOPE_H - 16,
          );
          env.poolR = POOL_MIN_R;
        }
        env.dripping = true;
        env.poolR = Math.min(POOL_MAX_R, env.poolR + POOL_GROW_PER_SEC * dt);
        env.poolTemp = 100; // stays hot while dripping
      } else {
        if (env.hasPool && env.dripping) {
          env.dripping = false;
          updateStampBtn();
        }
      }
      // Cooling
      if (env.hasPool && !env.dripping) {
        env.poolTemp = Math.max(0, env.poolTemp - COOL_PER_SEC * dt);
      }
      startEnvelopeTimerTick(dt);
      updateStampBtn();
    }
    draw(now);
    animHandle = requestAnimationFrame(loop);
  };
  animHandle = requestAnimationFrame(loop);
}

function stopLoop(): void {
  if (animHandle !== null) {
    cancelAnimationFrame(animHandle);
    animHandle = null;
  }
}

// ---- Input ----

function canvasPoint(e: PointerEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const sx = canvas.width / rect.width;
  const sy = canvas.height / rect.height;
  return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy };
}

function onPointerMove(e: PointerEvent): void {
  const p = canvasPoint(e);
  mouseX = p.x;
  mouseY = p.y;
  mouseInside =
    p.x >= 0 && p.x <= W && p.y >= 0 && p.y <= H;
  e.preventDefault();
}

function onPointerDown(e: PointerEvent): void {
  if (state !== 'playing') return;
  if (!env || env.finished || env.stamped) return;
  if (pointerId !== null) return;
  const p = canvasPoint(e);
  mouseX = p.x;
  mouseY = p.y;
  mouseInside = true;
  // Reject press if it's on the overlay area (overlay is z-index: 10 so it
  // intercepts pointerdown when visible — but we double-check state above).
  // Reject if outside the envelope's drip-able area.
  if (mouseY < ENVELOPE_Y + 16 || mouseY > ENVELOPE_Y + ENVELOPE_H - 16) {
    return;
  }
  if (mouseX < ENVELOPE_X + 12 || mouseX > ENVELOPE_X + ENVELOPE_W - 12) {
    return;
  }
  // If pool already exists, second press = nothing happens (player should
  // hit stamp instead).
  if (env.hasPool) return;
  pointerHeld = true;
  pointerId = e.pointerId;
  e.preventDefault();
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {
    /* ignore */
  }
}

function onPointerUp(e: PointerEvent): void {
  if (pointerId !== null && e.pointerId !== pointerId) return;
  pointerHeld = false;
  pointerId = null;
  e.preventDefault();
}

function onPointerCancel(): void {
  pointerHeld = false;
  pointerId = null;
}

function onPointerLeave(): void {
  mouseInside = false;
}

function tryStamp(): void {
  if (state !== 'playing') return;
  if (!env || env.finished || env.stamped || !env.hasPool || env.dripping)
    return;
  env.stamped = true;
  env.score = scoreEnvelope(env);
  // trigger stamp animation
  stampAnimStart = performance.now();
  // finish after a short pause to show animation
  const myGen = gen.current();
  totalScore += env.score;
  env.finished = true;
  updateHud();
  updateStampBtn();
  window.setTimeout(() => {
    if (!gen.isCurrent(myGen)) return;
    if (state !== 'playing') return;
    nextEnvelope();
  }, 900);
}

function onKey(e: KeyboardEvent): void {
  const k = e.key;
  if (k === 'r' || k === 'R') {
    reset();
    e.preventDefault();
    return;
  }
  if (k === ' ' || k === 'Spacebar' || k === 'Enter') {
    if (state === 'ready') {
      startSession();
    } else if (state === 'roundOver') {
      startNextRound();
    } else if (state === 'playing') {
      tryStamp();
    }
    e.preventDefault();
  }
}

// ---- Init ----

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  roundEl = document.querySelector<HTMLElement>('#round')!;
  letterEl = document.querySelector<HTMLElement>('#letter')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  stampBtn = document.querySelector<HTMLButtonElement>('#stamp')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayAction = document.querySelector<HTMLButtonElement>('#overlay-action')!;

  best = loadBest();

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);
  canvas.addEventListener('pointerleave', onPointerLeave);

  stampBtn.addEventListener('click', (e) => {
    if (state === 'playing') tryStamp();
    e.preventDefault();
  });
  restartBtn.addEventListener('click', reset);
  overlayAction.addEventListener('click', () => {
    if (state === 'ready' || state === 'gameover') {
      startSession();
    } else if (state === 'roundOver') {
      startNextRound();
    }
  });

  window.addEventListener('keydown', onKey);

  reset();
}

export const game = defineGame({ init, reset });
