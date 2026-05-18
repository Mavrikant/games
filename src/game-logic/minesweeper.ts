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

const boardEl = document.querySelector<HTMLDivElement>('#board')!;
const statusEl = document.querySelector<HTMLElement>('#status')!;
const minesLeftEl = document.querySelector<HTMLElement>('#mines-left')!;
const timerEl = document.querySelector<HTMLElement>('#timer')!;
const bestEl = document.querySelector<HTMLElement>('#best')!;
const restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
const restartFace = document.querySelector<HTMLElement>('#restart-face')!;
const difficultySel = document.querySelector<HTMLSelectElement>('#difficulty')!;

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
  boardEl.style.gridTemplateColumns = `repeat(${config.cols}, var(--ms-cell-size))`;
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
  boardEl.addEventListener('click', (e) => {
    const i = cellIndexFromEvent(e);
    if (i === null) return;
    openCell(i);
  });
  boardEl.addEventListener('contextmenu', (e) => {
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

  // Touch: long-press to flag (since right-click is not available on touch).
  let touchTimer: number | null = null;
  let touchTarget: HTMLElement | null = null;
  let touchLongPress = false;
  const TOUCH_FLAG_MS = 400;
  const clearTouch = (): void => {
    if (touchTimer !== null) {
      clearTimeout(touchTimer);
      touchTimer = null;
    }
    touchTarget = null;
  };
  boardEl.addEventListener(
    'touchstart',
    (e) => {
      const raw = e.target as HTMLElement | null;
      const target = raw?.closest<HTMLElement>('.ms-cell') ?? null;
      if (!target) return;
      touchTarget = target;
      touchLongPress = false;
      touchTimer = window.setTimeout(() => {
        if (touchTarget) {
          const i = Number(touchTarget.dataset.r) * config.cols + Number(touchTarget.dataset.c);
          if (Number.isFinite(i)) {
            touchLongPress = true;
            toggleFlag(i);
          }
        }
        touchTimer = null;
      }, TOUCH_FLAG_MS);
    },
    { passive: true },
  );
  boardEl.addEventListener('touchend', (e) => {
    if (touchLongPress) {
      e.preventDefault();
      touchLongPress = false;
    }
    clearTouch();
  });
  boardEl.addEventListener('touchmove', clearTouch, { passive: true });
  boardEl.addEventListener('touchcancel', clearTouch);
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

difficulty = loadDifficulty();
difficultySel.value = difficulty;
attachBoardListeners();
reset();
