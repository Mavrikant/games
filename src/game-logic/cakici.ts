import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay, hideOverlay, isOverlayHidden } from '@shared/overlay';

const STORAGE_BEST = 'cakici.best';

type State = 'ready' | 'playing' | 'gameover';

// Geometry — single source of truth, per PITFALLS#visual-vs-hitbox.
const CANVAS_W = 560;
const CANVAS_H = 520;

// Pendulum pivot — top centre of the canvas.
const PIVOT_X = CANVAS_W / 2;
const PIVOT_Y = 70;
const PEND_LEN = 330; // pivot to hammer head centre when hanging

// Plank — wooden board sitting near the bottom.
const PLANK_X = 60;
const PLANK_Y = 410;
const PLANK_W = CANVAS_W - 120;
const PLANK_H = 60;

// Nail heads sit at the top of the plank.
const NAIL_HEAD_R = 11;
const NAIL_TOP_Y = PLANK_Y + 6; // visual top of a fully-flush head
const NAIL_TALL_Y = NAIL_TOP_Y - 26; // sticking-out top

// Strike scoring tolerances (in radians of angular distance from sweet angle).
// At pendulum centre, these convert to ≈40 ms perfect / ≈85 ms bent windows
// — tight enough to skill-test, wide enough that aiming at edge-dwell nails
// gives the player a generous buffer.
const TOL_PERFECT = 0.13; // ≈7.4°
const TOL_BENT = 0.27; // ≈15.5°
// Anything beyond TOL_BENT counts as a clean miss (no contact).

// Pendulum dynamics — base period in seconds; ramped per plank.
const BASE_PERIOD = 2.3;
const PERIOD_FLOOR = 1.35;
const AMP = Math.PI / 2.6; // max swing amplitude (~69°)

const ROUND_SECONDS = 60;

const gen = createGenToken();
let state: State = 'ready';
let score = 0;
let best = 0;
let plankIndex = 1; // 1-based for display

let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let timeEl!: HTMLElement;
let plankEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let overlayEl!: HTMLElement;
let overlayTitleEl!: HTMLElement;
let overlayMsgEl!: HTMLElement;

let timeLeft = ROUND_SECONDS;
let lastFrame = 0;
let rafId = 0;

// Pendulum state
let pendT = 0; // seconds elapsed; phase = pendT / period * 2π
let pendPeriod = BASE_PERIOD;
let dropAnimT = 0; // 0 = idle (hammer at pendulum tip); >0 = striking (extends down)
const DROP_DURATION = 0.32; // total seconds for one strike animation
let dropAtAngle = 0; // angle at moment of release (frozen for animation)
let dropResults: HitResult[] = []; // per-strike feedback

interface Nail {
  x: number; // canvas x coordinate of nail head
  depth: number; // 0..3; 3 = flush
  bent: number; // 0..3; 3 = breaks
  broken: boolean;
  lateralOffset: number; // bent-strike visual offset (px)
  // Sweet angle: hammer head sits exactly over (x, NAIL_TOP_Y) when this angle.
  sweetAngle: number;
  done: boolean; // flush or broken
  flashT: number; // brief highlight after strike: 0..1 fade
  flashKind: 'good' | 'bent' | 'broken' | null;
}
let nails: Nail[] = [];

type StrikeKind = 'perfect' | 'bent' | 'miss';
interface HitResult {
  nailIdx: number; // -1 if miss
  kind: StrikeKind;
  t: number; // age in seconds, for floating text
  text: string;
}
const floatTexts: { x: number; y: number; t: number; text: string; color: string }[] = [];

// Sweet-angle for a nail head at (x, NAIL_TOP_Y) — angle measured from
// straight-down at the pivot, positive to the right.
function sweetAngleFor(x: number): number {
  return Math.atan2(x - PIVOT_X, NAIL_TOP_Y - PIVOT_Y);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function pendAngle(t: number, period: number): number {
  return AMP * Math.sin((t / period) * Math.PI * 2);
}

function makeNails(idx: number): Nail[] {
  // Plank N: count and spacing/period ramp.
  // 1: 3 nails slow; 2: 3 nails slightly faster; 3: 4 nails; 4-6: 4 nails faster;
  // 7+: 5 nails fast.
  let count: number;
  let period: number;
  if (idx <= 1) {
    count = 3;
    period = BASE_PERIOD;
  } else if (idx === 2) {
    count = 3;
    period = BASE_PERIOD - 0.2;
  } else if (idx <= 6) {
    count = 4;
    period = BASE_PERIOD - 0.2 - (idx - 2) * 0.12;
  } else {
    count = 5;
    period = Math.max(PERIOD_FLOOR, BASE_PERIOD - 0.6 - (idx - 7) * 0.08);
  }
  pendPeriod = clamp(period, PERIOD_FLOOR, BASE_PERIOD + 0.4);

  // Evenly distribute nails on the plank with margins.
  const margin = 60;
  const inner = PLANK_W - margin * 2;
  const out: Nail[] = [];
  for (let i = 0; i < count; i++) {
    const tx = count === 1 ? 0.5 : i / (count - 1);
    const x = PLANK_X + margin + inner * tx;
    out.push({
      x,
      depth: 0,
      bent: 0,
      broken: false,
      lateralOffset: 0,
      sweetAngle: sweetAngleFor(x),
      done: false,
      flashT: 0,
      flashKind: null,
    });
  }
  return out;
}

function newPlank(): void {
  nails = makeNails(plankIndex);
}

function setMsg(title: string, msg: string): void {
  overlayTitleEl.textContent = title;
  overlayMsgEl.textContent = msg;
}

function startGame(): void {
  gen.bump();
  state = 'playing';
  score = 0;
  plankIndex = 1;
  timeLeft = ROUND_SECONDS;
  pendT = 0;
  dropAnimT = 0;
  floatTexts.length = 0;
  newPlank();
  hideOverlay(overlayEl);
  syncHud();
  lastFrame = performance.now();
  const myGen = gen.current();
  cancelAnimationFrame(rafId);
  const loop = (now: number): void => {
    if (!gen.isCurrent(myGen)) return;
    const dt = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;
    tick(dt);
    draw();
    if (state === 'playing') {
      rafId = requestAnimationFrame(loop);
    }
  };
  rafId = requestAnimationFrame(loop);
}

function endGame(reason: 'time'): void {
  state = 'gameover';
  commitBest();
  setMsg(
    reason === 'time' ? 'Süre bitti!' : 'Bitti',
    `Skor: ${score}\nEn iyi: ${best}\n\nYeniden başlamak için Boşluk'a bas veya tıkla.`,
  );
  showOverlay(overlayEl);
  syncHud();
}

function commitBest(): void {
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
}

function syncHud(): void {
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
  timeEl.textContent = timeLeft.toFixed(1);
  plankEl.textContent = String(plankIndex);
}

function tick(dt: number): void {
  if (state !== 'playing') return;

  // Time pressure.
  timeLeft -= dt;
  if (timeLeft <= 0) {
    timeLeft = 0;
    syncHud();
    endGame('time');
    return;
  }

  // Pendulum — only advances when not mid-strike (frozen at drop angle).
  if (dropAnimT <= 0) {
    pendT += dt;
  } else {
    dropAnimT -= dt;
    if (dropAnimT <= 0) {
      dropAnimT = 0;
      dropResults = [];
      // Check if plank is fully done -> advance.
      if (nails.every((n) => n.done)) {
        plankIndex++;
        newPlank();
      }
    }
  }

  // Decay flashes + floating texts.
  for (const n of nails) {
    if (n.flashT > 0) {
      n.flashT = Math.max(0, n.flashT - dt * 2.4);
      if (n.flashT === 0) n.flashKind = null;
    }
  }
  for (let i = floatTexts.length - 1; i >= 0; i--) {
    const f = floatTexts[i]!;
    f.t += dt;
    if (f.t > 0.95) floatTexts.splice(i, 1);
  }

  // Sync time display each frame (cheap; element is just text).
  timeEl.textContent = timeLeft.toFixed(1);
}

function hammerHeadXY(angle: number, extra: number): { x: number; y: number } {
  // extra: extension beyond PEND_LEN during a strike (px).
  const L = PEND_LEN + extra;
  return { x: PIVOT_X + L * Math.sin(angle), y: PIVOT_Y + L * Math.cos(angle) };
}

function triggerStrike(): void {
  if (state !== 'playing') return;
  if (dropAnimT > 0) return; // already mid-strike

  const angle = pendAngle(pendT, pendPeriod);
  dropAtAngle = angle;
  dropAnimT = DROP_DURATION;

  // Find the closest live nail to this angle.
  let bestIdx = -1;
  let bestDist = Infinity;
  for (let i = 0; i < nails.length; i++) {
    const n = nails[i]!;
    if (n.done) continue;
    const d = Math.abs(angle - n.sweetAngle);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }

  // Resolve outcome.
  let kind: StrikeKind = 'miss';
  if (bestIdx >= 0) {
    if (bestDist <= TOL_PERFECT) kind = 'perfect';
    else if (bestDist <= TOL_BENT) kind = 'bent';
  }

  dropResults = [];
  if (kind === 'miss' || bestIdx < 0) {
    dropResults.push({ nailIdx: -1, kind: 'miss', t: 0, text: 'Iska' });
    floatTexts.push({
      x: PIVOT_X + (PEND_LEN + 30) * Math.sin(angle),
      y: PIVOT_Y + (PEND_LEN + 30) * Math.cos(angle) - 20,
      t: 0,
      text: 'Iska',
      color: '#9aa0aa',
    });
    return;
  }

  const n = nails[bestIdx]!;
  if (kind === 'perfect') {
    n.depth = Math.min(3, n.depth + 1);
    n.flashT = 1;
    n.flashKind = 'good';
    floatTexts.push({
      x: n.x,
      y: NAIL_TOP_Y - 28,
      t: 0,
      text: 'Tam!',
      color: '#7be08a',
    });
    if (n.depth >= 3) {
      n.done = true;
      score += 10;
    }
  } else {
    // bent
    n.depth = Math.min(3, n.depth + 1);
    n.bent += 1;
    // Lateral push: direction follows which side of sweetAngle the strike was on.
    const dir = angle < n.sweetAngle ? -1 : 1;
    n.lateralOffset = clamp(n.lateralOffset + dir * (6 + n.bent * 2), -20, 20);
    n.flashT = 1;
    n.flashKind = 'bent';
    floatTexts.push({
      x: n.x,
      y: NAIL_TOP_Y - 28,
      t: 0,
      text: 'Eğri',
      color: '#f4c25b',
    });
    if (n.bent >= 3) {
      n.broken = true;
      n.done = true;
      n.flashKind = 'broken';
      score = Math.max(0, score - 4);
      floatTexts.push({
        x: n.x,
        y: NAIL_TOP_Y - 44,
        t: 0,
        text: 'Kırıldı',
        color: '#e06464',
      });
    } else if (n.depth >= 3) {
      // Edge case: bent strikes still dropped depth to 3 — count as flushed
      // (you still drove it but it's crooked); modest score.
      n.done = true;
      score += 4;
    }
  }
  syncHud();
}

// ── Drawing ──────────────────────────────────────────────────────────────

function draw(): void {
  ctx.save();
  ctx.fillStyle = '#0d1014';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  // Subtle workshop ambience: vertical wall planks.
  ctx.save();
  ctx.globalAlpha = 0.5;
  for (let i = 0; i < 6; i++) {
    const x = (i * CANVAS_W) / 6;
    ctx.fillStyle = i % 2 === 0 ? '#101319' : '#0c0f14';
    ctx.fillRect(x, 0, CANVAS_W / 6 + 1, PLANK_Y - 20);
  }
  ctx.restore();

  // Workshop bench (a little ledge under the plank).
  ctx.fillStyle = '#22171042';
  ctx.fillRect(0, PLANK_Y + PLANK_H + 10, CANVAS_W, CANVAS_H - PLANK_Y - PLANK_H - 10);

  // Plank.
  drawPlank();

  // Nails.
  for (const n of nails) drawNail(n);

  // Sweet-angle arrows for live nails.
  for (const n of nails) {
    if (n.done) continue;
    drawSweetArrow(n);
  }

  // Pendulum.
  drawPendulum();

  // Floating text feedback.
  drawFloatTexts();

  ctx.restore();
}

function drawPlank(): void {
  ctx.fillStyle = '#6b3f1f';
  ctx.fillRect(PLANK_X, PLANK_Y, PLANK_W, PLANK_H);
  ctx.fillStyle = '#5a3318';
  ctx.fillRect(PLANK_X, PLANK_Y, PLANK_W, 6);
  ctx.fillStyle = '#7a4c28';
  ctx.fillRect(PLANK_X, PLANK_Y + PLANK_H - 6, PLANK_W, 6);
  // Grain lines.
  ctx.strokeStyle = 'rgba(0,0,0,0.25)';
  ctx.lineWidth = 1;
  for (let y = PLANK_Y + 14; y < PLANK_Y + PLANK_H - 4; y += 10) {
    ctx.beginPath();
    ctx.moveTo(PLANK_X + 6, y);
    ctx.lineTo(PLANK_X + PLANK_W - 6, y + (Math.sin(y) * 3));
    ctx.stroke();
  }
  // Edges.
  ctx.strokeStyle = '#1a1b20';
  ctx.lineWidth = 2;
  ctx.strokeRect(PLANK_X + 1, PLANK_Y + 1, PLANK_W - 2, PLANK_H - 2);
}

function drawNail(n: Nail): void {
  // Visual top of head: as depth grows, head sinks from NAIL_TALL_Y -> NAIL_TOP_Y.
  const depthFrac = n.depth / 3;
  const headY = NAIL_TALL_Y + (NAIL_TOP_Y - NAIL_TALL_Y) * depthFrac;
  const lateral = n.lateralOffset;

  // Shaft (from head down into the plank).
  ctx.save();
  ctx.translate(n.x, headY);
  // Tilt direction proportional to lateral offset.
  const tilt = lateral * 0.05;
  ctx.rotate(tilt);
  // Shaft
  ctx.fillStyle = n.broken ? '#3a3a3e' : '#8d909a';
  ctx.fillRect(-2, 0, 4, PLANK_Y + PLANK_H - headY + 4);
  // Head
  const headColor = n.broken ? '#54565c' : '#b8bcc6';
  ctx.fillStyle = headColor;
  ctx.beginPath();
  ctx.ellipse(0, 0, NAIL_HEAD_R, NAIL_HEAD_R * 0.55, 0, 0, Math.PI * 2);
  ctx.fill();
  // Inner highlight
  if (!n.broken) {
    ctx.fillStyle = 'rgba(255,255,255,0.32)';
    ctx.beginPath();
    ctx.ellipse(-3, -2, NAIL_HEAD_R * 0.55, NAIL_HEAD_R * 0.25, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // Head outline
  ctx.strokeStyle = '#1c1e23';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.ellipse(0, 0, NAIL_HEAD_R, NAIL_HEAD_R * 0.55, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  // Flash overlay (rim around head)
  if (n.flashT > 0 && n.flashKind) {
    const color =
      n.flashKind === 'good'
        ? '#7be08a'
        : n.flashKind === 'bent'
          ? '#f4c25b'
          : '#e06464';
    ctx.save();
    ctx.globalAlpha = n.flashT;
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(
      n.x,
      headY,
      NAIL_HEAD_R + 4,
      NAIL_HEAD_R * 0.55 + 4,
      0,
      0,
      Math.PI * 2,
    );
    ctx.stroke();
    ctx.restore();
  }

  // Done-flush check mark below head (for completed clean nails)
  if (n.done && !n.broken) {
    ctx.fillStyle = '#7be08a';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('✓', n.x, PLANK_Y + PLANK_H + 22);
  }
  if (n.broken) {
    ctx.fillStyle = '#e06464';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('×', n.x, PLANK_Y + PLANK_H + 22);
  }
}

function drawSweetArrow(n: Nail): void {
  // Small downward arrow above nail head — indicates this nail's sweet target.
  const tip = NAIL_TALL_Y - 16;
  const top = tip - 14;
  ctx.save();
  ctx.fillStyle = '#7be08a';
  ctx.globalAlpha = 0.85;
  ctx.beginPath();
  ctx.moveTo(n.x, tip);
  ctx.lineTo(n.x - 6, top);
  ctx.lineTo(n.x + 6, top);
  ctx.closePath();
  ctx.fill();
  // Sub-tick: dots indicating remaining hits (3 - depth).
  ctx.fillStyle = 'rgba(123,224,138,0.5)';
  const remain = 3 - n.depth;
  for (let i = 0; i < remain; i++) {
    ctx.fillRect(n.x - 6 + i * 6, top - 6, 3, 3);
  }
  ctx.restore();
}

function drawPendulum(): void {
  // Determine current angle.
  let angle: number;
  let extension = 0;
  if (dropAnimT > 0) {
    angle = dropAtAngle;
    // Strike animation: extend then retract.
    const tNorm = 1 - dropAnimT / DROP_DURATION; // 0..1
    // 0..0.5 extend out, 0.5..1 retract
    const eased = tNorm < 0.5 ? tNorm * 2 : 2 - tNorm * 2;
    extension = eased * 60;
  } else {
    angle = pendAngle(pendT, pendPeriod);
  }

  // Cable.
  const head = hammerHeadXY(angle, extension);
  ctx.strokeStyle = '#2b2d33';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(PIVOT_X, PIVOT_Y);
  ctx.lineTo(head.x, head.y);
  ctx.stroke();

  // Pivot point.
  ctx.fillStyle = '#1d1f25';
  ctx.beginPath();
  ctx.arc(PIVOT_X, PIVOT_Y, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#3a3c44';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Hammer head — drawn rotated to match the cable direction.
  ctx.save();
  ctx.translate(head.x, head.y);
  ctx.rotate(angle);
  // Wooden handle
  ctx.fillStyle = '#a07050';
  ctx.fillRect(-5, -34, 10, 28);
  ctx.strokeStyle = '#3a230f';
  ctx.lineWidth = 1.4;
  ctx.strokeRect(-5, -34, 10, 28);
  // Metal head
  ctx.fillStyle = '#444851';
  ctx.fillRect(-22, -8, 44, 24);
  ctx.strokeStyle = '#1c1e23';
  ctx.lineWidth = 1.6;
  ctx.strokeRect(-22, -8, 44, 24);
  // Specular highlight
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.fillRect(-22, -8, 44, 4);
  // Striking face (bottom)
  ctx.fillStyle = '#2a2c32';
  ctx.fillRect(-22, 14, 44, 3);
  ctx.restore();
}

function drawFloatTexts(): void {
  ctx.save();
  ctx.font = 'bold 14px sans-serif';
  ctx.textAlign = 'center';
  for (const f of floatTexts) {
    const a = 1 - f.t / 0.95;
    ctx.globalAlpha = clamp(a, 0, 1);
    ctx.fillStyle = f.color;
    ctx.fillText(f.text, f.x, f.y - f.t * 26);
  }
  ctx.restore();
}

// ── Input ────────────────────────────────────────────────────────────────

function onKey(e: KeyboardEvent): void {
  if (e.key === 'r' || e.key === 'R') {
    e.preventDefault();
    reset();
    return;
  }
  if (e.code === 'Space' || e.key === 'Enter') {
    e.preventDefault();
    if (state === 'ready') {
      startGame();
    } else if (state === 'playing') {
      triggerStrike();
    } else if (state === 'gameover') {
      reset();
      startGame();
    }
  }
}

function onPointerDown(e: PointerEvent): void {
  // Only react to primary button (avoid right-click triggering drops).
  if (e.button !== 0 && e.pointerType === 'mouse') return;
  e.preventDefault();
  if (state === 'ready') {
    startGame();
  } else if (state === 'playing') {
    triggerStrike();
  } else if (state === 'gameover') {
    reset();
    startGame();
  }
}

// ── Lifecycle ────────────────────────────────────────────────────────────

function reset(): void {
  gen.bump();
  cancelAnimationFrame(rafId);
  state = 'ready';
  score = 0;
  plankIndex = 1;
  timeLeft = ROUND_SECONDS;
  pendT = 0;
  dropAnimT = 0;
  floatTexts.length = 0;
  newPlank();
  commitBest();
  syncHud();
  setMsg(
    'Çakıcı',
    'Üstteki çekiç sallanır; her çivinin başının üzerinde küçük yeşil bir ok var — çekiç o oka denk geldiğinde Boşluk veya sol tıkla bırak. Tam üstünde isen çivi temiz çakılır, yamuk vurursan eğrilir. Çiviyi kırma; bütün çivileri çaktıkça yeni bir kalas iner.\n\nBaşlamak için tıkla veya Boşluk’a bas.',
  );
  showOverlay(overlayEl);
  // Render once so the initial frame isn't blank if dev tools opens slowly.
  draw();
}

function init(): void {
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  timeEl = document.querySelector<HTMLElement>('#time')!;
  plankEl = document.querySelector<HTMLElement>('#plank')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  overlayEl = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitleEl = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsgEl = document.querySelector<HTMLElement>('#overlay-msg')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  restartBtn.addEventListener('click', () => {
    reset();
  });

  // Keep overlay clicks driving start/restart even though it sits over canvas.
  overlayEl.addEventListener('pointerdown', (e) => {
    if (isOverlayHidden(overlayEl)) return;
    onPointerDown(e);
  });
  canvas.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('keydown', onKey);

  reset();
}

export const game = defineGame({ init, reset });
