import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import {
  showOverlay as showOverlayEl,
  hideOverlay as hideOverlayEl,
} from '@shared/overlay';

// İz Sürdür: a dot rides a hidden curve from left to right. For a brief
// visibility window the trail and dot are drawn; then the trail fades and
// the dot disappears. The player must click on the vertical target line at
// the y where they think the dot will cross. After the click the hidden
// segment animates so the player learns the answer.
//
// PITFALLS guarded:
// - unguarded-storage: safeRead/safeWrite wrap localStorage.
// - stale-async-callback: gen.bump() in reset()/new round invalidates the
//   in-flight RAF chain (token captured at schedule time, not call time —
//   PITFALLS#stale-async-callback).
// - overlay-input-leak: every handler checks the explicit `state` enum.
// - visual-vs-hitbox: the target line x is one constant used by both the
//   draw call and the score evaluator.
// - hud-counter-synced-only-at-lifecycle-edges: updateHud() runs on every
//   score change, not just round boundaries.
// - missing-overlay-css: .overlay-- hidden visual rules ship in the css
//   sibling file.

const STORAGE_BEST = 'iz-surdur.best';

const CANVAS_W = 520;
const CANVAS_H = 380;

// Playfield padding for the curve (canvas px). The dot enters at PAD_LEFT
// and rides toward CANVAS_W. The target line lives between TARGET_MIN_X
// and TARGET_MAX_X depending on level.
const PAD_TOP = 30;
const PAD_BOTTOM = 30;
const PAD_LEFT = 30;
const Y_MIN = PAD_TOP;
const Y_MAX = CANVAS_H - PAD_BOTTOM;
const Y_MID = (Y_MIN + Y_MAX) / 2;
const Y_AMP = (Y_MAX - Y_MIN) / 2;

const TARGET_MIN_X = 380;
const TARGET_MAX_X = 480;
const CLICK_TOLERANCE_X = 28; // how far horizontally a click is accepted from the target line.

// Per-level tuning. The visibility window shrinks with level; the target
// line walks slightly right; curves grow more complex from a curated pool.
const BASE_VIS_FRACTION = 0.55; // fraction of the playfield revealed before hiding.
const VIS_DECAY = 0.045;        // each level shaves this much off the fraction.
const MIN_VIS_FRACTION = 0.22;
const REVEAL_ANIM_MS = 700;     // how long the hidden segment takes to draw on reveal.

// Failure: 3 consecutive misses (= 0 points awarded) ends the run.
const MAX_MISS_STREAK = 3;
const POINTS_PERFECT = 100;
const POINTS_MIN = 10; // minimum award when within MAX_ERR_PX.
const MAX_ERR_PX = 80; // beyond this → 0 points.
const PERFECT_PX = 8;  // within → 100.

type State = 'ready' | 'observing' | 'awaiting-guess' | 'revealing' | 'gameover';

// A curve is parameterized by progress t in [0, 1]. yAt(t) returns canvas y.
type CurveSpec = {
  label: string;
  yAt: (t: number) => number;
};

const gen = createGenToken();

let state: State = 'ready';
let score = 0;
let best = 0;
let level = 1;
let missStreak = 0;

let curve: CurveSpec = makeCurve(1);
let targetX = TARGET_MIN_X;       // x of the vertical guess line.
let visFraction = BASE_VIS_FRACTION; // fraction of [PAD_LEFT, CANVAS_W] revealed before hide.

let revealProgress = 0;           // 0..1 during the 'observing' phase (visible trail).
let observeStart = 0;             // performance.now() reference.
const OBSERVE_DURATION_MS = 1500; // wall-clock time for the visible window to fill.

// True crossing y at targetX, cached so the curve definition isn't re-evaluated
// during scoring / drawing.
let crossingY = 0;

// Player guess (canvas y), drawn after they click and during reveal.
let guessY: number | null = null;
let lastRoundPoints = 0;
let lastRoundErr = 0;

// Reveal animation: from the last visible point (at visFraction) to t=1
// across REVEAL_ANIM_MS, plus a hold of REVEAL_HOLD_MS for the player to read.
let revealStart = 0;
const REVEAL_HOLD_MS = 800;
let canAdvance = false;           // turns true after reveal+hold; Space/Enter/click advances.

let rafHandle: number | null = null;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let levelEl!: HTMLElement;
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

function clampY(y: number): number {
  return clamp(y, Y_MIN, Y_MAX);
}

// xAtT: t=0 → PAD_LEFT, t=1 → CANVAS_W (right edge). Pure mapping helper so
// the curve definition + the draw loop + the scoring share one t-coordinate.
function xAtT(t: number): number {
  return PAD_LEFT + (CANVAS_W - PAD_LEFT) * t;
}

function tAtX(x: number): number {
  return (x - PAD_LEFT) / (CANVAS_W - PAD_LEFT);
}

// makeCurve(level): build a curve appropriate to the current level. Families:
// 1: pure line (slope, intercept)
// 2: parabola
// 3: single sine
// 4: damped oscillation
// 5+: composite (sine + linear drift, or two sines).
// Bigger level → larger amplitudes / higher frequency, but always clamped to
// the playfield so the dot never disappears off the top/bottom.
function makeCurve(lvl: number): CurveSpec {
  // Pick a family deterministically by level for ramp-up; later levels mix.
  const familyBuckets: number[] = [];
  if (lvl <= 1) familyBuckets.push(0, 0, 1);              // mostly line, a bit of parabola.
  else if (lvl === 2) familyBuckets.push(0, 1, 1, 2);     // line/parabola/sine.
  else if (lvl === 3) familyBuckets.push(1, 2, 2, 3);     // parabola/sine/damped.
  else if (lvl === 4) familyBuckets.push(2, 2, 3, 4);     // sine/damped/composite.
  else familyBuckets.push(2, 3, 4, 4);                    // mostly hard from level 5+.
  const family = familyBuckets[Math.floor(Math.random() * familyBuckets.length)]!;

  // Difficulty scaling for amplitude / frequency.
  const ampScale = clamp(0.55 + lvl * 0.06, 0.55, 0.95);
  const freqScale = clamp(0.8 + lvl * 0.1, 0.8, 1.8);

  switch (family) {
    case 0: {
      // Linear: y = a*t + b, mapped into playfield. Slope sign random.
      const y0 = rand(Y_MIN + 40, Y_MAX - 40);
      const slope = rand(-Y_AMP * 0.9, Y_AMP * 0.9);
      return {
        label: 'doğru',
        yAt: (t) => clampY(y0 + slope * (t - 0.5) * 2),
      };
    }
    case 1: {
      // Parabola: y = a*(t-t0)^2 + b. Opens up or down, vertex anywhere.
      const t0 = rand(0.2, 0.8);
      const baseY = rand(Y_MIN + 40, Y_MAX - 40);
      const a = rand(-Y_AMP * 1.6, Y_AMP * 1.6);
      return {
        label: 'parabol',
        yAt: (t) => {
          const d = t - t0;
          return clampY(baseY + a * d * d);
        },
      };
    }
    case 2: {
      // Pure sine: y = mid + A*sin(2π*f*t + phi).
      const A = Y_AMP * rand(0.35, 0.7) * ampScale;
      const cycles = rand(0.6, 1.4) * freqScale;
      const phi = rand(0, Math.PI * 2);
      const mid = Y_MID + rand(-Y_AMP * 0.15, Y_AMP * 0.15);
      return {
        label: 'sinüs',
        yAt: (t) => clampY(mid + A * Math.sin(2 * Math.PI * cycles * t + phi)),
      };
    }
    case 3: {
      // Damped oscillation: y = mid + A * exp(-k*t) * cos(2π*f*t + phi).
      // Visible portion shows decaying amplitude; player has to extrapolate.
      const A = Y_AMP * rand(0.7, 0.9);
      const k = rand(1.2, 2.4);
      const cycles = rand(1.3, 2.0) * freqScale;
      const phi = rand(0, Math.PI * 2);
      const mid = Y_MID + rand(-Y_AMP * 0.1, Y_AMP * 0.1);
      return {
        label: 'sönen dalga',
        yAt: (t) => clampY(mid + A * Math.exp(-k * t) * Math.cos(2 * Math.PI * cycles * t + phi)),
      };
    }
    case 4:
    default: {
      // Composite: sine + linear drift, or sum of two sines.
      const useDrift = Math.random() < 0.5;
      if (useDrift) {
        const A = Y_AMP * rand(0.3, 0.5) * ampScale;
        const cycles = rand(0.8, 1.5) * freqScale;
        const phi = rand(0, Math.PI * 2);
        const driftBase = rand(Y_MIN + 50, Y_MAX - 50);
        const driftSlope = rand(-Y_AMP * 0.7, Y_AMP * 0.7);
        return {
          label: 'sinüs + sürüklenme',
          yAt: (t) =>
            clampY(driftBase + driftSlope * (t - 0.5) * 2 + A * Math.sin(2 * Math.PI * cycles * t + phi)),
        };
      } else {
        const A1 = Y_AMP * rand(0.25, 0.45) * ampScale;
        const A2 = Y_AMP * rand(0.15, 0.3) * ampScale;
        const f1 = rand(0.7, 1.2) * freqScale;
        const f2 = rand(1.8, 2.6) * freqScale;
        const phi1 = rand(0, Math.PI * 2);
        const phi2 = rand(0, Math.PI * 2);
        const mid = Y_MID + rand(-Y_AMP * 0.1, Y_AMP * 0.1);
        return {
          label: 'iki sinüs',
          yAt: (t) =>
            clampY(mid + A1 * Math.sin(2 * Math.PI * f1 * t + phi1) + A2 * Math.sin(2 * Math.PI * f2 * t + phi2)),
        };
      }
    }
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
  levelEl.textContent = String(level);
}

function showReadyOverlay(): void {
  overlayTitle.textContent = 'İz Sürdür';
  overlayMsg.textContent =
    'Bir nokta gizli bir eğri boyunca soldan sağa süzülür.\n' +
    'İlk birkaç saniye iz görünür — eğrinin türünü oku.\n' +
    'İz kaybolunca sağdaki dikey hedef çizgisinde noktanın geçeceği yüksekliğe tıkla.\n' +
    'Tahminin gerçeğe ne kadar yakınsa o kadar puan. 3 tur üst üste 0 puanla biter.';
  overlayBtn.textContent = 'Başla';
  showOverlayEl(overlay);
}

function showGameOverOverlay(): void {
  overlayTitle.textContent = 'Tur bitti';
  const fresh = score > 0 && score === best;
  overlayMsg.textContent =
    `Skor: ${score}` +
    (fresh ? '  ·  Yeni rekor!' : `\nRekor: ${best}`) +
    '\n\nBOŞLUK / Enter ile tekrar dene.';
  overlayBtn.textContent = 'Tekrar dene';
  showOverlayEl(overlay);
}

function configureForLevel(): void {
  visFraction = clamp(BASE_VIS_FRACTION - (level - 1) * VIS_DECAY, MIN_VIS_FRACTION, BASE_VIS_FRACTION);
  // Target line walks right with level so the player has to extrapolate further.
  const span = TARGET_MAX_X - TARGET_MIN_X;
  const t = clamp((level - 1) / 6, 0, 1);
  targetX = TARGET_MIN_X + span * t;
}

function newRound(): void {
  configureForLevel();
  curve = makeCurve(level);
  crossingY = curve.yAt(tAtX(targetX));
  revealProgress = 0;
  guessY = null;
  observeStart = performance.now();
  state = 'observing';
  updateHud();
  hideOverlayEl(overlay);
  startLoop();
}

function startLoop(): void {
  if (rafHandle !== null) return;
  const myGen = gen.current();
  const tick = (ts: number) => {
    rafHandle = null;
    if (!gen.isCurrent(myGen)) return; // PITFALLS#stale-async-callback
    step(ts);
    if (state !== 'ready' && state !== 'gameover') {
      rafHandle = requestAnimationFrame(tick);
    }
  };
  rafHandle = requestAnimationFrame(tick);
}

function step(ts: number): void {
  if (state === 'observing') {
    const elapsed = ts - observeStart;
    revealProgress = clamp(elapsed / OBSERVE_DURATION_MS, 0, visFraction);
    if (elapsed >= OBSERVE_DURATION_MS) {
      // Visibility window done → ask for guess.
      state = 'awaiting-guess';
    }
  } else if (state === 'revealing') {
    const elapsed = ts - revealStart;
    const animT = clamp(elapsed / REVEAL_ANIM_MS, 0, 1);
    revealProgress = visFraction + (1 - visFraction) * animT;
    if (elapsed >= REVEAL_ANIM_MS + REVEAL_HOLD_MS) {
      canAdvance = true;
    }
  }
  draw();
}

function draw(): void {
  // Background.
  ctx.fillStyle = '#0b0e14';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  // Mid grid.
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 1; i < 6; i++) {
    const y = Y_MIN + (i * (Y_MAX - Y_MIN)) / 6;
    ctx.moveTo(PAD_LEFT, y);
    ctx.lineTo(CANVAS_W, y);
  }
  ctx.stroke();

  // Frame.
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 1;
  ctx.strokeRect(PAD_LEFT, Y_MIN, CANVAS_W - PAD_LEFT - 8, Y_MAX - Y_MIN);

  // Visible trail (up to revealProgress fraction). The trail is bright while
  // observing, fades to grey while awaiting guess, and the hidden portion is
  // drawn in accent during reveal.
  const visT = Math.min(revealProgress, visFraction);
  drawCurveSegment(0, visT, state === 'observing' ? '#7dd3fc' : 'rgba(125,211,252,0.30)', 2);

  if (state === 'revealing' && revealProgress > visFraction) {
    drawCurveSegment(visFraction, revealProgress, '#22d3ee', 2);
  }

  // Target line.
  const targetColor = state === 'awaiting-guess' ? '#facc15' : 'rgba(250,204,21,0.45)';
  ctx.strokeStyle = targetColor;
  ctx.lineWidth = state === 'awaiting-guess' ? 2 : 1.5;
  ctx.beginPath();
  ctx.moveTo(targetX, Y_MIN);
  ctx.lineTo(targetX, Y_MAX);
  ctx.stroke();
  ctx.lineWidth = 1;

  // Label for target line.
  ctx.fillStyle = 'rgba(250,204,21,0.75)';
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('hedef', targetX, Y_MIN - 12);

  // Dot at current position. Bright during observing, hidden during awaiting,
  // back to view during reveal at the actual end position.
  if (state === 'observing') {
    const x = xAtT(visT);
    const y = curve.yAt(visT);
    drawDot(x, y, '#fde68a', 6);
  } else if (state === 'revealing') {
    const x = xAtT(revealProgress);
    const y = curve.yAt(revealProgress);
    drawDot(x, y, '#fde68a', 5);
  }

  // Guess marker (drawn from awaiting-guess onward).
  if (guessY !== null && (state === 'awaiting-guess' || state === 'revealing')) {
    const gy = guessY;
    ctx.strokeStyle = '#f472b6';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(targetX - 14, gy);
    ctx.lineTo(targetX + 14, gy);
    ctx.stroke();
    ctx.lineWidth = 1;
  }

  // True crossing marker (after reveal).
  if (state === 'revealing' && revealProgress >= 1) {
    ctx.fillStyle = '#22d3ee';
    ctx.beginPath();
    ctx.arc(targetX, crossingY, 6, 0, Math.PI * 2);
    ctx.fill();
  }

  // Status text.
  ctx.fillStyle = 'rgba(255,255,255,0.65)';
  ctx.font = '12px system-ui, sans-serif';
  ctx.textAlign = 'left';
  if (state === 'observing') {
    ctx.fillText('İzi gözle…', PAD_LEFT + 6, CANVAS_H - 8);
  } else if (state === 'awaiting-guess') {
    ctx.fillText('Hedef çizgisinde tıkla', PAD_LEFT + 6, CANVAS_H - 8);
  } else if (state === 'revealing') {
    const txt = `+${lastRoundPoints} puan  ·  sapma ${Math.round(lastRoundErr)} px`;
    ctx.fillText(txt, PAD_LEFT + 6, CANVAS_H - 8);
    if (canAdvance) {
      ctx.fillStyle = 'rgba(125,211,252,0.85)';
      ctx.textAlign = 'right';
      ctx.fillText('Boşluk / Enter / tıkla — sonraki tur', CANVAS_W - 14, CANVAS_H - 8);
    }
  }
}

function drawCurveSegment(tStart: number, tEnd: number, stroke: string, width: number): void {
  if (tEnd <= tStart) return;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = width;
  ctx.beginPath();
  const STEPS = 80;
  for (let i = 0; i <= STEPS; i++) {
    const t = tStart + (tEnd - tStart) * (i / STEPS);
    const x = xAtT(t);
    const y = curve.yAt(t);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.lineWidth = 1;
}

function drawDot(x: number, y: number, color: string, r: number): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

function pointsForError(errPx: number): number {
  const e = Math.abs(errPx);
  if (e <= PERFECT_PX) return POINTS_PERFECT;
  if (e >= MAX_ERR_PX) return 0;
  // Linear ramp from (PERFECT_PX, POINTS_PERFECT) to (MAX_ERR_PX, POINTS_MIN-1).
  // Above MAX_ERR_PX the player gets 0 and a miss-streak tick.
  const t = (e - PERFECT_PX) / (MAX_ERR_PX - PERFECT_PX);
  const raw = POINTS_PERFECT - t * (POINTS_PERFECT - POINTS_MIN);
  return Math.max(POINTS_MIN, Math.round(raw));
}

function onCanvasClick(ev: PointerEvent): void {
  const rect = canvas.getBoundingClientRect();
  const cx = ((ev.clientX - rect.left) / rect.width) * CANVAS_W;
  const cy = ((ev.clientY - rect.top) / rect.height) * CANVAS_H;

  if (state === 'awaiting-guess') {
    // The click is valid anywhere on the canvas vertically; we just snap to
    // the target x and use the click's y. (Allowing any-x click avoids the
    // unreachable-start-state pitfall — the user can be a few px off and
    // still register the guess.)
    if (Math.abs(cx - targetX) > CLICK_TOLERANCE_X * 4) {
      // Way off; ignore so a stray miss-click doesn't waste the round.
      // (Inside CLICK_TOLERANCE_X*4 still registers — generous so mobile is
      // forgiving.)
      return;
    }
    submitGuess(clampY(cy));
  } else if (state === 'revealing' && canAdvance) {
    advanceRound();
  }
}

function submitGuess(y: number): void {
  guessY = y;
  const err = y - crossingY;
  lastRoundErr = Math.abs(err);
  lastRoundPoints = pointsForError(err);
  if (lastRoundPoints === 0) {
    missStreak += 1;
  } else {
    missStreak = 0;
    score += lastRoundPoints;
  }
  commitBest();
  updateHud();

  state = 'revealing';
  revealStart = performance.now();
  canAdvance = false;
}

function advanceRound(): void {
  if (missStreak >= MAX_MISS_STREAK) {
    endGame();
    return;
  }
  // Bump level every 4 successful (non-zero) rounds, soft cap at 9.
  if (lastRoundPoints > 0 && score >= level * 220 && level < 9) {
    level += 1;
  }
  newRound();
}

function endGame(): void {
  state = 'gameover';
  showGameOverOverlay();
}

function onKey(ev: KeyboardEvent): void {
  const k = ev.key;
  if (k === 'r' || k === 'R') {
    reset();
    ev.preventDefault();
    return;
  }
  if (state === 'ready') {
    if (k === ' ' || k === 'Enter') {
      ev.preventDefault();
      startGame();
    }
    return;
  }
  if (state === 'gameover') {
    if (k === ' ' || k === 'Enter') {
      ev.preventDefault();
      reset();
      startGame();
    }
    return;
  }
  if (state === 'revealing' && canAdvance) {
    if (k === ' ' || k === 'Enter') {
      ev.preventDefault();
      advanceRound();
    }
  }
}

function startGame(): void {
  state = 'observing';
  score = 0;
  level = 1;
  missStreak = 0;
  newRound();
}

function reset(): void {
  gen.bump();
  if (rafHandle !== null) {
    cancelAnimationFrame(rafHandle);
    rafHandle = null;
  }
  state = 'ready';
  score = 0;
  level = 1;
  missStreak = 0;
  guessY = null;
  revealProgress = 0;
  updateHud();
  showReadyOverlay();
  draw();
}

function onOverlayBtn(): void {
  if (state === 'ready') {
    startGame();
  } else if (state === 'gameover') {
    reset();
    startGame();
  }
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  levelEl = document.querySelector<HTMLElement>('#level')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  restartBtn.addEventListener('click', () => {
    reset();
  });
  overlayBtn.addEventListener('click', onOverlayBtn);
  canvas.addEventListener('pointerdown', onCanvasClick);
  window.addEventListener('keydown', onKey);

  updateHud();
  showReadyOverlay();
  draw();
}

export const game = defineGame({ init, reset });
