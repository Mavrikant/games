// Booster inventory + use-mode state machine.
// 4 boosters: hammer (kill 1 tile), swap (swap any 2 non-adjacent),
// colorBombStart (place a color bomb at level start), plus5Moves (+5 moves).

import type { BoosterId, LevelDef } from './types';
import { state, spendBooster, persistProfile, setPhase } from './state';
import {
  applyTileClasses,
  swapTilesInGrid,
  getBoardEl,
} from './board';
import { setBoosterClickHandler, hapticHit } from './input';
import { sfxHammer, sfxButton } from './audio';
import { applyGravityAndRefill } from './gravity';
import { startSwap } from './cascade';

let pendingFirstSwap: { row: number; col: number } | null = null;
let onChange: (() => void) | null = null;
let currentLevel: LevelDef | null = null;

export function bindBoosters(opts: { onChange: () => void }): void {
  onChange = opts.onChange;
  setBoosterClickHandler(onTileClick);
}

export function setBoosterLevel(level: LevelDef): void {
  currentLevel = level;
}

export function isBoosterActive(): boolean {
  return state.boosterMode !== 'idle';
}

export function activateBooster(id: BoosterId): boolean {
  if (state.phase !== 'idle') return false;
  if ((state.profile.boosters[id] ?? 0) <= 0) return false;
  sfxButton();
  if (id === 'hammer') {
    state.boosterMode = 'hammer-target';
    getBoardEl().classList.add('board--booster-active');
    return true;
  }
  if (id === 'swap') {
    state.boosterMode = 'swap-first';
    getBoardEl().classList.add('board--booster-active');
    return true;
  }
  if (id === 'plus5Moves') {
    if (spendBooster('plus5Moves')) {
      state.movesLeft += 5;
      document.dispatchEvent(new CustomEvent('seker-hud-update'));
      persistProfile();
      onChange?.();
    }
    return true;
  }
  if (id === 'colorBombStart') {
    // Place a color bomb at a random tile of the current board
    const candidates: { row: number; col: number }[] = [];
    for (let r = 0; r < state.grid.length; r++) {
      for (let c = 0; c < (state.grid[r]?.length ?? 0); c++) {
        const t = state.grid[r]?.[c];
        if (t && !t.special && !t.ingredient) candidates.push({ row: r, col: c });
      }
    }
    if (candidates.length === 0) return false;
    const pick = candidates[Math.floor(Math.random() * candidates.length)]!;
    const tile = state.grid[pick.row]?.[pick.col];
    if (!tile) return false;
    if (spendBooster('colorBombStart')) {
      tile.special = 'color-bomb';
      tile.color = -1;
      applyTileClasses(tile);
      persistProfile();
      onChange?.();
    }
    return true;
  }
  return false;
}

export function cancelBooster(): void {
  state.boosterMode = 'idle';
  pendingFirstSwap = null;
  getBoardEl().classList.remove('board--booster-active');
}

function onTileClick(row: number, col: number): boolean {
  if (state.boosterMode === 'idle') return false;
  const tile = state.grid[row]?.[col];
  if (!tile) return true;
  if (state.boosterMode === 'hammer-target') {
    if (!spendBooster('hammer')) {
      cancelBooster();
      return true;
    }
    sfxHammer();
    hapticHit();
    tile.el.classList.add('tile--matched');
    state.grid[row]![col] = null;
    window.setTimeout(() => tile.el.remove(), 220);
    window.setTimeout(() => {
      if (currentLevel) applyGravityAndRefill(currentLevel);
    }, 260);
    cancelBooster();
    setPhase('idle');
    persistProfile();
    onChange?.();
    return true;
  }
  if (state.boosterMode === 'swap-first') {
    pendingFirstSwap = { row, col };
    state.boosterMode = 'swap-second';
    tile.el.classList.add('tile--selected');
    return true;
  }
  if (state.boosterMode === 'swap-second') {
    if (!pendingFirstSwap) {
      cancelBooster();
      return true;
    }
    if (pendingFirstSwap.row === row && pendingFirstSwap.col === col) {
      cancelBooster();
      return true;
    }
    if (!spendBooster('swap')) {
      cancelBooster();
      return true;
    }
    const first = pendingFirstSwap;
    pendingFirstSwap = null;
    swapTilesInGrid(first.row, first.col, row, col);
    sfxHammer();
    hapticHit();
    cancelBooster();
    // Trigger a cascade run via normal swap path
    startSwap(first.row, first.col, row, col);
    persistProfile();
    onChange?.();
    return true;
  }
  return false;
}
