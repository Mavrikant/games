import { defineGame } from '@shared/game-module';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { reportGameOver } from '@shared/leaderboard';

// Halka Eşle — match-3'ün toroidal twist'i.
// Klasik Candy Crush'tan farkı: swap yok; her satır ve sütun kapalı bir halka,
// kenardaki oklarla bir step kaydırılır, uçtan çıkan diğer uca wrap olur.
// 100 level prosedürel zorlanma: grid boyu, renk sayısı, hamle limiti, kilitli
// tile sayısı tier'lara göre artar.
//
// PITFALLS guarded:
// - unguarded-storage: safeRead/safeWrite ile tüm storage erişimi.
// - stale-async-callback: gen.bump() reset/level-change'de in-flight cascade
//   timer'larını iptal eder.
// - overlay-input-leak: explicit `state` enum, her handler en başta state
//   guard'ı yapar.
// - module-level DOM access: tüm querySelector + addEventListener init() içinde.
// - missing-overlay-css: .overlay--hidden styles per-game CSS'te tanımlı.
// - unreachable-start-state: Overlay'in "Başla" butonu explicit state-change
//   tetikler; ek olarak Enter/Space keyboard fallback'i var.

const STORAGE_PROGRESS = 'halka-esle.progress';
const STORAGE_CURRENT = 'halka-esle.current';
// Leaderboard: highest level reached (flat mirror; progress stays in its own keys).
const SCORE_DESC = { gameId: 'halka-esle', storageKey: 'halka-esle.lb', direction: 'higher' as const };
const TOTAL_LEVELS = 100;
const COLOR_NAMES = ['kırmızı', 'yeşil', 'mavi', 'sarı', 'mor', 'pembe'];
const COLOR_EMOJI = ['🔴', '🟢', '🔵', '🟡', '🟣', '🩷'];

type ObjectiveType = 'total' | 'color' | 'locked';

interface Objective {
  type: ObjectiveType;
  target: number;
  color?: number;
}

interface LevelDef {
  rows: number;
  cols: number;
  colors: number;
  moves: number;
  objective: Objective;
  lockedCount: number;
}

interface CellState {
  color: number;
  locked: number;
}

type State = 'ready' | 'playing' | 'animating' | 'win' | 'lose' | 'levelselect';

const gen = createGenToken();
let state: State = 'ready';
let stateBeforeLevelSelect: State = 'ready';

let currentLevel = 1;
let maxUnlocked = 1;
let levelDef: LevelDef = generateLevel(1);
let grid: CellState[][] = [];
let tileEls: HTMLElement[][] = [];
let movesLeft = 0;
let progress = 0;
let chainCount = 0;

let board!: HTMLElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayAction!: HTMLButtonElement;
let restartBtn!: HTMLButtonElement;
let levelSelectBtn!: HTMLButtonElement;
let levelDisplay!: HTMLElement;
let levelTotal!: HTMLElement;
let movesLeftEl!: HTMLElement;
let objectiveEl!: HTMLElement;
let levelSelect!: HTMLElement;
let levelGrid!: HTMLElement;
let levelClose!: HTMLButtonElement;
let levelProgressHint!: HTMLElement;

let overlayActionCb: (() => void) | null = null;

function generateLevel(n: number): LevelDef {
  const lv = Math.max(1, Math.min(TOTAL_LEVELS, n));
  if (lv <= 10) {
    return {
      rows: 6,
      cols: 6,
      colors: 4,
      moves: 14 + Math.floor(lv / 3),
      objective: { type: 'total', target: 12 + lv * 2 },
      lockedCount: 0,
    };
  }
  if (lv <= 25) {
    const idx = lv - 10;
    return {
      rows: 6,
      cols: 6,
      colors: 5,
      moves: 16,
      objective: {
        type: 'color',
        target: 6 + Math.floor(idx / 2),
        color: (idx - 1) % 5,
      },
      lockedCount: 0,
    };
  }
  if (lv <= 50) {
    const idx = lv - 25;
    return {
      rows: 7,
      cols: 6,
      colors: 5,
      moves: Math.max(14, 18 - Math.floor(idx / 6)),
      objective: {
        type: 'color',
        target: 10 + Math.floor(idx / 3),
        color: (idx - 1) % 5,
      },
      lockedCount: 0,
    };
  }
  if (lv <= 75) {
    const idx = lv - 50;
    const locks = 4 + Math.floor(idx / 4);
    return {
      rows: 7,
      cols: 7,
      colors: 5,
      moves: Math.max(14, 20 - Math.floor(idx / 5)),
      objective: { type: 'locked', target: locks },
      lockedCount: locks,
    };
  }
  const idx = lv - 75;
  const locks = 8 + Math.floor(idx / 3);
  return {
    rows: 8,
    cols: 7,
    colors: 6,
    moves: Math.max(14, 22 - Math.floor(idx / 4)),
    objective: { type: 'locked', target: locks },
    lockedCount: locks,
  };
}

function describeObjective(o: Objective): string {
  switch (o.type) {
    case 'total':
      return `${o.target} tile patlat`;
    case 'color':
      return `${o.target}× ${COLOR_EMOJI[o.color ?? 0] ?? '·'} ${COLOR_NAMES[o.color ?? 0] ?? ''}`;
    case 'locked':
      return `${o.target} kilitli temizle 🔒`;
  }
}

function makeInitialGrid(): void {
  grid = [];
  for (let r = 0; r < levelDef.rows; r++) {
    grid[r] = [];
    for (let c = 0; c < levelDef.cols; c++) {
      let color = 0;
      let attempts = 0;
      do {
        color = Math.floor(Math.random() * levelDef.colors);
        attempts++;
        if (attempts > 50) break;
      } while (
        (c >= 2 &&
          grid[r]![c - 1]!.color === color &&
          grid[r]![c - 2]!.color === color) ||
        (r >= 2 &&
          grid[r - 1]![c]!.color === color &&
          grid[r - 2]![c]!.color === color)
      );
      grid[r]![c] = { color, locked: 0 };
    }
  }

  if (levelDef.lockedCount > 0) {
    const positions: Array<{ r: number; c: number }> = [];
    for (let r = 0; r < levelDef.rows; r++) {
      for (let c = 0; c < levelDef.cols; c++) {
        positions.push({ r, c });
      }
    }
    for (let i = positions.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = positions[i]!;
      positions[i] = positions[j]!;
      positions[j] = tmp;
    }
    const want = Math.min(levelDef.lockedCount, positions.length);
    for (let k = 0; k < want; k++) {
      const { r, c } = positions[k]!;
      grid[r]![c]!.locked = 1;
    }
  }
}

function shiftRow(r: number, dir: -1 | 1): void {
  const row = grid[r]!;
  if (dir === 1) {
    const last = row[row.length - 1]!;
    for (let c = row.length - 1; c > 0; c--) {
      row[c] = row[c - 1]!;
    }
    row[0] = last;
  } else {
    const first = row[0]!;
    for (let c = 0; c < row.length - 1; c++) {
      row[c] = row[c + 1]!;
    }
    row[row.length - 1] = first;
  }
}

function shiftCol(c: number, dir: -1 | 1): void {
  if (dir === 1) {
    const last = grid[grid.length - 1]![c]!;
    for (let r = grid.length - 1; r > 0; r--) {
      grid[r]![c] = grid[r - 1]![c]!;
    }
    grid[0]![c] = last;
  } else {
    const first = grid[0]![c]!;
    for (let r = 0; r < grid.length - 1; r++) {
      grid[r]![c] = grid[r + 1]![c]!;
    }
    grid[grid.length - 1]![c] = first;
  }
}

function findMatches(): Set<string> {
  const matches = new Set<string>();
  const rows = grid.length;
  const cols = grid[0]!.length;

  for (let r = 0; r < rows; r++) {
    let run = 1;
    for (let c = 1; c <= cols; c++) {
      const same =
        c < cols &&
        grid[r]![c]!.color === grid[r]![c - 1]!.color &&
        grid[r]![c]!.color >= 0;
      if (same) {
        run++;
      } else {
        if (run >= 3) {
          for (let k = 0; k < run; k++) {
            matches.add(`${r},${c - 1 - k}`);
          }
        }
        run = 1;
      }
    }
  }

  for (let c = 0; c < cols; c++) {
    let run = 1;
    for (let r = 1; r <= rows; r++) {
      const same =
        r < rows &&
        grid[r]![c]!.color === grid[r - 1]![c]!.color &&
        grid[r]![c]!.color >= 0;
      if (same) {
        run++;
      } else {
        if (run >= 3) {
          for (let k = 0; k < run; k++) {
            matches.add(`${r - 1 - k},${c}`);
          }
        }
        run = 1;
      }
    }
  }

  return matches;
}

interface PopResult {
  totalPopped: number;
  lockedHits: number;
  byColor: Map<number, number>;
}

function popMatches(matches: Set<string>): PopResult {
  let totalPopped = 0;
  let lockedHits = 0;
  const byColor = new Map<number, number>();

  for (const key of matches) {
    const parts = key.split(',');
    const r = Number(parts[0]);
    const c = Number(parts[1]);
    const cell = grid[r]![c]!;
    const col = cell.color;

    if (cell.locked > 0) {
      cell.locked--;
      lockedHits++;
      if (cell.locked === 0) {
        cell.color = -1;
        totalPopped++;
        byColor.set(col, (byColor.get(col) ?? 0) + 1);
      }
    } else {
      cell.color = -1;
      totalPopped++;
      byColor.set(col, (byColor.get(col) ?? 0) + 1);
    }
  }

  return { totalPopped, lockedHits, byColor };
}

function refillEmpty(): void {
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < grid[r]!.length; c++) {
      if (grid[r]![c]!.color === -1) {
        grid[r]![c]!.color = Math.floor(Math.random() * levelDef.colors);
      }
    }
  }
}

function buildBoardDOM(): void {
  board.innerHTML = '';
  board.style.setProperty('--cols', String(levelDef.cols));
  board.style.setProperty('--rows', String(levelDef.rows));
  tileEls = [];

  for (let c = 0; c < levelDef.cols; c++) {
    const btn = makeArrowButton('col', c, 1, '↓', `Sütun ${c + 1} aşağı kaydır`);
    btn.style.gridColumn = String(c + 2);
    btn.style.gridRow = '1';
    btn.classList.add('he-arrow--down');
    board.appendChild(btn);
  }
  for (let c = 0; c < levelDef.cols; c++) {
    const btn = makeArrowButton('col', c, -1, '↑', `Sütun ${c + 1} yukarı kaydır`);
    btn.style.gridColumn = String(c + 2);
    btn.style.gridRow = String(levelDef.rows + 2);
    btn.classList.add('he-arrow--up');
    board.appendChild(btn);
  }
  for (let r = 0; r < levelDef.rows; r++) {
    const btn = makeArrowButton('row', r, 1, '→', `Satır ${r + 1} sağa kaydır`);
    btn.style.gridRow = String(r + 2);
    btn.style.gridColumn = '1';
    btn.classList.add('he-arrow--right');
    board.appendChild(btn);
  }
  for (let r = 0; r < levelDef.rows; r++) {
    const btn = makeArrowButton('row', r, -1, '←', `Satır ${r + 1} sola kaydır`);
    btn.style.gridRow = String(r + 2);
    btn.style.gridColumn = String(levelDef.cols + 2);
    btn.classList.add('he-arrow--left');
    board.appendChild(btn);
  }

  for (let r = 0; r < levelDef.rows; r++) {
    tileEls[r] = [];
    for (let c = 0; c < levelDef.cols; c++) {
      const cell = document.createElement('div');
      cell.className = 'he-cell';
      cell.style.gridColumn = String(c + 2);
      cell.style.gridRow = String(r + 2);
      cell.setAttribute('role', 'gridcell');

      const tile = document.createElement('span');
      tile.className = 'he-tile';
      cell.appendChild(tile);
      board.appendChild(cell);
      tileEls[r]![c] = tile;
    }
  }
}

function makeArrowButton(
  axis: 'row' | 'col',
  index: number,
  dir: -1 | 1,
  label: string,
  aria: string,
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'he-arrow';
  btn.dataset.axis = axis;
  btn.dataset.index = String(index);
  btn.dataset.dir = String(dir);
  btn.textContent = label;
  btn.setAttribute('aria-label', aria);
  return btn;
}

function paintTiles(): void {
  for (let r = 0; r < levelDef.rows; r++) {
    for (let c = 0; c < levelDef.cols; c++) {
      const tile = tileEls[r]![c]!;
      const cs = grid[r]![c]!;
      tile.className = 'he-tile';
      if (cs.color >= 0) {
        tile.classList.add(`he-tile--c${cs.color}`);
      } else {
        tile.classList.add('he-tile--empty');
      }
      if (cs.locked > 0) {
        tile.classList.add('he-tile--locked');
      }
    }
  }
}

function updateHud(): void {
  levelDisplay.textContent = String(currentLevel);
  movesLeftEl.textContent = String(movesLeft);
  const o = levelDef.objective;
  objectiveEl.textContent = `${progress}/${o.target} ${objectiveShort(o)}`;
}

function objectiveShort(o: Objective): string {
  switch (o.type) {
    case 'total':
      return '🧩';
    case 'color':
      return COLOR_EMOJI[o.color ?? 0] ?? '·';
    case 'locked':
      return '🔒';
  }
}

function loadLevel(n: number): void {
  gen.bump();
  currentLevel = Math.max(1, Math.min(TOTAL_LEVELS, n));
  levelDef = generateLevel(currentLevel);
  movesLeft = levelDef.moves;
  progress = 0;
  chainCount = 0;
  makeInitialGrid();
  buildBoardDOM();
  paintTiles();
  updateHud();
  safeWrite(STORAGE_CURRENT, currentLevel);
  hideOverlayEl(overlay);
  closeLevelSelect();
  state = 'playing';
}

function showGameOverlay(
  title: string,
  msg: string,
  actionLabel: string,
  onAction: () => void,
): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  overlayAction.textContent = actionLabel;
  overlayActionCb = onAction;
  showOverlayEl(overlay);
}

function applyObjective(pop: PopResult): void {
  const o = levelDef.objective;
  switch (o.type) {
    case 'total':
      progress += pop.totalPopped;
      break;
    case 'color': {
      const c = o.color ?? 0;
      progress += pop.byColor.get(c) ?? 0;
      break;
    }
    case 'locked':
      progress += pop.lockedHits;
      break;
  }
  if (progress > levelDef.objective.target) {
    progress = levelDef.objective.target;
  }
}

function objectiveMet(): boolean {
  return progress >= levelDef.objective.target;
}

function handleShift(axis: 'row' | 'col', index: number, dir: -1 | 1): void {
  if (state !== 'playing') return;
  if (movesLeft <= 0) return;

  if (axis === 'row') shiftRow(index, dir);
  else shiftCol(index, dir);

  movesLeft--;
  chainCount = 0;
  updateHud();
  paintTiles();

  // Visual feedback: brief shift highlight on affected row/col
  flashShiftedLine(axis, index);

  state = 'animating';
  startCascadeChain();
}

function flashShiftedLine(axis: 'row' | 'col', index: number): void {
  const myGen = gen.current();
  const cells: HTMLElement[] = [];
  if (axis === 'row') {
    for (let c = 0; c < levelDef.cols; c++) cells.push(tileEls[index]![c]!);
  } else {
    for (let r = 0; r < levelDef.rows; r++) cells.push(tileEls[r]![index]!);
  }
  for (const t of cells) t.classList.add('he-tile--shifted');
  setTimeout(() => {
    if (!gen.isCurrent(myGen)) return;
    for (const t of cells) t.classList.remove('he-tile--shifted');
  }, 180);
}

function startCascadeChain(): void {
  const myGen = gen.current();
  setTimeout(() => {
    if (!gen.isCurrent(myGen)) return;
    processCascadeStep();
  }, 140);
}

function processCascadeStep(): void {
  const myGen = gen.current();
  const matches = findMatches();
  if (matches.size === 0) {
    chainEnded();
    return;
  }

  chainCount++;

  for (const key of matches) {
    const parts = key.split(',');
    const r = Number(parts[0]);
    const c = Number(parts[1]);
    const tile = tileEls[r]![c]!;
    tile.classList.add('he-tile--popping');
    if (chainCount > 1) tile.classList.add('he-tile--chain');
  }

  setTimeout(() => {
    if (!gen.isCurrent(myGen)) return;
    const pop = popMatches(matches);
    applyObjective(pop);
    updateHud();
    refillEmpty();
    paintTiles();
    setTimeout(() => {
      if (!gen.isCurrent(myGen)) return;
      processCascadeStep();
    }, 140);
  }, 240);
}

function chainEnded(): void {
  paintTiles();

  if (objectiveMet()) {
    state = 'win';
    if (currentLevel >= maxUnlocked) {
      maxUnlocked = Math.min(TOTAL_LEVELS, currentLevel + 1);
      safeWrite(STORAGE_PROGRESS, maxUnlocked - 1);
    }
    reportGameOver(SCORE_DESC, currentLevel, { label: 'Seviye' });
    const isLast = currentLevel >= TOTAL_LEVELS;
    const nextLevel = currentLevel + 1;
    showGameOverlay(
      isLast ? 'Tüm 100 level bitti! 🏆' : `Level ${currentLevel} tamam! 🎉`,
      isLast
        ? 'Tebrikler — 100 leveli de geçtin. Tekrar başlamak için tıkla.'
        : `${movesLeft} hamle artarken hedef tamam. Sonraki level: ${nextLevel}.`,
      isLast ? 'Baştan başla' : 'Sonraki level →',
      () => loadLevel(isLast ? 1 : nextLevel),
    );
    return;
  }

  if (movesLeft <= 0) {
    state = 'lose';
    showGameOverlay(
      'Hamleler bitti',
      `Hedef: ${describeObjective(levelDef.objective)}. ${progress}/${levelDef.objective.target} ile kaldın.`,
      'Tekrar dene',
      () => loadLevel(currentLevel),
    );
    return;
  }

  state = 'playing';
}

function buildLevelGrid(): void {
  levelGrid.innerHTML = '';
  for (let i = 1; i <= TOTAL_LEVELS; i++) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'he-level-btn';
    btn.textContent = String(i);
    btn.setAttribute('role', 'listitem');
    const unlocked = i <= maxUnlocked;
    if (!unlocked) {
      btn.classList.add('he-level-btn--locked');
      btn.disabled = true;
      btn.setAttribute('aria-label', `Level ${i} kilitli`);
    } else {
      btn.setAttribute('aria-label', `Level ${i}'a git`);
    }
    if (i === currentLevel) btn.classList.add('he-level-btn--current');
    if (i < maxUnlocked) btn.classList.add('he-level-btn--done');
    btn.addEventListener('click', () => {
      if (!unlocked) return;
      loadLevel(i);
    });
    levelGrid.appendChild(btn);
  }
  const cleared = Math.max(0, maxUnlocked - 1);
  levelProgressHint.textContent = `İlerleme: ${cleared} / ${TOTAL_LEVELS}`;
}

function openLevelSelect(): void {
  if (state === 'levelselect') return;
  stateBeforeLevelSelect = state;
  state = 'levelselect';
  buildLevelGrid();
  showOverlayEl(levelSelect);
}

function closeLevelSelect(): void {
  hideOverlayEl(levelSelect);
  if (state === 'levelselect') {
    state = stateBeforeLevelSelect === 'levelselect' ? 'playing' : stateBeforeLevelSelect;
  }
}

function onOverlayAction(): void {
  if (overlayActionCb) {
    const cb = overlayActionCb;
    overlayActionCb = null;
    cb();
  } else {
    hideOverlayEl(overlay);
    state = 'playing';
  }
}

function onBoardClick(e: MouseEvent): void {
  const target = e.target as HTMLElement;
  const btn = target.closest<HTMLButtonElement>('.he-arrow');
  if (!btn) return;
  if (state !== 'playing') return;
  const axis = btn.dataset.axis as 'row' | 'col' | undefined;
  const index = Number(btn.dataset.index);
  const dir = Number(btn.dataset.dir);
  if (!axis || !Number.isInteger(index) || (dir !== 1 && dir !== -1)) return;
  handleShift(axis, index, dir as -1 | 1);
}

function onKey(e: KeyboardEvent): void {
  const t = e.target;
  if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
  if (e.key === 'r' || e.key === 'R') {
    e.preventDefault();
    if (state === 'levelselect') return;
    loadLevel(currentLevel);
  } else if (e.key === 'l' || e.key === 'L') {
    e.preventDefault();
    if (state === 'levelselect') closeLevelSelect();
    else openLevelSelect();
  } else if (e.key === 'Escape') {
    if (state === 'levelselect') {
      e.preventDefault();
      closeLevelSelect();
    }
  } else if ((e.key === 'Enter' || e.key === ' ') && state !== 'playing' && state !== 'animating') {
    if (state === 'levelselect') return;
    if (!overlay.classList.contains('overlay--hidden')) {
      e.preventDefault();
      onOverlayAction();
    }
  }
}

function init(): void {
  board = document.querySelector<HTMLElement>('#board')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayAction = document.querySelector<HTMLButtonElement>('#overlay-action')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  levelSelectBtn = document.querySelector<HTMLButtonElement>('#level-select-btn')!;
  levelDisplay = document.querySelector<HTMLElement>('#level-display')!;
  levelTotal = document.querySelector<HTMLElement>('#level-total')!;
  movesLeftEl = document.querySelector<HTMLElement>('#moves-left')!;
  objectiveEl = document.querySelector<HTMLElement>('#objective')!;
  levelSelect = document.querySelector<HTMLElement>('#level-select')!;
  levelGrid = document.querySelector<HTMLElement>('#level-grid')!;
  levelClose = document.querySelector<HTMLButtonElement>('#level-close')!;
  levelProgressHint = document.querySelector<HTMLElement>('#level-progress-hint')!;

  levelTotal.textContent = String(TOTAL_LEVELS);

  const savedProgress = safeRead<number>(STORAGE_PROGRESS, 0);
  maxUnlocked = Math.max(1, Math.min(TOTAL_LEVELS, savedProgress + 1));
  const savedCurrent = safeRead<number>(STORAGE_CURRENT, 1);
  currentLevel = Math.max(1, Math.min(maxUnlocked, savedCurrent));

  // Build initial board behind the welcome overlay so first action gives
  // instant visual feedback (pitfall: invisible-boot).
  levelDef = generateLevel(currentLevel);
  movesLeft = levelDef.moves;
  progress = 0;
  makeInitialGrid();
  buildBoardDOM();
  paintTiles();
  updateHud();

  board.addEventListener('click', onBoardClick);
  restartBtn.addEventListener('click', () => {
    if (state === 'levelselect') closeLevelSelect();
    loadLevel(currentLevel);
  });
  levelSelectBtn.addEventListener('click', () => {
    if (state === 'levelselect') closeLevelSelect();
    else openLevelSelect();
  });
  levelClose.addEventListener('click', closeLevelSelect);
  overlayAction.addEventListener('click', onOverlayAction);
  // Click backdrop (outside .overlay__inner) does NOT auto-dismiss to avoid
  // accidental skip; the explicit button is the only action path.

  window.addEventListener('keydown', onKey);

  // Welcome overlay — first-action explicit Başla button + Enter/Space fallback
  // (pitfall: unreachable-start-state).
  state = 'ready';
  showGameOverlay(
    'Halka Eşle',
    `Level ${currentLevel} · ${describeObjective(levelDef.objective)} · ${levelDef.moves} hamle.\nKenardaki oklarla satır/sütunu kaydır. Tüm grid bir halka — uçtan uca wrap olur.`,
    'Başla',
    () => {
      hideOverlayEl(overlay);
      state = 'playing';
    },
  );
}

function reset(): void {
  // External reset (rarely triggered; restart button handles in-game).
  loadLevel(currentLevel);
}

export const game = defineGame({ init, reset });
