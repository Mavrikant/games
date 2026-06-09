import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay, hideOverlay } from '@shared/overlay';

type State = 'ready' | 'playing' | 'won' | 'stuck';

const KNIGHT_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [1, 2], [2, 1], [2, -1], [1, -2],
  [-1, -2], [-2, -1], [-2, 1], [-1, 2],
];

const MIN_SIZE = 5;
const MAX_SIZE = 8;
const DEFAULT_SIZE = 6;
const SIZE_KEY = 'atin-turu.size';

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let targetEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let statusEl!: HTMLElement;
let sizeBtns: HTMLButtonElement[] = [];

let size = DEFAULT_SIZE;
let visited: number[][] = [];
let knightAt: { x: number; y: number } | null = null;
let moveCount = 0;
let best = 0;
let state: State = 'ready';

function bestKeyFor(n: number): string {
  return `atin-turu.best.${n}`;
}

function loadBest(): void {
  best = safeRead<number>(bestKeyFor(size), 0);
}

function isInside(x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < size && y < size;
}

function legalMovesFrom(x: number, y: number): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (const [dx, dy] of KNIGHT_OFFSETS) {
    const nx = x + dx;
    const ny = y + dy;
    if (!isInside(nx, ny)) continue;
    if (visited[ny]![nx]! > 0) continue;
    out.push({ x: nx, y: ny });
  }
  return out;
}

function getCss(varName: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  return v || fallback;
}

function draw(): void {
  const w = canvas.width;
  const h = canvas.height;
  const cell = w / size;
  ctx.clearRect(0, 0, w, h);

  const light = getCss('--at-light', '#1e293b');
  const dark = getCss('--at-dark', '#0f172a');
  const visitedColor = getCss('--at-visited', '#fbbf24');
  const lastColor = getCss('--at-last', '#f97316');
  const moveColor = getCss('--at-move', '#34d399');
  const startColor = getCss('--at-start', '#a78bfa');
  const numberColor = getCss('--text', '#e2e8f0');

  // Board squares (checkerboard)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const isLight = (x + y) % 2 === 0;
      ctx.fillStyle = isLight ? light : dark;
      ctx.fillRect(x * cell, y * cell, cell, cell);
    }
  }

  // Visited squares
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const order = visited[y]![x]!;
      if (order === 0) continue;
      const isLast = knightAt && knightAt.x === x && knightAt.y === y;
      const isStart = order === 1;
      ctx.fillStyle = isLast
        ? lastColor
        : isStart
          ? startColor
          : visitedColor;
      ctx.globalAlpha = isLast ? 1 : 0.85;
      const pad = cell * 0.08;
      ctx.fillRect(x * cell + pad, y * cell + pad, cell - 2 * pad, cell - 2 * pad);
      ctx.globalAlpha = 1;

      // Number
      ctx.fillStyle = isLast ? '#0a0b0e' : '#0a0b0e';
      ctx.font = `${Math.floor(cell * 0.28)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(order), x * cell + cell / 2, y * cell + cell / 2 + cell * 0.04);
    }
  }

  // Legal-move dots from current knight position
  if (state === 'playing' && knightAt) {
    const moves = legalMovesFrom(knightAt.x, knightAt.y);
    for (const m of moves) {
      ctx.beginPath();
      ctx.fillStyle = moveColor;
      ctx.globalAlpha = 0.75;
      ctx.arc(
        m.x * cell + cell / 2,
        m.y * cell + cell / 2,
        cell * 0.16,
        0,
        Math.PI * 2,
      );
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  // Knight glyph on current square
  if (knightAt) {
    ctx.fillStyle = '#0a0b0e';
    ctx.font = `${Math.floor(cell * 0.62)}px serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('♞', knightAt.x * cell + cell / 2, knightAt.y * cell + cell / 2 - cell * 0.04);
  }

  // Grid lines
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= size; i++) {
    ctx.beginPath();
    ctx.moveTo(i * cell, 0);
    ctx.lineTo(i * cell, h);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i * cell);
    ctx.lineTo(w, i * cell);
    ctx.stroke();
  }
  // Make sure numberColor is referenced (kept for future-proofing palette use)
  void numberColor;
}

function syncHud(): void {
  scoreEl.textContent = String(moveCount);
  targetEl.textContent = String(size * size);
  bestEl.textContent = String(best);
}

function updateStatus(): void {
  if (state === 'ready') {
    statusEl.textContent = 'Başlangıç karesini seç';
  } else if (state === 'playing') {
    const remain = size * size - moveCount;
    statusEl.textContent = `Kalan: ${remain} kare`;
  } else if (state === 'won') {
    statusEl.textContent = `Tur tamamlandı! ${moveCount}/${size * size}`;
  } else {
    statusEl.textContent = `Sıkıştın — ${moveCount}/${size * size}`;
  }
}

function commitBest(): void {
  if (moveCount > best) {
    best = moveCount;
    safeWrite(bestKeyFor(size), best);
  }
}

function makeVisitedGrid(): number[][] {
  const out: number[][] = [];
  for (let y = 0; y < size; y++) {
    const row: number[] = [];
    for (let x = 0; x < size; x++) row.push(0);
    out.push(row);
  }
  return out;
}

function reset(): void {
  visited = makeVisitedGrid();
  knightAt = null;
  moveCount = 0;
  state = 'ready';
  loadBest();
  syncHud();
  updateStatus();
  overlayTitle.textContent = 'Atın Turu';
  overlayMsg.textContent = `${size}×${size} tahtada başlangıç karesini seç.`;
  showOverlay(overlay);
  draw();
}

function startFrom(x: number, y: number): void {
  visited[y]![x] = 1;
  knightAt = { x, y };
  moveCount = 1;
  state = 'playing';
  hideOverlay(overlay);
  syncHud();
  updateStatus();
  draw();
  // If the starting square has no moves at all (degenerate small board case)
  checkTerminal();
}

function moveTo(x: number, y: number): void {
  visited[y]![x] = moveCount + 1;
  knightAt = { x, y };
  moveCount += 1;
  syncHud();
  updateStatus();
  draw();
  checkTerminal();
}

function checkTerminal(): void {
  if (moveCount === size * size) {
    state = 'won';
    commitBest();
    syncHud();
    updateStatus();
    overlayTitle.textContent = 'Tur tamamlandı!';
    overlayMsg.textContent = `Bütün ${moveCount} kareyi ziyaret ettin.\nYeni el için "Yeniden başla".`;
    showOverlay(overlay);
    return;
  }
  if (!knightAt) return;
  const moves = legalMovesFrom(knightAt.x, knightAt.y);
  if (moves.length === 0) {
    state = 'stuck';
    commitBest();
    syncHud();
    updateStatus();
    overlayTitle.textContent = 'Sıkıştın';
    overlayMsg.textContent = `${moveCount}/${size * size} kare. Yeni el için "Yeniden başla" veya R.`;
    showOverlay(overlay);
  }
}

function pickCell(e: MouseEvent): { x: number; y: number } | null {
  const rect = canvas.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const py = e.clientY - rect.top;
  const cell = rect.width / size;
  const x = Math.floor(px / cell);
  const y = Math.floor(py / cell);
  if (!isInside(x, y)) return null;
  return { x, y };
}

function onCanvasClick(e: MouseEvent): void {
  const c = pickCell(e);
  if (!c) return;

  if (state === 'ready') {
    startFrom(c.x, c.y);
    return;
  }
  if (state !== 'playing' || !knightAt) return;

  // Must be a legal move from current knight position
  const moves = legalMovesFrom(knightAt.x, knightAt.y);
  const ok = moves.some((m) => m.x === c.x && m.y === c.y);
  if (!ok) return;
  moveTo(c.x, c.y);
}

function setSize(n: number): void {
  const clamped = Math.max(MIN_SIZE, Math.min(MAX_SIZE, n));
  if (clamped === size) {
    reset();
    return;
  }
  size = clamped;
  safeWrite(SIZE_KEY, size);
  for (const btn of sizeBtns) {
    btn.classList.toggle('size-btn--active', Number(btn.dataset.size) === size);
  }
  reset();
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  targetEl = document.querySelector<HTMLElement>('#target')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  statusEl = document.querySelector<HTMLElement>('#status')!;
  sizeBtns = Array.from(document.querySelectorAll<HTMLButtonElement>('.size-btn'));

  const savedSize = safeRead<number>(SIZE_KEY, DEFAULT_SIZE);
  size = Math.max(MIN_SIZE, Math.min(MAX_SIZE, Number(savedSize) || DEFAULT_SIZE));

  for (const btn of sizeBtns) {
    btn.classList.toggle('size-btn--active', Number(btn.dataset.size) === size);
    btn.addEventListener('click', () => {
      setSize(Number(btn.dataset.size));
    });
  }

  canvas.addEventListener('click', onCanvasClick);
  restartBtn.addEventListener('click', reset);
  overlay.addEventListener('click', () => {
    if (state === 'won' || state === 'stuck') reset();
  });

  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'r') {
      reset();
      e.preventDefault();
      return;
    }
    if (k >= '5' && k <= '8') {
      setSize(Number(k));
      e.preventDefault();
    }
  });

  reset();
}

export const game = defineGame({ init, reset });
