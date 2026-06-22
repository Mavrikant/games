import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';
import { reportGameOver } from '@shared/leaderboard';

// PITFALLS guards in place:
// - unguarded-storage: safeRead/safeWrite wrap localStorage.
// - module-level-dom-access: all DOM lookups + listeners live inside init().
// - overlay-input-leak: every input handler guards on `phase`.
// - missing-overlay-css: per-game CSS defines .overlay / .overlay--hidden.
// - stale-dom-from-prev-state: render() wipes #board and rebuilds from scratch
//   before any cross-element reads, so a shrunken level cannot read stale cells
//   from a previous larger level.

type Phase = 'ready' | 'playing' | 'won' | 'lost';
type Dir = 'up' | 'down' | 'left' | 'right';

interface Cell {
  r: number;
  c: number;
}

interface Bell extends Cell {
  noise: number;
  threshold: number;
  rang?: boolean;
}

const STORAGE_BEST = 'cingirak.best';
const SCORE_DESC = {
  gameId: 'cingirak',
  storageKey: STORAGE_BEST,
  direction: 'higher' as const,
};

let phase: Phase = 'ready';
let level = 1;
let best = 0;
let rows = 8;
let cols = 7;
let player: Cell = { r: 0, c: 3 };
let goal: Cell = { r: 7, c: 3 };
let bells: Bell[] = [];

let boardEl!: HTMLElement;
let levelEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let waitBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayBtn!: HTMLButtonElement;

interface LevelSpec {
  rows: number;
  cols: number;
  bellCount: number;
  threshold: number;
}

function dims(lv: number): LevelSpec {
  const rs = Math.min(12, 8 + Math.floor((lv - 1) / 2));
  const cs = 7;
  const bc = Math.min(9, 4 + Math.floor((lv - 1) / 2));
  const th = lv >= 5 ? 2 : 3;
  return { rows: rs, cols: cs, bellCount: bc, threshold: th };
}

function chebyshev(a: Cell, b: Cell): number {
  return Math.max(Math.abs(a.r - b.r), Math.abs(a.c - b.c));
}

function bellAt(r: number, c: number): Bell | undefined {
  return bells.find((b) => b.r === r && b.c === c);
}

function pathExists(start: Cell, end: Cell, walls: Bell[]): boolean {
  const blocked = new Set(walls.map((b) => `${b.r},${b.c}`));
  if (blocked.has(`${end.r},${end.c}`)) return false;
  const seen = new Set<string>();
  const queue: Cell[] = [start];
  seen.add(`${start.r},${start.c}`);
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur.r === end.r && cur.c === end.c) return true;
    for (const [dr, dc] of [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ] as const) {
      const nr = cur.r + dr;
      const nc = cur.c + dc;
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
      const key = `${nr},${nc}`;
      if (seen.has(key)) continue;
      if (blocked.has(key)) continue;
      seen.add(key);
      queue.push({ r: nr, c: nc });
    }
  }
  return false;
}

function generateLevel(lv: number): void {
  const spec = dims(lv);
  rows = spec.rows;
  cols = spec.cols;
  player = { r: 0, c: Math.floor(cols / 2) };

  for (let attempt = 0; attempt < 200; attempt++) {
    const goalCol = Math.floor(Math.random() * cols);
    const goalCell: Cell = { r: rows - 1, c: goalCol };

    const used = new Set<string>();
    used.add(`${player.r},${player.c}`);
    used.add(`${goalCell.r},${goalCell.c}`);
    // Reserve cells adjacent to player so the first step is never instantly
    // inside a bell halo — fights PITFALLS#invisible-boot (first move feels
    // dead) and gives a clear safe entry.
    for (const [dr, dc] of [
      [1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      used.add(`${player.r + dr},${player.c + dc}`);
    }

    const newBells: Bell[] = [];
    let tries = 0;
    while (newBells.length < spec.bellCount && tries < 400) {
      tries++;
      const r = 1 + Math.floor(Math.random() * (rows - 2));
      const c = Math.floor(Math.random() * cols);
      const key = `${r},${c}`;
      if (used.has(key)) continue;
      used.add(key);
      // Reject bells immediately adjacent to another bell — keeps halos
      // legible and prevents impossible chokepoints.
      if (newBells.some((b) => chebyshev({ r, c }, b) <= 1)) continue;
      newBells.push({ r, c, noise: 0, threshold: spec.threshold });
    }

    if (newBells.length < spec.bellCount) continue;
    if (!pathExists(player, goalCell, newBells)) continue;

    bells = newBells;
    goal = goalCell;
    return;
  }

  // Fallback: empty board (shouldn't happen but never lock the player out).
  bells = [];
  goal = { r: rows - 1, c: Math.floor(cols / 2) };
}

function showOverlay(title: string, msg: string, btnLabel: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  overlayBtn.textContent = btnLabel;
  showOverlayEl(overlay);
}

function hideOverlay(): void {
  hideOverlayEl(overlay);
}

function render(): void {
  levelEl.textContent = String(level);
  bestEl.textContent = String(best);

  boardEl.style.setProperty('--cols', String(cols));
  boardEl.style.setProperty('--rows', String(rows));
  boardEl.innerHTML = '';

  // Pre-compute halo intensity per cell from non-rung bells, so the player
  // can see which cells are inside a chime's sensitivity radius.
  const halo = new Map<string, number>();
  for (const b of bells) {
    if (b.rang) continue;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const r = b.r + dr;
        const c = b.c + dc;
        if (r < 0 || r >= rows || c < 0 || c >= cols) continue;
        const k = `${r},${c}`;
        halo.set(k, Math.max(halo.get(k) ?? 0, b.noise + 1));
      }
    }
  }

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'cell';
      cell.dataset.r = String(r);
      cell.dataset.c = String(c);
      cell.setAttribute('role', 'gridcell');

      const b = bellAt(r, c);
      const isPlayer = r === player.r && c === player.c;
      const isGoal = r === goal.r && c === goal.c;

      if (b) {
        cell.classList.add('cell--bell');
        cell.classList.add(`cell--noise-${Math.min(b.noise, b.threshold)}`);
        if (b.rang) cell.classList.add('cell--rang');
        cell.setAttribute(
          'aria-label',
          `Çıngırak (gürültü ${b.noise} / ${b.threshold}), satır ${r + 1}, sütun ${c + 1}`,
        );
        cell.disabled = true;

        const icon = document.createElement('span');
        icon.className = 'cell__bell';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = '◉';
        cell.appendChild(icon);

        const num = document.createElement('span');
        num.className = 'cell__noise';
        num.textContent = String(b.noise);
        cell.appendChild(num);
      } else {
        const haloLvl = halo.get(`${r},${c}`);
        if (haloLvl !== undefined) {
          cell.classList.add('cell--halo');
          cell.classList.add(`cell--halo-${Math.min(haloLvl, 3)}`);
        } else {
          cell.classList.add('cell--floor');
        }
        cell.setAttribute(
          'aria-label',
          `Hücre, satır ${r + 1}, sütun ${c + 1}${haloLvl !== undefined ? ', çıngırak halkası içinde' : ''}`,
        );
      }

      if (isGoal && !b) {
        cell.classList.add('cell--goal');
        const flag = document.createElement('span');
        flag.className = 'cell__flag';
        flag.setAttribute('aria-hidden', 'true');
        flag.textContent = '⚑';
        cell.appendChild(flag);
      }

      if (isPlayer && !b) {
        cell.classList.add('cell--player');
        const pawn = document.createElement('span');
        pawn.className = 'cell__pawn';
        pawn.setAttribute('aria-hidden', 'true');
        pawn.textContent = '●';
        cell.appendChild(pawn);
      }

      boardEl.appendChild(cell);
    }
  }

  waitBtn.disabled = phase !== 'playing';
}

function processBells(): boolean {
  // Adjust noise based on player's current position; return true if any bell
  // just crossed its threshold (caller transitions to lost).
  let rang: Bell | null = null;
  for (const b of bells) {
    if (chebyshev(player, b) <= 1) {
      b.noise = Math.min(b.threshold, b.noise + 1);
    } else {
      b.noise = Math.max(0, b.noise - 1);
    }
    if (b.noise >= b.threshold && rang === null) rang = b;
  }
  if (rang) {
    rang.rang = true;
    return true;
  }
  return false;
}

function cooldownAll(): void {
  for (const b of bells) {
    b.noise = Math.max(0, b.noise - 1);
  }
}

function tryMove(dir: Dir): void {
  if (phase !== 'playing') return;
  const nr = player.r + (dir === 'up' ? -1 : dir === 'down' ? 1 : 0);
  const nc = player.c + (dir === 'left' ? -1 : dir === 'right' ? 1 : 0);
  if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) return;
  if (bellAt(nr, nc)) return; // cannot step onto a bell

  player = { r: nr, c: nc };

  const rang = processBells();
  if (rang) {
    finishLost();
    return;
  }

  if (player.r === goal.r && player.c === goal.c) {
    finishWon();
    return;
  }

  render();
}

function waitTurn(): void {
  if (phase !== 'playing') return;
  cooldownAll();
  render();
}

function finishWon(): void {
  phase = 'won';
  level += 1;
  const cleared = level - 1;
  if (cleared > best) {
    best = cleared;
    safeWrite(STORAGE_BEST, best);
  }
  reportGameOver(SCORE_DESC, cleared);
  render();
  showOverlay(
    `Bölüm ${cleared} tamam!`,
    `Sıradaki bölüm ${level}. Çıngıraklar artıyor, eşik düşüyor — devam etmeye hazır mısın?`,
    'Sıradaki bölüm',
  );
}

function finishLost(): void {
  phase = 'lost';
  const cleared = level - 1;
  if (cleared > best) {
    best = cleared;
    safeWrite(STORAGE_BEST, best);
  }
  render();
  showOverlay(
    'Çıngırak çaldı!',
    `Bölüm ${level} bitti. Bu turda ${cleared} bölüm geçtin. Yeniden başlamak için tıkla.`,
    'Baştan başla',
  );
}

function startLevel(): void {
  generateLevel(level);
  phase = 'playing';
  hideOverlay();
  render();
}

function restartLevel(): void {
  if (phase === 'lost') {
    level = 1;
  }
  startLevel();
}

function reset(): void {
  level = 1;
  phase = 'ready';
  generateLevel(level);
  render();
  showOverlay(
    'Çıngırak',
    'Çıngırakları (◉) uyandırmadan bayrağa (⚑) in. Çana komşu hücreye her adım gürültü ekler; uzaklaş ya da Boşluk ile bekle, sessizleşsinler.',
    'Başla',
  );
}

function handleOverlayClick(): void {
  if (phase === 'ready' || phase === 'won') {
    startLevel();
    return;
  }
  if (phase === 'lost') {
    level = 1;
    startLevel();
  }
}

function onKey(e: KeyboardEvent): void {
  const k = e.key.toLowerCase();
  if (k === 'r') {
    restartLevel();
    e.preventDefault();
    return;
  }
  if (phase !== 'playing') {
    if (k === ' ' || k === 'enter') {
      handleOverlayClick();
      e.preventDefault();
    }
    return;
  }
  if (k === 'arrowup' || k === 'w') {
    tryMove('up');
    e.preventDefault();
  } else if (k === 'arrowdown' || k === 's') {
    tryMove('down');
    e.preventDefault();
  } else if (k === 'arrowleft' || k === 'a') {
    tryMove('left');
    e.preventDefault();
  } else if (k === 'arrowright' || k === 'd') {
    tryMove('right');
    e.preventDefault();
  } else if (k === ' ') {
    waitTurn();
    e.preventDefault();
  }
}

function onBoardClick(e: MouseEvent): void {
  if (phase !== 'playing') return;
  const target = e.target;
  if (!(target instanceof HTMLElement)) return;
  const cellEl = target.closest<HTMLElement>('.cell');
  if (!cellEl || !boardEl.contains(cellEl)) return;
  const r = Number(cellEl.dataset.r);
  const c = Number(cellEl.dataset.c);
  if (!Number.isInteger(r) || !Number.isInteger(c)) return;
  const dr = r - player.r;
  const dc = c - player.c;
  if (Math.abs(dr) + Math.abs(dc) !== 1) return;
  if (dr === -1) tryMove('up');
  else if (dr === 1) tryMove('down');
  else if (dc === -1) tryMove('left');
  else if (dc === 1) tryMove('right');
}

function init(): void {
  boardEl = document.querySelector<HTMLElement>('#board')!;
  levelEl = document.querySelector<HTMLElement>('#level')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  waitBtn = document.querySelector<HTMLButtonElement>('#wait-btn')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  window.addEventListener('keydown', onKey);
  boardEl.addEventListener('click', onBoardClick);
  restartBtn.addEventListener('click', restartLevel);
  waitBtn.addEventListener('click', waitTurn);
  overlayBtn.addEventListener('click', handleOverlayClick);

  reset();
}

export const game = defineGame({ init, reset });
