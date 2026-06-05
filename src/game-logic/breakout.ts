import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';
import { reportGameOver } from '@shared/leaderboard';

type Brick = {
  x: number;
  y: number;
  w: number;
  h: number;
  hp: number;
  maxHp: number;
  color: string;
  points: number;
  alive: boolean;
};

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let livesEl!: HTMLElement;
let levelEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;

const STORAGE_KEY = 'breakout.highScore';
const SCORE_DESC = { gameId: 'breakout', storageKey: STORAGE_KEY, direction: 'higher' as const };

// Logical play-field dimensions; canvas backing store is scaled to match
// CSS-rendered size * devicePixelRatio for crisp output on HiDPI/mobile,
// but all game logic uses these constant coordinates.
const W = 480;
const H = 600;

// Set up the canvas backing store for HiDPI rendering.
function resizeCanvas(): void {
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  const rect = canvas.getBoundingClientRect();
  const cssW = rect.width || W;
  const cssH = (cssW * H) / W;
  const targetW = Math.round(cssW * dpr);
  const targetH = Math.round(cssH * dpr);
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }
  ctx.setTransform(targetW / W, 0, 0, targetH / H, 0, 0);
}

const PADDLE_W_BASE = 86;
const PADDLE_H = 12;
const PADDLE_Y = H - 36;
const BALL_R = 7;
const BRICK_COLS = 10;
const BRICK_ROWS_BASE = 5;
const BRICK_PADDING = 4;
const BRICK_AREA_TOP = 56;
const BRICK_AREA_LEFT = 16;
const BRICK_AREA_RIGHT = 16;

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

const BRICK_PALETTE = [
  { v: '--bo-brick-6', f: '#a78bfa', points: 70 },
  { v: '--bo-brick-5', f: '#60a5fa', points: 60 },
  { v: '--bo-brick-4', f: '#34d399', points: 50 },
  { v: '--bo-brick-3', f: '#facc15', points: 40 },
  { v: '--bo-brick-2', f: '#fb923c', points: 20 },
  { v: '--bo-brick-1', f: '#f43f5e', points: 10 },
];

let paddleX = (W - PADDLE_W_BASE) / 2;
let paddleW = PADDLE_W_BASE;
let ballX = W / 2;
let ballY = PADDLE_Y - BALL_R - 1;
let ballVX = 0;
let ballVY = 0;
let ballSpeed = 300;

let bricks: Brick[] = [];
let score = 0;
let lives = 3;
let level = 1;
let best = 0;

let running = false;
let paused = false;
let gameOver = false;
let won = false;
let ballAttached = true;

let leftHeld = false;
let rightHeld = false;
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
  scoreEl.textContent = String(score);
  livesEl.textContent = String(lives);
  levelEl.textContent = String(level);
  bestEl.textContent = String(best);
}

function buildLevel(lv: number): void {
  bricks = [];
  const rows = Math.min(BRICK_ROWS_BASE + Math.floor((lv - 1) / 2), BRICK_PALETTE.length);
  const usableW = W - BRICK_AREA_LEFT - BRICK_AREA_RIGHT;
  const brickW = (usableW - BRICK_PADDING * (BRICK_COLS - 1)) / BRICK_COLS;
  const brickH = 18;

  for (let r = 0; r < rows; r++) {
    const palette = BRICK_PALETTE[r % BRICK_PALETTE.length]!;
    const hp = r < Math.min(2, Math.floor(lv / 2)) ? 2 : 1;
    for (let c = 0; c < BRICK_COLS; c++) {
      const x = BRICK_AREA_LEFT + c * (brickW + BRICK_PADDING);
      const y = BRICK_AREA_TOP + r * (brickH + BRICK_PADDING);
      bricks.push({
        x,
        y,
        w: brickW,
        h: brickH,
        hp,
        maxHp: hp,
        color: css(palette.v, palette.f),
        points: palette.points,
        alive: true,
      });
    }
  }
}

function resetBallToPaddle(): void {
  ballAttached = true;
  ballX = paddleX + paddleW / 2;
  ballY = PADDLE_Y - BALL_R - 1;
  ballVX = 0;
  ballVY = 0;
}

function launchBall(): void {
  if (!ballAttached || gameOver || won || paused) return;
  ballAttached = false;
  const angle = -Math.PI / 2 + (Math.random() * 0.6 - 0.3);
  ballVX = Math.cos(angle) * ballSpeed;
  ballVY = Math.sin(angle) * ballSpeed;
  running = true;
  hideOverlay();
}

function nextLevel(): void {
  level++;
  ballSpeed = Math.min(510, 300 + (level - 1) * 27);
  paddleW = Math.max(60, PADDLE_W_BASE - (level - 1) * 4);
  buildLevel(level);
  resetBallToPaddle();
  paused = false;
  showOverlay(`Seviye ${level}`, 'Boşluk veya tıklama ile topu fırlat.');
  updateHud();
}

function resetGame(): void {
  score = 0;
  lives = 3;
  level = 1;
  ballSpeed = 300;
  paddleW = PADDLE_W_BASE;
  paddleX = (W - paddleW) / 2;
  buildLevel(level);
  resetBallToPaddle();
  running = false;
  paused = false;
  gameOver = false;
  won = false;
  updateHud();
  showOverlay('Breakout', 'Başlamak için boşluk tuşuna bas veya tıkla.');
}

function loseLife(): void {
  lives--;
  updateHud();
  if (lives <= 0) {
    gameOver = true;
    running = false;
    if (score > best) {
      best = score;
      safeWrite(STORAGE_KEY, best);
      updateHud();
    }
    reportGameOver(SCORE_DESC, score);
    showOverlay('Bitti!', `Skor: ${score} · R ile yeniden başla`);
  } else {
    resetBallToPaddle();
    showOverlay('Hazır mısın?', 'Boşluk ile topu fırlat.');
  }
}

function bricksRemaining(): number {
  let n = 0;
  for (const b of bricks) if (b.alive) n++;
  return n;
}

function step(dt: number): void {
  const paddleSpeed = 520;
  if (leftHeld) paddleX -= paddleSpeed * dt;
  if (rightHeld) paddleX += paddleSpeed * dt;
  if (paddleX < 0) paddleX = 0;
  if (paddleX + paddleW > W) paddleX = W - paddleW;

  if (ballAttached) {
    ballX = paddleX + paddleW / 2;
    ballY = PADDLE_Y - BALL_R - 1;
    return;
  }

  if (!running || paused || gameOver || won) return;

  const dx = ballVX * dt;
  const dy = ballVY * dt;
  const moveLen = Math.hypot(dx, dy);
  const steps = Math.max(1, Math.ceil(moveLen / 4));
  const stepVX = dx / steps;
  const stepVY = dy / steps;

  for (let s = 0; s < steps; s++) {
    ballX += stepVX;
    ballY += stepVY;

    if (ballX - BALL_R < 0) {
      ballX = BALL_R;
      ballVX = Math.abs(ballVX);
    } else if (ballX + BALL_R > W) {
      ballX = W - BALL_R;
      ballVX = -Math.abs(ballVX);
    }
    if (ballY - BALL_R < 0) {
      ballY = BALL_R;
      ballVY = Math.abs(ballVY);
    }

    if (
      ballVY > 0 &&
      ballY + BALL_R >= PADDLE_Y &&
      ballY + BALL_R <= PADDLE_Y + PADDLE_H + Math.abs(stepVY) &&
      ballX >= paddleX - BALL_R &&
      ballX <= paddleX + paddleW + BALL_R
    ) {
      const hit = (ballX - (paddleX + paddleW / 2)) / (paddleW / 2);
      const clamped = Math.max(-0.85, Math.min(0.85, hit));
      const angle = clamped * (Math.PI / 3);
      const sp = Math.hypot(ballVX, ballVY);
      ballVX = sp * Math.sin(angle);
      ballVY = -Math.abs(sp * Math.cos(angle));
      ballY = PADDLE_Y - BALL_R - 1;
      break;
    }

    let hitBrick = false;
    for (const b of bricks) {
      if (!b.alive) continue;
      if (
        ballX + BALL_R > b.x &&
        ballX - BALL_R < b.x + b.w &&
        ballY + BALL_R > b.y &&
        ballY - BALL_R < b.y + b.h
      ) {
        const overlapLeft = ballX + BALL_R - b.x;
        const overlapRight = b.x + b.w - (ballX - BALL_R);
        const overlapTop = ballY + BALL_R - b.y;
        const overlapBottom = b.y + b.h - (ballY - BALL_R);
        const minX = Math.min(overlapLeft, overlapRight);
        const minY = Math.min(overlapTop, overlapBottom);

        if (minX < minY) {
          if (overlapLeft < overlapRight) {
            ballX = b.x - BALL_R;
            if (ballVX > 0) ballVX = -ballVX;
          } else {
            ballX = b.x + b.w + BALL_R;
            if (ballVX < 0) ballVX = -ballVX;
          }
        } else {
          if (overlapTop < overlapBottom) {
            ballY = b.y - BALL_R;
            if (ballVY > 0) ballVY = -ballVY;
          } else {
            ballY = b.y + b.h + BALL_R;
            if (ballVY < 0) ballVY = -ballVY;
          }
        }
        b.hp--;
        if (b.hp <= 0) {
          b.alive = false;
          score += b.points;
        } else {
          score += Math.floor(b.points / 4);
        }
        if (score > best) {
          best = score;
          safeWrite(STORAGE_KEY, best);
        }
        updateHud();
        hitBrick = true;
        break;
      }
    }
    if (hitBrick) break;

    if (ballY - BALL_R > H) {
      loseLife();
      return;
    }
  }

  if (bricksRemaining() === 0) {
    nextLevel();
  }
}

function drawRoundRect(
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

function draw(): void {
  ctx.fillStyle = css('--bo-bg', '#0a0b0e');
  ctx.fillRect(0, 0, W, H);

  for (const b of bricks) {
    if (!b.alive) continue;
    ctx.fillStyle = b.color;
    drawRoundRect(b.x, b.y, b.w, b.h, 4);
    ctx.fill();
    if (b.hp < b.maxHp) {
      ctx.fillStyle = 'rgba(0,0,0,0.28)';
      ctx.fill();
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  ctx.fillStyle = css('--bo-paddle', '#38bdf8');
  drawRoundRect(paddleX, PADDLE_Y, paddleW, PADDLE_H, 6);
  ctx.fill();

  ctx.fillStyle = css('--bo-ball', '#fde68a');
  ctx.beginPath();
  ctx.arc(ballX, ballY, BALL_R, 0, Math.PI * 2);
  ctx.fill();
}

function frame(ts: number): void {
  if (!lastTs) lastTs = ts;
  let dt = (ts - lastTs) / 1000;
  if (dt > 0.05) dt = 0.05;
  lastTs = ts;
  step(dt);
  draw();
  requestAnimationFrame(frame);
}

function pointerXToPaddle(clientX: number): void {
  const rect = canvas.getBoundingClientRect();
  const ratio = W / rect.width;
  const localX = (clientX - rect.left) * ratio;
  paddleX = localX - paddleW / 2;
  if (paddleX < 0) paddleX = 0;
  if (paddleX + paddleW > W) paddleX = W - paddleW;
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  livesEl = document.querySelector<HTMLElement>('#lives')!;
  levelEl = document.querySelector<HTMLElement>('#level')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;

  best = safeRead<number>(STORAGE_KEY, 0);

  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'arrowleft' || k === 'a') {
      leftHeld = true;
      e.preventDefault();
    } else if (k === 'arrowright' || k === 'd') {
      rightHeld = true;
      e.preventDefault();
    } else if (k === ' ') {
      if (gameOver || won) {
        resetGame();
      } else if (ballAttached) {
        launchBall();
      }
      e.preventDefault();
    } else if (k === 'p') {
      if (!ballAttached && !gameOver && !won) {
        paused = !paused;
        if (paused) showOverlay('Duraklatıldı', 'Devam için P.');
        else hideOverlay();
      }
      e.preventDefault();
    } else if (k === 'r') {
      resetGame();
      e.preventDefault();
    }
  });

  window.addEventListener('keyup', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'arrowleft' || k === 'a') leftHeld = false;
    else if (k === 'arrowright' || k === 'd') rightHeld = false;
  });

  canvas.addEventListener('mousemove', (e) => {
    pointerXToPaddle(e.clientX);
  });

  canvas.addEventListener(
    'touchmove',
    (e) => {
      const t = e.touches[0];
      if (!t) return;
      pointerXToPaddle(t.clientX);
      e.preventDefault();
    },
    { passive: false },
  );

  canvas.addEventListener(
    'touchstart',
    (e) => {
      const t = e.touches[0];
      if (!t) return;
      pointerXToPaddle(t.clientX);
      if (gameOver || won) {
        resetGame();
      } else if (ballAttached) {
        launchBall();
      }
      e.preventDefault();
    },
    { passive: false },
  );

  canvas.addEventListener('click', () => {
    if (gameOver || won) {
      resetGame();
    } else if (ballAttached) {
      launchBall();
    }
  });

  restartBtn.addEventListener('click', resetGame);

  window.addEventListener('resize', resizeCanvas);
  window.addEventListener('orientationchange', () => {
    requestAnimationFrame(resizeCanvas);
  });
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(resizeCanvas).observe(canvas);
  }

  resizeCanvas();
  resetGame();
  requestAnimationFrame(frame);
}

export const game = defineGame({ init, reset: resetGame });
