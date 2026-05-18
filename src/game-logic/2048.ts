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

const SIZE = 4;
const STORAGE_BEST = '2048.best';
const STORAGE_STATE = '2048.state';

const boardEl = document.querySelector<HTMLDivElement>('#board')!;
const tilesEl = document.querySelector<HTMLDivElement>('#tiles')!;
const scoreEl = document.querySelector<HTMLElement>('#score')!;
const bestEl = document.querySelector<HTMLElement>('#best')!;
const restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
const overlay = document.querySelector<HTMLElement>('#overlay')!;
const overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
const overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
const overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;

let grid: (Tile | null)[][] = [];
let tilesAll: Tile[] = [];
let score = 0;
let best = 0;
let nextId = 1;
let won = false;
let keepGoing = false;
let dead = false;
let animating = false;

try {
  best = Number(localStorage.getItem(STORAGE_BEST) ?? '0') || 0;
} catch {
  /* ignore */
}

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
  try {
    const flat = grid.map((row) => row.map((t) => (t ? t.value : 0)));
    localStorage.setItem(
      STORAGE_STATE,
      JSON.stringify({ grid: flat, score, won, keepGoing }),
    );
  } catch {
    /* ignore */
  }
}

function loadState(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_STATE);
    if (!raw) return false;
    const data = JSON.parse(raw) as {
      grid: number[][];
      score: number;
      won: boolean;
      keepGoing: boolean;
    };
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
    score = data.score | 0;
    won = !!data.won;
    keepGoing = !!data.keepGoing;
    scoreEl.textContent = String(score);
    bestEl.textContent = String(best);
    return true;
  } catch {
    return false;
  }
}

function tileClass(v: number): string {
  if (v >= 4096) return 'tile tile-super';
  return `tile tile-${v}`;
}

function posTransform(row: number, col: number): string {
  // tiles container has 4 cells with 10px gap; tile width = (100% - 30px) / 4
  const x = `calc((100% - 30px) / 4 * ${col} + 10px * ${col})`;
  const y = `calc((100% - 30px) / 4 * ${row} + 10px * ${row})`;
  return `translate(${x}, ${y})`;
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
    case 'up': return { dr: -1, dc: 0 };
    case 'down': return { dr: 1, dc: 0 };
    case 'left': return { dr: 0, dc: -1 };
    case 'right': return { dr: 0, dc: 1 };
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
  if (dead || animating) return false;
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
    // animate existing tiles to new positions
    for (const tile of tilesAll) {
      if (tile.el && !toRemove.includes(tile) && !tile.mergedFrom) {
        setPos(tile.el, tile.row, tile.col);
      }
    }
    window.setTimeout(() => {
      tilesAll = tilesAll.filter((t) => !toRemove.includes(t));
      spawnRandom();
      scoreEl.textContent = String(score);
      if (score > best) {
        best = score;
        bestEl.textContent = String(best);
        try {
          localStorage.setItem(STORAGE_BEST, String(best));
        } catch {
          /* ignore */
        }
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
    showOverlay('Bitti', `Hamle kalmadı. Skor: ${score}`, 'Yeniden başla');
  }
}

function showOverlay(title: string, msg: string, btn = 'Yeniden başla'): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  overlayBtn.textContent = btn;
  overlay.classList.remove('overlay--hidden');
}

function hideOverlay(): void {
  overlay.classList.add('overlay--hidden');
}

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

boardEl.addEventListener('touchend', (e) => {
  if (!touchActive) return;
  touchActive = false;
  const t = e.changedTouches[0];
  if (!t) return;
  const dx = t.clientX - touchStartX;
  const dy = t.clientY - touchStartY;
  const absX = Math.abs(dx);
  const absY = Math.abs(dy);
  if (Math.max(absX, absY) < 24) return;
  if (absX > absY) move(dx > 0 ? 'right' : 'left');
  else move(dy > 0 ? 'down' : 'up');
});

// Init
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
