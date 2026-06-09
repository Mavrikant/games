import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay, hideOverlay } from '@shared/overlay';
import { reportGameOver } from '@shared/leaderboard';

// PITFALLS guarded here (read docs/PITFALLS.md before editing):
// - unguarded-storage: best score only flows through safeRead/safeWrite.
// - stale-async-callback: a generation token cancels the rAF loop + flash
//   timeouts on reset/restart, so a spam-restarted run can't drain time or
//   rebuild a board that belongs to a previous run.
// - overlay-input-leak / unreachable-start-state: an explicit `state` enum
//   gates every handler; the overlay has a real Start button AND an Enter/Space
//   keyboard fallback, so "ready" and "gameover" always have an exit.
// - missing-overlay-css: ton-avi.css defines `.overlay--hidden`.
// - invisible-boot: pressing Start builds the first board synchronously, so the
//   grid of circles appears in the same frame (< 250 ms).

const STORAGE_BEST = 'ton-avi.best';
const SCORE_DESC = {
  gameId: 'ton-avi',
  storageKey: STORAGE_BEST,
  direction: 'higher' as const,
};

type State = 'ready' | 'playing' | 'gameover';

// --- Difficulty schedule ---------------------------------------------------
// Grid grows 2x2 -> 8x8 over the first seven levels, then stays maxed while the
// colour delta keeps shrinking. The tone delta is expressed in HSL lightness
// points and decays geometrically: obvious at first, near-identical later.
const GRID_MIN = 2;
const GRID_MAX = 8;
const DELTA_START = 26; // level 1 — very easy to spot
const DELTA_MIN = 2.4; // floor — colours are almost identical
const DELTA_DECAY = 0.86;
const TIME_START = 8000; // ms, level 1
const TIME_STEP = 360; // ms shaved off per level
const TIME_MIN = 3000; // ms floor
const WRONG_PENALTY = 1300; // ms lost on a wrong pick
const FLASH_MS = 150; // brief feedback before the next grid is built
const MAX_DT = 100; // clamp per-frame dt so a backgrounded tab can't insta-lose

function gridSizeFor(lvl: number): number {
  return Math.min(GRID_MAX, GRID_MIN + (lvl - 1));
}

function deltaFor(lvl: number): number {
  return Math.max(DELTA_MIN, DELTA_START * Math.pow(DELTA_DECAY, lvl - 1));
}

function durationFor(lvl: number): number {
  return Math.max(TIME_MIN, TIME_START - (lvl - 1) * TIME_STEP);
}

// --- Module state (all assigned in init / level setup) ---------------------
const gen = createGenToken();
let state: State = 'ready';
let level = 1;
let score = 0;
let best = 0;

let gridSize = GRID_MIN;
let oddIndex = -1;
let levelDuration = TIME_START;
let remaining = TIME_START;
let lastTs = 0;
let loopGen = 0;
let advancing = false; // brief lock during the correct-answer flash

let levelEl!: HTMLElement;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let timeFillEl!: HTMLElement;
let boardEl!: HTMLElement;
let overlayEl!: HTMLElement;
let overlayTitleEl!: HTMLElement;
let overlayTextEl!: HTMLElement;
let startBtn!: HTMLButtonElement;

// --- Colour helpers --------------------------------------------------------
interface Hsl {
  h: number;
  s: number;
  l: number;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function hslCss({ h, s, l }: Hsl): string {
  return `hsl(${h.toFixed(1)} ${s.toFixed(1)}% ${l.toFixed(1)}%)`;
}

// Pick a base colour and the single odd one, differing by `delta` tone points.
// The tone shift is mostly lightness (the natural reading of "different shade")
// with a smaller, same-direction saturation nudge so it stays a tone — not a
// new hue. The sign is chosen so the shift never clamps back onto the base
// colour, which would make the odd circle invisible.
function makeColours(delta: number): { base: Hsl; odd: Hsl } {
  const h = Math.random() * 360;
  const s = 55 + Math.random() * 22; // 55–77%
  const l = 44 + Math.random() * 20; // 44–64%
  const base: Hsl = { h, s, l };

  let sign = Math.random() < 0.5 ? 1 : -1;
  if (l + sign * delta > 90) sign = -1;
  if (l + sign * delta < 12) sign = 1;

  const odd: Hsl = {
    h,
    s: clamp(s + sign * delta * 0.35, 30, 95),
    l: clamp(l + sign * delta, 10, 92),
  };
  return { base, odd };
}

// --- Rendering -------------------------------------------------------------
function syncHud(): void {
  levelEl.textContent = String(level);
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
}

function updateTimebar(): void {
  const ratio = levelDuration > 0 ? clamp(remaining / levelDuration, 0, 1) : 0;
  timeFillEl.style.transform = `scaleX(${ratio})`;
  timeFillEl.classList.toggle('timebar__fill--low', ratio < 0.28);
}

function buildLevel(): void {
  gridSize = gridSizeFor(level);
  const count = gridSize * gridSize;
  const delta = deltaFor(level);
  const { base, odd } = makeColours(delta);
  oddIndex = Math.floor(Math.random() * count);

  boardEl.style.setProperty('--cols', String(gridSize));

  // Rebuild from scratch each level — sizes differ, so reuse buys nothing and a
  // clean DOM avoids ghost cells from the previous (different) grid size.
  const frag = document.createDocumentFragment();
  for (let i = 0; i < count; i++) {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'cell';
    cell.dataset.i = String(i);
    cell.setAttribute('aria-label', `${i + 1}. daire`);
    cell.style.setProperty('--dot', hslCss(i === oddIndex ? odd : base));
    frag.appendChild(cell);
  }
  boardEl.replaceChildren(frag);

  levelDuration = durationFor(level);
  remaining = levelDuration;
  updateTimebar();
}

// --- Game loop -------------------------------------------------------------
function loop(ts: number): void {
  if (state !== 'playing' || !gen.isCurrent(loopGen)) return;
  if (advancing) {
    // Timer is frozen during the success flash; keep lastTs fresh so the next
    // real frame computes a small dt instead of swallowing the pause.
    lastTs = ts;
    requestAnimationFrame(loop);
    return;
  }
  const dt = Math.min(MAX_DT, ts - lastTs);
  lastTs = ts;
  remaining -= dt;
  if (remaining <= 0) {
    remaining = 0;
    updateTimebar();
    endGame();
    return;
  }
  updateTimebar();
  requestAnimationFrame(loop);
}

function startLoop(): void {
  loopGen = gen.current();
  lastTs = performance.now();
  requestAnimationFrame(loop);
}

// --- State transitions -----------------------------------------------------
function commitBest(): void {
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
}

function nextLevel(): void {
  // Speed bonus rewards fast finds; the flat base keeps every pick worthwhile.
  const speedBonus = Math.round(remaining / 60);
  score += 10 + level * 5 + speedBonus;
  level += 1;
  commitBest();
  syncHud();

  advancing = true;
  boardEl.classList.add('board--good');
  const myGen = gen.current();
  window.setTimeout(() => {
    if (!gen.isCurrent(myGen)) return; // restarted mid-flash → drop it
    boardEl.classList.remove('board--good');
    advancing = false;
    buildLevel();
  }, FLASH_MS);
}

function wrongPick(cell: HTMLButtonElement): void {
  remaining -= WRONG_PENALTY;
  cell.classList.add('cell--wrong');
  const myGen = gen.current();
  window.setTimeout(() => {
    if (!gen.isCurrent(myGen)) return;
    cell.classList.remove('cell--wrong');
  }, 300);
  // Retrigger the shake even on rapid successive wrong taps.
  boardEl.classList.remove('board--shake');
  void boardEl.offsetWidth;
  boardEl.classList.add('board--shake');
  if (remaining <= 0) {
    remaining = 0;
    updateTimebar();
    endGame();
  } else {
    updateTimebar();
  }
}

function onBoardClick(e: MouseEvent): void {
  if (state !== 'playing' || advancing) return;
  const target = (e.target as HTMLElement | null)?.closest<HTMLButtonElement>(
    '.cell',
  );
  if (!target) return;
  if (Number(target.dataset.i) === oddIndex) {
    nextLevel();
  } else {
    wrongPick(target);
  }
}

function startGame(): void {
  gen.bump();
  advancing = false;
  state = 'playing';
  level = 1;
  score = 0;
  syncHud();
  hideOverlay(overlayEl);
  buildLevel();
  startLoop();
}

function endGame(): void {
  gen.bump(); // cancel the loop + any pending flash timeout
  state = 'gameover';
  advancing = false;
  commitBest();
  syncHud();
  boardEl.classList.remove('board--good', 'board--shake');
  overlayTitleEl.textContent = 'Süre doldu!';
  overlayTextEl.textContent = `Seviye ${level} · Skor ${score}\nRekor ${best}`;
  startBtn.textContent = 'Tekrar oyna';
  showOverlay(overlayEl);
  reportGameOver(SCORE_DESC, score, { label: 'Skor' });
}

// `reset()` returns the game to the ready screen — used on first load and the
// in-game R shortcut.
function reset(): void {
  gen.bump();
  state = 'ready';
  advancing = false;
  level = 1;
  score = 0;
  syncHud();
  overlayTitleEl.textContent = 'Ton Avı';
  overlayTextEl.textContent =
    'Dairelerin arasından farklı tonda olanı bul. Her seviyede ızgara büyür, renk farkı azalır ve süre kısalır.';
  startBtn.textContent = 'Başla';
  boardEl.replaceChildren();
  boardEl.style.setProperty('--cols', String(GRID_MIN));
  levelDuration = TIME_START;
  remaining = 0;
  updateTimebar();
  showOverlay(overlayEl);
}

function init(): void {
  levelEl = document.querySelector<HTMLElement>('#level')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  timeFillEl = document.querySelector<HTMLElement>('#timefill')!;
  boardEl = document.querySelector<HTMLElement>('#board')!;
  overlayEl = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitleEl = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayTextEl = document.querySelector<HTMLElement>('#overlay-text')!;
  startBtn = document.querySelector<HTMLButtonElement>('#start')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  boardEl.addEventListener('click', onBoardClick);
  startBtn.addEventListener('click', startGame);
  window.addEventListener('keydown', (e) => {
    const k = e.key;
    if (
      (k === 'Enter' || k === ' ' || k === 'Spacebar') &&
      state !== 'playing'
    ) {
      e.preventDefault();
      startGame();
    } else if ((k === 'r' || k === 'R') && state === 'playing') {
      reset();
    }
  });

  reset();
}

export const game = defineGame({ init, reset });
