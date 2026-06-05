// Kuşatma v2 — shared type contracts. Pure types, zero logic / imports.

export type Kind = 'wood' | 'stone' | 'iron' | 'tnt' | 'glass' | 'supply' | 'target';

export type EngineId = 'mancinik' | 'mangonel' | 'trebuse' | 'balista' | 'bombard';

export type AmmoId = 'stone' | 'boulder' | 'fire' | 'cluster' | 'keg' | 'bolt';

export type AmmoBehavior = 'plain' | 'boulder' | 'fire' | 'cluster' | 'keg' | 'bolt';

export type GameState =
  | 'intro'
  | 'map'
  | 'prelevel'
  | 'aiming'
  | 'firing'
  | 'settling'
  | 'levelclear'
  | 'gameover'
  | 'won'
  | 'settings'
  | 'achievements';

export interface Block {
  col: number;
  row: number;
  kind: Kind;
  hp: number;
  maxHp: number;
  drawY: number;
  alive: boolean;
  flash: number; // 0..1 hit flash, decays
}

export interface ColSpec {
  col: number;
  stack: Kind[]; // bottom -> top
}

export interface Projectile {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  ammo: AmmoId;
  active: boolean;
  age: number;
  restTimer: number;
  pierceLeft: number;
  hasSplit: boolean;
  exploded: boolean;
  shotId: number;
  rot: number;
}

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  color: string;
  size: number;
  rot: number;
  spin: number;
  grav: number;
}

export interface Popup {
  x: number;
  y: number;
  life: number;
  max: number;
  text: string;
  color: string;
  size: number;
}

export interface EngineDef {
  id: EngineId;
  name: string;
  desc: string;
  speedMin: number;
  speedMax: number;
  angleMin: number; // steepest (radians, negative = up)
  angleMax: number; // flattest
  aimStep: number;
  unlockWorld: number; // 0-based world index at which it unlocks
}

export interface AmmoDef {
  id: AmmoId;
  name: string;
  glyph: string;
  desc: string;
  r: number;
  mass: number;
  restitution: number;
  tangent: number;
  dmgMul: number;
  behavior: AmmoBehavior;
  color: string;
  trail: string;
  explodeRadius?: number;
  explodePower?: number;
  splitInto?: number;
  pierce?: number;
  isBasic?: boolean;
}

export interface LevelDef {
  id: number; // 1..60
  name: string;
  world: number; // 0..5
  engine: EngineId;
  ammo: Partial<Record<AmmoId, number>>;
  cols: ColSpec[];
  starThresholds: [number, number, number]; // leftover-ammo thresholds for 1/2/3 stars
  isBoss: boolean;
}

export interface LevelProgress {
  stars: 0 | 1 | 2 | 3;
  bestScore: number;
  cleared: boolean;
}

export interface UserSettings {
  sfx: boolean;
  music: boolean;
  reducedMotion: boolean;
}

export interface Profile {
  schemaVersion: 1;
  currentLevel: number; // highest unlocked, 1..60
  totalStars: number;
  levels: Record<number, LevelProgress>;
  medals: string[];
  settings: UserSettings;
  bestScore: number; // best single-level score (display "rekor")
}

export interface WorldDef {
  name: string;
  subtitle: string;
  skyTop: string;
  skyBot: string;
  hillFar: string;
  hillNear: string;
  groundTop: string;
  groundBot: string;
  dirt: string;
}

export interface MedalDef {
  id: string;
  name: string;
  desc: string;
  glyph: string;
}
