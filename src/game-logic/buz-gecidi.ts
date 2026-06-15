import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';
import { reportGameOver } from '@shared/leaderboard';

// PITFALLS guards:
// - unguarded-storage: safeRead/safeWrite
// - module-level-dom-access: all DOM access lives in init()
// - overlay-input-leak: explicit `state` enum; every input handler guards on it
// - missing-overlay-css: per-game CSS defines .overlay / .overlay--hidden
// - stale-dom-from-prev-state: render() rebuilds board from scratch on each call

type Phase = 'ready' | 'playing' | 'won' | 'lost';
type Dir = 'up' | 'down' | 'left' | 'right';

interface Cell {
  /** Remaining steps the floe can endure. 0 = sunk (impassable). */
  strength: number;
  /** True if the player is currently standing on this cell. */
  player?: boolean;
  /** True if this is the goal flag cell. */
  goal?: boolean;
}

const STORAGE_BEST = 'buz-gecidi.best';
const SCORE_DESC = { gameId: 'buz-gecidi', storageKey: STORAGE_BEST, direction: 'higher' as const };
const MAX_STRENGTH = 3;

let phase: Phase = 'ready';
let level = 1;
let best = 0;
let rows = 4;
let cols = 4;
let grid: Cell[][] = [];
let player: { r: number; c: number } = { r: 0, c: 0 };
let goal: { r: number; c: number } = { r: 0, c: 0 };

let boardEl!: HTMLElement;
let levelEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayBtn!: HTMLButtonElement;

function dims(lv: number): { rows: number; cols: number } {
  // 4x4 at level 1, grow by 1 per side every 3 levels, capped at 8x8.
  const grow = Math.min(4, Math.floor((lv - 1) / 3));
  const side = 4 + grow;
  return { rows: side, cols: side };
}

function shortestPathPossible(
  startStrength: number[][],
  start: { r: number; c: number },
  end: { r: number; c: number },
): boolean {
  // BFS treating any cell with strength >= 1 as walkable.
  const R = startStrength.length;
  const C = startStrength[0]!.length;
  const seen: boolean[][] = Array.from({ length: R }, () => Array(C).fill(false));
  const queue: { r: number; c: number }[] = [start];
  seen[start.r]![start.c] = true;
  while (queue.length > 0) {
    const { r, c } = queue.shift()!;
    if (r === end.r && c === end.c) return true;
    for (const [dr, dc] of [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ] as const) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nr >= R || nc < 0 || nc >= C) continue;
      if (seen[nr]![nc]) continue;
      if (startStrength[nr]![nc]! < 1) continue;
      seen[nr]![nc] = true;
      queue.push({ r: nr, c: nc });
    }
  }
  return false;
}

function generateLevel(lv: number): void {
  const { rows: R, cols: C } = dims(lv);
  rows = R;
  cols = C;
  player = { r: R - 1, c: 0 };
  goal = { r: 0, c: C - 1 };

  // Difficulty knobs: as level grows, more weak (strength=1 or 2) cells.
  // We retry generation until we have a solvable level (BFS-reachable).
  const weakRatio = Math.min(0.55, 0.15 + lv * 0.04);
  const fragileRatio = Math.min(0.25, 0.02 + lv * 0.025);

  for (let attempt = 0; attempt < 60; attempt++) {
    const strengths: number[][] = [];
    for (let r = 0; r < R; r++) {
      const row: number[] = [];
      for (let c = 0; c < C; c++) {
        if ((r === player.r && c === player.c) || (r === goal.r && c === goal.c)) {
          row.push(MAX_STRENGTH);
          continue;
        }
        const roll = Math.random();
        if (roll < fragileRatio) row.push(1);
        else if (roll < weakRatio) row.push(2);
        else row.push(MAX_STRENGTH);
      }
      strengths.push(row);
    }
    if (shortestPathPossible(strengths, player, goal)) {
      grid = strengths.map((row, r) =>
        row.map<Cell>((s, c) => ({
          strength: s,
          player: r === player.r && c === player.c,
          goal: r === goal.r && c === goal.c,
        })),
      );
      return;
    }
  }
  // Fallback: open board.
  grid = [];
  for (let r = 0; r < R; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < C; c++) {
      row.push({
        strength: MAX_STRENGTH,
        player: r === player.r && c === player.c,
        goal: r === goal.r && c === goal.c,
      });
    }
    grid.push(row);
  }
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

  // Rebuild grid from scratch to avoid stale-dom-from-prev-state.
  boardEl.style.setProperty('--cols', String(cols));
  boardEl.style.setProperty('--rows', String(rows));
  boardEl.innerHTML = '';

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = grid[r]![c]!;
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'cell';
      el.dataset.r = String(r);
      el.dataset.c = String(c);
      el.setAttribute('role', 'gridcell');

      if (cell.strength <= 0) {
        el.classList.add('cell--sunk');
        el.setAttribute('aria-label', 'Batık buz');
        el.disabled = true;
      } else {
        el.classList.add(`cell--s${cell.strength}`);
        el.setAttribute(
          'aria-label',
          `Buz, dayanıklık ${cell.strength}, satır ${r + 1}, sütun ${c + 1}`,
        );
      }

      if (cell.goal) {
        el.classList.add('cell--goal');
      }
      if (cell.player) {
        el.classList.add('cell--player');
      }

      const label = document.createElement('span');
      label.className = 'cell__num';
      label.textContent = cell.strength > 0 ? String(cell.strength) : '';
      el.appendChild(label);

      if (cell.goal) {
        const flag = document.createElement('span');
        flag.className = 'cell__flag';
        flag.setAttribute('aria-hidden', 'true');
        flag.textContent = '⚑';
        el.appendChild(flag);
      }
      if (cell.player) {
        const pawn = document.createElement('span');
        pawn.className = 'cell__pawn';
        pawn.setAttribute('aria-hidden', 'true');
        pawn.textContent = '●';
        el.appendChild(pawn);
      }

      boardEl.appendChild(el);
    }
  }
}

function tryMove(dir: Dir): void {
  if (phase !== 'playing') return;
  let nr = player.r;
  let nc = player.c;
  if (dir === 'up') nr--;
  else if (dir === 'down') nr++;
  else if (dir === 'left') nc--;
  else nc++;
  stepTo(nr, nc);
}

function stepTo(nr: number, nc: number): void {
  if (phase !== 'playing') return;
  if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) return;
  const dr = Math.abs(nr - player.r);
  const dc = Math.abs(nc - player.c);
  if (dr + dc !== 1) return; // orthogonal neighbour only
  const target = grid[nr]![nc]!;
  if (target.strength <= 0) return; // sunk, unreachable

  // Leave old cell.
  const fromCell = grid[player.r]![player.c]!;
  fromCell.player = false;

  // Step onto new cell, deplete strength.
  target.strength -= 1;
  target.player = true;
  player = { r: nr, c: nc };

  // Win check first — reaching the goal wins even if strength hit 0.
  if (target.goal) {
    phase = 'won';
    level += 1;
    if (level - 1 > best) {
      best = level - 1;
      safeWrite(STORAGE_BEST, best);
    }
    reportGameOver(SCORE_DESC, level - 1);
    render();
    showOverlay(
      `Bölüm ${level - 1} tamam!`,
      `Sıradaki bölüm ${level}. Devam etmek için tıkla.`,
      'Sıradaki bölüm',
    );
    return;
  }

  // Loss check: stranded on sunk cell with no neighbour to escape.
  if (target.strength <= 0) {
    if (!hasEscape(nr, nc)) {
      phase = 'lost';
      render();
      showOverlay(
        'Battın!',
        `Bölüm ${level} bitti. Toplam geçtiğin bölüm: ${level - 1}. Yeniden başlamak için tıkla.`,
        'Baştan başla',
      );
      return;
    }
  }

  render();
}

function hasEscape(r: number, c: number): boolean {
  for (const [dr, dc] of [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ] as const) {
    const nr = r + dr;
    const nc = c + dc;
    if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
    if (grid[nr]![nc]!.strength > 0) return true;
  }
  return false;
}

function startLevel(): void {
  generateLevel(level);
  phase = 'playing';
  hideOverlay();
  render();
}

function restartLevel(): void {
  // Restart current level — does not reset run counter unless we're in 'lost'.
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
    'Buz Geçidi',
    'Mavi taşı bayrağa götür. Her adım altındaki buzu çatlatır; dayanıklık sıfıra inerse batar.',
    'Başla',
  );
}

function onKey(e: KeyboardEvent): void {
  const k = e.key.toLowerCase();
  if (k === 'r') {
    restartLevel();
    e.preventDefault();
    return;
  }
  if (phase === 'ready' || phase === 'won' || phase === 'lost') {
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
  stepTo(r, c);
}

function handleOverlayClick(): void {
  if (phase === 'ready') {
    startLevel();
  } else if (phase === 'won') {
    startLevel();
  } else if (phase === 'lost') {
    level = 1;
    startLevel();
  }
}

function init(): void {
  boardEl = document.querySelector<HTMLElement>('#board')!;
  levelEl = document.querySelector<HTMLElement>('#level')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  window.addEventListener('keydown', onKey);
  boardEl.addEventListener('click', onBoardClick);
  restartBtn.addEventListener('click', restartLevel);
  overlayBtn.addEventListener('click', handleOverlayClick);

  reset();
}

export const game = defineGame({ init, reset });
