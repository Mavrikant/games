import { defineGame } from '@shared/game-module';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';

type Dir = 'right' | 'left' | 'up' | 'down';
type MirrorType = '/' | '\\' | null;

interface Cell {
  mirror: MirrorType;
  isTarget: boolean;
  isWall: boolean;
}

interface Level {
  laserSide: 'left' | 'right' | 'top' | 'bottom';
  laserIndex: number;       // row if left/right, col if top/bottom
  targets: Array<{col: number; row: number}>;
  mirrorLimit: number;
}

const GRID = 8;
const CELL = 60;                 // px per cell
const CANVAS_SIZE = 480;
const OFFSET = (CANVAS_SIZE - GRID * CELL) / 2;  // centering offset

const LEVELS: Level[] = [
  { laserSide: 'left',   laserIndex: 3, targets: [{col:6, row:0}],                                        mirrorLimit: 2 },
  { laserSide: 'left',   laserIndex: 4, targets: [{col:7, row:0}, {col:7, row:7}],                         mirrorLimit: 3 },
  { laserSide: 'top',    laserIndex: 0, targets: [{col:7, row:2}, {col:0, row:7}],                         mirrorLimit: 3 },
  { laserSide: 'left',   laserIndex: 0, targets: [{col:3, row:3}, {col:7, row:7}],                         mirrorLimit: 4 },
  { laserSide: 'left',   laserIndex: 7, targets: [{col:7, row:0}, {col:3, row:7}, {col:0, row:3}],         mirrorLimit: 4 },
  { laserSide: 'top',    laserIndex: 3, targets: [{col:0, row:0}, {col:7, row:0}, {col:0, row:7}],         mirrorLimit: 5 },
  { laserSide: 'left',   laserIndex: 3, targets: [{col:7,row:3},{col:3,row:7},{col:0,row:0},{col:7,row:0}], mirrorLimit: 6 },
];

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let fireBtn!: HTMLButtonElement;
let clearBtn!: HTMLButtonElement;
let levelDisplay!: HTMLElement;
let mirrorsLeft!: HTMLElement;

let currentLevel = 0;
let grid: Cell[][] = [];
let laserPath: Array<{col: number; row: number}> = [];
let hitTargets: Set<string> = new Set();
let mirrorsPlaced = 0;
let fired = false;

const cssCache = new Map<string, string>();
function getCss(v: string): string {
  const c = cssCache.get(v);
  if (c !== undefined) return c;
  const val = getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  cssCache.set(v, val);
  return val;
}

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlay);
}

function hideOverlay(): void {
  hideOverlayEl(overlay);
}

function makeGrid(level: Level): Cell[][] {
  const g: Cell[][] = [];
  for (let r = 0; r < GRID; r++) {
    g[r] = [];
    for (let c = 0; c < GRID; c++) {
      g[r]![c] = { mirror: null, isTarget: false, isWall: false };
    }
  }
  for (const t of level.targets) {
    g[t.row]![t.col]!.isTarget = true;
  }
  return g;
}

function simulateLaser(level: Level): { path: Array<{col: number; row: number}>; hits: Set<string> } {
  let col: number;
  let row: number;
  let dir: Dir;

  switch (level.laserSide) {
    case 'left':   col = -1; row = level.laserIndex; dir = 'right'; break;
    case 'right':  col = GRID; row = level.laserIndex; dir = 'left'; break;
    case 'top':    col = level.laserIndex; row = -1; dir = 'down'; break;
    case 'bottom': col = level.laserIndex; row = GRID; dir = 'up'; break;
  }

  const path: Array<{col: number; row: number}> = [];
  const hits = new Set<string>();
  const visited = new Set<string>();
  const MAX_STEPS = GRID * GRID * 4;
  let steps = 0;

  while (steps++ < MAX_STEPS) {
    if (dir === 'right') col++;
    else if (dir === 'left') col--;
    else if (dir === 'down') row++;
    else row--;

    if (col < 0 || col >= GRID || row < 0 || row >= GRID) break;

    const key = `${col},${row},${dir}`;
    if (visited.has(key)) break;
    visited.add(key);

    path.push({ col, row });
    const cell = grid[row]![col]!;

    if (cell.isTarget) hits.add(`${col},${row}`);

    if (cell.mirror === '/') {
      if (dir === 'right') dir = 'up';
      else if (dir === 'left') dir = 'down';
      else if (dir === 'up') dir = 'right';
      else dir = 'left';
    } else if (cell.mirror === '\\') {
      if (dir === 'right') dir = 'down';
      else if (dir === 'left') dir = 'up';
      else if (dir === 'up') dir = 'left';
      else dir = 'right';
    }
  }

  return { path, hits };
}

function draw(): void {
  ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

  const surface = getCss('--surface');
  const gridColor = getCss('--grid');

  ctx.fillStyle = surface;
  ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

  // Grid cells
  for (let r = 0; r < GRID; r++) {
    for (let c = 0; c < GRID; c++) {
      const x = OFFSET + c * CELL;
      const y = OFFSET + r * CELL;
      const cell = grid[r]![c]!;

      ctx.strokeStyle = gridColor;
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, CELL - 1, CELL - 1);

      // Laser path highlight
      const isLit = fired && laserPath.some((p) => p.col === c && p.row === r);
      if (isLit) {
        ctx.fillStyle = 'rgba(255,80,80,0.18)';
        ctx.fillRect(x, y, CELL, CELL);
      }

      // Target
      if (cell.isTarget) {
        const hit = hitTargets.has(`${c},${r}`);
        ctx.font = `bold ${Math.floor(CELL * 0.45)}px system-ui`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = hit ? '#f0c040' : gridColor;
        ctx.fillText('★', x + CELL / 2, y + CELL / 2);
      }

      // Mirror
      if (cell.mirror) {
        ctx.strokeStyle = '#60b8e8';
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        const pad = CELL * 0.2;
        ctx.beginPath();
        if (cell.mirror === '/') {
          ctx.moveTo(x + CELL - pad, y + pad);
          ctx.lineTo(x + pad, y + CELL - pad);
        } else {
          ctx.moveTo(x + pad, y + pad);
          ctx.lineTo(x + CELL - pad, y + CELL - pad);
        }
        ctx.stroke();
      }
    }
  }

  // Draw laser beam lines
  if (fired && laserPath.length > 0) {
    const level = LEVELS[currentLevel]!;
    let prevX: number;
    let prevY: number;

    switch (level.laserSide) {
      case 'left':   prevX = OFFSET - CELL / 2; prevY = OFFSET + level.laserIndex * CELL + CELL / 2; break;
      case 'right':  prevX = OFFSET + GRID * CELL + CELL / 2; prevY = OFFSET + level.laserIndex * CELL + CELL / 2; break;
      case 'top':    prevX = OFFSET + level.laserIndex * CELL + CELL / 2; prevY = OFFSET - CELL / 2; break;
      case 'bottom': prevX = OFFSET + level.laserIndex * CELL + CELL / 2; prevY = OFFSET + GRID * CELL + CELL / 2; break;
    }

    ctx.strokeStyle = 'rgba(255,80,80,0.75)';
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';

    for (const p of laserPath) {
      const cx = OFFSET + p.col * CELL + CELL / 2;
      const cy = OFFSET + p.row * CELL + CELL / 2;
      ctx.beginPath();
      ctx.moveTo(prevX, prevY);
      ctx.lineTo(cx, cy);
      ctx.stroke();
      prevX = cx;
      prevY = cy;
    }
  }

  // Laser source indicator
  drawLaserSource();

  // Mirror count
  const level = LEVELS[currentLevel]!;
  const remaining = level.mirrorLimit - mirrorsPlaced;
  mirrorsLeft.textContent = String(remaining);

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

function drawLaserSource(): void {
  const level = LEVELS[currentLevel]!;
  ctx.fillStyle = '#ff5050';
  ctx.font = `bold ${Math.floor(CELL * 0.35)}px system-ui`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  let x: number;
  let y: number;
  let arrow: string;
  switch (level.laserSide) {
    case 'left':
      x = OFFSET - CELL * 0.65; y = OFFSET + level.laserIndex * CELL + CELL / 2;
      arrow = '▶'; break;
    case 'right':
      x = OFFSET + GRID * CELL + CELL * 0.65; y = OFFSET + level.laserIndex * CELL + CELL / 2;
      arrow = '◀'; break;
    case 'top':
      x = OFFSET + level.laserIndex * CELL + CELL / 2; y = OFFSET - CELL * 0.55;
      arrow = '▼'; break;
    case 'bottom':
      x = OFFSET + level.laserIndex * CELL + CELL / 2; y = OFFSET + GRID * CELL + CELL * 0.55;
      arrow = '▲'; break;
  }

  ctx.fillText(arrow!, x!, y!);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

function loadLevel(idx: number): void {
  currentLevel = idx;
  const level = LEVELS[idx]!;
  grid = makeGrid(level);
  laserPath = [];
  hitTargets = new Set();
  mirrorsPlaced = 0;
  fired = false;
  levelDisplay.textContent = String(idx + 1);
  hideOverlay();
  draw();
}

function handleCellClick(e: MouseEvent): void {
  const rect = canvas.getBoundingClientRect();
  const scaleX = CANVAS_SIZE / rect.width;
  const scaleY = CANVAS_SIZE / rect.height;
  const px = (e.clientX - rect.left) * scaleX - OFFSET;
  const py = (e.clientY - rect.top) * scaleY - OFFSET;
  const col = Math.floor(px / CELL);
  const row = Math.floor(py / CELL);

  if (col < 0 || col >= GRID || row < 0 || row >= GRID) return;

  const cell = grid[row]![col]!;
  if (cell.isWall || cell.isTarget) return;

  const level = LEVELS[currentLevel]!;

  if (cell.mirror === null) {
    if (mirrorsPlaced >= level.mirrorLimit) return;
    cell.mirror = '/';
    mirrorsPlaced++;
  } else if (cell.mirror === '/') {
    cell.mirror = '\\';
  } else {
    cell.mirror = null;
    mirrorsPlaced--;
  }

  fired = false;
  laserPath = [];
  hitTargets = new Set();
  draw();
}

function fireLaser(): void {
  const level = LEVELS[currentLevel]!;
  const result = simulateLaser(level);
  laserPath = result.path;
  hitTargets = result.hits;
  fired = true;
  draw();

  const totalTargets = level.targets.length;
  if (hitTargets.size === totalTargets) {
    setTimeout(() => {
      if (currentLevel < LEVELS.length - 1) {
        showOverlay(`Seviye ${currentLevel + 1} Tamamlandı! 🎉`, 'Tebrikler! Bir sonraki seviyeye geçiliyor…');
        setTimeout(() => loadLevel(currentLevel + 1), 2000);
      } else {
        showOverlay('Tüm Seviyeler Tamamlandı! 🏆', `Tüm ${LEVELS.length} bulmacayı çözdün! · R ile baştan başla`);
      }
    }, 300);
  }
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  fireBtn = document.querySelector<HTMLButtonElement>('#fire-btn')!;
  clearBtn = document.querySelector<HTMLButtonElement>('#clear-btn')!;
  levelDisplay = document.querySelector<HTMLElement>('#level-display')!;
  mirrorsLeft = document.querySelector<HTMLElement>('#mirrors-left')!;

  canvas.addEventListener('click', handleCellClick);
  fireBtn.addEventListener('click', fireLaser);
  clearBtn.addEventListener('click', () => loadLevel(currentLevel));
  restartBtn.addEventListener('click', () => loadLevel(currentLevel));

  window.addEventListener('keydown', (e) => {
    if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      loadLevel(currentLevel);
    } else if (e.key === 'Enter' || e.key === 'f' || e.key === 'F') {
      e.preventDefault();
      fireLaser();
    }
  });

  showOverlay('Lazer & Ayna', 'Hücrelere tıklayarak ayna yerleştir, lazeri tüm yıldızlara ulaştır.\nBaşlamak için kapat (veya hücreye tıkla).');
  loadLevel(0);
}

export const game = defineGame({ init });
