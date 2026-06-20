// Vitray — stack additive R/G/B glass layers to match a target.
// Each cell stores a 3-bit mask: bit 0 = R, bit 1 = G, bit 2 = B. Mixed bits
// give Yellow (R+G), Magenta (R+B), Cyan (G+B), White (R+G+B). The puzzle is
// solved the instant grid === target across all cells; "Hamle" counter
// tracks clicks that actually changed a cell (idempotent clicks are free, so
// double-tapping the same colour isn't punished — pitfall: overlay-input-leak
// cousin).

import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { hideOverlay, showOverlay } from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';
import { reportGameOver } from '@shared/leaderboard';

const SIZE = 4;
const N = SIZE * SIZE;
const STORAGE_BEST = 'vitray.best';
const SCORE_DESC = {
  gameId: 'vitray',
  storageKey: STORAGE_BEST,
  direction: 'lower' as const,
};
const WIN_DELAY_MS = 360;

type Color = number; // 0..7 bitmask
type Tool = 'r' | 'g' | 'b' | 'x';
type State = 'playing' | 'won';

const TOOL_BIT: Record<Exclude<Tool, 'x'>, number> = {
  r: 0b001,
  g: 0b010,
  b: 0b100,
};

const gen = createGenToken();

let boardEl!: HTMLElement;
let targetEl!: HTMLElement;
let movesEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayNext!: HTMLButtonElement;
let toolBtns: HTMLButtonElement[] = [];
let cellEls: HTMLButtonElement[] = [];
let targetCellEls: HTMLElement[] = [];

let grid: Color[] = new Array(N).fill(0);
let target: Color[] = new Array(N).fill(0);
let tool: Tool = 'r';
let moves = 0;
let best: number | null = null;
let state: State = 'playing';

function loadBest(): number | null {
  const v = safeRead<number>(STORAGE_BEST, 0);
  return Number.isFinite(v) && v > 0 ? v : null;
}

function renderMoves(): void {
  movesEl.textContent = String(moves);
}

function renderBest(): void {
  bestEl.textContent = best === null ? '—' : String(best);
}

function colorClass(c: Color): string {
  return `c-${c}`;
}

function buildBoard(el: HTMLElement, role: 'target' | 'play'): HTMLElement[] {
  el.innerHTML = '';
  const out: HTMLElement[] = [];
  for (let i = 0; i < N; i++) {
    const isPlay = role === 'play';
    const node = document.createElement(isPlay ? 'button' : 'div');
    node.className = 'vt-cell c-0';
    if (isPlay) {
      const btn = node as HTMLButtonElement;
      btn.type = 'button';
      btn.dataset.i = String(i);
      btn.setAttribute('role', 'gridcell');
      const r = Math.floor(i / SIZE) + 1;
      const c = (i % SIZE) + 1;
      btn.setAttribute('aria-label', `Cam hücresi ${r}-${c}`);
      btn.addEventListener('click', onCellClick);
    } else {
      node.setAttribute('aria-hidden', 'true');
    }
    el.appendChild(node);
    out.push(node);
  }
  return out;
}

function paintCell(node: HTMLElement, prev: Color, next: Color): void {
  if (prev === next) return;
  node.classList.remove(colorClass(prev));
  node.classList.add(colorClass(next));
}

function renderGrid(): void {
  for (let i = 0; i < N; i++) {
    const el = cellEls[i];
    if (!el) continue;
    const cur = Number(el.dataset.color ?? '0');
    const next = grid[i] ?? 0;
    paintCell(el, cur, next);
    el.dataset.color = String(next);
    el.classList.toggle('vt-cell--match', next === (target[i] ?? 0));
  }
}

function renderTarget(): void {
  for (let i = 0; i < N; i++) {
    const el = targetCellEls[i];
    if (!el) continue;
    const cur = Number(el.dataset.color ?? '0');
    const next = target[i] ?? 0;
    paintCell(el, cur, next);
    el.dataset.color = String(next);
  }
}

function renderTools(): void {
  for (const btn of toolBtns) {
    const isOn = btn.dataset.tool === tool;
    btn.setAttribute('aria-pressed', String(isOn));
    btn.classList.toggle('vt-tool--active', isOn);
  }
}

function isSolved(): boolean {
  for (let i = 0; i < N; i++) {
    if ((grid[i] ?? 0) !== (target[i] ?? 0)) return false;
  }
  return true;
}

function onCellClick(e: MouseEvent): void {
  if (state !== 'playing') return;
  const btn = e.currentTarget as HTMLButtonElement | null;
  if (!btn) return;
  const i = Number(btn.dataset.i);
  if (!Number.isInteger(i) || i < 0 || i >= N) return;

  applyTool(i);
}

function applyTool(i: number): void {
  const prev = grid[i] ?? 0;
  let next = prev;
  if (tool === 'x') {
    next = 0;
  } else {
    const bit = TOOL_BIT[tool];
    next = prev | bit;
  }
  if (next === prev) return;

  grid[i] = next;
  moves++;
  renderMoves();
  renderGrid();

  if (isSolved()) {
    state = 'won';
    const winMoves = moves;
    const myGen = gen.current();
    window.setTimeout(() => {
      if (!gen.isCurrent(myGen)) return;
      showWin(winMoves);
    }, WIN_DELAY_MS);
  }
}

function showWin(winMoves: number): void {
  const isBest = best === null || winMoves < best;
  if (isBest) {
    best = winMoves;
    safeWrite(STORAGE_BEST, best);
    renderBest();
  }
  const optimal = optimalMoves();
  overlayTitle.textContent = isBest ? 'Yeni rekor!' : 'Vitray tamamlandı!';
  const ideal =
    winMoves === optimal
      ? 'Mükemmel — ideal hamle sayısıyla bitirdin.'
      : `${winMoves} hamlede çözdün. İdeal: ${optimal}.`;
  overlayMsg.textContent = ideal;
  reportGameOver(SCORE_DESC, winMoves, { label: 'Hamle' });
  showOverlay(overlay);
  overlayNext.focus({ preventScroll: true });
}

function optimalMoves(): number {
  let total = 0;
  for (let i = 0; i < N; i++) {
    let c = target[i] ?? 0;
    while (c > 0) {
      total += c & 1;
      c >>= 1;
    }
  }
  return total;
}

function randomColor(): Color {
  // Bias toward simpler colours so puzzles stay solvable in a few moves;
  // pure R/G/B more common, white rare.
  const roll = Math.random();
  if (roll < 0.45) {
    const c = Math.floor(Math.random() * 3);
    return [0b001, 0b010, 0b100][c]!;
  }
  if (roll < 0.85) {
    const c = Math.floor(Math.random() * 3);
    return [0b011, 0b101, 0b110][c]!;
  }
  return 0b111;
}

function newTarget(): Color[] {
  const t: Color[] = new Array(N).fill(0);
  // Fill 7-10 cells so the puzzle has rhythm without being trivial.
  const fillCount = 7 + Math.floor(Math.random() * 4);
  const indices = Array.from({ length: N }, (_, i) => i);
  // Fisher-Yates shuffle then pick first fillCount.
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j]!, indices[i]!];
  }
  for (let k = 0; k < fillCount; k++) {
    const idx = indices[k]!;
    t[idx] = randomColor();
  }
  return t;
}

function setTool(t: Tool): void {
  if (tool === t) return;
  tool = t;
  renderTools();
}

function reset(): void {
  gen.bump();
  state = 'playing';
  grid = new Array(N).fill(0);
  target = newTarget();
  moves = 0;
  tool = 'r';
  hideOverlay(overlay);
  renderMoves();
  renderGrid();
  renderTarget();
  renderTools();
}

function init(): void {
  boardEl = document.querySelector<HTMLElement>('#board')!;
  targetEl = document.querySelector<HTMLElement>('#target')!;
  movesEl = document.querySelector<HTMLElement>('#moves')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayNext = document.querySelector<HTMLButtonElement>('#overlay-next')!;
  toolBtns = Array.from(
    document.querySelectorAll<HTMLButtonElement>('.vt-tool'),
  );

  cellEls = buildBoard(boardEl, 'play') as HTMLButtonElement[];
  targetCellEls = buildBoard(targetEl, 'target');

  best = loadBest();

  for (const btn of toolBtns) {
    btn.addEventListener('click', () => {
      const t = btn.dataset.tool as Tool | undefined;
      if (!t) return;
      setTool(t);
    });
  }

  restartBtn.addEventListener('click', reset);
  overlayNext.addEventListener('click', reset);

  window.addEventListener('keydown', (e) => {
    if (e.key === '1') {
      setTool('r');
      e.preventDefault();
    } else if (e.key === '2') {
      setTool('g');
      e.preventDefault();
    } else if (e.key === '3') {
      setTool('b');
      e.preventDefault();
    } else if (e.key === '0' || e.key === 'x' || e.key === 'X') {
      setTool('x');
      e.preventDefault();
    } else if (e.key === 'r' || e.key === 'R') {
      reset();
      e.preventDefault();
    } else if (e.key === 'Enter' && state === 'won') {
      reset();
      e.preventDefault();
    }
  });

  renderBest();
  reset();
}

export const game = defineGame({ init, reset });
