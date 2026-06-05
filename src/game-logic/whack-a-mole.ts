// ---------------------------------------------------------------------------
// Whack-a-Mole — reflex game with gold-mole bonus + bomb hazard twist
// State machine: Ready | Playing | GameOver
// Pitfalls addressed:
//   - stale-async-callback: generation token bumped on every reset()
//   - unguarded-storage: safeRead/safeWrite helpers
//   - overlay-input-leak: explicit state enum; clicks during ready/gameover
//     do NOT mutate gameplay state, only overlay-btn / restart-btn transition
//   - invisible-boot: overlay shown immediately; first mole pops within 250ms
//     of "Başla" press (initial spawn delay = INITIAL_FIRST_SPAWN_MS)
//   - visual-vs-hitbox: the <button class="hole"> is the hit target. The mole
//     sprite inside it is decorative; clicking ANYWHERE in the hole counts.
//     This avoids tiny-sprite missed-tap frustration on mobile.
//   - duplicate-with-shared-layer: controls hint rendered by layout (from JSON)
// ---------------------------------------------------------------------------

import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';
import { recordScore } from '@shared/leaderboard';

type State = 'ready' | 'playing' | 'gameover';
type MoleKind = 'normal' | 'gold' | 'bomb';

interface MoleSlot {
  /** Currently visible critter, if any. */
  kind: MoleKind | null;
  /** Timestamp (ms) when this slot becomes available again. */
  nextEventAt: number;
  /** Timestamp (ms) when this critter should go back down (if not hit). */
  hideAt: number;
  /** Whether the slot is locked because we are mid-animation (bonk/explode). */
  locked: boolean;
  /** Sprite element. */
  spriteEl: HTMLDivElement;
  /** Hole rim element (for popup parent). */
  rimEl: HTMLDivElement;
  /** Wrapper button. */
  buttonEl: HTMLButtonElement;
}

// ── Constants ───────────────────────────────────────────────────────────────
const GRID = 9; // 3 × 3
const ROUND_SECONDS = 60;
const STORAGE_KEY = 'whack-a-mole.bestScore';
const SCORE_DESC = { gameId: 'whack-a-mole', storageKey: STORAGE_KEY, direction: 'higher' as const };

// Show timing
const SHOW_MIN_MS = 800;
const SHOW_MAX_MS = 1500;
const SHOW_MIN_GOLD_MS = 600;
const SHOW_MAX_GOLD_MS = 1000;
const SHOW_MIN_BOMB_MS = 1100;
const SHOW_MAX_BOMB_MS = 1800;

// Spawn cadence — gets faster every DIFFICULTY_STEP_S seconds.
const SPAWN_BASE_MIN_MS = 700;
const SPAWN_BASE_MAX_MS = 1500;
const SPAWN_FLOOR_MIN_MS = 250;
const SPAWN_FLOOR_MAX_MS = 600;
const DIFFICULTY_STEP_S = 10; // every 10s, spawn window shrinks
const DIFFICULTY_SHRINK_RATIO = 0.85; // multiplied per step
const INITIAL_FIRST_SPAWN_MS = 200; // first critter appears fast for "invisible-boot"

// Critter probability — order matters; cumulative.
const P_GOLD = 0.15;
const P_BOMB = 0.1;

// Scoring
const SCORE_NORMAL = 10;
const SCORE_GOLD = 30;
const SCORE_BOMB = -20;

// Animation timings
const BONK_MS = 220;
const EXPLODE_MS = 450;
const POPUP_MS = 700;
const SHAKE_MS = 500;

// ── DOM refs ────────────────────────────────────────────────────────────────
let boardWrap!: HTMLDivElement;
let board!: HTMLDivElement;
let scoreEl!: HTMLElement;
let timeEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayBtn!: HTMLButtonElement;

// ── Safe storage ────────────────────────────────────────────────────────────
// Storage helpers come from @shared/storage; called inline.

// ── Sprites ─────────────────────────────────────────────────────────────────
function moleSvg(): string {
  // Brown mole with face. SVG fills the .mole container (78% of hole width).
  return `
    <svg class="mole__svg" viewBox="0 0 100 100" aria-hidden="true">
      <!-- body -->
      <ellipse cx="50" cy="62" rx="36" ry="32" fill="var(--wm-mole-dark)" />
      <ellipse cx="50" cy="56" rx="34" ry="28" fill="var(--wm-mole)" />
      <!-- belly -->
      <ellipse cx="50" cy="68" rx="20" ry="14" fill="var(--wm-mole-light)" opacity="0.8" />
      <!-- ears -->
      <circle cx="22" cy="40" r="6" fill="var(--wm-mole-dark)" />
      <circle cx="78" cy="40" r="6" fill="var(--wm-mole-dark)" />
      <!-- eyes -->
      <circle cx="38" cy="50" r="4.5" fill="#1a0f08" />
      <circle cx="62" cy="50" r="4.5" fill="#1a0f08" />
      <circle cx="39" cy="48.5" r="1.4" fill="#fff" />
      <circle cx="63" cy="48.5" r="1.4" fill="#fff" />
      <!-- nose -->
      <ellipse cx="50" cy="60" rx="4" ry="3" fill="#1a0f08" />
      <!-- teeth -->
      <rect x="46" y="64" width="3.5" height="5" rx="1" fill="#fff" />
      <rect x="50.5" y="64" width="3.5" height="5" rx="1" fill="#fff" />
      <!-- whiskers -->
      <line x1="28" y1="60" x2="18" y2="58" stroke="#1a0f08" stroke-width="1" />
      <line x1="28" y1="62" x2="18" y2="62" stroke="#1a0f08" stroke-width="1" />
      <line x1="72" y1="60" x2="82" y2="58" stroke="#1a0f08" stroke-width="1" />
      <line x1="72" y1="62" x2="82" y2="62" stroke="#1a0f08" stroke-width="1" />
    </svg>
  `;
}

function goldMoleSvg(): string {
  return `
    <svg class="mole__svg" viewBox="0 0 100 100" aria-hidden="true">
      <defs>
        <radialGradient id="gold-grad" cx="0.5" cy="0.3" r="0.7">
          <stop offset="0%" stop-color="#fde68a" />
          <stop offset="60%" stop-color="var(--wm-gold)" />
          <stop offset="100%" stop-color="var(--wm-gold-dark)" />
        </radialGradient>
      </defs>
      <ellipse cx="50" cy="62" rx="36" ry="32" fill="var(--wm-gold-dark)" />
      <ellipse cx="50" cy="56" rx="34" ry="28" fill="url(#gold-grad)" />
      <ellipse cx="50" cy="68" rx="20" ry="14" fill="#fef3c7" opacity="0.9" />
      <circle cx="22" cy="40" r="6" fill="var(--wm-gold-dark)" />
      <circle cx="78" cy="40" r="6" fill="var(--wm-gold-dark)" />
      <circle cx="38" cy="50" r="4.5" fill="#1a0f08" />
      <circle cx="62" cy="50" r="4.5" fill="#1a0f08" />
      <circle cx="39" cy="48.5" r="1.4" fill="#fff" />
      <circle cx="63" cy="48.5" r="1.4" fill="#fff" />
      <ellipse cx="50" cy="60" rx="4" ry="3" fill="#1a0f08" />
      <rect x="46" y="64" width="3.5" height="5" rx="1" fill="#fff" />
      <rect x="50.5" y="64" width="3.5" height="5" rx="1" fill="#fff" />
      <!-- gold sparkle -->
      <text x="20" y="32" font-size="14" font-weight="700" fill="#fff" opacity="0.85">★</text>
      <text x="74" y="78" font-size="10" font-weight="700" fill="#fff" opacity="0.7">✦</text>
    </svg>
  `;
}

function bombSvg(): string {
  return `
    <svg class="mole__svg" viewBox="0 0 100 100" aria-hidden="true">
      <!-- fuse spark -->
      <circle cx="62" cy="20" r="4" fill="#fef3c7" />
      <circle cx="62" cy="20" r="2.5" fill="#fb923c" />
      <!-- fuse string -->
      <path d="M 62 22 Q 70 30 64 38" stroke="#fb923c" stroke-width="2.5" fill="none" stroke-linecap="round" />
      <!-- body -->
      <circle cx="50" cy="62" r="34" fill="#0a0d12" />
      <circle cx="50" cy="62" r="34" fill="none" stroke="#2a2f3a" stroke-width="2" />
      <!-- shine -->
      <ellipse cx="38" cy="50" rx="8" ry="5" fill="#3a3f4a" opacity="0.6" transform="rotate(-25 38 50)" />
      <!-- cap -->
      <rect x="56" y="34" width="10" height="6" rx="1" fill="#2a2f3a" />
      <!-- skull marker -->
      <circle cx="50" cy="66" r="9" fill="#2a2f3a" opacity="0.4" />
      <text x="50" y="71" font-size="14" text-anchor="middle" fill="#ef4444" font-weight="700">!</text>
    </svg>
  `;
}

function buildSpriteHtml(kind: MoleKind): string {
  switch (kind) {
    case 'normal':
      return moleSvg();
    case 'gold':
      return goldMoleSvg();
    case 'bomb':
      return bombSvg();
  }
}

// ── Game state ──────────────────────────────────────────────────────────────
let state: State = 'ready';
let score = 0;
let best = 0;
let timeLeft = ROUND_SECONDS;
let slots: MoleSlot[] = [];
let token = 0; // generation token — bumped every reset()
let timeoutIds: number[] = [];

// ── Helpers ─────────────────────────────────────────────────────────────────
function rng(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

function pickKind(): MoleKind {
  const r = Math.random();
  if (r < P_GOLD) return 'gold';
  if (r < P_GOLD + P_BOMB) return 'bomb';
  return 'normal';
}

function scheduleAt(ms: number, fn: (myToken: number) => void): void {
  const myToken = token;
  const id = window.setTimeout(() => {
    if (myToken !== token) return; // stale callback guard
    fn(myToken);
  }, ms);
  timeoutIds.push(id);
}

function clearAllTimers(): void {
  for (const id of timeoutIds) clearTimeout(id);
  timeoutIds = [];
}

function showOverlay(title: string, msgHtml: string, btnLabel: string): void {
  overlayTitle.textContent = title;
  overlayMsg.innerHTML = msgHtml;
  overlayBtn.textContent = btnLabel;
  showOverlayEl(overlay);
  // give focus for keyboard users
  overlayBtn.focus({ preventScroll: true });
}

function hideOverlay(): void {
  hideOverlayEl(overlay);
}

// ── Board ───────────────────────────────────────────────────────────────────
function buildBoard(): void {
  board.innerHTML = '';
  slots = [];
  for (let i = 0; i < GRID; i++) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'hole';
    button.setAttribute('role', 'gridcell');
    button.setAttribute('aria-label', `Delik ${i + 1}`);

    const rim = document.createElement('div');
    rim.className = 'hole__rim';

    const sprite = document.createElement('div');
    sprite.className = 'mole';
    rim.appendChild(sprite);

    button.appendChild(rim);
    board.appendChild(button);

    const slot: MoleSlot = {
      kind: null,
      nextEventAt: 0,
      hideAt: 0,
      locked: false,
      spriteEl: sprite,
      rimEl: rim,
      buttonEl: button,
    };
    slots.push(slot);

    // Single delegated handler per hole — pointerdown is faster than click
    // on touch devices and prevents the 300ms tap delay (touch-action: manipulation
    // also helps). Use pointerdown so taps register on the *down*, not release.
    button.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      onHoleTap(i);
    });
  }
}

// ── Critter lifecycle ────────────────────────────────────────────────────────
function popCritter(): void {
  if (state !== 'playing') return;

  // Find a free slot (no critter currently shown, not locked).
  const freeIdx: number[] = [];
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i]!;
    if (s.kind === null && !s.locked) freeIdx.push(i);
  }
  if (freeIdx.length === 0) {
    scheduleNextSpawn();
    return;
  }

  const idx = freeIdx[Math.floor(Math.random() * freeIdx.length)]!;
  const slot = slots[idx]!;
  const kind = pickKind();

  let showMs: number;
  switch (kind) {
    case 'gold':
      showMs = rng(SHOW_MIN_GOLD_MS, SHOW_MAX_GOLD_MS);
      break;
    case 'bomb':
      showMs = rng(SHOW_MIN_BOMB_MS, SHOW_MAX_BOMB_MS);
      break;
    default:
      showMs = rng(SHOW_MIN_MS, SHOW_MAX_MS);
  }

  showCritter(slot, kind, showMs);
  scheduleNextSpawn();
}

function showCritter(slot: MoleSlot, kind: MoleKind, showMs: number): void {
  slot.kind = kind;
  slot.hideAt = performance.now() + showMs;
  slot.spriteEl.innerHTML = buildSpriteHtml(kind);
  slot.spriteEl.className = 'mole'; // reset any animation class
  // Force a layout flush so the transition runs.
  void slot.spriteEl.offsetHeight;
  slot.spriteEl.classList.add('is-up');

  scheduleAt(showMs, (myToken) => {
    if (slot.kind !== kind) return; // already hit/replaced
    if (myToken !== token) return;
    hideCritter(slot);
  });
}

function hideCritter(slot: MoleSlot): void {
  slot.spriteEl.classList.remove('is-up');
  slot.spriteEl.classList.remove('is-bonked');
  slot.spriteEl.classList.remove('is-exploded');
  slot.kind = null;
}

// ── Spawn cadence ────────────────────────────────────────────────────────────
function currentSpawnWindow(): { min: number; max: number } {
  const elapsedS = ROUND_SECONDS - timeLeft;
  const steps = Math.floor(elapsedS / DIFFICULTY_STEP_S);
  const factor = Math.pow(DIFFICULTY_SHRINK_RATIO, steps);
  const min = Math.max(
    SPAWN_FLOOR_MIN_MS,
    Math.round(SPAWN_BASE_MIN_MS * factor),
  );
  const max = Math.max(
    SPAWN_FLOOR_MAX_MS,
    Math.round(SPAWN_BASE_MAX_MS * factor),
  );
  return { min, max };
}

function scheduleNextSpawn(): void {
  if (state !== 'playing') return;
  const { min, max } = currentSpawnWindow();
  const delay = rng(min, max);
  scheduleAt(delay, () => popCritter());
}

// ── Tap handling ─────────────────────────────────────────────────────────────
function onHoleTap(idx: number): void {
  if (state !== 'playing') return;
  const slot = slots[idx];
  if (!slot) return;
  if (slot.kind === null || slot.locked) return;

  const kind = slot.kind;
  slot.locked = true;

  if (kind === 'normal' || kind === 'gold') {
    const points = kind === 'gold' ? SCORE_GOLD : SCORE_NORMAL;
    addScore(points);
    spawnPopup(slot, `+${points}`, kind === 'gold' ? 'popup--gold' : 'popup--gain');
    slot.spriteEl.classList.remove('is-up');
    slot.spriteEl.classList.add('is-bonked');
    scheduleAt(BONK_MS, (myToken) => {
      if (myToken !== token) return;
      slot.kind = null;
      slot.locked = false;
      slot.spriteEl.classList.remove('is-bonked');
    });
  } else {
    // bomb
    addScore(SCORE_BOMB);
    spawnPopup(slot, `${SCORE_BOMB}`, 'popup--lose');
    triggerShake();
    slot.spriteEl.classList.remove('is-up');
    slot.spriteEl.classList.add('is-exploded');
    scheduleAt(EXPLODE_MS, (myToken) => {
      if (myToken !== token) return;
      slot.kind = null;
      slot.locked = false;
      slot.spriteEl.classList.remove('is-exploded');
    });
  }
}

function addScore(delta: number): void {
  score = Math.max(0, score + delta);
  scoreEl.textContent = String(score);
  if (score > best) {
    best = score;
    bestEl.textContent = String(best);
    safeWrite(STORAGE_KEY, best);
  }
}

function spawnPopup(slot: MoleSlot, text: string, cls: string): void {
  const popup = document.createElement('div');
  popup.className = `popup ${cls}`;
  popup.textContent = text;
  slot.rimEl.appendChild(popup);
  scheduleAt(POPUP_MS, (myToken) => {
    if (myToken !== token) {
      popup.remove();
      return;
    }
    popup.remove();
  });
}

function triggerShake(): void {
  boardWrap.classList.remove('is-shaking');
  // restart animation by forcing reflow
  void boardWrap.offsetHeight;
  boardWrap.classList.add('is-shaking');
  scheduleAt(SHAKE_MS, () => boardWrap.classList.remove('is-shaking'));
}

// ── Timer ────────────────────────────────────────────────────────────────────
function tickTimer(): void {
  if (state !== 'playing') return;
  timeLeft--;
  if (timeLeft < 0) timeLeft = 0;
  timeEl.textContent = String(timeLeft);
  if (timeLeft <= 0) {
    endGame();
    return;
  }
  scheduleAt(1000, () => tickTimer());
}

// ── Game flow ────────────────────────────────────────────────────────────────
function startGame(): void {
  // Always reset per-life state first — even if a round is already in progress,
  // pressing Start/R should restart the round cleanly.
  token++; // invalidate any stale callbacks from prior round
  clearAllTimers();
  for (const s of slots) {
    hideCritter(s);
    s.locked = false;
  }
  score = 0;
  timeLeft = ROUND_SECONDS;
  scoreEl.textContent = '0';
  timeEl.textContent = String(ROUND_SECONDS);
  bestEl.textContent = String(best);
  boardWrap.classList.remove('is-shaking');
  state = 'playing';
  hideOverlay();

  // First critter pops quickly so the user sees feedback within ~250ms.
  scheduleAt(INITIAL_FIRST_SPAWN_MS, () => popCritter());
  // Start the second-tick timer.
  scheduleAt(1000, () => tickTimer());
}

function endGame(): void {
  if (state === 'gameover') return;
  state = 'gameover';
  token++; // any pending pops/hides become stale
  clearAllTimers();
  // hide any still-up critters
  for (const s of slots) {
    hideCritter(s);
    s.locked = false;
  }
  boardWrap.classList.remove('is-shaking');

  recordScore(SCORE_DESC, score);

  const isBest = score >= best; // best already written incrementally; this is for messaging
  const title = isBest && score > 0 ? 'Yeni rekor!' : 'Süre doldu!';
  const msg = `Skor: <strong>${score}</strong><br>En iyi: ${best}<br><small>Boşluk veya R ile yeniden başla</small>`;
  showOverlay(title, msg, 'Tekrar oyna');
}

function resetToReady(): void {
  token++;
  clearAllTimers();
  for (const s of slots) {
    hideCritter(s);
    s.locked = false;
  }
  state = 'ready';
  score = 0;
  timeLeft = ROUND_SECONDS;
  scoreEl.textContent = '0';
  timeEl.textContent = String(ROUND_SECONDS);
  bestEl.textContent = String(best);
  boardWrap.classList.remove('is-shaking');
  showOverlay(
    'Whack-a-Mole',
    'Köstebekleri yakala. Altın köstebek <strong>+30</strong>, bomba <strong>-20</strong>!<br><small>Başlamak için "Başla" tuşuna bas.</small>',
    'Başla',
  );
}

// ── Init ────────────────────────────────────────────────────────────────────
function init(): void {
  boardWrap = document.querySelector<HTMLDivElement>('#board-wrap')!;
  board = document.querySelector<HTMLDivElement>('#board')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  timeEl = document.querySelector<HTMLElement>('#time')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;

  best = safeRead<number>(STORAGE_KEY, 0);
  if (!Number.isFinite(best) || best < 0) best = 0;

  overlayBtn.addEventListener('click', () => {
    startGame();
  });

  restartBtn.addEventListener('click', () => {
    startGame();
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      startGame();
      return;
    }
    if (state !== 'playing') {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        startGame();
      }
    }
  });

  buildBoard();
  resetToReady();
}

export const game = defineGame({ init, reset: resetToReady });
