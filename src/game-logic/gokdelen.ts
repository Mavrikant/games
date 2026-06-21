import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay, hideOverlay, isOverlayHidden } from '@shared/overlay';

// Gökdelen — klasik bir Japon mantık bulmacasının tarayıcı sürümü.
// 5×5 ızgaraya 1–5 yüksekliğinde gökdelenler yerleştirirsin; her satır ve
// sütunda her yükseklik tam olarak bir kez bulunmalı (Latin kare kuralı).
// Kenardaki sayılar o yönden bakınca kaç gökdelen görüldüğünü söyler — daha
// yüksek bir bina arkasındaki daha kısaları saklar. Tüm kenar ipuçlarına
// uyan herhangi bir geçerli yerleşim bulmacayı çözer.
//
// PITFALLS this implementation defends against (read docs/PITFALLS.md):
// - unguarded-storage: best time via safeRead/safeWrite.
// - module-level-dom-access: all DOM/storage access in init().
// - stale-async-callback: gen token guards setInterval timer + win callback.
// - overlay-input-leak: State enum; pointer/key handlers return when
//   overlay is shown or state !== 'playing'.
// - visual-vs-hitbox: cell pixel rect is the single source for both drawing
//   and hit testing (cellRectAt()).
// - invisible-boot: first puzzle rendered synchronously in reset(); overlay
//   on ready state lets player start immediately on Space/Enter/click.
// - missing-overlay-css: per-game CSS defines .overlay/.overlay--hidden.
// - hud-counter-synced-only-at-lifecycle-edges: HUD time updates every
//   second from the running timer interval, not only at lifecycle edges.

// ---------- Constants ----------

const N = 5;
const STORAGE_BEST = 'gokdelen.best';
const STORAGE_ROUND = 'gokdelen.round';

const BOARD_PX = 520;
const CLUE_PX = 56;
const CELL_PX = (BOARD_PX - CLUE_PX * 2) / N;
const GRID_ORIGIN = CLUE_PX;

// ---------- Types ----------

type GameState = 'ready' | 'playing' | 'won';

interface Puzzle {
  // Top/right/bottom/left clues — each length N.
  // Clue order: top[c] = looking south into column c (top of grid).
  // right[r] = looking west into row r (right edge).
  // bottom[c] = looking north into column c (bottom of grid).
  // left[r] = looking east into row r (left edge).
  top: number[];
  right: number[];
  bottom: number[];
  left: number[];
}

// ---------- State ----------

const gen = createGenToken();
let state: GameState = 'ready';
let puzzle: Puzzle = emptyPuzzle();
let grid: number[][] = makeEmptyGrid();
let selR = 2;
let selC = 2;
let startedAt = 0;
let elapsedMs = 0; // frozen on win
let best = Infinity; // milliseconds; Infinity = none yet
let round = 1;

// ---------- DOM refs ----------

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let timeEl!: HTMLElement;
let bestEl!: HTMLElement;
let roundEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let newPuzzleBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let startBtn!: HTMLButtonElement;

// ---------- Latin square + clue generation ----------

function makeEmptyGrid(): number[][] {
  const g: number[][] = [];
  for (let r = 0; r < N; r++) {
    const row: number[] = [];
    for (let c = 0; c < N; c++) row.push(0);
    g.push(row);
  }
  return g;
}

function emptyPuzzle(): Puzzle {
  return {
    top: new Array(N).fill(0),
    right: new Array(N).fill(0),
    bottom: new Array(N).fill(0),
    left: new Array(N).fill(0),
  };
}

// Build a random N×N Latin square with the "cyclic + shuffle rows/cols" trick.
// For N=5 this is uniform enough for puzzle variety; we don't need uniform
// over all Latin squares.
function randomLatinSquare(): number[][] {
  const base: number[][] = [];
  for (let r = 0; r < N; r++) {
    const row: number[] = [];
    for (let c = 0; c < N; c++) row.push(((r + c) % N) + 1);
    base.push(row);
  }
  shuffleInPlace(base);
  // Shuffle columns: transpose, shuffle, transpose back.
  const cols: number[][] = [];
  for (let c = 0; c < N; c++) {
    const col: number[] = [];
    for (let r = 0; r < N; r++) col.push(base[r]![c]!);
    cols.push(col);
  }
  shuffleInPlace(cols);
  const sq: number[][] = [];
  for (let r = 0; r < N; r++) {
    const row: number[] = [];
    for (let c = 0; c < N; c++) row.push(cols[c]![r]!);
    sq.push(row);
  }
  return sq;
}

function shuffleInPlace<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
}

// "How many towers are visible from this end of the line, looking inward."
// line[0] is the closest tower to the observer.
function visibleCount(line: number[]): number {
  let max = 0;
  let count = 0;
  for (const h of line) {
    if (h > max) {
      max = h;
      count++;
    }
  }
  return count;
}

function buildPuzzle(solution: number[][]): Puzzle {
  const p = emptyPuzzle();
  for (let c = 0; c < N; c++) {
    const colTopDown: number[] = [];
    const colBottomUp: number[] = [];
    for (let r = 0; r < N; r++) colTopDown.push(solution[r]![c]!);
    for (let r = N - 1; r >= 0; r--) colBottomUp.push(solution[r]![c]!);
    p.top[c] = visibleCount(colTopDown);
    p.bottom[c] = visibleCount(colBottomUp);
  }
  for (let r = 0; r < N; r++) {
    const rowLR: number[] = [];
    const rowRL: number[] = [];
    for (let c = 0; c < N; c++) rowLR.push(solution[r]![c]!);
    for (let c = N - 1; c >= 0; c--) rowRL.push(solution[r]![c]!);
    p.left[r] = visibleCount(rowLR);
    p.right[r] = visibleCount(rowRL);
  }
  return p;
}

// ---------- Solve check ----------

function isComplete(): boolean {
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      if (grid[r]![c]! === 0) return false;
    }
  }
  return true;
}

interface Validation {
  rowDup: boolean[];
  colDup: boolean[];
  topBad: boolean[];
  rightBad: boolean[];
  bottomBad: boolean[];
  leftBad: boolean[];
  allOk: boolean;
}

function validate(): Validation {
  const v: Validation = {
    rowDup: new Array(N).fill(false),
    colDup: new Array(N).fill(false),
    topBad: new Array(N).fill(false),
    rightBad: new Array(N).fill(false),
    bottomBad: new Array(N).fill(false),
    leftBad: new Array(N).fill(false),
    allOk: false,
  };

  for (let r = 0; r < N; r++) {
    const seen = new Set<number>();
    for (let c = 0; c < N; c++) {
      const h = grid[r]![c]!;
      if (h === 0) continue;
      if (seen.has(h)) {
        v.rowDup[r] = true;
        break;
      }
      seen.add(h);
    }
  }

  for (let c = 0; c < N; c++) {
    const seen = new Set<number>();
    for (let r = 0; r < N; r++) {
      const h = grid[r]![c]!;
      if (h === 0) continue;
      if (seen.has(h)) {
        v.colDup[c] = true;
        break;
      }
      seen.add(h);
    }
  }

  // Clues are only checked when the corresponding row/col is fully filled —
  // otherwise visibility count is meaningless and we'd "soft fail" the cue
  // visually before the player even gets to plan.
  for (let c = 0; c < N; c++) {
    let filled = true;
    const top: number[] = [];
    const bot: number[] = [];
    for (let r = 0; r < N; r++) {
      const h = grid[r]![c]!;
      if (h === 0) {
        filled = false;
        break;
      }
      top.push(h);
    }
    if (!filled) continue;
    for (let r = N - 1; r >= 0; r--) bot.push(grid[r]![c]!);
    if (visibleCount(top) !== puzzle.top[c]) v.topBad[c] = true;
    if (visibleCount(bot) !== puzzle.bottom[c]) v.bottomBad[c] = true;
  }

  for (let r = 0; r < N; r++) {
    let filled = true;
    const lr: number[] = [];
    const rl: number[] = [];
    for (let c = 0; c < N; c++) {
      const h = grid[r]![c]!;
      if (h === 0) {
        filled = false;
        break;
      }
      lr.push(h);
    }
    if (!filled) continue;
    for (let c = N - 1; c >= 0; c--) rl.push(grid[r]![c]!);
    if (visibleCount(lr) !== puzzle.left[r]) v.leftBad[r] = true;
    if (visibleCount(rl) !== puzzle.right[r]) v.rightBad[r] = true;
  }

  let anyBad = false;
  for (let i = 0; i < N; i++) {
    if (v.rowDup[i] || v.colDup[i]) anyBad = true;
    if (v.topBad[i] || v.bottomBad[i] || v.leftBad[i] || v.rightBad[i]) anyBad = true;
  }
  v.allOk = isComplete() && !anyBad;
  return v;
}

// ---------- HUD ----------

function fmtTime(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function renderHud(): void {
  const now = state === 'playing' ? performance.now() - startedAt : elapsedMs;
  timeEl.textContent = fmtTime(now);
  bestEl.textContent = best === Infinity ? '—' : fmtTime(best);
  roundEl.textContent = String(round);
}

// ---------- Drawing ----------

function getCss(varName: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(varName)
    .trim();
  return v || fallback;
}

interface Palette {
  bg: string;
  surface: string;
  border: string;
  text: string;
  textDim: string;
  accent: string;
  good: string;
  bad: string;
  cell: string;
  cellAlt: string;
  selected: string;
}
let pal: Palette | null = null;
function palette(): Palette {
  if (pal) return pal;
  pal = {
    bg: getCss('--bg', '#0a0b0e'),
    surface: getCss('--surface', '#11141a'),
    border: getCss('--border', '#222'),
    text: getCss('--text', '#fff'),
    textDim: getCss('--text-dim', '#7a8190'),
    accent: getCss('--accent', '#4ea1ff'),
    good: getCss('--success', '#4ade80'),
    bad: getCss('--danger', '#f87171'),
    cell: '#161a22',
    cellAlt: '#1c2230',
    selected: 'rgba(78, 161, 255, 0.18)',
  };
  return pal;
}

function cellRectAt(r: number, c: number): { x: number; y: number; w: number; h: number } {
  return {
    x: GRID_ORIGIN + c * CELL_PX,
    y: GRID_ORIGIN + r * CELL_PX,
    w: CELL_PX,
    h: CELL_PX,
  };
}

function drawBackground(p: Palette): void {
  ctx.fillStyle = p.bg;
  ctx.fillRect(0, 0, BOARD_PX, BOARD_PX);
}

function drawClues(p: Palette, v: Validation): void {
  ctx.font = 'bold 22px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (let c = 0; c < N; c++) {
    // Top clue
    const tx = GRID_ORIGIN + c * CELL_PX + CELL_PX / 2;
    ctx.fillStyle = v.topBad[c] ? p.bad : p.textDim;
    ctx.fillText(String(puzzle.top[c]), tx, CLUE_PX / 2);
    // Bottom clue
    ctx.fillStyle = v.bottomBad[c] ? p.bad : p.textDim;
    ctx.fillText(String(puzzle.bottom[c]), tx, BOARD_PX - CLUE_PX / 2);
  }

  for (let r = 0; r < N; r++) {
    const ty = GRID_ORIGIN + r * CELL_PX + CELL_PX / 2;
    ctx.fillStyle = v.leftBad[r] ? p.bad : p.textDim;
    ctx.fillText(String(puzzle.left[r]), CLUE_PX / 2, ty);
    ctx.fillStyle = v.rightBad[r] ? p.bad : p.textDim;
    ctx.fillText(String(puzzle.right[r]), BOARD_PX - CLUE_PX / 2, ty);
  }
}

function drawCells(p: Palette, v: Validation): void {
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const rect = cellRectAt(r, c);
      const alt = (r + c) % 2 === 0;
      ctx.fillStyle = alt ? p.cell : p.cellAlt;
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);

      if (r === selR && c === selC && state === 'playing') {
        ctx.fillStyle = p.selected;
        ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
      }

      const h = grid[r]![c]!;
      if (h !== 0) {
        const conflict = v.rowDup[r] || v.colDup[c];
        drawBuilding(rect, h, p, conflict);
      }
    }
  }

  // Grid lines.
  ctx.strokeStyle = p.border;
  ctx.lineWidth = 1;
  for (let i = 0; i <= N; i++) {
    const x = GRID_ORIGIN + i * CELL_PX;
    const y = GRID_ORIGIN + i * CELL_PX;
    ctx.beginPath();
    ctx.moveTo(x, GRID_ORIGIN);
    ctx.lineTo(x, GRID_ORIGIN + N * CELL_PX);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(GRID_ORIGIN, y);
    ctx.lineTo(GRID_ORIGIN + N * CELL_PX, y);
    ctx.stroke();
  }

  // Outer thick border.
  ctx.strokeStyle = p.accent;
  ctx.lineWidth = 2;
  ctx.strokeRect(GRID_ORIGIN - 1, GRID_ORIGIN - 1, N * CELL_PX + 2, N * CELL_PX + 2);
}

function drawBuilding(
  rect: { x: number; y: number; w: number; h: number },
  height: number,
  p: Palette,
  conflict: boolean,
): void {
  // Visual: a building of N "floors" with `height` of them filled (bottom-up).
  // Combined with a centered number that's the source of truth.
  const padX = rect.w * 0.18;
  const padTop = rect.h * 0.18;
  const padBot = rect.h * 0.16;
  const bx = rect.x + padX;
  const by = rect.y + padTop;
  const bw = rect.w - padX * 2;
  const bh = rect.h - padTop - padBot;

  const floors = N;
  const floorH = bh / floors;

  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 1;
  ctx.strokeRect(bx, by, bw, bh);

  const fill = conflict ? p.bad : p.accent;
  for (let f = 0; f < height; f++) {
    // Bottom-up: floor 0 is the lowest.
    const fy = by + bh - (f + 1) * floorH;
    const alpha = 0.35 + 0.55 * ((f + 1) / floors);
    ctx.fillStyle = withAlpha(fill, alpha);
    ctx.fillRect(bx + 1, fy + 1, bw - 2, floorH - 2);
  }

  // Big numeral, centered.
  ctx.fillStyle = '#0a0d12';
  ctx.font = 'bold 28px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(height), rect.x + rect.w / 2, rect.y + rect.h / 2 + 1);

  ctx.fillStyle = '#fff';
  ctx.fillText(String(height), rect.x + rect.w / 2, rect.y + rect.h / 2);
}

function withAlpha(color: string, a: number): string {
  // Accept #rrggbb or rgb()/rgba() strings; fall back to plain.
  if (color.startsWith('#') && color.length === 7) {
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${a})`;
  }
  return color;
}

function draw(): void {
  const p = palette();
  const v = validate();
  drawBackground(p);
  drawCells(p, v);
  drawClues(p, v);
}

// ---------- Input ----------

function cellAtPoint(px: number, py: number): { r: number; c: number } | null {
  if (px < GRID_ORIGIN || py < GRID_ORIGIN) return null;
  const c = Math.floor((px - GRID_ORIGIN) / CELL_PX);
  const r = Math.floor((py - GRID_ORIGIN) / CELL_PX);
  if (r < 0 || r >= N || c < 0 || c >= N) return null;
  return { r, c };
}

function placeAt(r: number, c: number, height: number): void {
  // height in 0..N; 0 means clear.
  if (height < 0 || height > N) return;
  grid[r]![c] = height;
  draw();
  if (isComplete()) {
    const v = validate();
    if (v.allOk) winRound();
  }
}

function cycleAt(r: number, c: number, dir: 1 | -1): void {
  const cur = grid[r]![c]!;
  const next = (cur + dir + (N + 1)) % (N + 1);
  placeAt(r, c, next);
}

function onPointerDown(e: PointerEvent): void {
  if (state !== 'playing') return;
  const rect = canvas.getBoundingClientRect();
  const px = ((e.clientX - rect.left) * BOARD_PX) / rect.width;
  const py = ((e.clientY - rect.top) * BOARD_PX) / rect.height;
  const hit = cellAtPoint(px, py);
  if (!hit) return;
  e.preventDefault();
  selR = hit.r;
  selC = hit.c;
  const dir: 1 | -1 = e.button === 2 || e.shiftKey ? -1 : 1;
  cycleAt(hit.r, hit.c, dir);
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'n' || e.key === 'N') {
    e.preventDefault();
    newRound();
    return;
  }
  if (e.key === 'r' || e.key === 'R') {
    e.preventDefault();
    clearGrid();
    return;
  }
  if (state === 'ready' || state === 'won') {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      if (state === 'won') newRound();
      else startGame();
    }
    return;
  }
  // state === 'playing'
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    selR = (selR + N - 1) % N;
    draw();
    return;
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    selR = (selR + 1) % N;
    draw();
    return;
  }
  if (e.key === 'ArrowLeft') {
    e.preventDefault();
    selC = (selC + N - 1) % N;
    draw();
    return;
  }
  if (e.key === 'ArrowRight') {
    e.preventDefault();
    selC = (selC + 1) % N;
    draw();
    return;
  }
  if (e.key >= '1' && e.key <= String(N)) {
    e.preventDefault();
    placeAt(selR, selC, Number(e.key));
    return;
  }
  if (e.key === '0' || e.key === 'Backspace' || e.key === 'Delete' || e.key === ' ') {
    e.preventDefault();
    placeAt(selR, selC, 0);
    return;
  }
}

// ---------- Lifecycle ----------

let tickId: number | null = null;
function startTimer(): void {
  stopTimer();
  const myGen = gen.current();
  tickId = window.setInterval(() => {
    if (!gen.isCurrent(myGen) || state !== 'playing') return;
    renderHud();
  }, 250);
}
function stopTimer(): void {
  if (tickId !== null) {
    clearInterval(tickId);
    tickId = null;
  }
}

function startGame(): void {
  gen.bump();
  hideOverlay(overlay);
  state = 'playing';
  startedAt = performance.now();
  elapsedMs = 0;
  renderHud();
  draw();
  startTimer();
}

function winRound(): void {
  if (state !== 'playing') return;
  state = 'won';
  elapsedMs = performance.now() - startedAt;
  stopTimer();
  if (elapsedMs < best) {
    best = elapsedMs;
    safeWrite(STORAGE_BEST, best);
  }
  round += 1;
  safeWrite(STORAGE_ROUND, round);
  renderHud();
  draw();
  overlayTitle.textContent = 'Şehir tamam!';
  overlayMsg.textContent =
    `Süre: ${fmtTime(elapsedMs)}\nRekor: ${best === Infinity ? '—' : fmtTime(best)}\n\n` +
    `Sonraki bulmaca için Başla'ya bas.`;
  startBtn.textContent = 'Sonraki bulmaca';
  showOverlay(overlay);
}

function newRound(): void {
  gen.bump();
  stopTimer();
  const sol = randomLatinSquare();
  puzzle = buildPuzzle(sol);
  grid = makeEmptyGrid();
  selR = 2;
  selC = 2;
  state = 'ready';
  startedAt = 0;
  elapsedMs = 0;
  overlayTitle.textContent = `Bulmaca #${round}`;
  overlayMsg.textContent =
    '5×5 ızgaraya 1-5 yüksekliklerinde gökdelenler yerleştir.\n' +
    'Her satır ve sütunda her yükseklik tam bir kez.\n' +
    'Kenardaki sayı: o yönden bakınca görünen bina sayısı.';
  startBtn.textContent = 'Başla';
  showOverlay(overlay);
  renderHud();
  draw();
}

// Clear the current grid (keep the same puzzle and timer running).
function clearGrid(): void {
  if (state === 'won') return;
  grid = makeEmptyGrid();
  draw();
}

function reset(): void {
  newRound();
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  timeEl = document.querySelector<HTMLElement>('#time')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  roundEl = document.querySelector<HTMLElement>('#round')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  newPuzzleBtn = document.querySelector<HTMLButtonElement>('#new-puzzle')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  startBtn = document.querySelector<HTMLButtonElement>('#start')!;

  best = safeRead<number>(STORAGE_BEST, Infinity);
  round = safeRead<number>(STORAGE_ROUND, 1);
  if (!isFinite(round) || round < 1) round = 1;

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  restartBtn.addEventListener('click', clearGrid);
  newPuzzleBtn.addEventListener('click', newRound);
  startBtn.addEventListener('click', () => {
    if (isOverlayHidden(overlay)) return;
    if (state === 'won') newRound();
    else startGame();
  });
  document.addEventListener('keydown', onKey);

  reset();
}

export const game = defineGame({ init, reset });
