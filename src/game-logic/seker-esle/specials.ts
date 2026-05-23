// Special candy detonation + 8-way special+special combinations.
// Pure tile-set arithmetic; visuals/audio fired by cascade.ts via callbacks.

import { SIZE, type Tile, type SpecialType } from './types';
import { state } from './state';

export interface DetonationResult {
  toClear: Set<Tile>;
  trail: { from: Tile; type: NonNullable<SpecialType> | 'combo'; affected: Tile[] }[];
}

function rowOf(r: number): Tile[] {
  const out: Tile[] = [];
  for (let c = 0; c < SIZE; c++) {
    const t = state.grid[r]?.[c];
    if (t) out.push(t);
  }
  return out;
}
function colOf(c: number): Tile[] {
  const out: Tile[] = [];
  for (let r = 0; r < SIZE; r++) {
    const t = state.grid[r]?.[c];
    if (t) out.push(t);
  }
  return out;
}
function box3x3(r: number, c: number): Tile[] {
  const out: Tile[] = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const t = state.grid[r + dr]?.[c + dc];
      if (t) out.push(t);
    }
  }
  return out;
}
function box5x5(r: number, c: number): Tile[] {
  const out: Tile[] = [];
  for (let dr = -2; dr <= 2; dr++) {
    for (let dc = -2; dc <= 2; dc++) {
      const t = state.grid[r + dr]?.[c + dc];
      if (t) out.push(t);
    }
  }
  return out;
}
function allOfColor(color: number): Tile[] {
  const out: Tile[] = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const t = state.grid[r]?.[c];
      if (t && t.color === color) out.push(t);
    }
  }
  return out;
}
function allTiles(): Tile[] {
  const out: Tile[] = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const t = state.grid[r]?.[c];
      if (t) out.push(t);
    }
  }
  return out;
}

// Detonate a single special. Returns the tiles directly cleared by THIS detonation
// (chained detonations of nested specials handled by caller's queue).
export function detonateSingle(t: Tile): Tile[] {
  if (t.special === 'striped-h') return rowOf(t.row);
  if (t.special === 'striped-v') return colOf(t.col);
  if (t.special === 'wrapped') return box3x3(t.row, t.col);
  if (t.special === 'color-bomb') {
    // Detonated alone (rare path: triggered by chain). Clears most common color.
    const counts = new Map<number, number>();
    for (const x of allTiles()) {
      if (x.color < 0) continue;
      counts.set(x.color, (counts.get(x.color) ?? 0) + 1);
    }
    let best = -1; let bestN = 0;
    for (const [c, n] of counts) if (n > bestN) { best = c; bestN = n; }
    if (best < 0) return [t];
    return [t, ...allOfColor(best)];
  }
  return [t];
}

// Combo when user swaps two specials. Returns affected tiles AND any "transforms"
// (e.g. colorbomb+striped turns all of one color into striped).
export interface ComboOutcome {
  affected: Tile[];
  transforms?: { tile: Tile; toSpecial: NonNullable<SpecialType> }[];
  triggerColor?: number;          // for color-bomb sweeps after transform
}

export function detonateCombo(a: Tile, b: Tile): ComboOutcome {
  const aType = a.special;
  const bType = b.special;
  const aColor = a.color;
  const bColor = b.color;

  const isStriped = (s: SpecialType) => s === 'striped-h' || s === 'striped-v';

  // colorbomb + colorbomb → clear board
  if (aType === 'color-bomb' && bType === 'color-bomb') {
    return { affected: allTiles() };
  }

  // colorbomb + striped → convert all of the other's color to striped, then sweep
  if (aType === 'color-bomb' && isStriped(bType)) {
    const transforms = allOfColor(bColor).map((t) => ({
      tile: t,
      toSpecial: (Math.random() < 0.5 ? 'striped-h' : 'striped-v') as NonNullable<SpecialType>,
    }));
    return { affected: [a, b], transforms, triggerColor: bColor };
  }
  if (bType === 'color-bomb' && isStriped(aType)) {
    const transforms = allOfColor(aColor).map((t) => ({
      tile: t,
      toSpecial: (Math.random() < 0.5 ? 'striped-h' : 'striped-v') as NonNullable<SpecialType>,
    }));
    return { affected: [a, b], transforms, triggerColor: aColor };
  }

  // colorbomb + wrapped → convert all of the other's color to wrapped, then sweep
  if (aType === 'color-bomb' && bType === 'wrapped') {
    const transforms = allOfColor(bColor).map((t) => ({ tile: t, toSpecial: 'wrapped' as const }));
    return { affected: [a, b], transforms, triggerColor: bColor };
  }
  if (bType === 'color-bomb' && aType === 'wrapped') {
    const transforms = allOfColor(aColor).map((t) => ({ tile: t, toSpecial: 'wrapped' as const }));
    return { affected: [a, b], transforms, triggerColor: aColor };
  }

  // colorbomb + normal → clear all of normal's color
  if (aType === 'color-bomb') {
    return { affected: [a, ...allOfColor(bColor)] };
  }
  if (bType === 'color-bomb') {
    return { affected: [b, ...allOfColor(aColor)] };
  }

  // striped + striped → cross (one row + one col centered on b)
  if (isStriped(aType) && isStriped(bType)) {
    const center = b;
    return { affected: dedup([...rowOf(center.row), ...colOf(center.col)]) };
  }

  // striped + wrapped → thick cross (3 rows + 3 cols centered on the wrapped)
  if (isStriped(aType) && bType === 'wrapped') {
    return { affected: thickCross(b.row, b.col) };
  }
  if (isStriped(bType) && aType === 'wrapped') {
    return { affected: thickCross(a.row, a.col) };
  }

  // wrapped + wrapped → 5x5 blast, twice
  if (aType === 'wrapped' && bType === 'wrapped') {
    return { affected: dedup([...box5x5(b.row, b.col), ...box3x3(a.row, a.col)]) };
  }

  // Default: detonate each individually
  return { affected: dedup([...detonateSingle(a), ...detonateSingle(b)]) };
}

function thickCross(r: number, c: number): Tile[] {
  const set = new Set<Tile>();
  for (let dr = -1; dr <= 1; dr++) {
    const rr = r + dr;
    if (rr < 0 || rr >= SIZE) continue;
    for (const t of rowOf(rr)) set.add(t);
  }
  for (let dc = -1; dc <= 1; dc++) {
    const cc = c + dc;
    if (cc < 0 || cc >= SIZE) continue;
    for (const t of colOf(cc)) set.add(t);
  }
  return [...set];
}

function dedup(list: Tile[]): Tile[] {
  const set = new Set(list);
  return [...set];
}

// Helper: when a swap involves at least one special, compute the full outcome
// including triggering nested specials caught in the blast.
export function resolveSwapWithSpecial(a: Tile, b: Tile): {
  initial: Tile[];
  transforms: { tile: Tile; toSpecial: NonNullable<SpecialType> }[];
  triggerColor: number | null;
} {
  if (a.special && b.special) {
    const combo = detonateCombo(a, b);
    return {
      initial: combo.affected,
      transforms: combo.transforms ?? [],
      triggerColor: combo.triggerColor ?? null,
    };
  }
  if (a.special === 'color-bomb') {
    return { initial: [a, ...allOfColor(b.color)], transforms: [], triggerColor: null };
  }
  if (b.special === 'color-bomb') {
    return { initial: [b, ...allOfColor(a.color)], transforms: [], triggerColor: null };
  }
  // single special: detonate it, opponent also clears if matched (no-op here since
  // we're entering via a swap that should normally match — caller handles normal path)
  const initial: Tile[] = [];
  if (a.special) initial.push(...detonateSingle(a));
  if (b.special) initial.push(...detonateSingle(b));
  if (initial.length === 0) initial.push(a, b);
  return { initial: dedup(initial), transforms: [], triggerColor: null };
}
