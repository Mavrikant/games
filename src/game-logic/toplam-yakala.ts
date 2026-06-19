import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay, hideOverlay, isOverlayHidden } from '@shared/overlay';

// Toplam Yakala — düşen sayıları seçip sepeti hedefe tam ulaştır.
//
// PITFALLS guarded here (see docs/PITFALLS.md):
// - unguarded-storage: best score via safeRead/safeWrite.
// - module-level-dom-access: all DOM/storage access in init().
// - stale-async-callback: the RAF loop reads `state` & `genId` and short-
//   circuits when reset() bumps the token. spawn interval is RAF-driven
//   so no setTimeout to dangle.
// - overlay-input-leak: explicit State enum; pointer/key handlers guard
//   on state at the top. Overlay-eaten pointer events: overlay itself
//   only contains the Start button — clicks outside reach canvas.
// - invisible-boot: first tile appears within 250ms of pressing Start
//   (FIRST_SPAWN_MS = 200). HUD updates synchronously.
// - visual-vs-hitbox: TILE_R is the single source for both ctx.arc()
//   drawing AND pointer-distance hit test.
// - missing-overlay-css: per-game CSS defines .overlay--hidden.

// ---------- Constants ----------

const STORAGE_BEST = 'toplam-yakala.best';

const COLS = 4;
const BOARD_W = 360;
const BOARD_H = 540;
const COL_W = BOARD_W / COLS;
const TILE_R = 30; // visual + hitbox radius
const HEADER_H = 96; // target banner + basket-bar zone; tiles hide behind it

const STARTING_LIVES = 3;
const BASE_FALL_PX_S = 70; // pixels per second
const BASE_SPAWN_MS = 1200;
const MIN_SPAWN_MS = 380;
const MIN_TILE_GAP = 90; // vertical gap inside a column at spawn time

const FIRST_SPAWN_MS = 200; // first tile appears fast (invisible-boot)
const FLASH_MS = 360;

// ---------- Types ----------

type State = 'ready' | 'playing' | 'gameover';

interface Tile {
  id: number;
  col: number; // 0..COLS-1
  x: number; // center
  y: number; // center
  value: number; // -3..-1 or 1..9
  vy: number; // pixels per second
}

type FlashKind = 'good' | 'bad';
interface Flash {
  kind: FlashKind;
  until: number; // timestamp ms
}

// ---------- State ----------

const gen = createGenToken();
let state: State = 'ready';
let score = 0;
let lives = STARTING_LIVES;
let best = 0;
let target = 0;
let basket = 0;

const tiles: Tile[] = [];
let nextTileId = 1;
let lastSpawn = 0; // performance.now()
let lastFrame = 0;
let flash: Flash | null = null;

// ---------- DOM refs ----------

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let targetEl!: HTMLElement;
let basketEl!: HTMLElement;
let livesEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let startBtn!: HTMLButtonElement;

// ---------- HUD ----------

function renderHud(): void {
  scoreEl.textContent = String(score);
  targetEl.textContent = state === 'ready' ? '—' : String(target);
  basketEl.textContent = String(basket);
  livesEl.textContent = String(lives);
  bestEl.textContent = String(best);
}

// ---------- Difficulty ----------

function fallSpeed(): number {
  // +5% per score, capped at 3x base.
  const mult = Math.min(3, 1 + score * 0.05);
  return BASE_FALL_PX_S * mult;
}

function spawnInterval(): number {
  // Faster spawns as score grows.
  const mult = Math.max(0.4, 1 - score * 0.03);
  return Math.max(MIN_SPAWN_MS, BASE_SPAWN_MS * mult);
}

function negativeChance(): number {
  if (score < 6) return 0;
  return Math.min(0.28, 0.08 + (score - 6) * 0.02);
}

function targetRange(): { min: number; max: number } {
  if (score < 4) return { min: 4, max: 9 };
  if (score < 10) return { min: 5, max: 14 };
  if (score < 20) return { min: 6, max: 20 };
  return { min: 8, max: 25 };
}

// ---------- Game flow ----------

function pickTarget(): number {
  const { min, max } = targetRange();
  return min + Math.floor(Math.random() * (max - min + 1));
}

function pickTileValue(): number {
  if (Math.random() < negativeChance()) {
    return -(1 + Math.floor(Math.random() * 3)); // -1, -2, -3
  }
  return 1 + Math.floor(Math.random() * 9); // 1..9
}

function topYInColumn(col: number): number {
  let top = Infinity;
  for (const t of tiles) {
    if (t.col === col && t.y < top) top = t.y;
  }
  return top;
}

function maybeSpawn(): void {
  // Pick a column that has enough vertical space at the top.
  const candidates: number[] = [];
  for (let c = 0; c < COLS; c++) {
    if (topYInColumn(c) >= MIN_TILE_GAP) candidates.push(c);
  }
  if (candidates.length === 0) return;
  const col = candidates[Math.floor(Math.random() * candidates.length)]!;
  tiles.push({
    id: nextTileId++,
    col,
    x: col * COL_W + COL_W / 2,
    y: -TILE_R,
    value: pickTileValue(),
    vy: fallSpeed(),
  });
}

function flashGood(): void {
  flash = { kind: 'good', until: performance.now() + FLASH_MS };
}
function flashBad(): void {
  flash = { kind: 'bad', until: performance.now() + FLASH_MS };
}

function catchTile(t: Tile): void {
  // Pop the tile out of the array, apply to basket.
  const i = tiles.indexOf(t);
  if (i >= 0) tiles.splice(i, 1);
  basket += t.value;
  evaluateBasket();
  renderHud();
}

function evaluateBasket(): void {
  if (basket === target) {
    score += 1;
    basket = 0;
    target = pickTarget();
    flashGood();
    if (score > best) {
      best = score;
      safeWrite(STORAGE_BEST, best);
    }
  } else if (basket > target) {
    lives -= 1;
    basket = 0;
    flashBad();
    if (lives <= 0) {
      gameOver();
    }
  }
  // basket < target: nothing yet; keep playing.
}

function gameOver(): void {
  state = 'gameover';
  gen.bump();
  overlayTitle.textContent = 'Bitti!';
  overlayMsg.textContent =
    `Skor: ${score}\nRekor: ${best}\n\nTekrar oynamak için Başla'ya bas.`;
  startBtn.textContent = 'Tekrar oyna';
  showOverlay(overlay);
}

// ---------- RAF loop ----------

function loop(myGen: number, now: number): void {
  if (!gen.isCurrent(myGen) || state !== 'playing') return;

  const dt = Math.min(0.05, (now - lastFrame) / 1000); // clamp big jumps
  lastFrame = now;

  // Spawn
  if (now - lastSpawn >= spawnInterval()) {
    maybeSpawn();
    lastSpawn = now;
  }

  // Move tiles
  for (let i = tiles.length - 1; i >= 0; i--) {
    const t = tiles[i]!;
    t.y += t.vy * dt;
    if (t.y - TILE_R > BOARD_H) {
      tiles.splice(i, 1);
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
  accent: string;
  good: string;
  bad: string;
  neg: string;
  pos: string;
} | null = null;

function colors() {
  if (cssCache) return cssCache;
  cssCache = {
    bg: getCss('--surface', '#0e1014'),
    border: getCss('--border', '#222'),
    text: getCss('--text', '#fff'),
    accent: getCss('--accent', '#4ea1ff'),
    good: getCss('--success', '#4ade80'),
    bad: getCss('--danger', '#f87171'),
    neg: '#e76a52',
    pos: '#4ea1ff',
  };
  return cssCache;
}

function drawTile(t: Tile, c: ReturnType<typeof colors>): void {
  const isNeg = t.value < 0;
  ctx.beginPath();
  ctx.arc(t.x, t.y, TILE_R, 0, Math.PI * 2);
  ctx.fillStyle = isNeg ? c.neg : c.pos;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.stroke();

  ctx.fillStyle = '#06080c';
  ctx.font = 'bold 26px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(t.value), t.x, t.y);
}

function draw(): void {
  const c = colors();

  // Background flash for feedback (good/bad).
  let flashAlpha = 0;
  if (flash && performance.now() < flash.until) {
    const remaining = flash.until - performance.now();
    flashAlpha = remaining / FLASH_MS;
  } else if (flash) {
    flash = null;
  }

  ctx.fillStyle = c.bg;
  ctx.fillRect(0, 0, BOARD_W, BOARD_H);

  // Column separators (only in playfield, below header).
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  for (let i = 1; i < COLS; i++) {
    ctx.beginPath();
    ctx.moveTo(i * COL_W, HEADER_H);
    ctx.lineTo(i * COL_W, BOARD_H);
    ctx.stroke();
  }

  // Column keyboard hints at bottom.
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.font = '12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  for (let i = 0; i < COLS; i++) {
    ctx.fillText(`[${i + 1}]`, i * COL_W + COL_W / 2, BOARD_H - 4);
  }

  // Tiles — drawn before header so they slide under it as they enter.
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, HEADER_H, BOARD_W, BOARD_H - HEADER_H);
  ctx.clip();
  for (const t of tiles) drawTile(t, c);
  ctx.restore();

  // Header backdrop (covers tiles above HEADER_H).
  ctx.fillStyle = c.bg;
  ctx.fillRect(0, 0, BOARD_W, HEADER_H);
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, HEADER_H + 0.5);
  ctx.lineTo(BOARD_W, HEADER_H + 0.5);
  ctx.stroke();

  // Target banner.
  ctx.fillStyle = 'rgba(255,255,255,0.05)';
  ctx.fillRect(0, 0, BOARD_W, 50);
  ctx.fillStyle = c.text;
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText('HEDEF', BOARD_W / 2, 6);
  ctx.font = 'bold 26px system-ui, sans-serif';
  ctx.fillText(String(target), BOARD_W / 2, 18);

  // Basket progress bar.
  const bx = 14;
  const by = 58;
  const bw = BOARD_W - 28;
  const bh = 12;
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  ctx.fillRect(bx, by, bw, bh);
  const pct = target > 0 ? Math.max(-0.2, Math.min(1.05, basket / target)) : 0;
  const fillW = bw * Math.max(0, pct);
  ctx.fillStyle = pct >= 1 ? c.good : pct < 0 ? c.neg : c.accent;
  ctx.fillRect(bx, by, fillW, bh);
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 1;
  ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
  ctx.fillStyle = c.text;
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(`Sepet: ${basket}`, bx + 2, by + bh + 10);
  ctx.textAlign = 'right';
  ctx.fillText(
    basket < target
      ? `Eksik: ${target - basket}`
      : basket === target
        ? 'Tam!'
        : `Aşım: ${basket - target}`,
    bx + bw - 2,
    by + bh + 10,
  );

  // Feedback flash overlay (covers everything).
  if (flashAlpha > 0 && flash) {
    ctx.fillStyle =
      flash.kind === 'good'
        ? `rgba(74, 222, 128, ${flashAlpha * 0.18})`
        : `rgba(248, 113, 113, ${flashAlpha * 0.22})`;
    ctx.fillRect(0, 0, BOARD_W, BOARD_H);
  }
}

// ---------- Input ----------

function tileAtPoint(px: number, py: number): Tile | null {
  // Find lowest-on-screen tile within hit radius, ignoring tiles still
  // hiding behind the header.
  let hit: Tile | null = null;
  for (const t of tiles) {
    if (t.y < HEADER_H) continue;
    const dx = t.x - px;
    const dy = t.y - py;
    if (dx * dx + dy * dy <= TILE_R * TILE_R) {
      if (!hit || t.y > hit.y) hit = t;
    }
  }
  return hit;
}

function onPointerDown(e: PointerEvent): void {
  if (state !== 'playing') return;
  // Map pointer to canvas internal coords (canvas may be CSS-scaled).
  const rect = canvas.getBoundingClientRect();
  const px = ((e.clientX - rect.left) * BOARD_W) / rect.width;
  const py = ((e.clientY - rect.top) * BOARD_H) / rect.height;
  const t = tileAtPoint(px, py);
  if (t) {
    e.preventDefault();
    catchTile(t);
  }
}

function lowestTileInColumn(col: number): Tile | null {
  let pick: Tile | null = null;
  for (const t of tiles) {
    if (t.col !== col) continue;
    if (t.y < HEADER_H) continue; // still behind the header
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
      catchTile(t);
    }
  }
}

// ---------- Lifecycle ----------

function startGame(): void {
  gen.bump();
  hideOverlay(overlay);
  state = 'playing';
  score = 0;
  lives = STARTING_LIVES;
  basket = 0;
  target = pickTarget();
  tiles.length = 0;
  flash = null;
  renderHud();
  // First spawn delayed slightly so user gets visible-board frame first.
  const myGen = gen.current();
  const now = performance.now();
  lastFrame = now;
  lastSpawn = now - (spawnInterval() - FIRST_SPAWN_MS);
  // One quick visible draw before the loop kicks in.
  draw();
  requestAnimationFrame((n) => loop(myGen, n));
}

function reset(): void {
  gen.bump();
  state = 'ready';
  score = 0;
  lives = STARTING_LIVES;
  basket = 0;
  target = 0;
  tiles.length = 0;
  flash = null;
  overlayTitle.textContent = 'Toplam Yakala';
  overlayMsg.textContent =
    "Düşen sayıları tıkla. Sepetin hedefe eşit olunca puan. Aşarsan can gider; negatifle aşımı toparla.";
  startBtn.textContent = 'Başla';
  showOverlay(overlay);
  renderHud();
  // Draw a single empty frame so the canvas isn't black before Start.
  draw();
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  targetEl = document.querySelector<HTMLElement>('#target')!;
  basketEl = document.querySelector<HTMLElement>('#basket')!;
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
    // Guard against accidental double-fire when key Enter triggers click.
    if (isOverlayHidden(overlay)) return;
    startGame();
  });
  document.addEventListener('keydown', onKey);

  reset();
}

export const game = defineGame({ init, reset });
