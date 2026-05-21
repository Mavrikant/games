import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { hideOverlay, showOverlay } from '@shared/overlay';

const STORAGE_BEST = 'kopru-adalari.best';
const STORAGE_DIFF = 'kopru-adalari.diff';

type Difficulty = 'kolay' | 'orta' | 'zor';

interface DiffConfig {
  rows: number;
  cols: number;
  islands: number;
}

const DIFFICULTIES: Record<Difficulty, DiffConfig> = {
  kolay: { rows: 6, cols: 6, islands: 9 },
  orta: { rows: 7, cols: 7, islands: 13 },
  zor: { rows: 8, cols: 8, islands: 17 },
};

const DIRS: ReadonlyArray<readonly [number, number]> = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];

interface Island {
  id: number;
  row: number;
  col: number;
  required: number;
}

interface Puzzle {
  rows: number;
  cols: number;
  islands: Island[];
}

interface Bridge {
  a: number;
  b: number;
  count: 1 | 2;
  horizontal: boolean;
  cells: Array<[number, number]>;
}

type Bests = Record<Difficulty, number>;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let statusEl!: HTMLElement;
let movesEl!: HTMLElement;
let bestEl!: HTMLElement;
let resetBtn!: HTMLButtonElement;
let newBtn!: HTMLButtonElement;
let overlayEl!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayNextBtn!: HTMLButtonElement;
let diffBtns: HTMLButtonElement[] = [];

let currentDiff: Difficulty = 'kolay';
let puzzle: Puzzle = { rows: 6, cols: 6, islands: [] };
let bridges: Bridge[] = [];
let selectedId: number | null = null;
let moves = 0;
let bests: Bests = { kolay: 0, orta: 0, zor: 0 };
let won = false;

let cellSize = 60;
let originX = 0;
let originY = 0;

// --- Utility ---

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  if (s === 0) s = 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function randomSeed(): number {
  return (Math.floor(Math.random() * 0xffffffff) >>> 0) || 1;
}

const cssCache = new Map<string, string>();
function getCss(name: string, fallback: string): string {
  let v = cssCache.get(name);
  if (v !== undefined) return v;
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  v = raw.length > 0 ? raw : fallback;
  cssCache.set(name, v);
  return v;
}

// --- Puzzle generator ---
// Build a guaranteed-solvable puzzle by growing a connected solution graph,
// then setting each island's required degree from the solution. Players don't
// see the solution; they reconstruct any layout that hits the same degrees and
// keeps the graph connected.

function generate(diff: Difficulty, seed: number): Puzzle {
  const cfg = DIFFICULTIES[diff];
  const rng = makeRng(seed);
  const { rows, cols } = cfg;
  const target = cfg.islands;
  const MAX_BRIDGES_PER_PAIR = 2;
  const MAX_DIST = Math.max(rows, cols);

  // grid[r][c]: 0=empty, 1=island, 2=horizontal bridge, 3=vertical bridge
  const grid: number[][] = Array.from({ length: rows }, () =>
    Array<number>(cols).fill(0),
  );

  interface GenIsland {
    id: number;
    row: number;
    col: number;
    degree: number;
  }
  interface GenBridge {
    aId: number;
    bId: number;
    count: 1 | 2;
    horizontal: boolean;
  }

  const islands: GenIsland[] = [];
  const bridgesGen: GenBridge[] = [];

  const startR = 1 + Math.floor(rng() * Math.max(1, rows - 2));
  const startC = 1 + Math.floor(rng() * Math.max(1, cols - 2));
  islands.push({ id: 0, row: startR, col: startC, degree: 0 });
  grid[startR]![startC] = 1;

  const MAX_ATTEMPTS = 4000;
  let attempts = 0;

  while (islands.length < target && attempts < MAX_ATTEMPTS) {
    attempts++;
    const src = islands[Math.floor(rng() * islands.length)]!;
    const dirIdx = Math.floor(rng() * 4);
    const [dr, dc] = DIRS[dirIdx]!;
    const horizontal = dr === 0;

    // Walk along direction until we hit a blocking cell (island or perpendicular bridge of any kind).
    // Find candidate distances >= 2.
    const candidates: number[] = [];
    for (let d = 2; d <= MAX_DIST; d++) {
      const r = src.row + dr * d;
      const c = src.col + dc * d;
      if (r < 0 || r >= rows || c < 0 || c >= cols) break;

      // Check the intermediate cell at distance d-1 wasn't already a perpendicular bridge.
      // Actually we'll do that in the placement step; here only check the candidate cell.
      const cell = grid[r]![c]!;
      if (cell !== 0) break; // hit island or bridge — can't pass through

      // Also: any of the cells in between (d' from 1 to d-1) must be empty
      // (otherwise we'd cross a bridge or pass an island).
      let ok = true;
      for (let k = 1; k < d; k++) {
        const ir = src.row + dr * k;
        const ic = src.col + dc * k;
        if (grid[ir]![ic]! !== 0) {
          ok = false;
          break;
        }
      }
      if (!ok) break;

      candidates.push(d);
      if (candidates.length >= 5) break;
    }

    if (candidates.length === 0) continue;
    const chosenD = candidates[Math.floor(rng() * candidates.length)]!;

    // Place new island
    const newR = src.row + dr * chosenD;
    const newC = src.col + dc * chosenD;
    const newId = islands.length;
    const newIsland: GenIsland = {
      id: newId,
      row: newR,
      col: newC,
      degree: 0,
    };
    islands.push(newIsland);
    grid[newR]![newC] = 1;

    const mark = horizontal ? 2 : 3;
    for (let k = 1; k < chosenD; k++) {
      const br = src.row + dr * k;
      const bc = src.col + dc * k;
      grid[br]![bc] = mark;
    }

    const count: 1 | 2 = rng() < 0.45 ? 2 : 1;
    bridgesGen.push({ aId: src.id, bId: newId, count, horizontal });
    src.degree += count;
    newIsland.degree += count;
  }

  // Pass 2: try to upgrade some single bridges to doubles for richer puzzles.
  for (const b of bridgesGen) {
    if (b.count !== 1) continue;
    if (rng() < 0.25) {
      b.count = 2;
      islands[b.aId]!.degree++;
      islands[b.bId]!.degree++;
    }
  }

  // Pass 3: try to add a few extra bridges between existing islands (cycles)
  // to create solutions with crossings to consider.
  let cycleTries = 60;
  while (cycleTries-- > 0) {
    const a = islands[Math.floor(rng() * islands.length)]!;
    const dirIdx = Math.floor(rng() * 4);
    const [dr, dc] = DIRS[dirIdx]!;
    // Walk to find first island in that direction with empty path between.
    let foundB: GenIsland | null = null;
    let foundD = 0;
    for (let d = 1; d <= MAX_DIST; d++) {
      const r = a.row + dr * d;
      const c = a.col + dc * d;
      if (r < 0 || r >= rows || c < 0 || c >= cols) break;
      const cell = grid[r]![c]!;
      if (cell === 1) {
        foundB = islands.find((i) => i.row === r && i.col === c) ?? null;
        foundD = d;
        break;
      }
      if (cell !== 0) break; // bridge crossing — give up
    }
    if (!foundB || foundD < 2) continue;
    // Check we don't already have a bridge between a and foundB
    const existing = bridgesGen.find(
      (b) =>
        (b.aId === a.id && b.bId === foundB!.id) ||
        (b.aId === foundB!.id && b.bId === a.id),
    );
    if (existing) {
      if (existing.count === 1 && rng() < 0.4) {
        existing.count = 2;
        a.degree++;
        foundB.degree++;
      }
      continue;
    }
    // Add new bridge
    const horizontal = dr === 0;
    const mark = horizontal ? 2 : 3;
    for (let k = 1; k < foundD; k++) {
      const br = a.row + dr * k;
      const bc = a.col + dc * k;
      grid[br]![bc] = mark;
    }
    const count: 1 | 2 = rng() < 0.5 ? 2 : 1;
    bridgesGen.push({ aId: a.id, bId: foundB.id, count, horizontal });
    a.degree += count;
    foundB.degree += count;
  }

  // Discard islands with degree 0 (orphans) — shouldn't happen given growth,
  // but be safe.
  const final = islands.filter((i) => i.degree > 0);
  if (final.length === 0) {
    // Fallback to a tiny known-good puzzle
    return {
      rows: 5,
      cols: 5,
      islands: [
        { id: 0, row: 0, col: 0, required: 2 },
        { id: 1, row: 0, col: 4, required: 2 },
        { id: 2, row: 4, col: 0, required: 2 },
        { id: 3, row: 4, col: 4, required: 2 },
      ],
    };
  }

  // Renumber ids 0..N-1 contiguous
  const idMap = new Map<number, number>();
  final.forEach((i, idx) => idMap.set(i.id, idx));

  return {
    rows,
    cols,
    islands: final.map((i) => ({
      id: idMap.get(i.id)!,
      row: i.row,
      col: i.col,
      required: i.degree,
    })),
  };
}

// --- Game logic ---

function islandById(id: number): Island | null {
  return puzzle.islands.find((i) => i.id === id) ?? null;
}

function islandAt(row: number, col: number): Island | null {
  return puzzle.islands.find((i) => i.row === row && i.col === col) ?? null;
}

function islandDegree(id: number): number {
  let sum = 0;
  for (const br of bridges) {
    if (br.a === id || br.b === id) sum += br.count;
  }
  return sum;
}

function pathCells(a: Island, b: Island): {
  ok: boolean;
  horizontal: boolean;
  cells: Array<[number, number]>;
} {
  if (a.id === b.id) return { ok: false, horizontal: false, cells: [] };
  if (a.row !== b.row && a.col !== b.col) {
    return { ok: false, horizontal: false, cells: [] };
  }
  const horizontal = a.row === b.row;
  const cells: Array<[number, number]> = [];
  if (horizontal) {
    const r = a.row;
    const c1 = Math.min(a.col, b.col);
    const c2 = Math.max(a.col, b.col);
    if (c2 - c1 < 2) return { ok: false, horizontal, cells: [] };
    for (let c = c1 + 1; c < c2; c++) {
      if (islandAt(r, c)) return { ok: false, horizontal, cells: [] };
      cells.push([r, c]);
    }
  } else {
    const c = a.col;
    const r1 = Math.min(a.row, b.row);
    const r2 = Math.max(a.row, b.row);
    if (r2 - r1 < 2) return { ok: false, horizontal, cells: [] };
    for (let r = r1 + 1; r < r2; r++) {
      if (islandAt(r, c)) return { ok: false, horizontal, cells: [] };
      cells.push([r, c]);
    }
  }
  return { ok: true, horizontal, cells };
}

function bridgeBetween(aId: number, bId: number): Bridge | null {
  return (
    bridges.find(
      (br) =>
        (br.a === aId && br.b === bId) || (br.a === bId && br.b === aId),
    ) ?? null
  );
}

function wouldCross(
  cells: Array<[number, number]>,
  horizontal: boolean,
): boolean {
  for (const existing of bridges) {
    if (existing.horizontal === horizontal) continue; // parallel can't cross
    for (const [r, c] of cells) {
      for (const [er, ec] of existing.cells) {
        if (r === er && c === ec) return true;
      }
    }
  }
  return false;
}

function tryToggleBridge(a: Island, b: Island): void {
  const { ok, horizontal, cells } = pathCells(a, b);
  if (!ok) {
    setStatus('Köprü yalnız aynı satır/sütundaki adalar arasında çekilir.');
    return;
  }

  const existing = bridgeBetween(a.id, b.id);
  if (existing) {
    if (existing.count === 1) {
      existing.count = 2;
      moves++;
      setStatus('Köprü çift yapıldı.');
    } else {
      const idx = bridges.indexOf(existing);
      bridges.splice(idx, 1);
      moves++;
      setStatus('Köprü kaldırıldı.');
    }
    afterMove();
    return;
  }

  if (wouldCross(cells, horizontal)) {
    setStatus('Bu köprü mevcut bir köprüyle kesişiyor.');
    return;
  }

  bridges.push({ a: a.id, b: b.id, count: 1, horizontal, cells });
  moves++;
  setStatus('Köprü eklendi.');
  afterMove();
}

function isSolved(): boolean {
  for (const i of puzzle.islands) {
    if (islandDegree(i.id) !== i.required) return false;
  }
  if (puzzle.islands.length === 0) return false;
  const visited = new Set<number>();
  const stack: number[] = [puzzle.islands[0]!.id];
  visited.add(stack[0]!);
  while (stack.length > 0) {
    const cur = stack.pop()!;
    for (const br of bridges) {
      let nb: number | null = null;
      if (br.a === cur) nb = br.b;
      else if (br.b === cur) nb = br.a;
      if (nb !== null && !visited.has(nb)) {
        visited.add(nb);
        stack.push(nb);
      }
    }
  }
  return visited.size === puzzle.islands.length;
}

function afterMove(): void {
  updateMoves();
  render();
  if (isSolved()) {
    won = true;
    handleWin();
  }
}

function handleWin(): void {
  const prev = bests[currentDiff];
  let beat = false;
  if (prev === 0 || moves < prev) {
    bests[currentDiff] = moves;
    safeWrite(STORAGE_BEST, bests);
    beat = true;
  }
  overlayTitle.textContent = beat ? 'Yeni rekor!' : 'Tebrikler!';
  const diffLabel =
    currentDiff === 'kolay' ? 'Kolay' : currentDiff === 'orta' ? 'Orta' : 'Zor';
  const bestText = bests[currentDiff] > 0 ? ` · Rekor ${bests[currentDiff]}` : '';
  overlayMsg.textContent = `${diffLabel} · Hamle ${moves}${bestText}`;
  showOverlay(overlayEl);
  setStatus('Çözüldü.');
  renderBest();
}

function setStatus(msg: string): void {
  statusEl.textContent = msg;
}

function updateMoves(): void {
  movesEl.textContent = String(moves);
}

function renderBest(): void {
  const v = bests[currentDiff];
  bestEl.textContent = v > 0 ? String(v) : '—';
}

function setDifficulty(d: Difficulty, freshPuzzle: boolean): void {
  currentDiff = d;
  safeWrite(STORAGE_DIFF, d);
  for (const btn of diffBtns) {
    btn.classList.toggle(
      'diff-btn--active',
      btn.dataset.diff === d,
    );
  }
  renderBest();
  if (freshPuzzle) newPuzzle();
}

function newPuzzle(): void {
  let attempt = 0;
  while (attempt < 6) {
    attempt++;
    const seed = randomSeed();
    const p = generate(currentDiff, seed);
    if (p.islands.length >= Math.max(4, DIFFICULTIES[currentDiff].islands - 4)) {
      puzzle = p;
      break;
    }
  }
  bridges = [];
  selectedId = null;
  moves = 0;
  won = false;
  hideOverlay(overlayEl);
  updateMoves();
  setStatus('Bir ada seç.');
  render();
}

function resetBridges(): void {
  bridges = [];
  selectedId = null;
  moves = 0;
  won = false;
  hideOverlay(overlayEl);
  updateMoves();
  setStatus('Sıfırlandı. Bir ada seç.');
  render();
}

// --- Rendering ---

function computeGeometry(): void {
  const w = canvas.width;
  const h = canvas.height;
  const maxSide = Math.min(w, h);
  // pad on all sides
  const pad = 10;
  cellSize = Math.floor((maxSide - pad * 2) / Math.max(puzzle.rows, puzzle.cols));
  const usedW = cellSize * puzzle.cols;
  const usedH = cellSize * puzzle.rows;
  originX = (w - usedW) / 2 + cellSize / 2;
  originY = (h - usedH) / 2 + cellSize / 2;
}

function cellToPixel(row: number, col: number): { x: number; y: number } {
  return {
    x: originX + col * cellSize,
    y: originY + row * cellSize,
  };
}

function pixelToIsland(px: number, py: number): Island | null {
  const radius = islandRadius() + 8;
  let best: Island | null = null;
  let bestDist = Infinity;
  for (const island of puzzle.islands) {
    const { x, y } = cellToPixel(island.row, island.col);
    const d = Math.hypot(px - x, py - y);
    if (d <= radius && d < bestDist) {
      bestDist = d;
      best = island;
    }
  }
  return best;
}

function islandRadius(): number {
  return Math.max(14, Math.min(cellSize / 2 - 4, 24));
}

function render(): void {
  computeGeometry();
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const bg = getCss('--surface', '#11141a');
  const grid = getCss('--border', '#262a33');
  const text = getCss('--text', '#e9ebef');
  const textDim = getCss('--text-dim', '#7a8392');
  const accent = getCss('--accent', '#f59e0b');
  const danger = '#ef4444';
  const success = '#10b981';
  const bridgeColor = getCss('--text-dim', '#7a8392');

  // Background
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  // Light grid dots at cell centers for orientation
  ctx.fillStyle = grid;
  for (let r = 0; r < puzzle.rows; r++) {
    for (let c = 0; c < puzzle.cols; c++) {
      const { x, y } = cellToPixel(r, c);
      ctx.beginPath();
      ctx.arc(x, y, 1.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Bridges
  const r = islandRadius();
  for (const br of bridges) {
    const a = islandById(br.a);
    const b = islandById(br.b);
    if (!a || !b) continue;
    const pa = cellToPixel(a.row, a.col);
    const pb = cellToPixel(b.row, b.col);
    ctx.strokeStyle = bridgeColor;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';

    // Trim endpoints to circle edges
    const dx = pb.x - pa.x;
    const dy = pb.y - pa.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const x1 = pa.x + ux * r;
    const y1 = pa.y + uy * r;
    const x2 = pb.x - ux * r;
    const y2 = pb.y - uy * r;

    if (br.count === 1) {
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    } else {
      const off = 4;
      const nx = -uy;
      const ny = ux;
      ctx.beginPath();
      ctx.moveTo(x1 + nx * off, y1 + ny * off);
      ctx.lineTo(x2 + nx * off, y2 + ny * off);
      ctx.moveTo(x1 - nx * off, y1 - ny * off);
      ctx.lineTo(x2 - nx * off, y2 - ny * off);
      ctx.stroke();
    }
  }

  // Islands
  for (const island of puzzle.islands) {
    const { x, y } = cellToPixel(island.row, island.col);
    const degree = islandDegree(island.id);
    const selected = selectedId === island.id;

    let borderColor = grid;
    if (degree > island.required) borderColor = danger;
    else if (degree === island.required && island.required > 0)
      borderColor = success;

    // Selection halo
    if (selected) {
      ctx.fillStyle = accent;
      ctx.globalAlpha = 0.18;
      ctx.beginPath();
      ctx.arc(x, y, r + 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // Fill circle
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();

    ctx.lineWidth = selected ? 3 : 2;
    ctx.strokeStyle = selected ? accent : borderColor;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();

    // Number
    ctx.fillStyle = degree > island.required ? danger : text;
    ctx.font = `700 ${Math.floor(r * 1.0)}px system-ui, -apple-system, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(island.required), x, y + 1);

    // Remaining indicator below (subtle)
    if (degree !== island.required && degree > 0) {
      const remaining = island.required - degree;
      const txt = remaining > 0 ? `${remaining}` : `+${-remaining}`;
      ctx.fillStyle = textDim;
      ctx.font = `500 10px system-ui, sans-serif`;
      ctx.fillText(txt, x + r * 0.85, y + r * 0.85);
    }
  }
}

// --- Input ---

function handleClick(ev: MouseEvent | PointerEvent): void {
  if (won) return;
  const rect = canvas.getBoundingClientRect();
  const px = (ev.clientX - rect.left) * (canvas.width / rect.width);
  const py = (ev.clientY - rect.top) * (canvas.height / rect.height);
  const clicked = pixelToIsland(px, py);

  if (!clicked) {
    if (selectedId !== null) {
      selectedId = null;
      setStatus('Bir ada seç.');
      render();
    }
    return;
  }

  if (selectedId === null) {
    selectedId = clicked.id;
    setStatus('Hizalı bir komşu adaya tıkla.');
    render();
    return;
  }

  if (selectedId === clicked.id) {
    selectedId = null;
    setStatus('Bir ada seç.');
    render();
    return;
  }

  const a = islandById(selectedId);
  if (!a) {
    selectedId = clicked.id;
    render();
    return;
  }
  tryToggleBridge(a, clicked);
  selectedId = null;
  render();
}

function handleKey(e: KeyboardEvent): void {
  const k = e.key.toLowerCase();
  if (k === 'r') {
    e.preventDefault();
    resetBridges();
  } else if (k === 'n') {
    e.preventDefault();
    newPuzzle();
  } else if (k === 'escape') {
    if (won) return;
    if (selectedId !== null) {
      selectedId = null;
      setStatus('Bir ada seç.');
      render();
    }
  }
}

function reset(): void {
  // Public reset: same puzzle, clear bridges.
  resetBridges();
}

// --- Init ---

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  statusEl = document.querySelector<HTMLElement>('#status')!;
  movesEl = document.querySelector<HTMLElement>('#moves')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  resetBtn = document.querySelector<HTMLButtonElement>('#reset')!;
  newBtn = document.querySelector<HTMLButtonElement>('#new-puzzle')!;
  overlayEl = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayNextBtn = document.querySelector<HTMLButtonElement>('#overlay-next')!;
  diffBtns = Array.from(
    document.querySelectorAll<HTMLButtonElement>('.diff-btn'),
  );

  const storedBests = safeRead<Partial<Bests>>(STORAGE_BEST, {});
  bests = {
    kolay: Number(storedBests.kolay) || 0,
    orta: Number(storedBests.orta) || 0,
    zor: Number(storedBests.zor) || 0,
  };
  const storedDiff = safeRead<string>(STORAGE_DIFF, 'kolay');
  if (
    storedDiff === 'kolay' ||
    storedDiff === 'orta' ||
    storedDiff === 'zor'
  ) {
    currentDiff = storedDiff;
  }

  for (const btn of diffBtns) {
    btn.classList.toggle(
      'diff-btn--active',
      btn.dataset.diff === currentDiff,
    );
    btn.addEventListener('click', () => {
      const d = btn.dataset.diff as Difficulty | undefined;
      if (!d) return;
      if (d === currentDiff) {
        newPuzzle();
        return;
      }
      setDifficulty(d, true);
    });
  }

  canvas.addEventListener('click', handleClick);
  resetBtn.addEventListener('click', resetBridges);
  newBtn.addEventListener('click', newPuzzle);
  overlayNextBtn.addEventListener('click', newPuzzle);
  window.addEventListener('keydown', handleKey);

  // Resize re-renders for crisp lines on responsive canvas.
  window.addEventListener('resize', () => render());

  renderBest();
  newPuzzle();
}

export const game = defineGame({ init, reset });
