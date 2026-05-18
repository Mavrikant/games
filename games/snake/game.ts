type Dir = 'up' | 'down' | 'left' | 'right';
type Cell = { x: number; y: number };

const COLS = 20;
const ROWS = 20;
const TICK_MS = 110;
const STORAGE_KEY = 'snake.best';

const canvas = document.querySelector<HTMLCanvasElement>('#board')!;
const ctx = canvas.getContext('2d')!;
const scoreEl = document.querySelector<HTMLElement>('#score')!;
const bestEl = document.querySelector<HTMLElement>('#best')!;
const overlay = document.querySelector<HTMLElement>('#overlay')!;
const overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
const overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
const restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;

const cellSize = canvas.width / COLS;

let snake: Cell[] = [];
let dir: Dir = 'right';
let pendingDir: Dir = 'right';
let food: Cell = { x: 0, y: 0 };
let score = 0;
let best = Number(localStorage.getItem(STORAGE_KEY) ?? '0') || 0;
let alive = false;
let paused = false;
let started = false;
let tickHandle: number | null = null;

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  overlay.classList.remove('overlay--hidden');
}

function hideOverlay(): void {
  overlay.classList.add('overlay--hidden');
}

function placeFood(): void {
  const taken = new Set(snake.map((c) => `${c.x},${c.y}`));
  const free: Cell[] = [];
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      if (!taken.has(`${x},${y}`)) free.push({ x, y });
    }
  }
  if (free.length === 0) return;
  const pick = free[Math.floor(Math.random() * free.length)]!;
  food = pick;
}

function reset(): void {
  snake = [
    { x: 9, y: 10 },
    { x: 8, y: 10 },
    { x: 7, y: 10 },
  ];
  dir = 'right';
  pendingDir = 'right';
  score = 0;
  scoreEl.textContent = '0';
  bestEl.textContent = String(best);
  alive = true;
  paused = false;
  started = false;
  placeFood();
  draw();
  showOverlay('Snake', 'Başlamak için bir yön tuşuna bas.');
  stopLoop();
}

function startLoopIfNeeded(): void {
  if (tickHandle !== null) return;
  tickHandle = window.setInterval(tick, TICK_MS);
}

function stopLoop(): void {
  if (tickHandle !== null) {
    clearInterval(tickHandle);
    tickHandle = null;
  }
}

function opposite(a: Dir, b: Dir): boolean {
  return (
    (a === 'up' && b === 'down') ||
    (a === 'down' && b === 'up') ||
    (a === 'left' && b === 'right') ||
    (a === 'right' && b === 'left')
  );
}

function setDir(next: Dir): void {
  if (opposite(dir, next)) return;
  pendingDir = next;
  if (!started && alive) {
    started = true;
    hideOverlay();
    startLoopIfNeeded();
  }
}

function tick(): void {
  if (!alive || paused) return;
  dir = pendingDir;
  const head = snake[0]!;
  const next: Cell = { x: head.x, y: head.y };
  if (dir === 'up') next.y--;
  else if (dir === 'down') next.y++;
  else if (dir === 'left') next.x--;
  else next.x++;

  if (next.x < 0 || next.x >= COLS || next.y < 0 || next.y >= ROWS) {
    return die();
  }
  if (snake.some((c, i) => i < snake.length - 1 && c.x === next.x && c.y === next.y)) {
    return die();
  }

  snake.unshift(next);

  if (next.x === food.x && next.y === food.y) {
    score++;
    scoreEl.textContent = String(score);
    if (score > best) {
      best = score;
      bestEl.textContent = String(best);
      localStorage.setItem(STORAGE_KEY, String(best));
    }
    placeFood();
  } else {
    snake.pop();
  }

  draw();
}

function die(): void {
  alive = false;
  stopLoop();
  draw();
  showOverlay('Bitti!', `Skor: ${score} · R ile yeniden başla`);
}

function draw(): void {
  ctx.fillStyle = getCss('--bg-elev');
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = getCss('--grid');
  ctx.lineWidth = 1;
  for (let i = 1; i < COLS; i++) {
    ctx.beginPath();
    ctx.moveTo(i * cellSize, 0);
    ctx.lineTo(i * cellSize, canvas.height);
    ctx.stroke();
  }
  for (let i = 1; i < ROWS; i++) {
    ctx.beginPath();
    ctx.moveTo(0, i * cellSize);
    ctx.lineTo(canvas.width, i * cellSize);
    ctx.stroke();
  }

  ctx.fillStyle = getCss('--food');
  drawCell(food.x, food.y, 0.7);

  snake.forEach((c, i) => {
    ctx.fillStyle = i === 0 ? getCss('--snake-head') : getCss('--snake');
    drawCell(c.x, c.y, i === 0 ? 0.95 : 0.85);
  });
}

function drawCell(x: number, y: number, scale: number): void {
  const pad = (cellSize * (1 - scale)) / 2;
  ctx.fillRect(
    x * cellSize + pad,
    y * cellSize + pad,
    cellSize * scale,
    cellSize * scale,
  );
}

const cssCache = new Map<string, string>();
function getCss(varName: string): string {
  const cached = cssCache.get(varName);
  if (cached !== undefined) return cached;
  const val = getComputedStyle(document.documentElement)
    .getPropertyValue(varName)
    .trim();
  cssCache.set(varName, val);
  return val;
}

window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k === 'arrowup' || k === 'w') {
    setDir('up');
    e.preventDefault();
  } else if (k === 'arrowdown' || k === 's') {
    setDir('down');
    e.preventDefault();
  } else if (k === 'arrowleft' || k === 'a') {
    setDir('left');
    e.preventDefault();
  } else if (k === 'arrowright' || k === 'd') {
    setDir('right');
    e.preventDefault();
  } else if (k === ' ' && alive && started) {
    paused = !paused;
    if (paused) showOverlay('Duraklatıldı', 'Devam için boşluk.');
    else hideOverlay();
    e.preventDefault();
  } else if (k === 'r') {
    reset();
    e.preventDefault();
  }
});

document.querySelectorAll<HTMLButtonElement>('.touch__btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const d = btn.dataset.dir as Dir | undefined;
    if (d) setDir(d);
  });
});

restartBtn.addEventListener('click', reset);

reset();
