import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay, hideOverlay } from '@shared/overlay';

// PITFALLS guarded:
// - unguarded-storage: safeRead/safeWrite for best score; no raw localStorage.
// - module-level-dom-access: every querySelector + addEventListener inside init().
// - overlay-input-leak: explicit Phase enum; handleTap switches per phase and
//   feedback/gameover swallow stray taps.
// - stale-async-callback: the feedback → nextBird timeout is bound to a
//   gen-token; reset() bumps it so a spam-restart cannot spawn a bird into a
//   fresh game.
// - missing-overlay-css: per-game CSS defines `.overlay--hidden` visuals.
// - invisible-boot: the start tap both hides the overlay and spawns the first
//   bird in the same frame (≤16ms before first visible state change).
// - hud-counter-synced-only-at-lifecycle-edges: updateHud() runs after every
//   life/score mutation, not just on game-over.
// - unreachable-start-state: the overlay's Başla button, the canvas surface,
//   keyboard Space/Enter all reach handleTap() with phase==='ready'.

// ── Tunables ────────────────────────────────────────────────────────────────
const W = 480;
const H = 480;
const CENTER_X = W / 2;
const CENTER_Y = H / 2;
const VIEWFINDER = 110;            // half-side of the central focus square (px)
const POSITION_FALLOFF = 160;      // distance at which positionScore reaches 0
const BIRD_BASE_SPEED = 120;       // px/s at round 1
const SPEED_PER_ROUND = 22;        // +px/s per round
const POSE_SLOWDOWN = 0.18;        // speed multiplier during the pose moment
const POSE_DURATION_BASE = 0.55;   // seconds at round 1
const POSE_DURATION_MIN = 0.22;    // floor for high rounds
const POSE_DURATION_DECAY = 0.05;  // seconds shaved per round
const FEEDBACK_DURATION = 1.1;     // seconds the photo-result freeze lasts
const QUALITY_THRESHOLD_OK = 20;   // below this counts as a missed shot
const STARTING_LIVES = 3;
const BIRDS_PER_ROUND = 5;

const STORAGE_BEST = 'deklansor.best';

// ── Phase ───────────────────────────────────────────────────────────────────
type Phase = 'ready' | 'flying' | 'feedback' | 'gameover';

// ── State ───────────────────────────────────────────────────────────────────
const gen = createGenToken();
let phase: Phase = 'ready';
let score = 0;
let best = 0;
let lives = STARTING_LIVES;
let round = 1;
let birdsThisRound = 0;

// Bird state
let birdX = 0;
let birdY = 0;
let birdVx = 0;                   // base velocity (px/s), signed
let birdT = 0;                    // seconds elapsed since this bird spawned
let birdSpeedScale = 1;           // current scale; POSE_SLOWDOWN during pose
let birdPoseStart = 0;            // when the pose begins (s into bird life)
let birdPoseDur = POSE_DURATION_BASE;
let birdEntry: 'left' | 'right' = 'left';
let birdHue = 24;
let birdWobblePhase = 0;          // independent of speed so the bird breathes

// Feedback / snapshot of the bird at the moment the shutter fired
let lastSnapX = 0;
let lastSnapY = 0;
let lastSnapHue = 0;
let lastSnapFacingRight = true;
let lastSnapVisible = false;
let feedbackEndAt = 0;
let feedbackLabel = '';
let feedbackGood = false;

// Loop
let lastTs = 0;
let rafId = 0;

// DOM refs (assigned in init())
let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let livesEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let startBtn!: HTMLButtonElement;
let statusEl!: HTMLElement;

// ── Helpers ─────────────────────────────────────────────────────────────────
function nowSec(): number {
  return performance.now() / 1000;
}

function setStatus(t: string): void {
  statusEl.textContent = t;
}

function updateHud(): void {
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
  livesEl.textContent = String(lives);
}

function commitBest(): void {
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
}

function birdsLeftLabel(): string {
  const remaining = BIRDS_PER_ROUND - birdsThisRound;
  return `Tur ${round} · kalan ${remaining}/${BIRDS_PER_ROUND}`;
}

// ── Bird lifecycle ──────────────────────────────────────────────────────────
function spawnBird(): void {
  birdT = 0;
  birdSpeedScale = 1;
  birdEntry = Math.random() < 0.5 ? 'left' : 'right';
  const baseSpeed = BIRD_BASE_SPEED + (round - 1) * SPEED_PER_ROUND;
  birdVx = (birdEntry === 'left' ? 1 : -1) * baseSpeed;
  birdY = 120 + Math.random() * 230;
  birdX = birdEntry === 'left' ? -28 : W + 28;
  // Pose somewhere in [0.35, 0.65] of the path so the bird is near centre.
  const pathSec = W / Math.abs(birdVx);
  birdPoseStart = pathSec * (0.35 + Math.random() * 0.30);
  birdPoseDur = Math.max(
    POSE_DURATION_MIN,
    POSE_DURATION_BASE - (round - 1) * POSE_DURATION_DECAY,
  );
  // Warm + a couple of cooler picks so birds vary visually.
  const palette = [12, 28, 46, 200, 145];
  birdHue = palette[Math.floor(Math.random() * palette.length)]!;
  birdWobblePhase = Math.random() * Math.PI * 2;
}

function scheduleAdvance(): void {
  const myGen = gen.current();
  setTimeout(() => {
    if (!gen.isCurrent(myGen)) return;
    if (lives <= 0) {
      gameOver();
      return;
    }
    nextBird();
  }, FEEDBACK_DURATION * 1000);
}

function nextBird(): void {
  birdsThisRound += 1;
  if (birdsThisRound >= BIRDS_PER_ROUND) {
    round += 1;
    birdsThisRound = 0;
  }
  spawnBird();
  phase = 'flying';
  setStatus(birdsLeftLabel());
}

function startGame(): void {
  gen.bump();
  hideOverlay(overlay);
  score = 0;
  lives = STARTING_LIVES;
  round = 1;
  birdsThisRound = 0;
  updateHud();
  spawnBird();
  phase = 'flying';
  setStatus(birdsLeftLabel());
}

function gameOver(): void {
  commitBest();
  updateHud();
  phase = 'gameover';
  overlayTitle.textContent = 'Albüm dolu';
  overlayMsg.textContent =
    `Toplam skor: ${score}\nRekor: ${best}\nTur: ${round}\n\n` +
    `Boşluk / tıkla — tekrar başla.`;
  startBtn.textContent = 'Tekrar';
  showOverlay(overlay);
  setStatus(`Bitti — skor ${score}, rekor ${best}`);
}

// ── Shot & miss handling ────────────────────────────────────────────────────
function handleShoot(): void {
  // Snapshot bird state before mutating anything so the freeze-frame is
  // visually correct even after we advance internal state.
  const dx = birdX - CENTER_X;
  const dy = birdY - CENTER_Y;
  const dist = Math.hypot(dx, dy);
  const speed = Math.abs(birdVx) * birdSpeedScale;
  const maxSpeed = BIRD_BASE_SPEED + (round - 1) * SPEED_PER_ROUND;
  const positionScore = Math.max(0, 1 - dist / POSITION_FALLOFF);
  // Slight floor so a perfectly-centred posed bird still beats threshold.
  const focusScore = Math.max(0, 1 - (speed / maxSpeed) * 0.92);
  const quality = positionScore * focusScore;
  const points = Math.round(quality * 100);

  lastSnapX = birdX;
  lastSnapY = birdY;
  lastSnapHue = birdHue;
  lastSnapFacingRight = birdVx > 0;
  lastSnapVisible = true;

  if (points >= QUALITY_THRESHOLD_OK) {
    score += points;
    feedbackGood = true;
    feedbackLabel =
      points >= 75
        ? `Mükemmel kare!  +${points}`
        : points >= 45
          ? `Güzel kare  +${points}`
          : `Çekildi  +${points}`;
  } else {
    lives -= 1;
    feedbackGood = false;
    feedbackLabel = points >= 1 ? `Bulanık / kenar (${points})` : 'Iskaladın';
  }
  setStatus(feedbackLabel);
  commitBest();
  updateHud();
  phase = 'feedback';
  feedbackEndAt = nowSec() + FEEDBACK_DURATION;
  scheduleAdvance();
}

function onBirdEscaped(): void {
  // Bird left the canvas without being photographed — wasted opportunity.
  lives -= 1;
  lastSnapVisible = false; // frame is empty in the photo result
  feedbackGood = false;
  feedbackLabel = 'Kuş kaçtı!';
  setStatus(feedbackLabel);
  commitBest();
  updateHud();
  phase = 'feedback';
  feedbackEndAt = nowSec() + FEEDBACK_DURATION;
  scheduleAdvance();
}

// ── Update ──────────────────────────────────────────────────────────────────
function update(dt: number): void {
  if (phase !== 'flying') return;
  birdT += dt;

  // Pose window — speed drops to POSE_SLOWDOWN inside, snaps back outside.
  const inPose = birdT >= birdPoseStart && birdT <= birdPoseStart + birdPoseDur;
  birdSpeedScale = inPose ? POSE_SLOWDOWN : 1;

  birdX += birdVx * dt * birdSpeedScale;
  // Gentle vertical wobble — smaller while posed so it visibly steadies.
  const wobbleScale = inPose ? 0.25 : 1;
  birdY += Math.cos(birdT * 1.8 + birdWobblePhase) * 18 * dt * wobbleScale;

  if (birdEntry === 'left' && birdX > W + 36) {
    onBirdEscaped();
  } else if (birdEntry === 'right' && birdX < -36) {
    onBirdEscaped();
  }
}

// ── Drawing ─────────────────────────────────────────────────────────────────
function drawBg(): void {
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, '#0e1a18');
  grad.addColorStop(0.55, '#16302a');
  grad.addColorStop(1, '#0a1310');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // Distant tree silhouettes at the bottom.
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  for (let i = 0; i < 9; i++) {
    const x = i * 56 - 8;
    const h = 56 + ((i * 23) % 44);
    ctx.beginPath();
    ctx.moveTo(x, H);
    ctx.lineTo(x + 28, H - h);
    ctx.lineTo(x + 56, H);
    ctx.closePath();
    ctx.fill();
  }

  // Mist band across the horizon.
  const mist = ctx.createLinearGradient(0, H * 0.4, 0, H * 0.78);
  mist.addColorStop(0, 'rgba(255,255,255,0)');
  mist.addColorStop(0.5, 'rgba(255,255,255,0.07)');
  mist.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = mist;
  ctx.fillRect(0, H * 0.4, W, H * 0.38);
}

function drawViewfinder(): void {
  const x0 = CENTER_X - VIEWFINDER;
  const y0 = CENTER_Y - VIEWFINDER;
  const s = VIEWFINDER * 2;
  const arm = 18;
  ctx.strokeStyle =
    phase === 'flying' ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.32)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x0, y0 + arm); ctx.lineTo(x0, y0); ctx.lineTo(x0 + arm, y0);
  ctx.moveTo(x0 + s - arm, y0); ctx.lineTo(x0 + s, y0); ctx.lineTo(x0 + s, y0 + arm);
  ctx.moveTo(x0, y0 + s - arm); ctx.lineTo(x0, y0 + s); ctx.lineTo(x0 + arm, y0 + s);
  ctx.moveTo(x0 + s - arm, y0 + s); ctx.lineTo(x0 + s, y0 + s); ctx.lineTo(x0 + s, y0 + s - arm);
  ctx.stroke();

  // Centre crosshair.
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(CENTER_X - 9, CENTER_Y); ctx.lineTo(CENTER_X + 9, CENTER_Y);
  ctx.moveTo(CENTER_X, CENTER_Y - 9); ctx.lineTo(CENTER_X, CENTER_Y + 9);
  ctx.stroke();
}

function drawFocusRing(): void {
  if (phase !== 'flying') return;
  const speed = Math.abs(birdVx) * birdSpeedScale;
  const maxSpeed = BIRD_BASE_SPEED + (round - 1) * SPEED_PER_ROUND;
  const focusBig = 58;
  const focusSmall = 14;
  const t = Math.min(1, speed / maxSpeed);
  const r = focusSmall + (focusBig - focusSmall) * t;
  const inPose = birdSpeedScale < 0.5;
  ctx.strokeStyle = inPose ? 'rgba(34,197,94,0.9)' : 'rgba(255,255,255,0.45)';
  ctx.lineWidth = inPose ? 2.2 : 1.5;
  ctx.beginPath();
  ctx.arc(birdX, birdY, r, 0, Math.PI * 2);
  ctx.stroke();
  if (inPose) {
    // Cardinal ticks emphasise the moment.
    for (let a = 0; a < 4; a++) {
      const ang = (a * Math.PI) / 2;
      const rx = Math.cos(ang) * r;
      const ry = Math.sin(ang) * r;
      ctx.beginPath();
      ctx.moveTo(birdX + rx * 1.18, birdY + ry * 1.18);
      ctx.lineTo(birdX + rx * 1.42, birdY + ry * 1.42);
      ctx.stroke();
    }
  }
}

function drawBirdAt(
  x: number,
  y: number,
  hue: number,
  facingRight: boolean,
  flapPhase: number,
): void {
  ctx.save();
  ctx.translate(x, y);
  if (!facingRight) ctx.scale(-1, 1);
  // Body
  ctx.fillStyle = `hsl(${hue} 70% 60%)`;
  ctx.beginPath();
  ctx.ellipse(0, 0, 12, 8, 0, 0, Math.PI * 2);
  ctx.fill();
  // Tail
  ctx.fillStyle = `hsl(${hue} 60% 48%)`;
  ctx.beginPath();
  ctx.moveTo(-10, -2);
  ctx.lineTo(-17, -5);
  ctx.lineTo(-17, 3);
  ctx.lineTo(-10, 3);
  ctx.closePath();
  ctx.fill();
  // Head
  ctx.fillStyle = `hsl(${hue} 72% 62%)`;
  ctx.beginPath();
  ctx.arc(10, -2, 6, 0, Math.PI * 2);
  ctx.fill();
  // Beak
  ctx.fillStyle = `hsl(${hue} 85% 40%)`;
  ctx.beginPath();
  ctx.moveTo(15, -2);
  ctx.lineTo(21, -1);
  ctx.lineTo(15, 2);
  ctx.closePath();
  ctx.fill();
  // Wing — flaps based on phase
  const flap = Math.sin(flapPhase) * 4;
  ctx.fillStyle = `hsl(${hue} 70% 45%)`;
  ctx.beginPath();
  ctx.ellipse(-2, -3 + flap, 8, 4, -0.3, 0, Math.PI * 2);
  ctx.fill();
  // Eye
  ctx.fillStyle = '#0a0b0e';
  ctx.beginPath();
  ctx.arc(11, -3, 1.3, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawBird(): void {
  if (phase === 'flying') {
    const flapPhase = nowSec() * (birdSpeedScale < 0.5 ? 6 : 18);
    drawBirdAt(birdX, birdY, birdHue, birdVx > 0, flapPhase);
    return;
  }
  if (phase === 'feedback' && lastSnapVisible) {
    drawBirdAt(lastSnapX, lastSnapY, lastSnapHue, lastSnapFacingRight, 0);
  }
}

function drawFeedback(): void {
  if (phase !== 'feedback') return;
  const remaining = Math.max(0, feedbackEndAt - nowSec());
  const t = remaining / FEEDBACK_DURATION;
  // Quick white flash at the start of feedback fading out.
  if (t > 0.82) {
    const a = (t - 0.82) / 0.18;
    ctx.fillStyle = `rgba(255,255,255,${a * 0.55})`;
    ctx.fillRect(0, 0, W, H);
  }
  // Photo frame around the central area.
  ctx.strokeStyle = feedbackGood ? '#22c55e' : '#ef4444';
  ctx.lineWidth = 4;
  ctx.strokeRect(CENTER_X - 102, CENTER_Y - 80, 204, 160);
  // Caption strip.
  ctx.fillStyle = 'rgba(0,0,0,0.72)';
  ctx.fillRect(CENTER_X - 102, CENTER_Y + 80, 204, 26);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 13px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(feedbackLabel, CENTER_X, CENTER_Y + 93);
}

function drawHint(): void {
  if (phase !== 'flying') return;
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('Boşluk / tıkla — deklanşör', W - 12, H - 14);
}

function draw(): void {
  drawBg();
  drawViewfinder();
  drawFocusRing();
  drawBird();
  drawFeedback();
  drawHint();
}

function frame(ts: number): void {
  const dt = lastTs === 0 ? 0 : Math.min((ts - lastTs) / 1000, 0.05);
  lastTs = ts;
  update(dt);
  draw();
  rafId = requestAnimationFrame(frame);
}

// ── Reset / input dispatch ─────────────────────────────────────────────────
function reset(): void {
  gen.bump();
  phase = 'ready';
  score = 0;
  lives = STARTING_LIVES;
  round = 1;
  birdsThisRound = 0;
  birdX = -200; // off-screen so drawBird does nothing in 'ready'
  birdY = -200;
  birdSpeedScale = 1;
  lastSnapVisible = false;
  updateHud();
  overlayTitle.textContent = 'Deklanşör';
  overlayMsg.textContent =
    'Kuş ekrandan geçerken kısa bir poz anında yavaşlar — fokus halkası ' +
    "küçülür ve yeşile döner.\nO anda vizör merkezindeyken Boşluk'a bas: " +
    'konum × keskinlik = puan.';
  startBtn.textContent = 'Başla';
  setStatus("Başlamak için Boşluk'a bas");
  showOverlay(overlay);
}

function handleTap(): void {
  switch (phase) {
    case 'ready':
    case 'gameover':
      startGame();
      return;
    case 'flying':
      handleShoot();
      return;
    case 'feedback':
      // Wait out the freeze; ignore taps so a panicked double-click can't
      // race the scheduled nextBird callback.
      return;
  }
}

// ── Init ────────────────────────────────────────────────────────────────────
function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  livesEl = document.querySelector<HTMLElement>('#lives')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  startBtn = document.querySelector<HTMLButtonElement>('#start')!;
  statusEl = document.querySelector<HTMLElement>('#status')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.code === 'Space' || e.key === 'Enter') {
      e.preventDefault();
      handleTap();
    } else if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      reset();
    }
  });

  const tap = (e: Event): void => {
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
