// Mutable runtime singleton + profile persistence. Mirrors the seker-esle
// "shared state object" pattern. All other modules import `S` and mutate it.

import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import type {
  AmmoId,
  Block,
  EngineId,
  GameState,
  LevelDef,
  LevelProgress,
  Particle,
  Popup,
  Profile,
  Projectile,
} from './types';
import { STORAGE_LEGACY_BEST, STORAGE_PROFILE, TOTAL_LEVELS } from './constants';

export interface Runtime {
  state: GameState;
  prevState: GameState; // to return from settings/achievements overlays
  blocks: Block[];
  projectiles: Projectile[];
  particles: Particle[];
  popups: Popup[];
  shakeX: number;
  shakeY: number;
  shake: number; // current shake magnitude (decays)
  level: LevelDef | null;
  levelIndex: number; // 1..TOTAL_LEVELS
  engineId: EngineId;
  ammoCounts: Record<AmmoId, number>;
  loadout: AmmoId[]; // ammo types available this level, in display order
  activeAmmo: AmmoId;
  score: number;
  shotsUsed: number;
  shotDestroyed: number; // blocks destroyed within the current shot
  bestChainThisLevel: number;
  startBlocks: number; // breakable blocks at level start (for demolition medal)
  targetsLeft: number;
  aimAngle: number;
  power: number;
  dragging: boolean;
  aimedByDrag: boolean;
  shotId: number;
  cleared: boolean; // current level already cleared before (enables engine pick)
  profile: Profile;
}

export const S: Runtime = {
  state: 'intro',
  prevState: 'map',
  blocks: [],
  projectiles: [],
  particles: [],
  popups: [],
  shakeX: 0,
  shakeY: 0,
  shake: 0,
  level: null,
  levelIndex: 1,
  engineId: 'mancinik',
  ammoCounts: { stone: 0, boulder: 0, fire: 0, cluster: 0, keg: 0, bolt: 0 },
  loadout: ['stone'],
  activeAmmo: 'stone',
  score: 0,
  shotsUsed: 0,
  shotDestroyed: 0,
  bestChainThisLevel: 0,
  startBlocks: 0,
  targetsLeft: 0,
  aimAngle: -0.78,
  power: 0.62,
  dragging: false,
  aimedByDrag: false,
  shotId: 0,
  cleared: false,
  profile: defaultProfile(),
};

export const gen = createGenToken();

export function defaultProfile(): Profile {
  return {
    schemaVersion: 1,
    currentLevel: 1,
    totalStars: 0,
    levels: {},
    medals: [],
    settings: { sfx: true, music: true, reducedMotion: false },
    bestScore: 0,
  };
}

export function loadProfile(): Profile {
  const fallback = defaultProfile();
  const raw = safeRead<Partial<Profile>>(STORAGE_PROFILE, fallback);
  const p: Profile = {
    ...fallback,
    ...raw,
    settings: { ...fallback.settings, ...(raw.settings ?? {}) },
    levels: raw.levels ?? {},
    medals: Array.isArray(raw.medals) ? raw.medals : [],
  };
  p.currentLevel = clampLevel(p.currentLevel);
  // Seed display "rekor" from the old single-best key the first time.
  if (!p.bestScore) {
    const legacy = safeRead<number>(STORAGE_LEGACY_BEST, 0);
    if (typeof legacy === 'number' && legacy > 0) p.bestScore = legacy;
  }
  p.totalStars = recomputeStars(p);
  return p;
}

function clampLevel(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(TOTAL_LEVELS, Math.floor(n)));
}

function recomputeStars(p: Profile): number {
  let t = 0;
  for (const k of Object.keys(p.levels)) {
    t += p.levels[Number(k)]?.stars ?? 0;
  }
  return t;
}

export function persistProfile(): void {
  safeWrite(STORAGE_PROFILE, S.profile);
}

export function progressFor(id: number): LevelProgress {
  return S.profile.levels[id] ?? { stars: 0, bestScore: 0, cleared: false };
}

export interface LevelResult {
  starsGained: number;
  firstClear: boolean;
  newBest: boolean;
}

export function recordLevelResult(
  id: number,
  score: number,
  stars: 0 | 1 | 2 | 3,
): LevelResult {
  const prev = progressFor(id);
  const newStars = Math.max(prev.stars, stars) as 0 | 1 | 2 | 3;
  const newScore = Math.max(prev.bestScore, score);
  const firstClear = !prev.cleared && stars > 0;
  S.profile.levels[id] = {
    stars: newStars,
    bestScore: newScore,
    cleared: prev.cleared || stars > 0,
  };
  S.profile.totalStars += Math.max(0, newStars - prev.stars);
  if (score > S.profile.bestScore) S.profile.bestScore = score;
  if (stars > 0 && id >= S.profile.currentLevel && id < TOTAL_LEVELS) {
    S.profile.currentLevel = id + 1;
  }
  persistProfile();
  return {
    starsGained: Math.max(0, newStars - prev.stars),
    firstClear,
    newBest: newScore > prev.bestScore,
  };
}

export function hasMedal(medalId: string): boolean {
  return S.profile.medals.includes(medalId);
}

export function awardMedal(medalId: string): boolean {
  if (hasMedal(medalId)) return false;
  S.profile.medals.push(medalId);
  persistProfile();
  return true;
}
