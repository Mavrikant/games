// Board: DOM tile creation, grid bookkeeping, position math, resize handling.
// Owns the #tiles container. All visual DOM elements for tiles live here.

import { SIZE, type Tile, type SpecialType, type IngredientType, type LevelDef } from './types';
import { state } from './state';

let tilesEl!: HTMLDivElement;
let boardEl!: HTMLDivElement;

const TILE_GAP = 4;

export function bindBoard(board: HTMLDivElement, tiles: HTMLDivElement): void {
  boardEl = board;
  tilesEl = tiles;
}

export function getTilesEl(): HTMLDivElement {
  return tilesEl;
}

export function getBoardEl(): HTMLDivElement {
  return boardEl;
}

export function tileSize(): number {
  const cw = tilesEl?.clientWidth ?? 0;
  return Math.max(0, (cw - TILE_GAP * (SIZE - 1)) / SIZE);
}

export function tileStep(): number {
  return tileSize() + TILE_GAP;
}

export function posTransform(row: number, col: number): string {
  const step = tileStep();
  return `translate3d(${col * step}px, ${row * step}px, 0)`;
}

export function centerXY(row: number, col: number): { x: number; y: number } {
  const ts = tileSize();
  const step = tileStep();
  return {
    x: col * step + ts / 2,
    y: row * step + ts / 2,
  };
}

export function setTilePos(t: Tile): void {
  t.el.style.transform = posTransform(t.row, t.col);
  t.el.dataset['row'] = String(t.row);
  t.el.dataset['col'] = String(t.col);
}

export function applyTileClasses(t: Tile): void {
  const classes = ['tile'];
  if (t.color === -1) {
    classes.push('tile--color-bomb');
  } else {
    classes.push(`tile--c${t.color}`);
  }
  if (t.special === 'striped-h') classes.push('tile--striped-h');
  else if (t.special === 'striped-v') classes.push('tile--striped-v');
  else if (t.special === 'wrapped') classes.push('tile--wrapped');
  else if (t.special === 'color-bomb') classes.push('tile--color-bomb');
  if (t.ingredient === 'cherry') classes.push('tile--cherry');
  else if (t.ingredient === 'nut') classes.push('tile--nut');
  if (t.jellyLayers === 1) classes.push('tile--jelly-1');
  else if (t.jellyLayers >= 2) classes.push('tile--jelly-2');
  t.el.className = classes.join(' ');
}

export function createTile(opts: {
  color: number;
  row: number;
  col: number;
  special?: SpecialType;
  ingredient?: IngredientType;
  jellyLayers?: number;
}): Tile {
  const el = document.createElement('div');
  el.dataset['row'] = String(opts.row);
  el.dataset['col'] = String(opts.col);
  el.setAttribute('role', 'gridcell');
  const tile: Tile = {
    id: state.nextTileId++,
    color: opts.color,
    special: opts.special ?? null,
    ingredient: opts.ingredient ?? null,
    jellyLayers: opts.jellyLayers ?? 0,
    row: opts.row,
    col: opts.col,
    el,
  };
  applyTileClasses(tile);
  el.setAttribute('aria-label', ariaForTile(tile));
  return tile;
}

function ariaForTile(t: Tile): string {
  if (t.special === 'color-bomb') return 'Renk bombası';
  if (t.special === 'striped-h') return `Yatay çizgili ${t.color + 1}`;
  if (t.special === 'striped-v') return `Dikey çizgili ${t.color + 1}`;
  if (t.special === 'wrapped') return `Sarmalanmış ${t.color + 1}`;
  if (t.ingredient === 'cherry') return 'Kiraz';
  if (t.ingredient === 'nut') return 'Fındık';
  return `Şeker ${t.color + 1}`;
}

export function emptyGrid(): (Tile | null)[][] {
  return Array.from({ length: SIZE }, () => Array<Tile | null>(SIZE).fill(null));
}

function pickColorAvoiding(
  row: number,
  col: number,
  current: (Tile | null)[][],
  colorCount: number,
): number {
  const forbidden = new Set<number>();
  if (col >= 2) {
    const a = current[row]?.[col - 1]?.color;
    const b = current[row]?.[col - 2]?.color;
    if (a !== undefined && a !== -1 && a === b) forbidden.add(a);
  }
  if (row >= 2) {
    const a = current[row - 1]?.[col]?.color;
    const b = current[row - 2]?.[col]?.color;
    if (a !== undefined && a !== -1 && a === b) forbidden.add(a);
  }
  const choices: number[] = [];
  for (let i = 0; i < colorCount; i++) {
    if (!forbidden.has(i)) choices.push(i);
  }
  if (choices.length === 0) return Math.floor(Math.random() * colorCount);
  return choices[Math.floor(Math.random() * choices.length)]!;
}

export function buildLevelBoard(level: LevelDef): void {
  tilesEl.innerHTML = '';
  state.grid = emptyGrid();
  state.selected = null;

  const blockedSet = new Set(level.layout.blocked.map(([r, c]) => `${r},${c}`));
  const jellyMap = new Map(level.layout.jelly.map(([r, c, n]) => [`${r},${c}`, n]));
  const ingredientSet = new Set(level.layout.ingredients.map(([r, c]) => `${r},${c}`));
  const specialMap = new Map(
    level.layout.preSpecials.map(([r, c, t]) => [`${r},${c}`, t]),
  );

  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const key = `${r},${c}`;
      if (blockedSet.has(key)) continue;
      let color = pickColorAvoiding(r, c, state.grid, level.colors);
      const sp = specialMap.get(key) ?? null;
      const ing = ingredientSet.has(key) ? 'cherry' : null;
      const jelly = jellyMap.get(key) ?? 0;
      if (sp === 'color-bomb') color = -1;
      const tile = createTile({
        color,
        row: r,
        col: c,
        special: sp,
        ingredient: ing,
        jellyLayers: jelly,
      });
      tile.el.style.transition = 'none';
      tilesEl.appendChild(tile.el);
      state.grid[r]![c] = tile;
      setTilePos(tile);
    }
  }

  requestAnimationFrame(() => {
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const t = state.grid[r]![c];
        if (t) t.el.style.transition = '';
      }
    }
  });
}

export function repositionAll(): void {
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const t = state.grid[r]?.[c];
      if (t) t.el.style.transform = posTransform(t.row, t.col);
    }
  }
}

export function swapTilesInGrid(r1: number, c1: number, r2: number, c2: number): void {
  const a = state.grid[r1]![c1]!;
  const b = state.grid[r2]![c2]!;
  state.grid[r1]![c1] = b;
  state.grid[r2]![c2] = a;
  a.row = r2;
  a.col = c2;
  b.row = r1;
  b.col = c1;
  setTilePos(a);
  setTilePos(b);
}

export function setSelectedCell(row: number | null, col: number | null): void {
  if (state.selected) {
    const prev = state.grid[state.selected.row]?.[state.selected.col];
    if (prev) prev.el.classList.remove('tile--selected');
  }
  if (row === null || col === null) {
    state.selected = null;
    return;
  }
  const next = state.grid[row]?.[col];
  if (!next) {
    state.selected = null;
    return;
  }
  next.el.classList.add('tile--selected');
  state.selected = { row, col };
}

export function cellAtPoint(clientX: number, clientY: number): { row: number; col: number } | null {
  const rect = tilesEl.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  if (x < 0 || y < 0 || x > rect.width || y > rect.height) return null;
  const step = tileStep();
  if (step <= 0) return null;
  const col = Math.min(SIZE - 1, Math.max(0, Math.floor(x / step)));
  const row = Math.min(SIZE - 1, Math.max(0, Math.floor(y / step)));
  return { row, col };
}

export function isAdjacent(r1: number, c1: number, r2: number, c2: number): boolean {
  return Math.abs(r1 - r2) + Math.abs(c1 - c2) === 1;
}
