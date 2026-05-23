// Cascade loop, combo banner, score popups, screen shake.
// Coordinates matcher → specials → gravity. Async-safe via gen-token.

import type { Tile, SpecialSpawn, LevelDef } from './types';
import { state, persistProfile, recordLevelResult, setPhase, addBooster } from './state';
import { analyzeMatches } from './matcher';
import { detonateSingle, resolveSwapWithSpecial } from './specials';
import {
  removeMatched,
  applyGravityAndRefill,
  decrementJellyUnder,
  setActiveLevel,
  refreshAllClasses,
  shuffleBoard,
} from './gravity';
import { hasAnyMove } from './matcher';
import {
  applyTileClasses,
  centerXY,
  getBoardEl,
  swapTilesInGrid,
  setSelectedCell,
} from './board';
import {
  matchBurst,
  stripedFireSparks,
  wrappedExplosion,
  colorBombClear,
  cascadeConfetti,
  levelCompleteCannon,
} from './particles';
import {
  sfxMatch,
  sfxSwap,
  sfxStripedFire,
  sfxWrappedExplode,
  sfxColorBomb,
  sfxLevelComplete,
  sfxLevelFail,
  sfxComboBanner,
  sfxSpecialSpawn,
} from './audio';
import {
  bumpMission,
  isMissionComplete,
  getMissionProgress,
  consumeMatchedForMission,
} from './missions';
import { recordAchievementEvent } from './achievements';

let activeLevel: LevelDef | null = null;
let bannerEl: HTMLElement | null = null;
let comboBannerEl: HTMLElement | null = null;
let popupsLayer: HTMLElement | null = null;

const CANDY_COLORS = ['#ff3b6b', '#ffd400', '#25d366', '#29b6ff', '#b14bff', '#ff8a00', '#ff66ce'];

export function bindCascadeUi(opts: {
  banner: HTMLElement;
  comboBanner: HTMLElement;
  popups: HTMLElement;
}): void {
  bannerEl = opts.banner;
  comboBannerEl = opts.comboBanner;
  popupsLayer = opts.popups;
}

export function setLevel(level: LevelDef): void {
  activeLevel = level;
  setActiveLevel(level);
}

export function startSwap(r1: number, c1: number, r2: number, c2: number): void {
  if (!activeLevel) return;
  setPhase('animating');
  setSelectedCell(null, null);
  swapTilesInGrid(r1, c1, r2, c2);
  sfxSwap();
  const myGen = state.gen.current();

  window.setTimeout(() => {
    if (!state.gen.isCurrent(myGen)) return;
    const a = state.grid[r2]?.[c2] ?? null;
    const b = state.grid[r1]?.[c1] ?? null;
    if (!a || !b) {
      setPhase('idle');
      return;
    }
    const hasSpecial = (a.special && a.special !== null) || (b.special && b.special !== null);
    let initialClear: Tile[] = [];
    if (hasSpecial) {
      const out = resolveSwapWithSpecial(a, b);
      initialClear = out.initial;
      for (const tr of out.transforms) {
        tr.tile.special = tr.toSpecial;
        applyTileClasses(tr.tile);
      }
    }
    const analysis = analyzeMatches({ r1, c1, r2, c2 });
    if (initialClear.length === 0 && analysis.matched.size === 0) {
      swapTilesInGrid(r1, c1, r2, c2);
      state.comboStreak = 0;
      window.setTimeout(() => {
        if (!state.gen.isCurrent(myGen)) return;
        setPhase('idle');
      }, 220);
      return;
    }
    state.profile.lastPlayDate = state.profile.lastPlayDate || todayKey();
    state.movesLeft = Math.max(0, state.movesLeft - 1);
    document.dispatchEvent(new CustomEvent('seker-hud-update'));
    state.comboStreak += 1;
    if (state.comboStreak > state.profile.stats.longestComboStreak) {
      state.profile.stats.longestComboStreak = state.comboStreak;
    }
    if (state.comboStreak >= 3) {
      showComboStreak(state.comboStreak);
    }
    state.cascadeDepth = 0;
    if (initialClear.length > 0) {
      processSpecialDetonation(initialClear, myGen, analysis.spawns);
    } else {
      processMatches(analysis.matched, analysis.spawns, analysis.groupSizes, myGen);
    }
  }, 200);
}

function processSpecialDetonation(initial: Tile[], myGen: number, pendingSpawns: SpecialSpawn[]): void {
  const queue: Tile[] = [...new Set(initial)];
  const visited = new Set<Tile>();
  const toClear = new Set<Tile>();

  while (queue.length) {
    const t = queue.shift()!;
    if (!t || visited.has(t)) continue;
    visited.add(t);
    if (t.special) {
      playSpecialEffect(t);
      const affected = detonateSingle(t);
      for (const x of affected) {
        if (!visited.has(x)) queue.push(x);
        toClear.add(x);
      }
    } else {
      toClear.add(t);
    }
  }

  for (const t of toClear) {
    t.el.classList.add('tile--matched');
    const xy = centerXY(t.row, t.col);
    const color = t.color >= 0 ? CANDY_COLORS[t.color]! : '#ffffff';
    matchBurst(xy.x, xy.y, color);
  }
  sfxMatch(toClear.size, 1);
  bumpMission(toClear, []);
  recordAchievementEvent({ kind: 'match', size: toClear.size });

  const jellyCleared = decrementJellyUnder(toClear);
  if (jellyCleared > 0) document.dispatchEvent(new CustomEvent('seker-jelly-clear', { detail: jellyCleared }));

  spawnScorePopups(toClear);
  state.score += scoreForGroup(toClear.size) * 2; // bonus for special trigger
  document.dispatchEvent(new CustomEvent('seker-hud-update'));

  window.setTimeout(() => {
    if (!state.gen.isCurrent(myGen)) return;
    const removalResult = removeMatched(toClear);
    if (removalResult.ingredientsCleared > 0) {
      document.dispatchEvent(new CustomEvent('seker-ingredient-clear', {
        detail: removalResult.ingredientsCleared,
      }));
    }
    spawnPendingSpecials(pendingSpawns);
    applyGravityAndRefill(activeLevel!);
    refreshAllClasses();
    window.setTimeout(() => {
      if (!state.gen.isCurrent(myGen)) return;
      cascadeStep(myGen);
    }, 280);
  }, 220);
}

function processMatches(matched: Set<Tile>, spawns: SpecialSpawn[], groupSizes: number[], myGen: number): void {
  state.cascadeDepth += 1;
  state.profile.stats.totalCascades += 1;
  if (state.cascadeDepth > state.profile.stats.bestCascade) {
    state.profile.stats.bestCascade = state.cascadeDepth;
  }
  recordAchievementEvent({ kind: 'cascade', depth: state.cascadeDepth });

  let gained = 0;
  for (const n of groupSizes) gained += scoreForGroup(n);
  const multiplier = 1 + (state.cascadeDepth - 1) * 0.5;
  gained = Math.round(gained * multiplier);
  state.score += gained;
  state.profile.stats.totalMatches += matched.size;
  recordAchievementEvent({ kind: 'match', size: matched.size });

  const toExclude = new Set<Tile>();
  for (const sp of spawns) {
    const tile = state.grid[sp.row]?.[sp.col];
    if (tile) toExclude.add(tile);
  }

  // Visual/audio per match
  let visEmitted = 0;
  for (const t of matched) {
    if (toExclude.has(t)) continue;
    t.el.classList.add('tile--matched');
    const xy = centerXY(t.row, t.col);
    const color = t.color >= 0 ? CANDY_COLORS[t.color]! : '#ffffff';
    if (visEmitted < 12) matchBurst(xy.x, xy.y, color);
    visEmitted++;
  }
  sfxMatch(maxGroupSize(groupSizes), state.cascadeDepth);
  spawnScorePopups(matched, gained);
  bumpMission(matched, []);
  consumeMatchedForMission(matched);

  if (state.cascadeDepth >= 2) {
    showCascadeBanner(state.cascadeDepth);
    cascadeConfetti(state.cascadeDepth);
    sfxComboBanner(state.cascadeDepth);
  }
  if (state.cascadeDepth >= 3) {
    const board = getBoardEl();
    board.classList.remove('board--shake');
    void board.offsetWidth;
    board.classList.add('board--shake');
  }

  document.dispatchEvent(new CustomEvent('seker-hud-update'));

  window.setTimeout(() => {
    if (!state.gen.isCurrent(myGen)) return;
    const jellyCleared = decrementJellyUnder(matched);
    if (jellyCleared > 0) document.dispatchEvent(new CustomEvent('seker-jelly-clear', { detail: jellyCleared }));
    const toRemove = new Set<Tile>();
    for (const t of matched) if (!toExclude.has(t)) toRemove.add(t);
    const removalResult = removeMatched(toRemove);
    if (removalResult.ingredientsCleared > 0) {
      document.dispatchEvent(new CustomEvent('seker-ingredient-clear', {
        detail: removalResult.ingredientsCleared,
      }));
    }
    spawnPendingSpecials(spawns);
    applyGravityAndRefill(activeLevel!);
    refreshAllClasses();
    window.setTimeout(() => {
      if (!state.gen.isCurrent(myGen)) return;
      cascadeStep(myGen);
    }, 260);
  }, 220);
}

function cascadeStep(myGen: number): void {
  const analysis = analyzeMatches();
  if (analysis.matched.size > 0) {
    processMatches(analysis.matched, analysis.spawns, analysis.groupSizes, myGen);
    return;
  }
  finishMove(myGen);
}

function finishMove(myGen: number): void {
  if (!state.gen.isCurrent(myGen)) return;
  if (!activeLevel) return;
  if (isMissionComplete()) {
    onLevelComplete();
    return;
  }
  if (state.movesLeft <= 0) {
    onLevelFailed();
    return;
  }
  if (!hasAnyMove()) shuffleBoard(activeLevel);
  setPhase('idle');
}

function maxGroupSize(sizes: number[]): number {
  let m = 3;
  for (const s of sizes) if (s > m) m = s;
  return m;
}

function scoreForGroup(n: number): number {
  if (n <= 3) return 30;
  if (n === 4) return 60;
  if (n === 5) return 120;
  return 200;
}

function spawnPendingSpecials(spawns: SpecialSpawn[]): void {
  for (const sp of spawns) {
    const tile = state.grid[sp.row]?.[sp.col];
    if (!tile) continue;
    tile.special = sp.type;
    if (sp.type === 'color-bomb') tile.color = -1;
    applyTileClasses(tile);
    state.profile.stats.specialsCreated += 1;
    recordAchievementEvent({ kind: 'special-created', type: sp.type });
    const xy = centerXY(sp.row, sp.col);
    const color = sp.color >= 0 ? CANDY_COLORS[sp.color]! : '#ffffff';
    if (sp.type === 'striped-h' || sp.type === 'striped-v') {
      sfxSpecialSpawn();
      stripedFireSparks(xy.x, xy.y, color, sp.type === 'striped-h' ? 'h' : 'v');
    } else if (sp.type === 'wrapped') {
      sfxSpecialSpawn();
      wrappedExplosion(xy.x, xy.y, color);
    } else if (sp.type === 'color-bomb') {
      sfxColorBomb();
      colorBombClear(xy.x, xy.y);
    }
  }
}

function playSpecialEffect(t: Tile): void {
  const xy = centerXY(t.row, t.col);
  const color = t.color >= 0 ? CANDY_COLORS[t.color]! : '#ffffff';
  if (t.special === 'striped-h') {
    sfxStripedFire();
    stripedFireSparks(xy.x, xy.y, color, 'h');
  } else if (t.special === 'striped-v') {
    sfxStripedFire();
    stripedFireSparks(xy.x, xy.y, color, 'v');
  } else if (t.special === 'wrapped') {
    sfxWrappedExplode();
    wrappedExplosion(xy.x, xy.y, color);
  } else if (t.special === 'color-bomb') {
    sfxColorBomb();
    colorBombClear(xy.x, xy.y);
  }
}

function spawnScorePopups(tiles: Iterable<Tile>, totalScore?: number): void {
  if (!popupsLayer) return;
  const tilesArr = [...tiles];
  if (tilesArr.length === 0) return;
  let avgR = 0; let avgC = 0;
  for (const t of tilesArr) { avgR += t.row; avgC += t.col; }
  avgR /= tilesArr.length; avgC /= tilesArr.length;
  const xy = centerXY(avgR, avgC);
  const node = document.createElement('div');
  node.className = 'score-popup';
  const val = totalScore ?? scoreForGroup(tilesArr.length);
  node.textContent = `+${val}`;
  node.style.left = `${xy.x}px`;
  node.style.top = `${xy.y}px`;
  popupsLayer.appendChild(node);
  window.setTimeout(() => node.remove(), 900);
}

const CASCADE_LABELS: Record<number, string> = {
  2: 'Süper!',
  3: 'Muhteşem!',
  4: 'İnanılmaz!',
  5: 'Efsanevi!',
  6: 'Tanrısal!',
};

function showCascadeBanner(depth: number): void {
  if (!bannerEl) return;
  const label = CASCADE_LABELS[depth] ?? CASCADE_LABELS[6]!;
  bannerEl.textContent = label;
  bannerEl.classList.remove('combo-banner--show');
  void bannerEl.offsetWidth;
  bannerEl.classList.add('combo-banner--show');
}

function showComboStreak(streak: number): void {
  if (!comboBannerEl) return;
  let label = `x${streak} Combo`;
  if (streak >= 12) label = `x${streak} ULTRA!`;
  else if (streak >= 8) label = `x${streak} Mega Combo`;
  comboBannerEl.textContent = label;
  comboBannerEl.classList.remove('combo-streak--show');
  void comboBannerEl.offsetWidth;
  comboBannerEl.classList.add('combo-streak--show');
}

function onLevelComplete(): void {
  if (!activeLevel) return;
  setPhase('levelComplete');
  const stars = starsForScore(activeLevel, state.score);
  const { starsGained } = recordLevelResult(activeLevel.id, state.score, stars);
  recordAchievementEvent({ kind: 'level-complete', stars, level: activeLevel.id });
  if (starsGained > 0) {
    recordAchievementEvent({ kind: 'star-earned', total: state.profile.totalStars });
  }
  if (activeLevel.id % 5 === 0) addBooster('plus5Moves', 1);
  sfxLevelComplete();
  levelCompleteCannon();
  persistProfile();
  document.dispatchEvent(new CustomEvent('seker-level-complete', { detail: { stars, score: state.score } }));
}

function onLevelFailed(): void {
  if (!activeLevel) return;
  setPhase('levelFailed');
  sfxLevelFail();
  document.dispatchEvent(new CustomEvent('seker-level-failed'));
}

function starsForScore(level: LevelDef, score: number): 0 | 1 | 2 | 3 {
  const [a, b, c] = level.starThresholds;
  if (score >= c) return 3;
  if (score >= b) return 2;
  if (score >= a) return 1;
  return 0;
}

function todayKey(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
}

export function getMissionStatus() {
  return getMissionProgress();
}

export function tickComboTimeout(): void {
  if (state.lastValidSwapAt && performance.now() - state.lastValidSwapAt > 800) {
    state.comboStreak = 0;
  }
}

// Re-export helpers used by HUD
export { CANDY_COLORS };
