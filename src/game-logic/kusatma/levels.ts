// 60-level generator. Every level is a unique, deterministically-seeded
// skyline whose complexity ramps smoothly with the global level index, while
// each world keeps its own visual theme, siege engine and signature materials.
// Solvability is guaranteed structurally (targets always on column tops,
// AP ammo whenever iron is present, generous clear budget) and proven by
// scripts/kusatma-playthrough.mjs clearing all 60.

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

function shuffle<T>(rng: () => number, arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

function pickDistinct(rng: () => number, n: number, lo: number, hi: number): number[] {
  const pool: number[] = [];
  for (let c = lo; c <= hi; c++) pool.push(c);
  shuffle(rng, pool);
  return pool.slice(0, clamp(n, 0, pool.length));
}

function rep(kind: Kind, n: number): Kind[] {
  return Array.from({ length: Math.max(0, n) }, () => kind);
}

interface Style {
  engine: EngineId;
  tower: number; // max height of a target tower
  wallW: number; // base wall propensity
  iron: number;
  tnt: number;
  glass: number;
  wood: number;
  rows: boolean; // bastion-style low wide field (balista)
}

// One style per world: theme/engine identity + which materials show up.
const STYLES: Style[] = [
  { engine: 'mancinik', tower: 3, wallW: 0.4, iron: 0, tnt: 0, glass: 0.1, wood: 0.35, rows: false },
  { engine: 'mangonel', tower: 4, wallW: 0.5, iron: 0, tnt: 0, glass: 0.16, wood: 0.18, rows: false },
  { engine: 'trebuse', tower: 4, wallW: 0.5, iron: 0.5, tnt: 0, glass: 0.1, wood: 0.08, rows: false },
  { engine: 'balista', tower: 2, wallW: 0.3, iron: 0.22, tnt: 0, glass: 0.12, wood: 0.1, rows: true },
  { engine: 'bombard', tower: 4, wallW: 0.45, iron: 0.28, tnt: 0.5, glass: 0.1, wood: 0.05, rows: false },
  { engine: 'mancinik', tower: 4, wallW: 0.5, iron: 0.42, tnt: 0.4, glass: 0.1, wood: 0.04, rows: false },
];

const NAMES: string[][] = [
  ['Gözcü Kulesi', 'İlk Siper', 'Sınır Karakolu', 'Çoban Burcu', 'Taş Tabya', 'Köprübaşı', 'Dere Geçidi', 'Çifte Kule', 'İleri Karakol', 'Sınır Kalesi'],
  ['Kum Kapısı', 'Vaha Burcu', 'Çöl Siperi', 'Yel Burcu', 'Kervansaray', 'Sıcak Sur', 'Akrep Kulesi', 'Serap Burcu', 'Kum Fırtınası', 'Çöl Kalesi'],
  ['Kar Burcu', 'Buz Kapısı', 'Geçit Kulesi', 'Zirve Siperi', 'Demir Ocağı', 'Çığ Duvarı', 'Kartal Yuvası', 'Granit Sur', 'Tipi Burcu', 'Dağ Kalesi'],
  ['Sazlık Siper', 'Liman Burcu', 'Köprü Kulesi', 'Bataklık Tabya', 'Nehir Geçidi', 'Su Değirmeni', 'Kamış Sur', 'Gemici Burcu', 'Sel Kapısı', 'Nehir Kalesi'],
  ['Lav Kapısı', 'Barut Burcu', 'Kül Siperi', 'Magma Kulesi', 'Ateş Hattı', 'Kor Duvarı', 'Volkan Ağzı', 'Fünye Tabya', 'Patlak Sur', 'Volkan Kalesi'],
  ['Dış Sur', 'Sur Kapısı', 'Saray Burcu', 'Hazine Kulesi', 'İç Kale', 'Taht Salonu', 'Muhafız Burcu', 'Kanlı Sur', 'Son Siper', 'Başkent Kalesi'],
];

function material(st: Style, world: number, d: number, rng: () => number): Kind {
  if (world >= 2 && rng() < st.iron * (0.55 + 0.6 * d)) return 'iron';
  if (world >= 4 && rng() < st.tnt * (0.5 + 0.7 * d)) return 'tnt';
  if (world >= 1 && rng() < st.glass * (1 - 0.5 * d)) return 'glass';
  if (rng() < st.wood * (1 - 0.7 * d)) return 'wood';
  return 'stone';
}

function stack(st: Style, world: number, d: number, rng: () => number, h: number): Kind[] {
  const out: Kind[] = [];
  for (let r = 0; r < h; r++) out.push(material(st, world, d, rng));
  return out;
}

interface Built {
  cols: ColSpec[];
  engine: EngineId;
}

function genFortress(world: number, tier: number, isBoss: boolean, rng: () => number): Built {
  const st = STYLES[world]!;
  const d = (world * LEVELS_PER_WORLD + tier) / (TOTAL_LEVELS - 1); // 0..1 global
  const cols: ColSpec[] = [];
  const used = new Set<number>();
  const free = (): number[] => [1, 2, 3, 4, 5, 6, 7].filter((c) => !used.has(c));
  const place = (c: number, s: Kind[]): void => {
    if (used.has(c) || c < 1 || c > 7 || s.length === 0) return;
    cols.push({ col: c, stack: s.slice(0, 6) });
    used.add(c);
  };

  // Targets: 1 early → 4 late (+1 on bosses), placed on the right.
  const T = clamp(1 + Math.round(d * 3.4) + (isBoss ? 1 : 0), 1, isBoss ? 5 : 4);
  const tCols = pickDistinct(rng, T, st.rows ? 1 : 3, 7);
  for (const c of tCols) {
    const th = clamp(1 + Math.round(d * (st.tower - 1) + rng() * 1.6), 1, st.tower);
    const s = stack(st, world, d, rng, th);
    s.push('target');
    place(c, s);
  }

  // Front walls (force arcing / grinding). More + taller with difficulty.
  const minT = Math.min(...tCols);
  let walls = clamp(Math.round(d * 2 + st.wallW + (isBoss ? 1.5 : 0)), st.rows ? 0 : 1, 3);
  const wallZone = shuffle(rng, free().filter((c) => (st.rows ? true : c < minT)));
  for (let i = 0; i < walls && i < wallZone.length; i++) {
    const wh = st.rows
      ? clamp(1 + Math.round(rng()), 1, 2)
      : clamp(2 + Math.round(d * 3 + rng() * 1.3), 2, 5);
    place(wallZone[i]!, stack(st, world, d, rng, wh));
  }

  // Rows worlds: fill the field with low bastions for the pierce playground.
  if (st.rows) {
    for (const c of free()) {
      if (rng() < 0.75) place(c, stack(st, world, d, rng, clamp(1 + Math.round(rng()), 1, 2)));
    }
  } else {
    // Light decoration so the silhouette never looks empty.
    for (const c of free()) {
      if (rng() < 0.18) place(c, stack(st, world, d, rng, clamp(1 + Math.round(rng()), 1, 2)));
    }
  }

  // Powder worlds get a guaranteed TNT cluster — the chain-reaction "domino"
  // moment that makes the fireball/keg ammo shine.
  if (world >= 4) {
    const fc = free();
    if (fc.length) {
      const n = clamp(2 + Math.round(d * 2), 2, 4);
      place(fc[Math.floor(rng() * fc.length)]!, rep('tnt', n));
    }
  }

  // Supply barrels (the ammo economy). 1, or 2 past the halfway point.
  const sup = 1 + (d > 0.55 ? 1 : 0);
  const supZone = shuffle(rng, free());
  for (let i = 0; i < sup && i < supZone.length; i++) {
    place(supZone[i]!, rng() < 0.5 ? ['stone', 'supply'] : ['supply']);
  }

  cols.sort((a, b) => a.col - b.col);
  void walls;
  return { cols, engine: st.engine };
}

function countKinds(cols: ColSpec[]): Record<Kind, number> {
  const c: Record<Kind, number> = { wood: 0, stone: 0, iron: 0, tnt: 0, glass: 0, supply: 0, target: 0 };
  for (const col of cols) for (const k of col.stack) c[k]++;
  return c;
}

function computeLoadout(
  cols: ColSpec[],
  world: number,
  d: number,
  isBoss: boolean,
): { ammo: Partial<Record<AmmoId, number>>; thresholds: [number, number, number] } {
  const c = countKinds(cols);
  const ironHP = c.iron * HP.iron;
  let breakHP = 0;
  for (const k of ['wood', 'stone', 'glass', 'tnt'] as Kind[]) breakHP += c[k] * HP[k];
  const targets = c.target;
  const par = targets + Math.ceil(breakHP / 4) + Math.ceil(ironHP / 6) + 1;
  const buffer = 3 + Math.ceil(par * 0.6);

  let boulder = 0;
  let fire = 0;
  let bolt = 0;
  let keg = 0;
  let cluster = 0;
  if (c.iron > 0) boulder = Math.ceil(ironHP / 5) + 1;
  if (c.tnt > 0) fire = 1 + Math.floor(world / 2);
  if (world === 3) bolt = 2 + Math.round(d * 3);
  if (world >= 1 && targets >= 2) cluster = 1 + (d > 0.5 ? 1 : 0);
  if (isBoss) {
    fire = Math.max(fire, 1);
    boulder = Math.max(boulder, 1);
    cluster = Math.max(cluster, 1);
    if (world >= 4) keg = 1;
  }

  const special = boulder + fire + bolt + keg + cluster;
  const stoneN = Math.max(3, par + buffer - special);

  const ammo: Partial<Record<AmmoId, number>> = { stone: stoneN };
  if (boulder) ammo.boulder = boulder;
  if (fire) ammo.fire = fire;
  if (cluster) ammo.cluster = cluster;
  if (bolt) ammo.bolt = bolt;
  if (keg) ammo.keg = keg;

  // Stars reward efficiency: leftover ammo vs the comfortable buffer. The
  // bigger/later the fortress, the more precise you must be for 3 stars.
  const t3 = Math.max(2, Math.round(buffer * 0.7));
  const t2 = Math.max(1, Math.min(t3 - 1, Math.round(buffer * 0.3)));
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
  const d = (id - 1) / (TOTAL_LEVELS - 1);
  const rng = mulberry32(id * 2654435761 + 7);
  const built = genFortress(world, tier, isBoss, rng);
  const { ammo, thresholds } = computeLoadout(built.cols, world, d, isBoss);

  const def: LevelDef = {
    id,
    name: NAMES[world]![tier] ?? `Seviye ${id}`,
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
    if (ti >= 0 && ti !== col.stack.length - 1) problems.push(`L${def.id}: target not on top in col ${col.col}`);
    if (col.stack.filter((k) => k === 'target').length > 1) problems.push(`L${def.id}: multiple targets in col ${col.col}`);
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
