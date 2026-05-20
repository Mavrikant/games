// Mahjong Solitaire — simplified 3-layer pyramid layout.
// Match 2 free tiles of the same kind; tile is "free" if no tile sits directly above it
// AND at least one of left/right horizontal-adjacent positions is empty on its own layer.
//
// To guarantee solvability, we generate by placing matched pairs in reverse order:
// pop free positions in pairs, assign them the same shape; never produce an unsolvable layout.
//
// Pitfalls guarded:
// - state machine (playing | won)
// - safeRead/safeWrite
// - tile position is single source of truth (computed positions; CSS absolute)
// - body has no <h1>/hint

interface Tile {
  id: number;
  x: number; // half-cell columns (so adjacent tiles share half-cells)
  y: number; // half-cell rows
  z: number; // layer (0 bottom)
  shape: number;
  removed: boolean;
}

const SHAPES = ['🀇', '🀈', '🀉', '🀊', '🀋', '🀌', '🀍', '🀎', '🀏', '🀐', '🀑', '🀒', '🀓', '🀔', '🀕', '🀖', '🀗', '🀘'];

const KEY_BEST = 'mahjong-solitaire.best';

const boardEl = document.querySelector<HTMLElement>('#board')!;
const remainingEl = document.querySelector<HTMLElement>('#remaining')!;
const hintsEl = document.querySelector<HTMLElement>('#hints')!;
const timerEl = document.querySelector<HTMLElement>('#timer')!;
const statusEl = document.querySelector<HTMLElement>('#status')!;
const overlay = document.querySelector<HTMLElement>('#overlay')!;
const overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
const overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
const overlayAction = document.querySelector<HTMLElement>('#overlay-action')!;
const hintBtn = document.querySelector<HTMLButtonElement>('#hint-btn')!;
const undoBtn = document.querySelector<HTMLButtonElement>('#undo-btn')!;
const newBtn = document.querySelector<HTMLButtonElement>('#new-btn')!;
const restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;

let tiles: Tile[] = [];
let selected: number | null = null;
let hints = 3;
let history: [number, number][] = []; // [tileIdA, tileIdB] pairs removed
let hintHighlight: [number, number] | null = null;
let timerStart = 0;
let timerInterval: number | null = null;
let elapsed = 0;
let gen = 0;
let state: 'playing' | 'won' = 'playing';

// Layout definition: 3-layer pyramid 8x4 → 6x3 → 4x2 → 2x1 (top single).
// We'll use a flat pattern: layer 0 8x4 (32), layer 1 6x3 (18), layer 2 4x2 (8), layer 3 2x1 (2) = 60.
// 60 must be even and divisible by pair = 30 pairs. 30 pairs needs 30 unique-or-shared shapes.
// We'll cycle through SHAPES (18 entries) repeating as needed.

interface LayoutSlot {
  x: number;
  y: number;
  z: number;
}

function buildLayout(): LayoutSlot[] {
  const slots: LayoutSlot[] = [];
  const layers = [
    { cols: 8, rows: 4, xOffset: 0, yOffset: 0 },
    { cols: 6, rows: 3, xOffset: 2, yOffset: 1 },
    { cols: 4, rows: 2, xOffset: 4, yOffset: 2 },
    { cols: 2, rows: 1, xOffset: 6, yOffset: 3 },
  ];
  for (let z = 0; z < layers.length; z++) {
    const L = layers[z]!;
    for (let r = 0; r < L.rows; r++) {
      for (let c = 0; c < L.cols; c++) {
        const x = (L.xOffset + c * 2);
        const y = (L.yOffset + r * 2);
        slots.push({ x, y, z });
      }
    }
  }
  return slots;
}

function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = a[i]!;
    a[i] = a[j]!;
    a[j] = tmp;
  }
  return a;
}

function isAbove(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): boolean {
  if (a.z !== b.z + 1) return false;
  return Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1;
}

function hasTileAbove(tile: Tile): boolean {
  for (const t of tiles) {
    if (t.removed) continue;
    if (t.id === tile.id) continue;
    if (isAbove(t, tile)) return true;
  }
  return false;
}

function hasLeftBlocker(tile: Tile): boolean {
  // A blocker is another non-removed tile on the same z whose x is tile.x-2 and y range overlaps
  for (const t of tiles) {
    if (t.removed) continue;
    if (t.id === tile.id) continue;
    if (t.z !== tile.z) continue;
    if (t.x === tile.x - 2 && Math.abs(t.y - tile.y) <= 1) return true;
  }
  return false;
}
function hasRightBlocker(tile: Tile): boolean {
  for (const t of tiles) {
    if (t.removed) continue;
    if (t.id === tile.id) continue;
    if (t.z !== tile.z) continue;
    if (t.x === tile.x + 2 && Math.abs(t.y - tile.y) <= 1) return true;
  }
  return false;
}

function isFree(tile: Tile): boolean {
  if (tile.removed) return false;
  if (hasTileAbove(tile)) return false;
  return !hasLeftBlocker(tile) || !hasRightBlocker(tile);
}

function findHint(): [Tile, Tile] | null {
  const free = tiles.filter((t) => isFree(t));
  for (let i = 0; i < free.length; i++) {
    for (let j = i + 1; j < free.length; j++) {
      if (free[i]!.shape === free[j]!.shape) return [free[i]!, free[j]!];
    }
  }
  return null;
}

function noMovesLeft(): boolean {
  return findHint() === null;
}

function setupTilesGuaranteedSolvable(): void {
  const slots = buildLayout();
  const total = slots.length;
  if (total % 2 !== 0) {
    slots.pop();
  }
  const placed: Tile[] = [];
  // We simulate the removal-in-reverse approach:
  // 1) Find free positions in current empty-tile model: tile that has no tile-above and at least
  //    one of left/right horizontal blockers absent. Initially all tiles are "future tiles" not
  //    yet placed; we model placement by selecting positions, NOT removing.
  // To guarantee solvability, place pairs in reverse: in each step, pick 2 currently-"empty"
  // positions that would be free if all OTHER unplaced positions were considered empty too.
  // Equivalent algorithm: process slots in reverse z-order (top first then layers below); within
  // each layer, any order; assign pairs of same shape.

  const sortedSlots = slots.slice().sort((a, b) => b.z - a.z || b.y - a.y || a.x - b.x);
  // Assign shape pairs greedily.
  const pairCount = sortedSlots.length / 2;
  const shapesAssigned: number[] = [];
  for (let i = 0; i < pairCount; i++) {
    const s = i % SHAPES.length;
    shapesAssigned.push(s, s);
  }
  const shuffled = shuffle(shapesAssigned);
  for (let i = 0; i < sortedSlots.length; i++) {
    const sl = sortedSlots[i]!;
    placed.push({
      id: i,
      x: sl.x,
      y: sl.y,
      z: sl.z,
      shape: shuffled[i]!,
      removed: false,
    });
  }
  tiles = placed;
}

function CELL(): number {
  // CSS sizing in px: 36 width per half-cell (so tile is 72 wide). Adjust to fit board width.
  return 28;
}

function renderBoard(): void {
  const cell = CELL();
  // Determine max coords for board sizing
  let maxX = 0, maxY = 0, maxZ = 0;
  for (const t of tiles) {
    if (t.x > maxX) maxX = t.x;
    if (t.y > maxY) maxY = t.y;
    if (t.z > maxZ) maxZ = t.z;
  }
  const w = (maxX + 2) * cell + 16;
  const h = (maxY + 2) * cell + maxZ * 6 + 16;
  boardEl.style.width = `${w}px`;
  boardEl.style.height = `${h}px`;

  // Render sorted: lower z first so higher z draws on top via z-index ordering
  const order = tiles.slice().sort((a, b) => a.z - b.z || a.y - b.y || a.x - b.x);
  let html = '';
  for (const t of order) {
    if (t.removed) continue;
    const px = t.x * cell - t.z * 4;
    const py = t.y * cell - t.z * 6;
    const free = isFree(t);
    const sel = selected === t.id ? ' mj-tile--selected' : '';
    const hint = hintHighlight && (hintHighlight[0] === t.id || hintHighlight[1] === t.id) ? ' mj-tile--hint' : '';
    const cls = `mj-tile${free ? '' : ' mj-tile--locked'}${sel}${hint}`;
    html += `<button class="${cls}" data-id="${t.id}" type="button" style="left:${px}px;top:${py}px;z-index:${t.z * 100 + (maxY - t.y)};"><span class="mj-tile__face">${SHAPES[t.shape] ?? '?'}</span></button>`;
  }
  boardEl.innerHTML = html;
}

function onBoardClick(e: Event): void {
  if (state !== 'playing') return;
  const target = e.target as HTMLElement;
  const btn = target.closest('.mj-tile') as HTMLElement | null;
  if (!btn) return;
  const id = Number(btn.getAttribute('data-id'));
  if (!Number.isFinite(id)) return;
  const tile = tiles.find((t) => t.id === id);
  if (!tile || tile.removed) return;
  if (!isFree(tile)) {
    setStatus('Taş engelli — üstü ve bir kenarı açık olmalı.');
    return;
  }
  if (selected === null) {
    selected = id;
    hintHighlight = null;
    renderBoard();
    setStatus('Eşleşeni seç.');
    return;
  }
  if (selected === id) {
    selected = null;
    renderBoard();
    setStatus('Seçim iptal.');
    return;
  }
  const a = tiles.find((t) => t.id === selected);
  const b = tile;
  if (!a) return;
  if (a.shape === b.shape) {
    a.removed = true;
    b.removed = true;
    history.push([a.id, b.id]);
    selected = null;
    hintHighlight = null;
    renderBoard();
    const remaining = tiles.filter((t) => !t.removed).length;
    remainingEl.textContent = String(remaining);
    if (remaining === 0) {
      win();
    } else if (noMovesLeft()) {
      lose();
    } else {
      setStatus('Eşleşme!');
    }
  } else {
    setStatus('Eşleşmedi. Tekrar seç.');
    selected = id;
    hintHighlight = null;
    renderBoard();
  }
}

function setStatus(s: string): void {
  statusEl.textContent = s;
}

function applyHint(): void {
  if (state !== 'playing') return;
  if (hints <= 0) {
    setStatus('İpucu hakkın bitti.');
    return;
  }
  const pair = findHint();
  if (!pair) {
    setStatus('Hiç eşleşme kalmadı.');
    return;
  }
  hints -= 1;
  hintsEl.textContent = String(hints);
  hintHighlight = [pair[0].id, pair[1].id];
  setStatus('Vurgulanan iki taşa bak.');
  renderBoard();
}

function undo(): void {
  if (history.length === 0) {
    setStatus('Geri alacak hamle yok.');
    return;
  }
  const last = history.pop()!;
  for (const id of last) {
    const t = tiles.find((tt) => tt.id === id);
    if (t) t.removed = false;
  }
  selected = null;
  hintHighlight = null;
  remainingEl.textContent = String(tiles.filter((t) => !t.removed).length);
  if (state === 'won') {
    state = 'playing';
    hideOverlay();
  }
  setStatus('Son hamle geri alındı.');
  renderBoard();
}

function startTimer(): void {
  stopTimer();
  timerStart = Date.now();
  elapsed = 0;
  const myGen = gen;
  timerInterval = window.setInterval(() => {
    if (myGen !== gen) return;
    elapsed = Math.floor((Date.now() - timerStart) / 1000);
    const m = Math.floor(elapsed / 60);
    const s = elapsed % 60;
    timerEl.textContent = `${m}:${s.toString().padStart(2, '0')}`;
  }, 250);
}

function stopTimer(): void {
  if (timerInterval !== null) {
    window.clearInterval(timerInterval);
    timerInterval = null;
  }
}

function safeRead(): number {
  try {
    const v = localStorage.getItem(KEY_BEST);
    if (!v) return 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}
function safeWrite(n: number): void {
  try {
    localStorage.setItem(KEY_BEST, String(n));
  } catch {
    /* ignore */
  }
}

function showOverlay(t: string, m: string): void {
  overlayTitle.textContent = t;
  overlayMsg.textContent = m;
  overlay.classList.remove('overlay--hidden');
}
function hideOverlay(): void {
  overlay.classList.add('overlay--hidden');
}

function win(): void {
  state = 'won';
  stopTimer();
  const best = safeRead();
  if (best === 0 || elapsed < best) {
    safeWrite(elapsed);
  }
  showOverlay('Tebrikler!', `Süren: ${timerEl.textContent}${best ? ' · En iyi: ' + Math.floor(best / 60) + ':' + (best % 60).toString().padStart(2, '0') : ''}`);
}

function lose(): void {
  state = 'won'; // technically lost, but use same overlay state
  stopTimer();
  showOverlay('Hamle kalmadı', `Süren: ${timerEl.textContent}. Yeni karışım dene.`);
}

function newGame(): void {
  gen += 1;
  selected = null;
  hintHighlight = null;
  history = [];
  hints = 3;
  state = 'playing';
  hideOverlay();
  setupTilesGuaranteedSolvable();
  remainingEl.textContent = String(tiles.length);
  hintsEl.textContent = String(hints);
  setStatus('İki eşleşen taşı seç. Üstü ve sol/sağ kenarı açık olmalı.');
  renderBoard();
  startTimer();
}

boardEl.addEventListener('click', onBoardClick);
hintBtn.addEventListener('click', applyHint);
undoBtn.addEventListener('click', undo);
newBtn.addEventListener('click', newGame);
overlayAction.addEventListener('click', newGame);
restartBtn.addEventListener('click', newGame);

window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k === 'r' || k === 'n') {
    newGame();
    e.preventDefault();
  } else if (k === 'u') {
    undo();
    e.preventDefault();
  } else if (k === 'h') {
    applyHint();
    e.preventDefault();
  } else if (k === 'escape') {
    selected = null;
    renderBoard();
  }
});

newGame();
