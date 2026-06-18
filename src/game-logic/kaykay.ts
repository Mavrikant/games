import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import {
  showOverlay as showOverlayEl,
  hideOverlay as hideOverlayEl,
} from '@shared/overlay';

// PITFALLS guarded here (docs/PITFALLS.md):
// - unguarded-storage: safeRead/safeWrite wrap localStorage in try/catch.
// - overlay-input-leak: state enum + state guard at the top of every input
//   handler. Spin starts only when state === 'airborne'.
// - invisible-boot: first input either starts the run (Ready → Rolling) or
//   spins the deck (Airborne) in the same frame — visible feedback < 250 ms.
// - stale-async-callback: the RAF loop checks `state` each frame and stops
//   itself on gameover; reset() flushes per-run state.
// - visual-vs-hitbox: landing test uses the same boardAngle that draw()
//   reads — single source of truth.
// - module-level-dom-access: all DOM access lives inside init().

const STORAGE_BEST = 'kaykay.best';

type State = 'ready' | 'rolling' | 'airborne' | 'gameover';

const W = 480;
const H = 320;
const GROUND_Y = 240;

const SKATER_X = 180;
const SKATER_H = 56;

const FORWARD_SPEED = 200; // px/s ground scroll while rolling.
const RAMP_SPACING = 460; // distance between ramps (world px).
const RAMP_W = 70;
const RAMP_H = 64;

const JUMP_VY = 480; // initial upward velocity (px/s).
const GRAVITY = 1200; // px/s^2 — gives ~0.8 s airtime.

const BASE_SPIN_RATE = 540; // deg/s while holding (1.5 flips/s base).
const SPIN_RATE_PER_SCORE = 9; // ramps up with score for added difficulty.
const SPIN_RATE_MAX_BONUS = 540; // caps at 1080 deg/s (3 flips/s).

const LANDING_TOL_DEG = 22; // wheels-down tolerance window each side.

const MAX_LIVES = 3;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let livesEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayStartBtn!: HTMLButtonElement;

let state: State = 'ready';
let score = 0;
let best = 0;
let lives = MAX_LIVES;

// World/scroll state.
let groundScroll = 0;
// Distance the world has rolled since the *last* ramp launch. When this
// reaches RAMP_SPACING we trigger a new airborne sequence.
let sinceLastRamp = 0;

// Airborne state.
let airY = 0; // negative = above ground.
let airVy = 0;
let boardAngle = 0; // degrees, 0 = wheels down, signed continuous.
let totalRotation = 0; // total absolute degrees spun this jump.
let isSpinning = false;

// Banner shown after a landing for a moment.
let bannerText = '';
let bannerKind: 'ok' | 'bail' | '' = '';
let bannerT = 0;

let rafId = 0;
let lastFrameMs = 0;

function setScore(v: number): void {
  score = v;
  scoreEl.textContent = String(score);
}

function setBest(v: number): void {
  best = v;
  bestEl.textContent = String(best);
}

function setLives(v: number): void {
  lives = Math.max(0, v);
  livesEl.textContent = lives > 0 ? '♥'.repeat(lives) : '0';
}

function commitBest(): void {
  if (score > best) {
    setBest(score);
    safeWrite(STORAGE_BEST, best);
  }
}

function showStartOverlay(): void {
  overlayTitle.textContent = 'Kaykay';
  overlayMsg.textContent =
    "Rampaya değdiğin an havalanırsın. Havadayken Boşluk'u BASILI TUT — tahta " +
    'dönsün; doğru anda BIRAK — tekerlek üstüne in. Her tam dönüş daha çok ' +
    "puan getirir, ters açıda iniş can götürür.\n\n" +
    "Başlamak için Boşluk'a bas ya da alana dokun.";
  overlayStartBtn.textContent = 'Başla';
  showOverlayEl(overlay);
}

function showGameOverOverlay(): void {
  overlayTitle.textContent = 'Düştün';
  overlayMsg.textContent =
    `Skor: ${score} · Rekor: ${best}\n` +
    "Yeniden başlatmak için Boşluk'a bas ya da Yeniden başla'ya dokun.";
  overlayStartBtn.textContent = 'Tekrar oyna';
  showOverlayEl(overlay);
}

function startRun(): void {
  setScore(0);
  setLives(MAX_LIVES);
  groundScroll = 0;
  sinceLastRamp = 0;
  airY = 0;
  airVy = 0;
  boardAngle = 0;
  totalRotation = 0;
  isSpinning = false;
  bannerText = '';
  bannerKind = '';
  bannerT = 0;
  state = 'rolling';
  hideOverlayEl(overlay);
}

function reset(): void {
  state = 'ready';
  setScore(0);
  setLives(MAX_LIVES);
  groundScroll = 0;
  sinceLastRamp = 0;
  airY = 0;
  airVy = 0;
  boardAngle = 0;
  totalRotation = 0;
  isSpinning = false;
  bannerText = '';
  bannerKind = '';
  bannerT = 0;
  showStartOverlay();
}

function launch(): void {
  state = 'airborne';
  airY = 0;
  airVy = -JUMP_VY;
  boardAngle = 0;
  totalRotation = 0;
  isSpinning = false;
}

function currentSpinRate(): number {
  const bonus = Math.min(SPIN_RATE_MAX_BONUS, score * SPIN_RATE_PER_SCORE);
  return BASE_SPIN_RATE + bonus;
}

function land(): void {
  const mod = ((boardAngle % 360) + 360) % 360;
  const off = Math.min(mod, 360 - mod);
  const flips = Math.floor(totalRotation / 360);
  const clean = off <= LANDING_TOL_DEG;

  if (clean) {
    // 0 flip = 1, 1 flip = 2, 2 flips = 4, 3 flips = 6... (2 per flip, floor 1)
    const gain = flips === 0 ? 1 : flips * 2;
    setScore(score + gain);
    commitBest();
    bannerText = flips > 0 ? `Temiz! +${gain} (${flips} flip)` : `Ollie! +${gain}`;
    bannerKind = 'ok';
  } else {
    setLives(lives - 1);
    bannerText = 'Düştün! -1 can';
    bannerKind = 'bail';
  }
  bannerT = 1.2;

  // Reset post-landing trajectory.
  airY = 0;
  airVy = 0;
  isSpinning = false;
  totalRotation = 0;
  boardAngle = 0;
  sinceLastRamp = 0;

  if (lives <= 0) {
    state = 'gameover';
    showGameOverOverlay();
    return;
  }
  state = 'rolling';
}

function pressSpin(): void {
  if (state === 'ready') {
    startRun();
    return;
  }
  if (state === 'gameover') {
    startRun();
    return;
  }
  if (state === 'airborne') {
    isSpinning = true;
  }
}

function releaseSpin(): void {
  if (state === 'airborne') {
    isSpinning = false;
  }
}

function step(dtMs: number): void {
  const dt = dtMs / 1000;

  if (bannerT > 0) {
    bannerT = Math.max(0, bannerT - dt);
    if (bannerT === 0) {
      bannerText = '';
      bannerKind = '';
    }
  }

  if (state === 'rolling') {
    groundScroll += FORWARD_SPEED * dt;
    sinceLastRamp += FORWARD_SPEED * dt;
    if (sinceLastRamp >= RAMP_SPACING) {
      launch();
    }
    return;
  }
  if (state === 'airborne') {
    groundScroll += FORWARD_SPEED * dt;
    airVy += GRAVITY * dt;
    airY += airVy * dt;
    if (isSpinning) {
      const da = currentSpinRate() * dt;
      boardAngle += da;
      totalRotation += da;
    }
    if (airY >= 0) {
      airY = 0;
      land();
    }
  }
}

function drawSky(): void {
  const grad = ctx.createLinearGradient(0, 0, 0, GROUND_Y);
  grad.addColorStop(0, '#1a1f3a');
  grad.addColorStop(1, '#ff8c5c');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, GROUND_Y);

  // A few simple stars.
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  for (let i = 0; i < 16; i++) {
    const x = (i * 53 + 11) % W;
    const y = (i * 37) % 100;
    ctx.fillRect(x, y, 2, 2);
  }

  // Distant mountain silhouette (subtle parallax with groundScroll).
  ctx.fillStyle = 'rgba(20, 20, 40, 0.55)';
  ctx.beginPath();
  ctx.moveTo(0, GROUND_Y);
  const baseOffset = (groundScroll * 0.06) % 80;
  for (let x = -80; x <= W + 80; x += 80) {
    const px = x - baseOffset;
    ctx.lineTo(px + 40, GROUND_Y - 60);
    ctx.lineTo(px + 80, GROUND_Y);
  }
  ctx.lineTo(W, GROUND_Y);
  ctx.closePath();
  ctx.fill();
}

function drawGround(): void {
  ctx.fillStyle = '#2c2118';
  ctx.fillRect(0, GROUND_Y, W, H - GROUND_Y);

  // Scrolling stripes give a sense of speed.
  ctx.fillStyle = '#3a2a1f';
  const off = -(groundScroll % 32);
  for (let x = off; x < W + 32; x += 32) {
    ctx.fillRect(x, GROUND_Y + 8, 16, 3);
    ctx.fillRect(x + 8, GROUND_Y + 26, 12, 2);
  }

  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  ctx.fillRect(0, GROUND_Y, W, 2);
}

function drawRamp(): void {
  // Visible position depends on state.
  // rolling: distance until launch maps to screen X.
  // airborne: ramp scrolls left at FORWARD_SPEED based on air-time elapsed.
  let rx: number;
  if (state === 'airborne') {
    // Air-elapsed via the velocity integral (independent of frame timing).
    const airElapsed = (airVy + JUMP_VY) / GRAVITY;
    rx = SKATER_X - airElapsed * FORWARD_SPEED;
  } else {
    rx = SKATER_X + (RAMP_SPACING - sinceLastRamp);
  }
  if (rx > W + 40 || rx < -RAMP_W - 40) return;

  // Triangle ramp pointing up-left (skater rolls up its right edge).
  ctx.save();
  ctx.fillStyle = '#3b4a6b';
  ctx.strokeStyle = '#0c1226';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(rx, GROUND_Y);
  ctx.lineTo(rx + RAMP_W, GROUND_Y);
  ctx.lineTo(rx + RAMP_W, GROUND_Y - RAMP_H);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Stripes on the ramp face.
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 5; i++) {
    const y = GROUND_Y - (RAMP_H * i) / 5;
    const x = rx + RAMP_W - (RAMP_W * i) / 5;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(rx + RAMP_W, y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawSkater(): void {
  const cy = GROUND_Y - SKATER_H / 2 + airY;
  const cx = SKATER_X;

  ctx.save();
  ctx.translate(cx, cy);

  // Shadow on the ground (visible while in air for parallax depth).
  if (state === 'airborne') {
    ctx.save();
    ctx.translate(0, SKATER_H / 2 - airY);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.ellipse(0, 6, 22, 5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Body
  ctx.fillStyle = '#1a1f30';
  ctx.fillRect(-6, -SKATER_H / 2, 12, 26);
  // Head
  ctx.beginPath();
  ctx.arc(0, -SKATER_H / 2 - 8, 8, 0, Math.PI * 2);
  ctx.fillStyle = '#f3d8b0';
  ctx.fill();
  ctx.strokeStyle = '#0c1226';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  // Beanie
  ctx.fillStyle = '#dc2626';
  ctx.beginPath();
  ctx.arc(0, -SKATER_H / 2 - 11, 8, Math.PI, 0);
  ctx.fill();

  // Arms — wider when spinning, gives a visible cue.
  ctx.strokeStyle = '#1a1f30';
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.beginPath();
  if (state === 'airborne' && isSpinning) {
    ctx.moveTo(-6, -SKATER_H / 2 + 4);
    ctx.lineTo(-14, -SKATER_H / 2 - 4);
    ctx.moveTo(6, -SKATER_H / 2 + 4);
    ctx.lineTo(14, -SKATER_H / 2 - 4);
  } else {
    ctx.moveTo(-6, -SKATER_H / 2 + 6);
    ctx.lineTo(-12, -SKATER_H / 2 + 18);
    ctx.moveTo(6, -SKATER_H / 2 + 6);
    ctx.lineTo(12, -SKATER_H / 2 + 18);
  }
  ctx.stroke();

  // Legs
  ctx.beginPath();
  ctx.moveTo(-3, -2);
  ctx.lineTo(-7, SKATER_H / 2 - 10);
  ctx.moveTo(3, -2);
  ctx.lineTo(7, SKATER_H / 2 - 10);
  ctx.stroke();

  // Board — drawn below the skater, rotated by boardAngle.
  ctx.save();
  ctx.translate(0, SKATER_H / 2 - 6);
  const rad = (boardAngle * Math.PI) / 180;
  ctx.rotate(rad);

  // Deck plank — top half painted orange, bottom half darker so flip is
  // visible during rotation.
  const deckW = 56;
  const deckH = 7;
  ctx.fillStyle = '#f59e0b';
  ctx.fillRect(-deckW / 2, -deckH / 2, deckW, deckH);
  ctx.fillStyle = '#92400e';
  ctx.fillRect(-deckW / 2, 0, deckW, deckH / 2);
  ctx.strokeStyle = '#5a2606';
  ctx.lineWidth = 1.2;
  ctx.strokeRect(-deckW / 2, -deckH / 2, deckW, deckH);

  // Trucks + wheels — anchored on the "bottom" side of the deck (positive
  // local Y), so rotation visibly flips them.
  ctx.fillStyle = '#9ca3af';
  ctx.fillRect(-deckW / 2 + 8, deckH / 2, 4, 6);
  ctx.fillRect(deckW / 2 - 12, deckH / 2, 4, 6);
  ctx.fillStyle = '#fef3c7';
  ctx.beginPath();
  ctx.arc(-deckW / 2 + 10, deckH / 2 + 9, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(deckW / 2 - 10, deckH / 2 + 9, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#1a1f30';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(-deckW / 2 + 10, deckH / 2 + 9, 5, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(deckW / 2 - 10, deckH / 2 + 9, 5, 0, Math.PI * 2);
  ctx.stroke();

  ctx.restore();
  ctx.restore();
}

function drawAirHud(): void {
  if (state !== 'airborne') return;
  const flips = Math.floor(totalRotation / 360);
  const mod = ((boardAngle % 360) + 360) % 360;
  const off = Math.min(mod, 360 - mod);
  const clean = off <= LANDING_TOL_DEG;

  ctx.save();
  ctx.font = '600 13px Inter, system-ui, sans-serif';
  ctx.textAlign = 'center';

  // Flip counter above the skater.
  const label = `${flips} flip`;
  ctx.fillStyle = clean ? '#5eead4' : '#fbbf24';
  ctx.fillText(label, SKATER_X, GROUND_Y - SKATER_H + airY - 28);

  // Tolerance bar: needle = current deck angle, centre = wheels-down.
  const barW = 80;
  const barX = SKATER_X - barW / 2;
  const barY = GROUND_Y - SKATER_H + airY - 18;
  ctx.fillStyle = 'rgba(255,255,255,0.15)';
  ctx.fillRect(barX, barY, barW, 4);
  ctx.fillStyle = '#5eead4';
  ctx.fillRect(barX + barW / 2 - 1, barY - 2, 2, 8);

  let signed = mod;
  if (signed > 180) signed -= 360;
  const px = barX + barW / 2 + (signed / 180) * (barW / 2);
  ctx.fillStyle = clean ? '#5eead4' : '#f87171';
  ctx.fillRect(px - 1.5, barY - 1, 3, 6);

  ctx.restore();
}

function drawBanner(): void {
  if (!bannerText) return;
  const alpha = Math.min(1, bannerT / 0.4);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = '700 20px Inter, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = bannerKind === 'bail' ? '#f87171' : '#5eead4';
  ctx.fillText(bannerText, W / 2, 100);
  ctx.restore();
}

function draw(): void {
  ctx.clearRect(0, 0, W, H);
  drawSky();
  drawGround();
  drawRamp();
  drawSkater();
  drawAirHud();
  drawBanner();
}

function tick(now: number): void {
  const dtMs = lastFrameMs === 0 ? 16 : Math.min(50, now - lastFrameMs);
  lastFrameMs = now;
  step(dtMs);
  draw();
  rafId = requestAnimationFrame(tick);
}

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
  overlayStartBtn = document.querySelector<HTMLButtonElement>('#overlay-start')!;

  best = safeRead<number>(STORAGE_BEST, 0);
  setBest(best);
  setScore(0);
  setLives(MAX_LIVES);

  // Pointer on the canvas: press-to-spin / release-to-stop. Also doubles
  // as the start input when state === 'ready' or 'gameover'.
  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    pressSpin();
  });
  canvas.addEventListener('pointerup', (e) => {
    e.preventDefault();
    releaseSpin();
  });
  canvas.addEventListener('pointercancel', () => {
    releaseSpin();
  });
  canvas.addEventListener('pointerleave', () => {
    releaseSpin();
  });

  // Overlay swallows pointer to avoid the canvas listener double-firing
  // while it visually covers the board (pitfall: overlay-input-leak).
  overlay.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    pressSpin();
  });
  overlayStartBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    pressSpin();
  });

  restartBtn.addEventListener('click', () => {
    reset();
  });

  window.addEventListener('keydown', (e) => {
    const k = e.key;
    if (k === ' ' || k === 'Enter') {
      if (!e.repeat) pressSpin();
      e.preventDefault();
      return;
    }
    if (k === 'r' || k === 'R') {
      reset();
      e.preventDefault();
    }
  });
  window.addEventListener('keyup', (e) => {
    const k = e.key;
    if (k === ' ' || k === 'Enter') {
      releaseSpin();
      e.preventDefault();
    }
  });

  reset();
  if (rafId !== 0) cancelAnimationFrame(rafId);
  lastFrameMs = 0;
  rafId = requestAnimationFrame(tick);
}

export const game = defineGame({ init, reset });
