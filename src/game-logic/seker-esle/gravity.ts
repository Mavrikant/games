// Gravity, refill, and ingredient drop-out detection.
// Also handles jelly layer decrement when matched tiles sit on jelly.

import { SIZE, type Tile, type LevelDef } from './types';
import { state, forEachTile } from './state';
import { createTile, posTransform, setTilePos, applyTileClasses, getTilesEl } from './board';
import { hasAnyMove } from './matcher';

export interface GravityResult {
  ingredientsCleared: number;
  jellyCleared: number;
}

let blockedSet = new Set<string>();

export function setActiveLevel(level: LevelDef): void {
  blockedSet = new Set(level.layout.blocked.map(([r, c]) => `${r},${c}`));
}

function isBlocked(r: number, c: number): boolean {
  return blockedSet.has(`${r},${c}`);
}

// Bottom-most non-blocked row for a column (where ingredients can drop out).
function bottomReachableRow(c: number): number {
  for (let r = SIZE - 1; r >= 0; r--) {
    if (!isBlocked(r, c)) return r;
  }
  return SIZE - 1;
}

// Decrement jelly under matched tiles. Call BEFORE actually removing them.
export function decrementJellyUnder(matched: Iterable<Tile>): number {
  let cleared = 0;
  for (const t of matched) {
    if (t.jellyLayers > 0) {
      t.jellyLayers -= 1;
      if (t.jellyLayers === 0) cleared += 1;
    }
  }
  return cleared;
}

// Remove matched tiles from grid + DOM. Ingredient tiles are NEVER matched
// (color -3 makes them skip the match algorithm) — they are harvested only
// when gravity drops them to the bottom row.
export function removeMatched(matched: Iterable<Tile>): GravityResult {
  for (const t of matched) {
    if (t.ingredient) continue; // safety: never remove ingredient via match
    state.grid[t.row]![t.col] = null;
    t.el.remove();
  }
  return { ingredientsCleared: 0, jellyCleared: 0 };
}

// Apply gravity: compact columns downward, ingredients fall like normal tiles,
// refill empty slots from above with new tiles starting offscreen.
// Ingredients that reach the bottom-most non-blocked row are automatically
// removed and counted as "collected" via a custom event.
export function applyGravityAndRefill(level: LevelDef): void {

  for (let c = 0; c < SIZE; c++) {
    let write = SIZE - 1;
    for (let r = SIZE - 1; r >= 0; r--) {
      if (isBlocked(r, c)) {
        // skip blocked; treat as wall — nothing falls through
        // Reset write below if needed: blocked cells act as floor
        // To keep it simple: anything below the blocked cell stays, anything
        // above will pack down to the blocked cell row+1.
        // We rebuild this column in two halves.
        while (write > r) {
          // already settled below; do nothing
          break;
        }
        continue;
      }
      const t = state.grid[r]![c];
      if (t) {
        if (write !== r) {
          state.grid[write]![c] = t;
          state.grid[r]![c] = null;
          t.row = write;
          setTilePos(t);
        }
        write -= 1;
      }
    }
    // Refill empties above
    let newRow = -1;
    for (let r = write; r >= 0; r--) {
      if (isBlocked(r, c)) continue;
      const color = Math.floor(Math.random() * level.colors);
      const tile = createTile({ color, row: r, col: c });
      tile.el.style.transform = posTransform(newRow, c);
      newRow -= 1;
      getTilesEl().appendChild(tile.el);
      state.grid[r]![c] = tile;
    }
  }
  // Harvest ingredients sitting at the bottom-most reachable row.
  let ingredientsHarvested = 0;
  for (let c = 0; c < SIZE; c++) {
    const bottom = bottomReachableRow(c);
    const tile = state.grid[bottom]?.[c];
    if (tile && tile.ingredient) {
      tile.el.classList.add('tile--matched');
      const el = tile.el;
      state.grid[bottom]![c] = null;
      window.setTimeout(() => el.remove(), 220);
      ingredientsHarvested += 1;
    }
  }
  requestAnimationFrame(() => {
    forEachTile((t) => setTilePos(t));
  });
  if (ingredientsHarvested > 0) {
    document.dispatchEvent(new CustomEvent('seker-ingredient-clear', { detail: ingredientsHarvested }));
  }
}

export function refreshAllClasses(): void {
  forEachTile((t) => applyTileClasses(t));
}

export function shuffleBoard(_level: LevelDef): void {
  for (let attempt = 0; attempt < 30; attempt++) {
    const tiles: Tile[] = [];
    forEachTile((t) => {
      if (t.color >= 0 && !t.special && !t.ingredient) tiles.push(t);
    });
    const colors = tiles.map((t) => t.color);
    for (let i = colors.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = colors[i]!;
      colors[i] = colors[j]!;
      colors[j] = tmp;
    }
    let idx = 0;
    for (const t of tiles) {
      t.color = colors[idx++]!;
      applyTileClasses(t);
    }
    if (hasAnyMove()) return;
  }
}
