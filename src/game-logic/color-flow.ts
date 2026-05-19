/* Color Flow — Flow Free style puzzle: drag from each endpoint to its twin,
   fill every cell, paths never cross. Generation uses random self-avoiding
   walks that together tile the entire grid, guaranteeing solvability. */

type GameState = 'playing' | 'won';

interface Level {
  size: number;
  colors: number;
}

interface Endpoint {
  r: number;
  c: number;
  color: number;
}

interface Puzzle {
  size: number;
  colors: number;
  endpoints: Endpoint[]; // 2 per color
  // Optional reference solution from generator (not shown — used only as a
  // generation-time witness of solvability).
  solutionPaths: Path[];
}

type Path = Array<{ r: number; c: number }>;

const LEVELS: Level[] = [
  { size: 5, colors: 4 },
  { size: 5, colors: 5 },
  { size: 6, colors: 5 },
  { size: 6, colors: 6 },
  { size: 7, colors: 6 },
  { size: 7, colors: 7 },
  { size: 8, colors: 7 },
  { size: 8, colors: 8 },
];

// Up to 8 visually distinct, color-blind aware palette (varying hue +
// brightness so each color is also distinguishable by its luminance).
const COLOR_PALETTE = [
  '#ef4444', // red
  '#3b82f6', // blue
  '#f59e0b', // amber
  '#22d3ee', // cyan
  '#10b981', // emerald
  '#a855f7', // purple
  '#ec4899', // pink
  '#facc15', // yellow
];

const STORAGE_LEVEL = 'color-flow.level';
const STORAGE_BEST_PREFIX = 'color-flow.bestMoves.';

const boardEl = document.querySelector<HTMLCanvasElement>('#cf-board')!;
const levelEl = document.querySelector<HTMLElement>('#cf-level')!;
const movesEl = document.querySelector<HTMLElement>('#cf-moves')!;
const bestEl = document.querySelector<HTMLElement>('#cf-best')!;
const sizeEl = document.querySelector<HTMLElement>('#cf-size')!;
const statusEl = document.querySelector<HTMLElement>('#cf-status')!;
const newBtn = document.querySelector<HTMLButtonElement>('#cf-new')!;
const restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
const overlay = document.querySelector<HTMLElement>('#cf-overlay')!;
const overlayTitle = document.querySelector<HTMLElement>('#cf-overlay-title')!;
const overlayMsg = document.querySelector<HTMLElement>('#cf-overlay-msg')!;
const overlayNext = document.querySelector<HTMLButtonElement>('#cf-overlay-next')!;

const ctx = boardEl.getContext('2d')!;

// State
let levelIndex = 0;
let puzzle: Puzzle = makeFallbackPuzzle();
let paths: Path[] = []; // paths[color] = sequence of {r,c} including endpoints
let moves = 0;
let state: GameState = 'playing';
// Token bumped on every reset/newPuzzle/levelChange. Async callbacks check
// `if (myToken !== currentToken) return;` to drop stale work.
let genToken = 0;

// Active drag state
let dragColor = -1; // -1 = no drag
let dragPointerId = -1;
let lastCell: { r: number; c: number } | null = null;

// ────────────────────────────────────────────────────────────────────────
// Storage helpers — guarded against private-mode throws (pitfall: unguarded-storage)
// ────────────────────────────────────────────────────────────────────────

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
    /* ignore */
  }
}

function loadLevel(): number {
  const raw = safeRead(STORAGE_LEVEL);
  const n = raw === null ? 0 : Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.floor(n), LEVELS.length - 1);
}
function saveLevel(): void {
  safeWrite(STORAGE_LEVEL, String(levelIndex));
}

function bestKey(idx: number): string {
  return STORAGE_BEST_PREFIX + String(idx);
}
function loadBest(idx: number): number | null {
  const raw = safeRead(bestKey(idx));
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function saveBest(idx: number, m: number): void {
  safeWrite(bestKey(idx), String(m));
}

// ────────────────────────────────────────────────────────────────────────
// Puzzle generation — random self-avoiding walks that together tile the grid
// ────────────────────────────────────────────────────────────────────────

const DIRS: Array<[number, number]> = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];

function inBounds(r: number, c: number, size: number): boolean {
  return r >= 0 && r < size && c >= 0 && c < size;
}

function countEmptyNeighbors(
  r: number,
  c: number,
  size: number,
  occupied: Int8Array,
): number {
  let n = 0;
  for (const [dr, dc] of DIRS) {
    const nr = r + dr;
    const nc = c + dc;
    if (inBounds(nr, nc, size) && occupied[nr * size + nc] === -1) n++;
  }
  return n;
}

// Pick a starting cell for a new path, preferring corners/edges (cells with
// fewer empty neighbors). Helps avoid leaving isolated holes.
function pickStartCell(size: number, occupied: Int8Array): [number, number] | null {
  let best: [number, number] | null = null;
  let bestScore = Infinity;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (occupied[r * size + c] !== -1) continue;
      const empties = countEmptyNeighbors(r, c, size, occupied);
      // Score: fewer empty neighbors = better (more constrained). Tie-break randomly.
      const score = empties + Math.random() * 0.5;
      if (score < bestScore) {
        bestScore = score;
        best = [r, c];
      }
    }
  }
  return best;
}

/* Grow a self-avoiding random walk from (sr,sc). Bias toward cells whose
   neighbors have the fewest remaining empties — this hugs walls and other
   paths so we don't strand single empty cells. */
function growPath(
  size: number,
  occupied: Int8Array,
  color: number,
  sr: number,
  sc: number,
  maxLen: number,
): Path {
  const path: Path = [{ r: sr, c: sc }];
  occupied[sr * size + sc] = color;

  while (path.length < maxLen) {
    const head = path[path.length - 1]!;
    const candidates: Array<{ r: number; c: number; score: number }> = [];
    for (const [dr, dc] of DIRS) {
      const nr = head.r + dr;
      const nc = head.c + dc;
      if (!inBounds(nr, nc, size)) continue;
      if (occupied[nr * size + nc] !== -1) continue;
      // Prefer cells with fewer empty neighbors (avoid creating holes).
      const empties = countEmptyNeighbors(nr, nc, size, occupied);
      candidates.push({ r: nr, c: nc, score: empties + Math.random() * 0.4 });
    }
    if (candidates.length === 0) break;
    candidates.sort((a, b) => a.score - b.score);
    const next = candidates[0]!;
    path.push({ r: next.r, c: next.c });
    occupied[next.r * size + next.c] = color;
  }
  return path;
}

function makeFallbackPuzzle(): Puzzle {
  // Simple known-good 5x5 used if generation fails for some reason.
  // Two parallel snakes that together tile the grid.
  const size = 5;
  // Path R: row 0 left→right, row 1 right→left, row 2 left→right
  // Path B: row 3 right→left, row 4 left→right (only 2 colors → degenerate)
  // We instead use 4 small paths that tile a 5x5:
  const paths4: Path[] = [
    [
      { r: 0, c: 0 },
      { r: 0, c: 1 },
      { r: 0, c: 2 },
      { r: 1, c: 2 },
      { r: 1, c: 1 },
      { r: 1, c: 0 },
      { r: 2, c: 0 },
      { r: 2, c: 1 },
    ],
    [
      { r: 0, c: 3 },
      { r: 0, c: 4 },
      { r: 1, c: 4 },
      { r: 1, c: 3 },
      { r: 2, c: 3 },
      { r: 2, c: 4 },
    ],
    [
      { r: 2, c: 2 },
      { r: 3, c: 2 },
      { r: 3, c: 1 },
      { r: 3, c: 0 },
      { r: 4, c: 0 },
      { r: 4, c: 1 },
      { r: 4, c: 2 },
    ],
    [
      { r: 3, c: 3 },
      { r: 3, c: 4 },
      { r: 4, c: 4 },
      { r: 4, c: 3 },
    ],
  ];
  const endpoints: Endpoint[] = [];
  for (let i = 0; i < paths4.length; i++) {
    const p = paths4[i]!;
    endpoints.push({ ...p[0]!, color: i });
    endpoints.push({ ...p[p.length - 1]!, color: i });
  }
  return { size, colors: 4, endpoints, solutionPaths: paths4 };
}

function generatePuzzle(level: Level): Puzzle {
  const { size } = level;
  let targetColors = level.colors;
  const MAX_ATTEMPTS = 30;

  while (targetColors >= 2) {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const result = tryGenerate(size, targetColors);
      if (result) return result;
    }
    // Couldn't generate with this many colors — try fewer.
    targetColors--;
  }
  return makeFallbackPuzzle();
}

function tryGenerate(size: number, colors: number): Puzzle | null {
  const total = size * size;
  const occupied = new Int8Array(total).fill(-1);
  const solutionPaths: Path[] = [];

  // Roughly even path lengths. Last color may absorb the remainder.
  const baseLen = Math.floor(total / colors);

  for (let color = 0; color < colors; color++) {
    const remainingCells = total - countOccupied(occupied);
    const remainingColors = colors - color;
    if (remainingCells < remainingColors * 2) return null; // not enough room for endpoints
    const start = pickStartCell(size, occupied);
    if (!start) return null;
    // Target length: ~baseLen, but last color takes whatever's left.
    let target =
      color === colors - 1
        ? remainingCells
        : Math.max(2, Math.min(baseLen + Math.floor(Math.random() * 3) - 1, remainingCells - (remainingColors - 1) * 2));
    const path = growPath(size, occupied, color, start[0], start[1], target);
    if (path.length < 2) return null;
    solutionPaths.push(path);
  }

  if (countOccupied(occupied) !== total) return null;

  // Sanity: no two endpoints share a cell, no path length <2.
  const endpointSet = new Set<number>();
  const endpoints: Endpoint[] = [];
  for (let i = 0; i < solutionPaths.length; i++) {
    const p = solutionPaths[i]!;
    if (p.length < 2) return null;
    const head = p[0]!;
    const tail = p[p.length - 1]!;
    const hKey = head.r * size + head.c;
    const tKey = tail.r * size + tail.c;
    if (endpointSet.has(hKey) || endpointSet.has(tKey) || hKey === tKey) return null;
    endpointSet.add(hKey);
    endpointSet.add(tKey);
    endpoints.push({ r: head.r, c: head.c, color: i });
    endpoints.push({ r: tail.r, c: tail.c, color: i });
  }

  return { size, colors, endpoints, solutionPaths };
}

function countOccupied(occupied: Int8Array): number {
  let n = 0;
  for (let i = 0; i < occupied.length; i++) if (occupied[i] !== -1) n++;
  return n;
}

// ────────────────────────────────────────────────────────────────────────
// Game state helpers
// ────────────────────────────────────────────────────────────────────────

function endpointAt(r: number, c: number): Endpoint | null {
  for (const e of puzzle.endpoints) {
    if (e.r === r && e.c === c) return e;
  }
  return null;
}

function getPathContaining(r: number, c: number): { color: number; index: number } | null {
  for (let color = 0; color < paths.length; color++) {
    const p = paths[color]!;
    for (let i = 0; i < p.length; i++) {
      const cell = p[i]!;
      if (cell.r === r && cell.c === c) return { color, index: i };
    }
  }
  return null;
}

function cellOwner(r: number, c: number): number {
  // Returns color index that owns this cell, or -1 if free.
  for (let color = 0; color < paths.length; color++) {
    const p = paths[color]!;
    for (let i = 0; i < p.length; i++) {
      const cell = p[i]!;
      if (cell.r === r && cell.c === c) return color;
    }
  }
  return -1;
}

function isAdjacent(a: { r: number; c: number }, b: { r: number; c: number }): boolean {
  const dr = Math.abs(a.r - b.r);
  const dc = Math.abs(a.c - b.c);
  return (dr === 1 && dc === 0) || (dr === 0 && dc === 1);
}

function isPathComplete(color: number): boolean {
  const p = paths[color]!;
  if (p.length < 2) return false;
  const start = p[0]!;
  const end = p[p.length - 1]!;
  const startIsEndpoint = isEndpointOf(start.r, start.c, color);
  const endIsEndpoint = isEndpointOf(end.r, end.c, color);
  return startIsEndpoint && endIsEndpoint;
}

function isEndpointOf(r: number, c: number, color: number): boolean {
  for (const e of puzzle.endpoints) {
    if (e.color === color && e.r === r && e.c === c) return true;
  }
  return false;
}

function totalCellsFilled(): number {
  let n = 0;
  for (const p of paths) n += p.length;
  return n;
}

function checkWin(): boolean {
  if (totalCellsFilled() !== puzzle.size * puzzle.size) return false;
  for (let color = 0; color < puzzle.colors; color++) {
    if (!isPathComplete(color)) return false;
  }
  return true;
}

// ────────────────────────────────────────────────────────────────────────
// Drag handling
// ────────────────────────────────────────────────────────────────────────

function startDragFromEndpoint(color: number, r: number, c: number): void {
  // Reset this color's path; start fresh from the chosen endpoint.
  paths[color] = [{ r, c }];
  dragColor = color;
  lastCell = { r, c };
}

function startDragFromPath(color: number, index: number): void {
  // User pressed on an existing path cell — truncate path up to here and continue.
  const p = paths[color]!;
  paths[color] = p.slice(0, index + 1);
  dragColor = color;
  const tail = paths[color]![paths[color]!.length - 1]!;
  lastCell = { r: tail.r, c: tail.c };
}

function extendDragTo(r: number, c: number): boolean {
  if (dragColor < 0 || !lastCell) return false;
  if (r === lastCell.r && c === lastCell.c) return false;
  if (!isAdjacent(lastCell, { r, c })) return false;

  const path = paths[dragColor]!;

  // If user dragged back over their own path tail, truncate.
  for (let i = 0; i < path.length - 1; i++) {
    const cell = path[i]!;
    if (cell.r === r && cell.c === c) {
      paths[dragColor] = path.slice(0, i + 1);
      lastCell = { ...cell };
      drawAll();
      return true;
    }
  }

  // Can't enter our own path's tail-area again (would create a loop).
  if (path.some((cell) => cell.r === r && cell.c === c)) return false;

  // Endpoint check: target is an endpoint of a different color → blocked.
  const ep = endpointAt(r, c);
  if (ep && ep.color !== dragColor) return false;

  // If target is the other endpoint of OUR color, complete the path.
  if (ep && ep.color === dragColor) {
    path.push({ r, c });
    lastCell = { r, c };
    drawAll();
    // Win check happens on pointerup; reaching the partner endpoint mid-drag
    // doesn't end the drag (user can still drag back to shorten).
    return true;
  }

  // Target cell occupied by another color's path → cut that color's path back
  // (Flow Free behavior). Splice their path so it no longer includes this cell
  // or anything after it.
  const occ = cellOwner(r, c);
  if (occ !== -1 && occ !== dragColor) {
    const occPath = paths[occ]!;
    let cutIndex = -1;
    for (let i = 0; i < occPath.length; i++) {
      const cell = occPath[i]!;
      if (cell.r === r && cell.c === c) {
        cutIndex = i;
        break;
      }
    }
    if (cutIndex !== -1) {
      paths[occ] = occPath.slice(0, cutIndex);
    }
  }

  // Extend our path into the cell.
  path.push({ r, c });
  lastCell = { r, c };
  drawAll();
  return true;
}

function cancelDrag(): void {
  dragColor = -1;
  lastCell = null;
  if (dragPointerId !== -1 && boardEl.hasPointerCapture?.(dragPointerId)) {
    try {
      boardEl.releasePointerCapture(dragPointerId);
    } catch {
      /* ignore */
    }
  }
  dragPointerId = -1;
}

// ────────────────────────────────────────────────────────────────────────
// Rendering
// ────────────────────────────────────────────────────────────────────────

interface Geom {
  size: number;
  cellPx: number;
  pad: number;
  cssWidth: number;
}

let geom: Geom = { size: 5, cellPx: 60, pad: 6, cssWidth: 300 };

function recomputeGeom(): void {
  // Find largest cellPx so that grid + padding fits the available width.
  const sz = puzzle.size;
  // Determine target CSS width: use the wrapper's clientWidth (clamped).
  const wrap = boardEl.parentElement!;
  const available = Math.max(240, Math.min(wrap.clientWidth, 560));
  // Padding scaled with cell.
  const pad = 4;
  const cell = Math.floor((available - pad * 2) / sz);
  const cssWidth = cell * sz + pad * 2;

  geom = { size: sz, cellPx: cell, pad, cssWidth };

  const dpr = Math.max(1, window.devicePixelRatio || 1);
  boardEl.style.width = `${cssWidth}px`;
  boardEl.style.height = `${cssWidth}px`;
  boardEl.width = Math.round(cssWidth * dpr);
  boardEl.height = Math.round(cssWidth * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function cellCenter(r: number, c: number): { x: number; y: number } {
  return {
    x: geom.pad + c * geom.cellPx + geom.cellPx / 2,
    y: geom.pad + r * geom.cellPx + geom.cellPx / 2,
  };
}

function pointToCell(clientX: number, clientY: number): { r: number; c: number } | null {
  const rect = boardEl.getBoundingClientRect();
  const x = clientX - rect.left - geom.pad;
  const y = clientY - rect.top - geom.pad;
  if (x < 0 || y < 0) return null;
  const c = Math.floor(x / geom.cellPx);
  const r = Math.floor(y / geom.cellPx);
  if (!inBounds(r, c, puzzle.size)) return null;
  return { r, c };
}

function drawAll(): void {
  const w = geom.cssWidth;
  ctx.clearRect(0, 0, w, w);

  // Background panel
  ctx.fillStyle = '#0f1118';
  ctx.fillRect(0, 0, w, w);

  // Grid lines
  ctx.strokeStyle = '#1f242c';
  ctx.lineWidth = 1;
  for (let i = 0; i <= puzzle.size; i++) {
    const p = geom.pad + i * geom.cellPx;
    ctx.beginPath();
    ctx.moveTo(geom.pad, p);
    ctx.lineTo(geom.pad + puzzle.size * geom.cellPx, p);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(p, geom.pad);
    ctx.lineTo(p, geom.pad + puzzle.size * geom.cellPx);
    ctx.stroke();
  }

  // Draw paths as wide rounded strokes.
  const lineW = Math.max(8, Math.floor(geom.cellPx * 0.55));
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = lineW;

  for (let color = 0; color < paths.length; color++) {
    const path = paths[color]!;
    if (path.length === 0) continue;
    const stroke = COLOR_PALETTE[color % COLOR_PALETTE.length]!;
    // Soft outer halo for depth
    ctx.globalAlpha = 0.18;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lineW + 4;
    drawPathStroke(path);

    ctx.globalAlpha = 1;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lineW;
    drawPathStroke(path);

    // If path is just an endpoint (length 1), no stroke is drawn; that's fine.
  }
  ctx.globalAlpha = 1;

  // Draw endpoints (always on top of paths)
  const epR = Math.max(6, Math.floor(geom.cellPx * 0.32));
  for (const ep of puzzle.endpoints) {
    const { x, y } = cellCenter(ep.r, ep.c);
    const color = COLOR_PALETTE[ep.color % COLOR_PALETTE.length]!;
    // Subtle outer glow
    const grad = ctx.createRadialGradient(x, y, 0, x, y, epR * 1.8);
    grad.addColorStop(0, color);
    grad.addColorStop(0.55, color);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, epR * 1.6, 0, Math.PI * 2);
    ctx.fill();

    // Solid disk
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, epR, 0, Math.PI * 2);
    ctx.fill();

    // Inner highlight (for accessibility — different brightness per color)
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath();
    ctx.arc(x - epR * 0.3, y - epR * 0.3, epR * 0.3, 0, Math.PI * 2);
    ctx.fill();

    // Ring if path is completed (visual feedback)
    if (isPathComplete(ep.color)) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = Math.max(2, Math.floor(epR * 0.2));
      ctx.beginPath();
      ctx.arc(x, y, epR + 3, 0, Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = lineW;
    }
  }
}

function drawPathStroke(path: Path): void {
  if (path.length === 0) return;
  if (path.length === 1) return;
  ctx.beginPath();
  const first = cellCenter(path[0]!.r, path[0]!.c);
  ctx.moveTo(first.x, first.y);
  for (let i = 1; i < path.length; i++) {
    const p = cellCenter(path[i]!.r, path[i]!.c);
    ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();
}

// ────────────────────────────────────────────────────────────────────────
// Win + level progression
// ────────────────────────────────────────────────────────────────────────

function win(): void {
  state = 'won';
  cancelDrag();
  const prev = loadBest(levelIndex);
  let isBest = false;
  if (prev === null || moves < prev) {
    saveBest(levelIndex, moves);
    isBest = true;
  }
  renderBest();
  overlayTitle.textContent = isBest ? 'Yeni rekor!' : 'Seviye tamam!';
  overlayMsg.textContent = isBest
    ? `${moves} hamle — en iyi skorun!`
    : `${moves} hamle ile bitirdin.`;
  const nextExists = levelIndex < LEVELS.length - 1;
  overlayNext.textContent = nextExists ? 'Sonraki seviye' : 'Baştan başla';
  overlay.classList.remove('cf-overlay--hidden');
  statusEl.textContent = `Tüm yollar tamamlandı (${moves} hamle).`;
}

function nextLevel(): void {
  if (levelIndex < LEVELS.length - 1) {
    levelIndex++;
  } else {
    levelIndex = 0;
  }
  saveLevel();
  newPuzzle();
}

// ────────────────────────────────────────────────────────────────────────
// Reset / new puzzle
// ────────────────────────────────────────────────────────────────────────

function renderLevel(): void {
  levelEl.textContent = String(levelIndex + 1);
  sizeEl.textContent = `${puzzle.size}×${puzzle.size}`;
}

function renderBest(): void {
  const b = loadBest(levelIndex);
  bestEl.textContent = b === null ? '—' : String(b);
}

function clearPaths(): void {
  paths = [];
  for (let i = 0; i < puzzle.colors; i++) {
    paths.push([]);
  }
}

function newPuzzle(): void {
  genToken++;
  state = 'playing';
  cancelDrag();
  overlay.classList.add('cf-overlay--hidden');
  const cfg = LEVELS[levelIndex] ?? LEVELS[0]!;
  puzzle = generatePuzzle(cfg);
  clearPaths();
  moves = 0;
  movesEl.textContent = '0';
  renderLevel();
  renderBest();
  recomputeGeom();
  drawAll();
  statusEl.textContent =
    `Seviye ${levelIndex + 1} · ${puzzle.colors} renk · ${puzzle.size}×${puzzle.size}`;
}

function resetCurrentPuzzle(): void {
  state = 'playing';
  cancelDrag();
  overlay.classList.add('cf-overlay--hidden');
  clearPaths();
  moves = 0;
  movesEl.textContent = '0';
  drawAll();
  statusEl.textContent = `Sıfırlandı — yeniden dene.`;
}

// ────────────────────────────────────────────────────────────────────────
// Pointer event wiring
// ────────────────────────────────────────────────────────────────────────

// Snapshot of paths at drag start, so we can detect whether a drag changed
// state (which counts as a "move").
let dragInitialSnapshot: Path[] = [];

function snapshotPaths(): Path[] {
  return paths.map((p) => p.map((cell) => ({ ...cell })));
}

function pathsEqual(a: Path[], b: Path[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const pa = a[i]!;
    const pb = b[i]!;
    if (pa.length !== pb.length) return false;
    for (let j = 0; j < pa.length; j++) {
      const ca = pa[j]!;
      const cb = pb[j]!;
      if (ca.r !== cb.r || ca.c !== cb.c) return false;
    }
  }
  return true;
}

function beginDrag(e: PointerEvent): void {
  dragInitialSnapshot = snapshotPaths();
  dragPointerId = e.pointerId;
  if (boardEl.setPointerCapture) {
    try {
      boardEl.setPointerCapture(e.pointerId);
    } catch {
      /* capture can throw if pointer was released — ignore */
    }
  }
}

function onPointerDown(e: PointerEvent): void {
  if (state === 'won') return;
  if (dragColor !== -1 && e.pointerId !== dragPointerId) return; // single drag at a time
  const cell = pointToCell(e.clientX, e.clientY);
  if (!cell) return;
  const ep = endpointAt(cell.r, cell.c);
  if (ep) {
    startDragFromEndpoint(ep.color, cell.r, cell.c);
    beginDrag(e);
    e.preventDefault();
    drawAll();
    return;
  }
  // Pressed on an existing path cell — continue it from there.
  const onPath = getPathContaining(cell.r, cell.c);
  if (onPath) {
    startDragFromPath(onPath.color, onPath.index);
    beginDrag(e);
    e.preventDefault();
    drawAll();
  }
}

function onPointerMove(e: PointerEvent): void {
  if (state === 'won') return;
  if (dragColor < 0) return;
  if (e.pointerId !== dragPointerId) return;
  const cell = pointToCell(e.clientX, e.clientY);
  if (!cell) return;
  // Walk from lastCell toward cell one step at a time so a fast finger doesn't
  // skip cells.
  while (lastCell && (lastCell.r !== cell.r || lastCell.c !== cell.c)) {
    const dr = Math.sign(cell.r - lastCell.r);
    const dc = Math.sign(cell.c - lastCell.c);
    let step: { r: number; c: number };
    if (Math.abs(cell.r - lastCell.r) >= Math.abs(cell.c - lastCell.c) && dr !== 0) {
      step = { r: lastCell.r + dr, c: lastCell.c };
    } else if (dc !== 0) {
      step = { r: lastCell.r, c: lastCell.c + dc };
    } else if (dr !== 0) {
      step = { r: lastCell.r + dr, c: lastCell.c };
    } else {
      break;
    }
    const before = paths[dragColor]!.length;
    const ok = extendDragTo(step.r, step.c);
    if (!ok) break;
    if (paths[dragColor]!.length === before && lastCell.r === step.r && lastCell.c === step.c) {
      // Move only succeeded as a truncation back into our own path.
      continue;
    }
    if (paths[dragColor]!.length === before) break; // safety
  }
  e.preventDefault();
}

function commitDrag(): void {
  const changed = !pathsEqual(dragInitialSnapshot, paths);
  dragColor = -1;
  lastCell = null;
  if (dragPointerId !== -1 && boardEl.hasPointerCapture(dragPointerId)) {
    try {
      boardEl.releasePointerCapture(dragPointerId);
    } catch {
      /* ignore */
    }
  }
  dragPointerId = -1;
  dragInitialSnapshot = [];
  if (changed) {
    moves++;
    movesEl.textContent = String(moves);
  }
  if (checkWin()) win();
}

function onPointerUp(e: PointerEvent): void {
  if (dragColor < 0) return;
  if (e.pointerId !== dragPointerId) return;
  commitDrag();
}

function onPointerCancel(): void {
  if (dragColor < 0) return;
  commitDrag();
}

boardEl.addEventListener('pointerdown', onPointerDown);
boardEl.addEventListener('pointermove', onPointerMove);
boardEl.addEventListener('pointerup', onPointerUp);
boardEl.addEventListener('pointercancel', onPointerCancel);

// ────────────────────────────────────────────────────────────────────────
// Buttons + keyboard
// ────────────────────────────────────────────────────────────────────────

newBtn.addEventListener('click', () => {
  newPuzzle();
});
restartBtn.addEventListener('click', () => {
  resetCurrentPuzzle();
});
overlayNext.addEventListener('click', () => {
  nextLevel();
});

window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const target = e.target as HTMLElement | null;
  if (target) {
    const tag = target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) {
      return;
    }
  }
  const k = e.key.toLowerCase();
  if (k === 'r') {
    resetCurrentPuzzle();
    e.preventDefault();
  } else if (k === 'n') {
    newPuzzle();
    e.preventDefault();
  } else if (k === 'enter' && state === 'won') {
    nextLevel();
    e.preventDefault();
  }
});

// Resize: debounce-light. Recompute geom and redraw.
let resizeRaf: number | null = null;
window.addEventListener('resize', () => {
  if (resizeRaf !== null) cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(() => {
    resizeRaf = null;
    recomputeGeom();
    drawAll();
  });
});

// Init
levelIndex = loadLevel();
newPuzzle();
