import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { reportGameOver } from '@shared/leaderboard';

// ── Constants ────────────────────────────────────────────────────────────────
const W = 400;
const H = 400;
const COLS = 8;
const ROWS = 8;
const MARGIN = 16;
const CELL_W = (W - MARGIN * 2) / COLS;
const CELL_H = (H - MARGIN * 2) / ROWS;
const TOTAL_ROUNDS = 5;
const BASE_SCORE = 500;
const PROBE_COST = 60;
const MIN_ROUND_SCORE = 50;
const STORAGE_KEY = 'hazine-avi.best';
const SCORE_DESC = { gameId: 'hazine-avi', storageKey: STORAGE_KEY, direction: 'higher' as const };

// ── Types ────────────────────────────────────────────────────────────────────
type State = 'ready' | 'playing' | 'roundEnd' | 'gameover';
type CellState = 'hidden' | number;

// ── DOM (filled in init) ──────────────────────────────────────────────────────
let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let roundEl!: HTMLElement;
let probesEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;

// ── State ────────────────────────────────────────────────────────────────────
let state: State = 'ready';
let round = 1;
let totalScore = 0;
let probesUsed = 0;
let best = 0;
let roundScore = 0;
let cells: CellState[][] = [];
let treasureRow = 0;
let treasureCol = 0;

// ── Helpers ──────────────────────────────────────────────────────────────────
function chebyshev(r1: number, c1: number, r2: number, c2: number): number {
  return Math.max(Math.abs(r1 - r2), Math.abs(c1 - c2));
}

function updateHud(): void {
  scoreEl.textContent = String(totalScore);
  roundEl.textContent = `${round}/5`;
  probesEl.textContent = String(probesUsed);
}

function initGrid(): void {
  cells = [];
  for (let r = 0; r < ROWS; r++) {
    const row: CellState[] = [];
    for (let c = 0; c < COLS; c++) {
      row.push('hidden');
    }
    cells.push(row);
  }
  treasureRow = Math.floor(Math.random() * ROWS);
  treasureCol = Math.floor(Math.random() * COLS);
  probesUsed = 0;
}

function cellAt(cx: number, cy: number): [number, number] | null {
  const col = Math.floor((cx - MARGIN) / CELL_W);
  const row = Math.floor((cy - MARGIN) / CELL_H);
  if (row < 0 || row >= ROWS || col < 0 || col >= COLS) return null;
  return [row, col];
}

function canvasCoords(e: PointerEvent): [number, number] {
  const rect = canvas.getBoundingClientRect();
  const scaleX = W / rect.width;
  const scaleY = H / rect.height;
  return [(e.clientX - rect.left) * scaleX, (e.clientY - rect.top) * scaleY];
}

// ── Color & Label ─────────────────────────────────────────────────────────────
function tempColor(dist: number): string {
  if (dist === 0) return '#fbbf24';
  if (dist === 1) return '#ef4444';
  if (dist === 2) return '#f97316';
  if (dist === 3) return '#eab308';
  if (dist === 4) return '#84cc16';
  if (dist === 5) return '#22d3ee';
  if (dist === 6) return '#3b82f6';
  return '#1e40af';
}

function cellLabel(dist: number): string {
  if (dist === 0) return '★';
  return String(dist);
}

// ── Draw helpers ──────────────────────────────────────────────────────────────
function roundRect(x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawOverlay(title: string, lines: string[], titleColor: string): void {
  ctx.fillStyle = 'rgba(0,0,0,0.72)';
  ctx.fillRect(0, 0, W, H);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const startY = H / 2 - (lines.length * 26) / 2;

  ctx.font = 'bold 28px system-ui, sans-serif';
  ctx.fillStyle = titleColor;
  ctx.fillText(title, W / 2, startY - 24);

  ctx.font = '16px system-ui, sans-serif';
  ctx.fillStyle = '#ffffff';
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i]!, W / 2, startY + i * 26);
  }
}

// ── Draw ──────────────────────────────────────────────────────────────────────
function draw(): void {
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0a0b0e';
  ctx.fillRect(0, 0, W, H);

  const padding = 2;

  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const x = MARGIN + c * CELL_W + padding;
      const y = MARGIN + r * CELL_H + padding;
      const cw = CELL_W - padding * 2;
      const ch = CELL_H - padding * 2;
      const cell = cells[r]![c]!;

      if (cell === 'hidden') {
        ctx.fillStyle = '#1e293b';
        roundRect(x, y, cw, ch, 5);
        ctx.fill();
        ctx.strokeStyle = '#334155';
        ctx.lineWidth = 1;
        ctx.stroke();
      } else {
        const dist = cell as number;
        const color = tempColor(dist);
        ctx.fillStyle = color + '33';
        roundRect(x, y, cw, ch, 5);
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.stroke();

        const label = cellLabel(dist);
        const fontSize = CELL_W * 0.5;
        ctx.font = dist === 0
          ? `bold ${fontSize}px system-ui, sans-serif`
          : `${fontSize}px system-ui, sans-serif`;
        ctx.fillStyle = color;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, x + cw / 2, y + ch / 2);
      }
    }
  }

  if (state === 'ready') {
    drawOverlay(
      'Hazine Avı',
      ['Tıkla veya SPACE — başlat'],
      '#fbbf24',
    );
  } else if (state === 'roundEnd') {
    const isLast = round >= TOTAL_ROUNDS;
    drawOverlay(
      `Tur ${round} bitti! +${roundScore} puan`,
      [isLast ? 'Son tur!' : 'Devam için tıkla'],
      '#fbbf24',
    );
  } else if (state === 'gameover') {
    const isNewBest = totalScore >= best && totalScore > 0;
    drawOverlay(
      isNewBest ? 'Yeni rekor!' : 'Oyun bitti',
      [
        `Toplam: ${totalScore} puan`,
        `En iyi: ${best} puan`,
        'Tekrar için tıkla',
      ],
      isNewBest ? '#fbbf24' : '#ffffff',
    );
  }
}

// ── Game flow ─────────────────────────────────────────────────────────────────
function beginPlay(): void {
  state = 'playing';
  draw();
}

function nextRound(): void {
  if (round >= TOTAL_ROUNDS) {
    state = 'gameover';
    if (totalScore > best) {
      best = totalScore;
      safeWrite(STORAGE_KEY, best);
    }
    reportGameOver(SCORE_DESC, totalScore);
    draw();
  } else {
    round++;
    initGrid();
    state = 'playing';
    updateHud();
    draw();
  }
}

function reset(): void {
  state = 'ready';
  round = 1;
  totalScore = 0;
  probesUsed = 0;
  roundScore = 0;
  initGrid();
  updateHud();
  draw();
}

function handleClick(canvasX: number, canvasY: number): void {
  if (state === 'ready') {
    beginPlay();
    return;
  }
  if (state === 'gameover') {
    reset();
    return;
  }
  if (state === 'roundEnd') {
    nextRound();
    return;
  }
  // state === 'playing'
  const pos = cellAt(canvasX, canvasY);
  if (!pos) return;
  const [row, col] = pos;
  if (cells[row]![col]! !== 'hidden') return;

  const dist = chebyshev(row, col, treasureRow, treasureCol);
  cells[row]![col] = dist;
  probesUsed++;
  updateHud();

  if (dist === 0) {
    roundScore = Math.max(MIN_ROUND_SCORE, BASE_SCORE - probesUsed * PROBE_COST);
    totalScore += roundScore;
    updateHud();
    state = 'roundEnd';
  }

  draw();
}

// ── Init ─────────────────────────────────────────────────────────────────────
function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  roundEl = document.querySelector<HTMLElement>('#round')!;
  probesEl = document.querySelector<HTMLElement>('#probes')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;

  best = safeRead<number>(STORAGE_KEY, 0);
  if (!Number.isFinite(best) || best < 0) best = 0;

  canvas.addEventListener('pointerdown', (e: PointerEvent) => {
    const [cx, cy] = canvasCoords(e);
    handleClick(cx, cy);
  });

  canvas.addEventListener(
    'touchstart',
    (e: TouchEvent) => {
      e.preventDefault();
    },
    { passive: false },
  );

  restartBtn.addEventListener('click', () => {
    reset();
  });

  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'r' || e.key === 'R') {
      reset();
      return;
    }
    if (e.key === ' ' || e.key === 'Enter') {
      if (state === 'ready') {
        beginPlay();
      } else if (state === 'roundEnd') {
        nextRound();
      } else if (state === 'gameover') {
        reset();
      }
    }
  });

  reset();
}

export const game = defineGame({ init, reset });
