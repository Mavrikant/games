// Bot steering. Bots are ordinary crafts whose InputState is synthesized
// each tick on whichever machine runs the simulation (host or offline).
// Priorities: don't fall off > fling a vulnerable rival > chase orbs
// (slingshotting between islands when the orb is elsewhere).

import { CRAFT_R, HOOK_RANGE } from './constants';
import { islandAt, liveOf } from './world';
import type { Craft, World } from './types';

interface BotMind {
  holdUntil: number; // sim time to keep the hook held until
  nextHookAt: number; // earliest sim time for the next hook decision
  aggression: number; // 0.7..1.1 temperament scalar
}

const minds = new Map<string, BotMind>();

function mindOf(id: string): BotMind {
  let m = minds.get(id);
  if (!m) {
    m = { holdUntil: 0, nextHookAt: 0, aggression: 0.7 + Math.random() * 0.4 };
    minds.set(id, m);
  }
  return m;
}

/** Distance from the live rim of the island under (x,z); Infinity over void. */
function rimDistance(world: World, x: number, z: number): number {
  const idx = islandAt(world, x, z);
  if (idx < 0) return -1;
  const isl = world.islands[idx]!;
  const r = isl.r * liveOf(isl, world.t);
  return r - Math.hypot(x - isl.x, z - isl.z);
}

function steerTo(c: Craft, tx: number, tz: number): void {
  const dx = tx - c.x;
  const dz = tz - c.z;
  const d = Math.hypot(dx, dz);
  if (d < 0.3) {
    c.input.mx = 0;
    c.input.mz = 0;
    return;
  }
  c.input.mx = dx / d;
  c.input.mz = dz / d;
}

function nearestOrb(world: World, c: Craft): { x: number; z: number; island: number } | null {
  let best: { x: number; z: number; island: number } | null = null;
  let bestD = Infinity;
  for (const orb of world.orbs) {
    const d = Math.hypot(orb.x - c.x, orb.z - c.z);
    if (d < bestD) {
      bestD = d;
      best = { x: orb.x, z: orb.z, island: orb.island };
    }
  }
  return best;
}

function driveBot(world: World, c: Craft): void {
  const mind = mindOf(c.id);
  const t = world.t;
  c.input.fire = false;
  c.input.release = false;

  // Manage an ongoing hook: hold until the planned time, then let go.
  if (c.hook) {
    if (t >= mind.holdUntil) {
      c.input.held = false;
      c.input.release = true;
    } else {
      c.input.held = true;
    }
  } else {
    c.input.held = false;
  }

  const myIsland = islandAt(world, c.x, c.z);
  const rim = rimDistance(world, c.x, c.z);

  // 0) Over the void: emergency — hook the nearest healthy island and reel.
  if (myIsland < 0) {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < world.islands.length; i++) {
      const isl = world.islands[i]!;
      if (liveOf(isl, t) < 0.5) continue;
      const d = Math.hypot(isl.x - c.x, isl.z - c.z);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0) {
      const isl = world.islands[best]!;
      c.input.aimX = isl.x;
      c.input.aimZ = isl.z;
      steerTo(c, isl.x, isl.z);
      if (!c.hook && c.hookCd <= 0) {
        c.input.fire = true;
        c.input.held = true;
        mind.holdUntil = t + 1.5;
      } else if (c.hook) {
        c.input.held = true; // keep reeling, this is the rescue
        mind.holdUntil = Math.max(mind.holdUntil, t + 1);
      }
    }
    return;
  }

  const here = world.islands[myIsland]!;

  // 1) Edge / collapse safety: pull back toward the island heart.
  const sinking = liveOf(here, t) < 0.95;
  if (rim < 2.5 || (sinking && liveOf(here, t) < 0.6)) {
    if (sinking) {
      // Island going down: hop toward the center island.
      const home = world.islands[0]!;
      c.input.aimX = home.x;
      c.input.aimZ = home.z;
      steerTo(c, home.x, home.z);
      if (!c.hook && c.hookCd <= 0 && Math.hypot(home.x - c.x, home.z - c.z) < HOOK_RANGE + home.r) {
        c.input.fire = true;
        c.input.held = true;
        mind.holdUntil = t + 1.6;
      }
    } else {
      steerTo(c, here.x, here.z);
      if (c.hook && c.hook.kind === 'rock') {
        c.input.held = false;
        c.input.release = true;
      }
    }
    return;
  }

  // 2) Fling opportunity: fast + a rival near an edge + hook ready.
  const mySpeed = Math.hypot(c.vx, c.vz);
  if (!c.hook && c.hookCd <= 0 && t >= mind.nextHookAt && mySpeed > 10 * mind.aggression) {
    for (const v of world.crafts) {
      if (v === c || !v.alive || v.protectIn > 0) continue;
      const d = Math.hypot(v.x - c.x, v.z - c.z);
      if (d > HOOK_RANGE * 0.8 || d < CRAFT_R * 3) continue;
      const vRim = rimDistance(world, v.x, v.z);
      if (vRim >= 0 && vRim < 4.5) {
        c.input.aimX = v.x;
        c.input.aimZ = v.z;
        c.input.fire = true;
        c.input.held = true;
        mind.holdUntil = t + 0.6 * mind.aggression;
        mind.nextHookAt = t + 2.5 / mind.aggression;
        return;
      }
    }
  }

  // 3) Orbs: drive to it; slingshot across when it's on another island.
  const orb = nearestOrb(world, c);
  if (!orb) {
    steerTo(c, here.x, here.z);
    return;
  }
  steerTo(c, orb.x, orb.z);
  if (orb.island !== myIsland && !c.hook && c.hookCd <= 0 && t >= mind.nextHookAt) {
    const target = world.islands[orb.island];
    if (target && liveOf(target, t) > 0.4) {
      const d = Math.hypot(target.x - c.x, target.z - c.z);
      if (d < HOOK_RANGE + target.r * liveOf(target, t)) {
        c.input.aimX = target.x;
        c.input.aimZ = target.z;
        c.input.fire = true;
        c.input.held = true;
        mind.holdUntil = t + 1.2;
        mind.nextHookAt = t + 1.8;
      }
    }
  }
}

/** Fill InputState for every living bot craft. Call right before step(). */
export function driveBots(world: World): void {
  for (const c of world.crafts) {
    if (c.bot && c.alive) driveBot(world, c);
  }
}

/** Forget temperaments/timers between matches. */
export function resetBotMinds(): void {
  minds.clear();
}
