import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scorePlayerEl!: HTMLElement;
let scoreCpuEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;

const STORAGE_KEY = 'pong.best';

// Logical playfield dimensions (matches the canvas attribute width/height).
// Hard-coded so geometry constants below can resolve at module load.
const W = 640;
const H = 360;

const PADDLE_W = 10;
const PADDLE_H = 70;
const PADDLE_MARGIN = 16;
const BALL_R = 7;
const WIN_SCORE = 7;

const PLAYER_X = PADDLE_MARGIN;
const CPU_X = W - PADDLE_MARGIN - PADDLE_W;

const PLAYER_SPEED = 520;
const CPU_MAX_SPEED = 360;
const BALL_BASE_SPEED = 5.2;
const BALL_SPEED_GAIN = 0.35;
const MAX_BOUNCE_ANGLE = (Math.PI / 180) * 55;

const cssCache = new Map<string, string>();
function css(varName: string, fallback: string): string {
  const cached = cssCache.get(varName);
  if (cached !== undefined) return cached;
  const val = getComputedStyle(document.documentElement)
    .getPropertyValue(varName)
    .trim();
  const out = val || fallback;
  cssCache.set(varName, out);
  return out;
}

let playerY = (H - PADDLE_H) / 2;
let cpuY = (H - PADDLE_H) / 2;
let ballX = W / 2;
let ballY = H / 2;
let ballVX = 0;
let ballVY = 0;
let ballSpeed = BALL_BASE_SPEED;

let playerScore = 0;
let cpuScore = 0;
let best = 0;

let serving = true;
let serveTo: 1 | -1 = -1; // -1 = ball goes toward player (CPU serves), 1 = toward cpu
let paused = false;
let gameOver = false;

let upHeld = false;
let downHeld = false;
let pointerY: number | null = null;
let lastTs = 0;

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlay);
}

function hideOverlay(): void {
  hideOverlayEl(overlay);
}

function updateHud(): void {
  scorePlayerEl.textContent = String(playerScore);
  scoreCpuEl.textContent = String(cpuScore);
  bestEl.textContent = String(best);
}

function resetBall(toward: 1 | -1): void {
  ballX = W / 2;
  ballY = H / 2;
  ballSpeed = BALL_BASE_SPEED;
  ballVX = 0;
  ballVY = 0;
  serving = true;
  serveTo = toward;
}

function launchServe(): void {
  if (!serving || gameOver || paused) return;
  const angle = (Math.random() * 0.6 - 0.3); // -0.3..0.3 rad
  ballVX = Math.cos(angle) * ballSpeed * serveTo;
  ballVY = Math.sin(angle) * ballSpeed * (Math.random() < 0.5 ? -1 : 1);
  serving = false;
  hideOverlay();
}

function resetMatch(): void {
  playerScore = 0;
  cpuScore = 0;
  playerY = (H - PADDLE_H) / 2;
  cpuY = (H - PADDLE_H) / 2;
  gameOver = false;
  paused = false;
  resetBall(Math.random() < 0.5 ? -1 : 1);
  updateHud();
  showOverlay('Pong', 'Servis için boşluğa bas veya tıkla.');
}

function awardPoint(toCpu: boolean): void {
  if (toCpu) cpuScore++;
  else playerScore++;
  if (playerScore > best) {
    best = playerScore;
    safeWrite(STORAGE_KEY, best);
  }
  updateHud();

  if (playerScore >= WIN_SCORE || cpuScore >= WIN_SCORE) {
    gameOver = true;
    const won = playerScore >= WIN_SCORE;
    showOverlay(
      won ? 'Kazandın!' : 'CPU kazandı',
      `${playerScore} - ${cpuScore} · R ile yeniden başla`,
    );
    return;
  }

  resetBall(toCpu ? 1 : -1);
  showOverlay(
    `${playerScore} - ${cpuScore}`,
    'Servis için boşluğa bas veya tıkla.',
  );
}

function clampPaddle(y: number): number {
  if (y < 0) return 0;
  if (y + PADDLE_H > H) return H - PADDLE_H;
  return y;
}

function paddleCollide(
  px: number,
  py: number,
  dirSign: 1 | -1, // +1: paddle on left, ball moves right after hit; -1 opposite
): boolean {
  if (dirSign === 1) {
    if (ballVX >= 0) return false;
    if (ballX - BALL_R > px + PADDLE_W) return false;
    if (ballX + BALL_R < px) return false;
  } else {
    if (ballVX <= 0) return false;
    if (ballX + BALL_R < px) return false;
    if (ballX - BALL_R > px + PADDLE_W) return false;
  }
  if (ballY + BALL_R < py) return false;
  if (ballY - BALL_R > py + PADDLE_H) return false;

  const relY = (ballY - (py + PADDLE_H / 2)) / (PADDLE_H / 2);
  const clamped = Math.max(-1, Math.min(1, relY));
  const angle = clamped * MAX_BOUNCE_ANGLE;
  ballSpeed = Math.min(11, ballSpeed + BALL_SPEED_GAIN);
  ballVX = Math.cos(angle) * ballSpeed * dirSign;
  ballVY = Math.sin(angle) * ballSpeed;
  if (dirSign === 1) ballX = px + PADDLE_W + BALL_R + 0.1;
  else ballX = px - BALL_R - 0.1;
  return true;
}

function stepPaddles(dt: number): void {
  // Player input: keyboard takes priority; pointer otherwise.
  if (upHeld || downHeld) {
    const dir = (upHeld ? -1 : 0) + (downHeld ? 1 : 0);
    playerY += dir * PLAYER_SPEED * dt;
  } else if (pointerY !== null) {
    const target = pointerY - PADDLE_H / 2;
    const diff = target - playerY;
    const maxStep = PLAYER_SPEED * dt;
    if (Math.abs(diff) <= maxStep) playerY = target;
    else playerY += Math.sign(diff) * maxStep;
  }
  playerY = clampPaddle(playerY);

  // CPU: predict ball, with reaction lag + slight imperfection.
  const cpuCenter = cpuY + PADDLE_H / 2;
  let target: number;
  if (ballVX > 0) {
    // ball coming toward CPU; aim toward it but with imperfection
    target = ballY + (Math.sin(ballX * 0.02) * 14);
  } else {
    // ball moving away; drift toward center
    target = H / 2;
  }
  const diff = target - cpuCenter;
  const maxStep = CPU_MAX_SPEED * dt;
  if (Math.abs(diff) <= maxStep) cpuY = clampPaddle(target - PADDLE_H / 2);
  else cpuY = clampPaddle(cpuY + Math.sign(diff) * maxStep);
}

function stepBall(): void {
  if (serving || paused || gameOver) return;

  const speed = Math.hypot(ballVX, ballVY);
  const substeps = Math.max(1, Math.ceil(speed / 4));
  const sx = ballVX / substeps;
  const sy = ballVY / substeps;

  for (let i = 0; i < substeps; i++) {
    ballX += sx;
    ballY += sy;

    // Top/bottom walls
    if (ballY - BALL_R < 0) {
      ballY = BALL_R;
      ballVY = Math.abs(ballVY);
    } else if (ballY + BALL_R > H) {
      ballY = H - BALL_R;
      ballVY = -Math.abs(ballVY);
    }

    // Paddles
    if (paddleCollide(PLAYER_X, playerY, 1)) break;
    if (paddleCollide(CPU_X, cpuY, -1)) break;

    // Out left = CPU scores, out right = player scores
    if (ballX + BALL_R < 0) {
      awardPoint(true);
      return;
    }
    if (ballX - BALL_R > W) {
      awardPoint(false);
      return;
    }
  }
}

function drawCenterLine(): void {
  ctx.strokeStyle = css('--pong-line', 'rgba(228, 228, 237, 0.18)');
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 10]);
  ctx.beginPath();
  ctx.moveTo(W / 2, 8);
  ctx.lineTo(W / 2, H - 8);
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawPaddle(x: number, y: number, color: string): void {
  ctx.fillStyle = color;
  const r = 4;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + PADDLE_W - r, y);
  ctx.quadraticCurveTo(x + PADDLE_W, y, x + PADDLE_W, y + r);
  ctx.lineTo(x + PADDLE_W, y + PADDLE_H - r);
  ctx.quadraticCurveTo(x + PADDLE_W, y + PADDLE_H, x + PADDLE_W - r, y + PADDLE_H);
  ctx.lineTo(x + r, y + PADDLE_H);
  ctx.quadraticCurveTo(x, y + PADDLE_H, x, y + PADDLE_H - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  ctx.fill();
}

function draw(): void {
  ctx.fillStyle = css('--pong-bg', '#0a0b0e');
  ctx.fillRect(0, 0, W, H);

  drawCenterLine();

  drawPaddle(PLAYER_X, playerY, css('--pong-player', '#38bdf8'));
  drawPaddle(CPU_X, cpuY, css('--pong-cpu', '#f43f5e'));

  // Ball
  ctx.fillStyle = css('--pong-ball', '#fde68a');
  ctx.beginPath();
  ctx.arc(ballX, ballY, BALL_R, 0, Math.PI * 2);
  ctx.fill();
}

function frame(ts: number): void {
  if (!lastTs) lastTs = ts;
  let dt = (ts - lastTs) / 1000;
  if (dt > 0.05) dt = 0.05;
  lastTs = ts;
  if (!paused && !gameOver) {
    stepPaddles(dt);
    stepBall();
  }
  draw();
  requestAnimationFrame(frame);
}

// --- Input ---
function _wire(): void {
window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k === 'arrowup' || k === 'w') {
    upHeld = true;
    e.preventDefault();
  } else if (k === 'arrowdown' || k === 's') {
    downHeld = true;
    e.preventDefault();
  } else if (k === ' ') {
    if (gameOver) {
      resetMatch();
    } else if (serving) {
      launchServe();
    }
    e.preventDefault();
  } else if (k === 'p') {
    if (!serving && !gameOver) {
      paused = !paused;
      if (paused) showOverlay('Duraklatıldı', 'Devam için P.');
      else hideOverlay();
    }
    e.preventDefault();
  } else if (k === 'r') {
    resetMatch();
    e.preventDefault();
  }
});

window.addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase();
  if (k === 'arrowup' || k === 'w') upHeld = false;
  else if (k === 'arrowdown' || k === 's') downHeld = false;
});

function clientToCanvasY(clientY: number): number {
  const rect = canvas.getBoundingClientRect();
  const ratio = H / rect.height;
  return (clientY - rect.top) * ratio;
}

canvas.addEventListener('mousemove', (e) => {
  pointerY = clientToCanvasY(e.clientY);
});

canvas.addEventListener('mouseleave', () => {
  pointerY = null;
});

canvas.addEventListener('touchmove', (e) => {
  const t = e.touches[0];
  if (!t) return;
  pointerY = clientToCanvasY(t.clientY);
  e.preventDefault();
}, { passive: false });

canvas.addEventListener('touchstart', (e) => {
  const t = e.touches[0];
  if (!t) return;
  pointerY = clientToCanvasY(t.clientY);
  if (gameOver) {
    resetMatch();
  } else if (serving) {
    launchServe();
  }
  e.preventDefault();
}, { passive: false });

canvas.addEventListener('touchend', () => {
  pointerY = null;
});

canvas.addEventListener('click', () => {
  if (gameOver) {
    resetMatch();
  } else if (serving) {
    launchServe();
  }
});

restartBtn.addEventListener('click', resetMatch);
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scorePlayerEl = document.querySelector<HTMLElement>('#score-player')!;
  scoreCpuEl = document.querySelector<HTMLElement>('#score-cpu')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;

  best = safeRead<number>(STORAGE_KEY, 0);
  if (!Number.isFinite(best) || best < 0) best = 0;

  _wire();
  resetMatch();
  requestAnimationFrame(frame);
}

export const game = defineGame({ init, reset: resetMatch });
