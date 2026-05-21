export {};

// ─── Constants ────────────────────────────────────────────────────────────────
const W = 360;
const H = 560;
const FLOOR_H = 28;
const INIT_BLOCK_W = 200;
const MIN_BLOCK_W = 8;
const INIT_SPEED = 110;
const SPEED_INC = 7;
const MOVING_Y = 72;
const TOWER_TOP_TARGET = 112;
const GROUND_Y = H - 30; // 530

const FLOOR_COLORS: string[] = [
  '#3b82f6', '#6366f1', '#8b5cf6', '#a855f7',
  '#ec4899', '#f43f5e', '#f97316', '#eab308',
  '#84cc16', '#22c55e', '#14b8a6', '#06b6d4',
];

// ─── DOM ──────────────────────────────────────────────────────────────────────
const canvas = document.querySelector<HTMLCanvasElement>('#board')!;
const ctx = canvas.getContext('2d')!;
const scoreEl = document.querySelector<HTMLElement>('#score')!;
const bestEl = document.querySelector<HTMLElement>('#best')!;
const restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;

// ─── Storage ──────────────────────────────────────────────────────────────────
const STORAGE_KEY = 'kule-insaat.best';

function safeRead(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? Number(raw) || 0 : 0;
  } catch {
    return 0;
  }
}

function safeWrite(v: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(v));
  } catch {
    /* ignore */
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────
type State = 'ready' | 'playing' | 'gameover';

type Floor = {
  x: number;
  w: number;
  colorIdx: number;
  y: number; // canvas y of block TOP
};

type FallingPiece = {
  x: number;
  y: number;
  w: number;
  colorIdx: number;
  vy: number;
};

// ─── State variables ──────────────────────────────────────────────────────────
let state: State = 'ready';
let generation = 0;
let floors: Floor[] = [];
let movingX = 0;
let movingDir = 1;
let movingSpeed = INIT_SPEED;
let score = 0;
let best = 0;
let lastTs = 0;
let rafId = 0;
let fallingPieces: FallingPiece[] = [];

// ─── Helpers ──────────────────────────────────────────────────────────────────
function topFloor(): Floor {
  return floors[floors.length - 1]!;
}

function currentBlockW(): number {
  return topFloor().w;
}

function floorColorIdx(): number {
  return floors.length % FLOOR_COLORS.length;
}

function updateHud(): void {
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
}

// ─── Draw helpers ─────────────────────────────────────────────────────────────
function roundRect2(x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

function drawBlock(
  x: number,
  y: number,
  w: number,
  h: number,
  colorIdx: number,
  placed: boolean,
): void {
  const color = FLOOR_COLORS[colorIdx % FLOOR_COLORS.length]!;
  let r = 4;
  if (w < r * 2) r = w / 2;
  if (h < r * 2) r = h / 2;

  // Shadow
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  roundRect2(x + 2, y + 2, w, h, r);
  ctx.fill();
  ctx.restore();

  // Fill
  ctx.save();
  ctx.fillStyle = placed ? color + 'cc' : color;
  roundRect2(x, y, w, h, r);
  ctx.fill();

  // White stroke for moving block
  if (!placed) {
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 2;
    roundRect2(x, y, w, h, r);
    ctx.stroke();
  }

  // Highlight on top third
  ctx.fillStyle = 'rgba(255,255,255,0.15)';
  const highlightH = Math.max(4, Math.floor(h / 3));
  let hr = r;
  if (w < hr * 2) hr = w / 2;
  if (highlightH < hr * 2) hr = highlightH / 2;
  roundRect2(x, y, w, highlightH, hr);
  ctx.fill();

  ctx.restore();
}

// ─── Draw ─────────────────────────────────────────────────────────────────────
function draw(): void {
  // Background gradient
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, '#0a0b1e');
  grad.addColorStop(1, '#0f172a');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // Static stars (parallax by topFloor y for subtle drift)
  const scrollOffset = floors.length > 0 ? topFloor().y % 100 : 0;
  const starSeeds = [
    [23, 45], [67, 120], [150, 30], [200, 90], [310, 15],
    [45, 200], [280, 170], [100, 250], [340, 300], [20, 340],
    [180, 380], [250, 420], [80, 470], [320, 500], [130, 510],
    [60, 80], [230, 60], [300, 390], [150, 450], [350, 220],
  ] as [number, number][];

  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  for (const [sx, sy] of starSeeds) {
    const starY = ((sy! + scrollOffset * 0.3) % H + H) % H;
    ctx.beginPath();
    ctx.arc(sx!, starY, 1, 0, Math.PI * 2);
    ctx.fill();
  }

  // Draw all placed floors
  for (const floor of floors) {
    if (floor.y < -FLOOR_H || floor.y > H + FLOOR_H) continue;
    drawBlock(floor.x, floor.y, floor.w, FLOOR_H, floor.colorIdx, true);
  }

  // Draw moving block
  if (state === 'playing' || state === 'ready') {
    drawBlock(movingX, MOVING_Y, currentBlockW(), FLOOR_H, floorColorIdx(), false);
  }

  // Draw falling pieces
  for (const fp of fallingPieces) {
    if (fp.y > H + 50) continue;
    drawBlock(fp.x, fp.y, fp.w, FLOOR_H, fp.colorIdx, true);
  }

  // Overlay for ready / gameover
  if (state === 'ready' || state === 'gameover') {
    ctx.fillStyle = 'rgba(0,0,0,0.72)';
    ctx.fillRect(0, 0, W, H);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (state === 'ready') {
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 28px system-ui, sans-serif';
      ctx.fillText('Kule İnşaatı', W / 2, H / 2 - 50);

      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.font = '16px system-ui, sans-serif';
      ctx.fillText('SPACE veya ekrana bas', W / 2, H / 2);
      ctx.fillText('başlamak için', W / 2, H / 2 + 28);
    } else {
      ctx.fillStyle = '#f43f5e';
      ctx.font = 'bold 28px system-ui, sans-serif';
      ctx.fillText('Oyun Bitti!', W / 2, H / 2 - 60);

      ctx.fillStyle = '#ffffff';
      ctx.font = '18px system-ui, sans-serif';
      ctx.fillText(`Kat: ${score}`, W / 2, H / 2 - 20);

      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.font = '15px system-ui, sans-serif';
      ctx.fillText(`En İyi: ${best}`, W / 2, H / 2 + 16);

      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.font = '14px system-ui, sans-serif';
      ctx.fillText('SPACE veya ekrana bas — yeniden başla', W / 2, H / 2 + 55);
    }
  }
}

// ─── Game logic ───────────────────────────────────────────────────────────────
function beginPlay(): void {
  state = 'playing';
}

function drop(): void {
  if (state === 'ready') {
    beginPlay();
    return;
  }
  if (state === 'gameover') {
    reset();
    return;
  }
  if (state !== 'playing') return;

  const tf = topFloor();
  const blockW = currentBlockW();
  const overlapLeft = Math.max(movingX, tf.x);
  const overlapRight = Math.min(movingX + blockW, tf.x + tf.w);
  const newW = overlapRight - overlapLeft;

  if (newW <= MIN_BLOCK_W) {
    state = 'gameover';
    if (score > best) {
      best = score;
      safeWrite(best);
    }
    updateHud();
    return;
  }

  const colorIdx = floorColorIdx();

  // Left overhang
  if (movingX < overlapLeft) {
    fallingPieces.push({
      x: movingX,
      y: MOVING_Y,
      w: overlapLeft - movingX,
      colorIdx,
      vy: 60,
    });
  }

  // Right overhang
  if (movingX + blockW > overlapRight) {
    fallingPieces.push({
      x: overlapRight,
      y: MOVING_Y,
      w: movingX + blockW - overlapRight,
      colorIdx,
      vy: 60,
    });
  }

  // Compute new floor y
  let newY = tf.y - FLOOR_H;
  if (newY < TOWER_TOP_TARGET) {
    const shift = TOWER_TOP_TARGET - newY;
    for (const fl of floors) {
      fl.y += shift;
    }
    for (const fp of fallingPieces) {
      fp.y += shift;
    }
    newY = TOWER_TOP_TARGET;
  }

  floors.push({ x: overlapLeft, w: newW, colorIdx, y: newY });

  // Cull floors below canvas
  floors = floors.filter((fl) => fl.y < H + FLOOR_H);

  score++;
  movingSpeed = INIT_SPEED + score * SPEED_INC;

  // Toggle direction; position moving block off-screen on the incoming side
  movingDir = -movingDir;
  movingX = movingDir > 0 ? -newW : W;

  updateHud();
}

function reset(): void {
  generation++;
  state = 'ready';
  floors = [
    {
      x: W / 2 - INIT_BLOCK_W / 2,
      w: INIT_BLOCK_W,
      colorIdx: 0,
      y: GROUND_Y - FLOOR_H,
    },
  ];
  movingX = -INIT_BLOCK_W;
  movingDir = 1;
  movingSpeed = INIT_SPEED;
  score = 0;
  fallingPieces = [];
  lastTs = 0;
  updateHud();
  draw();
}

// ─── Update ───────────────────────────────────────────────────────────────────
function update(dt: number): void {
  if (state !== 'playing') return;

  movingX += movingDir * movingSpeed * dt;

  const blockW = currentBlockW();

  // Bounce off right wall
  if (movingDir > 0 && movingX + blockW > W) {
    movingX = W - blockW;
    movingDir = -1;
  }
  // Bounce off left wall
  if (movingDir < 0 && movingX < 0) {
    movingX = 0;
    movingDir = 1;
  }

  // Animate falling pieces
  for (const fp of fallingPieces) {
    fp.y += fp.vy * dt;
    fp.vy += 320 * dt;
  }
  fallingPieces = fallingPieces.filter((fp) => fp.y <= H + 50);
}

// ─── RAF loop ─────────────────────────────────────────────────────────────────
function frame(ts: number): void {
  const currentGen = generation;
  if (lastTs === 0) lastTs = ts;
  const dt = Math.min((ts - lastTs) / 1000, 0.05);
  lastTs = ts;

  update(dt);
  draw();

  if (currentGen === generation) {
    rafId = requestAnimationFrame(frame);
  }
}

// ─── Input ────────────────────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    e.preventDefault();
    drop();
  } else if (e.key === 'r' || e.key === 'R') {
    reset();
  }
});

canvas.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  drop();
}, { passive: false });

canvas.addEventListener('touchstart', (e) => {
  e.preventDefault();
}, { passive: false });

restartBtn.addEventListener('click', () => {
  reset();
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    lastTs = 0;
  }
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
best = safeRead();
reset();
cancelAnimationFrame(rafId);
lastTs = 0;
rafId = requestAnimationFrame(frame);
void generation;
