import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';
import { reportGameOver } from '@shared/leaderboard';

type Dir = 'up' | 'down' | 'left' | 'right';

interface Tile {
  id: number;
  value: number;
  row: number;
  col: number;
  mergedFrom?: [Tile, Tile];
  isNew?: boolean;
  el?: HTMLDivElement;
}

interface SavedState {
  grid: number[][];
  score: number;
  won: boolean;
  keepGoing: boolean;
}

const SIZE = 4;
const STORAGE_BEST = '2048.best';
const STORAGE_STATE = '2048.state';
// Global-leaderboard contract. recordScore() also keeps the local best in sync,
// so this is purely additive on top of the existing STORAGE_BEST handling.
const SCORE_DESC = { gameId: '2048', storageKey: STORAGE_BEST, direction: 'higher' as const };

let boardEl!: HTMLDivElement;
let tilesEl!: HTMLDivElement;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayBtn!: HTMLButtonElement;

let grid: (Tile | null)[][] = [];
let tilesAll: Tile[] = [];
let score = 0;
let best = 0;
let nextId = 1;
let won = false;
let keepGoing = false;
let dead = false;
let animating = false;
const moveGen = createGenToken();

function emptyGrid(): (Tile | null)[][] {
  return Array.from({ length: SIZE }, () => Array<Tile | null>(SIZE).fill(null));
}

function findEmptyCells(): { r: number; c: number }[] {
  const cells: { r: number; c: number }[] = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (!grid[r]![c]) cells.push({ r, c });
    }
  }
  return cells;
}

function spawnRandom(): void {
  const cells = findEmptyCells();
  if (cells.length === 0) return;
  const pick = cells[Math.floor(Math.random() * cells.length)]!;
  const value = Math.random() < 0.9 ? 2 : 4;
  const tile: Tile = {
    id: nextId++,
    value,
    row: pick.r,
    col: pick.c,
    isNew: true,
  };
  grid[pick.r]![pick.c] = tile;
  tilesAll.push(tile);
}

function reset(persist = true): void {
  moveGen.bump();
  grid = emptyGrid();
  tilesAll = [];
  score = 0;
  won = false;
  keepGoing = false;
  dead = false;
  animating = false;
  scoreEl.textContent = '0';
  bestEl.textContent = String(best);
  spawnRandom();
  spawnRandom();
  render();
  hideOverlay();
  if (persist) saveState();
}

function saveState(): void {
  const flat = grid.map((row) => row.map((t) => (t ? t.value : 0)));
  safeWrite(STORAGE_STATE, { grid: flat, score, won, keepGoing });
}

function loadState(): boolean {
  const data = safeRead<SavedState | null>(STORAGE_STATE, null);
  if (!data) return false;
  if (!Array.isArray(data.grid) || data.grid.length !== SIZE) return false;
  grid = emptyGrid();
  tilesAll = [];
  for (let r = 0; r < SIZE; r++) {
    const row = data.grid[r];
    if (!row || row.length !== SIZE) return false;
    for (let c = 0; c < SIZE; c++) {
      const v = row[c]!;
      if (v > 0) {
        const tile: Tile = { id: nextId++, value: v, row: r, col: c };
        grid[r]![c] = tile;
        tilesAll.push(tile);
      }
    }
  }
  score = (data.score | 0) || 0;
  won = !!data.won;
  keepGoing = !!data.keepGoing;
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
  return true;
}

function tileClass(v: number): string {
  if (v >= 4096) return 'tile tile-super';
  return `tile tile-${v}`;
}

function posTransform(row: number, col: number): string {
  // tiles container is square; layout = 4 tiles + 3×10px gaps.
  // NOTE: percentages inside `translate()` are resolved against the tile's
  // OWN size, not the container — so we must compute the offset in pixels
  // from the live container width instead of using `100%`.
  const cw = tilesEl.clientWidth || 0;
  const tileSize = Math.max(0, (cw - 30) / 4);
  const step = tileSize + 10;
  return `translate(${col * step}px, ${row * step}px)`;
}

function setPos(el: HTMLDivElement, row: number, col: number): void {
  const t = posTransform(row, col);
  el.style.setProperty('--pos', t);
  el.style.transform = t;
}

function render(): void {
  tilesEl.innerHTML = '';
  for (const tile of tilesAll) {
    const el = document.createElement('div');
    el.className = tileClass(tile.value);
    el.textContent = String(tile.value);
    setPos(el, tile.row, tile.col);
    if (tile.isNew) el.classList.add('tile--new');
    if (tile.mergedFrom) el.classList.add('tile--merged');
    tilesEl.appendChild(el);
    tile.el = el;
  }
  requestAnimationFrame(() => {
    for (const tile of tilesAll) {
      tile.isNew = false;
      tile.mergedFrom = undefined;
    }
  });
}

function prepareTiles(): void {
  for (const tile of tilesAll) {
    tile.mergedFrom = undefined;
    tile.isNew = false;
  }
}

function getVector(dir: Dir): { dr: number; dc: number } {
  switch (dir) {
    case 'up':
      return { dr: -1, dc: 0 };
    case 'down':
      return { dr: 1, dc: 0 };
    case 'left':
      return { dr: 0, dc: -1 };
    case 'right':
      return { dr: 0, dc: 1 };
  }
}

function buildTraversals(dir: Dir): { rows: number[]; cols: number[] } {
  const rows = Array.from({ length: SIZE }, (_, i) => i);
  const cols = Array.from({ length: SIZE }, (_, i) => i);
  if (dir === 'down') rows.reverse();
  if (dir === 'right') cols.reverse();
  return { rows, cols };
}

function findFarthest(
  row: number,
  col: number,
  vec: { dr: number; dc: number },
): { farthest: { r: number; c: number }; next: Tile | null } {
  let prevR = row;
  let prevC = col;
  let r = row + vec.dr;
  let c = col + vec.dc;
  while (r >= 0 && r < SIZE && c >= 0 && c < SIZE && !grid[r]![c]) {
    prevR = r;
    prevC = c;
    r += vec.dr;
    c += vec.dc;
  }
  const next = r >= 0 && r < SIZE && c >= 0 && c < SIZE ? grid[r]![c] : null;
  return { farthest: { r: prevR, c: prevC }, next };
}

function move(dir: Dir): boolean {
  // Block input while the game is over, animating, or the win overlay is up
  // and the player hasn't acknowledged it yet.
  if (dead || animating || (won && !keepGoing)) return false;
  prepareTiles();
  const vec = getVector(dir);
  const { rows, cols } = buildTraversals(dir);
  let moved = false;
  const toRemove: Tile[] = [];

  for (const r of rows) {
    for (const c of cols) {
      const tile = grid[r]![c];
      if (!tile) continue;
      const { farthest, next } = findFarthest(r, c, vec);
      if (next && next.value === tile.value && !next.mergedFrom) {
        const mergedValue = tile.value * 2;
        const merged: Tile = {
          id: nextId++,
          value: mergedValue,
          row: next.row,
          col: next.col,
          mergedFrom: [tile, next],
        };
        grid[next.row]![next.col] = merged;
        grid[r]![c] = null;
        tile.row = next.row;
        tile.col = next.col;
        toRemove.push(tile, next);
        tilesAll.push(merged);
        score += mergedValue;
        if (mergedValue === 2048 && !won) won = true;
        moved = true;
      } else if (farthest.r !== r || farthest.c !== c) {
        grid[r]![c] = null;
        grid[farthest.r]![farthest.c] = tile;
        tile.row = farthest.r;
        tile.col = farthest.c;
        moved = true;
      }
    }
  }

  if (moved) {
    animating = true;
    const myGen = moveGen.current();
    // animate existing tiles to new positions
    for (const tile of tilesAll) {
      if (tile.el && !toRemove.includes(tile) && !tile.mergedFrom) {
        setPos(tile.el, tile.row, tile.col);
      }
    }
    window.setTimeout(() => {
      // If a reset happened during the animation, abandon this stale callback.
      if (!moveGen.isCurrent(myGen)) return;
      tilesAll = tilesAll.filter((t) => !toRemove.includes(t));
      spawnRandom();
      scoreEl.textContent = String(score);
      if (score > best) {
        best = score;
        bestEl.textContent = String(best);
        safeWrite(STORAGE_BEST, best);
      }
      render();
      saveState();
      animating = false;
      checkEnd();
    }, 130);
  }
  return moved;
}

function hasMoves(): boolean {
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const t = grid[r]![c];
      if (!t) return true;
      const v = t.value;
      if (r + 1 < SIZE && grid[r + 1]![c]?.value === v) return true;
      if (c + 1 < SIZE && grid[r]![c + 1]?.value === v) return true;
    }
  }
  return false;
}

function checkEnd(): void {
  if (won && !keepGoing) {
    showOverlay('Kazandın!', `2048'e ulaştın! Skor: ${score}`, 'Devam et');
    return;
  }
  if (!hasMoves()) {
    dead = true;
    // Final score for this run — submit to the global board (no-op when the
    // backend is off or the player is signed out).
    reportGameOver(SCORE_DESC, score);
    showOverlay('Bitti', `Hamle kalmadı. Skor: ${score}`, 'Yeniden başla');
  }
}

function showOverlay(title: string, msg: string, btn = 'Yeniden başla'): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  overlayBtn.textContent = btn;
  showOverlayEl(overlay);
}

function hideOverlay(): void {
  hideOverlayEl(overlay);
}

function init(): void {
  boardEl = document.querySelector<HTMLDivElement>('#board')!;
  tilesEl = document.querySelector<HTMLDivElement>('#tiles')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  overlayBtn.addEventListener('click', () => {
    if (won && !keepGoing && !dead) {
      keepGoing = true;
      hideOverlay();
      saveState();
    } else {
      reset();
    }
  });

  restartBtn.addEventListener('click', () => reset());

  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    let dir: Dir | null = null;
    if (k === 'arrowup' || k === 'w') dir = 'up';
    else if (k === 'arrowdown' || k === 's') dir = 'down';
    else if (k === 'arrowleft' || k === 'a') dir = 'left';
    else if (k === 'arrowright' || k === 'd') dir = 'right';
    else if (k === 'r') {
      reset();
      e.preventDefault();
      return;
    }
    if (dir) {
      e.preventDefault();
      move(dir);
    }
  });

  let touchStartX = 0;
  let touchStartY = 0;
  let touchActive = false;
  // ~20px is the empirical "intentional swipe" threshold on small phones
  const SWIPE_THRESHOLD = 20;

  boardEl.addEventListener(
    'touchstart',
    (e) => {
      const t = e.touches[0];
      if (!t) return;
      touchStartX = t.clientX;
      touchStartY = t.clientY;
      touchActive = true;
    },
    { passive: true },
  );

  // touchmove is intentionally a no-op handler: `touch-action: none` on the
  // board element already blocks the browser's default scroll/zoom gestures.

  boardEl.addEventListener('touchend', (e) => {
    if (!touchActive) return;
    touchActive = false;
    const t = e.changedTouches[0];
    if (!t) return;
    const dx = t.clientX - touchStartX;
    const dy = t.clientY - touchStartY;
    const absX = Math.abs(dx);
    const absY = Math.abs(dy);
    if (Math.max(absX, absY) < SWIPE_THRESHOLD) return;
    if (absX > absY) move(dx > 0 ? 'right' : 'left');
    else move(dy > 0 ? 'down' : 'up');
  });

  boardEl.addEventListener('touchcancel', () => {
    touchActive = false;
  });

  // Recompute tile positions when the board resizes (orientation change,
  // window resize, mobile keyboard, etc.). Transform is pixel-based, so a
  // stale value would leave tiles misaligned with the background grid.
  let resizeRaf = 0;
  const repositionAll = (): void => {
    for (const tile of tilesAll) {
      if (tile.el) setPos(tile.el, tile.row, tile.col);
    }
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

  if (loadState()) {
    render();
    if (won && !keepGoing) {
      showOverlay('Kazandın!', `2048'e ulaştın! Skor: ${score}`, 'Devam et');
    } else if (!hasMoves()) {
      dead = true;
      showOverlay('Bitti', `Hamle kalmadı. Skor: ${score}`, 'Yeniden başla');
    }
  } else {
    reset();
  }
}

export const game = defineGame({ init, reset: () => reset() });
