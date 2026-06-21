// ---------------------------------------------------------------------------
// Yosun — slow-tempo strategic gardening on a 6x6 grid.
// State machine: Ready | Playing | GameOver
// Pitfalls addressed:
//   - unguarded-storage: safeRead/safeWrite via @shared/storage.
//   - stale-async-callback: a single setInterval is owned and cleared on
//     every reset(); per-cell click cooldowns are tied to performance.now()
//     so stale timeouts cannot mutate state.
//   - overlay-input-leak: explicit state enum; all input handlers early-out
//     when state !== 'playing'.
//   - missing-overlay-css: per-game CSS defines .overlay + .overlay--hidden.
//   - module-level side effects: all DOM access lives in init(); defineGame
//     invokes init() after the body markup is parsed.
//   - hud-counter-synced-only-at-lifecycle-edges: HUD writes happen inside
//     the same tick that mutates score/alive/dead, never deferred to game end.
//   - designed-lose-condition-not-wired: dead cells *do* end the game once
//     the dead-count threshold is crossed; ignoring dying moss is punished.
// ---------------------------------------------------------------------------

import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';
import { reportGameOver } from '@shared/leaderboard';

type Phase = 'ready' | 'playing' | 'gameover';
type CellState = 'empty' | 'moss' | 'dead';

interface Cell {
  state: CellState;
  moisture: number;
  lastWaterAt: number;
  el: HTMLButtonElement;
}

// ── Constants ───────────────────────────────────────────────────────────────
const COLS = 6;
const ROWS = 6;
const TOTAL = COLS * ROWS;
const ROUND_SECONDS = 60;
const TICK_MS = 350;                  // ~2.85 game ticks per second
const MOISTURE_DECAY_PER_TICK = 1;    // ≈ 2.85 / sec
const SPREAD_THRESHOLD = 25;          // neighbour moisture floor for spread
const SPREAD_CHANCE = 0.11;           // per healthy moss, per tick
const WATER_AMOUNT = 30;
const WATER_CAP = 100;
const WATER_COOLDOWN_MS = 600;
const DEAD_LIMIT = 6;                 // game over when this many cells die

const SCORE_PER_LIVE = 10;
const SCORE_PER_DEAD = -15;

const STORAGE_KEY = 'yosun.best';
const SCORE_DESC = {
  gameId: 'yosun',
  storageKey: STORAGE_KEY,
  direction: 'higher' as const,
};

// ── DOM refs ────────────────────────────────────────────────────────────────
let boardEl!: HTMLDivElement;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let timeEl!: HTMLElement;
let aliveEl!: HTMLElement;
let deadEl!: HTMLElement;
let coverageEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayBtn!: HTMLButtonElement;

// ── Game state ──────────────────────────────────────────────────────────────
let phase: Phase = 'ready';
let cells: Cell[] = [];
let score = 0;
let best = 0;
let timeLeft = ROUND_SECONDS;
let aliveCount = 0;
let deadCount = 0;
let tickHandle: number | null = null;
let secondHandle: number | null = null;

// ── Helpers ─────────────────────────────────────────────────────────────────
function idx(x: number, y: number): number {
  return y * COLS + x;
}

function neighbours(i: number): number[] {
  const x = i % COLS;
  const y = (i - x) / COLS;
  const out: number[] = [];
  if (x > 0) out.push(idx(x - 1, y));
  if (x < COLS - 1) out.push(idx(x + 1, y));
  if (y > 0) out.push(idx(x, y - 1));
  if (y < ROWS - 1) out.push(idx(x, y + 1));
  return out;
}

function applyCellVisual(cell: Cell): void {
  const m = Math.max(0, Math.min(100, cell.moisture));
  const m01 = m / 100;
  cell.el.dataset.state = cell.state;
  // Continuous moisture intensity drives CSS variable so colour shifts
  // smoothly without re-flipping classes.
  cell.el.style.setProperty('--ys-m', m01.toFixed(3));
  // Warn class for moss that's close to dying (visual nudge to act).
  if (cell.state === 'moss' && m < 20) cell.el.classList.add('is-warn');
  else cell.el.classList.remove('is-warn');
}

function setScore(value: number): void {
  score = value;
  scoreEl.textContent = String(score);
  if (score > best) {
    best = score;
    bestEl.textContent = String(best);
    safeWrite(STORAGE_KEY, best);
  }
}

function refreshMeters(): void {
  aliveEl.textContent = String(aliveCount);
  deadEl.textContent = String(deadCount);
  const pct = Math.round((aliveCount / TOTAL) * 100);
  coverageEl.textContent = `${pct}%`;
}

function recomputeScoreFromBoard(): void {
  setScore(aliveCount * SCORE_PER_LIVE + deadCount * SCORE_PER_DEAD);
}

// ── Board build ─────────────────────────────────────────────────────────────
function buildBoard(): void {
  boardEl.innerHTML = '';
  boardEl.style.setProperty('--ys-cols', String(COLS));
  cells = [];
  for (let i = 0; i < TOTAL; i++) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ys-cell';
    btn.setAttribute('role', 'gridcell');
    btn.setAttribute('aria-label', `Hücre ${i + 1}`);
    const cell: Cell = {
      state: 'empty',
      moisture: 0,
      lastWaterAt: 0,
      el: btn,
    };
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      onCellTap(i);
    });
    boardEl.appendChild(btn);
    cells.push(cell);
  }
}

function seedBoard(): void {
  // Reset every cell to a baseline barren state with mid moisture.
  for (const cell of cells) {
    cell.state = 'empty';
    cell.moisture = 45;
    cell.lastWaterAt = 0;
    cell.el.classList.remove('is-warn', 'is-splash');
  }
  // Two starter moss tiles near the centre, well-watered so they can
  // actually do something on the first tick (avoids invisible-boot vibe).
  const seeds = [idx(2, 2), idx(3, 3)];
  for (const i of seeds) {
    const cell = cells[i]!;
    cell.state = 'moss';
    cell.moisture = 85;
  }
  aliveCount = seeds.length;
  deadCount = 0;
  for (const cell of cells) applyCellVisual(cell);
  refreshMeters();
  recomputeScoreFromBoard();
}

// ── Input ───────────────────────────────────────────────────────────────────
function onCellTap(i: number): void {
  if (phase !== 'playing') return;
  const cell = cells[i];
  if (!cell) return;
  if (cell.state === 'dead') return;
  const now = performance.now();
  if (now - cell.lastWaterAt < WATER_COOLDOWN_MS) return;
  cell.lastWaterAt = now;
  cell.moisture = Math.min(WATER_CAP, cell.moisture + WATER_AMOUNT);
  // Splash feedback — short flash, doesn't block input.
  cell.el.classList.remove('is-splash');
  void cell.el.offsetHeight; // restart CSS animation
  cell.el.classList.add('is-splash');
  applyCellVisual(cell);
}

// ── Tick ────────────────────────────────────────────────────────────────────
function gameTick(): void {
  if (phase !== 'playing') return;

  // 1) Moisture decay for every cell, including dead (dead are inert visually
  //    but we keep them at 0 so the colour stays steady).
  for (const cell of cells) {
    if (cell.state === 'dead') {
      cell.moisture = 0;
      continue;
    }
    cell.moisture -= MOISTURE_DECAY_PER_TICK;
    if (cell.moisture < 0) cell.moisture = 0;
  }

  // 2) Death pass: any moss whose moisture hit 0 becomes permanently dead.
  let newlyDead = 0;
  for (const cell of cells) {
    if (cell.state === 'moss' && cell.moisture <= 0) {
      cell.state = 'dead';
      newlyDead++;
    }
  }
  if (newlyDead > 0) {
    aliveCount -= newlyDead;
    deadCount += newlyDead;
  }

  // 3) Spread pass: each living moss may seed a wet-enough empty neighbour.
  //    Snapshot which indices were moss BEFORE this pass so freshly-spread
  //    sprouts don't immediately spread again in the same tick (would feel
  //    like a wildfire and trivialise the strategy).
  const sourceIndices: number[] = [];
  for (let i = 0; i < cells.length; i++) {
    if (cells[i]!.state === 'moss') sourceIndices.push(i);
  }
  let newlyAlive = 0;
  for (const i of sourceIndices) {
    if (Math.random() >= SPREAD_CHANCE) continue;
    const ns = neighbours(i);
    // Pick a single random eligible neighbour. Keeps spread feeling steady
    // rather than explosive in clusters with many neighbours.
    const candidates = ns.filter((j) => {
      const c = cells[j]!;
      return c.state === 'empty' && c.moisture > SPREAD_THRESHOLD;
    });
    if (candidates.length === 0) continue;
    const pick = candidates[Math.floor(Math.random() * candidates.length)]!;
    const target = cells[pick]!;
    target.state = 'moss';
    newlyAlive++;
  }
  if (newlyAlive > 0) aliveCount += newlyAlive;

  // 4) Visual refresh — only cells whose state or moisture changed need it,
  //    but the cost of a full pass over 36 cells is negligible.
  for (const cell of cells) applyCellVisual(cell);

  refreshMeters();
  recomputeScoreFromBoard();

  // 5) Lose conditions
  if (deadCount >= DEAD_LIMIT) {
    endGame('Çok fazla yosun kurudu.');
    return;
  }
  if (aliveCount === 0) {
    endGame('Bütün yosun kurudu.');
    return;
  }
  // 6) Win condition — full coverage (no empties, no deaths).
  if (aliveCount === TOTAL) {
    // Reward perfect run with a bonus before reporting.
    setScore(aliveCount * SCORE_PER_LIVE + Math.max(0, timeLeft) * 5);
    endGame('Bahçe tamamen yosunla kaplandı!');
    return;
  }
}

// ── Timer ───────────────────────────────────────────────────────────────────
function tickSeconds(): void {
  if (phase !== 'playing') return;
  timeLeft--;
  if (timeLeft < 0) timeLeft = 0;
  timeEl.textContent = String(timeLeft);
  if (timeLeft <= 0) {
    endGame('Süre doldu.');
  }
}

// ── Overlay helpers ─────────────────────────────────────────────────────────
function showOverlay(title: string, msgHtml: string, btnLabel: string): void {
  overlayTitle.textContent = title;
  overlayMsg.innerHTML = msgHtml;
  overlayBtn.textContent = btnLabel;
  showOverlayEl(overlay);
  overlayBtn.focus({ preventScroll: true });
}

function hideOverlay(): void {
  hideOverlayEl(overlay);
}

// ── Lifecycle ───────────────────────────────────────────────────────────────
function clearTimers(): void {
  if (tickHandle !== null) {
    clearInterval(tickHandle);
    tickHandle = null;
  }
  if (secondHandle !== null) {
    clearInterval(secondHandle);
    secondHandle = null;
  }
}

function startGame(): void {
  clearTimers();
  seedBoard();
  timeLeft = ROUND_SECONDS;
  timeEl.textContent = String(timeLeft);
  bestEl.textContent = String(best);
  phase = 'playing';
  hideOverlay();
  tickHandle = window.setInterval(gameTick, TICK_MS);
  secondHandle = window.setInterval(tickSeconds, 1000);
}

function endGame(reason: string): void {
  if (phase === 'gameover') return;
  phase = 'gameover';
  clearTimers();
  // Final visual pass so dying moss flips to dead colour the moment we land
  // on the overlay (no stale "warn yellow" left underneath).
  for (const cell of cells) applyCellVisual(cell);
  reportGameOver(SCORE_DESC, score);
  const msg =
    `${reason}<br>` +
    `Canlı: <strong>${aliveCount}</strong> · ` +
    `Ölü: <strong>${deadCount}</strong><br>` +
    `Skor: <strong>${score}</strong> · En iyi: ${best}<br>` +
    `<small>R veya Tekrar oyna ile yeniden başla</small>`;
  const title = score > 0 && score >= best ? 'Yeni rekor!' : 'Tur bitti';
  showOverlay(title, msg, 'Tekrar oyna');
}

function resetToReady(): void {
  clearTimers();
  seedBoard();
  timeLeft = ROUND_SECONDS;
  timeEl.textContent = String(timeLeft);
  bestEl.textContent = String(best);
  phase = 'ready';
  showOverlay(
    'Yosun',
    'Ortadaki iki yosun lekesini olabildiğince yay. Boş hücrelere tıklayarak nem ekle; ' +
      'kuru komşular yosun kabul etmez. Nemi sıfıra düşen yosun kalıcı çöl olur.<br>' +
      `<small>${DEAD_LIMIT} ölü hücrede oyun biter · 60 saniye</small>`,
    'Başla',
  );
}

// ── Init ────────────────────────────────────────────────────────────────────
function init(): void {
  boardEl = document.querySelector<HTMLDivElement>('#board')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  timeEl = document.querySelector<HTMLElement>('#time')!;
  aliveEl = document.querySelector<HTMLElement>('#alive')!;
  deadEl = document.querySelector<HTMLElement>('#dead')!;
  coverageEl = document.querySelector<HTMLElement>('#coverage')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;

  best = safeRead<number>(STORAGE_KEY, 0);
  if (!Number.isFinite(best) || best < 0) best = 0;

  buildBoard();

  restartBtn.addEventListener('click', startGame);
  overlayBtn.addEventListener('click', startGame);
  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'r') {
      e.preventDefault();
      startGame();
      return;
    }
    if (phase !== 'playing' && (k === ' ' || k === 'enter')) {
      e.preventDefault();
      startGame();
    }
  });

  resetToReady();
}

export const game = defineGame({ init, reset: resetToReady });
