// 60-level curated-procedural generator. Deterministic per index. Archetype
// builders + loadout/star computation + validateLevel() solvability checks.

import type { AmmoId, ColSpec, EngineId, Kind, LevelDef } from './types';
import { HP, LEVELS_PER_WORLD, TOTAL_LEVELS, WORLDS, clamp } from './constants';

export { WORLDS };
export function totalLevels(): number {
  return TOTAL_LEVELS;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rep(kind: Kind, n: number): Kind[] {
  return Array.from({ length: Math.max(0, n) }, () => kind);
}

type ArchKey =
  | 'SingleTower'
  | 'TwinTowers'
  | 'Pyramid'
  | 'GlassHouse'
  | 'Gatehouse'
  | 'Keep'
  | 'LayeredWall'
  | 'BastionRows'
  | 'IronVault'
  | 'TNTHoneycomb'
  | 'MixedFortress';

interface Built {
  cols: ColSpec[];
  engine: EngineId;
}

const LABEL: Record<ArchKey, string> = {
  SingleTower: 'Gözcü Kulesi',
  TwinTowers: 'İkiz Burç',
  Pyramid: 'Piramit Sur',
  GlassHouse: 'Cam Köşk',
  Gatehouse: 'Kapı Kulesi',
  Keep: 'İç Kale',
  LayeredWall: 'Katmanlı Sur',
  BastionRows: 'Tabya Sırası',
  IronVault: 'Demir Mahzen',
  TNTHoneycomb: 'Barut Peteği',
  MixedFortress: 'Büyük Kale',
};

function build(key: ArchKey, world: number, tier: number, rng: () => number): Built {
  const w = world;
  switch (key) {
    case 'SingleTower': {
      const h = clamp(2 + w + Math.floor(tier / 3), 2, 6);
      const cols: ColSpec[] = [{ col: 5, stack: [...rep('stone', h), 'target'] }];
      if (tier > 0) cols.unshift({ col: 2, stack: rep('wood', clamp(1 + Math.floor(tier / 2), 1, 3)) });
      return { cols, engine: 'mancinik' };
    }
    case 'TwinTowers': {
      const h1 = clamp(2 + w, 2, 5);
      const h2 = clamp(3 + w, 2, 6);
      return {
        cols: [
          { col: 3, stack: [...rep('stone', h1), 'target'] },
          { col: 5, stack: ['stone', 'supply'] },
          { col: 6, stack: [...rep('stone', h2), 'target'] },
        ],
        engine: 'mancinik',
      };
    }
    case 'Pyramid': {
      const b = clamp(1 + w, 1, 4);
      return {
        cols: [
          { col: 2, stack: rep('stone', b) },
          { col: 3, stack: rep('stone', b + 1) },
          { col: 4, stack: [...rep('stone', b + 1), 'target'] },
          { col: 5, stack: rep('stone', b + 1) },
          { col: 6, stack: rep('stone', b) },
        ],
        engine: 'mancinik',
      };
    }
    case 'GlassHouse': {
      return {
        cols: [
          { col: 1, stack: ['glass', 'supply'] },
          { col: 2, stack: rep('glass', 2) },
          { col: 3, stack: rep('glass', 3) },
          { col: 4, stack: [...rep('glass', 2), 'target'] },
          { col: 5, stack: rep('glass', 3) },
          { col: 6, stack: [...rep('glass', 2), 'target'] },
        ],
        engine: 'mancinik',
      };
    }
    case 'Gatehouse': {
      const wall = clamp(3 + w, 3, 6);
      return {
        cols: [
          { col: 2, stack: rep('stone', wall) },
          { col: 4, stack: ['stone', 'target'] },
          { col: 5, stack: ['stone', 'supply'] },
          { col: 6, stack: [...rep('stone', clamp(2 + w, 2, 5)), 'target'] },
        ],
        engine: 'mangonel',
      };
    }
    case 'Keep': {
      const side = clamp(2 + w, 2, 5);
      const mid = clamp(3 + w, 3, 5);
      return {
        cols: [
          { col: 2, stack: rep('stone', side) },
          { col: 4, stack: [...rep('stone', mid), 'target'] },
          { col: 5, stack: ['stone', 'supply'] },
          { col: 6, stack: rep('stone', side) },
        ],
        engine: 'mangonel',
      };
    }
    case 'LayeredWall': {
      const wall = clamp(3 + w, 3, 6);
      return {
        cols: [
          { col: 2, stack: rep('stone', wall) },
          { col: 3, stack: rep('stone', wall) },
          { col: 5, stack: ['stone', 'target'] },
          { col: 6, stack: ['stone', 'target'] },
          { col: 7, stack: ['supply'] },
        ],
        engine: 'mangonel',
      };
    }
    case 'BastionRows': {
      const cols: ColSpec[] = [];
      for (let c = 2; c <= 7; c++) {
        const isT = c === 3 || c === 5 || c === 7;
        cols.push({ col: c, stack: isT ? ['stone', 'target'] : rep('stone', 2) });
      }
      return { cols, engine: 'balista' };
    }
    case 'IronVault': {
      return {
        cols: [
          { col: 2, stack: ['iron', 'iron'] },
          { col: 3, stack: ['iron', 'stone', 'target'] },
          { col: 4, stack: rep('iron', clamp(2 + Math.floor(w / 2), 2, 3)) },
          { col: 5, stack: ['iron', 'stone', 'target'] },
          { col: 6, stack: ['stone', 'supply'] },
        ],
        engine: 'trebuse',
      };
    }
    case 'TNTHoneycomb': {
      return {
        cols: [
          { col: 2, stack: ['stone', 'supply'] },
          { col: 3, stack: ['stone', 'tnt', 'tnt'] },
          { col: 4, stack: ['tnt', 'tnt', 'target'] },
          { col: 5, stack: ['stone', 'tnt', 'tnt'] },
          { col: 6, stack: ['tnt', 'target'] },
        ],
        engine: 'bombard',
      };
    }
    case 'MixedFortress':
    default: {
      const t = clamp(1 + w, 1, 3);
      void rng;
      return {
        cols: [
          { col: 1, stack: [...rep('stone', t), 'supply'] },
          { col: 2, stack: rep('stone', clamp(2 + w, 2, 5)) },
          { col: 3, stack: ['iron', ...rep('stone', t)] },
          { col: 4, stack: [...rep('stone', t), 'target'] },
          { col: 5, stack: ['stone', 'tnt', 'tnt', 'target'] },
          { col: 6, stack: [...rep('stone', clamp(1 + w, 1, 4)), 'target'] },
          { col: 7, stack: ['stone', 'supply'] },
        ],
        engine: 'mancinik',
      };
    }
  }
}

const WORLD_POOLS: ArchKey[][] = [
  ['SingleTower', 'TwinTowers', 'SingleTower', 'Pyramid', 'TwinTowers', 'GlassHouse', 'Pyramid', 'TwinTowers', 'SingleTower'],
  ['Gatehouse', 'SingleTower', 'Keep', 'TwinTowers', 'Gatehouse', 'LayeredWall', 'Pyramid', 'Keep', 'LayeredWall'],
  ['IronVault', 'Keep', 'IronVault', 'Gatehouse', 'IronVault', 'LayeredWall', 'IronVault', 'Keep', 'Gatehouse'],
  ['BastionRows', 'IronVault', 'BastionRows', 'LayeredWall', 'BastionRows', 'Keep', 'BastionRows', 'IronVault', 'LayeredWall'],
  ['TNTHoneycomb', 'BastionRows', 'TNTHoneycomb', 'IronVault', 'TNTHoneycomb', 'Keep', 'TNTHoneycomb', 'LayeredWall', 'TNTHoneycomb'],
  ['MixedFortress', 'Keep', 'IronVault', 'TNTHoneycomb', 'BastionRows', 'Gatehouse', 'LayeredWall', 'IronVault', 'TNTHoneycomb'],
];

function countKinds(cols: ColSpec[]): Record<Kind, number> {
  const c: Record<Kind, number> = { wood: 0, stone: 0, iron: 0, tnt: 0, glass: 0, supply: 0, target: 0 };
  for (const col of cols) for (const k of col.stack) c[k]++;
  return c;
}

function computeLoadout(
  cols: ColSpec[],
  key: ArchKey,
  world: number,
  isBoss: boolean,
): { ammo: Partial<Record<AmmoId, number>>; thresholds: [number, number, number] } {
  const c = countKinds(cols);
  const ironHP = c.iron * HP.iron;
  let breakHP = 0;
  for (const k of ['wood', 'stone', 'glass', 'tnt'] as Kind[]) breakHP += c[k] * HP[k];
  const targets = c.target;
  const par = targets + Math.ceil(breakHP / 4) + Math.ceil(ironHP / 6) + 1;
  const buffer = 2 + Math.ceil(par * 0.6) + Math.floor(world / 2);

  let boulder = 0;
  let fire = 0;
  let bolt = 0;
  let keg = 0;
  let cluster = 0;
  if (c.iron > 0) boulder = Math.ceil(ironHP / 5) + 1;
  if (c.tnt > 0) fire = 1 + Math.floor(world / 2);
  if (key === 'BastionRows') bolt = 3 + Math.floor(world / 2);
  if (key === 'TNTHoneycomb') fire = Math.max(fire, 2);
  if ((key === 'TwinTowers' || key === 'Pyramid') && world >= 1) cluster = 2;
  if (isBoss) {
    fire = Math.max(fire, 1);
    boulder = Math.max(boulder, 1);
    if (world >= 2) cluster = Math.max(cluster, 2);
    if (world >= 4) keg = 1;
  }

  const special = boulder + fire + bolt + keg + cluster;
  const stone = Math.max(3, par + buffer - special);

  const ammo: Partial<Record<AmmoId, number>> = { stone };
  if (boulder) ammo.boulder = boulder;
  if (fire) ammo.fire = fire;
  if (cluster) ammo.cluster = cluster;
  if (bolt) ammo.bolt = bolt;
  if (keg) ammo.keg = keg;

  const total = stone + special;
  const t2 = Math.max(1, Math.round(total * 0.2));
  const t3 = Math.max(t2 + 1, Math.round(total * 0.38));
  return { ammo, thresholds: [0, t2, t3] };
}

const cache = new Map<number, LevelDef>();

export function makeLevel(i: number): LevelDef {
  const id = clamp(i, 1, TOTAL_LEVELS);
  const cached = cache.get(id);
  if (cached) return cached;

  const world = Math.floor((id - 1) / LEVELS_PER_WORLD);
  const tier = (id - 1) % LEVELS_PER_WORLD;
  const isBoss = tier === LEVELS_PER_WORLD - 1;
  const rng = mulberry32(id * 2654435761);
  const key: ArchKey = isBoss ? 'MixedFortress' : WORLD_POOLS[world]![tier]!;
  const built = build(key, world, tier, rng);
  const { ammo, thresholds } = computeLoadout(built.cols, key, world, isBoss);

  const def: LevelDef = {
    id,
    name: isBoss ? `Büyük Kale ${world + 1}` : LABEL[key],
    world,
    engine: built.engine,
    ammo,
    cols: built.cols,
    starThresholds: thresholds,
    isBoss,
  };
  cache.set(id, def);
  return def;
}

export function getLevel(i: number): LevelDef {
  return makeLevel(i);
}

export function loadoutTotal(def: LevelDef): number {
  let t = 0;
  for (const k of Object.keys(def.ammo) as AmmoId[]) t += def.ammo[k] ?? 0;
  return t;
}

// Static solvability invariants. Returns a list of problems (empty == ok).
export function validateLevel(def: LevelDef): string[] {
  const problems: string[] = [];
  const c = countKinds(def.cols);
  if (c.target < 1) problems.push(`L${def.id}: no targets`);
  for (const col of def.cols) {
    const ti = col.stack.indexOf('target');
    if (ti >= 0 && ti !== col.stack.length - 1) {
      problems.push(`L${def.id}: target not on top in col ${col.col}`);
    }
    if (col.stack.filter((k) => k === 'target').length > 1) {
      problems.push(`L${def.id}: multiple targets in col ${col.col}`);
    }
    if (col.stack.length > 6) problems.push(`L${def.id}: col ${col.col} too tall`);
    if (col.col < 0 || col.col > 7) problems.push(`L${def.id}: col ${col.col} out of range`);
  }
  if (c.iron > 0) {
    const ap = (def.ammo.boulder ?? 0) + (def.ammo.bolt ?? 0) + (def.ammo.fire ?? 0) + (def.ammo.keg ?? 0);
    if (ap < 1) problems.push(`L${def.id}: iron present but no AP ammo`);
  }
  if (loadoutTotal(def) < c.target + 1) problems.push(`L${def.id}: loadout too small`);
  return problems;
}

export function validateAll(): string[] {
  const all: string[] = [];
  for (let i = 1; i <= TOTAL_LEVELS; i++) all.push(...validateLevel(makeLevel(i)));
  return all;
}
