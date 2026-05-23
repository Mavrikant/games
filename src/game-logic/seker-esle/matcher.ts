// Match detection + special pattern recognition.
// Returns matched tile set and the special candies to spawn from each match.

import { SIZE, type Tile, type SpecialSpawn } from './types';
import { state } from './state';

export interface MatchAnalysis {
  matched: Set<Tile>;
  spawns: SpecialSpawn[];
  groupSizes: number[];
}

interface Run {
  tiles: Tile[];
  axis: 'h' | 'v';
  color: number;
}

function collectRuns(): Run[] {
  const runs: Run[] = [];
  // Horizontal
  for (let r = 0; r < SIZE; r++) {
    let start = 0;
    let lastColor = -2;
    for (let c = 0; c <= SIZE; c++) {
      const t = c < SIZE ? state.grid[r]![c] : null;
      const col = t ? t.color : -2;
      if (col !== lastColor || col === -2) {
        const len = c - start;
        if (len >= 3 && lastColor >= 0) {
          const tiles: Tile[] = [];
          for (let k = start; k < c; k++) {
            const it = state.grid[r]![k];
            if (it) tiles.push(it);
          }
          runs.push({ tiles, axis: 'h', color: lastColor });
        }
        start = c;
        lastColor = col;
      }
    }
  }
  // Vertical
  for (let c = 0; c < SIZE; c++) {
    let start = 0;
    let lastColor = -2;
    for (let r = 0; r <= SIZE; r++) {
      const t = r < SIZE ? state.grid[r]![c] : null;
      const col = t ? t.color : -2;
      if (col !== lastColor || col === -2) {
        const len = r - start;
        if (len >= 3 && lastColor >= 0) {
          const tiles: Tile[] = [];
          for (let k = start; k < r; k++) {
            const it = state.grid[k]![c];
            if (it) tiles.push(it);
          }
          runs.push({ tiles, axis: 'v', color: lastColor });
        }
        start = r;
        lastColor = col;
      }
    }
  }
  return runs;
}

export function analyzeMatches(swapOrigin?: {
  r1: number; c1: number; r2: number; c2: number;
} | null): MatchAnalysis {
  const runs = collectRuns();
  const matched = new Set<Tile>();
  for (const r of runs) for (const t of r.tiles) matched.add(t);

  const sizes = runs.map((r) => r.tiles.length);
  if (matched.size === 0) return { matched, spawns: [], groupSizes: sizes };

  // Special spawn detection.
  // Group runs by shared tiles to detect L/T intersections.
  // For simplicity: for each cell that belongs to BOTH a horizontal and vertical run,
  // produce a single wrapped spawn at that intersection.
  const tileToRuns = new Map<Tile, Run[]>();
  for (const run of runs) {
    for (const t of run.tiles) {
      const arr = tileToRuns.get(t) ?? [];
      arr.push(run);
      tileToRuns.set(t, arr);
    }
  }

  const spawns: SpecialSpawn[] = [];
  const usedRuns = new Set<Run>();

  // 1) Match-5+ → color bomb. Single longest run >= 5.
  const sortedByLen = [...runs].sort((a, b) => b.tiles.length - a.tiles.length);
  for (const r of sortedByLen) {
    if (r.tiles.length >= 5 && !usedRuns.has(r)) {
      const target = pickSpawnTile(r, swapOrigin) ?? r.tiles[Math.floor(r.tiles.length / 2)]!;
      spawns.push({ row: target.row, col: target.col, type: 'color-bomb', color: -1 });
      usedRuns.add(r);
    }
  }

  // 2) L/T intersections → wrapped. Any tile that's in both an unused H and an unused V run (each length 3).
  for (const [tile, list] of tileToRuns) {
    const h = list.find((r) => r.axis === 'h' && r.tiles.length === 3 && !usedRuns.has(r));
    const v = list.find((r) => r.axis === 'v' && r.tiles.length === 3 && !usedRuns.has(r));
    if (h && v) {
      spawns.push({ row: tile.row, col: tile.col, type: 'wrapped', color: tile.color });
      usedRuns.add(h);
      usedRuns.add(v);
    }
  }

  // 3) Match-4 → striped (h or v).
  for (const r of runs) {
    if (usedRuns.has(r)) continue;
    if (r.tiles.length === 4) {
      const target = pickSpawnTile(r, swapOrigin) ?? r.tiles[1]!;
      spawns.push({
        row: target.row,
        col: target.col,
        type: r.axis === 'h' ? 'striped-v' : 'striped-h',
        color: r.color,
      });
      usedRuns.add(r);
    }
  }

  return { matched, spawns, groupSizes: sizes };
}

function pickSpawnTile(
  run: Run,
  swapOrigin: { r1: number; c1: number; r2: number; c2: number } | null | undefined,
): Tile | null {
  if (!swapOrigin) return null;
  for (const t of run.tiles) {
    if ((t.row === swapOrigin.r1 && t.col === swapOrigin.c1) ||
        (t.row === swapOrigin.r2 && t.col === swapOrigin.c2)) {
      return t;
    }
  }
  return null;
}

export function trySwapProducesMatch(r1: number, c1: number, r2: number, c2: number): boolean {
  const a = state.grid[r1]?.[c1];
  const b = state.grid[r2]?.[c2];
  if (!a || !b) return false;
  // color-bomb always produces a match if swapped with anything
  if (a.special === 'color-bomb' || b.special === 'color-bomb') return true;
  const ac = a.color;
  const bc = b.color;
  a.color = bc; b.color = ac;
  const ok = analyzeMatches().matched.size > 0;
  a.color = ac; b.color = bc;
  return ok;
}

export function hasAnyMove(): boolean {
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const here = state.grid[r]?.[c];
      if (!here) continue;
      if (here.special === 'color-bomb') return true;
      if (c + 1 < SIZE && trySwapProducesMatch(r, c, r, c + 1)) return true;
      if (r + 1 < SIZE && trySwapProducesMatch(r, c, r + 1, c)) return true;
    }
  }
  return false;
}

export function findHintSwap(): { r1: number; c1: number; r2: number; c2: number } | null {
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (c + 1 < SIZE && trySwapProducesMatch(r, c, r, c + 1)) {
        return { r1: r, c1: c, r2: r, c2: c + 1 };
      }
      if (r + 1 < SIZE && trySwapProducesMatch(r, c, r + 1, c)) {
        return { r1: r, c1: c, r2: r + 1, c2: c };
      }
    }
  }
  return null;
}
