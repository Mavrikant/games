import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import {
  showOverlay as showOverlayEl,
  hideOverlay as hideOverlayEl,
} from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';

const STORAGE_BEST = 'ip-atla.best';

type State = 'ready' | 'playing' | 'gameover';

const CANVAS_W = 480;
const CANVAS_H = 360;
const GROUND_Y = 290;

const SPINNER_LEFT_X = 60;
const SPINNER_RIGHT_X = CANVAS_W - 60;
const SPINNER_HAND_Y = GROUND_Y - 95;
const SPINNER_RADIUS = 60;

const PLAYER_X = CANVAS_W / 2;
const PLAYER_FOOT_Y = GROUND_Y;
const PLAYER_HEIGHT = 78;

const T_START = 1300;
const T_MIN = 520;
const T_DECAY_PER_5 = 0.92;

const JUMP_DURATION = 360;
const JUMP_HEIGHT_PX = 96;
const CLEAR_PX = 28;

const gen = createGenToken();
let state: State = 'ready';
let score = 0;
let best = 0;

let phase = 0.5;
let prevPhase = 0.5;
let cyclePeriod = T_START;
let isJumping = false;
let jumpStartMs = 0;
let lastFrameMs = 0;
let rafHandle: number | null = null;

let scoreFlashUntil = 0;
let gameOverPhaseFreeze = 0;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayBtn!: HTMLButtonElement;

function updateHud(): void {
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
}

function commitBest(): void {
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
}

function showReady(): void {
  overlayTitle.textContent = 'İp Atla';
  overlayMsg.textContent =
    'İp ayağına gelince zıpla.\nSpace / yukarı ok / ekrana dokun.\nHer 5 atlamada ip biraz daha hızlanır.';
  overlayBtn.textContent = 'Başla';
  showOverlayEl(overlay);
}

function showGameOver(): void {
  overlayTitle.textContent = 'İpe takıldın!';
  const fresh = score > 0 && score >= best;
  overlayMsg.textContent = fresh
    ? `Skor: ${score}  ·  Yeni rekor!`
    : `Skor: ${score}\nRekor: ${best}`;
  overlayBtn.textContent = 'Tekrar dene';
  showOverlayEl(overlay);
}

function reset(): void {
  gen.bump();
  stopRaf();
  state = 'ready';
  score = 0;
  phase = 0.5;
  prevPhase = 0.5;
  cyclePeriod = T_START;
  isJumping = false;
  jumpStartMs = 0;
  scoreFlashUntil = 0;
  gameOverPhaseFreeze = 0;
  updateHud();
  draw(performance.now());
  showReady();
}

function startRound(): void {
  hideOverlayEl(overlay);
  state = 'playing';
  score = 0;
  phase = 0.5;
  prevPhase = 0.5;
  cyclePeriod = T_START;
  isJumping = false;
  jumpStartMs = 0;
  scoreFlashUntil = 0;
  gameOverPhaseFreeze = 0;
  updateHud();
  startRaf();
}

function gameOver(now: number): void {
  state = 'gameover';
  gameOverPhaseFreeze = phase;
  commitBest();
  stopRaf();
  updateHud();
  draw(now);
  showGameOver();
}

function tryJump(now: number): void {
  if (state !== 'playing') return;
  if (isJumping) return;
  isJumping = true;
  jumpStartMs = now;
}

function playerOffsetY(now: number): number {
  if (!isJumping) return 0;
  const elapsed = now - jumpStartMs;
  if (elapsed >= JUMP_DURATION || elapsed < 0) {
    isJumping = false;
    return 0;
  }
  const t = elapsed / JUMP_DURATION;
  return JUMP_HEIGHT_PX * Math.sin(Math.PI * t);
}

function update(dt: number, now: number): void {
  if (state !== 'playing') return;
  prevPhase = phase;
  phase = (phase + dt / cyclePeriod) % 1;
  if (prevPhase > 0.7 && phase < 0.3) {
    const offset = playerOffsetY(now);
    if (offset >= CLEAR_PX) {
      score++;
      scoreFlashUntil = now + 220;
      updateHud();
      if (score % 5 === 0) {
        cyclePeriod = Math.max(T_MIN, cyclePeriod * T_DECAY_PER_5);
      }
    } else {
      gameOver(now);
      return;
    }
  }
  if (isJumping && now - jumpStartMs >= JUMP_DURATION) {
    isJumping = false;
  }
}

function drawBackground(): void {
  const sky = ctx.createLinearGradient(0, 0, 0, GROUND_Y);
  sky.addColorStop(0, '#1c2746');
  sky.addColorStop(1, '#34466c');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, CANVAS_W, GROUND_Y);

  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  for (let i = 0; i < 5; i++) {
    const cx = (i * 97 + 45) % CANVAS_W;
    const cy = 40 + (i * 23) % 60;
    ctx.beginPath();
    ctx.ellipse(cx, cy, 22, 6, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.fillStyle = '#3b2e1d';
  ctx.fillRect(0, GROUND_Y, CANVAS_W, CANVAS_H - GROUND_Y);
  ctx.fillStyle = '#5e4a30';
  ctx.fillRect(0, GROUND_Y, CANVAS_W, 4);

  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  for (let i = 0; i < 12; i++) {
    const x = (i * 41 + 10) % CANVAS_W;
    const y = GROUND_Y + 12 + (i * 17) % 50;
    ctx.fillRect(x, y, 5, 2);
  }
}

function drawSpinner(x: number, ropePhase: number, mirror: boolean): void {
  const shoulderY = SPINNER_HAND_Y - 18;
  const handY = SPINNER_HAND_Y + SPINNER_RADIUS * Math.cos(2 * Math.PI * ropePhase);
  const sideDir = mirror ? -1 : 1;
  const handX = x + sideDir * 6;

  ctx.fillStyle = '#e2dccb';
  ctx.strokeStyle = '#e2dccb';
  ctx.lineWidth = 3;

  ctx.beginPath();
  ctx.arc(x, SPINNER_HAND_Y - 40, 11, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#7c8be8';
  ctx.fillRect(x - 9, shoulderY, 18, 30);

  ctx.fillStyle = '#2f3a64';
  ctx.fillRect(x - 9, shoulderY + 30, 8, GROUND_Y - (shoulderY + 30));
  ctx.fillRect(x + 1, shoulderY + 30, 8, GROUND_Y - (shoulderY + 30));

  ctx.strokeStyle = '#e2dccb';
  ctx.lineWidth = 3.5;
  ctx.beginPath();
  ctx.moveTo(x + sideDir * 9, shoulderY + 4);
  ctx.lineTo(handX, handY);
  ctx.stroke();

  ctx.fillStyle = '#e2dccb';
  ctx.beginPath();
  ctx.arc(handX, handY, 4, 0, Math.PI * 2);
  ctx.fill();
}

function drawRope(ropePhase: number, inFront: boolean): void {
  const handY = SPINNER_HAND_Y + SPINNER_RADIUS * Math.cos(2 * Math.PI * ropePhase);
  const leftX = SPINNER_LEFT_X + 6;
  const rightX = SPINNER_RIGHT_X - 6;
  const midX = (leftX + rightX) / 2;
  const droop = handY > SPINNER_HAND_Y ? 14 : 6;

  ctx.lineWidth = inFront ? 4 : 3;
  ctx.strokeStyle = inFront ? '#ffcc55' : '#7a6230';
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(leftX, handY);
  ctx.quadraticCurveTo(midX, handY + droop, rightX, handY);
  ctx.stroke();
}

function drawPlayer(now: number): void {
  const offset = playerOffsetY(now);
  const bottomY = PLAYER_FOOT_Y - offset;
  const headY = bottomY - PLAYER_HEIGHT + 10;
  const cx = PLAYER_X;
  const tucked = offset > 6;

  ctx.fillStyle = 'rgba(0,0,0,0.32)';
  const shadowW = Math.max(8, 22 - offset / 4);
  ctx.beginPath();
  ctx.ellipse(cx, GROUND_Y + 3, shadowW, 3.5, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#f1c79a';
  ctx.beginPath();
  ctx.arc(cx, headY, 11, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#3a2517';
  ctx.beginPath();
  ctx.arc(cx, headY - 6, 11, Math.PI, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#1a1a1a';
  ctx.beginPath();
  ctx.arc(cx - 3, headY - 1, 1.4, 0, Math.PI * 2);
  ctx.arc(cx + 3, headY - 1, 1.4, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#5fd897';
  const torsoH = tucked ? 26 : 34;
  const torsoY = headY + 10;
  ctx.fillRect(cx - 11, torsoY, 22, torsoH);

  ctx.strokeStyle = '#5fd897';
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.beginPath();
  if (tucked) {
    ctx.moveTo(cx - 11, torsoY + 6);
    ctx.lineTo(cx - 16, torsoY + 16);
    ctx.moveTo(cx + 11, torsoY + 6);
    ctx.lineTo(cx + 16, torsoY + 16);
  } else {
    ctx.moveTo(cx - 11, torsoY + 6);
    ctx.lineTo(cx - 17, torsoY + 22);
    ctx.moveTo(cx + 11, torsoY + 6);
    ctx.lineTo(cx + 17, torsoY + 22);
  }
  ctx.stroke();

  ctx.strokeStyle = '#2554a6';
  ctx.lineWidth = 5;
  ctx.beginPath();
  if (tucked) {
    ctx.moveTo(cx - 6, torsoY + torsoH);
    ctx.lineTo(cx - 10, torsoY + torsoH + 10);
    ctx.lineTo(cx - 6, bottomY);
    ctx.moveTo(cx + 6, torsoY + torsoH);
    ctx.lineTo(cx + 10, torsoY + torsoH + 10);
    ctx.lineTo(cx + 6, bottomY);
  } else {
    ctx.moveTo(cx - 6, torsoY + torsoH);
    ctx.lineTo(cx - 6, bottomY);
    ctx.moveTo(cx + 6, torsoY + torsoH);
    ctx.lineTo(cx + 6, bottomY);
  }
  ctx.stroke();
}

function drawScoreFlash(now: number): void {
  if (now >= scoreFlashUntil) return;
  const t = (scoreFlashUntil - now) / 220;
  ctx.globalAlpha = t;
  ctx.fillStyle = '#7cf0a8';
  ctx.font = 'bold 28px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('+1', PLAYER_X, GROUND_Y - 120 - (1 - t) * 30);
  ctx.globalAlpha = 1;
}

function drawSpeedometer(): void {
  const w = 80;
  const h = 6;
  const x = CANVAS_W / 2 - w / 2;
  const y = 14;
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.fillRect(x, y, w, h);
  const speedFrac = Math.min(
    1,
    (T_START - cyclePeriod) / (T_START - T_MIN),
  );
  ctx.fillStyle = speedFrac > 0.75 ? '#ff7a55' : speedFrac > 0.5 ? '#ffc555' : '#7cf0a8';
  ctx.fillRect(x, y, w * speedFrac, h);
}

function draw(now: number): void {
  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
  drawBackground();

  const ropePhase = state === 'gameover' ? gameOverPhaseFreeze : phase;
  const ropeInFront = ropePhase >= 0.5;

  drawSpinner(SPINNER_LEFT_X, ropePhase, false);
  drawSpinner(SPINNER_RIGHT_X, ropePhase, true);

  if (ropeInFront) {
    drawPlayer(now);
    drawRope(ropePhase, true);
  } else {
    drawRope(ropePhase, false);
    drawPlayer(now);
  }

  drawScoreFlash(now);
  drawSpeedometer();
}

function startRaf(): void {
  if (rafHandle !== null) return;
  const myGen = gen.current();
  lastFrameMs = performance.now();
  const loop = (t: number): void => {
    if (!gen.isCurrent(myGen)) {
      rafHandle = null;
      return;
    }
    const dt = Math.min(50, t - lastFrameMs);
    lastFrameMs = t;
    update(dt, t);
    draw(t);
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

function onKey(e: KeyboardEvent): void {
  const k = e.key.toLowerCase();
  if (k === 'r') {
    reset();
    e.preventDefault();
    return;
  }
  if (state === 'ready' || state === 'gameover') {
    if (k === ' ' || k === 'enter') {
      startRound();
      e.preventDefault();
    }
    return;
  }
  if (k === ' ' || k === 'arrowup' || k === 'w') {
    tryJump(performance.now());
    e.preventDefault();
  }
}

function onCanvasPointerDown(e: PointerEvent): void {
  e.preventDefault();
  if (state === 'ready' || state === 'gameover') {
    startRound();
    return;
  }
  tryJump(performance.now());
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  canvas.addEventListener('pointerdown', onCanvasPointerDown);
  restartBtn.addEventListener('click', reset);
  overlayBtn.addEventListener('click', () => startRound());
  window.addEventListener('keydown', onKey);

  reset();
}

export const game = defineGame({ init, reset });
