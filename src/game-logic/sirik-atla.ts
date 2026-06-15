import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import {
  showOverlay as showOverlayEl,
  hideOverlay as hideOverlayEl,
} from '@shared/overlay';
import { reportGameOver } from '@shared/leaderboard';

// PITFALLS guarded:
// - unguarded-storage: safeRead/safeWrite wrap localStorage.
// - module-level-dom-access: every DOM/storage access is inside init().
// - overlay-input-leak: explicit `Phase` enum; handleTap switches per phase.
// - hud-counter-synced-only-at-lifecycle-edges: updateHud() runs right after
//   every life/bar mutation, not only on game-over.
// - missing-overlay-css: per-game CSS defines .overlay--hidden visuals.
// - visual-vs-hitbox: the take-off box is purely cosmetic; clearance is
//   judged purely from arc apex vs. bar height, both in canvas px.
// - invisible-boot: first tap immediately starts the run + rhythm bar, no
//   silent delay.

// ── Tunables ─────────────────────────────────────────────────────────────────
const W = 480;
const H = 480;
const GROUND_Y = 400;

const RUNWAY_X0 = 30;
const TAKEOFF_X = 200;       // plant box centre
const TAKEOFF_W = 36;
const PIT_X = 280;           // landing pit centre
const PIT_W = 130;

const BEAT_COUNT = 4;
const BEAT_INTERVAL = 0.55;  // seconds between beats
const BEAT_HIT_WINDOW = 0.16; // ± seconds counted as a hit
const RHYTHM_PREP = 0.5;     // grace before first beat so the start-tap doesn't collide with it
const RHYTHM_TAIL = 0.5;     // tail after last beat so the indicator finishes crossing the bar
const RHYTHM_BAR_X = 60;
const RHYTHM_BAR_W = 360;
const RHYTHM_BAR_Y = 36;
const RHYTHM_BAR_DURATION =
  RHYTHM_PREP + (BEAT_COUNT - 1) * BEAT_INTERVAL + RHYTHM_TAIL;

// Take-off arc geometry.
// Apex height (in metres above GROUND_Y) is computed from
//   apex = APEX_BASE + speedScore * APEX_SPEED + releaseScore * APEX_RELEASE
// where each *Score is in [0,1]. With perfect input apex ≈ 5.50 m, with
// just speed mastery and a missed release ≈ 3.10 m — i.e. roughly the
// opening bar height. That keeps round 1 tractable but never trivial.
const APEX_BASE_M = 1.8;
const APEX_SPEED_M = 1.6;
const APEX_RELEASE_M = 2.1;
const PIXELS_PER_METRE = 50; // 480 px tall canvas → ~7m vertical range.

const RELEASE_PERIOD = 1.3;  // s for indicator to traverse top → bottom → top
const RELEASE_BAND = 0.18;   // ± fraction around peak counted as full release

const STARTING_BAR_M = 3.0;
const BAR_STEP_M = 0.1;
const LIVES = 3;

const STORAGE_BEST = 'sirik-atla.best';
const SCORE_DESC = {
  gameId: 'sirik-atla',
  storageKey: STORAGE_BEST,
  direction: 'higher' as const,
};

// ── Phases ───────────────────────────────────────────────────────────────────
type Phase =
  | 'ready'        // overlay up; tap starts a run
  | 'runup'        // athlete jogging; rhythm bar active
  | 'release'      // pole bending; release indicator active
  | 'flight'       // body arcing over (or into) the bar
  | 'result'       // overlay with cleared/failed message + tap to continue
  | 'gameover';    // overlay; tap to fully reset

// ── DOM (init) ───────────────────────────────────────────────────────────────
let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let barHeightEl!: HTMLElement;
let bestEl!: HTMLElement;
let livesEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;

// ── State ────────────────────────────────────────────────────────────────────
let phase: Phase = 'ready';

let barMetres = STARTING_BAR_M;
let lives = LIVES;
let bestCm = 0;

// Run-up timing
let runupStart = 0;          // performance.now() at start of run-up (s)
let beatsHit = 0;
let speedScore = 0;          // 0..1, finalised at plant
let releaseScore = 0;        // 0..1, finalised on release tap

// Release window
let releaseStart = 0;        // s
let releasedAt = -1;         // s offset within release phase, -1 if not yet

// Flight
let flightStart = 0;
let flightDuration = 0;
let lastApexPx = 0;
let lastCleared = false;
let athleteX = RUNWAY_X0;    // horizontal position during run + flight
let athleteY = GROUND_Y;

// Pole-bend animation phase (release): a 0..1 progress
let bendProgress = 0;

// Loop
let lastTs = 0;
let rafId = 0;

// ── Helpers ──────────────────────────────────────────────────────────────────
function nowSec(): number {
  return performance.now() / 1000;
}

function showOverlayText(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlay);
}

function hideOverlayText(): void {
  hideOverlayEl(overlay);
}

function metresToCm(m: number): number {
  return Math.round(m * 100);
}

function updateHud(): void {
  barHeightEl.textContent = String(metresToCm(barMetres));
  bestEl.textContent = String(bestCm);
  livesEl.textContent = String(lives);
}

function commitBestIfNew(clearedMetres: number): void {
  const cm = metresToCm(clearedMetres);
  if (cm > bestCm) {
    bestCm = cm;
    safeWrite(STORAGE_BEST, bestCm);
  }
}

// ── Phase transitions ────────────────────────────────────────────────────────
function reset(): void {
  phase = 'ready';
  barMetres = STARTING_BAR_M;
  lives = LIVES;
  beatsHit = 0;
  speedScore = 0;
  releaseScore = 0;
  releasedAt = -1;
  athleteX = RUNWAY_X0;
  athleteY = GROUND_Y;
  bendProgress = 0;
  updateHud();
  showOverlayText(
    'Sırık Atla',
    'Önce dört vuruşluk ritim çubuğunu yakala, sonra zirvede sırığı bırak.\n\n' +
      'Boşluk / tıkla — başla.',
  );
}

function startRunUp(): void {
  phase = 'runup';
  runupStart = nowSec();
  beatsHit = 0;
  speedScore = 0;
  releaseScore = 0;
  releasedAt = -1;
  athleteX = RUNWAY_X0;
  athleteY = GROUND_Y;
  bendProgress = 0;
  hideOverlayText();
}

function plantPole(): void {
  // Finalise speed score from beats actually hit.
  speedScore = beatsHit / BEAT_COUNT;
  phase = 'release';
  releaseStart = nowSec();
  releasedAt = -1;
}

function commitFlight(): void {
  // Compute apex height in pixels above ground.
  const apexM =
    APEX_BASE_M +
    speedScore * APEX_SPEED_M +
    releaseScore * APEX_RELEASE_M;
  lastApexPx = apexM * PIXELS_PER_METRE;
  lastCleared = apexM >= barMetres;
  flightStart = nowSec();
  flightDuration = 1.1; // seconds for the arc animation
  phase = 'flight';
}

function settleFlight(): void {
  if (lastCleared) {
    commitBestIfNew(barMetres);
    barMetres += BAR_STEP_M;
    updateHud();
    phase = 'result';
    showOverlayText(
      `Geçtin! ${metresToCm(barMetres - BAR_STEP_M)} cm`,
      `Yeni çıta: ${metresToCm(barMetres)} cm · Rekor: ${bestCm} cm\n\nBoşluk / tıkla — sıradaki atlama.`,
    );
  } else {
    lives -= 1;
    updateHud();
    if (lives <= 0) {
      phase = 'gameover';
      reportGameOver(SCORE_DESC, bestCm);
      showOverlayText(
        'Seri bitti!',
        `Geçtiğin en yüksek çıta: ${bestCm} cm\nMevcut çıta: ${metresToCm(barMetres)} cm\n\nBoşluk / tıkla — tekrar başla.`,
      );
    } else {
      phase = 'result';
      showOverlayText(
        `Çıta düştü (${metresToCm(barMetres)} cm)`,
        `Kalan hak: ${lives}\n\nBoşluk / tıkla — yeni deneme.`,
      );
    }
  }
}

// ── Input ────────────────────────────────────────────────────────────────────
function tryRegisterBeat(): void {
  // Find the nearest beat to the press moment within the hit window.
  const elapsed = nowSec() - runupStart;
  let bestErr = BEAT_HIT_WINDOW + 1;
  let bestBeat = -1;
  for (let b = 0; b < BEAT_COUNT; b++) {
    const t = RHYTHM_PREP + b * BEAT_INTERVAL;
    const err = Math.abs(elapsed - t);
    if (err < bestErr) {
      bestErr = err;
      bestBeat = b;
    }
  }
  if (bestBeat >= 0 && bestErr <= BEAT_HIT_WINDOW) {
    // Each beat may only count once: cap hits at BEAT_COUNT and don't
    // reward duplicate presses on the same beat.
    if (beatsHit < BEAT_COUNT) {
      beatsHit += 1;
    }
  }
  // Press off-beat is harmless — no penalty, just no reward.
}

function tryReleasePole(): void {
  if (releasedAt >= 0) return; // already released this attempt
  const elapsed = nowSec() - releaseStart;
  // Indicator oscillates: position = (1 + cos(2π * elapsed / RELEASE_PERIOD)) / 2
  // i.e. 1 at top (apex) at t=0, t=RELEASE_PERIOD, ...
  // Distance from peak measured as min(elapsed, RELEASE_PERIOD - elapsed) for
  // the first cycle so the player just needs to catch the top in the first arc.
  const cycle = elapsed % RELEASE_PERIOD;
  const peakDistance = Math.min(cycle, RELEASE_PERIOD - cycle);
  const norm = peakDistance / (RELEASE_PERIOD / 2); // 0 at peak, 1 at trough
  if (norm <= RELEASE_BAND) {
    // Linearly map: at norm=0 → 1.0, at norm=RELEASE_BAND → 0.0
    releaseScore = 1 - norm / RELEASE_BAND;
  } else {
    releaseScore = 0;
  }
  releasedAt = elapsed;
  commitFlight();
}

function handleTap(): void {
  switch (phase) {
    case 'ready':
      startRunUp();
      return;
    case 'runup':
      tryRegisterBeat();
      return;
    case 'release':
      tryReleasePole();
      return;
    case 'flight':
      // Ignore taps mid-flight; let the arc finish.
      return;
    case 'result':
      hideOverlayText();
      startRunUp();
      return;
    case 'gameover':
      reset();
      // After reset() the overlay sits on the start screen again — the
      // user's next tap will start the run. This avoids a hidden
      // double-state where R+Tap behave differently.
      return;
  }
}

// ── Update ───────────────────────────────────────────────────────────────────
function update(_dt: number): void {
  const t = nowSec();

  if (phase === 'runup') {
    // Athlete jogs from RUNWAY_X0 to TAKEOFF_X over RHYTHM_BAR_DURATION
    // seconds. Reaching the plant box triggers the pole plant automatically.
    const elapsed = t - runupStart;
    const progress = Math.max(0, Math.min(1, elapsed / RHYTHM_BAR_DURATION));
    athleteX = RUNWAY_X0 + (TAKEOFF_X - RUNWAY_X0) * progress;
    if (elapsed >= RHYTHM_BAR_DURATION) {
      plantPole();
    }
    return;
  }

  if (phase === 'release') {
    const elapsed = t - releaseStart;
    bendProgress = Math.min(1, elapsed / RELEASE_PERIOD);
    // If the player never taps, time out into a failed attempt after one full
    // oscillation — equivalent to a missed release (releaseScore = 0).
    if (elapsed >= RELEASE_PERIOD) {
      releaseScore = 0;
      releasedAt = elapsed;
      commitFlight();
    }
    return;
  }

  if (phase === 'flight') {
    const elapsed = t - flightStart;
    const p = Math.max(0, Math.min(1, elapsed / flightDuration));
    // Arc: start at take-off, go up to apex above bar, land in pit.
    // Use a sin curve for vertical, lerp horizontal.
    athleteX = TAKEOFF_X + (PIT_X - TAKEOFF_X) * p;
    athleteY = GROUND_Y - Math.sin(p * Math.PI) * lastApexPx;
    if (elapsed >= flightDuration) {
      settleFlight();
    }
    return;
  }
}

// ── Drawing ──────────────────────────────────────────────────────────────────
function drawSky(): void {
  const grad = ctx.createLinearGradient(0, 0, 0, GROUND_Y);
  grad.addColorStop(0, '#0a0b0e');
  grad.addColorStop(1, '#1c2030');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, GROUND_Y);
}

function drawStadium(): void {
  ctx.fillStyle = 'rgba(255,255,255,0.04)';
  for (let i = 0; i < 14; i++) {
    const bx = (i * 40) % W;
    const bh = 18 + ((i * 17) % 22);
    ctx.fillRect(bx, GROUND_Y - bh, 32, bh);
  }
}

function drawGround(): void {
  ctx.fillStyle = '#2a2e3a';
  ctx.fillRect(0, GROUND_Y, W, H - GROUND_Y);
  ctx.strokeStyle = '#525a6c';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, GROUND_Y + 0.5);
  ctx.lineTo(W, GROUND_Y + 0.5);
  ctx.stroke();

  // Runway lane lines
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 4; i++) {
    const y = GROUND_Y + 10 + i * 14;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }

  // Take-off box (plant area) — purely cosmetic, judged geometry uses
  // TAKEOFF_X only.
  ctx.fillStyle = '#3b82f6';
  ctx.fillRect(TAKEOFF_X - TAKEOFF_W / 2, GROUND_Y - 6, TAKEOFF_W, 8);
  ctx.strokeStyle = '#60a5fa';
  ctx.lineWidth = 1;
  ctx.strokeRect(TAKEOFF_X - TAKEOFF_W / 2, GROUND_Y - 6, TAKEOFF_W, 8);

  // Landing pit
  ctx.fillStyle = '#374151';
  ctx.fillRect(PIT_X - PIT_W / 2, GROUND_Y, PIT_W, H - GROUND_Y);
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  ctx.fillRect(PIT_X - PIT_W / 2, GROUND_Y, PIT_W, 4);
}

function drawCrossbar(): void {
  // Crossbar uprights stand on either side of the pit.
  const barPx = barMetres * PIXELS_PER_METRE;
  const barY = GROUND_Y - barPx;
  const leftX = PIT_X - PIT_W / 2 + 14;
  const rightX = PIT_X + PIT_W / 2 - 14;

  ctx.strokeStyle = '#94a3b8';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(leftX, GROUND_Y);
  ctx.lineTo(leftX, barY);
  ctx.moveTo(rightX, GROUND_Y);
  ctx.lineTo(rightX, barY);
  ctx.stroke();

  // The bar itself: red if the previous attempt was a knock and we're in
  // the result phase before it resets, otherwise pale.
  const knocked = phase === 'result' && !lastCleared;
  ctx.strokeStyle = knocked ? '#ef4444' : '#fbbf24';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(leftX, barY);
  ctx.lineTo(rightX, barY);
  ctx.stroke();

  // Height label
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(`${metresToCm(barMetres)} cm`, rightX + 8, barY + 4);
}

function drawAthlete(): void {
  // Tiny silhouette: head + body + legs/arms.
  ctx.fillStyle = '#e6ebf2';
  ctx.beginPath();
  ctx.arc(athleteX, athleteY - 26, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillRect(athleteX - 2, athleteY - 20, 4, 14);
  // Legs animate during runup.
  const stride =
    phase === 'runup'
      ? Math.sin((nowSec() - runupStart) * 10) * 4
      : 0;
  ctx.fillRect(athleteX - 5, athleteY - 6, 4, 6 + stride);
  ctx.fillRect(athleteX + 1, athleteY - 6, 4, 6 - stride);
}

function drawPole(): void {
  // The pole tip moves with the athlete during run + flight. During release
  // we draw it bending.
  ctx.strokeStyle = '#fbbf24';
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';

  if (phase === 'runup' || phase === 'ready' || phase === 'result' || phase === 'gameover') {
    // Pole carried at an angle.
    ctx.beginPath();
    ctx.moveTo(athleteX + 6, athleteY - 18);
    ctx.lineTo(athleteX + 60, athleteY - 38);
    ctx.stroke();
    return;
  }

  if (phase === 'release') {
    // Pole planted in take-off box, bending. Use a quadratic Bezier.
    const bend = bendProgress;
    const baseX = TAKEOFF_X;
    const baseY = GROUND_Y - 4;
    // Tip arcs from far-right-down toward straight-up as bend grows.
    const tipX = baseX + 70 - bend * 70;
    const tipY = baseY - 120 - bend * 40;
    const ctlX = baseX + 60 - bend * 30;
    const ctlY = baseY - 60 - bend * 60;
    ctx.beginPath();
    ctx.moveTo(baseX, baseY);
    ctx.quadraticCurveTo(ctlX, ctlY, tipX, tipY);
    ctx.stroke();
    return;
  }

  if (phase === 'flight') {
    // Pole left behind, leaning back from the take-off box.
    ctx.beginPath();
    ctx.moveTo(TAKEOFF_X, GROUND_Y - 4);
    ctx.lineTo(TAKEOFF_X - 30, GROUND_Y - 80);
    ctx.stroke();
  }
}

function drawRhythmBar(): void {
  if (phase !== 'runup') return;
  const elapsed = nowSec() - runupStart;
  const progress = Math.max(0, Math.min(1, elapsed / RHYTHM_BAR_DURATION));

  // Bar track
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.fillRect(RHYTHM_BAR_X, RHYTHM_BAR_Y, RHYTHM_BAR_W, 18);
  ctx.strokeStyle = 'rgba(255,255,255,0.2)';
  ctx.lineWidth = 1;
  ctx.strokeRect(RHYTHM_BAR_X + 0.5, RHYTHM_BAR_Y + 0.5, RHYTHM_BAR_W - 1, 17);

  // Beat rings — positioned where the indicator will be at each beat moment.
  for (let b = 0; b < BEAT_COUNT; b++) {
    const t = RHYTHM_PREP + b * BEAT_INTERVAL;
    const x = RHYTHM_BAR_X + RHYTHM_BAR_W * (t / RHYTHM_BAR_DURATION);
    const cy = RHYTHM_BAR_Y + 9;
    ctx.beginPath();
    ctx.arc(x, cy, 8, 0, Math.PI * 2);
    ctx.strokeStyle = b < beatsHit ? '#22c55e' : 'rgba(255,255,255,0.45)';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // Sliding indicator
  const ix = RHYTHM_BAR_X + RHYTHM_BAR_W * progress;
  ctx.fillStyle = '#fbbf24';
  ctx.beginPath();
  ctx.moveTo(ix, RHYTHM_BAR_Y - 4);
  ctx.lineTo(ix - 5, RHYTHM_BAR_Y - 12);
  ctx.lineTo(ix + 5, RHYTHM_BAR_Y - 12);
  ctx.closePath();
  ctx.fill();

  // Label
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('RİTİM — vuruşa bas', RHYTHM_BAR_X, RHYTHM_BAR_Y - 4);
}

function drawReleaseMeter(): void {
  if (phase !== 'release') return;
  const elapsed = nowSec() - releaseStart;
  const cycle = elapsed % RELEASE_PERIOD;
  // Indicator position: 0 at peak (top), 1 at bottom.
  // norm = sin(π * cycle / RELEASE_PERIOD) so 0 at t=0, 1 at half, 0 again.
  // We want 0 (peak) at start, growing toward 1 (bottom) at mid-cycle.
  const norm = Math.sin((Math.PI * cycle) / RELEASE_PERIOD);

  const metreX = W - 56;
  const metreY = 80;
  const metreH = 220;
  const metreW = 22;

  // Track
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.fillRect(metreX, metreY, metreW, metreH);
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 1;
  ctx.strokeRect(metreX + 0.5, metreY + 0.5, metreW - 1, metreH - 1);

  // Green peak zone at the top.
  const bandH = metreH * RELEASE_BAND;
  ctx.fillStyle = 'rgba(34,197,94,0.32)';
  ctx.fillRect(metreX, metreY, metreW, bandH);
  ctx.strokeStyle = 'rgba(34,197,94,0.85)';
  ctx.strokeRect(metreX + 0.5, metreY + 0.5, metreW - 1, bandH - 1);

  // Indicator
  const indY = metreY + norm * metreH;
  ctx.fillStyle = norm <= RELEASE_BAND ? '#22c55e' : '#fbbf24';
  ctx.beginPath();
  ctx.moveTo(metreX - 4, indY);
  ctx.lineTo(metreX + metreW + 4, indY);
  ctx.lineTo(metreX + metreW + 4, indY + 4);
  ctx.lineTo(metreX - 4, indY + 4);
  ctx.closePath();
  ctx.fill();

  // Label
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('BIRAK', metreX + metreW / 2, metreY - 6);
}

function drawSpeedBar(): void {
  if (phase !== 'release' && phase !== 'flight') return;
  // After plant, show a small read-out of how fast the athlete approached.
  const barW = 110;
  const x = 16;
  const y = 36;
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.fillRect(x, y, barW, 8);
  const color =
    speedScore > 0.85 ? '#22c55e' : speedScore > 0.5 ? '#eab308' : '#f97316';
  ctx.fillStyle = color;
  ctx.fillRect(x, y, barW * speedScore, 8);
  ctx.strokeStyle = 'rgba(255,255,255,0.2)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, barW - 1, 7);
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('HIZ', x, y - 4);
}

function drawHint(): void {
  if (phase === 'ready' || phase === 'gameover' || phase === 'result') return;
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'right';
  const hint =
    phase === 'runup'
      ? 'Boşluk / tıkla — vuruş'
      : phase === 'release'
        ? 'Boşluk / tıkla — bırak'
        : '';
  if (hint) ctx.fillText(hint, W - 12, H - 14);
}

function draw(): void {
  drawSky();
  drawStadium();
  drawGround();
  drawCrossbar();
  drawPole();
  drawAthlete();
  drawRhythmBar();
  drawReleaseMeter();
  drawSpeedBar();
  drawHint();
}

// ── Loop ─────────────────────────────────────────────────────────────────────
function frame(ts: number): void {
  const dt = lastTs === 0 ? 0 : Math.min((ts - lastTs) / 1000, 0.05);
  lastTs = ts;
  update(dt);
  draw();
  rafId = requestAnimationFrame(frame);
}

// ── Init ─────────────────────────────────────────────────────────────────────
function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  barHeightEl = document.querySelector<HTMLElement>('#bar-height')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  livesEl = document.querySelector<HTMLElement>('#lives')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;

  const stored = safeRead<number>(STORAGE_BEST, 0);
  bestCm = Number.isFinite(stored) && stored > 0 ? stored : 0;

  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.code === 'Space' || e.key === 'Enter') {
      e.preventDefault();
      handleTap();
    } else if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      reset();
    }
  });

  const tap = (e: Event) => {
    e.preventDefault();
    handleTap();
  };
  canvas.addEventListener('pointerdown', tap, { passive: false });
  overlay.addEventListener('pointerdown', tap, { passive: false });
  restartBtn.addEventListener('click', () => reset());

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) lastTs = 0;
  });

  reset();
  cancelAnimationFrame(rafId);
  lastTs = 0;
  rafId = requestAnimationFrame(frame);
}

export const game = defineGame({ init, reset });
