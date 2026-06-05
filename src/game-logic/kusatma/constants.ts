// Kuşatma v2 — tunable constants, palette, world themes. No logic.

import type { Kind, WorldDef } from './types';

export const W = 640;
export const H = 400;
export const GROUND_Y = 340;
export const BLOCK = 32;
export const CASTLE_X = 372;
export const P0X = 80;
export const P0Y = GROUND_Y - 66;

export const GRAVITY = 1000; // px/s^2
export const FIXED_DT = 1 / 120;
export const MAX_FRAME_TIME = 0.1;

export const HIT_MIN_SPEED = 90;
export const DMG_STEP = 300; // base speed-damage divisor
export const DMG_CAP = 6;
export const REST_EPS = 36; // px/s
export const REST_TIME = 0.45; // s under REST_EPS => spent
export const MAX_SHOT_TIME = 7; // s safety per projectile
export const MAX_PULL = 150; // px drag for full power

export const AMMO_BONUS = 120; // score per leftover boulder at clear
export const SUPPLY_REFUND = 2; // stone refunded per supply barrel

export const STORAGE_PROFILE = 'kusatma.profile.v1';
export const STORAGE_LEGACY_BEST = 'kusatma.best';

export const TOTAL_LEVELS = 60;
export const WORLD_COUNT = 6;
export const LEVELS_PER_WORLD = 10;

// HP / score per block kind (single source).
export const HP: Record<Kind, number> = {
  wood: 2,
  stone: 5,
  iron: 12,
  tnt: 1,
  glass: 1,
  supply: 1,
  target: 1,
};

export const SCORE: Record<Kind, number> = {
  wood: 30,
  stone: 50,
  iron: 120,
  tnt: 40,
  glass: 80,
  supply: 60,
  target: 200,
};

export const TNT_RADIUS = 58;
export const TNT_POWER = 4;
export const MAX_CHAIN_DEPTH = 6;

export const MAX_PARTICLES = 300;
export const MAX_POPUPS = 18;

// Static scene palette (world-independent pieces).
export const COL = {
  stone: '#79828f',
  stoneTop: '#98a1ae',
  stoneEdge: '#454c57',
  wood: '#9a6a3c',
  woodTop: '#b6884f',
  woodEdge: '#5d3d21',
  iron: '#566173',
  ironTop: '#79859a',
  ironEdge: '#2e3543',
  tnt: '#b3402f',
  tntTop: '#d65c46',
  tntDark: '#5e1f16',
  glass: '#7fd6e6',
  glassTop: '#bdf0fa',
  glassEdge: '#3f9fb4',
  supply: '#d2982f',
  supplyTop: '#e8b658',
  supplyHoop: '#6f5018',
  keep: '#3b3442',
  keepEdge: '#241f2a',
  banner: '#d23b3b',
  pole: '#caa45a',
  ball: '#ccd1d9',
  ballEdge: '#7b8290',
  frame: '#6a4525',
  frameDark: '#412a14',
  fire: '#ff8a3c',
  fireCore: '#ffd45e',
  smoke: 'rgba(60,60,66,0.7)',
  traj: 'rgba(245, 246, 248, 0.55)',
  sun: 'rgba(255,236,170,0.85)',
};

export const WORLDS: WorldDef[] = [
  {
    name: 'Sınır Boyu',
    subtitle: 'İlk surlar',
    skyTop: '#13315c',
    skyBot: '#5b7aa3',
    hillFar: '#1c3350',
    hillNear: '#27435f',
    groundTop: '#46663f',
    groundBot: '#243a22',
    dirt: '#2c2118',
  },
  {
    name: 'Çöl Kaleleri',
    subtitle: 'Kavurucu kum',
    skyTop: '#7a4a22',
    skyBot: '#e0a35a',
    hillFar: '#9b6a35',
    hillNear: '#b9853f',
    groundTop: '#c79a52',
    groundBot: '#7c5a2c',
    dirt: '#5e441f',
  },
  {
    name: 'Dağ Geçidi',
    subtitle: 'Karlı zirveler',
    skyTop: '#33425e',
    skyBot: '#9fb2cc',
    hillFar: '#6b7791',
    hillNear: '#8b97ad',
    groundTop: '#d6dde6',
    groundBot: '#9aa6b4',
    dirt: '#6b7180',
  },
  {
    name: 'Nehir Kalesi',
    subtitle: 'Sazlık siperler',
    skyTop: '#13403f',
    skyBot: '#5fae9a',
    hillFar: '#1d5246',
    hillNear: '#2a6b58',
    groundTop: '#3f7a4e',
    groundBot: '#22432a',
    dirt: '#243a2a',
  },
  {
    name: 'Volkan Surları',
    subtitle: 'Lav ve barut',
    skyTop: '#3a1322',
    skyBot: '#a8472f',
    hillFar: '#4a1c22',
    hillNear: '#6a2722',
    groundTop: '#5c2a22',
    groundBot: '#2c1413',
    dirt: '#1e0f0d',
  },
  {
    name: 'Başkent Kuşatması',
    subtitle: 'Son kale',
    skyTop: '#221a3a',
    skyBot: '#6a5a9a',
    hillFar: '#2c2350',
    hillNear: '#3a2f63',
    groundTop: '#3e3a52',
    groundBot: '#211f30',
    dirt: '#181626',
  },
];

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
