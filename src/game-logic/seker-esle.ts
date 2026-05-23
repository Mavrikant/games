import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';

const SIZE = 8;
const MAX_COLORS = 7;
const STORAGE_LEVEL = 'seker-esle.level';
const STORAGE_BEST = 'seker-esle.best';

type State = 'idle' | 'animating' | 'level_complete' | 'level_failed';

interface Tile {
  id: number;
  color: number;
  row: number;
  col: number;
  el: HTMLDivElement;
}

let boardEl!: HTMLDivElement;
let tilesEl!: HTMLDivElement;
let levelEl!: HTMLElement;
let targetEl!: HTMLElement;
let scoreEl!: HTMLElement;
let movesEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayBtn!: HTMLButtonElement;

let grid: (Tile | null)[][] = [];
let state: State = 'idle';
let level = 1;
let best = 1;
let score = 0;
let movesLeft = 0;
let target = 0;
let colorCount = 4;
let cascadeDepth = 0;
let nextId = 1;
let selected: { row: number; col: number } | null = null;
const gen = createGenToken();

function colorsForLevel(lv: number): number {
  return Math.min(MAX_COLORS, 4 + Math.floor((lv - 1) / 4));
}

function targetForLevel(lv: number): number {
  return 200 + 150 * lv;
}

function movesForLevel(lv: number): number {
  return Math.max(12, 22 - Math.floor(lv / 3));
}

function emptyGrid(): (Tile | null)[][] {
  return Array.from({ length: SIZE }, () => Array<Tile | null>(SIZE).fill(null));
}

function posTransform(row: number, col: number): string {
  // tiles container uses padding:10px and 4px gap between cells.
  // step = (containerInner - (SIZE-1)*gap) / SIZE + gap
  const cw = tilesEl.clientWidth || 0;
  const gap = 4;
  const tileSize = Math.max(0, (cw - gap * (SIZE - 1)) / SIZE);
  const step = tileSize + gap;
  return `translate3d(${col * step}px, ${row * step}px, 0)`;
}

function setTilePos(tile: Tile): void {
  tile.el.style.transform = posTransform(tile.row, tile.col);
  tile.el.dataset.row = String(tile.row);
  tile.el.dataset.col = String(tile.col);
}

function createTileEl(color: number, row: number, col: number): HTMLDivElement {
  const el = document.createElement('div');
  el.className = `tile tile--c${color}`;
  el.dataset.row = String(row);
  el.dataset.col = String(col);
  el.setAttribute('role', 'gridcell');
  el.setAttribute('aria-label', `Şeker ${color + 1}`);
  return el;
}

function pickColorAvoiding(row: number, col: number, current: (Tile | null)[][]): number {
  // Avoid creating a horizontal or vertical run of 3 with already-placed tiles.
  const forbidden = new Set<number>();
  if (col >= 2) {
    const a = current[row]?.[col - 1]?.color;
    const b = current[row]?.[col - 2]?.color;
    if (a !== undefined && a === b) forbidden.add(a);
  }
  if (row >= 2) {
    const a = current[row - 1]?.[col]?.color;
    const b = current[row - 2]?.[col]?.color;
    if (a !== undefined && a === b) forbidden.add(a);
  }
  const choices: number[] = [];
  for (let i = 0; i < colorCount; i++) {
    if (!forbidden.has(i)) choices.push(i);
  }
  if (choices.length === 0) return Math.floor(Math.random() * colorCount);
  return choices[Math.floor(Math.random() * choices.length)]!;
}

function rebuildBoard(): void {
  // Tear down DOM tiles and grid.
  tilesEl.innerHTML = '';
  grid = emptyGrid();
  selected = null;

  // Generate matchless initial layout. Place tiles synchronously with
  // transitions suppressed so the first paint shows the full grid in
  // position — without a (0,0) → target slide flash.
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const color = pickColorAvoiding(r, c, grid);
      const el = createTileEl(color, r, c);
      el.style.transition = 'none';
      tilesEl.appendChild(el);
      const tile: Tile = { id: nextId++, color, row: r, col: c, el };
      grid[r]![c] = tile;
      setTilePos(tile);
    }
  }

  // After the first paint, re-enable transitions for subsequent moves.
  requestAnimationFrame(() => {
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const t = grid[r]![c];
        if (t) t.el.style.transition = '';
      }
    }
  });

  // Safety net: ensure no accidental matches at deal time.
  // (If forbidden-set logic ever fails — e.g. all colors blocked — reshuffle.)
  if (findMatches().size > 0) {
    rebuildBoard();
  }
}

function findMatches(): Set<Tile> {
  const matched = new Set<Tile>();
  // Horizontal runs
  for (let r = 0; r < SIZE; r++) {
    let runStart = 0;
    for (let c = 1; c <= SIZE; c++) {
      const prev = grid[r]![c - 1];
      const cur = c < SIZE ? grid[r]![c] : null;
      const same = !!prev && !!cur && prev.color === cur.color;
      if (!same) {
        if (c - runStart >= 3) {
          for (let k = runStart; k < c; k++) {
            const t = grid[r]![k];
            if (t) matched.add(t);
          }
        }
        runStart = c;
      }
    }
  }
  // Vertical runs
  for (let c = 0; c < SIZE; c++) {
    let runStart = 0;
    for (let r = 1; r <= SIZE; r++) {
      const prev = grid[r - 1]![c];
      const cur = r < SIZE ? grid[r]![c] : null;
      const same = !!prev && !!cur && prev.color === cur.color;
      if (!same) {
        if (r - runStart >= 3) {
          for (let k = runStart; k < r; k++) {
            const t = grid[k]![c];
            if (t) matched.add(t);
          }
        }
        runStart = r;
      }
    }
  }
  return matched;
}

function scoreForRun(n: number): number {
  if (n <= 3) return 30;
  if (n === 4) return 60;
  return 100;
}

function groupSizes(matched: Set<Tile>): number[] {
  // Approximate per-run scoring: count consecutive runs per row/col within matched set.
  const sizes: number[] = [];
  // Rows
  for (let r = 0; r < SIZE; r++) {
    let run = 0;
    let runColor = -1;
    for (let c = 0; c <= SIZE; c++) {
      const t = c < SIZE ? grid[r]![c] : null;
      if (t && matched.has(t) && t.color === runColor) {
        run++;
      } else {
        if (run >= 3) sizes.push(run);
        run = t && matched.has(t) ? 1 : 0;
        runColor = t && matched.has(t) ? t.color : -1;
      }
    }
  }
  // Cols
  for (let c = 0; c < SIZE; c++) {
    let run = 0;
    let runColor = -1;
    for (let r = 0; r <= SIZE; r++) {
      const t = r < SIZE ? grid[r]![c] : null;
      if (t && matched.has(t) && t.color === runColor) {
        run++;
      } else {
        if (run >= 3) sizes.push(run);
        run = t && matched.has(t) ? 1 : 0;
        runColor = t && matched.has(t) ? t.color : -1;
      }
    }
  }
  return sizes;
}

function applyMatches(matched: Set<Tile>): number {
  const sizes = groupSizes(matched);
  let gained = 0;
  for (const n of sizes) gained += scoreForRun(n);
  gained *= cascadeDepth; // depth starts at 1 on first pass
  // Mark for animation
  for (const t of matched) {
    t.el.classList.add('tile--matched');
  }
  return gained;
}

function removeMatched(matched: Set<Tile>): void {
  for (const t of matched) {
    grid[t.row]![t.col] = null;
    t.el.remove();
  }
}

function applyGravityAndRefill(): void {
  for (let c = 0; c < SIZE; c++) {
    // Compact column downward.
    let write = SIZE - 1;
    for (let r = SIZE - 1; r >= 0; r--) {
      const t = grid[r]![c];
      if (t) {
        if (write !== r) {
          grid[write]![c] = t;
          grid[r]![c] = null;
          t.row = write;
          setTilePos(t);
        }
        write--;
      }
    }
    // Fill remaining slots from top with new tiles starting offscreen.
    let newRow = -1;
    for (let r = write; r >= 0; r--) {
      const color = Math.floor(Math.random() * colorCount);
      const el = createTileEl(color, r, c);
      tilesEl.appendChild(el);
      // Start offscreen (above), then animate to position next frame.
      el.style.transform = posTransform(newRow, c);
      newRow--;
      const tile: Tile = { id: nextId++, color, row: r, col: c, el };
      grid[r]![c] = tile;
    }
  }
  // Next frame: place new tiles at target positions (transitions trigger).
  requestAnimationFrame(() => {
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const t = grid[r]![c];
        if (t) setTilePos(t);
      }
    }
  });
}

function hasAnyMove(): boolean {
  // Try every horizontal & vertical adjacent swap, check if it produces a match.
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (c + 1 < SIZE && trySwapMatch(r, c, r, c + 1)) return true;
      if (r + 1 < SIZE && trySwapMatch(r, c, r + 1, c)) return true;
    }
  }
  return false;
}

function trySwapMatch(r1: number, c1: number, r2: number, c2: number): boolean {
  const a = grid[r1]![c1];
  const b = grid[r2]![c2];
  if (!a || !b) return false;
  const ac = a.color;
  const bc = b.color;
  a.color = bc;
  b.color = ac;
  const matched = findMatches().size > 0;
  a.color = ac;
  b.color = bc;
  return matched;
}

function shuffleBoard(): void {
  // Collect all colors, shuffle, re-assign. Retry until no initial matches AND a move exists.
  for (let attempt = 0; attempt < 30; attempt++) {
    const colors: number[] = [];
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const t = grid[r]![c];
        if (t) colors.push(t.color);
      }
    }
    for (let i = colors.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = colors[i]!;
      colors[i] = colors[j]!;
      colors[j] = tmp;
    }
    let idx = 0;
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const t = grid[r]![c];
        if (t) {
          t.color = colors[idx++]!;
          t.el.className = `tile tile--c${t.color}`;
          t.el.setAttribute('aria-label', `Şeker ${t.color + 1}`);
        }
      }
    }
    if (findMatches().size === 0 && hasAnyMove()) return;
  }
  // Fallback — rebuild entire board if shuffling failed.
  rebuildBoard();
}

function updateHud(): void {
  levelEl.textContent = String(level);
  targetEl.textContent = String(target);
  scoreEl.textContent = String(score);
  movesEl.textContent = String(movesLeft);
  bestEl.textContent = String(best);
}

function startLevel(lv: number): void {
  gen.bump();
  level = lv;
  if (level > best) best = level;
  colorCount = colorsForLevel(level);
  target = targetForLevel(level);
  movesLeft = movesForLevel(level);
  score = 0;
  cascadeDepth = 0;
  state = 'idle';
  hideOverlayEl(overlay);
  updateHud();
  rebuildBoard();
  persist();
}

function persist(): void {
  safeWrite(STORAGE_LEVEL, level);
  safeWrite(STORAGE_BEST, best);
}

function isAdjacent(r1: number, c1: number, r2: number, c2: number): boolean {
  const dr = Math.abs(r1 - r2);
  const dc = Math.abs(c1 - c2);
  return dr + dc === 1;
}

function setSelected(row: number | null, col: number | null): void {
  // Clear previous
  if (selected) {
    const prev = grid[selected.row]?.[selected.col];
    if (prev) prev.el.classList.remove('tile--selected');
  }
  if (row === null || col === null) {
    selected = null;
    return;
  }
  const next = grid[row]?.[col];
  if (!next) {
    selected = null;
    return;
  }
  next.el.classList.add('tile--selected');
  selected = { row, col };
}

function swapTiles(r1: number, c1: number, r2: number, c2: number): void {
  const a = grid[r1]![c1]!;
  const b = grid[r2]![c2]!;
  grid[r1]![c1] = b;
  grid[r2]![c2] = a;
  a.row = r2;
  a.col = c2;
  b.row = r1;
  b.col = c1;
  setTilePos(a);
  setTilePos(b);
}

function attemptSwap(r1: number, c1: number, r2: number, c2: number): void {
  state = 'animating';
  setSelected(null, null);
  swapTiles(r1, c1, r2, c2);
  const myGen = gen.current();
  window.setTimeout(() => {
    if (!gen.isCurrent(myGen)) return;
    const matched = findMatches();
    if (matched.size === 0) {
      // Revert
      swapTiles(r1, c1, r2, c2);
      window.setTimeout(() => {
        if (!gen.isCurrent(myGen)) return;
        state = 'idle';
      }, 220);
      return;
    }
    // Valid move: count it, then resolve cascade.
    movesLeft--;
    updateHud();
    cascadeDepth = 0;
    resolveCascade(myGen);
  }, 220);
}

function resolveCascade(myGen: number): void {
  if (!gen.isCurrent(myGen)) return;
  const matched = findMatches();
  if (matched.size === 0) {
    // Cascade ended.
    finishMove(myGen);
    return;
  }
  cascadeDepth++;
  const gained = applyMatches(matched);
  score += gained;
  updateHud();
  window.setTimeout(() => {
    if (!gen.isCurrent(myGen)) return;
    removeMatched(matched);
    applyGravityAndRefill();
    window.setTimeout(() => {
      if (!gen.isCurrent(myGen)) return;
      resolveCascade(myGen);
    }, 280);
  }, 220);
}

function finishMove(myGen: number): void {
  if (!gen.isCurrent(myGen)) return;
  // Level outcome check.
  if (score >= target) {
    state = 'level_complete';
    level += 1;
    if (level > best) best = level;
    persist();
    showLevelComplete();
    return;
  }
  if (movesLeft <= 0) {
    state = 'level_failed';
    const newLevel = Math.max(1, level - 1);
    const droppedTo = newLevel;
    level = newLevel;
    persist();
    showLevelFailed(droppedTo);
    return;
  }
  // Deadlock check.
  if (!hasAnyMove()) {
    shuffleBoard();
  }
  state = 'idle';
}

function showLevelComplete(): void {
  overlayTitle.textContent = 'Seviye tamam!';
  overlayMsg.textContent = `Hedefe ulaştın. Seviye ${level} başlıyor.`;
  overlayBtn.textContent = 'Sonraki Seviye';
  showOverlayEl(overlay);
}

function showLevelFailed(droppedTo: number): void {
  overlayTitle.textContent = 'Hamleler bitti';
  overlayMsg.textContent = `Hedefe ulaşamadın. Seviye ${droppedTo}'e düşüldü.`;
  overlayBtn.textContent = 'Tekrar Dene';
  showOverlayEl(overlay);
}

function onBoardClick(e: MouseEvent): void {
  if (state !== 'idle') return;
  const target = (e.target as HTMLElement | null)?.closest('.tile') as HTMLElement | null;
  if (!target) return;
  const row = Number(target.dataset.row);
  const col = Number(target.dataset.col);
  if (Number.isNaN(row) || Number.isNaN(col)) return;
  if (!selected) {
    setSelected(row, col);
    return;
  }
  if (selected.row === row && selected.col === col) {
    setSelected(null, null);
    return;
  }
  if (isAdjacent(selected.row, selected.col, row, col)) {
    const from = selected;
    attemptSwap(from.row, from.col, row, col);
    return;
  }
  // Non-adjacent: change selection.
  setSelected(row, col);
}

function reset(): void {
  // Restart current level from scratch (board, score, moves).
  startLevel(level);
}

function init(): void {
  boardEl = document.querySelector<HTMLDivElement>('#board')!;
  tilesEl = document.querySelector<HTMLDivElement>('#tiles')!;
  levelEl = document.querySelector<HTMLElement>('#level')!;
  targetEl = document.querySelector<HTMLElement>('#target')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  movesEl = document.querySelector<HTMLElement>('#moves')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;

  level = Math.max(1, safeRead<number>(STORAGE_LEVEL, 1));
  best = Math.max(1, safeRead<number>(STORAGE_BEST, 1));

  boardEl.addEventListener('click', onBoardClick);

  restartBtn.addEventListener('click', () => reset());

  overlayBtn.addEventListener('click', () => {
    // Both level-complete and level-failed kick off the (possibly new) current level.
    startLevel(level);
  });

  // Recompute tile positions when board resizes (orientation, window resize).
  let resizeRaf = 0;
  const repositionAll = (): void => {
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const t = grid[r]![c];
        if (t) t.el.style.transform = posTransform(t.row, t.col);
      }
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

  startLevel(level);
}

export const game = defineGame({ init, reset });
