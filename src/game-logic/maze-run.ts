// Maze Run — procedural maze, drag/swipe + arrow/WASD navigation.
//
// Design notes / pitfalls avoided:
// - Explicit GameState enum gates all input → no overlay-input-leak.
// - generationToken bumps on every reset() so any deferred rAF/timeout that
//   survives a restart bails out → no stale-async-callback.
// - All localStorage reads wrapped in try/catch and deferred to runtime (no
//   module-level side effects) → no unguarded-storage on Safari private.
// - Canvas backing store is sized to CSS pixels × DPR so the maze stays
//   crisp on retina mobile; logical drawing units stay constant.
// - Visual cell size and hit-test grid both derive from the same
//   `cellSize = LOGICAL / mazeSize` value → no visual-vs-hitbox drift.
// - First user input triggers visible movement within one frame (player
//   already drawn in the start cell from reset()) → no invisible-boot.

type Dir = 'up' | 'down' | 'left' | 'right';
type GameState = 'ready' | 'playing' | 'won' | 'lost' | 'paused';

// Each cell stores which of its 4 walls are open (true = open / no wall).
interface Cell {
  walls: { n: boolean; e: boolean; s: boolean; w: boolean };
}

// --- DOM ---
const canvas = document.querySelector<HTMLCanvasElement>('#board')!;
const ctx = canvas.getContext('2d')!;
const levelEl = document.querySelector<HTMLElement>('#level')!;
const timeEl = document.querySelector<HTMLElement>('#time')!;
const bestEl = document.querySelector<HTMLElement>('#best')!;
const restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
const overlay = document.querySelector<HTMLElement>('#overlay')!;
const overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
const overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
const overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-action')!;

// --- Tunables ---
const LOGICAL = 480;             // canvas logical px (square)
const START_SIZE = 8;            // starting maze dimension
const SIZE_STEP = 2;             // grow by N per level
const MAX_SIZE = 24;             // cap; otherwise cells become unplayable
const TIME_LIMIT_SEC = 60;       // per-level time (does not shrink, maze grows)
const SWIPE_THRESHOLD = 25;      // px to register a directional swipe
const SWIPE_AXIS_BIAS = 1.4;     // dominant axis must exceed perpendicular by this factor
const MOVE_ANIM_MS = 110;        // pawn movement animation duration

const STORAGE_BEST_LEVEL = 'maze-run.bestLevel';
const STORAGE_BEST_TIME = 'maze-run.bestTime';

// --- State ---
let mazeSize = START_SIZE;
let cellSize = LOGICAL / mazeSize;
let maze: Cell[][] = [];
let playerX = 0;
let playerY = 0;
let exitX = 0;
let exitY = 0;
let level = 1;
let timeLeft = TIME_LIMIT_SEC;
let bestLevel = 0;
let bestTimeMs = 0; // best (lowest) total elapsed across levels in a run; 0 = unset
let runStartMs = 0;
let state: GameState = 'ready';
let lastTickMs = 0;
let rafHandle = 0;
let shakeUntil = 0;
let generationToken = 0;

// Movement animation between cells. `animFromX/Y -> playerX/Y` over animMs.
let animFromX = 0;
let animFromY = 0;
let animStartMs = 0;
let animActive = false;

// Exit pulse animation (decorative)
let exitPulseStartMs = 0;

// Flash on win
let flashUntil = 0;

// --- Storage helpers (guarded) ---
function safeReadNumber(key: string): number {
  try {
    const v = localStorage.getItem(key);
    if (v === null) return 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}
function safeWriteNumber(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* private mode etc — ignore */
  }
}

// --- Maze generation (recursive backtracker, iterative) ---
function newMaze(size: number): Cell[][] {
  const g: Cell[][] = Array.from({ length: size }, () =>
    Array.from({ length: size }, () => ({
      walls: { n: false, e: false, s: false, w: false },
    })),
  );
  const visited: boolean[][] = Array.from({ length: size }, () =>
    Array.from({ length: size }, () => false),
  );
  // iterative DFS to avoid stack issues at MAX_SIZE
  const startX = 0;
  const startY = 0;
  visited[startY]![startX] = true;
  const stack: Array<[number, number]> = [[startX, startY]];

  while (stack.length > 0) {
    const top = stack[stack.length - 1]!;
    const cx = top[0];
    const cy = top[1];
    // Collect unvisited neighbours
    const neighbours: Array<[number, number, Dir]> = [];
    if (cy > 0 && !visited[cy - 1]![cx]) neighbours.push([cx, cy - 1, 'up']);
    if (cx < size - 1 && !visited[cy]![cx + 1]) neighbours.push([cx + 1, cy, 'right']);
    if (cy < size - 1 && !visited[cy + 1]![cx]) neighbours.push([cx, cy + 1, 'down']);
    if (cx > 0 && !visited[cy]![cx - 1]) neighbours.push([cx - 1, cy, 'left']);

    if (neighbours.length === 0) {
      stack.pop();
      continue;
    }
    const pick = neighbours[Math.floor(Math.random() * neighbours.length)]!;
    const nx = pick[0];
    const ny = pick[1];
    const dir = pick[2];
    // Knock down the wall between (cx, cy) and (nx, ny)
    const here = g[cy]![cx]!;
    const there = g[ny]![nx]!;
    if (dir === 'up') {
      here.walls.n = true;
      there.walls.s = true;
    } else if (dir === 'down') {
      here.walls.s = true;
      there.walls.n = true;
    } else if (dir === 'left') {
      here.walls.w = true;
      there.walls.e = true;
    } else {
      here.walls.e = true;
      there.walls.w = true;
    }
    visited[ny]![nx] = true;
    stack.push([nx, ny]);
  }
  return g;
}

// --- Lifecycle ---
function setLevel(n: number, carryTime: boolean): void {
  level = n;
  mazeSize = Math.min(MAX_SIZE, START_SIZE + (n - 1) * SIZE_STEP);
  cellSize = LOGICAL / mazeSize;
  maze = newMaze(mazeSize);
  playerX = 0;
  playerY = 0;
  exitX = mazeSize - 1;
  exitY = mazeSize - 1;
  animActive = false;
  shakeUntil = 0;
  exitPulseStartMs = performance.now();
  if (!carryTime) {
    timeLeft = TIME_LIMIT_SEC;
  }
  updateHud();
  draw();
}

function resetRun(): void {
  generationToken++; // invalidate any in-flight callbacks
  // Cancel any in-flight rAF; the stale loop also self-aborts via token
  // check but cancelling immediately means no half-frame is rendered
  // against fresh state.
  if (rafHandle !== 0) {
    cancelAnimationFrame(rafHandle);
    rafHandle = 0;
  }
  state = 'ready';
  bestLevel = safeReadNumber(STORAGE_BEST_LEVEL);
  bestTimeMs = safeReadNumber(STORAGE_BEST_TIME);
  setLevel(1, false);
  runStartMs = 0;
  showOverlay('Maze Run', 'Çıkışa ulaş. Ok tuşları, WASD veya ekranı kaydır.', 'Başla');
  startRafIfNeeded();
}

function startPlaying(): void {
  if (state === 'playing') return;
  state = 'playing';
  lastTickMs = performance.now();
  runStartMs = lastTickMs;
  hideOverlay();
  // Canvas may not have keyboard focus on iframe load — try to grab it so
  // keyboard navigation works without an explicit click in the maze.
  try {
    canvas.focus({ preventScroll: true });
  } catch {
    /* ignore */
  }
}

function advanceLevel(): void {
  // Carry remaining time forward but cap at the per-level limit so the
  // run gets progressively harder via the maze growing, not timer drain.
  const carry = Math.min(timeLeft + 5, TIME_LIMIT_SEC); // +5s bonus per level
  setLevel(level + 1, false);
  timeLeft = carry;
  updateHud();
  state = 'playing';
  lastTickMs = performance.now();
}

function win(): void {
  state = 'won';
  flashUntil = performance.now() + 380;
  if (level > bestLevel) {
    bestLevel = level;
    safeWriteNumber(STORAGE_BEST_LEVEL, bestLevel);
  }
  const elapsed = performance.now() - runStartMs;
  if (bestTimeMs === 0 || elapsed < bestTimeMs) {
    bestTimeMs = Math.round(elapsed);
    safeWriteNumber(STORAGE_BEST_TIME, bestTimeMs);
  }
  updateHud();
  showOverlay(
    'Çıkış bulundu!',
    `Seviye ${level} tamamlandı · sonraki: ${Math.min(MAX_SIZE, mazeSize + SIZE_STEP)}×${Math.min(MAX_SIZE, mazeSize + SIZE_STEP)}`,
    'Sonraki seviye',
  );
}

function lose(): void {
  state = 'lost';
  timeLeft = 0;
  updateHud();
  showOverlay(
    'Süre bitti',
    `Ulaşılan seviye: ${level} · yeniden dene`,
    'Yeniden başla',
  );
}

// --- HUD ---
function updateHud(): void {
  levelEl.textContent = String(level);
  timeEl.textContent = String(Math.max(0, Math.ceil(timeLeft)));
  bestEl.textContent = String(bestLevel);
}

function showOverlay(title: string, msg: string, btnLabel: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  overlayBtn.textContent = btnLabel;
  overlay.classList.remove('overlay--hidden');
}
function hideOverlay(): void {
  overlay.classList.add('overlay--hidden');
}

// --- Movement ---
function canMove(dir: Dir): boolean {
  const cell = maze[playerY]?.[playerX];
  if (!cell) return false;
  if (dir === 'up') return cell.walls.n;
  if (dir === 'down') return cell.walls.s;
  if (dir === 'left') return cell.walls.w;
  return cell.walls.e;
}

function tryMove(dir: Dir): void {
  if (state === 'ready') {
    startPlaying();
  }
  if (state !== 'playing') return;
  if (animActive) return; // ignore input mid-animation to keep grid in sync

  if (!canMove(dir)) {
    shakeUntil = performance.now() + 180;
    return;
  }
  animFromX = playerX;
  animFromY = playerY;
  if (dir === 'up') playerY--;
  else if (dir === 'down') playerY++;
  else if (dir === 'left') playerX--;
  else playerX++;
  animStartMs = performance.now();
  animActive = true;
  // Win condition is detected by the rAF tick after animation finishes so
  // the flash visually coincides with the player landing on the exit cell.
}

// --- Loop ---
function startRafIfNeeded(): void {
  if (rafHandle !== 0) return;
  const myToken = generationToken;
  const tick = (now: number): void => {
    if (myToken !== generationToken) {
      rafHandle = 0;
      return; // stale loop — fresh one was started by reset
    }
    if (state === 'playing') {
      const dt = (now - lastTickMs) / 1000;
      lastTickMs = now;
      // Don't run down the clock during the win flash (commit to next level).
      timeLeft -= dt;
      if (timeLeft <= 0) {
        timeLeft = 0;
        lose();
      } else {
        updateHud();
      }
    } else {
      lastTickMs = now;
    }
    // Commit a pending win once movement animation reaches the exit cell.
    if (
      state === 'playing' &&
      !animActive &&
      playerX === exitX &&
      playerY === exitY
    ) {
      win();
    }
    draw();
    rafHandle = requestAnimationFrame(tick);
  };
  rafHandle = requestAnimationFrame(tick);
}

// --- Rendering ---
const cssCache = new Map<string, string>();
function css(name: string, fallback: string): string {
  const cached = cssCache.get(name);
  if (cached !== undefined) return cached;
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  const out = v || fallback;
  cssCache.set(name, out);
  return out;
}

function resizeCanvas(): void {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  const cssW = Math.max(1, Math.round(rect.width || LOGICAL));
  const cssH = Math.max(1, Math.round(rect.height || LOGICAL));
  const targetW = Math.round(cssW * dpr);
  const targetH = Math.round(cssH * dpr);
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }
  ctx.setTransform(targetW / LOGICAL, 0, 0, targetH / LOGICAL, 0, 0);
  ctx.imageSmoothingEnabled = true;
}

function draw(): void {
  resizeCanvas();
  const now = performance.now();

  // Background
  ctx.fillStyle = css('--maze-bg', '#0f1218');
  ctx.fillRect(0, 0, LOGICAL, LOGICAL);

  // Shake offset for wall-bump feedback. Tiny so it never makes the
  // visible walls misalign with the actual hit-test grid.
  let ox = 0;
  let oy = 0;
  if (now < shakeUntil) {
    const t = (shakeUntil - now) / 180;
    ox = (Math.random() - 0.5) * 4 * t;
    oy = (Math.random() - 0.5) * 4 * t;
  }
  ctx.save();
  ctx.translate(ox, oy);

  // Exit cell glow
  const pulseT = ((now - exitPulseStartMs) / 900) % 1;
  const glow = 0.5 + 0.5 * Math.sin(pulseT * Math.PI * 2);
  ctx.fillStyle = css('--maze-exit', '#fde68a');
  ctx.globalAlpha = 0.18 + glow * 0.22;
  const ex = exitX * cellSize;
  const ey = exitY * cellSize;
  ctx.fillRect(ex + 2, ey + 2, cellSize - 4, cellSize - 4);
  ctx.globalAlpha = 1;
  // Exit ring
  ctx.strokeStyle = css('--maze-exit', '#fde68a');
  ctx.lineWidth = Math.max(1, cellSize * 0.06);
  ctx.strokeRect(
    ex + cellSize * 0.18,
    ey + cellSize * 0.18,
    cellSize * 0.64,
    cellSize * 0.64,
  );

  // Walls — draw each cell's N and W wall + boundary E/S on the last row/col.
  ctx.strokeStyle = css('--maze-wall', '#cbd5f5');
  ctx.lineWidth = Math.max(2, cellSize * 0.08);
  ctx.lineCap = 'square';
  ctx.beginPath();
  for (let y = 0; y < mazeSize; y++) {
    for (let x = 0; x < mazeSize; x++) {
      const cell = maze[y]![x]!;
      const px = x * cellSize;
      const py = y * cellSize;
      if (!cell.walls.n) {
        ctx.moveTo(px, py);
        ctx.lineTo(px + cellSize, py);
      }
      if (!cell.walls.w) {
        ctx.moveTo(px, py);
        ctx.lineTo(px, py + cellSize);
      }
      if (y === mazeSize - 1 && !cell.walls.s) {
        ctx.moveTo(px, py + cellSize);
        ctx.lineTo(px + cellSize, py + cellSize);
      }
      if (x === mazeSize - 1 && !cell.walls.e) {
        ctx.moveTo(px + cellSize, py);
        ctx.lineTo(px + cellSize, py + cellSize);
      }
    }
  }
  ctx.stroke();

  // Player — interpolate animation
  let drawX = playerX;
  let drawY = playerY;
  if (animActive) {
    const t = Math.min(1, (now - animStartMs) / MOVE_ANIM_MS);
    drawX = animFromX + (playerX - animFromX) * t;
    drawY = animFromY + (playerY - animFromY) * t;
    if (t >= 1) {
      animActive = false;
    }
  }
  const cx = drawX * cellSize + cellSize / 2;
  const cy = drawY * cellSize + cellSize / 2;
  const r = cellSize * 0.32;
  // Soft player halo
  ctx.fillStyle = css('--maze-player-glow', 'rgba(129, 140, 248, 0.35)');
  ctx.beginPath();
  ctx.arc(cx, cy, r * 1.7, 0, Math.PI * 2);
  ctx.fill();
  // Player core
  ctx.fillStyle = css('--maze-player', '#a5b4fc');
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  // Highlight
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.beginPath();
  ctx.arc(cx - r * 0.35, cy - r * 0.4, r * 0.32, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();

  // Win flash
  if (now < flashUntil) {
    const t = (flashUntil - now) / 380;
    ctx.fillStyle = `rgba(253, 230, 138, ${t * 0.55})`;
    ctx.fillRect(0, 0, LOGICAL, LOGICAL);
  }
}

// --- Input: keyboard ---
window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k === 'arrowup' || k === 'w') {
    tryMove('up');
    e.preventDefault();
  } else if (k === 'arrowdown' || k === 's') {
    tryMove('down');
    e.preventDefault();
  } else if (k === 'arrowleft' || k === 'a') {
    tryMove('left');
    e.preventDefault();
  } else if (k === 'arrowright' || k === 'd') {
    tryMove('right');
    e.preventDefault();
  } else if (k === 'r') {
    resetRun();
    e.preventDefault();
  } else if (k === ' ') {
    if (state === 'playing') {
      state = 'paused';
      showOverlay('Duraklatıldı', 'Devam etmek için boşluk veya düğmeye bas.', 'Devam et');
    } else if (state === 'paused') {
      hideOverlay();
      state = 'playing';
      lastTickMs = performance.now();
    }
    e.preventDefault();
  }
});

// --- Input: touch / pointer swipe on the maze surface ---
// Implemented manually (no library). Threshold ~25px diagonal tolerance:
// dominant axis must clear SWIPE_THRESHOLD and out-distance the other by
// SWIPE_AXIS_BIAS, otherwise it's ambiguous and we ignore the gesture.
interface SwipeState {
  active: boolean;
  startX: number;
  startY: number;
  pointerId: number;
}
const swipe: SwipeState = { active: false, startX: 0, startY: 0, pointerId: -1 };

canvas.addEventListener(
  'pointerdown',
  (e) => {
    // primary pointer only
    if (e.button !== undefined && e.button !== 0) return;
    swipe.active = true;
    swipe.startX = e.clientX;
    swipe.startY = e.clientY;
    swipe.pointerId = e.pointerId;
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    // Don't preventDefault here — we want focus/click semantics for desktop.
  },
  { passive: true },
);

canvas.addEventListener(
  'pointermove',
  (e) => {
    if (!swipe.active || e.pointerId !== swipe.pointerId) return;
    const dx = e.clientX - swipe.startX;
    const dy = e.clientY - swipe.startY;
    const adx = Math.abs(dx);
    const ady = Math.abs(dy);
    if (Math.max(adx, ady) < SWIPE_THRESHOLD) return;
    // Determine dominant axis with bias to avoid jittery diagonal swipes.
    if (adx >= ady * SWIPE_AXIS_BIAS) {
      tryMove(dx > 0 ? 'right' : 'left');
      // Re-anchor so the user can keep swiping in the same direction for
      // multiple cells without lifting their finger.
      swipe.startX = e.clientX;
      swipe.startY = e.clientY;
    } else if (ady >= adx * SWIPE_AXIS_BIAS) {
      tryMove(dy > 0 ? 'down' : 'up');
      swipe.startX = e.clientX;
      swipe.startY = e.clientY;
    }
  },
  { passive: true },
);

const endSwipe = (e: PointerEvent): void => {
  if (e.pointerId !== swipe.pointerId) return;
  swipe.active = false;
  swipe.pointerId = -1;
};
canvas.addEventListener('pointerup', endSwipe);
canvas.addEventListener('pointercancel', endSwipe);
canvas.addEventListener('pointerleave', endSwipe);

// Touch-only fallback for browsers where pointer events aren't perfect (and
// to make sure scrolling doesn't intercept the gesture on iOS Safari). The
// CSS `touch-action: none` on #board already blocks scroll, but
// preventDefault on touchmove belt-and-braces it.
canvas.addEventListener(
  'touchmove',
  (e) => {
    if (e.touches.length > 0) e.preventDefault();
  },
  { passive: false },
);

// --- Touch buttons (mobile fallback if user prefers tap-pad) ---
document.querySelectorAll<HTMLButtonElement>('.touch__btn').forEach((btn) => {
  const d = btn.dataset.dir as Dir | undefined;
  if (!d) return;
  btn.addEventListener(
    'pointerdown',
    (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();
      btn.classList.add('touch__btn--pressed');
      tryMove(d);
    },
    { passive: false },
  );
  const release = (): void => btn.classList.remove('touch__btn--pressed');
  btn.addEventListener('pointerup', release);
  btn.addEventListener('pointercancel', release);
  btn.addEventListener('pointerleave', release);
  // Suppress synthesised click so we don't fire twice.
  btn.addEventListener('click', (e) => e.preventDefault());
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
});

// --- Header / overlay buttons ---
restartBtn.addEventListener('click', () => {
  resetRun();
});

overlayBtn.addEventListener('click', () => {
  if (state === 'ready') {
    startPlaying();
  } else if (state === 'won') {
    advanceLevel();
    hideOverlay();
  } else if (state === 'lost') {
    resetRun();
    startPlaying();
  } else if (state === 'paused') {
    hideOverlay();
    state = 'playing';
    lastTickMs = performance.now();
  }
});

// --- Resize: re-tile canvas only; logical coords are stable. ---
let resizeRaf = 0;
function onResize(): void {
  if (resizeRaf) return;
  resizeRaf = requestAnimationFrame(() => {
    resizeRaf = 0;
    resizeCanvas();
    draw();
  });
}
window.addEventListener('resize', onResize);
window.addEventListener('orientationchange', onResize);

// --- Boot ---
resetRun();
