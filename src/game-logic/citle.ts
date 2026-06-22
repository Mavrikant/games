import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';

const STORAGE_BEST = 'citle.best';

const COLS = 20;
const ROWS = 14;
const CELL = 24;
const PLAYER_TICK_MS = 90;
const ENEMY_TICK_MS_BASE = 420;
const ENEMY_TICK_MS_MIN = 200;
const LIVES_START = 3;
const TARGET_FILL = 0.75;
const INITIAL_ENEMIES = 2;
const MAX_ENEMIES = 8;

type Cell = 0 | 1 | 2 | 3;
const WALL: Cell = 0;
const FIELD: Cell = 1;
const TRAIL: Cell = 2;
const FENCE: Cell = 3;

type Dir = 'up' | 'down' | 'left' | 'right';
type State = 'ready' | 'playing' | 'levelclear' | 'gameover';
type Enemy = { x: number; y: number };

const DIR_VEC: Record<Dir, [number, number]> = {
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
};
const OPPOSITE: Record<Dir, Dir> = {
  up: 'down',
  down: 'up',
  left: 'right',
  right: 'left',
};

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let livesEl!: HTMLElement;
let levelEl!: HTMLElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let restartBtn!: HTMLButtonElement;

let grid: Cell[][] = [];
let enemies: Enemy[] = [];
let px = 0;
let py = 0;
let dir: Dir | null = null;
let state: State = 'ready';

let score = 0;
let best = 0;
let lives = LIVES_START;
let level = 1;
let fieldStart = 0;

let lastPlayerStep = 0;
let lastEnemyStep = 0;
let flashUntil = 0;

const cssCache = new Map<string, string>();
function getCss(name: string, fallback: string): string {
  const cached = cssCache.get(name);
  if (cached !== undefined) return cached || fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  cssCache.set(name, v);
  return v || fallback;
}

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlay);
}

function hideOverlay(): void {
  hideOverlayEl(overlay);
}

function countCells(target: Cell): number {
  let n = 0;
  for (let y = 0; y < ROWS; y++) {
    const row = grid[y]!;
    for (let x = 0; x < COLS; x++) {
      if (row[x] === target) n++;
    }
  }
  return n;
}

function clearTrail(): void {
  for (let y = 0; y < ROWS; y++) {
    const row = grid[y]!;
    for (let x = 0; x < COLS; x++) {
      if (row[x] === TRAIL) row[x] = FIELD;
    }
  }
}

function setupLevel(): void {
  grid = [];
  for (let y = 0; y < ROWS; y++) {
    const row: Cell[] = [];
    for (let x = 0; x < COLS; x++) {
      if (x === 0 || x === COLS - 1 || y === 0 || y === ROWS - 1) {
        row.push(WALL);
      } else {
        row.push(FIELD);
      }
    }
    grid.push(row);
  }
  fieldStart = countCells(FIELD);

  const target = Math.min(MAX_ENEMIES, INITIAL_ENEMIES + level - 1);
  enemies = [];
  let attempts = 0;
  while (enemies.length < target && attempts < 200) {
    attempts++;
    const ex = 4 + Math.floor(Math.random() * (COLS - 8));
    const ey = 4 + Math.floor(Math.random() * (ROWS - 8));
    if (grid[ey]![ex] !== FIELD) continue;
    const tooClose = enemies.some((e) => Math.abs(e.x - ex) + Math.abs(e.y - ey) < 3);
    if (tooClose) continue;
    enemies.push({ x: ex, y: ey });
  }

  px = 0;
  py = 0;
  dir = null;
}

function fullReset(): void {
  score = 0;
  lives = LIVES_START;
  level = 1;
  state = 'ready';
  setupLevel();
  syncHud();
  flashUntil = 0;
  showOverlay('Çitle', 'Ok tuşlarıyla tarlaya dal. Geri kıyıya ulaşınca çevrelediğin alan çit olur. Tavşanlar açık çitini kemirirse can gider. Hedef: %' + Math.round(TARGET_FILL * 100));
  draw();
}

function nextLevel(): void {
  level++;
  state = 'levelclear';
  setupLevel();
  syncHud();
  showOverlay(`Seviye ${level}`, `Tarla büyüdü, sürüye bir tavşan eklendi. Yön tuşuyla başla.`);
}

function syncHud(): void {
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
  livesEl.textContent = String(lives);
  levelEl.textContent = String(level);
}

function startPlaying(): void {
  if (state === 'gameover') return;
  state = 'playing';
  lastPlayerStep = performance.now();
  lastEnemyStep = performance.now();
  hideOverlay();
}

function setDir(d: Dir): void {
  if (state === 'gameover') return;
  if (dir && OPPOSITE[dir] === d) {
    if (grid[py]![px] === TRAIL) return;
  }
  dir = d;
  if (state === 'ready' || state === 'levelclear') startPlaying();
}

function isPerimeterLike(c: Cell): boolean {
  return c === WALL || c === FENCE;
}

function loseLife(reason: string): void {
  clearTrail();
  px = 0;
  py = 0;
  dir = null;
  lives--;
  livesEl.textContent = String(lives);
  flashUntil = performance.now() + 320;
  if (lives <= 0) {
    state = 'gameover';
    if (score > best) {
      best = score;
      safeWrite(STORAGE_BEST, best);
      bestEl.textContent = String(best);
    }
    showOverlay('Bitti!', `Skor: ${score} · Seviye ${level} · R ile yeniden başla`);
    return;
  }
  state = 'ready';
  showOverlay('Tutuldun!', `${reason} · Kalan can ${lives}. Yön tuşuyla devam.`);
}

function stepPlayer(): void {
  if (!dir) return;
  const [dx, dy] = DIR_VEC[dir];
  const nx = px + dx;
  const ny = py + dy;
  if (nx < 0 || nx >= COLS || ny < 0 || ny >= ROWS) return;
  const target = grid[ny]![nx]!;
  const here = grid[py]![px]!;
  if (target === TRAIL) {
    loseLife('Kendi izine çarptın');
    return;
  }
  if (target === FIELD) {
    grid[ny]![nx] = TRAIL;
    px = nx;
    py = ny;
    return;
  }
  if (isPerimeterLike(target)) {
    if (here === TRAIL) {
      px = nx;
      py = ny;
      closeLoop();
      return;
    }
    px = nx;
    py = ny;
  }
}

function closeLoop(): void {
  let trailConsumed = 0;
  for (let y = 0; y < ROWS; y++) {
    const row = grid[y]!;
    for (let x = 0; x < COLS; x++) {
      if (row[x] === TRAIL) {
        row[x] = FENCE;
        trailConsumed++;
      }
    }
  }

  const reachable: boolean[][] = [];
  for (let y = 0; y < ROWS; y++) {
    reachable.push(new Array<boolean>(COLS).fill(false));
  }
  const queue: Array<[number, number]> = [];
  for (const e of enemies) {
    const r = reachable[e.y];
    if (!r) continue;
    if (grid[e.y]![e.x] !== FIELD || r[e.x]) continue;
    r[e.x] = true;
    queue.push([e.x, e.y]);
  }
  const NEIGH: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  while (queue.length > 0) {
    const head = queue.shift()!;
    const cx = head[0];
    const cy = head[1];
    for (const n of NEIGH) {
      const nx = cx + n[0];
      const ny = cy + n[1];
      if (nx < 0 || nx >= COLS || ny < 0 || ny >= ROWS) continue;
      if (grid[ny]![nx] !== FIELD) continue;
      const r = reachable[ny]!;
      if (r[nx]) continue;
      r[nx] = true;
      queue.push([nx, ny]);
    }
  }

  let captured = 0;
  for (let y = 0; y < ROWS; y++) {
    const row = grid[y]!;
    const r = reachable[y]!;
    for (let x = 0; x < COLS; x++) {
      if (row[x] === FIELD && !r[x]) {
        row[x] = FENCE;
        captured++;
      }
    }
  }

  if (captured > 0 || trailConsumed > 0) {
    score += captured * 10 + Math.floor((captured * captured) / 12) + trailConsumed;
    scoreEl.textContent = String(score);
    if (score > best) {
      best = score;
      safeWrite(STORAGE_BEST, best);
      bestEl.textContent = String(best);
    }
  }

  const fieldNow = countCells(FIELD);
  const filled = (fieldStart - fieldNow) / fieldStart;
  if (filled >= TARGET_FILL) {
    nextLevel();
  }
}

function stepEnemies(): void {
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i]!;
    const opts: Array<[number, number]> = [];
    const NEIGH: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const n of NEIGH) {
      const nx = e.x + n[0];
      const ny = e.y + n[1];
      if (nx < 0 || nx >= COLS || ny < 0 || ny >= ROWS) continue;
      const cell = grid[ny]![nx]!;
      if (cell === FIELD || cell === TRAIL) opts.push([nx, ny]);
    }
    if (opts.length === 0) continue;
    const pick = opts[Math.floor(Math.random() * opts.length)]!;
    const targetCell = grid[pick[1]]![pick[0]]!;
    if (targetCell === TRAIL) {
      loseLife('Tavşan çitini kemirdi');
      return;
    }
    e.x = pick[0];
    e.y = pick[1];
  }
}

function draw(): void {
  const surface = getCss('--surface', '#161a23');
  const border = getCss('--border', '#2a3140');
  const accent = getCss('--accent', '#f59e0b');
  const accent2 = getCss('--accent-2', '#22d3ee');

  ctx.fillStyle = surface;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (let y = 0; y < ROWS; y++) {
    const row = grid[y]!;
    for (let x = 0; x < COLS; x++) {
      const c = row[x]!;
      if (c === WALL) {
        ctx.fillStyle = border;
        ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
      } else if (c === FIELD) {
        ctx.fillStyle = '#0d1018';
        ctx.fillRect(x * CELL + 1, y * CELL + 1, CELL - 2, CELL - 2);
      } else if (c === TRAIL) {
        ctx.fillStyle = accent;
        ctx.fillRect(x * CELL + 2, y * CELL + 2, CELL - 4, CELL - 4);
      } else {
        ctx.fillStyle = accent2;
        ctx.globalAlpha = 0.55;
        ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
        ctx.globalAlpha = 1;
      }
    }
  }

  for (const e of enemies) {
    ctx.fillStyle = '#ef4444';
    ctx.beginPath();
    ctx.arc(e.x * CELL + CELL / 2, e.y * CELL + CELL / 2, CELL / 2 - 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#1a0408';
    ctx.beginPath();
    ctx.arc(e.x * CELL + CELL / 2 - 3, e.y * CELL + CELL / 2 - 2, 1.6, 0, Math.PI * 2);
    ctx.arc(e.x * CELL + CELL / 2 + 3, e.y * CELL + CELL / 2 - 2, 1.6, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.fillStyle = '#fde68a';
  ctx.beginPath();
  ctx.arc(px * CELL + CELL / 2, py * CELL + CELL / 2, CELL / 2 - 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#0a0b0e';
  ctx.lineWidth = 2;
  ctx.stroke();

  const fieldNow = countCells(FIELD);
  const filled = fieldStart > 0 ? (fieldStart - fieldNow) / fieldStart : 0;
  const pct = Math.round(filled * 100);
  ctx.fillStyle = 'rgba(10,11,14,0.55)';
  ctx.fillRect(canvas.width - 78, 6, 72, 22);
  ctx.fillStyle = '#fde68a';
  ctx.font = '600 13px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillText(`%${pct} / %${Math.round(TARGET_FILL * 100)}`, canvas.width - 10, 17);

  if (flashUntil > performance.now()) {
    ctx.fillStyle = 'rgba(239,68,68,0.18)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
}

function loop(t: number): void {
  requestAnimationFrame(loop);
  if (state === 'playing') {
    if (t - lastPlayerStep >= PLAYER_TICK_MS) {
      stepPlayer();
      lastPlayerStep = t;
    }
    const enemyTick = Math.max(ENEMY_TICK_MS_MIN, ENEMY_TICK_MS_BASE - level * 22);
    if (t - lastEnemyStep >= enemyTick) {
      stepEnemies();
      lastEnemyStep = t;
    }
  }
  draw();
}

function onKey(e: KeyboardEvent): void {
  const k = e.key.toLowerCase();
  if (k === 'r') {
    e.preventDefault();
    fullReset();
    return;
  }
  if (k === ' ' || k === 'enter') {
    e.preventDefault();
    if (state === 'ready' || state === 'levelclear') {
      if (!dir) dir = 'right';
      startPlaying();
    } else if (state === 'gameover') {
      fullReset();
    }
    return;
  }
  let d: Dir | null = null;
  if (k === 'arrowup' || k === 'w') d = 'up';
  else if (k === 'arrowdown' || k === 's') d = 'down';
  else if (k === 'arrowleft' || k === 'a') d = 'left';
  else if (k === 'arrowright' || k === 'd') d = 'right';
  if (!d) return;
  e.preventDefault();
  setDir(d);
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  livesEl = document.querySelector<HTMLElement>('#lives')!;
  levelEl = document.querySelector<HTMLElement>('#level')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  window.addEventListener('keydown', onKey);
  restartBtn.addEventListener('click', () => fullReset());
  overlay.addEventListener('pointerdown', () => {
    if (state === 'ready' || state === 'levelclear') {
      if (!dir) dir = 'right';
      startPlaying();
    } else if (state === 'gameover') {
      fullReset();
    }
  });
  document.querySelectorAll<HTMLButtonElement>('.touch__btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const d = btn.dataset.dir as Dir | undefined;
      if (d) setDir(d);
    });
  });

  fullReset();
  loop(performance.now());
}

function reset(): void {
  fullReset();
}

export const game = defineGame({ init, reset });
