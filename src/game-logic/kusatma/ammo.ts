// Ammunition types — data + projectile factory. Mechanical differences live
// in physics.ts (which reads these defs); this module owns the table.

import type { AmmoDef, AmmoId, Projectile } from './types';
import { COL } from './constants';

export const AMMO: Record<AmmoId, AmmoDef> = {
  stone: {
    id: 'stone',
    name: 'Taş',
    glyph: '●',
    desc: 'Temel mermi. Erzak fıçısı bunu doldurur.',
    r: 8,
    mass: 1,
    restitution: 0.42,
    tangent: 0.78,
    dmgMul: 1,
    behavior: 'plain',
    color: COL.ball,
    trail: 'rgba(220,225,233,0.25)',
    isBasic: true,
  },
  boulder: {
    id: 'boulder',
    name: 'Gülle',
    glyph: '⬤',
    desc: 'Ağır; az seker, demiri ezer, menzili kısa.',
    r: 11,
    mass: 2.4,
    restitution: 0.16,
    tangent: 0.7,
    dmgMul: 2.2,
    behavior: 'boulder',
    color: '#8a8f99',
    trail: 'rgba(120,126,140,0.25)',
  },
  fire: {
    id: 'fire',
    name: 'Ateş topu',
    glyph: '✺',
    desc: 'Çarpınca patlar; çevreyi yakar.',
    r: 8,
    mass: 1,
    restitution: 0.28,
    tangent: 0.72,
    dmgMul: 1,
    behavior: 'fire',
    color: COL.fire,
    trail: 'rgba(255,138,60,0.4)',
    explodeRadius: 70,
    explodePower: 4,
  },
  cluster: {
    id: 'cluster',
    name: 'Saçma',
    glyph: '✸',
    desc: 'Tepe noktasında üçe bölünür.',
    r: 8,
    mass: 1,
    restitution: 0.4,
    tangent: 0.78,
    dmgMul: 1,
    behavior: 'cluster',
    color: '#bcd45f',
    trail: 'rgba(188,212,95,0.3)',
    splitInto: 3,
  },
  keg: {
    id: 'keg',
    name: 'Barut fıçısı',
    glyph: '◍',
    desc: 'Devasa patlama; az bulunur.',
    r: 12,
    mass: 1.6,
    restitution: 0.2,
    tangent: 0.7,
    dmgMul: 1,
    behavior: 'keg',
    color: '#8a5a2a',
    trail: 'rgba(138,90,42,0.3)',
    explodeRadius: 95,
    explodePower: 7,
  },
  bolt: {
    id: 'bolt',
    name: 'Delici ok',
    glyph: '➶',
    desc: 'Çok hızlı, düz; üst üste birkaç bloğu deler.',
    r: 5,
    mass: 1.2,
    restitution: 0.1,
    tangent: 0.95,
    dmgMul: 1.6,
    behavior: 'bolt',
    color: '#ded2a6',
    trail: 'rgba(222,210,166,0.35)',
    pierce: 3,
  },
};

export const AMMO_ORDER: AmmoId[] = ['stone', 'boulder', 'fire', 'cluster', 'keg', 'bolt'];

export function getAmmo(id: AmmoId): AmmoDef {
  return AMMO[id];
}

export function makeProjectile(
  ammo: AmmoId,
  x: number,
  y: number,
  vx: number,
  vy: number,
  shotId: number,
): Projectile {
  const def = AMMO[ammo];
  return {
    x,
    y,
    vx,
    vy,
    r: def.r,
    ammo,
    active: true,
    age: 0,
    restTimer: 0,
    pierceLeft: def.pierce ?? 0,
    hasSplit: false,
    exploded: false,
    shotId,
    rot: 0,
  };
}
