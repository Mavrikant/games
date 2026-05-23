// Shared types for the seker-esle game.
// All sub-modules import contracts from here; no logic lives in this file.

export const SIZE = 8;
export const MAX_COLORS = 7;

export type Phase =
  | 'boot'
  | 'tutorial'
  | 'map'
  | 'idle'
  | 'animating'
  | 'cascadeBetween'
  | 'boosterSelect'
  | 'paused'
  | 'levelComplete'
  | 'levelFailed'
  | 'dailyChallenge'
  | 'comeback';

export type SpecialType = null | 'striped-h' | 'striped-v' | 'wrapped' | 'color-bomb';
export type IngredientType = null | 'cherry' | 'nut';

export interface Tile {
  id: number;
  color: number;
  special: SpecialType;
  ingredient: IngredientType;
  jellyLayers: number;
  row: number;
  col: number;
  el: HTMLDivElement;
}

export type Grid = (Tile | null)[][];

export interface MatchRun {
  tiles: Tile[];
  axis: 'h' | 'v';
  color: number;
  length: number;
  row?: number;
  col?: number;
}

export interface SpecialSpawn {
  row: number;
  col: number;
  type: NonNullable<SpecialType>;
  color: number;
}

export type MissionType = 'score' | 'ingredient' | 'jelly' | 'color';

export interface ColorTarget {
  color: number;
  count: number;
}

export interface MissionDef {
  type: MissionType;
  scoreTarget: number;
  ingredientTarget?: number;
  jellyTarget?: number;
  colorTargets?: ColorTarget[];
}

export interface LayoutPlacement {
  blocked: [number, number][];
  jelly: [number, number, number][];
  ingredients: [number, number][];
  preSpecials: [number, number, NonNullable<SpecialType>][];
}

export interface LevelDef {
  id: number;
  mission: MissionDef;
  colors: number;
  moves: number;
  layout: LayoutPlacement;
  starThresholds: [number, number, number];
  isBoss?: boolean;
  title?: string;
}

export type BoosterId = 'hammer' | 'swap' | 'colorBombStart' | 'plus5Moves';

export type BoosterInventory = Record<BoosterId, number>;

export interface AchievementDef {
  id: string;
  label: string;
  desc: string;
  icon: string;
  reward: Partial<Record<BoosterId, number>>;
}

export interface LevelProgress {
  stars: 0 | 1 | 2 | 3;
  bestScore: number;
  completed: boolean;
}

export interface UserSettings {
  sound: boolean;
  vibrate: boolean;
  reducedMotion: boolean;
}

export interface Profile {
  schemaVersion: 2;
  currentLevel: number;
  bestLevel: number;
  totalStars: number;
  levels: Record<number, LevelProgress>;
  boosters: BoosterInventory;
  achievements: string[];
  lastPlayDate: string;
  streak: number;
  longestStreak: number;
  dailyCompleted: Record<string, boolean>;
  tutorialDone: boolean;
  settings: UserSettings;
  stats: {
    totalMatches: number;
    totalCascades: number;
    bestCascade: number;
    specialsCreated: number;
    bestLevelStars: number;
    longestComboStreak: number;
  };
}

export interface DailySolve {
  score: number;
  stars: 0 | 1 | 2 | 3;
  completed: boolean;
}

export type BoosterMode =
  | 'idle'
  | 'hammer-target'
  | 'swap-first'
  | 'swap-second';

export interface MissionProgress {
  type: MissionType;
  current: number;
  target: number;
  label: string;
  done: boolean;
  detail?: { color: number; current: number; target: number }[];
}

export interface SwapCoord {
  row: number;
  col: number;
}

export type AchievementEvent =
  | { kind: 'match'; size: number }
  | { kind: 'cascade'; depth: number }
  | { kind: 'special-created'; type: NonNullable<SpecialType> }
  | { kind: 'level-complete'; stars: 0 | 1 | 2 | 3; level: number }
  | { kind: 'star-earned'; total: number }
  | { kind: 'streak-day'; day: number }
  | { kind: 'daily-complete' }
  | { kind: 'combo-streak'; streak: number };
