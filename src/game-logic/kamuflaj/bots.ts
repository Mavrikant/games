// Bot minds. Bots fill every empty slot so the arena is always full, online or
// off. They write into each bot's InputState exactly like a human would, then
// world.step() consumes it — bots and humans share one code path (pitfall:
// designed-lose-condition-not-wired is avoided because bots actually play both
// roles to a finish).

import {
  ARENA_R,
  REVEAL_DIST,
  SAMPLE_RANGE,
  TONGUE_RANGE,
} from './constants';
import type { Player, PropSpec, World } from './types';

interface Mind {
  prop: number; // hider: chosen cover prop index (-1 = none)
  sampleCd: number; // throttle eyedropper edges
  fireCd: number; // seeker: throttle tongue edges
  retarget: number; // seconds until the next decision
  targetId: string | null; // seeker: current quarry
  wanderX: number;
  wanderZ: number;
}

const minds = new Map<string, Mind>();

export function resetBotMinds(): void {
  minds.clear();
}

function mindOf(id: string): Mind {
  let m = minds.get(id);
  if (!m) {
    m = { prop: -1, sampleCd: 0, fireCd: 0, retarget: 0, targetId: null, wanderX: 0, wanderZ: 0 };
    minds.set(id, m);
  }
  return m;
}

function moveToward(p: Player, x: number, z: number): void {
  const dx = x - p.x;
  const dz = z - p.z;
  const d = Math.hypot(dx, dz);
  if (d < 0.001) {
    p.input.mx = 0;
    p.input.mz = 0;
    return;
  }
  p.input.mx = dx / d;
  p.input.mz = dz / d;
}

/** A hug point just outside a prop's rim, on the side away from arena centre. */
function hugSpot(pr: PropSpec): { x: number; z: number } {
  const a = Math.atan2(pr.z, pr.x);
  const reach = pr.r + 1.0;
  return { x: pr.x + Math.cos(a) * reach, z: pr.z + Math.sin(a) * reach };
}

function nearestProp(world: World, x: number, z: number): number {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < world.props.length; i++) {
    const pr = world.props[i]!;
    const d = Math.hypot(pr.x - x, pr.z - z);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

function driveHider(world: World, p: Player, m: Mind, dt: number): void {
  m.sampleCd -= dt;
  const seeking = world.status === 'hunt';

  // Flee if a seeker is close and pointed at us.
  if (seeking) {
    for (const s of world.players) {
      if (s.role !== 'seeker' || s.caught) continue;
      const dx = p.x - s.x;
      const dz = p.z - s.z;
      const d = Math.hypot(dx, dz);
      const fx = Math.sin(s.yaw);
      const fz = Math.cos(s.yaw);
      const facing = d > 0.001 && (fx * -dx + fz * -dz) / d > 0.3;
      if (d < REVEAL_DIST + 1 && facing) {
        // Bolt to a different prop, away from this seeker.
        m.prop = pickEscapeProp(world, p, s.x, s.z);
        break;
      }
    }
  }

  if (m.prop < 0 || m.prop >= world.props.length) {
    m.prop = nearestProp(world, p.x, p.z);
  }
  const pr = world.props[m.prop];
  if (!pr) {
    p.input.mx = p.input.mz = 0;
    return;
  }
  const spot = hugSpot(pr);
  const dist = Math.hypot(spot.x - p.x, spot.z - p.z);
  if (dist > 0.8) {
    moveToward(p, spot.x, spot.z);
  } else {
    // Arrived: stand still and paint to the prop's hue.
    p.input.mx = p.input.mz = 0;
    const gap = Math.hypot(pr.x - p.x, pr.z - p.z) - pr.r;
    if (gap < SAMPLE_RANGE && m.sampleCd <= 0) {
      p.input.fire = true;
      m.sampleCd = 1.5;
    }
  }
}

function pickEscapeProp(world: World, p: Player, sx: number, sz: number): number {
  let best = -1;
  let bestScore = -Infinity;
  for (let i = 0; i < world.props.length; i++) {
    const pr = world.props[i]!;
    const fromSeeker = Math.hypot(pr.x - sx, pr.z - sz);
    const toMe = Math.hypot(pr.x - p.x, pr.z - p.z);
    if (toMe < 0.5) continue;
    const score = fromSeeker - toMe * 0.6;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best >= 0 ? best : nearestProp(world, p.x, p.z);
}

function driveSeeker(world: World, p: Player, m: Mind, dt: number): void {
  if (world.status !== 'hunt') {
    p.input.mx = p.input.mz = 0;
    return;
  }
  m.fireCd -= dt;
  m.retarget -= dt;

  // Pick the most detectable hider, else wander.
  let target: Player | null = null;
  let bestVis = 0.18;
  for (const h of world.players) {
    if (h.role !== 'hider' || h.caught) continue;
    const d = Math.hypot(h.x - p.x, h.z - p.z);
    // Closer + more visible = more tempting; sight falls off with distance.
    const detect = h.visible * (1 - Math.min(1, d / (REVEAL_DIST * 2.4)));
    if (detect > bestVis) {
      bestVis = detect;
      target = h;
    }
  }

  if (target) {
    m.targetId = target.id;
    p.input.aimX = target.x;
    p.input.aimZ = target.z;
    const d = Math.hypot(target.x - p.x, target.z - p.z);
    if (d > TONGUE_RANGE * 0.7) {
      moveToward(p, target.x, target.z);
    } else {
      // In range: stop, line up, lash.
      p.input.mx = p.input.mz = 0;
      if (m.fireCd <= 0) {
        p.input.fire = true;
        m.fireCd = 1.3;
      }
    }
  } else {
    if (m.retarget <= 0) {
      const ang = Math.random() * Math.PI * 2;
      const rad = 4 + Math.random() * (ARENA_R - 6);
      m.wanderX = Math.cos(ang) * rad;
      m.wanderZ = Math.sin(ang) * rad;
      m.retarget = 2.2 + Math.random() * 1.8;
    }
    moveToward(p, m.wanderX, m.wanderZ);
    p.input.aimX = p.x + p.input.mx * 6;
    p.input.aimZ = p.z + p.input.mz * 6;
  }
}

export function driveBots(world: World, dt: number): void {
  for (const p of world.players) {
    if (!p.bot || p.caught) continue;
    const m = mindOf(p.id);
    if (p.role === 'hider') driveHider(world, p, m, dt);
    else driveSeeker(world, p, m, dt);
  }
}
