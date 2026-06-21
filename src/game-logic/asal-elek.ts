import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay, hideOverlay, isOverlayHidden } from '@shared/overlay';

// Asal Elek — sayılar düşer; bileşikleri yakala, asallar süzgeçten geçsin.
//
// PITFALLS guarded here (see docs/PITFALLS.md):
// - unguarded-storage: best score via safeRead/safeWrite.
// - module-level-dom-access: all DOM/storage access in init().
// - stale-async-callback: RAF loop reads gen token & state, short-circuits
//   when reset()/startGame() bumps. No setTimeout to dangle.
// - overlay-input-leak: explicit State enum; pointer + key handlers guard at
//   the top. Overlay reuses .overlay--hidden class so getComputedStyle drops
//   pointer-events when hidden.
// - invisible-boot: first tile appears at FIRST_SPAWN_MS (200ms) after Start.
// - visual-vs-hitbox: TILE_R is the single radius for ctx.arc() AND for the
//   pointer hit-test distance check.
// - missing-overlay-css: per-game CSS defines .overlay/.overlay--hidden.
// - hud-counter-synced-only-at-lifecycle-edges: renderHud() is called every
//   time score/lives/primes change, not only on start/end.
// - cap-counts-dead-entities: tiles are spliced on catch/fall, so the live
//   array length equals active count; no zombies linger in the cap check.
// - designed-lose-condition-not-wired: composite reaching the bottom
//   explicitly costs a life — sieve leak is a designed lose condition.

// ---------- Constants ----------

const STORAGE_BEST = 'asal-elek.best';

const COLS = 5;
const BOARD_W = 400;
const BOARD_H = 560;
const COL_W = BOARD_W / COLS;
const TILE_R = 28; // visual + hitbox radius
const HEADER_H = 56; // banner zone; tiles slide under it as they spawn
const FLOOR_Y = BOARD_H - 28; // y at which a tile is considered "fallen through"

const STARTING_LIVES = 3;
const BASE_FALL_PX_S = 70; // pixels/sec
const BASE_SPAWN_MS = 950;
const MIN_SPAWN_MS = 360;
const MIN_TILE_GAP = 92; // min vertical spacing inside a column at spawn

const FIRST_SPAWN_MS = 200; // first visible tile fast (invisible-boot guard)
const FLASH_MS = 320;

// Composite-bias: keep primes rare-ish so the round has rhythm.
// Players win by catching composites; too many primes makes it spammy.
const PRIME_RATIO = 0.32;

// Value range scales gently with score so easy primes (2,3,5,7) stay common
// at the start and bigger composites enter later.
function valueRange(): { min: number; max: number } {
  if (score < 5) return { min: 2, max: 20 };
  if (score < 15) return { min: 2, max: 40 };
  if (score < 30) return { min: 2, max: 70 };
  return { min: 2, max: 99 };
}

// ---------- Types ----------

type GameState = 'ready' | 'playing' | 'gameover';

interface Tile {
  id: number;
  col: number; // 0..COLS-1
  x: number;
  y: number;
  value: number; // >= 2
  isPrime: boolean;
  vy: number; // px/sec
}

type FlashKind = 'good' | 'bad';
interface Flash {
  kind: FlashKind;
  until: number;
}

// ---------- State ----------

const gen = createGenToken();
let state: GameState = 'ready';
let score = 0; // composites correctly filtered
let primesPassed = 0; // primes correctly allowed to fall through
let lives = STARTING_LIVES;
let best = 0;

const tiles: Tile[] = [];
let nextTileId = 1;
let lastSpawn = 0;
let lastFrame = 0;
let flash: Flash | null = null;

// ---------- DOM refs ----------

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let primesEl!: HTMLElement;
let livesEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let startBtn!: HTMLButtonElement;

// ---------- Number theory helpers ----------

function isPrime(n: number): boolean {
  if (n < 2) return false;
  if (n < 4) return true; // 2, 3
  if (n % 2 === 0) return false;
  const limit = Math.floor(Math.sqrt(n));
  for (let d = 3; d <= limit; d += 2) {
    if (n % d === 0) return false;
  }
  return true;
}

// ---------- HUD ----------

function renderHud(): void {
  scoreEl.textContent = String(score);
  primesEl.textContent = String(primesPassed);
  livesEl.textContent = String(lives);
  bestEl.textContent = String(best);
}

// ---------- Difficulty ----------

function fallSpeed(): number {
  // +4% per score, capped at ~3x base.
  const mult = Math.min(3, 1 + score * 0.04);
  return BASE_FALL_PX_S * mult;
}

function spawnInterval(): number {
  const mult = Math.max(0.4, 1 - score * 0.025);
  return Math.max(MIN_SPAWN_MS, BASE_SPAWN_MS * mult);
}

// ---------- Spawn ----------

function pickValue(): number {
  const { min, max } = valueRange();
  const wantPrime = Math.random() < PRIME_RATIO;
  // Bounded retry — values up to 99 always include both kinds, so this
  // resolves in 1–3 tries on average.
  for (let attempt = 0; attempt < 12; attempt++) {
    const candidate = min + Math.floor(Math.random() * (max - min + 1));
    if (isPrime(candidate) === wantPrime) return candidate;
  }
  // Fallback: return whatever we last drew (rare).
  return min + Math.floor(Math.random() * (max - min + 1));
}

function topYInColumn(col: number): number {
  let top = Infinity;
  for (const t of tiles) {
    if (t.col === col && t.y < top) top = t.y;
  }
  return top;
}

function maybeSpawn(): void {
  const candidates: number[] = [];
  for (let c = 0; c < COLS; c++) {
    if (topYInColumn(c) >= MIN_TILE_GAP) candidates.push(c);
  }
  if (candidates.length === 0) return;
  const col = candidates[Math.floor(Math.random() * candidates.length)]!;
  const value = pickValue();
  tiles.push({
    id: nextTileId++,
    col,
    x: col * COL_W + COL_W / 2,
    y: -TILE_R,
    value,
    isPrime: isPrime(value),
    vy: fallSpeed(),
  });
}

// ---------- Feedback ----------

function flashGood(): void {
  flash = { kind: 'good', until: performance.now() + FLASH_MS };
}
function flashBad(): void {
  flash = { kind: 'bad', until: performance.now() + FLASH_MS };
}

function loseLife(): void {
  lives -= 1;
  flashBad();
  if (lives <= 0) {
    gameOver();
  }
}

// ---------- Tile resolution ----------

function clickTile(t: Tile): void {
  const i = tiles.indexOf(t);
  if (i >= 0) tiles.splice(i, 1);
  if (t.isPrime) {
    // Caught a prime — sieve failed.
    loseLife();
  } else {
    // Caught a composite — sieve win.
    score += 1;
    flashGood();
    if (score > best) {
      best = score;
      safeWrite(STORAGE_BEST, best);
    }
  }
  renderHud();
}

function tileFellThrough(t: Tile): void {
  // Prime falling through is the *goal* of a sieve — count it but no penalty.
  // Composite falling through is a leak — costs a life.
  if (t.isPrime) {
    primesPassed += 1;
  } else {
    loseLife();
  }
  renderHud();
}

// ---------- Game flow ----------

function gameOver(): void {
  state = 'gameover';
  gen.bump();
  overlayTitle.textContent = 'Süzgeç delindi';
  overlayMsg.textContent =
    `Skor: ${score}\nGeçen asal: ${primesPassed}\nRekor: ${best}\n\n` +
    `Tekrar oynamak için Başla'ya bas.`;
  startBtn.textContent = 'Tekrar oyna';
  showOverlay(overlay);
}

// ---------- RAF loop ----------

function loop(myGen: number, now: number): void {
  if (!gen.isCurrent(myGen) || state !== 'playing') return;

  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;

  if (now - lastSpawn >= spawnInterval()) {
    maybeSpawn();
    lastSpawn = now;
  }

  // Move tiles + resolve floor crossings.
  for (let i = tiles.length - 1; i >= 0; i--) {
    const t = tiles[i]!;
    t.y += t.vy * dt;
    if (t.y - TILE_R > FLOOR_Y) {
      tiles.splice(i, 1);
      tileFellThrough(t);
      // gameOver() may have flipped state — bail cleanly next frame.
    }
  }

  draw();
  requestAnimationFrame((n) => loop(myGen, n));
}

// ---------- Drawing ----------

function getCss(varName: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(varName)
    .trim();
  return v || fallback;
}

let cssCache: {
  bg: string;
  border: string;
  text: string;
  textDim: string;
  accent: string;
  good: string;
  bad: string;
  composite: string;
  prime: string;
} | null = null;

function colors() {
  if (cssCache) return cssCache;
  cssCache = {
    bg: getCss('--surface', '#0e1014'),
    border: getCss('--border', '#222'),
    text: getCss('--text', '#fff'),
    textDim: getCss('--text-dim', '#7a8190'),
    accent: getCss('--accent', '#4ea1ff'),
    good: getCss('--success', '#4ade80'),
    bad: getCss('--danger', '#f87171'),
    // Both kinds use the same neutral color until clicked — the player must
    // do the math; revealing primality would defeat the game.
    composite: '#3b6dd6',
    prime: '#3b6dd6',
  };
  return cssCache;
}

function drawTile(t: Tile, c: ReturnType<typeof colors>): void {
  // Visual ring matches TILE_R (visual-vs-hitbox: same constant).
  ctx.beginPath();
  ctx.arc(t.x, t.y, TILE_R, 0, Math.PI * 2);
  ctx.fillStyle = c.composite;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(0,0,0,0.4)';
  ctx.stroke();

  ctx.fillStyle = '#06080c';
  // Use 22-26 font depending on length so 2-digit fits comfortably.
  const fontSize = t.value < 10 ? 26 : t.value < 100 ? 22 : 18;
  ctx.font = `bold ${fontSize}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(t.value), t.x, t.y);
}

function drawSieve(): void {
  // Diagonal hatch zone near the floor — visual cue for "the sieve".
  const top = FLOOR_Y - 6;
  const bot = FLOOR_Y + 4;
  ctx.fillStyle = 'rgba(255,255,255,0.05)';
  ctx.fillRect(0, top, BOARD_W, bot - top);

  ctx.strokeStyle = 'rgba(78, 161, 255, 0.55)';
  ctx.lineWidth = 1.5;
  const spacing = 14;
  for (let x = -bot; x < BOARD_W + bot; x += spacing) {
    ctx.beginPath();
    ctx.moveTo(x, bot);
    ctx.lineTo(x + (bot - top), top);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, FLOOR_Y + 0.5);
  ctx.lineTo(BOARD_W, FLOOR_Y + 0.5);
  ctx.stroke();
}

function draw(): void {
  const c = colors();

  let flashAlpha = 0;
  if (flash && performance.now() < flash.until) {
    flashAlpha = (flash.until - performance.now()) / FLASH_MS;
  } else if (flash) {
    flash = null;
  }

  ctx.fillStyle = c.bg;
  ctx.fillRect(0, 0, BOARD_W, BOARD_H);

  // Column separators (in the playfield only).
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.lineWidth = 1;
  for (let i = 1; i < COLS; i++) {
    ctx.beginPath();
    ctx.moveTo(i * COL_W, HEADER_H);
    ctx.lineTo(i * COL_W, FLOOR_Y);
    ctx.stroke();
  }

  // Column keyboard hints near the floor (above sieve line).
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  for (let i = 0; i < COLS; i++) {
    ctx.fillText(`[${i + 1}]`, i * COL_W + COL_W / 2, FLOOR_Y - 8);
  }

  // Tiles — clipped to area below header so they slide in cleanly.
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, HEADER_H, BOARD_W, FLOOR_Y - HEADER_H + TILE_R + 4);
  ctx.clip();
  for (const t of tiles) drawTile(t, c);
  ctx.restore();

  // Sieve line.
  drawSieve();

  // Header backdrop.
  ctx.fillStyle = c.bg;
  ctx.fillRect(0, 0, BOARD_W, HEADER_H);
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, HEADER_H + 0.5);
  ctx.lineTo(BOARD_W, HEADER_H + 0.5);
  ctx.stroke();

  // Header text.
  ctx.fillStyle = c.text;
  ctx.font = 'bold 14px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('ASAL ELEK', 14, 10);

  ctx.fillStyle = c.textDim;
  ctx.font = '11px system-ui, sans-serif';
  ctx.fillText('Bileşikleri tıkla · Asalları geçir', 14, 30);

  // Lives dots, top-right.
  const dotR = 5;
  const baseX = BOARD_W - 16;
  const baseY = 22;
  for (let i = 0; i < STARTING_LIVES; i++) {
    ctx.beginPath();
    ctx.arc(baseX - i * 16, baseY, dotR, 0, Math.PI * 2);
    ctx.fillStyle = i < lives ? c.bad : 'rgba(255,255,255,0.12)';
    ctx.fill();
  }

  // Feedback flash overlay (covers everything below the header).
  if (flashAlpha > 0 && flash) {
    ctx.fillStyle =
      flash.kind === 'good'
        ? `rgba(74, 222, 128, ${flashAlpha * 0.16})`
        : `rgba(248, 113, 113, ${flashAlpha * 0.22})`;
    ctx.fillRect(0, HEADER_H, BOARD_W, BOARD_H - HEADER_H);
  }
}

// ---------- Input ----------

function tileAtPoint(px: number, py: number): Tile | null {
  // Pick the on-screen tile closest to the pointer within hit radius.
  // Tiles still hiding behind the header don't count.
  let hit: Tile | null = null;
  let bestDist = TILE_R * TILE_R;
  for (const t of tiles) {
    if (t.y < HEADER_H) continue;
    const dx = t.x - px;
    const dy = t.y - py;
    const d2 = dx * dx + dy * dy;
    if (d2 <= bestDist) {
      bestDist = d2;
      hit = t;
    }
  }
  return hit;
}

function onPointerDown(e: PointerEvent): void {
  if (state !== 'playing') return;
  const rect = canvas.getBoundingClientRect();
  const px = ((e.clientX - rect.left) * BOARD_W) / rect.width;
  const py = ((e.clientY - rect.top) * BOARD_H) / rect.height;
  const t = tileAtPoint(px, py);
  if (t) {
    e.preventDefault();
    clickTile(t);
  }
}

function lowestTileInColumn(col: number): Tile | null {
  let pick: Tile | null = null;
  for (const t of tiles) {
    if (t.col !== col) continue;
    if (t.y < HEADER_H) continue;
    if (!pick || t.y > pick.y) pick = t;
  }
  return pick;
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'r' || e.key === 'R') {
    e.preventDefault();
    reset();
    return;
  }
  if (state === 'ready' || state === 'gameover') {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      startGame();
    }
    return;
  }
  // state === 'playing'
  if (e.key >= '1' && e.key <= String(COLS)) {
    const col = Number(e.key) - 1;
    const t = lowestTileInColumn(col);
    if (t) {
      e.preventDefault();
      clickTile(t);
    }
  }
}

// ---------- Lifecycle ----------

function startGame(): void {
  gen.bump();
  hideOverlay(overlay);
  state = 'playing';
  score = 0;
  primesPassed = 0;
  lives = STARTING_LIVES;
  tiles.length = 0;
  flash = null;
  renderHud();
  const myGen = gen.current();
  const now = performance.now();
  lastFrame = now;
  // Position lastSpawn so first spawn occurs FIRST_SPAWN_MS from now,
  // not after a full spawnInterval — invisible-boot guard.
  lastSpawn = now - (spawnInterval() - FIRST_SPAWN_MS);
  draw();
  requestAnimationFrame((n) => loop(myGen, n));
}

function reset(): void {
  gen.bump();
  state = 'ready';
  score = 0;
  primesPassed = 0;
  lives = STARTING_LIVES;
  tiles.length = 0;
  flash = null;
  overlayTitle.textContent = 'Asal Elek';
  overlayMsg.textContent =
    'Sayılar yukarıdan düşer. Bileşik sayılara tıkla, asal sayıları süzgeçten geçir.\n' +
    'Asalı tıklarsan ya da bileşiği kaçırırsan can yanar.';
  startBtn.textContent = 'Başla';
  showOverlay(overlay);
  renderHud();
  draw();
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  primesEl = document.querySelector<HTMLElement>('#primes')!;
  livesEl = document.querySelector<HTMLElement>('#lives')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  startBtn = document.querySelector<HTMLButtonElement>('#start')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  canvas.addEventListener('pointerdown', onPointerDown);
  restartBtn.addEventListener('click', reset);
  startBtn.addEventListener('click', () => {
    if (isOverlayHidden(overlay)) return;
    startGame();
  });
  document.addEventListener('keydown', onKey);

  reset();
}

export const game = defineGame({ init, reset });
