import { defineGame } from '@shared/game-module';
import { reportGameOver } from '@shared/leaderboard';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';

type Pipe = {
  x: number;
  gapY: number;
  passed: boolean;
};

const STORAGE_KEY = 'flappy.best';
const SCORE_DESC = { gameId: 'flappy', storageKey: STORAGE_KEY, direction: 'higher' as const };

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let restartBtn!: HTMLButtonElement;

// Logical playfield dimensions (kept stable so all physics constants below are
// resolution-independent). The canvas backing store is rescaled to match
// devicePixelRatio for crispness on mobile; CSS handles the on-screen size.
const W = 480;
const H = 640;
const GROUND_H = 80;
const PLAY_H = H - GROUND_H;

const BIRD_X = Math.floor(W * 0.28);
const BIRD_R = 14;
const GRAVITY = 1500; // px/sec^2
const FLAP_VY = -420; // px/sec
const MAX_VY = 700;

const PIPE_W = 64;
const PIPE_GAP = 160;
const PIPE_SPACING = 230;
const PIPE_SPEED = 170;
const PIPE_GAP_MARGIN = 60;
const PIPE_CAP_H = 22;
const PIPE_CAP_OVER = 6;

const FIXED_DT = 1 / 120;
const MAX_FRAME_TIME = 0.1;

type State = 'ready' | 'playing' | 'gameover';

let state: State = 'ready';
let birdY = 0;
let birdVy = 0;
let birdAngle = 0;
let pipes: Pipe[] = [];
let groundOffset = 0;
let score = 0;
let best = 0;
let lastTime = 0;
let physicsAccumulator = 0;
let rafHandle = 0;
let dpr = 1;

function resizeCanvas(): void {
  const next = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  if (next === dpr && canvas.width === W * dpr) return;
  dpr = next;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
  draw();
}

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlay);
}

function hideOverlay(): void {
  hideOverlayEl(overlay);
}

function randomGapY(): number {
  const min = PIPE_GAP_MARGIN + PIPE_GAP / 2;
  const max = PLAY_H - PIPE_GAP_MARGIN - PIPE_GAP / 2;
  return min + Math.random() * (max - min);
}

function spawnInitialPipes(): void {
  pipes = [];
  const first = W + 120;
  for (let i = 0; i < 4; i++) {
    pipes.push({ x: first + i * PIPE_SPACING, gapY: randomGapY(), passed: false });
  }
}

function reset(): void {
  state = 'ready';
  birdY = PLAY_H / 2;
  birdVy = 0;
  birdAngle = 0;
  score = 0;
  scoreEl.textContent = '0';
  bestEl.textContent = String(best);
  spawnInitialPipes();
  showOverlay('Flappy', "Başlamak için Boşluk'a bas, tıkla ya da dokun.");
  physicsAccumulator = 0;
  lastTime = 0;
  draw();
}

function flap(): void {
  if (state === 'gameover') {
    reset();
  }
  if (state === 'ready') {
    state = 'playing';
    hideOverlay();
    lastTime = performance.now();
    physicsAccumulator = 0;
  }
  birdVy = FLAP_VY;
}

function gameOver(): void {
  state = 'gameover';
  if (score > best) {
    best = score;
    safeWrite(STORAGE_KEY, best);
    bestEl.textContent = String(best);
  }
  reportGameOver(SCORE_DESC, score);
  showOverlay('Çarptın!', `Skor: ${score} · En iyi: ${best}. Tekrar denemek için dokun.`);
}

function circleRectHit(
  cx: number,
  cy: number,
  r: number,
  rx: number,
  ry: number,
  rw: number,
  rh: number,
): boolean {
  const closestX = Math.max(rx, Math.min(cx, rx + rw));
  const closestY = Math.max(ry, Math.min(cy, ry + rh));
  const dx = cx - closestX;
  const dy = cy - closestY;
  return dx * dx + dy * dy <= r * r;
}

function collides(): boolean {
  if (birdY + BIRD_R >= PLAY_H) return true;
  if (birdY - BIRD_R <= 0) return true;
  for (const p of pipes) {
    const capLeft = p.x - PIPE_CAP_OVER;
    const capRight = p.x + PIPE_W + PIPE_CAP_OVER;
    if (capRight < BIRD_X - BIRD_R) continue;
    if (capLeft > BIRD_X + BIRD_R) continue;
    const gapTop = p.gapY - PIPE_GAP / 2;
    const gapBot = p.gapY + PIPE_GAP / 2;
    if (
      circleRectHit(BIRD_X, birdY, BIRD_R, p.x, 0, PIPE_W, gapTop) ||
      circleRectHit(
        BIRD_X,
        birdY,
        BIRD_R,
        capLeft,
        gapTop - PIPE_CAP_H,
        PIPE_W + PIPE_CAP_OVER * 2,
        PIPE_CAP_H,
      )
    ) {
      return true;
    }
    if (
      circleRectHit(
        BIRD_X,
        birdY,
        BIRD_R,
        p.x,
        gapBot,
        PIPE_W,
        PLAY_H - gapBot,
      ) ||
      circleRectHit(
        BIRD_X,
        birdY,
        BIRD_R,
        capLeft,
        gapBot,
        PIPE_W + PIPE_CAP_OVER * 2,
        PIPE_CAP_H,
      )
    ) {
      return true;
    }
  }
  return false;
}

function step(dt: number): void {
  if (state !== 'playing') return;

  birdVy = Math.min(MAX_VY, birdVy + GRAVITY * dt);
  birdY += birdVy * dt;
  birdAngle = Math.max(-0.5, Math.min(1.3, birdVy / 500));

  groundOffset = (groundOffset + PIPE_SPEED * dt) % 32;

  for (const p of pipes) {
    p.x -= PIPE_SPEED * dt;
    if (!p.passed && p.x + PIPE_W < BIRD_X - BIRD_R) {
      p.passed = true;
      score += 1;
      scoreEl.textContent = String(score);
    }
  }

  while (pipes.length > 0 && pipes[0]!.x + PIPE_W < -20) {
    pipes.shift();
  }
  const last = pipes[pipes.length - 1];
  if (last && last.x < W - PIPE_SPACING) {
    pipes.push({ x: last.x + PIPE_SPACING, gapY: randomGapY(), passed: false });
  }

  if (collides()) {
    gameOver();
  }
}

function drawPipe(x: number, gapY: number): void {
  const gapTop = gapY - PIPE_GAP / 2;
  const gapBot = gapY + PIPE_GAP / 2;
  ctx.fillStyle = '#5dbf3f';
  ctx.fillRect(x, 0, PIPE_W, gapTop);
  ctx.fillRect(x, gapBot, PIPE_W, PLAY_H - gapBot);
  ctx.fillStyle = '#2f7a1f';
  ctx.fillRect(x, 0, 4, gapTop);
  ctx.fillRect(x + PIPE_W - 4, 0, 4, gapTop);
  ctx.fillRect(x, gapBot, 4, PLAY_H - gapBot);
  ctx.fillRect(x + PIPE_W - 4, gapBot, 4, PLAY_H - gapBot);
  ctx.fillStyle = '#5dbf3f';
  ctx.fillRect(
    x - PIPE_CAP_OVER,
    gapTop - PIPE_CAP_H,
    PIPE_W + PIPE_CAP_OVER * 2,
    PIPE_CAP_H,
  );
  ctx.fillRect(
    x - PIPE_CAP_OVER,
    gapBot,
    PIPE_W + PIPE_CAP_OVER * 2,
    PIPE_CAP_H,
  );
  ctx.fillStyle = '#2f7a1f';
  ctx.fillRect(
    x - PIPE_CAP_OVER,
    gapTop - PIPE_CAP_H,
    PIPE_W + PIPE_CAP_OVER * 2,
    4,
  );
  ctx.fillRect(
    x - PIPE_CAP_OVER,
    gapBot + PIPE_CAP_H - 4,
    PIPE_W + PIPE_CAP_OVER * 2,
    4,
  );
}

function drawBird(): void {
  ctx.save();
  ctx.translate(BIRD_X, birdY);
  ctx.rotate(birdAngle);
  ctx.fillStyle = '#ffd23f';
  ctx.beginPath();
  ctx.arc(0, 0, BIRD_R, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#d88f1c';
  ctx.beginPath();
  ctx.ellipse(-3, 3, 8, 5, -0.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ff7e2f';
  ctx.beginPath();
  ctx.moveTo(BIRD_R - 2, -2);
  ctx.lineTo(BIRD_R + 8, 0);
  ctx.lineTo(BIRD_R - 2, 4);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(5, -5, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#222';
  ctx.beginPath();
  ctx.arc(6, -5, 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.25)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(0, 0, BIRD_R, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawGround(): void {
  ctx.fillStyle = '#ded895';
  ctx.fillRect(0, PLAY_H, W, GROUND_H);
  ctx.fillStyle = '#c2b870';
  ctx.fillRect(0, PLAY_H, W, 6);
  ctx.fillStyle = '#998a3a';
  for (let x = -groundOffset; x < W; x += 32) {
    ctx.fillRect(x, PLAY_H + 16, 16, 6);
  }
}

function drawScore(): void {
  if (state === 'ready') return;
  ctx.save();
  ctx.font = 'bold 42px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const s = String(score);
  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.strokeText(s, W / 2, 24);
  ctx.fillStyle = '#fff';
  ctx.fillText(s, W / 2, 24);
  ctx.restore();
}

function draw(): void {
  ctx.clearRect(0, 0, W, H);
  const grad = ctx.createLinearGradient(0, 0, 0, PLAY_H);
  grad.addColorStop(0, '#4ec0ff');
  grad.addColorStop(1, '#b7e7ff');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, PLAY_H);

  for (const p of pipes) drawPipe(p.x, p.gapY);
  drawGround();
  drawBird();
  drawScore();
}

function loop(t: number): void {
  if (!lastTime) lastTime = t;
  const frameTime = Math.min(MAX_FRAME_TIME, (t - lastTime) / 1000);
  lastTime = t;

  if (state === 'playing') {
    physicsAccumulator += frameTime;
    if (physicsAccumulator > MAX_FRAME_TIME) {
      physicsAccumulator = MAX_FRAME_TIME;
    }
    while (physicsAccumulator >= FIXED_DT) {
      step(FIXED_DT);
      physicsAccumulator -= FIXED_DT;
      if (state !== 'playing') break;
    }
  }

  draw();
  rafHandle = requestAnimationFrame(loop);
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;

  best = safeRead<number>(STORAGE_KEY, 0);

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' || e.key === ' ' || e.key === 'ArrowUp') {
      e.preventDefault();
      flap();
    } else if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      reset();
    }
  });

  canvas.addEventListener(
    'pointerdown',
    (e) => {
      e.preventDefault();
      flap();
    },
    { passive: false },
  );

  canvas.addEventListener(
    'touchstart',
    (e) => {
      e.preventDefault();
    },
    { passive: false },
  );

  restartBtn.addEventListener('click', (e) => {
    e.preventDefault();
    reset();
  });

  window.addEventListener('resize', resizeCanvas);
  window.addEventListener('orientationchange', resizeCanvas);

  resizeCanvas();
  reset();
  cancelAnimationFrame(rafHandle);
  lastTime = 0;
  rafHandle = requestAnimationFrame(loop);
}

export const game = defineGame({ init, reset });
