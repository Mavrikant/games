// ---------------------------------------------------------------------------
// Key Fall — Falling letters typing game
// State machine: Ready | Playing | GameOver
// Pitfalls addressed:
//   - stale-async-callback: @shared/gen-token on every reset()
//   - unguarded-storage: @shared/storage helpers
//   - overlay-input-leak: explicit state enum, all input through handleKey()
//   - invisible-boot: overlay shown immediately on init()
//   - visual-vs-hitbox: letter hit zone = same constants for draw and collide
// ---------------------------------------------------------------------------

import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';
import { reportGameOver } from '@shared/leaderboard';

type State = 'ready' | 'playing' | 'gameover';

interface Letter {
  char: string;
  lane: number; // 0-4
  y: number; // canvas pixels from top of game area
  speed: number;
  flash: number; // frames of "hit" flash remaining
  flashType: 'hit' | 'miss';
}

// ── Constants ───────────────────────────────────────────────────────────────
const COLS = 5;
const CANVAS_W = 480;
const CANVAS_H = 480;
const LANE_W = CANVAS_W / COLS; // 96
const LETTER_SIZE = 38;
const LETTER_ZONE_H = LETTER_SIZE * 1.2; // visual cell height (used for spawn Y and hit-ring radius)
const SPAWN_Y = -LETTER_ZONE_H / 2;
const FLOOR_Y = CANVAS_H - 12; // letters that pass this are "missed"
const MAX_LIVES = 3;
const BASE_SPEED = 1.2;
const SPEED_INC = 0.15; // speed gain per level
const LETTERS_PER_LEVEL = 8;
const SPAWN_INTERVAL_FRAMES = 55; // base frames between spawns
const SPAWN_INTERVAL_MIN = 18; // minimum frames (max difficulty)
const STORAGE_KEY = 'key-fall.best';
const SCORE_DESC = { gameId: 'key-fall', storageKey: STORAGE_KEY, direction: 'higher' as const };
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const HIT_FLASH_EXPANSION = 0.8; // ring expansion factor during hit animation

// ── DOM refs (filled in init) ────────────────────────────────────────────────
let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let life1!: HTMLElement;
let life2!: HTMLElement;
let life3!: HTMLElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let restartBtn!: HTMLButtonElement;

// Storage helpers from @shared/storage are used directly below — no
// local shim needed since the values are simple numbers.

// ── CSS var cache ────────────────────────────────────────────────────────────
const cssCache = new Map<string, string>();
function getCss(varName: string): string {
  const cached = cssCache.get(varName);
  if (cached !== undefined) return cached;
  const val = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  cssCache.set(varName, val);
  return val;
}

// ── Game state ───────────────────────────────────────────────────────────────
let state: State = 'ready';
let score = 0;
let best = 0;
let lives = MAX_LIVES;
let level = 1;
let lettersDestroyedThisLevel = 0;
let letters: Letter[] = [];
const frameGen = createGenToken();
let rafId: number | null = null;
let frameCount = 0;
let spawnCountdown = 0;

// ── Lane color palette ───────────────────────────────────────────────────────
const LANE_COLORS = ['#fb7185', '#f59e0b', '#34d399', '#60a5fa', '#c084fc'];

// ── Overlay helpers ──────────────────────────────────────────────────────────
function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.innerHTML = msg;
  showOverlayEl(overlay);
}
function hideOverlay(): void {
  hideOverlayEl(overlay);
}

// ── Lives display ─────────────────────────────────────────────────────────────
function updateLives(): void {
  const lifeEls = [life1, life2, life3];
  for (let i = 0; i < MAX_LIVES; i++) {
    const el = lifeEls[i];
    if (el) el.classList.toggle('life--lost', i >= lives);
  }
}

// ── Spawn logic ──────────────────────────────────────────────────────────────
function randomLane(): number {
  return Math.floor(Math.random() * COLS);
}

function spawnLetter(): void {
  const char = ALPHABET[Math.floor(Math.random() * ALPHABET.length)]!;
  const lane = randomLane();
  const speed = BASE_SPEED + SPEED_INC * (level - 1);
  letters.push({ char, lane, y: SPAWN_Y, speed, flash: 0, flashType: 'hit' });
}

function currentSpawnInterval(): number {
  return Math.max(SPAWN_INTERVAL_MIN, SPAWN_INTERVAL_FRAMES - (level - 1) * 5);
}

// ── Level up ──────────────────────────────────────────────────────────────────
function checkLevelUp(): void {
  if (lettersDestroyedThisLevel >= LETTERS_PER_LEVEL) {
    level++;
    lettersDestroyedThisLevel = 0;
  }
}

// ── Game loop ─────────────────────────────────────────────────────────────────
function gameLoop(token: number): void {
  if (!frameGen.isCurrent(token)) return; // stale callback guard
  if (state !== 'playing') return;

  rafId = requestAnimationFrame(() => gameLoop(token));
  frameCount++;

  // Spawn
  spawnCountdown--;
  if (spawnCountdown <= 0) {
    spawnLetter();
    spawnCountdown = currentSpawnInterval();
  }

  // Move letters
  for (const letter of letters) {
    if (letter.flash > 0) {
      letter.flash--;
    } else {
      letter.y += letter.speed;
    }
  }

  // Check for floor hits (misses)
  const surviving: Letter[] = [];
  for (const letter of letters) {
    if (letter.flash === 0 && letter.y > FLOOR_Y) {
      // missed — this letter reached the bottom
      lives--;
      updateLives();
      letter.flash = 18;
      letter.flashType = 'miss';
      surviving.push(letter); // keep briefly for miss animation
      if (lives <= 0) {
        // end game after brief animation
        surviving.push(...letters.filter((l) => l !== letter));
        // draw final frame then go to gameover after delay
        letters = surviving;
        draw();
        const t = token;
        window.setTimeout(() => {
          if (!frameGen.isCurrent(t)) return;
          endGame();
        }, 400);
        return;
      }
    } else {
      surviving.push(letter);
    }
  }
  // Remove fully-flashed-out miss animations
  letters = surviving.filter((l) => !(l.flashType === 'miss' && l.flash === 0));

  draw();
}

// ── Draw ──────────────────────────────────────────────────────────────────────
function draw(): void {
  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

  // Background
  ctx.fillStyle = getCss('--surface');
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  // Lane dividers
  ctx.strokeStyle = getCss('--border');
  ctx.lineWidth = 1;
  for (let i = 1; i < COLS; i++) {
    ctx.beginPath();
    ctx.moveTo(i * LANE_W, 0);
    ctx.lineTo(i * LANE_W, CANVAS_H);
    ctx.stroke();
  }

  // Floor line
  ctx.strokeStyle = getCss('--border');
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, FLOOR_Y);
  ctx.lineTo(CANVAS_W, FLOOR_Y);
  ctx.stroke();

  // Lane color top strips
  for (let i = 0; i < COLS; i++) {
    ctx.fillStyle = (LANE_COLORS[i] ?? '#888') + '33'; // 20% alpha
    ctx.fillRect(i * LANE_W + 1, 0, LANE_W - 2, 6);
  }

  // Letters — SAME LETTER_ZONE_H constant for both draw and collide
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `bold ${LETTER_SIZE}px monospace`;

  for (const letter of letters) {
    const cx = letter.lane * LANE_W + LANE_W / 2;
    const cy = letter.y;
    const color = LANE_COLORS[letter.lane] ?? '#888';

    if (letter.flash > 0) {
      if (letter.flashType === 'hit') {
        // Hit flash: expanding bright ring
        const alpha = letter.flash / 18;
        const radius = LETTER_ZONE_H * 0.5 * (1 + (1 - alpha) * HIT_FLASH_EXPANSION);
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = alpha * 0.6;
        ctx.fillStyle = color;
        ctx.fillText(letter.char, cx, cy);
        ctx.restore();
      } else {
        // Miss flash: red tint, letter shaking
        const alpha = letter.flash / 18;
        ctx.save();
        ctx.globalAlpha = alpha;
        const shake = (Math.random() - 0.5) * 4;
        ctx.fillStyle = '#ef4444';
        ctx.fillText(letter.char, cx + shake, cy);
        ctx.restore();
      }
    } else {
      // Normal: glow effect
      ctx.save();
      ctx.shadowColor = color;
      ctx.shadowBlur = 12;
      ctx.fillStyle = color;
      ctx.fillText(letter.char, cx, cy);
      ctx.restore();
    }
  }

  // Level indicator (bottom right)
  ctx.save();
  ctx.font = '11px monospace';
  ctx.fillStyle = getCss('--text-dim') || '#666';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.fillText(`Seviye ${level}`, CANVAS_W - 10, CANVAS_H - 4);
  ctx.restore();
}

// ── Keyboard handler ──────────────────────────────────────────────────────────
function handleKey(e: KeyboardEvent): void {
  const key = e.key.toUpperCase();

  if (state === 'ready') {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      startGame();
    }
    return;
  }

  if (state === 'gameover') {
    if (e.key === 'r' || e.key === 'R' || e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      reset();
    }
    return;
  }

  // state === 'playing'
  if (e.key === 'r' || e.key === 'R') {
    e.preventDefault();
    reset();
    return;
  }

  if (key.length === 1 && ALPHABET.includes(key)) {
    e.preventDefault();
    tryHit(key);
  }
}

function tryHit(key: string): void {
  if (state !== 'playing') return;

  // Find the lowest matching letter (most urgent to type)
  let bestIdx = -1;
  let bestY = -Infinity;

  for (let i = 0; i < letters.length; i++) {
    const l = letters[i]!;
    if (l.char === key && l.flash === 0 && l.y > bestY) {
      bestY = l.y;
      bestIdx = i;
    }
  }

  if (bestIdx === -1) return; // no matching letter visible

  const hit = letters[bestIdx]!;
  hit.flash = 18;
  hit.flashType = 'hit';

  score++;
  lettersDestroyedThisLevel++;
  scoreEl.textContent = String(score);

  if (score > best) {
    best = score;
    bestEl.textContent = String(best);
    safeWrite(STORAGE_KEY, best);
  }

  checkLevelUp();
}

// ── Game flow ─────────────────────────────────────────────────────────────────
function startGame(): void {
  state = 'playing';
  hideOverlay();
  // First letter spawns immediately for quick feedback (< 250ms)
  spawnLetter();
  spawnCountdown = currentSpawnInterval();

  const token = frameGen.current();
  rafId = requestAnimationFrame(() => gameLoop(token));
}

function endGame(): void {
  state = 'gameover';
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  reportGameOver(SCORE_DESC, score);
  showOverlay('Bitti!', `Skor: ${score}<br><small>Boşluk veya R ile yeniden başla</small>`);
}

function reset(): void {
  // Bump generation token — invalidates any stale setTimeout/rAF callbacks
  frameGen.bump();

  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }

  state = 'ready';
  score = 0;
  lives = MAX_LIVES;
  level = 1;
  lettersDestroyedThisLevel = 0;
  letters = [];
  frameCount = 0;
  spawnCountdown = currentSpawnInterval();

  best = safeRead(STORAGE_KEY, 0);

  scoreEl.textContent = '0';
  bestEl.textContent = String(best);
  updateLives();
  draw();
  showOverlay('Key Fall', 'Düşen harflere klavyeden bas.<br>Başlamak için boşluk tuşuna bas.');
}

// ── Init ──────────────────────────────────────────────────────────────────────
function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  life1 = document.querySelector<HTMLElement>('#life-1')!;
  life2 = document.querySelector<HTMLElement>('#life-2')!;
  life3 = document.querySelector<HTMLElement>('#life-3')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;

  window.addEventListener('keydown', handleKey);
  restartBtn.addEventListener('click', () => {
    reset();
  });

  reset();
}

export const game = defineGame({ init, reset });
