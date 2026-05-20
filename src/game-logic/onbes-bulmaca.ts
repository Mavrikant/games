// Onbeş Bulmaca — classic sliding-tile puzzle.
//
// The grid is `size × size` (3, 4 or 5). One cell is the blank (value 0).
// Tiles 1..N (where N = size² − 1) start scrambled. A click on a tile that
// is orthogonally adjacent to the blank slides it into the blank. Arrow
// keys move the **blank** in the chosen direction (the tile underneath
// slides the opposite way).
//
// Solvability is guaranteed because we scramble by applying 200+ random
// VALID moves from the solved state. (Random permutations of N²−1 tiles
// have a 50% chance of being unsolvable; valid-move scrambling cannot
// produce an unsolvable board.)
//
// State enum (`Playing | Solved`) prevents overlay-input-leak: once the
// board is solved the arrow keys and clicks are ignored until the user
// restarts.
//
// Animations: a CSS transform transition moves each tile to its new
// (row, col). We do NOT depend on transitionend for game logic — moves
// update state instantly, then re-render. A generation token guards any
// queued win callback or timer against a stale game.

type Size = 3 | 4 | 5;
type GameState = 'playing' | 'solved';

interface BestRecord {
  moves: number;
  time: number;
}
type BestMap = Partial<Record<Size, BestRecord>>;

const SIZES: readonly Size[] = [3, 4, 5];
const DEFAULT_SIZE: Size = 4;
const SCRAMBLE_MOVES = 240; // 200+ as per spec, comfortably above

const STORAGE_BEST = 'onbes-bulmaca.best';
const STORAGE_BEST_MOVES = 'onbes-bulmaca.best-moves';
const STORAGE_BEST_TIME = 'onbes-bulmaca.best-time';
const STORAGE_SIZE = 'onbes-bulmaca.size';

const boardEl = document.querySelector<HTMLElement>('#board')!;
const movesEl = document.querySelector<HTMLElement>('#moves')!;
const timeEl = document.querySelector<HTMLElement>('#time')!;
const bestEl = document.querySelector<HTMLElement>('#best')!;
const restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
const diffBtns = Array.from(
  document.querySelectorAll<HTMLButtonElement>('.diff__btn'),
);
const overlay = document.querySelector<HTMLElement>('#overlay')!;
const overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
const overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
const overlayRestart =
  document.querySelector<HTMLButtonElement>('#overlay-restart')!;

let size: Size = loadSize();
const bestMap: BestMap = loadBest();

// `tiles[i]` is the value at flat index i (0 = blank).
let tiles: number[] = [];
let blank = 0; // flat index of the blank
let moves = 0;
let elapsedSec = 0;
let startMs = 0;
let timerHandle: number | null = null;
let state: GameState = 'playing';
// Bumped on every reset; async callbacks check it before mutating state.
let gen = 0;

// One <button> per tile (incl. the blank, which is hidden via class).
let tileEls: HTMLButtonElement[] = [];

// ─────────────────────── storage helpers ───────────────────────

function safeRead(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeWrite(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore (private mode, quota, disabled) */
  }
}

function loadSize(): Size {
  const raw = safeRead(STORAGE_SIZE);
  const n = Number(raw);
  if (n === 3 || n === 4 || n === 5) return n;
  return DEFAULT_SIZE;
}

function saveSize(): void {
  safeWrite(STORAGE_SIZE, String(size));
}

function loadBest(): BestMap {
  const out: BestMap = {};
  const raw = safeRead(STORAGE_BEST);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object') {
        for (const s of SIZES) {
          const entry = (parsed as Record<string, unknown>)[String(s)];
          if (entry && typeof entry === 'object') {
            const m = Number((entry as Record<string, unknown>).moves);
            const t = Number((entry as Record<string, unknown>).time);
            if (Number.isFinite(m) && m > 0 && Number.isFinite(t) && t >= 0) {
              out[s] = { moves: m, time: t };
            }
          }
        }
      }
    } catch {
      /* fall through */
    }
  }
  // Legacy single-key fallbacks (spec mentions these keys explicitly).
  const legacyMoves = Number(safeRead(STORAGE_BEST_MOVES));
  const legacyTime = Number(safeRead(STORAGE_BEST_TIME));
  if (
    !out[DEFAULT_SIZE] &&
    Number.isFinite(legacyMoves) &&
    legacyMoves > 0 &&
    Number.isFinite(legacyTime) &&
    legacyTime >= 0
  ) {
    out[DEFAULT_SIZE] = { moves: legacyMoves, time: legacyTime };
  }
  return out;
}

function saveBest(): void {
  safeWrite(STORAGE_BEST, JSON.stringify(bestMap));
  const four = bestMap[DEFAULT_SIZE];
  if (four) {
    // Mirror to the explicit keys called out in the spec so that anything
    // depending on them (debug tools, external scripts) keeps working.
    safeWrite(STORAGE_BEST_MOVES, String(four.moves));
    safeWrite(STORAGE_BEST_TIME, String(four.time));
  }
}

// ─────────────────────── grid math ───────────────────────

function rowOf(i: number): number {
  return Math.floor(i / size);
}
function colOf(i: number): number {
  return i % size;
}
function idx(r: number, c: number): number {
  return r * size + c;
}
function inBounds(r: number, c: number): boolean {
  return r >= 0 && r < size && c >= 0 && c < size;
}

function solvedTiles(): number[] {
  const total = size * size;
  const arr = new Array<number>(total);
  for (let i = 0; i < total - 1; i++) arr[i] = i + 1;
  arr[total - 1] = 0;
  return arr;
}

function isSolved(): boolean {
  const total = size * size;
  for (let i = 0; i < total - 1; i++) {
    if (tiles[i] !== i + 1) return false;
  }
  // last cell must be the blank
  return tiles[total - 1] === 0;
}

/**
 * Scramble by applying random valid moves from the solved state. This
 * GUARANTEES the result is solvable (every move is reversible) — unlike a
 * random permutation, which has a 50% chance of producing an unsolvable
 * board for even-sized grids.
 *
 * To avoid trivial back-and-forth oscillation we forbid the immediate
 * undo: the very next swap can't put the blank back where it was one
 * step ago.
 */
function scramble(): void {
  tiles = solvedTiles();
  blank = tiles.length - 1;
  // `lastBlankPos` is the position the blank occupied BEFORE the most
  // recent swap. Swapping back into that cell would undo the last move,
  // so we forbid it.
  let lastBlankPos = -1;
  for (let step = 0; step < SCRAMBLE_MOVES; step++) {
    const neighbors = blankNeighbors();
    const candidates = neighbors.filter((i) => i !== lastBlankPos);
    const choices = candidates.length > 0 ? candidates : neighbors;
    if (choices.length === 0) break; // size === 0/1 safety
    const pick = choices[Math.floor(Math.random() * choices.length)]!;
    const prev = blank;
    swapBlankWith(pick);
    lastBlankPos = prev;
  }
  // Astronomically unlikely, but: if we landed back on solved, push off it.
  while (isSolved()) {
    const ns = blankNeighbors();
    if (ns.length === 0) break;
    const pick = ns[Math.floor(Math.random() * ns.length)]!;
    swapBlankWith(pick);
  }
}

function blankNeighbors(): number[] {
  const r = rowOf(blank);
  const c = colOf(blank);
  const out: number[] = [];
  if (inBounds(r - 1, c)) out.push(idx(r - 1, c));
  if (inBounds(r + 1, c)) out.push(idx(r + 1, c));
  if (inBounds(r, c - 1)) out.push(idx(r, c - 1));
  if (inBounds(r, c + 1)) out.push(idx(r, c + 1));
  return out;
}

function swapBlankWith(i: number): void {
  tiles[blank] = tiles[i]!;
  tiles[i] = 0;
  blank = i;
}

// ─────────────────────── rendering ───────────────────────

function setBoardSizeAttr(): void {
  boardEl.style.setProperty('--size', String(size));
  boardEl.setAttribute(
    'aria-label',
    `Onbeş Bulmaca ${size}×${size} tahtası`,
  );
  boardEl.dataset.size = String(size);
}

/**
 * Compute the pixel offset (from the board's content-box top-left) for
 * the tile that should appear at flat index `i`. We measure the live
 * board width so the layout follows orientation changes / window resize.
 *
 * IMPORTANT: this MUST mirror the CSS exactly:
 *   tileSize = (boardContentWidth - gap*(size-1)) / size
 *   step     = tileSize + gap
 * The CSS uses `--ob-gap` (read here) and the tile's own `width: calc(...)`.
 * Both visual draw and hitbox calc agree on these numbers — fix-once,
 * source-of-truth. (pitfall: visual-vs-hitbox)
 */
function tilePosTransform(i: number): string {
  const r = rowOf(i);
  const c = colOf(i);
  const styles = getComputedStyle(boardEl);
  // The board has padding === --ob-gap on every side. clientWidth includes
  // padding, so we subtract 2*pad to get the content-box width.
  const pad = parseFloat(styles.paddingLeft) || 0;
  const gap = pad; // padding === gap by design (see CSS)
  const innerWidth = boardEl.clientWidth - 2 * pad;
  const tileSize = (innerWidth - gap * (size - 1)) / size;
  const step = tileSize + gap;
  return `translate(${c * step}px, ${r * step}px)`;
}

function buildBoard(): void {
  boardEl.innerHTML = '';
  tileEls = [];
  const total = size * size;
  // Build one element per VALUE (1..N), positioned by current flat index.
  // The blank is represented by ABSENCE — i.e. we render `total - 1` tile
  // elements, never the blank, so there's no "hide" class to fight with.
  for (let v = 1; v < total; v++) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tile';
    btn.dataset.value = String(v);
    btn.setAttribute('aria-label', `Plaka ${v}`);
    btn.textContent = String(v);
    btn.addEventListener('click', () => onTileClick(v));
    boardEl.appendChild(btn);
    tileEls.push(btn);
  }
}

function positionTiles(): void {
  // For each value 1..N, find its current flat index and set its transform.
  for (let i = 0; i < tiles.length; i++) {
    const v = tiles[i]!;
    if (v === 0) continue;
    const el = tileEls[v - 1];
    if (!el) continue;
    el.style.transform = tilePosTransform(i);
  }
}

function renderMoves(): void {
  movesEl.textContent = String(moves);
}

function renderTime(): void {
  timeEl.textContent = formatTime(elapsedSec);
}

function renderBest(): void {
  const b = bestMap[size];
  if (!b) {
    bestEl.textContent = '—';
  } else {
    bestEl.textContent = `${b.moves} · ${formatTime(b.time)}`;
  }
}

function renderDiff(): void {
  diffBtns.forEach((btn) => {
    btn.classList.toggle(
      'diff__btn--active',
      btn.dataset.size === String(size),
    );
  });
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ─────────────────────── input ───────────────────────

function findIndexOfValue(v: number): number {
  for (let i = 0; i < tiles.length; i++) if (tiles[i] === v) return i;
  return -1;
}

function isNeighborOfBlank(i: number): boolean {
  const r = rowOf(i);
  const c = colOf(i);
  const br = rowOf(blank);
  const bc = colOf(blank);
  return (
    (r === br && Math.abs(c - bc) === 1) ||
    (c === bc && Math.abs(r - br) === 1)
  );
}

function onTileClick(value: number): void {
  if (state !== 'playing') return;
  const i = findIndexOfValue(value);
  if (i < 0) return;
  if (!isNeighborOfBlank(i)) return; // invalid move = no-op
  doSlide(i);
}

function doSlide(tileIndex: number): void {
  if (state !== 'playing') return;
  if (!isNeighborOfBlank(tileIndex)) return;
  if (startMs === 0) startTimer();
  swapBlankWith(tileIndex);
  moves++;
  renderMoves();
  positionTiles();
  if (isSolved()) onSolved();
}

/**
 * Arrow keys move the BLANK in the chosen direction. The tile slides the
 * opposite way. (This is the more natural mental model for keyboard
 * play and matches most physical 15-puzzle apps.)
 */
function moveBlank(dr: number, dc: number): boolean {
  if (state !== 'playing') return false;
  const r = rowOf(blank) + dr;
  const c = colOf(blank) + dc;
  if (!inBounds(r, c)) return false;
  doSlide(idx(r, c));
  return true;
}

function onSolved(): void {
  state = 'solved';
  stopTimer();
  const winMoves = moves;
  const winTime = elapsedSec;
  const prev = bestMap[size];
  const isBest =
    !prev ||
    winMoves < prev.moves ||
    (winMoves === prev.moves && winTime < prev.time);
  if (isBest) {
    bestMap[size] = { moves: winMoves, time: winTime };
    saveBest();
    renderBest();
  }
  showOverlay(isBest, winMoves, winTime);
}

function showOverlay(isBest: boolean, m: number, t: number): void {
  overlayTitle.textContent = isBest ? 'Yeni rekor!' : 'Çözdün!';
  overlayMsg.textContent = `${m} hamle · ${formatTime(t)}`;
  overlay.classList.remove('overlay--hidden');
  overlay.setAttribute('aria-hidden', 'false');
  // Move focus to the prominent button so Enter / Space restarts.
  overlayRestart.focus({ preventScroll: true });
}

function hideOverlay(): void {
  overlay.classList.add('overlay--hidden');
  overlay.setAttribute('aria-hidden', 'true');
}

// ─────────────────────── timer ───────────────────────

function startTimer(): void {
  if (timerHandle !== null) return;
  startMs = Date.now();
  const myGen = gen;
  timerHandle = window.setInterval(() => {
    // Stale tick guard: if a reset bumped the generation, this interval
    // belongs to a previous game and must not mutate `elapsedSec`.
    if (myGen !== gen) return;
    elapsedSec = Math.floor((Date.now() - startMs) / 1000);
    renderTime();
  }, 250);
}

function stopTimer(): void {
  if (timerHandle !== null) {
    clearInterval(timerHandle);
    timerHandle = null;
  }
}

// ─────────────────────── lifecycle ───────────────────────

function startGame(): void {
  gen++;
  stopTimer();
  state = 'playing';
  setBoardSizeAttr();
  scramble();
  moves = 0;
  elapsedSec = 0;
  startMs = 0;
  buildBoard();
  positionTiles();
  renderMoves();
  renderTime();
  renderBest();
  renderDiff();
  hideOverlay();
}

function setSize(s: Size): void {
  if (s === size) {
    // Same size = just reshuffle.
    startGame();
    return;
  }
  size = s;
  saveSize();
  startGame();
}

// ─────────────────────── wiring ───────────────────────

restartBtn.addEventListener('click', () => startGame());
overlayRestart.addEventListener('click', () => startGame());

diffBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    const n = Number(btn.dataset.size);
    if (n === 3 || n === 4 || n === 5) setSize(n);
  });
});

window.addEventListener('keydown', (e) => {
  const k = e.key;
  // 'R' is always allowed (it's a restart, not gameplay input).
  if (k === 'r' || k === 'R') {
    startGame();
    e.preventDefault();
    return;
  }
  // Arrow keys are GAMEPLAY input — block them while solved overlay is up.
  if (state !== 'playing') {
    if (k === 'Enter' || k === ' ') {
      // Single press restarts from the solved overlay (matches the
      // overlay-input-leak pitfall — one tap to retry).
      startGame();
      e.preventDefault();
    }
    return;
  }
  let handled = false;
  switch (k) {
    case 'ArrowUp':
      handled = moveBlank(-1, 0);
      break;
    case 'ArrowDown':
      handled = moveBlank(1, 0);
      break;
    case 'ArrowLeft':
      handled = moveBlank(0, -1);
      break;
    case 'ArrowRight':
      handled = moveBlank(0, 1);
      break;
  }
  if (handled || k.startsWith('Arrow')) {
    // Prevent the page from scrolling under our grid even when the move
    // was a no-op (e.g. blank against the wall).
    e.preventDefault();
  }
});

// Reposition all tiles when the board size changes (orientation flip,
// window resize, mobile keyboard pushing the viewport). The transform is
// pixel-based, so a stale value would leave tiles misaligned.
let resizeRaf = 0;
const repositionAll = () => {
  if (tileEls.length === 0) return;
  positionTiles();
};
window.addEventListener('resize', () => {
  if (resizeRaf) cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(() => {
    resizeRaf = 0;
    repositionAll();
  });
});
if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(() => repositionAll()).observe(boardEl);
}

// First paint — make sure the board is renderable within 250ms of load.
startGame();
