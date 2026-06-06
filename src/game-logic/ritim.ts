import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { reportGameOver } from '@shared/leaderboard';

// ── Types ────────────────────────────────────────────────────────────────────
type State = 'ready' | 'playing' | 'gameover';
type FeedbackKind = 'perfect' | 'good' | 'miss' | null;

// ── DOM (filled in init) ──────────────────────────────────────────────────────
let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;

// ── Constants ────────────────────────────────────────────────────────────────
const W = 400;
const H = 400;
const CX = W / 2;
const CY = H / 2;
const INNER_R = 38;
const TARGET_R = 148;
const PERFECT_W = 10;
const GOOD_W = 26;
const TOTAL_BEATS = 30;
const INIT_BPM = 66;
const BPM_STEP = 4;
const BPM_CAP = 180;
const HITS_PER_LEVEL = 8;
const MAX_MISSES = 3;

// ── Storage helpers ──────────────────────────────────────────────────────────
const STORAGE_KEY = 'ritim.best';
const SCORE_DESC = { gameId: 'ritim', storageKey: STORAGE_KEY, direction: 'higher' as const };

function loadBest(): number {
  const v = safeRead<number>(STORAGE_KEY, 0);
  return Number.isFinite(v) && v >= 0 ? v : 0;
}

function persistBest(): void {
  safeWrite(STORAGE_KEY, best);
}

// ── State variables ──────────────────────────────────────────────────────────
let state: State = 'ready';
let generation = 0;

let bpm = INIT_BPM;
let beatSec = 60 / bpm;
let pulseR = INNER_R;
let elapsed = 0;

let score = 0;
let best = 0;
let misses = 0;
let combo = 0;
let consec = 0;
let beatsLeft = TOTAL_BEATS;

let lastTs = 0;
let rafId = 0;

let fbKind: FeedbackKind = null;
let fbAlpha = 0;

// ── HUD update ───────────────────────────────────────────────────────────────
function updateHud(): void {
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
}

// ── Game flow ────────────────────────────────────────────────────────────────
function advanceBeat(): void {
  beatsLeft--;
  pulseR = INNER_R;
  elapsed = 0;
}

function beginPlay(): void {
  state = 'playing';
  pulseR = INNER_R;
  elapsed = 0;
}

function endGame(): void {
  if (state === 'gameover') return;
  state = 'gameover';
  if (score > best) {
    best = score;
    persistBest();
  }
  reportGameOver(SCORE_DESC, score);
  updateHud();
}

function reset(): void {
  generation++;
  state = 'ready';
  bpm = INIT_BPM;
  beatSec = 60 / bpm;
  pulseR = INNER_R;
  elapsed = 0;
  score = 0;
  misses = 0;
  combo = 0;
  consec = 0;
  beatsLeft = TOTAL_BEATS;
  lastTs = 0;
  fbKind = null;
  fbAlpha = 0;
  updateHud();
  draw();
}

function handleTap(): void {
  if (state === 'ready') {
    beginPlay();
    return;
  }
  if (state === 'gameover') {
    reset();
    return;
  }
  // playing
  const dist = Math.abs(pulseR - TARGET_R);
  if (dist <= PERFECT_W) {
    score += 3 * Math.max(1, Math.floor(combo / 3));
    combo++;
    consec++;
    fbKind = 'perfect';
  } else if (dist <= GOOD_W) {
    score += 1;
    combo++;
    consec++;
    fbKind = 'good';
  } else {
    combo = 0;
    consec = 0;
    misses++;
    fbKind = 'miss';
  }
  fbAlpha = 1;
  advanceBeat();
  if (consec > 0 && consec % HITS_PER_LEVEL === 0) {
    bpm = Math.min(BPM_CAP, bpm + BPM_STEP);
    beatSec = 60 / bpm;
  }
  if (misses >= MAX_MISSES || beatsLeft <= 0) {
    endGame();
  } else {
    updateHud();
  }
}

// ── Update ───────────────────────────────────────────────────────────────────
function update(dt: number): void {
  if (state !== 'playing') return;

  elapsed += dt;
  const range = TARGET_R + GOOD_W + 8 - INNER_R;
  pulseR = INNER_R + range * Math.min(1, elapsed / beatSec);

  if (elapsed >= beatSec) {
    // auto-miss
    combo = 0;
    consec = 0;
    misses++;
    fbKind = 'miss';
    fbAlpha = 1;
    advanceBeat();
    if (misses >= MAX_MISSES || beatsLeft <= 0) {
      endGame();
    } else {
      updateHud();
    }
  }

  if (fbAlpha > 0) {
    fbAlpha = Math.max(0, fbAlpha - dt * 2.2);
  }
}

// ── Draw ─────────────────────────────────────────────────────────────────────
function draw(): void {
  ctx.clearRect(0, 0, W, H);

  // Background
  ctx.fillStyle = '#0a0b0e';
  ctx.fillRect(0, 0, W, H);

  if (state !== 'gameover') {
    // Good zone band
    ctx.beginPath();
    ctx.arc(CX, CY, TARGET_R, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(251,191,36,0.12)';
    ctx.lineWidth = GOOD_W * 2;
    ctx.stroke();

    // Perfect zone band
    ctx.beginPath();
    ctx.arc(CX, CY, TARGET_R, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(251,191,36,0.22)';
    ctx.lineWidth = PERFECT_W * 2;
    ctx.stroke();

    // Target ring outline
    ctx.beginPath();
    ctx.arc(CX, CY, TARGET_R, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 2;
    ctx.shadowColor = 'rgba(255,255,255,0.6)';
    ctx.shadowBlur = 8;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  // Pulse ring (only when playing)
  if (state === 'playing') {
    const dist = Math.abs(pulseR - TARGET_R);
    const closeness = Math.max(0, 1 - dist / GOOD_W);
    const alpha = 0.5 + closeness * 0.5;
    ctx.beginPath();
    ctx.arc(CX, CY, pulseR, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(251,191,36,${alpha})`;
    ctx.lineWidth = 3 + closeness * 3;
    ctx.shadowColor = 'rgba(251,191,36,0.8)';
    ctx.shadowBlur = 12 + closeness * 16;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  // Center circle with radial gradient
  const grad = ctx.createRadialGradient(CX, CY, 0, CX, CY, INNER_R);
  grad.addColorStop(0, 'rgba(253,224,71,1)');
  grad.addColorStop(1, 'rgba(217,119,6,1)');
  ctx.beginPath();
  ctx.arc(CX, CY, INNER_R, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.shadowColor = 'rgba(251,191,36,0.7)';
  ctx.shadowBlur = 18;
  ctx.fill();
  ctx.shadowBlur = 0;

  // In-game info
  if (state === 'playing') {
    // Beats left in center
    ctx.fillStyle = '#0a0b0e';
    ctx.font = 'bold 18px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(beatsLeft), CX, CY);

    // BPM label below center
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillText(`${bpm} BPM`, CX, CY + INNER_R + 14);

    // Combo above center
    if (combo >= 3) {
      ctx.fillStyle = 'rgba(251,191,36,0.9)';
      ctx.font = 'bold 13px system-ui, sans-serif';
      ctx.fillText(`×${combo}`, CX, CY - INNER_R - 14);
    }

    // Hearts at bottom
    const heartY = H - 24;
    const heartSpacing = 28;
    const heartStartX = CX - heartSpacing;
    for (let i = 0; i < MAX_MISSES; i++) {
      const hx = heartStartX + i * heartSpacing;
      ctx.font = '18px system-ui, sans-serif';
      ctx.fillStyle = i < (MAX_MISSES - misses) ? '#ef4444' : 'rgba(255,255,255,0.2)';
      ctx.fillText('♥', hx, heartY);
    }
  }

  // Feedback text
  if (fbKind !== null && fbAlpha > 0) {
    let fbText = '';
    let fbColor = '';
    if (fbKind === 'perfect') { fbText = 'PERFECT!'; fbColor = '#22c55e'; }
    else if (fbKind === 'good') { fbText = 'GOOD'; fbColor = '#eab308'; }
    else { fbText = 'MISS'; fbColor = '#ef4444'; }

    ctx.globalAlpha = fbAlpha;
    ctx.fillStyle = fbColor;
    ctx.font = 'bold 20px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(fbText, CX, CY - TARGET_R - 20);
    ctx.globalAlpha = 1;
  }

  // Overlay screens
  if (state === 'ready' || state === 'gameover') {
    ctx.fillStyle = 'rgba(0,0,0,0.72)';
    ctx.fillRect(0, 0, W, H);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (state === 'ready') {
      ctx.fillStyle = '#fde047';
      ctx.font = 'bold 32px system-ui, sans-serif';
      ctx.fillText('Ritim', CX, CY - 40);

      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.font = '15px system-ui, sans-serif';
      ctx.fillText('Halka hedef çizgisine değince', CX, CY + 4);
      ctx.fillText('SPACE veya ekrana bas', CX, CY + 26);

      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      ctx.font = '13px system-ui, sans-serif';
      ctx.fillText('Başlamak için SPACE ya da dokun', CX, CY + 60);
    } else {
      // gameover
      const won = beatsLeft <= 0 && misses < MAX_MISSES;
      ctx.fillStyle = won ? '#22c55e' : '#ef4444';
      ctx.font = 'bold 28px system-ui, sans-serif';
      ctx.fillText(won ? 'Tebrikler!' : 'Oyun Bitti', CX, CY - 50);

      ctx.fillStyle = '#fde047';
      ctx.font = 'bold 22px system-ui, sans-serif';
      ctx.fillText(`Skor: ${score}`, CX, CY - 8);

      ctx.fillStyle = 'rgba(255,255,255,0.65)';
      ctx.font = '16px system-ui, sans-serif';
      ctx.fillText(`En iyi: ${best}`, CX, CY + 24);

      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      ctx.font = '13px system-ui, sans-serif';
      ctx.fillText('Tekrar oynamak için SPACE ya da dokun', CX, CY + 60);
    }
  }
}

// ── RAF loop ─────────────────────────────────────────────────────────────────
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
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;

  best = loadBest();

  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.code === 'Space') {
      e.preventDefault();
      handleTap();
    } else if (e.key === 'r' || e.key === 'R') {
      reset();
    }
  });

  canvas.addEventListener(
    'pointerdown',
    (e: PointerEvent) => {
      e.preventDefault();
      handleTap();
    },
    { passive: false },
  );

  canvas.addEventListener(
    'touchstart',
    (e: TouchEvent) => {
      e.preventDefault();
    },
    { passive: false },
  );

  restartBtn.addEventListener('click', () => {
    reset();
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      lastTs = 0;
    }
  });

  reset();
  cancelAnimationFrame(rafId);
  lastTs = 0;
  rafId = requestAnimationFrame(frame);
}

export const game = defineGame({ init, reset });
