type Pipe = {
  x: number;
  gapY: number;
  passed: boolean;
};

const STORAGE_KEY = 'flappy.best';

const canvas = document.querySelector<HTMLCanvasElement>('#board')!;
const ctx = canvas.getContext('2d')!;
const scoreEl = document.querySelector<HTMLElement>('#score')!;
const bestEl = document.querySelector<HTMLElement>('#best')!;
const overlay = document.querySelector<HTMLElement>('#overlay')!;
const overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
const overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
const restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;

const W = canvas.width;
const H = canvas.height;
const GROUND_H = 80;
const PLAY_H = H - GROUND_H;

const BIRD_X = Math.floor(W * 0.28);
const BIRD_R = 14;
const GRAVITY = 1500; // px/sec^2
const FLAP_VY = -420; // px/sec
const MAX_VY = 700;

const PIPE_W = 64;
const PIPE_GAP = 160;
const PIPE_SPACING = 230; // px between pipes
const PIPE_SPEED = 170; // px/sec
const PIPE_GAP_MARGIN = 60; // distance from top/ground to gap edge
const PIPE_CAP_H = 22; // visual cap height (must match drawPipe)
const PIPE_CAP_OVER = 6; // visual cap overhang on each side (must match drawPipe)

type State = 'ready' | 'playing' | 'gameover';

let state: State = 'ready';
let birdY = 0;
let birdVy = 0;
let birdAngle = 0;
let pipes: Pipe[] = [];
let groundOffset = 0;
let score = 0;
let best = Number(localStorage.getItem(STORAGE_KEY) ?? '0') || 0;
let lastTime = 0;
let rafHandle = 0;

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  overlay.classList.remove('overlay--hidden');
}

function hideOverlay(): void {
  overlay.classList.add('overlay--hidden');
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
  draw();
}

function flap(): void {
  if (state === 'gameover') {
    reset();
    // fall through: immediately start a new run with the same input
  }
  if (state === 'ready') {
    state = 'playing';
    hideOverlay();
    lastTime = performance.now();
  }
  birdVy = FLAP_VY;
}

function gameOver(): void {
  state = 'gameover';
  if (score > best) {
    best = score;
    try {
      localStorage.setItem(STORAGE_KEY, String(best));
    } catch {
      /* ignore */
    }
    bestEl.textContent = String(best);
  }
  showOverlay('Çarptın!', `Skor: ${score} · En iyi: ${best}. Tekrar denemek için tıkla.`);
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
  // ground
  if (birdY + BIRD_R >= PLAY_H) return true;
  // ceiling
  if (birdY - BIRD_R <= 0) return true;
  // pipes — check both the shaft and the slightly-wider cap rects so the
  // collision matches what's drawn (caps overhang the shaft by PIPE_CAP_OVER).
  for (const p of pipes) {
    const capLeft = p.x - PIPE_CAP_OVER;
    const capRight = p.x + PIPE_W + PIPE_CAP_OVER;
    // broad-phase cull using the widest extent (the caps)
    if (capRight < BIRD_X - BIRD_R) continue;
    if (capLeft > BIRD_X + BIRD_R) continue;
    const gapTop = p.gapY - PIPE_GAP / 2;
    const gapBot = p.gapY + PIPE_GAP / 2;
    // Top pipe: shaft + top cap
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
    // Bottom pipe: shaft + bottom cap
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

function update(dt: number): void {
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

  // recycle off-screen pipes
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
  // dark edge
  ctx.fillStyle = '#2f7a1f';
  ctx.fillRect(x, 0, 4, gapTop);
  ctx.fillRect(x + PIPE_W - 4, 0, 4, gapTop);
  ctx.fillRect(x, gapBot, 4, PLAY_H - gapBot);
  ctx.fillRect(x + PIPE_W - 4, gapBot, 4, PLAY_H - gapBot);
  // caps
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
  // body
  ctx.fillStyle = '#ffd23f';
  ctx.beginPath();
  ctx.arc(0, 0, BIRD_R, 0, Math.PI * 2);
  ctx.fill();
  // wing
  ctx.fillStyle = '#d88f1c';
  ctx.beginPath();
  ctx.ellipse(-3, 3, 8, 5, -0.4, 0, Math.PI * 2);
  ctx.fill();
  // beak
  ctx.fillStyle = '#ff7e2f';
  ctx.beginPath();
  ctx.moveTo(BIRD_R - 2, -2);
  ctx.lineTo(BIRD_R + 8, 0);
  ctx.lineTo(BIRD_R - 2, 4);
  ctx.closePath();
  ctx.fill();
  // eye
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(5, -5, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#222';
  ctx.beginPath();
  ctx.arc(6, -5, 2, 0, Math.PI * 2);
  ctx.fill();
  // outline
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
  // dashes
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
  // sky already from CSS background; paint a soft layer for canvas export
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
  const dt = Math.min(0.05, (t - lastTime) / 1000);
  lastTime = t;
  update(dt);
  draw();
  rafHandle = requestAnimationFrame(loop);
}

// inputs
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' || e.key === ' ' || e.key === 'ArrowUp') {
    e.preventDefault();
    flap();
  } else if (e.key === 'r' || e.key === 'R') {
    e.preventDefault();
    reset();
  }
});

canvas.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  flap();
});

canvas.addEventListener('touchstart', (e) => {
  e.preventDefault();
  flap();
}, { passive: false });

restartBtn.addEventListener('click', () => {
  reset();
});

reset();
cancelAnimationFrame(rafHandle);
lastTime = 0;
rafHandle = requestAnimationFrame(loop);
