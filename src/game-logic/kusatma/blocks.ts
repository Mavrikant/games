// Blocks: the single blockRect() source (draw + collide), level build, the
// per-column gravity settle, damage/destroy with combo scoring, and the AoE
// explosion with TNT chain reactions.

import { S } from './state';
import {
  BLOCK,
  CASTLE_X,
  GROUND_Y,
  HP,
  MAX_CHAIN_DEPTH,
  SCORE,
  SUPPLY_REFUND,
  TNT_POWER,
  TNT_RADIUS,
  COL,
  clamp,
} from './constants';
import type { Block, Kind, LevelDef } from './types';
import { spawnDebris, spawnSparks, addShake, addPopup } from './fx';
import * as audio from './audio';
import { renderHud } from './ui';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function targetTop(row: number): number {
  return GROUND_Y - (row + 1) * BLOCK;
}

export function blockRect(b: Block, visual = false): Rect {
  return {
    x: CASTLE_X + b.col * BLOCK,
    y: visual ? b.drawY : targetTop(b.row),
    w: BLOCK,
    h: BLOCK,
  };
}

export function blockCenter(b: Block, visual = false): { x: number; y: number } {
  const r = blockRect(b, visual);
  return { x: r.x + BLOCK / 2, y: r.y + BLOCK / 2 };
}

export function buildLevel(level: LevelDef): void {
  const blocks: Block[] = [];
  for (const c of level.cols) {
    for (let r = 0; r < c.stack.length; r++) {
      const kind = c.stack[r]!;
      blocks.push({
        col: c.col,
        row: r,
        kind,
        hp: HP[kind],
        maxHp: HP[kind],
        drawY: targetTop(r),
        alive: true,
        flash: 0,
      });
    }
  }
  S.blocks = blocks;
  S.targetsLeft = blocks.filter((b) => b.kind === 'target').length;
  S.startBlocks = blocks.length;
}

export function dustColor(kind: Kind): string {
  switch (kind) {
    case 'wood':
      return COL.wood;
    case 'iron':
      return COL.iron;
    case 'tnt':
      return COL.tntTop;
    case 'glass':
      return COL.glassTop;
    case 'supply':
      return COL.supplyTop;
    case 'target':
      return COL.banner;
    default:
      return COL.stone;
  }
}

function comboMultiplier(): number {
  return 1 + 0.18 * Math.min(S.shotDestroyed, 6);
}

function destroyBlock(b: Block, depth: number): void {
  if (!b.alive) return;
  b.alive = false;
  S.shotDestroyed += 1;
  if (S.shotDestroyed > S.bestChainThisLevel) S.bestChainThisLevel = S.shotDestroyed;

  const mult = comboMultiplier();
  S.score += Math.round(SCORE[b.kind] * mult);

  const c = blockCenter(b, true);
  if (b.kind === 'supply') {
    S.ammoCounts.stone += SUPPLY_REFUND;
    addPopup(c.x, c.y - 6, '+2 taş', COL.supplyTop, 15);
    audio.sfxSupply();
  } else if (b.kind === 'target') {
    S.targetsLeft = Math.max(0, S.targetsLeft - 1);
    addPopup(c.x, c.y - 6, 'Sancak!', COL.banner, 17);
    audio.sfxTarget();
    addShake(4);
  } else {
    audio.sfxBreak(b.kind);
  }

  if (S.shotDestroyed >= 3) {
    addPopup(c.x, c.y - 18, `x${S.shotDestroyed}!`, COL.fireCore, 16 + Math.min(8, S.shotDestroyed));
  }

  spawnDebris(c.x, c.y, dustColor(b.kind), b.kind === 'glass' ? 16 : 12, b.kind === 'iron' ? 150 : 190);
  if (b.kind === 'glass') spawnSparks(c.x, c.y, COL.glassTop, 8);

  renderHud();

  if (b.kind === 'tnt' && depth < MAX_CHAIN_DEPTH) {
    explode(c.x, c.y, TNT_RADIUS, TNT_POWER, depth + 1);
  }
}

export function damageBlock(b: Block, dmg: number, ap: boolean, depth = 0): void {
  if (!b.alive || dmg <= 0) return;
  // Iron shrugs off non-armor-piercing contact (needs boulder/bolt/explosion).
  if (b.kind === 'iron' && !ap) {
    b.flash = 1;
    const c = blockCenter(b, true);
    spawnSparks(c.x, c.y, COL.ironTop, 5);
    return;
  }
  b.hp -= dmg;
  b.flash = 1;
  if (b.hp <= 0) {
    destroyBlock(b, depth);
  } else {
    const c = blockCenter(b, true);
    spawnDebris(c.x, c.y, dustColor(b.kind), 4, 90);
  }
}

export function explode(
  x: number,
  y: number,
  radius: number,
  power: number,
  depth = 0,
): void {
  addShake(clamp(power * 0.9, 2, 14));
  spawnDebris(x, y, COL.fire, 22, 230);
  spawnSparks(x, y, COL.fireCore, 14);
  audio.sfxExplode(radius >= 80);
  for (const b of S.blocks) {
    if (!b.alive) continue;
    const r = blockRect(b);
    const cx = clamp(x, r.x, r.x + r.w);
    const cy = clamp(y, r.y, r.y + r.h);
    const d = Math.hypot(x - cx, y - cy);
    if (d > radius) continue;
    const falloff = 1 - d / radius;
    const dmg = Math.max(1, Math.ceil(power * falloff));
    damageBlock(b, dmg, true, depth);
  }
}

export function settle(): void {
  const byCol = new Map<number, Block[]>();
  for (const b of S.blocks) {
    const arr = byCol.get(b.col);
    if (arr) arr.push(b);
    else byCol.set(b.col, [b]);
  }
  for (const arr of byCol.values()) {
    arr.sort((a, c) => a.row - c.row);
    for (let i = 0; i < arr.length; i++) arr[i]!.row = i;
  }
}

export function easeBlocks(dt: number): void {
  const k = Math.min(1, dt * 14);
  for (const b of S.blocks) {
    const t = targetTop(b.row);
    const d = t - b.drawY;
    if (Math.abs(d) < 0.5) b.drawY = t;
    else b.drawY += d * k;
    if (b.flash > 0) b.flash = Math.max(0, b.flash - dt * 5);
  }
}

export function allSettled(): boolean {
  for (const b of S.blocks) {
    if (Math.abs(b.drawY - targetTop(b.row)) > 0.6) return false;
  }
  return true;
}

export function aliveBlocks(): number {
  let n = 0;
  for (const b of S.blocks) if (b.alive) n++;
  return n;
}
