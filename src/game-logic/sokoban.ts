// Sokoban — kutuları hedef noktalarına itme bulmacası.
//
// Notasyon (yaygın Sokoban formatı):
//   #  = duvar
//   ' '= zemin (içeri girilebilir)
//   .  = hedef
//   $  = kutu
//   *  = hedefte duran kutu
//   @  = oyuncu
//   +  = hedefte duran oyuncu
//
// State machine: playing → levelClear → (next) playing
//                                    \→ gameComplete (son seviye)
// Yasak: kutu çekme. Sadece itme. İki ardışık kutuyu birlikte itme yok.

type Cell = 'wall' | 'floor' | 'goal';
type Dir = 'up' | 'down' | 'left' | 'right';
type GameState = 'playing' | 'levelClear' | 'gameComplete';

interface LevelData {
  grid: Cell[][];
  player: { x: number; y: number };
  boxes: { x: number; y: number }[];
  goals: { x: number; y: number }[];
  width: number;
  height: number;
}

interface MoveRecord {
  dx: number;
  dy: number;
  pushedBoxFrom?: { x: number; y: number };
}

const LEVELS: string[] = [
  // 1: Tek kutu, tek hedef — kavramı öğret
  [
    '#######',
    '#     #',
    '# .$@ #',
    '#     #',
    '#######',
  ].join('\n'),
  // 2: Kutu sağa itme, sonra yukarı dönme
  [
    '########',
    '#      #',
    '# $    #',
    '# @  . #',
    '#      #',
    '########',
  ].join('\n'),
  // 3: İki kutu, iki hedef
  [
    '#########',
    '#       #',
    '# .$ $. #',
    '#   @   #',
    '#       #',
    '#########',
  ].join('\n'),
  // 4: U-şekilli engel, kutuyu döndür
  [
    '########',
    '#  .   #',
    '# ###  #',
    '# # $  #',
    '# #  @ #',
    '#      #',
    '########',
  ].join('\n'),
  // 5: Üç kutu, üç hedef yan yana
  [
    '##########',
    '#        #',
    '# ...    #',
    '# $$$    #',
    '#     @  #',
    '#        #',
    '##########',
  ].join('\n'),
  // 6: Engelli koridor — kutuları doğru sırayla yerleştir
  [
    '##########',
    '#   #    #',
    '# $ # .  #',
    '# @ # .  #',
    '# $ #    #',
    '#   ##   #',
    '#        #',
    '##########',
  ].join('\n'),
  // 7: Köşelerden kaçınma
  [
    '##########',
    '#    .   #',
    '#  ####  #',
    '# $    $ #',
    '#  .  .  #',
    '# $  @ $ #',
    '#  .     #',
    '##########',
  ].join('\n'),
  // 8: Sıkışık alanda planlama
  [
    '##########',
    '#  ....  #',
    '#  $$$$  #',
    '#        #',
    '#   @    #',
    '#        #',
    '##########',
  ].join('\n'),
  // 9: Çapraz dağılım
  [
    '##########',
    '#.       #',
    '# $      #',
    '#   .$   #',
    '#   @    #',
    '#   $.   #',
    '#      $ #',
    '#       .#',
    '##########',
  ].join('\n'),
  // 10: Final — sıkışık 4-kutu puzzle
  [
    '##########',
    '#   .    #',
    '# $   $  #',
    '#   .  . #',
    '# $ @    #',
    '#   $  . #',
    '##########',
  ].join('\n'),
];

const STORAGE_BEST = 'sokoban.best';
const STORAGE_LEVEL = 'sokoban.level';

const CANVAS_W = 480;
const CANVAS_H = 480;

const canvas = document.querySelector<HTMLCanvasElement>('#board')!;
const ctx = canvas.getContext('2d')!;
const levelEl = document.querySelector<HTMLElement>('#level')!;
const movesEl = document.querySelector<HTMLElement>('#moves')!;
const pushesEl = document.querySelector<HTMLElement>('#pushes')!;
const bestEl = document.querySelector<HTMLElement>('#best')!;
const undoBtn = document.querySelector<HTMLButtonElement>('#undo')!;
const restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
const nextBtn = document.querySelector<HTMLButtonElement>('#next')!;
const overlay = document.querySelector<HTMLElement>('#overlay')!;
const overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
const overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
const overlayNextBtn = document.querySelector<HTMLButtonElement>('#overlay-next')!;
const touchButtons = document.querySelectorAll<HTMLButtonElement>('.sb-touch__btn');

let state: GameState = 'playing';
let currentLevelIdx = 0;
let level: LevelData = parseLevel(LEVELS[0]!);
let moves = 0;
let pushes = 0;
let history: MoveRecord[] = [];
let best = 0; // highest completed level (1-indexed); 0 means none completed yet

function safeReadNumber(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

function safeWriteNumber(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* ignore */
  }
}

function parseLevel(text: string): LevelData {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const height = rows.length;
  const width = Math.max(...rows.map((r) => r.length));
  const grid: Cell[][] = [];
  let playerPos: { x: number; y: number } = { x: 0, y: 0 };
  const boxes: { x: number; y: number }[] = [];
  const goals: { x: number; y: number }[] = [];

  for (let y = 0; y < height; y++) {
    const row: Cell[] = [];
    const line = rows[y]!;
    for (let x = 0; x < width; x++) {
      const ch = x < line.length ? line[x]! : ' ';
      let cell: Cell;
      switch (ch) {
        case '#':
          cell = 'wall';
          break;
        case '.':
        case '+':
        case '*':
          cell = 'goal';
          goals.push({ x, y });
          break;
        default:
          cell = 'floor';
          break;
      }
      if (ch === '@' || ch === '+') {
        playerPos = { x, y };
      }
      if (ch === '$' || ch === '*') {
        boxes.push({ x, y });
      }
      row.push(cell);
    }
    grid.push(row);
  }

  return { grid, player: playerPos, boxes, goals, width, height };
}

interface RenderInfo {
  cell: number;
  offsetX: number;
  offsetY: number;
}

// visual-vs-hitbox pitfall: render boyutları tek const'tan; hareket validation
// hücre indekslerini kullanır, draw da aynı indeksleri kullanır.
function computeRenderInfo(lvl: LevelData): RenderInfo {
  const maxByW = Math.floor(CANVAS_W / lvl.width);
  const maxByH = Math.floor(CANVAS_H / lvl.height);
  const cell = Math.max(8, Math.min(maxByW, maxByH));
  const offsetX = Math.floor((CANVAS_W - cell * lvl.width) / 2);
  const offsetY = Math.floor((CANVAS_H - cell * lvl.height) / 2);
  return { cell, offsetX, offsetY };
}

const cssCache = new Map<string, string>();
function getCss(name: string, fallback: string): string {
  const cached = cssCache.get(name);
  if (cached !== undefined && cached !== '') return cached;
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    if (v) {
      cssCache.set(name, v);
      return v;
    }
  } catch {
    /* ignore */
  }
  return fallback;
}

function cellAt(x: number, y: number): Cell {
  if (y < 0 || y >= level.height) return 'wall';
  if (x < 0 || x >= level.width) return 'wall';
  return level.grid[y]![x]!;
}

function boxAt(x: number, y: number): number {
  for (let i = 0; i < level.boxes.length; i++) {
    const b = level.boxes[i]!;
    if (b.x === x && b.y === y) return i;
  }
  return -1;
}

function isBoxOnGoal(b: { x: number; y: number }): boolean {
  return cellAt(b.x, b.y) === 'goal';
}

function isSolved(): boolean {
  if (level.boxes.length === 0) return false;
  if (level.boxes.length !== level.goals.length) return false;
  for (const b of level.boxes) {
    if (!isBoxOnGoal(b)) return false;
  }
  return true;
}

function dirToDelta(d: Dir): { dx: number; dy: number } {
  switch (d) {
    case 'up':
      return { dx: 0, dy: -1 };
    case 'down':
      return { dx: 0, dy: 1 };
    case 'left':
      return { dx: -1, dy: 0 };
    case 'right':
      return { dx: 1, dy: 0 };
  }
}

function move(d: Dir): boolean {
  // overlay-input-leak guard
  if (state !== 'playing') return false;
  const { dx, dy } = dirToDelta(d);
  const nx = level.player.x + dx;
  const ny = level.player.y + dy;
  const targetCell = cellAt(nx, ny);
  if (targetCell === 'wall') return false;

  const boxIdx = boxAt(nx, ny);
  if (boxIdx >= 0) {
    const bx = nx + dx;
    const by = ny + dy;
    const beyondCell = cellAt(bx, by);
    if (beyondCell === 'wall') return false;
    if (boxAt(bx, by) >= 0) return false; // iki kutu üst üste itilemez

    const fromPos = { x: level.boxes[boxIdx]!.x, y: level.boxes[boxIdx]!.y };
    level.boxes[boxIdx] = { x: bx, y: by };
    level.player = { x: nx, y: ny };
    moves++;
    pushes++;
    history.push({ dx, dy, pushedBoxFrom: fromPos });
    afterMove();
    return true;
  }

  level.player = { x: nx, y: ny };
  moves++;
  history.push({ dx, dy });
  afterMove();
  return true;
}

function afterMove(): void {
  updateHud();
  draw();
  if (isSolved()) {
    handleLevelClear();
  }
}

function undo(): void {
  if (state !== 'playing') return;
  const last = history.pop();
  if (!last) return;
  const prevPlayerX = level.player.x - last.dx;
  const prevPlayerY = level.player.y - last.dy;
  if (last.pushedBoxFrom) {
    const curBoxX = level.player.x + last.dx;
    const curBoxY = level.player.y + last.dy;
    const idx = boxAt(curBoxX, curBoxY);
    if (idx >= 0) {
      level.boxes[idx] = { x: last.pushedBoxFrom.x, y: last.pushedBoxFrom.y };
      pushes = Math.max(0, pushes - 1);
    }
  }
  level.player = { x: prevPlayerX, y: prevPlayerY };
  moves = Math.max(0, moves - 1);
  updateHud();
  draw();
}

function loadLevel(idx: number): void {
  if (idx < 0 || idx >= LEVELS.length) return;
  currentLevelIdx = idx;
  safeWriteNumber(STORAGE_LEVEL, currentLevelIdx);
  level = parseLevel(LEVELS[idx]!);
  moves = 0;
  pushes = 0;
  history = [];
  state = 'playing';
  hideOverlay();
  updateHud();
  draw();
}

function restartLevel(): void {
  loadLevel(currentLevelIdx);
}

function nextLevel(): void {
  if (currentLevelIdx + 1 < LEVELS.length) {
    loadLevel(currentLevelIdx + 1);
  } else {
    loadLevel(0);
  }
}

function handleLevelClear(): void {
  const completedLevelNumber = currentLevelIdx + 1;
  if (completedLevelNumber > best) {
    best = completedLevelNumber;
    safeWriteNumber(STORAGE_BEST, best);
    bestEl.textContent = String(best);
  }
  if (currentLevelIdx + 1 >= LEVELS.length) {
    state = 'gameComplete';
    showOverlay(
      'Tüm seviyeler tamam!',
      `${moves} hamle · ${pushes} itme. Başa dönmek için N veya Sonraki.`,
    );
  } else {
    state = 'levelClear';
    showOverlay(
      'Seviye tamam!',
      `${moves} hamle · ${pushes} itme · Seviye ${currentLevelIdx + 1}/${LEVELS.length}`,
    );
  }
}

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  overlay.classList.remove('sb-overlay--hidden');
  overlay.setAttribute('aria-hidden', 'false');
  if (state === 'gameComplete') {
    overlayNextBtn.textContent = 'Başa dön';
  } else {
    overlayNextBtn.textContent = 'Sonraki seviye';
  }
}

function hideOverlay(): void {
  overlay.classList.add('sb-overlay--hidden');
  overlay.setAttribute('aria-hidden', 'true');
}

function updateHud(): void {
  levelEl.textContent = String(currentLevelIdx + 1);
  movesEl.textContent = String(moves);
  pushesEl.textContent = String(pushes);
  bestEl.textContent = String(best);
  undoBtn.disabled = history.length === 0 || state !== 'playing';
  undoBtn.setAttribute('aria-disabled', undoBtn.disabled ? 'true' : 'false');
  nextBtn.disabled = state === 'playing';
  nextBtn.setAttribute('aria-disabled', nextBtn.disabled ? 'true' : 'false');
}

// -------------------- Çizim --------------------

function draw(): void {
  const info = computeRenderInfo(level);
  const cell = info.cell;
  const ox = info.offsetX;
  const oy = info.offsetY;

  ctx.fillStyle = getCss('--surface', '#1e2230');
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  const wallCol = getCss('--sb-wall', '#3a4256');
  const floorCol = getCss('--sb-floor', '#262b39');
  const goalRingCol = getCss('--sb-goal', '#6366f1');
  const goalDotCol = getCss('--sb-goal-dot', '#a5b4fc');
  const boxCol = getCss('--sb-box', '#d97706');
  const boxOnGoalCol = getCss('--sb-box-on-goal', '#22c55e');
  const playerCol = getCss('--sb-player', '#f8fafc');
  const playerOutlineCol = getCss('--sb-player-outline', '#0f172a');

  for (let y = 0; y < level.height; y++) {
    for (let x = 0; x < level.width; x++) {
      const c = level.grid[y]![x]!;
      const px = ox + x * cell;
      const py = oy + y * cell;
      if (c === 'wall') {
        drawWall(px, py, cell, wallCol);
      } else {
        ctx.fillStyle = floorCol;
        ctx.fillRect(px, py, cell, cell);
        if (c === 'goal') {
          drawGoal(px, py, cell, goalRingCol, goalDotCol);
        }
      }
    }
  }

  for (const b of level.boxes) {
    const px = ox + b.x * cell;
    const py = oy + b.y * cell;
    const onGoal = isBoxOnGoal(b);
    drawBox(px, py, cell, onGoal ? boxOnGoalCol : boxCol, onGoal);
  }

  const ppx = ox + level.player.x * cell;
  const ppy = oy + level.player.y * cell;
  drawPlayer(ppx, ppy, cell, playerCol, playerOutlineCol);
}

function drawWall(x: number, y: number, size: number, color: string): void {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, size, size);
  ctx.strokeStyle = 'rgba(0,0,0,0.30)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, y + size / 2);
  ctx.lineTo(x + size, y + size / 2);
  ctx.moveTo(x + size / 2, y);
  ctx.lineTo(x + size / 2, y + size / 2);
  ctx.moveTo(x, y + size);
  ctx.lineTo(x + size, y + size);
  ctx.stroke();
}

function drawGoal(x: number, y: number, size: number, ring: string, dot: string): void {
  const cx = x + size / 2;
  const cy = y + size / 2;
  const r = Math.max(3, size * 0.18);
  ctx.strokeStyle = ring;
  ctx.lineWidth = Math.max(1.5, size * 0.06);
  ctx.beginPath();
  ctx.arc(cx, cy, r * 1.6, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = dot;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.55, 0, Math.PI * 2);
  ctx.fill();
}

function drawBox(x: number, y: number, size: number, color: string, onGoal: boolean): void {
  const pad = Math.max(2, size * 0.1);
  const bx = x + pad;
  const by = y + pad;
  const bs = size - pad * 2;
  ctx.fillStyle = color;
  ctx.fillRect(bx, by, bs, bs);
  ctx.strokeStyle = onGoal ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.55)';
  ctx.lineWidth = Math.max(1.5, size * 0.05);
  ctx.strokeRect(bx + 0.5, by + 0.5, bs - 1, bs - 1);
  ctx.beginPath();
  ctx.moveTo(bx, by);
  ctx.lineTo(bx + bs, by + bs);
  ctx.moveTo(bx + bs, by);
  ctx.lineTo(bx, by + bs);
  ctx.stroke();
}

function drawPlayer(x: number, y: number, size: number, fill: string, outline: string): void {
  const cx = x + size / 2;
  const cy = y + size / 2;
  const r = size * 0.36;
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = Math.max(1.5, size * 0.05);
  ctx.strokeStyle = outline;
  ctx.stroke();
  const eyeR = Math.max(1, size * 0.05);
  ctx.fillStyle = outline;
  ctx.beginPath();
  ctx.arc(cx - r * 0.32, cy - r * 0.18, eyeR, 0, Math.PI * 2);
  ctx.arc(cx + r * 0.32, cy - r * 0.18, eyeR, 0, Math.PI * 2);
  ctx.fill();
}

// -------------------- Input --------------------

function handleKeyDown(e: KeyboardEvent): void {
  const k = e.key;
  const kl = k.toLowerCase();

  if (state === 'levelClear' || state === 'gameComplete') {
    // overlay-input-leak pitfall: hareket tuşları arka grid'i etkilemesin.
    if (kl === 'n' || k === 'Enter' || k === ' ') {
      if (state === 'gameComplete') {
        loadLevel(0);
      } else {
        nextLevel();
      }
      e.preventDefault();
      return;
    }
    if (kl === 'r') {
      restartLevel();
      e.preventDefault();
      return;
    }
    if (
      k === 'ArrowUp' ||
      k === 'ArrowDown' ||
      k === 'ArrowLeft' ||
      k === 'ArrowRight' ||
      kl === 'w' ||
      kl === 'a' ||
      kl === 's' ||
      kl === 'd' ||
      kl === 'z'
    ) {
      e.preventDefault();
    }
    return;
  }

  // state === 'playing'
  if (k === 'ArrowUp' || kl === 'w') {
    move('up');
    e.preventDefault();
    return;
  }
  if (k === 'ArrowDown' || kl === 's') {
    move('down');
    e.preventDefault();
    return;
  }
  if (k === 'ArrowLeft' || kl === 'a') {
    move('left');
    e.preventDefault();
    return;
  }
  if (k === 'ArrowRight' || kl === 'd') {
    move('right');
    e.preventDefault();
    return;
  }
  if (kl === 'z') {
    undo();
    e.preventDefault();
    return;
  }
  if (kl === 'r') {
    restartLevel();
    e.preventDefault();
    return;
  }
  if (kl === 'n') {
    // playing iken N atlamasın
    e.preventDefault();
  }
}

for (const btn of Array.from(touchButtons)) {
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    const dir = btn.dataset.dir as Dir | undefined;
    if (!dir) return;
    if (state === 'playing') {
      move(dir);
    }
  });
}

undoBtn.addEventListener('click', (e) => {
  e.preventDefault();
  undo();
});
restartBtn.addEventListener('click', (e) => {
  e.preventDefault();
  restartLevel();
});
nextBtn.addEventListener('click', (e) => {
  e.preventDefault();
  if (state === 'gameComplete') {
    loadLevel(0);
    return;
  }
  if (state === 'levelClear') {
    nextLevel();
  }
});
overlayNextBtn.addEventListener('click', (e) => {
  e.preventDefault();
  if (state === 'gameComplete') {
    loadLevel(0);
    return;
  }
  nextLevel();
});

window.addEventListener('keydown', handleKeyDown);

// -------------------- Init --------------------

// unguarded-storage pitfall: localStorage'ı init içinde okuyoruz, module-level
// side-effect değil. Hata atarsa fallback kullanırız.
function init(): void {
  const storedBest = safeReadNumber(STORAGE_BEST, 0);
  best = Math.max(0, Math.min(LEVELS.length, Math.floor(storedBest)));
  const storedLevel = safeReadNumber(STORAGE_LEVEL, 0);
  const startIdx =
    Number.isFinite(storedLevel) && storedLevel >= 0 && storedLevel < LEVELS.length
      ? Math.floor(storedLevel)
      : 0;
  loadLevel(startIdx);
}

init();
