// Aydınlat (Light Up / Akari). Deductive logic puzzle: place lamps on white
// cells so that (a) every white cell is illuminated, (b) no two lamps see
// each other along a row/column without a wall in between, and (c) every
// numbered black wall has exactly that many lamps in its 4 orthogonal
// neighbors. Click cycles each white cell through empty → lamp → mark → empty;
// the X mark is a player-only annotation ("I won't put a lamp here").

import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';
import { reportGameOver } from '@shared/leaderboard';

type Marker = 'none' | 'lamp' | 'x';

interface Cell {
  isWall: boolean;
  wallNum: number | null; // 0-4 if numbered wall, else null
  marker: Marker;
}

type RawLevel = readonly string[];

// Hand-crafted levels. Each is verified solvable; the game accepts any valid
// placement (not just the canonical one).
//   . = white empty cell
//   # = unnumbered black wall
//   0..4 = numbered black wall (count of orthogonally adjacent lamps required)
const LEVELS: readonly RawLevel[] = [
  [
    '.....',
    '..#..',
    '.....',
    '..#..',
    '.....',
  ],
  [
    '....1',
    '..#..',
    '.....',
    '..#..',
    '1....',
  ],
  [
    '.....',
    '.0.2.',
    '.....',
    '.2.0.',
    '.....',
  ],
  [
    '......',
    '.#..#.',
    '......',
    '......',
    '.#..#.',
    '......',
  ],
  [
    '......',
    '.0..0.',
    '......',
    '......',
    '.0..0.',
    '......',
  ],
];

const STORAGE_LEVEL = 'aydinlat.level';
const STORAGE_CLEARED = 'aydinlat.cleared';
const SCORE_DESC = { gameId: 'aydinlat', storageKey: STORAGE_CLEARED, direction: 'higher' as const };
const WIN_DELAY_MS = 520;

const gen = createGenToken();

let levelIdx = 0;
let cleared = 0;
let grid: Cell[][] = [];
let rows = 0;
let cols = 0;
let cellEls: HTMLButtonElement[][] = [];
let solvedThisLevel = false;

let boardEl!: HTMLElement;
let levelEl!: HTMLElement;
let bulbsEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayNext!: HTMLButtonElement;

function parseLevel(raw: RawLevel): Cell[][] {
  return raw.map((row) =>
    row.split('').map<Cell>((ch) => {
      if (ch === '.') return { isWall: false, wallNum: null, marker: 'none' };
      if (ch === '#') return { isWall: true, wallNum: null, marker: 'none' };
      const n = Number(ch);
      return { isWall: true, wallNum: n, marker: 'none' };
    }),
  );
}

interface IlluminationResult {
  lit: boolean[][];
  conflictLamps: Set<string>;
}

function computeIllumination(): IlluminationResult {
  const lit: boolean[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: boolean[] = [];
    for (let c = 0; c < cols; c++) row.push(false);
    lit.push(row);
  }
  const conflictLamps = new Set<string>();
  const lamps: Array<[number, number]> = [];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (grid[r]![c]!.marker === 'lamp') lamps.push([r, c]);
    }
  }

  for (const [r, c] of lamps) {
    lit[r]![c] = true;
    for (let rr = r - 1; rr >= 0 && !grid[rr]![c]!.isWall; rr--) {
      lit[rr]![c] = true;
      if (grid[rr]![c]!.marker === 'lamp') {
        conflictLamps.add(`${r},${c}`);
        conflictLamps.add(`${rr},${c}`);
      }
    }
    for (let rr = r + 1; rr < rows && !grid[rr]![c]!.isWall; rr++) {
      lit[rr]![c] = true;
      if (grid[rr]![c]!.marker === 'lamp') {
        conflictLamps.add(`${r},${c}`);
        conflictLamps.add(`${rr},${c}`);
      }
    }
    for (let cc = c - 1; cc >= 0 && !grid[r]![cc]!.isWall; cc--) {
      lit[r]![cc] = true;
      if (grid[r]![cc]!.marker === 'lamp') {
        conflictLamps.add(`${r},${c}`);
        conflictLamps.add(`${r},${cc}`);
      }
    }
    for (let cc = c + 1; cc < cols && !grid[r]![cc]!.isWall; cc++) {
      lit[r]![cc] = true;
      if (grid[r]![cc]!.marker === 'lamp') {
        conflictLamps.add(`${r},${c}`);
        conflictLamps.add(`${r},${cc}`);
      }
    }
  }
  return { lit, conflictLamps };
}

function countAdjacentLamps(r: number, c: number): number {
  let count = 0;
  const deltas: ReadonlyArray<readonly [number, number]> = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ];
  for (const [dr, dc] of deltas) {
    const rr = r + dr;
    const cc = c + dc;
    if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
    if (grid[rr]![cc]!.marker === 'lamp') count++;
  }
  return count;
}

function isWallSatisfied(r: number, c: number): boolean | null {
  const cell = grid[r]![c]!;
  if (!cell.isWall || cell.wallNum === null) return null;
  return countAdjacentLamps(r, c) === cell.wallNum;
}

function buildBoard(): void {
  boardEl.innerHTML = '';
  boardEl.style.setProperty('--ay-cols', String(cols));
  boardEl.style.setProperty('--ay-rows', String(rows));
  cellEls = [];
  for (let r = 0; r < rows; r++) {
    const rowEls: HTMLButtonElement[] = [];
    for (let c = 0; c < cols; c++) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ay-cell';
      btn.dataset.r = String(r);
      btn.dataset.c = String(c);
      const cell = grid[r]![c]!;
      if (cell.isWall) {
        btn.classList.add('ay-cell--wall');
        btn.disabled = true;
        btn.setAttribute(
          'aria-label',
          cell.wallNum !== null
            ? `Duvar ${r + 1},${c + 1}, ${cell.wallNum} komşu lamba gerekli`
            : `Duvar ${r + 1},${c + 1}`,
        );
        if (cell.wallNum !== null) {
          const span = document.createElement('span');
          span.className = 'ay-cell__num';
          span.textContent = String(cell.wallNum);
          btn.appendChild(span);
        }
      } else {
        btn.setAttribute('aria-label', `Hücre ${r + 1},${c + 1}`);
        btn.addEventListener('click', onCellClick);
        btn.addEventListener('contextmenu', onCellRightClick);
      }
      boardEl.appendChild(btn);
      rowEls.push(btn);
    }
    cellEls.push(rowEls);
  }
}

function renderCells(illum: IlluminationResult): void {
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = grid[r]![c]!;
      const el = cellEls[r]![c]!;
      if (cell.isWall) {
        if (cell.wallNum !== null) {
          const satisfied = isWallSatisfied(r, c);
          el.classList.toggle('ay-cell--wall-bad', satisfied === false);
        }
        continue;
      }
      const lit = illum.lit[r]![c]!;
      const inConflict = illum.conflictLamps.has(`${r},${c}`);
      el.classList.toggle('ay-cell--lamp', cell.marker === 'lamp');
      el.classList.toggle('ay-cell--x', cell.marker === 'x');
      el.classList.toggle('ay-cell--lit', lit && cell.marker !== 'lamp');
      el.classList.toggle('ay-cell--conflict', inConflict);
      el.setAttribute(
        'aria-pressed',
        cell.marker === 'lamp' ? 'true' : 'false',
      );
    }
  }
}

function renderHud(): void {
  levelEl.textContent = `${levelIdx + 1} / ${LEVELS.length}`;
  let lampCount = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (grid[r]![c]!.marker === 'lamp') lampCount++;
    }
  }
  bulbsEl.textContent = String(lampCount);
}

function checkWin(illum: IlluminationResult): boolean {
  if (illum.conflictLamps.size > 0) return false;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = grid[r]![c]!;
      if (cell.isWall) {
        if (cell.wallNum !== null) {
          if (countAdjacentLamps(r, c) !== cell.wallNum) return false;
        }
      } else {
        if (!illum.lit[r]![c]) return false;
      }
    }
  }
  return true;
}

function rerender(): void {
  const illum = computeIllumination();
  renderCells(illum);
  renderHud();
  if (!solvedThisLevel && checkWin(illum)) {
    solvedThisLevel = true;
    if (levelIdx + 1 > cleared) {
      cleared = levelIdx + 1;
      safeWrite(STORAGE_CLEARED, cleared);
    }
    reportGameOver(SCORE_DESC, cleared, { label: 'Bölüm' });
    const myGen = gen.current();
    window.setTimeout(() => {
      if (!gen.isCurrent(myGen)) return;
      showWin();
    }, WIN_DELAY_MS);
  }
}

function cycle(marker: Marker, forward: boolean): Marker {
  if (forward) {
    if (marker === 'none') return 'lamp';
    if (marker === 'lamp') return 'x';
    return 'none';
  }
  if (marker === 'none') return 'x';
  if (marker === 'x') return 'lamp';
  return 'none';
}

function onCellClick(e: MouseEvent): void {
  if (solvedThisLevel) return;
  const target = e.currentTarget as HTMLButtonElement | null;
  if (!target) return;
  const r = Number(target.dataset.r);
  const c = Number(target.dataset.c);
  if (!Number.isInteger(r) || !Number.isInteger(c)) return;
  const cell = grid[r]![c]!;
  if (cell.isWall) return;
  cell.marker = cycle(cell.marker, !e.shiftKey);
  rerender();
}

function onCellRightClick(e: MouseEvent): void {
  e.preventDefault();
  if (solvedThisLevel) return;
  const target = e.currentTarget as HTMLButtonElement | null;
  if (!target) return;
  const r = Number(target.dataset.r);
  const c = Number(target.dataset.c);
  if (!Number.isInteger(r) || !Number.isInteger(c)) return;
  const cell = grid[r]![c]!;
  if (cell.isWall) return;
  cell.marker = cycle(cell.marker, false);
  rerender();
}

function showWin(): void {
  const isLast = levelIdx + 1 >= LEVELS.length;
  overlayTitle.textContent = isLast
    ? 'Tüm bölümler tamam!'
    : `Bölüm ${levelIdx + 1} tamam!`;
  overlayMsg.textContent = isLast
    ? 'Tebrikler — başa dön ve daha az lambayla çözmeye çalış.'
    : 'Bir sonraki bölüme geçmeye hazırsın.';
  overlayNext.textContent = isLast ? 'Başa dön' : 'Sonraki bölüm';
  showOverlayEl(overlay);
  overlayNext.focus({ preventScroll: true });
}

function loadLevel(idx: number): void {
  gen.bump();
  solvedThisLevel = false;
  levelIdx = ((idx % LEVELS.length) + LEVELS.length) % LEVELS.length;
  safeWrite(STORAGE_LEVEL, levelIdx);
  const raw = LEVELS[levelIdx]!;
  grid = parseLevel(raw);
  rows = grid.length;
  cols = grid[0]!.length;
  buildBoard();
  hideOverlayEl(overlay);
  rerender();
}

function resetCurrent(): void {
  gen.bump();
  solvedThisLevel = false;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = grid[r]![c]!;
      if (!cell.isWall) cell.marker = 'none';
    }
  }
  hideOverlayEl(overlay);
  rerender();
}

function nextLevel(): void {
  loadLevel(levelIdx + 1);
}

function init(): void {
  boardEl = document.querySelector<HTMLElement>('#board')!;
  levelEl = document.querySelector<HTMLElement>('#level')!;
  bulbsEl = document.querySelector<HTMLElement>('#bulbs')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayNext = document.querySelector<HTMLButtonElement>('#overlay-next')!;

  cleared = safeRead<number>(STORAGE_CLEARED, 0);
  const savedLevel = safeRead<number>(STORAGE_LEVEL, 0);
  const startIdx =
    Number.isInteger(savedLevel) && savedLevel >= 0 && savedLevel < LEVELS.length
      ? savedLevel
      : 0;

  restartBtn.addEventListener('click', resetCurrent);
  overlayNext.addEventListener('click', nextLevel);

  window.addEventListener('keydown', (e) => {
    if (e.key === 'r' || e.key === 'R') {
      resetCurrent();
      e.preventDefault();
    } else if (e.key === 'n' || e.key === 'N') {
      nextLevel();
      e.preventDefault();
    } else if (e.key === 'Enter' && solvedThisLevel) {
      nextLevel();
      e.preventDefault();
    }
  });

  loadLevel(startIdx);
}

export const game = defineGame({ init, reset: resetCurrent });
