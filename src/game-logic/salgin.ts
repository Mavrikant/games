// Salgın — outbreak containment. A small infection starts on a 7×7 grid;
// each click is one "day". Clicking a healthy cell quarantines it (a wall);
// clicking an infected cell cures it (immune, blocks spread). After every
// click, each infected cell tries to infect each healthy orthogonal
// neighbor with a fixed probability. Goal: zero infected cells. Score =
// alive cells (healthy + quarantined + cured) when the round ends.

import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';

const SIZE = 7;
const TOTAL = SIZE * SIZE;
const INITIAL_INFECTED = 3;
const SPREAD_PROB = 0.22;
// Stop the round if more than ~55% of cells are infected — recovery from
// here is essentially impossible and players should restart.
const LOSE_INFECTED = 28;
const STORAGE_BEST = 'salgin.best';

type Cell = 'healthy' | 'infected' | 'quarantined' | 'cured';
type Phase = 'playing' | 'won' | 'lost';

let boardEl!: HTMLElement;
let turnsEl!: HTMLElement;
let infectedEl!: HTMLElement;
let savedEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlayEl!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayBtn!: HTMLButtonElement;

let grid: Cell[] = new Array(TOTAL).fill('healthy');
let cellEls: HTMLButtonElement[] = [];
let phase: Phase = 'playing';
let turns = 0;
let best = 0;

function idx(r: number, c: number): number {
  return r * SIZE + c;
}

function countBy(predicate: (c: Cell) => boolean): number {
  let n = 0;
  for (let i = 0; i < TOTAL; i++) {
    if (predicate(grid[i]!)) n++;
  }
  return n;
}

function countInfected(): number {
  return countBy((c) => c === 'infected');
}

function countSaved(): number {
  return countBy((c) => c !== 'infected');
}

function placeInitialInfected(): void {
  // Spread the seeds out so the first turn isn't a single-click cure.
  const picks: number[] = [];
  let attempts = 0;
  while (picks.length < INITIAL_INFECTED && attempts < 200) {
    attempts++;
    const r = Math.floor(Math.random() * SIZE);
    const c = Math.floor(Math.random() * SIZE);
    const i = idx(r, c);
    const farEnough = picks.every((p) => {
      const pr = Math.floor(p / SIZE);
      const pc = p % SIZE;
      return Math.abs(pr - r) + Math.abs(pc - c) >= 2;
    });
    if (farEnough && !picks.includes(i)) picks.push(i);
  }
  for (const i of picks) grid[i] = 'infected';
}

function spreadTick(): void {
  const newInfections: number[] = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (grid[idx(r, c)] !== 'infected') continue;
      const neighbors: [number, number][] = [
        [r - 1, c],
        [r + 1, c],
        [r, c - 1],
        [r, c + 1],
      ];
      for (const [nr, nc] of neighbors) {
        if (nr < 0 || nr >= SIZE || nc < 0 || nc >= SIZE) continue;
        const ni = idx(nr, nc);
        if (grid[ni] !== 'healthy') continue;
        if (newInfections.includes(ni)) continue;
        if (Math.random() < SPREAD_PROB) newInfections.push(ni);
      }
    }
  }
  for (const ni of newInfections) grid[ni] = 'infected';
}

function buildBoard(): void {
  boardEl.innerHTML = '';
  cellEls = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cell';
      btn.setAttribute('role', 'gridcell');
      btn.dataset.r = String(r);
      btn.dataset.c = String(c);
      btn.addEventListener('click', onCellClick);
      boardEl.appendChild(btn);
      cellEls.push(btn);
    }
  }
}

function render(): void {
  for (let i = 0; i < TOTAL; i++) {
    const el = cellEls[i]!;
    const s = grid[i]!;
    el.dataset.state = s;
    el.setAttribute(
      'aria-label',
      `Hücre ${Math.floor(i / SIZE) + 1},${(i % SIZE) + 1} — ${cellLabel(s)}`,
    );
    el.disabled =
      phase !== 'playing' || s === 'quarantined' || s === 'cured';
  }
  turnsEl.textContent = String(turns);
  const inf = countInfected();
  infectedEl.textContent = String(inf);
  savedEl.textContent = String(TOTAL - inf);
}

function cellLabel(s: Cell): string {
  if (s === 'healthy') return 'sağlıklı';
  if (s === 'infected') return 'enfekte';
  if (s === 'quarantined') return 'karantina';
  return 'iyileşmiş';
}

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlayEl);
}

function hideOverlay(): void {
  hideOverlayEl(overlayEl);
}

function onCellClick(e: MouseEvent): void {
  if (phase !== 'playing') return;
  const target = e.currentTarget as HTMLButtonElement | null;
  if (!target) return;
  const r = Number(target.dataset.r);
  const c = Number(target.dataset.c);
  if (!Number.isInteger(r) || !Number.isInteger(c)) return;
  const i = idx(r, c);
  const s = grid[i]!;
  if (s === 'healthy') {
    grid[i] = 'quarantined';
  } else if (s === 'infected') {
    grid[i] = 'cured';
  } else {
    return;
  }
  turns++;
  spreadTick();
  render();
  checkEnd();
}

function checkEnd(): void {
  const inf = countInfected();
  if (inf === 0) {
    phase = 'won';
    const saved = countSaved();
    if (saved > best) {
      best = saved;
      safeWrite(STORAGE_BEST, best);
      bestEl.textContent = String(best);
    }
    showOverlay(
      'Salgın durduruldu!',
      `${saved}/${TOTAL} hücre kurtarıldı (${turns} tur). Yeniden başlamak için Boşluk.`,
    );
    overlayBtn.focus({ preventScroll: true });
    return;
  }
  if (inf >= LOSE_INFECTED) {
    phase = 'lost';
    showOverlay(
      'Salgın yayıldı',
      `${inf} hücre enfekte oldu, kontrol elden çıktı. Yeniden denemek için Boşluk.`,
    );
    overlayBtn.focus({ preventScroll: true });
  }
}

function startGame(): void {
  phase = 'playing';
  turns = 0;
  grid = new Array(TOTAL).fill('healthy');
  placeInitialInfected();
  hideOverlay();
  render();
}

function init(): void {
  boardEl = document.querySelector<HTMLElement>('#board')!;
  turnsEl = document.querySelector<HTMLElement>('#turns')!;
  infectedEl = document.querySelector<HTMLElement>('#infected')!;
  savedEl = document.querySelector<HTMLElement>('#saved')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlayEl = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-restart')!;

  best = safeRead<number>(STORAGE_BEST, 0);
  bestEl.textContent = String(best);

  restartBtn.addEventListener('click', startGame);
  overlayBtn.addEventListener('click', startGame);

  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    const k = e.key.toLowerCase();
    if (k === 'r') {
      startGame();
      e.preventDefault();
      return;
    }
    if ((e.key === ' ' || e.key === 'Enter') && phase !== 'playing') {
      startGame();
      e.preventDefault();
    }
  });

  buildBoard();
  startGame();
}

export const game = defineGame({ init, reset: startGame });
