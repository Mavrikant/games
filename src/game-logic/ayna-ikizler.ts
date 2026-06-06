import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay, hideOverlay } from '@shared/overlay';
import { reportGameOver } from '@shared/leaderboard';

// PITFALLS guarded here (see docs/PITFALLS.md):
// - unguarded-storage: best scores go through safeRead/safeWrite.
// - module-level-dom-access: all DOM access is inside init().
// - overlay-input-leak: movement is gated on status === 'playing'; the win
//   overlay only reacts to its own confirm action.
// - stale-dom-from-prev-state: loadLevel() rebuilds the whole board grid from
//   scratch before any twin is drawn, so a smaller level never reads stale
//   cells from a larger one.
// No timers / async, so no gen-token is needed.

type Dir = 'up' | 'down' | 'left' | 'right';
type Pos = { x: number; y: number };
type Status = 'playing' | 'won' | 'complete';

// Map symbols:
//   # wall   . floor   A blue start  a blue goal  B orange start  b orange goal
// Mirror rule: blue moves with the pressed direction; orange's horizontal axis
// is flipped (left<->right), vertical axis is shared. Verified solvable by BFS.
const LEVELS: readonly string[][] = [
  ['#####', '#A.a#', '#...#', '#b.B#', '#####'],
  ['#####', '#.#.#', '#.B.#', '#abA#', '#####'],
  ['#######', '#...A.#', '#b.#a.#', '#..B..#', '#######'],
  ['######', '#.##.#', '#a##.#', '#...A#', '#..Bb#', '######'],
  ['#######', '#.A.#b#', '#B.a..#', '#.##..#', '#######'],
  ['#######', '#.a..B#', '#.###.#', '#.Ab..#', '#######'],
];

const BEST_KEY = 'ayna-ikizler.best';
// Global leaderboard tracks the first level only (fixed difficulty so move
// counts are comparable). Fewer moves is better.
const SCORE_DESC = { gameId: 'ayna-ikizler-1', storageKey: 'ayna-ikizler.best-1', direction: 'lower' as const };

const DELTA: Record<Dir, Pos> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

let lvlIndex = 0;
let cols = 0;
let rows = 0;
let walls = new Set<string>();
let blue: Pos = { x: 0, y: 0 };
let orange: Pos = { x: 0, y: 0 };
let blueGoal: Pos = { x: 0, y: 0 };
let orangeGoal: Pos = { x: 0, y: 0 };
let moves = 0;
let history: { blue: Pos; orange: Pos }[] = [];
let status: Status = 'playing';
let bestMap: Record<string, number> = {};

let boardEl!: HTMLElement;
let levelEl!: HTMLElement;
let movesEl!: HTMLElement;
let bestEl!: HTMLElement;
let overlayEl!: HTMLElement;
let ovTitle!: HTMLElement;
let ovText!: HTMLElement;
let ovBtn!: HTMLButtonElement;
let undoBtn!: HTMLButtonElement;
let resetBtn!: HTMLButtonElement;

let cellEls: HTMLDivElement[][] = [];

function key(x: number, y: number): string {
  return `${x},${y}`;
}

function samePos(a: Pos, b: Pos): boolean {
  return a.x === b.x && a.y === b.y;
}

function isWall(x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= cols || y >= rows) return true;
  return walls.has(key(x, y));
}

function stepPos(p: Pos, dx: number, dy: number): Pos {
  const nx = p.x + dx;
  const ny = p.y + dy;
  if (isWall(nx, ny)) return p;
  return { x: nx, y: ny };
}

function buildBoard(): void {
  boardEl.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  boardEl.textContent = '';
  cellEls = [];
  for (let y = 0; y < rows; y++) {
    const rowEls: HTMLDivElement[] = [];
    for (let x = 0; x < cols; x++) {
      const cell = document.createElement('div');
      cell.className = 'ai-cell';
      if (isWall(x, y)) {
        cell.classList.add('ai-cell--wall');
      } else {
        if (samePos({ x, y }, blueGoal)) cell.classList.add('ai-cell--goal-blue');
        if (samePos({ x, y }, orangeGoal)) cell.classList.add('ai-cell--goal-orange');
      }
      boardEl.appendChild(cell);
      rowEls.push(cell);
    }
    cellEls.push(rowEls);
  }
}

function renderTwins(): void {
  for (const token of Array.from(boardEl.querySelectorAll('.ai-twin'))) {
    token.remove();
  }
  const blueCell = cellEls[blue.y]?.[blue.x];
  if (blueCell) {
    const t = document.createElement('span');
    t.className = 'ai-twin ai-twin--blue';
    if (samePos(blue, blueGoal)) t.classList.add('ai-twin--home');
    t.setAttribute('aria-label', 'Mavi ikiz');
    blueCell.appendChild(t);
  }
  const orangeCell = cellEls[orange.y]?.[orange.x];
  if (orangeCell) {
    const t = document.createElement('span');
    t.className = 'ai-twin ai-twin--orange';
    if (samePos(orange, orangeGoal)) t.classList.add('ai-twin--home');
    t.setAttribute('aria-label', 'Turuncu ikiz');
    orangeCell.appendChild(t);
  }
}

function renderHud(): void {
  levelEl.textContent = `${lvlIndex + 1} / ${LEVELS.length}`;
  movesEl.textContent = String(moves);
  const rec = bestMap[String(lvlIndex)];
  bestEl.textContent = rec === undefined ? '—' : String(rec);
}

function render(): void {
  renderHud();
  renderTwins();
}

function loadLevel(index: number): void {
  lvlIndex = index;
  const map = LEVELS[index]!;
  rows = map.length;
  cols = map[0]!.length;
  walls = new Set();
  for (let y = 0; y < rows; y++) {
    const line = map[y]!;
    for (let x = 0; x < cols; x++) {
      const c = line[x]!;
      if (c === '#') walls.add(key(x, y));
      else if (c === 'A') blue = { x, y };
      else if (c === 'a') blueGoal = { x, y };
      else if (c === 'B') orange = { x, y };
      else if (c === 'b') orangeGoal = { x, y };
    }
  }
  moves = 0;
  history = [];
  status = 'playing';
  hideOverlay(overlayEl);
  buildBoard();
  render();
}

function checkWin(): void {
  if (!samePos(blue, blueGoal) || !samePos(orange, orangeGoal)) return;
  const k = String(lvlIndex);
  const prev = bestMap[k];
  if (prev === undefined || moves < prev) {
    bestMap[k] = moves;
    safeWrite(BEST_KEY, bestMap);
  }
  if (lvlIndex === 0) reportGameOver(SCORE_DESC, moves, { label: 'Hamle' });
  renderHud();

  const isLast = lvlIndex >= LEVELS.length - 1;
  if (isLast) {
    status = 'complete';
    ovTitle.textContent = 'Hepsini bitirdin!';
    ovText.textContent = `Son seviyeyi ${moves} hamlede tamamladın. Baştan oynamak ister misin?`;
    ovBtn.textContent = 'Baştan başla';
  } else {
    status = 'won';
    ovTitle.textContent = 'Seviye tamam!';
    ovText.textContent = `${moves} hamlede çözdün. Sıradaki seviyeye geç.`;
    ovBtn.textContent = 'Sonraki seviye';
  }
  showOverlay(overlayEl);
  ovBtn.focus();
}

function move(dir: Dir): void {
  if (status !== 'playing') return;
  const d = DELTA[dir];
  const nextBlue = stepPos(blue, d.x, d.y);
  const nextOrange = stepPos(orange, -d.x, d.y); // mirror horizontal axis
  if (samePos(nextBlue, blue) && samePos(nextOrange, orange)) return;
  history.push({ blue, orange });
  blue = nextBlue;
  orange = nextOrange;
  moves++;
  render();
  checkWin();
}

function undo(): void {
  if (status !== 'playing') return;
  const last = history.pop();
  if (!last) return;
  blue = last.blue;
  orange = last.orange;
  moves = Math.max(0, moves - 1);
  render();
}

function reset(): void {
  loadLevel(lvlIndex);
}

function advance(): void {
  if (status === 'complete') {
    loadLevel(0);
  } else if (status === 'won') {
    loadLevel(lvlIndex + 1);
  }
}

function onKey(e: KeyboardEvent): void {
  const k = e.key;
  if (status !== 'playing') {
    if (k === 'Enter' || k === ' ') {
      e.preventDefault();
      advance();
    }
    return;
  }
  switch (k) {
    case 'ArrowUp':
    case 'w':
    case 'W':
      e.preventDefault();
      move('up');
      break;
    case 'ArrowDown':
    case 's':
    case 'S':
      e.preventDefault();
      move('down');
      break;
    case 'ArrowLeft':
    case 'a':
    case 'A':
      e.preventDefault();
      move('left');
      break;
    case 'ArrowRight':
    case 'd':
    case 'D':
      e.preventDefault();
      move('right');
      break;
    case 'z':
    case 'Z':
      e.preventDefault();
      undo();
      break;
    case 'r':
    case 'R':
      e.preventDefault();
      reset();
      break;
    default:
      return;
  }
}

function init(): void {
  boardEl = document.querySelector<HTMLElement>('#board')!;
  levelEl = document.querySelector<HTMLElement>('#level')!;
  movesEl = document.querySelector<HTMLElement>('#moves')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  overlayEl = document.querySelector<HTMLElement>('#overlay')!;
  ovTitle = document.querySelector<HTMLElement>('#ov-title')!;
  ovText = document.querySelector<HTMLElement>('#ov-text')!;
  ovBtn = document.querySelector<HTMLButtonElement>('#ov-btn')!;
  undoBtn = document.querySelector<HTMLButtonElement>('#undo')!;
  resetBtn = document.querySelector<HTMLButtonElement>('#reset')!;

  bestMap = safeRead<Record<string, number>>(BEST_KEY, {});

  for (const btn of Array.from(document.querySelectorAll<HTMLButtonElement>('.ai-key'))) {
    btn.addEventListener('click', () => {
      const dir = btn.dataset.dir as Dir | undefined;
      if (dir) move(dir);
    });
  }
  undoBtn.addEventListener('click', undo);
  resetBtn.addEventListener('click', reset);
  ovBtn.addEventListener('click', advance);
  window.addEventListener('keydown', onKey);

  loadLevel(0);
}

export const game = defineGame({ init, reset });
