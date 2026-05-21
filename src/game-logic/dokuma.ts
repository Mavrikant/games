import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';

// Dokuma — weave the shown pattern by choosing UP/DOWN as the shuttle crosses each warp.
// Mechanic: shuttle moves left-to-right (and snake-style back) across COLS warp threads.
// Above the loom: a target pattern (PATTERN_ROWS rows). Player must reproduce it row by row.
// Per-column input window; miss or wrong = -1 life. Complete the pattern = next pattern, faster.

// --- State machine ---
type GameState = 'ready' | 'playing' | 'gameover' | 'tileClear';

// --- Geometry constants (single source of truth: draw() and hitbox both read these) ---
const CANVAS_W = 480;
const CANVAS_H = 560;
const COLS = 6;
const PATTERN_ROWS = 4;

// Layout zones
const PAD_X = 24;
const TARGET_TOP = 22;
const TARGET_ROW_H = 28;
const TARGET_BOTTOM = TARGET_TOP + PATTERN_ROWS * TARGET_ROW_H; // gap then live loom
const LIVE_TOP = TARGET_BOTTOM + 30;
const LIVE_ROW_H = 38;
const LIVE_BOTTOM = LIVE_TOP + PATTERN_ROWS * LIVE_ROW_H;
const CELL_W = (CANVAS_W - PAD_X * 2) / COLS;

const STORAGE_BEST = 'dokuma.best';
const STARTING_LIVES = 3;

// Cell choice: '∅' = empty, 'U' = over (üst), 'D' = under (alt), 'X' = wrong
type Cell = '∅' | 'U' | 'D' | 'X';

interface Tile {
  target: ('U' | 'D')[][];
  woven: Cell[][];
  row: number;
  col: number;
  direction: 1 | -1; // weaving direction for current row
  timePerColMs: number; // input window for current row
  remainingMs: number; // time left for the current column
}

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let livesEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let touchUpBtn!: HTMLButtonElement;
let touchDownBtn!: HTMLButtonElement;

let state: GameState = 'ready';
let score = 0;
let lives = STARTING_LIVES;
let best = 0; // initialized in init()
let tilesCompleted = 0;
let tile: Tile = makeTile(0);
let lastFrameTime = 0;
const generationToken = createGenToken();
let pendingClearTimeoutId: ReturnType<typeof setTimeout> | null = null;

function loadBest(): number {
  const v = safeRead<number>(STORAGE_BEST, 0);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

// CSS variable cache (theme-aware drawing)
const cssCache = new Map<string, string>();
function getCss(name: string): string {
  const cached = cssCache.get(name);
  if (cached !== undefined) return cached;
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  cssCache.set(name, v);
  return v;
}

function patternFor(tileIndex: number): ('U' | 'D')[][] {
  // Generate a pattern. Lower indexes have more structure (alternating, twill);
  // higher indexes get more random / harder to predict.
  const rng = mulberry32(0x9e3779b1 ^ (tileIndex * 0x85ebca6b));
  const pat: ('U' | 'D')[][] = [];
  // For variety, choose a base "weave style"
  const styles = ['plain', 'twill', 'basket', 'random'] as const;
  const style = styles[tileIndex % styles.length]!;
  for (let r = 0; r < PATTERN_ROWS; r++) {
    const row: ('U' | 'D')[] = [];
    for (let c = 0; c < COLS; c++) {
      let v: 'U' | 'D';
      if (style === 'plain') {
        v = (r + c) % 2 === 0 ? 'U' : 'D';
      } else if (style === 'twill') {
        v = ((r + Math.floor(c / 1)) % 3 < 2) ? 'U' : 'D';
      } else if (style === 'basket') {
        v = (Math.floor(r / 2) + Math.floor(c / 2)) % 2 === 0 ? 'U' : 'D';
      } else {
        v = rng() < 0.5 ? 'U' : 'D';
      }
      row.push(v);
    }
    pat.push(row);
  }
  return pat;
}

function makeTile(tileIndex: number): Tile {
  const target = patternFor(tileIndex);
  const woven: Cell[][] = [];
  for (let r = 0; r < PATTERN_ROWS; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < COLS; c++) row.push('∅');
    woven.push(row);
  }
  const timePerColMs = timeForTile(tileIndex);
  return {
    target,
    woven,
    row: 0,
    col: 0,
    direction: 1,
    timePerColMs,
    remainingMs: timePerColMs,
  };
}

function timeForTile(tileIndex: number): number {
  // Start slow (1100ms per column), speed up gradually. Floor at 480ms.
  const base = 1100;
  const t = base - tileIndex * 110;
  return Math.max(480, t);
}

// Small deterministic PRNG so patterns are reproducible per tile index.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Drawing ---
function clearBg(): void {
  ctx.fillStyle = getCss('--surface');
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
}

function drawTargetPattern(): void {
  // Label
  ctx.fillStyle = getCss('--text-dim');
  ctx.font = '600 11px Inter, system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('ÖRÜNTÜ', PAD_X, 6);

  const startX = PAD_X;
  const startY = TARGET_TOP;
  const w = COLS * CELL_W;
  const h = PATTERN_ROWS * TARGET_ROW_H;
  // Background panel
  ctx.fillStyle = getCss('--surface-2');
  ctx.fillRect(startX, startY, w, h);
  ctx.strokeStyle = getCss('--border');
  ctx.strokeRect(startX + 0.5, startY + 0.5, w - 1, h - 1);

  for (let r = 0; r < PATTERN_ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const x = startX + c * CELL_W;
      const y = startY + r * TARGET_ROW_H;
      const v = tile.target[r]![c]!;
      // Over = warm thread; Under = cool thread (slightly subdued/recessed)
      ctx.fillStyle = v === 'U' ? getCss('--dokuma-weft-a') : getCss('--dokuma-weft-b');
      const pad = v === 'U' ? 3 : 6;
      ctx.fillRect(x + pad, y + pad, CELL_W - pad * 2, TARGET_ROW_H - pad * 2);
      // grid lines
      ctx.strokeStyle = getCss('--border');
      ctx.strokeRect(x + 0.5, y + 0.5, CELL_W - 1, TARGET_ROW_H - 1);
    }
  }
}

function drawLoom(): void {
  // Label
  ctx.fillStyle = getCss('--text-dim');
  ctx.font = '600 11px Inter, system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('TEZGAH', PAD_X, TARGET_BOTTOM + 8);

  const startX = PAD_X;
  const startY = LIVE_TOP;
  const w = COLS * CELL_W;
  const h = PATTERN_ROWS * LIVE_ROW_H;
  // Background panel
  ctx.fillStyle = getCss('--surface-2');
  ctx.fillRect(startX, startY, w, h);
  ctx.strokeStyle = getCss('--border-strong');
  ctx.strokeRect(startX + 0.5, startY + 0.5, w - 1, h - 1);

  // Warp threads (vertical, behind weft cells)
  ctx.strokeStyle = getCss('--dokuma-warp');
  ctx.lineWidth = 2;
  for (let c = 0; c <= COLS; c++) {
    const x = startX + c * CELL_W;
    if (c > 0 && c < COLS) {
      ctx.beginPath();
      ctx.moveTo(x, startY + 2);
      ctx.lineTo(x, startY + h - 2);
      ctx.stroke();
    }
  }
  ctx.lineWidth = 1;

  // Woven cells
  for (let r = 0; r < PATTERN_ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const x = startX + c * CELL_W;
      const y = startY + r * LIVE_ROW_H;
      const cell = tile.woven[r]![c]!;
      if (cell === '∅') continue;
      if (cell === 'X') {
        ctx.fillStyle = getCss('--dokuma-wrong');
      } else if (cell === 'U') {
        ctx.fillStyle = getCss('--dokuma-weft-a');
      } else {
        ctx.fillStyle = getCss('--dokuma-weft-b');
      }
      // 'U' weft sits over the warp (wider band), 'D' weft sits under (narrower)
      const pad = cell === 'D' ? 8 : 4;
      ctx.fillRect(x + pad, y + 6, CELL_W - pad * 2, LIVE_ROW_H - 12);
      // Cell border
      ctx.strokeStyle = getCss('--border');
      ctx.strokeRect(x + 0.5, y + 0.5, CELL_W - 1, LIVE_ROW_H - 1);
    }
  }

  // Current row highlight + shuttle (only during playing)
  if (state === 'playing' && tile.row < PATTERN_ROWS) {
    const rowY = startY + tile.row * LIVE_ROW_H;
    ctx.fillStyle = 'rgba(129, 140, 248, 0.12)';
    ctx.fillRect(startX, rowY, w, LIVE_ROW_H);

    // Show target hint for the current row (smaller line underneath target panel,
    // visually linking target row → live row)
    const targetRowY = TARGET_TOP + tile.row * TARGET_ROW_H;
    ctx.strokeStyle = getCss('--accent');
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(startX, targetRowY + TARGET_ROW_H - 1);
    ctx.lineTo(startX + w, targetRowY + TARGET_ROW_H - 1);
    ctx.stroke();
    ctx.setLineDash([]);

    // Shuttle: rounded rectangle sliding from left/right depending on direction.
    const colCenter = startX + (tile.col + 0.5) * CELL_W;
    const shuttleY = rowY + LIVE_ROW_H / 2;
    drawShuttle(colCenter, shuttleY);

    // Time bar under the live loom for current column
    const ratio = Math.max(0, Math.min(1, tile.remainingMs / tile.timePerColMs));
    const barY = LIVE_BOTTOM + 8;
    const barH = 6;
    ctx.fillStyle = getCss('--border');
    ctx.fillRect(startX, barY, w, barH);
    ctx.fillStyle =
      ratio < 0.25
        ? getCss('--dokuma-wrong')
        : ratio < 0.55
          ? getCss('--dokuma-weft-a')
          : getCss('--accent');
    ctx.fillRect(startX, barY, w * ratio, barH);
  }
}

function drawShuttle(cx: number, cy: number): void {
  const w = CELL_W * 0.7;
  const h = 18;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.fillStyle = getCss('--dokuma-shuttle');
  ctx.strokeStyle = getCss('--accent-strong');
  ctx.lineWidth = 1.5;
  // pointy-ended shuttle shape
  ctx.beginPath();
  ctx.moveTo(-w / 2, 0);
  ctx.lineTo(-w / 2 + 8, -h / 2);
  ctx.lineTo(w / 2 - 8, -h / 2);
  ctx.lineTo(w / 2, 0);
  ctx.lineTo(w / 2 - 8, h / 2);
  ctx.lineTo(-w / 2 + 8, h / 2);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  // direction tick
  ctx.fillStyle = getCss('--accent-strong');
  ctx.beginPath();
  if (tile.direction === 1) {
    ctx.moveTo(w / 2 - 6, 0);
    ctx.lineTo(w / 2 - 12, -5);
    ctx.lineTo(w / 2 - 12, 5);
  } else {
    ctx.moveTo(-(w / 2 - 6), 0);
    ctx.lineTo(-(w / 2 - 12), -5);
    ctx.lineTo(-(w / 2 - 12), 5);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawHints(): void {
  ctx.fillStyle = getCss('--text-dim');
  ctx.font = '500 11px Inter, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  let label: string;
  if (state === 'ready') {
    label = 'Boşluk: başla · ↑ = ÜST · ↓ = ALT';
  } else if (state === 'gameover') {
    label = 'Tekrar başlamak için Boşluk veya Yeniden başla';
  } else if (state === 'tileClear') {
    label = 'Tabaka tamam — sıradaki örüntüye geçiliyor';
  } else {
    const hint = tile.target[tile.row]?.[tile.col] === 'U' ? 'üst (↑)' : 'alt (↓)';
    label = `Hedef: ${hint} · sıra ${tilesCompleted + 1}`;
  }
  ctx.fillText(label, CANVAS_W / 2, CANVAS_H - 20);
}

function draw(): void {
  clearBg();
  drawTargetPattern();
  drawLoom();
  drawHints();
}

// --- Game logic ---
function updateHud(): void {
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
  livesEl.textContent = String(lives);
}

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlay);
}
function hideOverlay(): void {
  hideOverlayEl(overlay);
}

function applyInput(choice: 'U' | 'D'): void {
  if (state !== 'playing') return;
  if (tile.row >= PATTERN_ROWS) return;
  const target = tile.target[tile.row]![tile.col]!;
  if (choice === target) {
    tile.woven[tile.row]![tile.col] = choice;
    score += 1;
    if (score > best) {
      best = score;
      safeWrite(STORAGE_BEST, best);
    }
    updateHud();
  } else {
    tile.woven[tile.row]![tile.col] = 'X';
    lives -= 1;
    updateHud();
    if (lives <= 0) {
      doGameOver();
      return;
    }
  }
  advanceCell();
}

function timeoutCurrentCell(): void {
  // Treat as wrong (no input within window)
  tile.woven[tile.row]![tile.col] = 'X';
  lives -= 1;
  updateHud();
  if (lives <= 0) {
    doGameOver();
    return;
  }
  advanceCell();
}

function advanceCell(): void {
  // Move along the row in the current direction; flip at the end and step down.
  const lastCol = COLS - 1;
  if (tile.direction === 1) {
    if (tile.col < lastCol) {
      tile.col += 1;
    } else {
      // end of row
      finishRow();
      return;
    }
  } else {
    if (tile.col > 0) {
      tile.col -= 1;
    } else {
      finishRow();
      return;
    }
  }
  tile.remainingMs = tile.timePerColMs;
}

function finishRow(): void {
  tile.row += 1;
  if (tile.row >= PATTERN_ROWS) {
    // Tile cleared
    tilesCompleted += 1;
    score += 4; // bonus for completing a tile
    if (score > best) {
      best = score;
      safeWrite(STORAGE_BEST, best);
    }
    updateHud();
    enterTileClear();
    return;
  }
  // Snake direction
  tile.direction = tile.direction === 1 ? -1 : 1;
  tile.col = tile.direction === 1 ? 0 : COLS - 1;
  tile.remainingMs = tile.timePerColMs;
}

function enterTileClear(): void {
  state = 'tileClear';
  showOverlay('Tabaka tamam!', `Skor: ${score} · sıradaki örüntü hazırlanıyor`);
  const tokenAtSchedule = generationToken.current();
  if (pendingClearTimeoutId !== null) clearTimeout(pendingClearTimeoutId);
  pendingClearTimeoutId = setTimeout(() => {
    pendingClearTimeoutId = null;
    if (!generationToken.isCurrent(tokenAtSchedule)) return; // stale, reset happened
    if (state !== 'tileClear') return;
    tile = makeTile(tilesCompleted);
    state = 'playing';
    hideOverlay();
  }, 900);
}

function doGameOver(): void {
  state = 'gameover';
  showOverlay('Mekik durdu', `Skor: ${score} · Boşluk veya butonla tekrar başla`);
}

function startPlaying(): void {
  // Single-tap from ready or gameover transitions to playing — no intermediate state.
  if (state === 'playing' || state === 'tileClear') return;
  if (state === 'gameover') {
    fullReset();
  }
  state = 'playing';
  hideOverlay();
}

function fullReset(): void {
  generationToken.bump();
  if (pendingClearTimeoutId !== null) {
    clearTimeout(pendingClearTimeoutId);
    pendingClearTimeoutId = null;
  }
  score = 0;
  lives = STARTING_LIVES;
  tilesCompleted = 0;
  tile = makeTile(0);
  state = 'ready';
  lastFrameTime = 0;
  updateHud();
  showOverlay('Dokuma', 'Yukarıdaki örüntüyü mekikle birebir doku. Boşluk ile başla.');
}

function tick(dt: number): void {
  if (state !== 'playing') return;
  tile.remainingMs -= dt;
  if (tile.remainingMs <= 0) {
    // Snap to zero for the next cell
    timeoutCurrentCell();
  }
}

function loop(now: number): void {
  if (lastFrameTime === 0) lastFrameTime = now;
  // Clamp dt so a backgrounded tab doesn't dump a huge frame into the game.
  const dt = Math.min(64, now - lastFrameTime);
  lastFrameTime = now;
  tick(dt);
  draw();
  requestAnimationFrame(loop);
}

// --- Input ---
// Centralized handler: every input path funnels through here so state machine
// transitions are explicit and overlay input leak (pitfall) is impossible.
function handleInput(action: 'up' | 'down' | 'start' | 'restart'): void {
  switch (state) {
    case 'ready':
      if (action === 'start') startPlaying();
      else if (action === 'restart') fullReset();
      return; // up/down ignored in ready
    case 'playing':
      if (action === 'up') applyInput('U');
      else if (action === 'down') applyInput('D');
      else if (action === 'restart') fullReset();
      else if (action === 'start') {
        /* ignore start during play */
      }
      return;
    case 'tileClear':
      if (action === 'restart') fullReset();
      return; // overlay-input-leak: up/down/start cannot leak into next tile
    case 'gameover':
      if (action === 'start' || action === 'up' || action === 'down') startPlaying();
      else if (action === 'restart') fullReset();
      return;
    default:
      return;
  }
}

// --- Init ---
function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  livesEl = document.querySelector<HTMLElement>('#lives')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  touchUpBtn = document.querySelector<HTMLButtonElement>('#touch-up')!;
  touchDownBtn = document.querySelector<HTMLButtonElement>('#touch-down')!;

  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    if (k === 'ArrowUp' || k === 'w' || k === 'W' || k === 'z' || k === 'Z') {
      handleInput('up');
      e.preventDefault();
    } else if (k === 'ArrowDown' || k === 's' || k === 'S' || k === 'x' || k === 'X') {
      handleInput('down');
      e.preventDefault();
    } else if (k === ' ' || k === 'Enter') {
      handleInput('start');
      e.preventDefault();
    } else if (k === 'r' || k === 'R') {
      handleInput('restart');
      e.preventDefault();
    }
  });

  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const yCanvas = ((e.clientY - rect.top) / rect.height) * CANVAS_H;
    if (state === 'ready' || state === 'gameover') {
      handleInput('start');
      return;
    }
    if (state !== 'playing') return;
    if (yCanvas < CANVAS_H / 2) handleInput('up');
    else handleInput('down');
  });

  touchUpBtn.addEventListener('click', (e) => {
    e.preventDefault();
    if (state === 'ready' || state === 'gameover') handleInput('start');
    else handleInput('up');
  });
  touchDownBtn.addEventListener('click', (e) => {
    e.preventDefault();
    if (state === 'ready' || state === 'gameover') handleInput('start');
    else handleInput('down');
  });

  restartBtn.addEventListener('click', () => handleInput('restart'));

  best = loadBest();
  fullReset();
  requestAnimationFrame(loop);
}

export const game = defineGame({ init, reset: fullReset });
