// Projectile physics: sub-stepped integration (swept for fast ammo → no
// tunneling), circle-vs-AABB collision, and per-ammo response. Reads/writes
// S.projectiles and damages blocks via blocks.ts.

import { S } from './state';
import {
  DMG_CAP,
  DMG_STEP,
  GRAVITY,
  GROUND_Y,
  H,
  HIT_MIN_SPEED,
  MAX_SHOT_TIME,
  REST_EPS,
  REST_TIME,
  W,
  clamp,
} from './constants';
import type { Block, Projectile } from './types';
import { AMMO, makeProjectile } from './ammo';
import { blockRect, damageBlock, explode } from './blocks';
import { spawnDebris } from './fx';
import * as audio from './audio';

export function gravScale(ammo: Projectile['ammo']): number {
  if (ammo === 'boulder') return 1.12;
  if (ammo === 'bolt') return 0.62;
  if (ammo === 'keg') return 1.05;
  return 1;
}

function speedOf(p: Projectile): number {
  return Math.hypot(p.vx, p.vy);
}

export function projectilesActive(): boolean {
  for (const p of S.projectiles) if (p.active) return true;
  return false;
}

function baseDamage(speed: number, ap: boolean): number {
  if (speed < HIT_MIN_SPEED) return ap ? 1 : 0;
  return clamp(1 + Math.floor((speed - HIT_MIN_SPEED) / DMG_STEP), 1, DMG_CAP);
}

function pushAlongVelocity(p: Projectile, dist: number): void {
  const s = speedOf(p);
  if (s < 1) return;
  p.x += (p.vx / s) * dist;
  p.y += (p.vy / s) * dist;
}

// Returns true if the substep loop should stop (projectile bounced/stopped/gone).
function handleHit(p: Projectile, b: Block): boolean {
  const r = blockRect(b);
  const cx = clamp(p.x, r.x, r.x + r.w);
  const cy = clamp(p.y, r.y, r.y + r.h);
  let dx = p.x - cx;
  let dy = p.y - cy;
  let d2 = dx * dx + dy * dy;
  if (d2 > p.r * p.r) return false; // no overlap

  const def = AMMO[p.ammo];
  const impact = speedOf(p);

  // Explosive ammo detonates on first solid contact.
  if (def.behavior === 'fire' || def.behavior === 'keg') {
    explode(p.x, p.y, def.explodeRadius ?? 60, def.explodePower ?? 4);
    p.active = false;
    p.exploded = true;
    return true;
  }

  const ap = def.behavior === 'boulder' || def.behavior === 'bolt';
  const dmg = Math.round(baseDamage(impact, ap) * def.dmgMul);
  const wasGlass = b.kind === 'glass';
  damageBlock(b, dmg, ap);
  const destroyed = !b.alive;
  audio.sfxImpact(impact);

  // Pierce: bolt passes through destroyed/glass blocks.
  if (def.behavior === 'bolt' && p.pierceLeft > 0 && (destroyed || wasGlass)) {
    p.pierceLeft -= 1;
    p.vx *= 0.9;
    p.vy *= 0.9;
    pushAlongVelocity(p, p.r * 2 + 2);
    return true;
  }
  // Glass lets any shot pass with a little energy loss.
  if (wasGlass && destroyed) {
    p.vx *= 0.85;
    p.vy *= 0.85;
    pushAlongVelocity(p, p.r * 2 + 2);
    return true;
  }

  // Bounce off the block.
  let nx: number;
  let ny: number;
  let pen: number;
  if (d2 > 1e-6) {
    const d = Math.sqrt(d2);
    nx = dx / d;
    ny = dy / d;
    pen = p.r - d;
  } else {
    const left = p.x - r.x;
    const right = r.x + r.w - p.x;
    const top = p.y - r.y;
    const bot = r.y + r.h - p.y;
    const m = Math.min(left, right, top, bot);
    if (m === left) {
      nx = -1;
      ny = 0;
      pen = left + p.r;
    } else if (m === right) {
      nx = 1;
      ny = 0;
      pen = right + p.r;
    } else if (m === top) {
      nx = 0;
      ny = -1;
      pen = top + p.r;
    } else {
      nx = 0;
      ny = 1;
      pen = bot + p.r;
    }
  }
  p.x += nx * pen;
  p.y += ny * pen;
  const vn = p.vx * nx + p.vy * ny;
  if (vn < 0) {
    const vtx = p.vx - vn * nx;
    const vty = p.vy - vn * ny;
    p.vx = vtx * def.tangent - def.restitution * vn * nx;
    p.vy = vty * def.tangent - def.restitution * vn * ny;
  }
  void dx;
  void dy;
  return true;
}

function firstHit(p: Projectile): boolean {
  for (const b of S.blocks) {
    if (!b.alive) continue;
    if (handleHit(p, b)) return true;
  }
  return false;
}

function maybeSplit(p: Projectile): void {
  const def = AMMO[p.ammo];
  if (def.behavior !== 'cluster' || p.hasSplit) return;
  if (p.age < 0.12 || p.vy < 0) return; // split at/after apex
  const n = def.splitInto ?? 3;
  const speed = speedOf(p);
  const base = Math.atan2(p.vy, p.vx);
  p.hasSplit = true;
  p.r = 6;
  for (let k = 0; k < n; k++) {
    const off = (k - (n - 1) / 2) * 0.22;
    const ang = base + off;
    if (k === 0) {
      p.vx = Math.cos(ang) * speed;
      p.vy = Math.sin(ang) * speed;
    } else {
      const np = makeProjectile('cluster', p.x, p.y, Math.cos(ang) * speed, Math.sin(ang) * speed, p.shotId);
      np.hasSplit = true;
      np.r = 6;
      S.projectiles.push(np);
    }
  }
}

function integrate(p: Projectile, dt: number): void {
  const g = GRAVITY * gravScale(p.ammo);
  const speed = speedOf(p);
  const steps = clamp(Math.ceil((speed * dt) / (p.r * 0.8)), 1, 6);
  const sdt = dt / steps;
  for (let i = 0; i < steps; i++) {
    p.vy += g * sdt;
    p.x += p.vx * sdt;
    p.y += p.vy * sdt;
    p.rot += (p.vx >= 0 ? 1 : -1) * speedOf(p) * sdt * 0.04;
    if (firstHit(p)) {
      if (!p.active) return;
    }
    if (p.y + p.r > GROUND_Y) {
      p.y = GROUND_Y - p.r;
      const def = AMMO[p.ammo];
      if (def.behavior === 'fire' || def.behavior === 'keg') {
        explode(p.x, GROUND_Y, def.explodeRadius ?? 60, def.explodePower ?? 4);
        p.active = false;
        p.exploded = true;
        return;
      }
      if (p.vy > 0) {
        if (Math.abs(p.vy) > 80) {
          spawnDebris(p.x, GROUND_Y, 'rgba(120,100,70,0.8)', 3, 70);
          audio.sfxImpact(Math.abs(p.vy));
        }
        p.vy = -p.vy * def.restitution;
      }
      p.vx *= 0.85;
    }
  }
  if (speedOf(p) < REST_EPS) p.restTimer += dt;
  else p.restTimer = 0;
}

function spent(p: Projectile): boolean {
  if (p.x < -40 || p.x > W + 40 || p.y > H + 80) return true;
  if (p.age > MAX_SHOT_TIME) return true;
  return p.restTimer > REST_TIME;
}

export function stepProjectiles(dt: number): void {
  for (const p of S.projectiles) {
    if (!p.active) continue;
    p.age += dt;
    integrate(p, dt);
    if (!p.active) continue;
    maybeSplit(p);
    if (spent(p)) p.active = false;
  }
}
