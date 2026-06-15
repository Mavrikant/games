import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';

const COLS = 7;
const ROWS = 5;
const MAX_DIRT = 3;
const STORAGE_BEST = 'kazi.best';
const SCORE_SAFE = 10;
const SCORE_DAMAGED = -15;

type State = 'ready' | 'playing' | 'win' | 'lose';
type Tool = 'brush' | 'pick';

interface Cell {
  dirt: number;
  treasure: boolean;
  dug: boolean;
  damaged: boolean;
}

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let levelEl!: HTMLElement;
let energyEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let brushBtn!: HTMLButtonElement;
let pickBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayStart!: HTMLButtonElement;

let grid: Cell[][] = [];
let state: State = 'ready';
let tool: Tool = 'brush';
let level = 1;
let energy = 0;
let energyMax = 0;
let score = 0;
let best = 0;
let totalTreasure = 0;
let exposedTreasure = 0;
let damagedCount = 0;

let cellW = 0;
let cellH = 0;

function energyForLevel(lv: number): number {
  return 40 + (lv - 1) * 4;
}

function treasureCountForLevel(lv: number): number {
  return Math.min(5 + (lv - 1), 14);
}

function pickRandomInt(max: number): number {
  return Math.floor(Math.random() * max);
}

function generateTreasure(target: number): Set<string> {
  const cells = new Set<string>();
  // Start somewhere not on the absolute edge so the blob has room.
  const startX = 1 + pickRandomInt(COLS - 2);
  const startY = 1 + pickRandomInt(ROWS - 2);
  cells.add(`${startX},${startY}`);
  const frontier: Array<{ x: number; y: number }> = [{ x: startX, y: startY }];
  let safety = 0;
  while (cells.size < target && frontier.length > 0 && safety < 5000) {
    safety++;
    const idx = pickRandomInt(frontier.length);
    const cur = frontier[idx]!;
    const dirs = [
      { dx: 1, dy: 0 },
      { dx: -1, dy: 0 },
      { dx: 0, dy: 1 },
      { dx: 0, dy: -1 },
    ];
    const d = dirs[pickRandomInt(dirs.length)]!;
    const nx = cur.x + d.dx;
    const ny = cur.y + d.dy;
    if (nx < 0 || nx >= COLS || ny < 0 || ny >= ROWS) continue;
    const key = `${nx},${ny}`;
    if (cells.has(key)) continue;
    cells.add(key);
    frontier.push({ x: nx, y: ny });
  }
  return cells;
}

function buildLevel(): void {
  energyMax = energyForLevel(level);
  energy = energyMax;
  exposedTreasure = 0;
  damagedCount = 0;
  totalTreasure = treasureCountForLevel(level);
  const treasureCells = generateTreasure(totalTreasure);
  grid = [];
  for (let y = 0; y < ROWS; y++) {
    const row: Cell[] = [];
    for (let x = 0; x < COLS; x++) {
      row.push({
        dirt: MAX_DIRT,
        treasure: treasureCells.has(`${x},${y}`),
        dug: false,
        damaged: false,
      });
    }
    grid.push(row);
  }
}

function syncHUD(): void {
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
  levelEl.textContent = String(level);
  energyEl.textContent = `${energy}/${energyMax}`;
}

function commitBest(): void {
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
    bestEl.textContent = String(best);
  }
}

function setTool(next: Tool): void {
  tool = next;
  brushBtn.classList.toggle('kz-tool--active', tool === 'brush');
  pickBtn.classList.toggle('kz-tool--active', tool === 'pick');
  brushBtn.setAttribute('aria-pressed', tool === 'brush' ? 'true' : 'false');
  pickBtn.setAttribute('aria-pressed', tool === 'pick' ? 'true' : 'false');
  canvas.style.cursor = tool === 'brush' ? 'crosshair' : 'cell';
}

function showOverlay(title: string, msg: string, startLabel: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  overlayStart.textContent = startLabel;
  showOverlayEl(overlay);
}

function hideOverlay(): void {
  hideOverlayEl(overlay);
}

function startGame(): void {
  level = 1;
  score = 0;
  buildLevel();
  state = 'playing';
  syncHUD();
  draw();
  hideOverlay();
}

function nextLevel(): void {
  level++;
  buildLevel();
  state = 'playing';
  syncHUD();
  draw();
  hideOverlay();
}

function reset(): void {
  state = 'ready';
  score = 0;
  level = 1;
  energy = 0;
  energyMax = energyForLevel(1);
  grid = [];
  syncHUD();
  // Render a peaceful empty pre-game board so the player sees something.
  drawEmpty();
  showOverlay(
    'Kazı',
    'Toprağın altında bir tablet gömülü. Önce fırça ile sahayı tara (altın ışıltı = tablet ipucu), sonra kazma ile doğrulanmış hücreleri hızla aç. Enerji bitmeden tamamla.',
    'Başla',
  );
}

function applyTool(cx: number, cy: number): void {
  if (state !== 'playing') return;
  if (cx < 0 || cx >= COLS || cy < 0 || cy >= ROWS) return;
  const cell = grid[cy]![cx]!;
  if (cell.dirt === 0) return;
  if (energy <= 0) return;

  if (tool === 'brush') {
    cell.dirt = Math.max(0, cell.dirt - 1);
    cell.dug = true;
  } else {
    // Pick: full clear. Damage if cell was not yet brushed AND has treasure.
    const wasUntouched = !cell.dug;
    cell.dirt = 0;
    cell.dug = true;
    if (wasUntouched && cell.treasure) {
      cell.damaged = true;
    }
  }
  energy--;

  if (cell.treasure && cell.dirt === 0) {
    exposedTreasure++;
    if (cell.damaged) {
      score += SCORE_DAMAGED;
      damagedCount++;
    } else {
      score += SCORE_SAFE;
    }
    if (score < 0) score = 0;
  }

  syncHUD();
  draw();

  if (exposedTreasure >= totalTreasure) {
    onLevelWin();
    return;
  }
  if (energy <= 0) {
    onLevelLose();
    return;
  }
}

function onLevelWin(): void {
  state = 'win';
  commitBest();
  const cleanBonus = damagedCount === 0 ? 20 : 0;
  if (cleanBonus > 0) {
    score += cleanBonus;
    syncHUD();
    commitBest();
  }
  const stats = damagedCount === 0
    ? `Hiç çatlatmadın! +${cleanBonus} bonus puan. Toplam: ${score}.`
    : `${damagedCount} parça çatladı. Toplam: ${score}.`;
  showOverlay(
    `Seviye ${level} tamamlandı`,
    `${stats} Sonraki seviyede tablet biraz büyür ve enerji 4 artar.`,
    'Sonraki seviye',
  );
}

function onLevelLose(): void {
  state = 'lose';
  commitBest();
  showOverlay(
    'Enerji bitti',
    `Tablet yarım kaldı (${exposedTreasure}/${totalTreasure} parça). Toplam skor: ${score}. R ile veya butonla yeniden başla.`,
    'Yeniden başla',
  );
}

// --- Drawing ---------------------------------------------------------------

const cssCache = new Map<string, string>();
function getCss(name: string, fallback: string): string {
  const cached = cssCache.get(name);
  if (cached !== undefined && cached !== '') return cached;
  let v = '';
  try {
    v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  } catch {
    v = '';
  }
  if (!v) v = fallback;
  cssCache.set(name, v);
  return v;
}

function fillRoundRect(x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
  ctx.fill();
}

function strokeRoundRect(x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
  ctx.stroke();
}

function drawCellAt(x: number, y: number, cell: Cell): void {
  const px = x * cellW;
  const py = y * cellH;
  const pad = 3;
  const cx = px + pad;
  const cy = py + pad;
  const cwid = cellW - pad * 2;
  const chei = cellH - pad * 2;

  if (cell.dirt === 0) {
    // Exposed.
    if (cell.treasure) {
      if (cell.damaged) {
        ctx.fillStyle = '#a14535';
        fillRoundRect(cx, cy, cwid, chei, 6);
        // crack pattern
        ctx.strokeStyle = '#3a1414';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(cx + 6, cy + chei * 0.3);
        ctx.lineTo(cx + cwid * 0.4, cy + chei * 0.55);
        ctx.lineTo(cx + cwid * 0.55, cy + chei * 0.3);
        ctx.lineTo(cx + cwid - 6, cy + chei * 0.7);
        ctx.stroke();
      } else {
        // Gold tablet tile.
        const grad = ctx.createLinearGradient(cx, cy, cx + cwid, cy + chei);
        grad.addColorStop(0, '#f5c542');
        grad.addColorStop(1, '#c98a1c');
        ctx.fillStyle = grad;
        fillRoundRect(cx, cy, cwid, chei, 6);
        // Hieroglyph-ish accent
        ctx.fillStyle = 'rgba(60, 30, 5, 0.5)';
        const dotR = Math.min(cwid, chei) * 0.08;
        ctx.beginPath();
        ctx.arc(cx + cwid * 0.5, cy + chei * 0.5, dotR, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillRect(cx + cwid * 0.3, cy + chei * 0.72, cwid * 0.4, Math.max(2, chei * 0.06));
      }
    } else {
      // Empty: gray bedrock.
      ctx.fillStyle = '#3a3d44';
      fillRoundRect(cx, cy, cwid, chei, 6);
      // small speckle
      ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
      ctx.fillRect(cx + cwid * 0.2, cy + chei * 0.3, cwid * 0.15, chei * 0.08);
      ctx.fillRect(cx + cwid * 0.6, cy + chei * 0.6, cwid * 0.12, chei * 0.06);
    }
    return;
  }

  // Dirt remaining.
  const shades = ['#7a4a26', '#8a5530', '#9a623c']; // dirt 1, 2, 3
  const baseColor = shades[Math.max(0, Math.min(2, cell.dirt - 1))]!;
  ctx.fillStyle = baseColor;
  fillRoundRect(cx, cy, cwid, chei, 6);

  // Hatching to indicate dirt density.
  ctx.strokeStyle = 'rgba(40, 22, 10, 0.55)';
  ctx.lineWidth = 1;
  const lines = cell.dirt; // 1, 2, or 3
  for (let i = 0; i < lines; i++) {
    const yy = cy + ((i + 1) * chei) / (lines + 1);
    ctx.beginPath();
    ctx.moveTo(cx + 4, yy);
    ctx.lineTo(cx + cwid - 4, yy);
    ctx.stroke();
  }

  // Hint glow when dug and treasure underneath.
  if (cell.dug && cell.treasure) {
    const intensity = cell.dirt === 1 ? 0.65 : 0.35;
    ctx.fillStyle = `rgba(245, 200, 70, ${intensity * 0.35})`;
    fillRoundRect(cx, cy, cwid, chei, 6);
    ctx.strokeStyle = `rgba(245, 197, 66, ${intensity})`;
    ctx.lineWidth = 2;
    strokeRoundRect(cx + 1, cy + 1, cwid - 2, chei - 2, 5);
  } else if (cell.dug && !cell.treasure) {
    // Subtle "checked, empty" indicator
    ctx.strokeStyle = 'rgba(220, 220, 220, 0.18)';
    ctx.lineWidth = 1;
    strokeRoundRect(cx + 1, cy + 1, cwid - 2, chei - 2, 5);
  }
}

function drawEmpty(): void {
  ctx.fillStyle = getCss('--surface', '#0a0b0e');
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#6a4a30';
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const px = x * cellW;
      const py = y * cellH;
      fillRoundRect(px + 3, py + 3, cellW - 6, cellH - 6, 6);
    }
  }
}

function draw(): void {
  ctx.fillStyle = getCss('--surface', '#0a0b0e');
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const cell = grid[y]?.[x];
      if (!cell) continue;
      drawCellAt(x, y, cell);
    }
  }
}

// --- Input -----------------------------------------------------------------

function onCanvasClick(e: PointerEvent | MouseEvent): void {
  if (state === 'ready' || state === 'win' || state === 'lose') {
    onPrimaryAction();
    return;
  }
  if (state !== 'playing') return;
  const rect = canvas.getBoundingClientRect();
  const px = ((e.clientX - rect.left) / rect.width) * canvas.width;
  const py = ((e.clientY - rect.top) / rect.height) * canvas.height;
  const cx = Math.floor(px / cellW);
  const cy = Math.floor(py / cellH);
  applyTool(cx, cy);
}

function onPrimaryAction(): void {
  if (state === 'ready') {
    startGame();
  } else if (state === 'win') {
    nextLevel();
  } else if (state === 'lose') {
    reset();
    startGame();
  }
}

function onKey(e: KeyboardEvent): void {
  const k = e.key.toLowerCase();
  if (k === '1') {
    if (state === 'playing') setTool('brush');
    e.preventDefault();
    return;
  }
  if (k === '2') {
    if (state === 'playing') setTool('pick');
    e.preventDefault();
    return;
  }
  if (k === 'r') {
    reset();
    e.preventDefault();
    return;
  }
  if (k === ' ' || k === 'enter') {
    onPrimaryAction();
    e.preventDefault();
    return;
  }
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  levelEl = document.querySelector<HTMLElement>('#level')!;
  energyEl = document.querySelector<HTMLElement>('#energy')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  brushBtn = document.querySelector<HTMLButtonElement>('#tool-brush')!;
  pickBtn = document.querySelector<HTMLButtonElement>('#tool-pick')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayStart = document.querySelector<HTMLButtonElement>('#overlay-start')!;

  cellW = canvas.width / COLS;
  cellH = canvas.height / ROWS;
  best = safeRead<number>(STORAGE_BEST, 0);

  canvas.addEventListener('pointerdown', onCanvasClick);
  // Avoid context menu on right-click; we only use left taps.
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('keydown', onKey);
  restartBtn.addEventListener('click', () => {
    reset();
  });
  brushBtn.addEventListener('click', () => {
    if (state === 'playing') setTool('brush');
  });
  pickBtn.addEventListener('click', () => {
    if (state === 'playing') setTool('pick');
  });
  overlayStart.addEventListener('click', (e) => {
    e.stopPropagation();
    onPrimaryAction();
  });

  reset();
}

export const game = defineGame({ init, reset });
