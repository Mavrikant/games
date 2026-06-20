import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';

// PITFALLS guarded:
// - unguarded-storage: safeRead/safeWrite.
// - overlay-input-leak: explicit state enum guards every handler.
// - module-level: all DOM access in init(); defineGame schedules it.
// - stale-async-callback: single RAF; loop checks state before continuing.
// - hud-counter-synced-only-at-lifecycle-edges: aeration/temp/folds HUD
//   are written every frame inside loop(), not just at start/end.
// - visual-vs-hitbox: hook positions, "break" length and "tight fold"
//   length share single MIN/MAX constants used by both draw() and tick().
// - invisible-boot: ready overlay shown immediately on reset(); first
//   pull produces visible stretch within one frame (no hidden buffer).
// - unreachable-start-state: ready/gameover both accept Space, Enter,
//   click, and Start button.
// - designed-lose-condition-not-wired: both break (over-pull) and freeze
//   (temperature ≤ 0) call gameOver explicitly.

const STORAGE_BEST = 'helva-cekme.best';

type State = 'ready' | 'playing' | 'gameover';

// Geometric constants — used by both draw() and physics (pitfall:
// visual-vs-hitbox).  Hook positions slide between MIN and MAX along the
// horizontal axis; "stretched" = hook span ≥ STRETCH_OK.
const HOOK_Y = 230;
const HOOK_X_REST = 0.45;        // fraction of canvas width when folded
const HOOK_X_MAX = 0.97;          // outermost fraction before snap risk
const STRETCH_OK = 0.55;          // span fraction that counts as a stretch
const STRETCH_BREAK = 0.95;       // span fraction that snaps the strand
const PULL_SPEED = 0.55;          // hook fraction / second while pulling
const FOLD_SPEED = 1.6;            // hook fraction / second while releasing

const TEMP_START = 100;
const TEMP_COOL_REST = 1.6;        // °/sec when not pulling
const TEMP_COOL_PULL = 0.7;        // °/sec while pulling (less; heat builds)
const TEMP_COOL_FOLD_BONUS = 0.0;  // (folds don't accelerate cooling)
const TEMP_BRITTLE = 28;           // below: break threshold drops
const AERATION_MAX = 100;
const FOLD_GAIN_BASE = 6;          // % aeration per perfect fold
const STRETCH_BONUS_MAX = 4;       // extra % when stretch was near max

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let tempEl!: HTMLElement;
let foldsEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let startBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;

let state: State = 'ready';
let pulling = false;
let span = HOOK_X_REST;            // current hook-span fraction (rest..max)
let peakSpan = HOOK_X_REST;        // peak span seen since last fold
let aeration = 0;                  // 0..100
let temperature = TEMP_START;
let folds = 0;
let best = 0;
let lastFrame = 0;
let rafId = 0;
let breakPulse = 0;                // visual flash on snap/freeze
let foldPulse = 0;                 // visual flash on successful fold

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  startBtn.textContent = state === 'gameover' ? 'Tekrar dene' : 'Başla';
  showOverlayEl(overlay);
}

function hideOverlay(): void {
  hideOverlayEl(overlay);
}

function syncHud(): void {
  scoreEl.textContent = `%${Math.round(aeration)}`;
  bestEl.textContent = `%${Math.round(best)}`;
  tempEl.textContent = `${Math.max(0, Math.round(temperature))}°`;
  foldsEl.textContent = String(folds);
}

function commitBest(): void {
  if (aeration > best) {
    best = aeration;
    safeWrite(STORAGE_BEST, best);
  }
}

function reset(): void {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
  state = 'ready';
  pulling = false;
  span = HOOK_X_REST;
  peakSpan = HOOK_X_REST;
  aeration = 0;
  temperature = TEMP_START;
  folds = 0;
  breakPulse = 0;
  foldPulse = 0;
  syncHud();
  draw();
  showOverlay(
    'Helva Çekme',
    'BOŞLUK basılı tut: helvayı kancalardan dışarı çek.\nBırak: helva ortaya katlanır, hava içeri girer.\nHedef: %100 hava — soğumadan ve kopmadan.',
  );
}

function start(): void {
  if (state === 'playing') return;
  state = 'playing';
  pulling = false;
  span = HOOK_X_REST;
  peakSpan = HOOK_X_REST;
  aeration = 0;
  temperature = TEMP_START;
  folds = 0;
  breakPulse = 0;
  foldPulse = 0;
  syncHud();
  hideOverlay();
  lastFrame = performance.now();
  rafId = requestAnimationFrame(loop);
}

function gameOver(reason: string, winning: boolean): void {
  if (state !== 'playing') return;
  state = 'gameover';
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
  if (winning) {
    // Cap aeration on win so trophy reads clean.
    aeration = AERATION_MAX;
  }
  commitBest();
  syncHud();
  breakPulse = winning ? 0 : 1;
  draw();
  const head = winning ? 'Helva Hazır!' : 'Tezgâh Boş!';
  showOverlay(
    head,
    `${reason}\nHava: %${Math.round(aeration)}  ·  Rekor: %${Math.round(best)}`,
  );
}

// Aeration gain when releasing back to rest.
function commitFold(stretchedTo: number): void {
  // stretchedTo is the peak span seen during the pull (HOOK_X_REST..HOOK_X_MAX).
  const reach = (stretchedTo - HOOK_X_REST) / (HOOK_X_MAX - HOOK_X_REST);
  if (reach < (STRETCH_OK - HOOK_X_REST) / (HOOK_X_MAX - HOOK_X_REST)) {
    // Short pull — no aeration, slight cool penalty already applied.
    return;
  }
  // Reward stretching close to (but not at) the danger zone.
  // Danger zone starts at STRETCH_BREAK; sweet spot is ~85% reach.
  const sweetReach = (STRETCH_BREAK - 0.05 - HOOK_X_REST) / (HOOK_X_MAX - HOOK_X_REST);
  const closeness = 1 - Math.min(1, Math.abs(reach - sweetReach) / sweetReach);
  const gain = FOLD_GAIN_BASE + STRETCH_BONUS_MAX * closeness;
  aeration = Math.min(AERATION_MAX, aeration + gain);
  folds += 1;
  foldPulse = 1;
  // Folding warms the strand slightly — friction.
  temperature = Math.min(TEMP_START, temperature + 1.4);
}

function loop(now: number): void {
  if (state !== 'playing') {
    rafId = 0;
    return;
  }
  const dtMs = Math.max(0, Math.min(80, now - lastFrame));
  lastFrame = now;
  const dt = dtMs / 1000;

  // Move hooks.
  if (pulling) {
    span = Math.min(HOOK_X_MAX, span + PULL_SPEED * dt);
    if (span > peakSpan) peakSpan = span;
    // Break check: only when actively pulling past threshold.
    const breakAt = temperature < TEMP_BRITTLE
      ? STRETCH_BREAK - 0.18 * (1 - temperature / TEMP_BRITTLE)
      : STRETCH_BREAK;
    if (span >= breakAt) {
      gameOver('Helva koptu — fazla gerdin.', false);
      return;
    }
  } else {
    // Fold back toward rest. When we touch rest, commit a fold based on peak.
    const before = span;
    span = Math.max(HOOK_X_REST, span - FOLD_SPEED * dt);
    if (before > HOOK_X_REST && span <= HOOK_X_REST + 0.001) {
      commitFold(peakSpan);
      peakSpan = HOOK_X_REST;
    }
  }

  // Cool the strand.
  const cool = pulling ? TEMP_COOL_PULL : TEMP_COOL_REST + TEMP_COOL_FOLD_BONUS;
  temperature -= cool * dt;
  if (temperature <= 0) {
    temperature = 0;
    gameOver('Helva soğudu — şekilsiz kaldı.', false);
    return;
  }

  // Win condition.
  if (aeration >= AERATION_MAX) {
    gameOver('Beyazlama tamam — tezgâh seninle gurur duyuyor.', true);
    return;
  }

  // Decay visual pulses.
  if (foldPulse > 0) foldPulse = Math.max(0, foldPulse - dt * 2.4);
  if (breakPulse > 0) breakPulse = Math.max(0, breakPulse - dt * 1.6);

  syncHud();
  draw();
  rafId = requestAnimationFrame(loop);
}

// --- rendering --------------------------------------------------------

const cssCache = new Map<string, string>();
function getCss(varName: string, fallback: string): string {
  const cached = cssCache.get(varName);
  if (cached !== undefined) return cached;
  const val = getComputedStyle(document.documentElement)
    .getPropertyValue(varName).trim() || fallback;
  cssCache.set(varName, val);
  return val;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function strandColor(): string {
  // amber (#d9772a) → ivory (#f4ecd8) as aeration grows
  const t = aeration / AERATION_MAX;
  const r = Math.round(lerp(0xd9, 0xf4, t));
  const g = Math.round(lerp(0x77, 0xec, t));
  const b = Math.round(lerp(0x2a, 0xd8, t));
  return `rgb(${r},${g},${b})`;
}

function draw(): void {
  const w = canvas.width;
  const h = canvas.height;

  // Background — countertop
  ctx.fillStyle = getCss('--surface', '#16181d');
  ctx.fillRect(0, 0, w, h);

  // Countertop band
  const benchY = HOOK_Y + 110;
  const benchGrad = ctx.createLinearGradient(0, benchY, 0, h);
  benchGrad.addColorStop(0, getCss('--bench-top', '#3a2f24'));
  benchGrad.addColorStop(1, getCss('--bench-bot', '#1d1812'));
  ctx.fillStyle = benchGrad;
  ctx.fillRect(0, benchY, w, h - benchY);

  // Wood grain hint
  ctx.strokeStyle = 'rgba(0,0,0,0.18)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 6; i++) {
    const y = benchY + 14 + i * 18;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.bezierCurveTo(w * 0.25, y + 3, w * 0.5, y - 4, w, y + 1);
    ctx.stroke();
  }

  // Hook positions from span.
  const cx = w / 2;
  const halfSpan = (span * w) / 2;
  const lx = cx - halfSpan;
  const rx = cx + halfSpan;

  // The strand: a thick stroke between hooks, with sag depending on slack.
  const slack = Math.max(0, HOOK_X_REST - span);  // negative when stretched
  // Width shrinks as we stretch (volume conservation), grows with folds.
  const stretchT = (span - HOOK_X_REST) / (HOOK_X_MAX - HOOK_X_REST);
  const thicknessRest = 30 + folds * 0.7;
  const minThick = 6;
  const thickness = Math.max(minThick, thicknessRest * (1 - stretchT * 0.7));
  const sagPx = slack * 80 + 18;

  // Stretch warning glow.
  const stretchedFrac =
    Math.max(0, (span - STRETCH_OK) / (STRETCH_BREAK - STRETCH_OK));
  if (stretchedFrac > 0) {
    const alpha = 0.25 + 0.5 * Math.min(1, stretchedFrac);
    ctx.strokeStyle = `rgba(220,80,60,${alpha.toFixed(3)})`;
    ctx.lineWidth = thickness + 12;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(lx, HOOK_Y);
    ctx.quadraticCurveTo(cx, HOOK_Y + sagPx, rx, HOOK_Y);
    ctx.stroke();
  }

  // Strand body
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = thickness;
  ctx.strokeStyle = strandColor();
  ctx.beginPath();
  ctx.moveTo(lx, HOOK_Y);
  ctx.quadraticCurveTo(cx, HOOK_Y + sagPx, rx, HOOK_Y);
  ctx.stroke();

  // Twisted highlight — small bright stripes following the curve, showing
  // folded layers as aeration grows.
  const layers = 1 + Math.min(8, Math.floor(folds / 2));
  ctx.lineCap = 'round';
  for (let i = 0; i < layers; i++) {
    const offset = (i - (layers - 1) / 2) * (thickness * 0.18);
    ctx.lineWidth = Math.max(1, thickness * 0.18);
    ctx.strokeStyle = i % 2 === 0
      ? `rgba(255,255,255,${(0.05 + (aeration / AERATION_MAX) * 0.25).toFixed(3)})`
      : `rgba(0,0,0,${(0.10 + (1 - aeration / AERATION_MAX) * 0.18).toFixed(3)})`;
    ctx.beginPath();
    ctx.moveTo(lx, HOOK_Y + offset);
    ctx.quadraticCurveTo(cx, HOOK_Y + sagPx + offset, rx, HOOK_Y + offset);
    ctx.stroke();
  }

  // Air bubbles surface as aeration approaches 100.
  if (aeration > 25) {
    const bubbles = Math.floor((aeration / AERATION_MAX) * 24);
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    for (let i = 0; i < bubbles; i++) {
      const t = (i + 1) / (bubbles + 1);
      const bx = lx + (rx - lx) * t;
      const by = HOOK_Y + sagPx * (1 - Math.pow(2 * t - 1, 2)) - 2;
      const r = 1.2 + ((i * 13) % 5) * 0.4;
      ctx.beginPath();
      ctx.arc(bx, by, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Fold flash
  if (foldPulse > 0) {
    ctx.fillStyle = `rgba(255,235,150,${(foldPulse * 0.35).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(cx, HOOK_Y + sagPx, 60 + (1 - foldPulse) * 60, 0, Math.PI * 2);
    ctx.fill();
  }

  // Hooks (left & right)
  drawHook(lx, HOOK_Y, -1);
  drawHook(rx, HOOK_Y, +1);

  // Top gauges — temperature bar
  const barX = 24;
  const barY = 24;
  const barW = w - 48;
  const barH = 14;
  ctx.fillStyle = getCss('--bar-bg', '#1f2128');
  ctx.fillRect(barX, barY, barW, barH);
  const tFrac = Math.max(0, temperature / TEMP_START);
  const tempCol = temperature > TEMP_BRITTLE
    ? '#e8a84a'
    : '#73b7ff';
  ctx.fillStyle = tempCol;
  ctx.fillRect(barX, barY, barW * tFrac, barH);
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  ctx.lineWidth = 1;
  ctx.strokeRect(barX, barY, barW, barH);

  // Brittle threshold tick
  const brittleX = barX + barW * (TEMP_BRITTLE / TEMP_START);
  ctx.strokeStyle = '#e85c4a';
  ctx.beginPath();
  ctx.moveTo(brittleX, barY - 2);
  ctx.lineTo(brittleX, barY + barH + 2);
  ctx.stroke();

  // Aeration bar (right side)
  const aY = barY + barH + 8;
  ctx.fillStyle = getCss('--bar-bg', '#1f2128');
  ctx.fillRect(barX, aY, barW, barH);
  ctx.fillStyle = '#f4ecd8';
  ctx.fillRect(barX, aY, barW * (aeration / AERATION_MAX), barH);
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  ctx.strokeRect(barX, aY, barW, barH);

  // Labels
  ctx.fillStyle = getCss('--text-dim', '#aab');
  ctx.font = '600 11px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('ISI', barX, barY - 4);
  ctx.fillText('HAVA', barX, aY - 4);

  // Break flash
  if (breakPulse > 0) {
    ctx.fillStyle = `rgba(220,80,60,${(breakPulse * 0.18).toFixed(3)})`;
    ctx.fillRect(0, 0, w, h);
  }
}

function drawHook(x: number, y: number, dir: -1 | 1): void {
  // Hook = rounded peg with curved iron hook coming off countertop
  const pegW = 14;
  const pegH = 60;
  ctx.fillStyle = '#3b3b42';
  ctx.fillRect(x - pegW / 2, y, pegW, pegH);
  ctx.fillStyle = '#5a5a63';
  ctx.fillRect(x - pegW / 2, y + pegH - 8, pegW, 8);
  // hook curve
  ctx.strokeStyle = '#cfd2d8';
  ctx.lineWidth = 6;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.bezierCurveTo(
    x + dir * 14, y - 6,
    x + dir * 22, y - 4,
    x + dir * 16, y + 10,
  );
  ctx.stroke();
}

// --- input ------------------------------------------------------------

function beginPull(): void {
  if (state === 'ready') {
    start();
  }
  if (state !== 'playing') return;
  pulling = true;
}

function endPull(): void {
  if (state !== 'playing') return;
  pulling = false;
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  tempEl = document.querySelector<HTMLElement>('#temp')!;
  foldsEl = document.querySelector<HTMLElement>('#folds')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  startBtn = document.querySelector<HTMLButtonElement>('#start')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  // Keyboard: SPACE / Enter pulls.
  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    if (e.key === 'r' || e.key === 'R') {
      reset();
      e.preventDefault();
      return;
    }
    if (state === 'gameover' && (e.key === ' ' || e.key === 'Enter')) {
      reset();
      start();
      e.preventDefault();
      return;
    }
    if (e.key === ' ' || e.key === 'Enter') {
      beginPull();
      e.preventDefault();
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === ' ' || e.key === 'Enter') {
      endPull();
      e.preventDefault();
    }
  });

  // Pointer: hold canvas to pull.
  canvas.addEventListener('pointerdown', (e) => {
    if (state === 'gameover') {
      reset();
      start();
      e.preventDefault();
      return;
    }
    beginPull();
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  const release = (e: PointerEvent): void => {
    if (canvas.hasPointerCapture(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId);
    }
    endPull();
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('pointerleave', () => endPull());

  startBtn.addEventListener('click', () => {
    if (state === 'gameover') reset();
    start();
  });
  restartBtn.addEventListener('click', () => {
    reset();
  });

  reset();
}

export const game = defineGame({ init, reset });
