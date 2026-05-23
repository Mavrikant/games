// Game state singleton + persistence with v1 → v2 migration.
//
// LEGACY keys preserved (never deleted): seker-esle.level, seker-esle.best.
// NEW key (single source of truth): seker-esle.profile.v2.
// DAILY keys (sparse): seker-esle.daily.<YYYY-MM-DD>.
//
// Write frequency: only on level-complete, achievement-unlock, settings-
// change, daily-complete, comeback-claim. Never per swap.

import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken, type GenToken } from '@shared/gen-token';
import type {
  Phase,
  Grid,
  Tile,
  Profile,
  BoosterMode,
  SwapCoord,
  LevelProgress,
  BoosterInventory,
  DailySolve,
  UserSettings,
} from './types';

const KEY_PROFILE = 'seker-esle.profile.v2';
const KEY_LEGACY_LEVEL = 'seker-esle.level';
const KEY_LEGACY_BEST = 'seker-esle.best';
const DAILY_PREFIX = 'seker-esle.daily.';

const DEFAULT_BOOSTERS: BoosterInventory = {
  hammer: 1,
  swap: 1,
  colorBombStart: 0,
  plus5Moves: 1,
};

const DEFAULT_SETTINGS: UserSettings = {
  sound: true,
  vibrate: true,
  reducedMotion: false,
};

export interface RuntimeState {
  phase: Phase;
  grid: Grid;
  level: number;
  score: number;
  movesLeft: number;
  cascadeDepth: number;
  comboStreak: number;
  lastValidSwapAt: number;
  selected: SwapCoord | null;
  nextTileId: number;
  boosterMode: BoosterMode;
  boosterTempSwap: SwapCoord | null;
  isDailyChallenge: boolean;
  dailyKey: string;
  profile: Profile;
  gen: GenToken;
}

export const state: RuntimeState = {
  phase: 'boot',
  grid: [],
  level: 1,
  score: 0,
  movesLeft: 0,
  cascadeDepth: 0,
  comboStreak: 0,
  lastValidSwapAt: 0,
  selected: null,
  nextTileId: 1,
  boosterMode: 'idle',
  boosterTempSwap: null,
  isDailyChallenge: false,
  dailyKey: '',
  profile: emptyProfile(),
  gen: createGenToken(),
};

function emptyProfile(): Profile {
  return {
    schemaVersion: 2,
    currentLevel: 1,
    bestLevel: 1,
    totalStars: 0,
    levels: {},
    boosters: { ...DEFAULT_BOOSTERS },
    achievements: [],
    lastPlayDate: '',
    streak: 0,
    longestStreak: 0,
    dailyCompleted: {},
    tutorialDone: false,
    settings: { ...DEFAULT_SETTINGS },
    stats: {
      totalMatches: 0,
      totalCascades: 0,
      bestCascade: 0,
      specialsCreated: 0,
      bestLevelStars: 0,
      longestComboStreak: 0,
    },
  };
}

export function loadProfile(): Profile {
  const raw = safeRead<Profile | null>(KEY_PROFILE, null);
  if (raw && raw.schemaVersion === 2) {
    return mergeWithDefaults(raw);
  }
  const legacyLevel = Math.max(1, safeRead<number>(KEY_LEGACY_LEVEL, 1));
  const legacyBest = Math.max(legacyLevel, safeRead<number>(KEY_LEGACY_BEST, 1));
  const fresh = emptyProfile();
  fresh.currentLevel = legacyLevel;
  fresh.bestLevel = legacyBest;
  return fresh;
}

function mergeWithDefaults(p: Profile): Profile {
  return {
    ...emptyProfile(),
    ...p,
    boosters: { ...DEFAULT_BOOSTERS, ...(p.boosters || {}) },
    settings: { ...DEFAULT_SETTINGS, ...(p.settings || {}) },
    levels: p.levels || {},
    achievements: p.achievements || [],
    dailyCompleted: p.dailyCompleted || {},
    stats: { ...emptyProfile().stats, ...(p.stats || {}) },
  };
}

export function persistProfile(): void {
  safeWrite(KEY_PROFILE, state.profile);
  safeWrite(KEY_LEGACY_LEVEL, state.profile.currentLevel);
  safeWrite(KEY_LEGACY_BEST, state.profile.bestLevel);
}

export function readDaily(key: string): DailySolve | null {
  return safeRead<DailySolve | null>(DAILY_PREFIX + key, null);
}

export function writeDaily(key: string, solve: DailySolve): void {
  safeWrite(DAILY_PREFIX + key, solve);
  state.profile.dailyCompleted[key] = solve.completed;
}

export function setPhase(next: Phase): void {
  state.phase = next;
}

export function bumpGeneration(): number {
  state.selected = null;
  state.boosterMode = 'idle';
  state.boosterTempSwap = null;
  return state.gen.bump();
}

export function recordLevelResult(level: number, score: number, stars: 0 | 1 | 2 | 3): {
  starsGained: number;
  newRecord: boolean;
} {
  const prev: LevelProgress = state.profile.levels[level] ?? {
    stars: 0,
    bestScore: 0,
    completed: false,
  };
  const newStars = (Math.max(prev.stars, stars) as 0 | 1 | 2 | 3);
  const newScore = Math.max(prev.bestScore, score);
  const next: LevelProgress = {
    stars: newStars,
    bestScore: newScore,
    completed: prev.completed || stars > 0,
  };
  state.profile.levels[level] = next;
  state.profile.totalStars += Math.max(0, stars - prev.stars);
  if (stars > 0 && level >= state.profile.currentLevel) {
    state.profile.currentLevel = Math.max(state.profile.currentLevel, level + 1);
  }
  if (level > state.profile.bestLevel) state.profile.bestLevel = level;
  return {
    starsGained: Math.max(0, stars - prev.stars),
    newRecord: newScore > prev.bestScore,
  };
}

export function addBooster(id: keyof BoosterInventory, count: number): void {
  state.profile.boosters[id] = Math.max(0, (state.profile.boosters[id] ?? 0) + count);
}

export function spendBooster(id: keyof BoosterInventory): boolean {
  const have = state.profile.boosters[id] ?? 0;
  if (have <= 0) return false;
  state.profile.boosters[id] = have - 1;
  return true;
}

export function unlockAchievement(id: string): boolean {
  if (state.profile.achievements.includes(id)) return false;
  state.profile.achievements.push(id);
  return true;
}

export function findTile(predicate: (t: Tile) => boolean): Tile | null {
  for (let r = 0; r < state.grid.length; r++) {
    const row = state.grid[r]!;
    for (let c = 0; c < row.length; c++) {
      const t = row[c];
      if (t && predicate(t)) return t;
    }
  }
  return null;
}

export function forEachTile(visit: (t: Tile) => void): void {
  for (let r = 0; r < state.grid.length; r++) {
    const row = state.grid[r]!;
    for (let c = 0; c < row.length; c++) {
      const t = row[c];
      if (t) visit(t);
    }
  }
}
