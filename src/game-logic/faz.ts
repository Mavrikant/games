// Faz — phase-capture rhythm/timing arcade.
//
// Two sine waves scroll at different speeds. A vertical capture line sits at
// the canvas centre; the player presses Space (or taps) to "capture" the
// moment. Score for a capture is highest when the two waves cross at the
// capture line (their Y values match). Difficulty ramps via amplitude, period
// and scroll speed every few captures.
//
// PITFALLS guarded:
// - module-level-dom-access: all DOM/storage access lives in init().
// - unguarded-storage: safeRead/safeWrite wrap localStorage.
// - stale-async-callback: gen.bump() in reset() cancels the RAF chain.
// - overlay-input-leak: pointer + key handlers gate on state, default returns.
// - missing-overlay-css: per-game CSS defines .overlay--hidden visual.
// - unreachable-start-state: overlay has both a Start button and Space/Enter,
//   plus tapping the canvas while ready also starts.
// - hud-counter-synced-only-at-lifecycle-edges: setScore/setTime mutate DOM.
// - visual-vs-hitbox: capture uses the same sine sampler as the renderer.

import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay, hideOverlay } from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';

const STORAGE_BEST = 'faz.best';

const CANVAS_W = 480;
const CANVAS_H = 540;
const CAPTURE_X = CANVAS_W / 2;
const WAVE_MID_Y = CANVAS_H / 2;

const ROUND_DURATION = 45; // seconds
const PERFECT_DIST = 6; // px — full-score window
const ZERO_DIST = 90; // px — beyond this scores zero
const STREAK_FOR_BONUS = 3;
const PERFECT_BONUS = 25;

type State = 'ready' | 'playing' | 'gameover';

interface Wave {
  amplitude: number; // px
  period: number; // px per cycle
  phase: number; // radians
  speed: number; // radians per second (sign = scroll direction)
  color: string;
}

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let timeEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayBtn!: HTMLButtonElement;

const gen = createGenToken();

let state: State = 'ready';
let score = 0;
let best = 0;
let timeLeft = ROUND_DURATION;

let lastFrame = 0;
let nowSec = 0;

let captureCount = 0;
let streak = 0;
let difficulty = 1;

interface LastCapture {
  value: number;
  tier: 'perfect' | 'good' | 'miss';
  bonus: number;
  born: number;
}
let lastCapture: LastCapture | null = null;

let flashTimer = 0;
let flashColor = '#000';

const waveA: Wave = makeWave('#7cc8ff');
const waveB: Wave = makeWave('#ffae6c');

function makeWave(color: string): Wave {
  return {
    amplitude: 80,
    period: 110,
    phase: 0,
    speed: 1.4,
    color,
  };
}

function randomSign(): number {
  return Math.random() < 0.5 ? -1 : 1;
}

function randomizeWaves(): void {
  const ampMin = 50;
  const ampMax = Math.min(150, 80 + difficulty * 8);
  const periodMin = Math.max(70, 120 - difficulty * 4);
  const periodMax = Math.max(periodMin + 30, 170 - difficulty * 4);
  const speedBase = 1.0 + Math.min(2.5, difficulty * 0.18);

  waveA.amplitude = ampMin + Math.random() * (ampMax - ampMin);
  waveB.amplitude = ampMin + Math.random() * (ampMax - ampMin);
  waveA.period = periodMin + Math.random() * (periodMax - periodMin);
  waveB.period = periodMin + Math.random() * (periodMax - periodMin);
  waveA.phase = Math.random() * Math.PI * 2;
  waveB.phase = Math.random() * Math.PI * 2;
  waveA.speed = randomSign() * (speedBase + Math.random() * 0.8);
  waveB.speed = randomSign() * (speedBase + Math.random() * 0.8);
  // Force the two waves to scroll in different directions sometimes so they
  // never appear "frozen relative" to each other.
  if (Math.sign(waveA.speed) === Math.sign(waveB.speed) && Math.random() < 0.5) {
    waveB.speed = -waveB.speed;
  }
}

function waveYAt(w: Wave, x: number): number {
  return Math.sin((x / w.period) * Math.PI * 2 + w.phase) * w.amplitude;
}

function setScore(v: number): void {
  score = v;
  scoreEl.textContent = String(score);
  if (score > best) {
    best = score;
    bestEl.textContent = String(best);
    safeWrite(STORAGE_BEST, best);
  }
}

function setTime(v: number): void {
  timeLeft = Math.max(0, v);
  timeEl.textContent = timeLeft.toFixed(1);
}

function pointsForDistance(distPx: number): number {
  if (distPx >= ZERO_DIST) return 0;
  if (distPx <= PERFECT_DIST) return 100;
  // Quadratic falloff between perfect and zero windows.
  const t = (distPx - PERFECT_DIST) / (ZERO_DIST - PERFECT_DIST);
  const norm = 1 - t * t;
  return Math.max(1, Math.round(norm * 100));
}

function tryCapture(): void {
  if (state !== 'playing') return;
  const ya = waveYAt(waveA, CAPTURE_X);
  const yb = waveYAt(waveB, CAPTURE_X);
  const dist = Math.abs(ya - yb);
  const pts = pointsForDistance(dist);

  let bonus = 0;
  let tier: LastCapture['tier'];
  if (pts >= 90) {
    tier = 'perfect';
    streak++;
    if (streak >= STREAK_FOR_BONUS) {
      bonus = PERFECT_BONUS;
      streak = 0;
    }
    flashTimer = 0.35;
    flashColor = '#9be7ff';
  } else if (pts > 0) {
    tier = 'good';
    streak = 0;
    flashTimer = 0.25;
    flashColor = '#ffd166';
  } else {
    tier = 'miss';
    streak = 0;
    flashTimer = 0.2;
    flashColor = '#ff6b6b';
  }

  setScore(score + pts + bonus);

  lastCapture = { value: pts, tier, bonus, born: nowSec };
  captureCount++;
  difficulty = 1 + Math.floor(captureCount / 3);
  randomizeWaves();
}

function endRound(): void {
  state = 'gameover';
  overlayTitle.textContent = 'Faz Bitti';
  overlayMsg.textContent =
    `Skor: ${score}  ·  Rekor: ${best}\n` +
    `${captureCount} yakalama · zorluk ${difficulty}\n` +
    'Boşluk veya tıkla: yeniden başla.';
  overlayBtn.textContent = 'Yeniden başla';
  showOverlay(overlay);
}

function startGame(): void {
  state = 'playing';
  setScore(0);
  setTime(ROUND_DURATION);
  streak = 0;
  captureCount = 0;
  difficulty = 1;
  lastCapture = null;
  nowSec = 0;
  randomizeWaves();
  hideOverlay(overlay);
}

function reset(): void {
  gen.bump();
  state = 'ready';
  setScore(0);
  setTime(ROUND_DURATION);
  streak = 0;
  captureCount = 0;
  difficulty = 1;
  lastCapture = null;
  nowSec = 0;
  lastFrame = 0;
  randomizeWaves();
  overlayTitle.textContent = 'Faz';
  overlayMsg.textContent =
    'İki dalga farklı hızlarda kayar.\n' +
    'Tam üst üste binme anında yakala —\n' +
    'noktalar ne kadar yakın, puan o kadar yüksek.\n' +
    'Üst üste 3 mükemmel = +25 kombo.';
  overlayBtn.textContent = 'Başla';
  showOverlay(overlay);
  requestAnimationFrame(loop);
}

function drawBackground(): void {
  const grd = ctx.createLinearGradient(0, 0, 0, CANVAS_H);
  grd.addColorStop(0, '#0a0d18');
  grd.addColorStop(1, '#11142a');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, WAVE_MID_Y);
  ctx.lineTo(CANVAS_W, WAVE_MID_Y);
  ctx.stroke();
}

function drawWave(w: Wave): void {
  // Soft halo underneath.
  ctx.save();
  ctx.strokeStyle = w.color;
  ctx.globalAlpha = 0.22;
  ctx.lineWidth = 7;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  for (let x = 0; x <= CANVAS_W; x += 3) {
    const y = WAVE_MID_Y + waveYAt(w, x);
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.restore();

  // Crisp line.
  ctx.beginPath();
  for (let x = 0; x <= CANVAS_W; x += 2) {
    const y = WAVE_MID_Y + waveYAt(w, x);
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = w.color;
  ctx.lineWidth = 2.4;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();
}

function drawCaptureLine(): void {
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  ctx.setLineDash([5, 5]);
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(CAPTURE_X, 24);
  ctx.lineTo(CAPTURE_X, CANVAS_H - 24);
  ctx.stroke();
  ctx.restore();
}

function drawDots(): void {
  const ya = WAVE_MID_Y + waveYAt(waveA, CAPTURE_X);
  const yb = WAVE_MID_Y + waveYAt(waveB, CAPTURE_X);

  const dist = Math.abs(ya - yb);
  const closeness = Math.max(0, 1 - dist / ZERO_DIST);
  ctx.save();
  ctx.strokeStyle = `rgba(255,255,255,${0.18 + closeness * 0.7})`;
  ctx.lineWidth = 2 + closeness * 3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(CAPTURE_X, ya);
  ctx.lineTo(CAPTURE_X, yb);
  ctx.stroke();
  ctx.restore();

  if (closeness > 0.7) {
    const mid = (ya + yb) / 2;
    const haloR = 18 + closeness * 28;
    const grd = ctx.createRadialGradient(CAPTURE_X, mid, 0, CAPTURE_X, mid, haloR);
    grd.addColorStop(0, `rgba(155,231,255,${0.55 * closeness})`);
    grd.addColorStop(1, 'rgba(155,231,255,0)');
    ctx.fillStyle = grd;
    ctx.beginPath();
    ctx.arc(CAPTURE_X, mid, haloR, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.fillStyle = waveA.color;
  ctx.beginPath();
  ctx.arc(CAPTURE_X, ya, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = waveB.color;
  ctx.beginPath();
  ctx.arc(CAPTURE_X, yb, 7, 0, Math.PI * 2);
  ctx.fill();
}

function drawHud(): void {
  if (lastCapture && nowSec - lastCapture.born < 1.0) {
    const age = nowSec - lastCapture.born;
    const t = age / 1.0;
    ctx.save();
    ctx.globalAlpha = Math.max(0, 1 - t);
    let color = '#ff6b6b';
    if (lastCapture.tier === 'perfect') color = '#9be7ff';
    else if (lastCapture.tier === 'good') color = '#ffd166';
    ctx.fillStyle = color;
    ctx.font = '700 30px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    const txt =
      lastCapture.tier === 'miss' ? 'kaçtı' : `+${lastCapture.value}`;
    ctx.fillText(txt, CAPTURE_X, WAVE_MID_Y - 50 - 28 * t);
    if (lastCapture.bonus > 0) {
      ctx.font = '700 16px system-ui, -apple-system, sans-serif';
      ctx.fillStyle = '#9be7ff';
      ctx.fillText(
        `kombo +${lastCapture.bonus}`,
        CAPTURE_X,
        WAVE_MID_Y - 24 - 28 * t,
      );
    }
    ctx.restore();
  }

  if (state === 'playing' && streak > 0) {
    ctx.save();
    ctx.fillStyle = '#9be7ff';
    ctx.font = '700 14px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('✦'.repeat(streak), CAPTURE_X, 18);
    ctx.restore();
  }

  if (state === 'playing') {
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.font = '600 11px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(`zorluk ${difficulty}`, CANVAS_W - 12, 18);
    ctx.restore();
  }
}

function drawFlash(): void {
  if (flashTimer <= 0) return;
  ctx.save();
  ctx.globalAlpha = (flashTimer / 0.35) * 0.35;
  ctx.fillStyle = flashColor;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  ctx.restore();
}

function draw(): void {
  drawBackground();
  drawWave(waveA);
  drawWave(waveB);
  drawCaptureLine();
  drawDots();
  drawHud();
  drawFlash();
}

function update(dt: number): void {
  // Animate even outside `playing` so the screen isn't static.
  waveA.phase += waveA.speed * dt;
  waveB.phase += waveB.speed * dt;
  if (state !== 'playing') return;

  nowSec += dt;
  setTime(timeLeft - dt);
  if (timeLeft <= 0) {
    endRound();
    return;
  }
  flashTimer = Math.max(0, flashTimer - dt);
}

function loop(timestamp: number): void {
  const myGen = gen.current();
  if (!gen.isCurrent(myGen)) return;

  const t = timestamp / 1000;
  const raw = lastFrame === 0 ? 0 : t - lastFrame;
  const dt = Math.min(raw, 1 / 15);
  lastFrame = t;

  update(dt);
  draw();

  if (gen.isCurrent(myGen)) {
    requestAnimationFrame((ts) => {
      if (gen.isCurrent(myGen)) loop(ts);
    });
  }
}

function onPointer(e: PointerEvent): void {
  if (state === 'ready') {
    startGame();
    return;
  }
  if (state === 'gameover') {
    reset();
    return;
  }
  if (state === 'playing') {
    tryCapture();
    e.preventDefault();
  }
}

function onKey(e: KeyboardEvent): void {
  const k = e.key.toLowerCase();
  if (k === 'r') {
    reset();
    e.preventDefault();
    return;
  }
  if (state === 'ready') {
    if (k === ' ' || k === 'enter') {
      startGame();
      e.preventDefault();
    }
    return;
  }
  if (state === 'playing') {
    if (k === ' ' || k === 'enter') {
      tryCapture();
      e.preventDefault();
    }
    return;
  }
  if (state === 'gameover') {
    if (k === ' ' || k === 'enter') {
      reset();
      e.preventDefault();
    }
    return;
  }
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  timeEl = document.querySelector<HTMLElement>('#time')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;

  best = safeRead<number>(STORAGE_BEST, 0);
  bestEl.textContent = String(best);

  canvas.addEventListener('pointerdown', onPointer);
  window.addEventListener('keydown', onKey);
  restartBtn.addEventListener('click', reset);
  overlayBtn.addEventListener('click', () => {
    if (state === 'ready') startGame();
    else if (state === 'gameover') reset();
  });

  reset();
}

export const game = defineGame({ init, reset });
