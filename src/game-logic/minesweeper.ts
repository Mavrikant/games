import { defineGame } from '@shared/game-module';

type Difficulty = 'easy' | 'medium' | 'hard';

interface DiffConfig {
  rows: number;
  cols: number;
  mines: number;
}

const CONFIGS: Record<Difficulty, DiffConfig> = {
  easy: { rows: 9, cols: 9, mines: 10 },
  medium: { rows: 16, cols: 16, mines: 40 },
  hard: { rows: 16, cols: 30, mines: 99 },
};

const DIFFICULTY_KEY = 'minesweeper.difficulty';
const bestKey = (d: Difficulty): string => `minesweeper.best.${d}`;

let boardEl!: HTMLDivElement;
let statusEl!: HTMLElement;
let minesLeftEl!: HTMLElement;
let timerEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let restartFace!: HTMLElement;
let difficultySel!: HTMLSelectElement;

interface Cell {
  mine: boolean;
  open: boolean;
  flag: boolean;
  adj: number;
  el: HTMLButtonElement;
}

let difficulty: Difficulty = 'medium';
let config: DiffConfig = CONFIGS[difficulty];
let cells: Cell[] = [];
let firstClick = true;
let gameOver = false;
let flagsPlaced = 0;
let openedCount = 0;
let timer = 0;
let timerInterval: number | null = null;

function loadDifficulty(): Difficulty {
  try {
    const raw = localStorage.getItem(DIFFICULTY_KEY);
    if (raw === 'easy' || raw === 'medium' || raw === 'hard') return raw;
  } catch {
    /* ignore */
  }
  return 'medium';
}

function saveDifficulty(): void {
  try {
    localStorage.setItem(DIFFICULTY_KEY, difficulty);
  } catch {
    /* ignore */
  }
}

function loadBest(d: Difficulty): number | null {
  try {
    const raw = localStorage.getItem(bestKey(d));
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

function saveBest(d: Difficulty, t: number): void {
  try {
    localStorage.setItem(bestKey(d), String(t));
  } catch {
    /* ignore */
  }
}

function renderBest(): void {
  const b = loadBest(difficulty);
  bestEl.textContent = b === null ? '—' : `${b}s`;
}

function idx(r: number, c: number): number {
  return r * config.cols + c;
}

function inBounds(r: number, c: number): boolean {
  return r >= 0 && r < config.rows && c >= 0 && c < config.cols;
}

function neighbors(r: number, c: number): number[] {
  const out: number[] = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = r + dr;
      const nc = c + dc;
      if (inBounds(nr, nc)) out.push(idx(nr, nc));
    }
  }
  return out;
}

function buildBoard(): void {
  boardEl.innerHTML = '';
  // CSS reads --ms-cols to compute cell size with clamp(); see styles/games/minesweeper.css.
  boardEl.style.setProperty('--ms-cols', String(config.cols));
  cells = [];
  for (let r = 0; r < config.rows; r++) {
    for (let c = 0; c < config.cols; c++) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ms-cell';
      btn.setAttribute('role', 'gridcell');
      btn.setAttribute('aria-label', `Hücre ${r + 1}, ${c + 1}`);
      btn.dataset.r = String(r);
      btn.dataset.c = String(c);
      boardEl.appendChild(btn);
      cells.push({ mine: false, open: false, flag: false, adj: 0, el: btn });
    }
  }
}

function placeMines(safeIndex: number): void {
  const total = config.rows * config.cols;
  const forbidden = new Set<number>([safeIndex]);
  const sr = Math.floor(safeIndex / config.cols);
  const sc = safeIndex % config.cols;
  for (const n of neighbors(sr, sc)) forbidden.add(n);

  let placed = 0;
  const maxMines = Math.min(config.mines, total - forbidden.size);
  while (placed < maxMines) {
    const i = Math.floor(Math.random() * total);
    if (forbidden.has(i)) continue;
    const cell = cells[i]!;
    if (cell.mine) continue;
    cell.mine = true;
    placed++;
  }

  for (let r = 0; r < config.rows; r++) {
    for (let c = 0; c < config.cols; c++) {
      const cell = cells[idx(r, c)]!;
      if (cell.mine) {
        cell.adj = 0;
        continue;
      }
      let count = 0;
      for (const n of neighbors(r, c)) {
        if (cells[n]!.mine) count++;
      }
      cell.adj = count;
    }
  }
}

function renderCell(i: number): void {
  const cell = cells[i]!;
  const el = cell.el;
  el.className = 'ms-cell';
  el.textContent = '';
  if (cell.open) {
    el.classList.add('ms-cell--open');
    if (cell.mine) {
      el.classList.add('ms-cell--mine');
    } else if (cell.adj > 0) {
      el.classList.add(`ms-cell--n${cell.adj}`);
      el.textContent = String(cell.adj);
    }
  } else if (cell.flag) {
    el.classList.add('ms-cell--flag');
  }
}

function renderAll(): void {
  for (let i = 0; i < cells.length; i++) renderCell(i);
  minesLeftEl.textContent = String(config.mines - flagsPlaced);
}

function startTimer(): void {
  stopTimer();
  timer = 0;
  timerEl.textContent = '0';
  timerInterval = window.setInterval(() => {
    timer++;
    timerEl.textContent = String(timer);
  }, 1000);
}

function stopTimer(): void {
  if (timerInterval !== null) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

function floodOpen(start: number): void {
  const stack: number[] = [start];
  while (stack.length > 0) {
    const i = stack.pop()!;
    const cell = cells[i]!;
    if (cell.open || cell.flag || cell.mine) continue;
    cell.open = true;
    openedCount++;
    if (cell.adj === 0) {
      const r = Math.floor(i / config.cols);
      const c = i % config.cols;
      for (const n of neighbors(r, c)) {
        const nc = cells[n]!;
        if (!nc.open && !nc.flag && !nc.mine) stack.push(n);
      }
    }
  }
}

function revealMinesAfterLoss(hitIndex: number): void {
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i]!;
    if (c.mine && !c.flag) {
      c.open = true;
    }
  }
  renderAll();
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i]!;
    if (c.flag && !c.mine) {
      c.el.classList.add('ms-cell--wrong-flag');
    }
  }
  const hit = cells[hitIndex];
  if (hit) hit.el.classList.add('ms-cell--mine-hit');
}

function checkWin(): boolean {
  const safeTotal = config.rows * config.cols - config.mines;
  return openedCount >= safeTotal;
}

function setFace(face: string): void {
  restartFace.textContent = face;
}

function setStatus(msg: string, kind?: 'win' | 'lose'): void {
  statusEl.textContent = msg;
  statusEl.classList.remove('ms-status--win', 'ms-status--lose');
  if (kind === 'win') statusEl.classList.add('ms-status--win');
  if (kind === 'lose') statusEl.classList.add('ms-status--lose');
}

function endGame(victory: boolean, hitIndex?: number): void {
  gameOver = true;
  stopTimer();
  if (victory) {
    for (const c of cells) {
      if (c.mine && !c.flag) {
        c.flag = true;
        flagsPlaced++;
      }
    }
    renderAll();
    setFace('😎');
    const prev = loadBest(difficulty);
    if (prev === null || timer < prev) {
      saveBest(difficulty, timer);
      renderBest();
      setStatus(`Kazandın! Yeni rekor: ${timer}s 🏆`, 'win');
    } else {
      setStatus(`Kazandın! Süre: ${timer}s`, 'win');
    }
  } else {
    if (hitIndex !== undefined) revealMinesAfterLoss(hitIndex);
    setFace('😵');
    setStatus('Mayına bastın! Yeni oyun için tekrar başlat.', 'lose');
  }
}

function openCell(i: number): void {
  if (gameOver) return;
  const cell = cells[i]!;
  if (cell.flag || cell.open) return;

  if (firstClick) {
    placeMines(i);
    firstClick = false;
    startTimer();
  }

  if (cell.mine) {
    endGame(false, i);
    return;
  }

  floodOpen(i);
  renderAll();
  if (checkWin()) endGame(true);
}

function toggleFlag(i: number): void {
  if (gameOver) return;
  const cell = cells[i]!;
  if (cell.open) return;
  cell.flag = !cell.flag;
  flagsPlaced += cell.flag ? 1 : -1;
  renderCell(i);
  minesLeftEl.textContent = String(config.mines - flagsPlaced);
}

function chord(i: number): void {
  if (gameOver) return;
  const cell = cells[i]!;
  if (!cell.open || cell.adj === 0) return;
  const r = Math.floor(i / config.cols);
  const c = i % config.cols;
  const nbs = neighbors(r, c);
  let flags = 0;
  for (const n of nbs) if (cells[n]!.flag) flags++;
  if (flags !== cell.adj) return;
  let hitMine = -1;
  for (const n of nbs) {
    const nc = cells[n]!;
    if (!nc.open && !nc.flag) {
      if (nc.mine) {
        hitMine = n;
        break;
      }
      floodOpen(n);
    }
  }
  if (hitMine !== -1) {
    endGame(false, hitMine);
    return;
  }
  renderAll();
  if (checkWin()) endGame(true);
}

function cellIndexFromEvent(e: Event): number | null {
  const target = e.target as HTMLElement | null;
  if (!target || !target.classList.contains('ms-cell')) return null;
  const r = Number(target.dataset.r);
  const c = Number(target.dataset.c);
  if (!Number.isFinite(r) || !Number.isFinite(c)) return null;
  return idx(r, c);
}

function attachBoardListeners(): void {
  // Tracks whether the next synthetic click should be ignored (e.g., after a long-press
  // flag, or after a touch-driven double-tap that we already handled as chord).
  let suppressNextClick = false;

  boardEl.addEventListener('click', (e) => {
    if (suppressNextClick) {
      suppressNextClick = false;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const i = cellIndexFromEvent(e);
    if (i === null) return;
    openCell(i);
  });
  boardEl.addEventListener('contextmenu', (e) => {
    // Always block the context menu on the board — long-press on touch devices
    // dispatches contextmenu and we don't want a system menu popping over the game.
    e.preventDefault();
    const i = cellIndexFromEvent(e);
    if (i === null) return;
    toggleFlag(i);
  });
  boardEl.addEventListener('dblclick', (e) => {
    const i = cellIndexFromEvent(e);
    if (i === null) return;
    e.preventDefault();
    chord(i);
  });
  boardEl.addEventListener('mousedown', (e) => {
    const me = e as MouseEvent;
    if (me.button !== 0 || gameOver) return;
    if (cellIndexFromEvent(e) === null) return;
    setFace('😮');
  });
  boardEl.addEventListener('mouseup', () => {
    if (!gameOver) setFace('🙂');
  });
  boardEl.addEventListener('mouseleave', () => {
    if (!gameOver) setFace('🙂');
  });

  // Touch: long-press to flag, double-tap on an opened number to chord.
  // Single-finger only; multi-touch is treated as a scroll/zoom gesture and ignored.
  let touchTimer: number | null = null;
  let touchTarget: HTMLElement | null = null;
  let touchStartX = 0;
  let touchStartY = 0;
  let touchLongPress = false;
  let lastTapTime = 0;
  let lastTapIndex = -1;
  const TOUCH_FLAG_MS = 400;
  const TAP_MOVE_TOLERANCE = 10; // px — finger jitter allowance for long-press
  const DOUBLE_TAP_MS = 280;

  const clearTouchTimer = (): void => {
    if (touchTimer !== null) {
      clearTimeout(touchTimer);
      touchTimer = null;
    }
  };
  const resetTouch = (): void => {
    clearTouchTimer();
    touchTarget = null;
  };

  boardEl.addEventListener(
    'touchstart',
    (e) => {
      // Ignore multi-touch (pinch-zoom on the wrapper, etc.).
      if (e.touches.length !== 1) {
        resetTouch();
        return;
      }
      const raw = e.target as HTMLElement | null;
      const target = raw?.closest<HTMLElement>('.ms-cell') ?? null;
      if (!target) return;
      const touch = e.touches[0]!;
      touchTarget = target;
      touchStartX = touch.clientX;
      touchStartY = touch.clientY;
      touchLongPress = false;
      clearTouchTimer();
      touchTimer = window.setTimeout(() => {
        touchTimer = null;
        if (!touchTarget) return;
        const r = Number(touchTarget.dataset.r);
        const c = Number(touchTarget.dataset.c);
        if (!Number.isFinite(r) || !Number.isFinite(c)) return;
        const i = idx(r, c);
        touchLongPress = true;
        suppressNextClick = true;
        const cell = cells[i];
        // Long-press on an opened number cell triggers chord; on an unopened cell,
        // toggle the flag. This gives mobile users an explicit chord alternative
        // to double-tap.
        if (cell && cell.open && cell.adj > 0) {
          chord(i);
        } else {
          toggleFlag(i);
        }
      }, TOUCH_FLAG_MS);
    },
    { passive: true },
  );

  boardEl.addEventListener(
    'touchmove',
    (e) => {
      if (!touchTarget || touchTimer === null) return;
      const touch = e.touches[0];
      if (!touch) {
        resetTouch();
        return;
      }
      const dx = touch.clientX - touchStartX;
      const dy = touch.clientY - touchStartY;
      if (Math.abs(dx) > TAP_MOVE_TOLERANCE || Math.abs(dy) > TAP_MOVE_TOLERANCE) {
        // Finger moved enough that we treat this as a scroll, not a tap.
        resetTouch();
      }
    },
    { passive: true },
  );

  boardEl.addEventListener('touchend', (e) => {
    // If long-press already fired, suppress the synthetic click that follows.
    if (touchLongPress) {
      if (e.cancelable) e.preventDefault();
      touchLongPress = false;
      resetTouch();
      return;
    }
    // Short tap — check for double-tap to chord.
    const target = touchTarget;
    resetTouch();
    if (!target) return;
    const r = Number(target.dataset.r);
    const c = Number(target.dataset.c);
    if (!Number.isFinite(r) || !Number.isFinite(c)) return;
    const i = idx(r, c);
    const now = Date.now();
    if (i === lastTapIndex && now - lastTapTime < DOUBLE_TAP_MS) {
      // Second tap of a double-tap on the same cell → chord.
      const cell = cells[i];
      if (cell && cell.open && cell.adj > 0) {
        if (e.cancelable) e.preventDefault();
        suppressNextClick = true;
        chord(i);
      }
      lastTapIndex = -1;
      lastTapTime = 0;
      return;
    }
    lastTapIndex = i;
    lastTapTime = now;
  });

  boardEl.addEventListener('touchcancel', () => {
    resetTouch();
  });
}

function reset(): void {
  config = CONFIGS[difficulty];
  firstClick = true;
  gameOver = false;
  flagsPlaced = 0;
  openedCount = 0;
  stopTimer();
  timer = 0;
  timerEl.textContent = '0';
  buildBoard();
  renderAll();
  renderBest();
  setFace('🙂');
  setStatus('İlk hücreye tıkla — ilk tık asla mayına denk gelmez.');
}

function init(): void {
  boardEl = document.querySelector<HTMLDivElement>('#board')!;
  statusEl = document.querySelector<HTMLElement>('#status')!;
  minesLeftEl = document.querySelector<HTMLElement>('#mines-left')!;
  timerEl = document.querySelector<HTMLElement>('#timer')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  restartFace = document.querySelector<HTMLElement>('#restart-face')!;
  difficultySel = document.querySelector<HTMLSelectElement>('#difficulty')!;

  difficulty = loadDifficulty();
  difficultySel.value = difficulty;
  attachBoardListeners();

  restartBtn.addEventListener('click', reset);
  difficultySel.addEventListener('change', () => {
    const v = difficultySel.value;
    if (v === 'easy' || v === 'medium' || v === 'hard') {
      difficulty = v;
      saveDifficulty();
      reset();
    }
  });
  window.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() !== 'r') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target as HTMLElement | null;
    if (target) {
      const tag = target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) {
        return;
      }
    }
    reset();
  });

  reset();
}

export const game = defineGame({ init, reset });
