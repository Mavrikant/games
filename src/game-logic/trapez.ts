import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';
import { reportGameOver } from '@shared/leaderboard';

const STORAGE_KEY = 'trapez.best';
const SCORE_DESC = { gameId: 'trapez', storageKey: STORAGE_KEY, direction: 'higher' as const };

const W = 480;
const H = 480;
const PIVOT_Y = 56;
const PIVOT_A_X = 132;
const PIVOT_B_X = 348;
const BASE_ROPE_LEN = 168;
const FLOOR_Y = 432;
const GRAVITY = 680;
const CATCH_RADIUS = 40;

type Side = 'A' | 'B';
type State = 'ready' | 'playing' | 'gameover';

interface Trapeze {
  px: number;
  py: number;
  len: number;
  amp: number;
  period: number;
  phase: number;
}

interface Player {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlayEl!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;

let state: State = 'ready';
let trapA!: Trapeze;
let trapB!: Trapeze;
let player!: Player;
let onBar: Side | null = 'A';
let target: Side = 'B';
let elapsed = 0;
let releaseGuard = 0;
let score = 0;
let best = 0;
let rafId: number | null = null;
let lastTime = 0;

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function makeTrapeze(px: number, difficulty: number): Trapeze {
  const period = Math.max(1.15, 1.75 - difficulty * 0.028);
  const amp = Math.min(0.98, 0.62 + difficulty * 0.022);
  const len = Math.max(138, BASE_ROPE_LEN - difficulty * 1.0);
  return {
    px,
    py: PIVOT_Y,
    len,
    amp,
    period,
    phase: rand(0, Math.PI * 2),
  };
}

function barPos(t: Trapeze, time: number): { x: number; y: number; angle: number; omega: number } {
  const w = (2 * Math.PI) / t.period;
  const ang = t.amp * Math.sin(w * time + t.phase);
  const omega = t.amp * w * Math.cos(w * time + t.phase);
  return {
    x: t.px + t.len * Math.sin(ang),
    y: t.py + t.len * Math.cos(ang),
    angle: ang,
    omega,
  };
}

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlayEl);
}

function commitBest(): void {
  if (score > best) {
    best = score;
    safeWrite(STORAGE_KEY, best);
    bestEl.textContent = String(best);
  }
}

function reset(): void {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  state = 'ready';
  score = 0;
  elapsed = 0;
  releaseGuard = 0;
  trapA = makeTrapeze(PIVOT_A_X, 0);
  trapA.phase = 0;
  trapB = makeTrapeze(PIVOT_B_X, 0);
  trapB.phase = Math.PI;
  onBar = 'A';
  target = 'B';
  const pos = barPos(trapA, 0);
  player = { x: pos.x, y: pos.y, vx: 0, vy: 0 };
  scoreEl.textContent = '0';
  bestEl.textContent = String(best);
  showOverlay('Trapez', 'Boşluk / Tıkla — barı salıver, karşı trapeze yetiş.');
  draw();
}

function startPlaying(): void {
  state = 'playing';
  hideOverlayEl(overlayEl);
  lastTime = performance.now();
  if (rafId === null) rafId = requestAnimationFrame(frame);
}

function release(): void {
  if (state === 'ready') {
    startPlaying();
    return;
  }
  if (state === 'gameover') {
    reset();
    startPlaying();
    return;
  }
  if (state !== 'playing' || onBar === null) return;
  const t = onBar === 'A' ? trapA : trapB;
  const bar = barPos(t, elapsed);
  player.x = bar.x;
  player.y = bar.y;
  player.vx = t.len * Math.cos(bar.angle) * bar.omega;
  player.vy = -t.len * Math.sin(bar.angle) * bar.omega;
  target = onBar === 'A' ? 'B' : 'A';
  onBar = null;
  releaseGuard = 0.08;
}

function tryCatch(): boolean {
  if (releaseGuard > 0) return false;
  const t = target === 'A' ? trapA : trapB;
  const bar = barPos(t, elapsed);
  const dx = player.x - bar.x;
  const dy = player.y - bar.y;
  const dist = Math.hypot(dx, dy);
  if (dist > CATCH_RADIUS) return false;
  onBar = target;
  if (target === 'A') {
    trapB = makeTrapeze(PIVOT_B_X, score + 1);
  } else {
    trapA = makeTrapeze(PIVOT_A_X, score + 1);
  }
  score += 1;
  scoreEl.textContent = String(score);
  commitBest();
  return true;
}

function gameOver(): void {
  state = 'gameover';
  commitBest();
  reportGameOver(SCORE_DESC, score);
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  showOverlay('Düştü!', `Skor: ${score} · R veya Boşluk ile yeniden`);
  draw();
}

function update(dt: number): void {
  if (state !== 'playing') return;
  elapsed += dt;
  if (releaseGuard > 0) releaseGuard = Math.max(0, releaseGuard - dt);

  if (onBar !== null) {
    const t = onBar === 'A' ? trapA : trapB;
    const bar = barPos(t, elapsed);
    player.x = bar.x;
    player.y = bar.y;
    player.vx = t.len * Math.cos(bar.angle) * bar.omega;
    player.vy = -t.len * Math.sin(bar.angle) * bar.omega;
    return;
  }

  player.vy += GRAVITY * dt;
  player.x += player.vx * dt;
  player.y += player.vy * dt;

  if (tryCatch()) return;

  if (player.y > FLOOR_Y || player.x < -40 || player.x > W + 40) {
    gameOver();
  }
}

function frame(now: number): void {
  rafId = null;
  const dt = Math.min(0.04, (now - lastTime) / 1000);
  lastTime = now;
  update(dt);
  draw();
  if (state === 'playing') {
    rafId = requestAnimationFrame(frame);
  }
}

function drawBackground(): void {
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, '#1a2236');
  grad.addColorStop(0.55, '#2a3553');
  grad.addColorStop(1, '#3a2a3e');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = 'rgba(255, 220, 180, 0.06)';
  for (let i = 0; i < 24; i++) {
    const cx = (i * 137.5) % W;
    const cy = (i * 73.3) % (H * 0.6);
    ctx.beginPath();
    ctx.arc(cx, cy, 1.4, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.fillStyle = '#11151c';
  ctx.fillRect(0, PIVOT_Y - 22, W, 14);
  ctx.fillStyle = '#1c2330';
  ctx.fillRect(0, PIVOT_Y - 8, W, 4);

  ctx.fillStyle = '#1a1110';
  ctx.fillRect(0, FLOOR_Y, W, H - FLOOR_Y);
  ctx.strokeStyle = 'rgba(220, 90, 90, 0.45)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = -H; x <= W; x += 14) {
    ctx.moveTo(x, FLOOR_Y);
    ctx.lineTo(x + H, FLOOR_Y + H);
  }
  for (let x = 0; x <= W + H; x += 14) {
    ctx.moveTo(x, FLOOR_Y);
    ctx.lineTo(x - H, FLOOR_Y + H);
  }
  ctx.stroke();
  ctx.fillStyle = 'rgba(220, 90, 90, 0.22)';
  ctx.fillRect(0, FLOOR_Y, W, 5);
}

function drawTrapeze(t: Trapeze, time: number, color: string, accent: string): void {
  const bar = barPos(t, time);
  ctx.fillStyle = '#0c0f15';
  ctx.fillRect(t.px - 6, PIVOT_Y - 14, 12, 8);
  ctx.fillStyle = '#42495a';
  ctx.beginPath();
  ctx.arc(t.px, PIVOT_Y, 3, 0, Math.PI * 2);
  ctx.fill();

  const barHalf = 22;
  const cosA = Math.cos(bar.angle);
  const sinA = Math.sin(bar.angle);
  const left = { x: bar.x - barHalf * cosA, y: bar.y + barHalf * sinA };
  const right = { x: bar.x + barHalf * cosA, y: bar.y - barHalf * sinA };
  ctx.strokeStyle = '#b08653';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(t.px - 2, PIVOT_Y);
  ctx.lineTo(left.x, left.y);
  ctx.moveTo(t.px + 2, PIVOT_Y);
  ctx.lineTo(right.x, right.y);
  ctx.stroke();

  ctx.save();
  ctx.translate(bar.x, bar.y);
  ctx.rotate(-bar.angle);
  ctx.fillStyle = color;
  ctx.fillRect(-barHalf, -3, barHalf * 2, 6);
  ctx.fillStyle = accent;
  ctx.fillRect(-barHalf, -3, barHalf * 2, 2);
  ctx.restore();
}

function drawPlayer(): void {
  if (onBar !== null) {
    ctx.fillStyle = '#f3d28e';
    ctx.beginPath();
    ctx.arc(player.x, player.y + 1, 3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = '#e7eaef';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(player.x, player.y);
  if (onBar !== null) {
    ctx.lineTo(player.x, player.y + 28);
  } else {
    const vmag = Math.hypot(player.vx, player.vy) + 1;
    const dx = (player.vx / vmag) * 5;
    const dy = (player.vy / vmag) * 5;
    ctx.lineTo(player.x + dx, player.y + 22 + dy);
  }
  ctx.stroke();

  ctx.fillStyle = '#f3d28e';
  ctx.beginPath();
  ctx.arc(player.x, player.y + 12, 7, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#e0436a';
  ctx.beginPath();
  ctx.arc(player.x, player.y + 22, 4.5, 0, Math.PI * 2);
  ctx.fill();
}

function drawCatchHint(): void {
  if (state !== 'playing' || onBar !== null) return;
  const t = target === 'A' ? trapA : trapB;
  const bar = barPos(t, elapsed);
  ctx.strokeStyle = 'rgba(120, 220, 160, 0.55)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(bar.x, bar.y, CATCH_RADIUS, 0, Math.PI * 2);
  ctx.stroke();
}

function draw(): void {
  drawBackground();
  drawTrapeze(trapA, elapsed, '#d8b06a', '#fff0c6');
  drawTrapeze(trapB, elapsed, '#d8b06a', '#fff0c6');
  drawCatchHint();
  drawPlayer();

  if (state === 'playing') {
    ctx.fillStyle = 'rgba(230, 235, 245, 0.65)';
    ctx.font = 'bold 12px ui-sans-serif, system-ui';
    ctx.textAlign = 'right';
    ctx.fillText(`Hedef → ${target}`, W - 12, 22);
  }
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlayEl = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;

  best = safeRead<number>(STORAGE_KEY, 0);

  window.addEventListener('keydown', (e) => {
    const k = e.key;
    if (k === ' ' || k === 'Spacebar' || k === 'Enter') {
      release();
      e.preventDefault();
    } else if (k === 'r' || k === 'R') {
      reset();
      e.preventDefault();
    }
  });

  const onPointer = (e: Event) => {
    release();
    e.preventDefault();
  };
  canvas.addEventListener('pointerdown', onPointer);
  overlayEl.addEventListener('pointerdown', onPointer);

  restartBtn.addEventListener('click', () => {
    reset();
  });

  reset();
}

export const game = defineGame({ init, reset });
