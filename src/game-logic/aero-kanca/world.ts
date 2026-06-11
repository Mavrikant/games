// Pure-data simulation. No three.js, no DOM, no storage — runs identically
// on the host, in offline bot matches, and in the headless smoke test
// (where WebGL may be absent). scene.ts renders FROM this state; both sides
// read the same constants (pitfall: visual-vs-hitbox).

import {
  ACCEL,
  CENTER_R,
  COLLAPSE_DROP,
  COLLAPSE_DUR_S,
  COLLAPSE_GAP_S,
  COLLAPSE_START_S,
  COMMIT_DEPTH,
  COUNTDOWN_S,
  CRAFT_R,
  CREDIT_S,
  DRAG,
  FEED_MAX,
  FLING_MULT,
  GRAVITY,
  HOOK_CD_S,
  HOOK_MAX_S,
  HOOK_RANGE,
  HOVER_DAMP,
  HOVER_H,
  HOVER_K,
  ISLAND_COUNT,
  ISLAND_MAX_R,
  ISLAND_MIN_R,
  KO_PTS,
  KO_Y,
  LATCH_PULL,
  LATCH_S,
  MATCH_S,
  MAX_SPEED,
  ORB_COUNT,
  ORB_HOVER,
  ORB_PTS,
  ORB_R,
  PALETTE,
  PROTECT_S,
  REEL_RATE,
  REST,
  RESPAWN_S,
  RING_DIST,
  ROPE_K,
  ROPE_MIN,
} from './constants';
import type { Craft, InputState, IslandSpec, Orb, World } from './types';

// ---- islands ----------------------------------------------------------------

export function makeIslands(): IslandSpec[] {
  const islands: IslandSpec[] = [
    // Central island: largest, never collapses — the endgame stage.
    { x: 0, z: 0, r: CENTER_R, topY: 0, collapseAt: Infinity, seed: Math.random() * 1000 },
  ];
  const ring = ISLAND_COUNT - 1;
  // Outer islands collapse smallest-first so the arena shrinks inward.
  const order = Array.from({ length: ring }, (_, i) => i).sort(() => Math.random() - 0.5);
  for (let i = 0; i < ring; i++) {
    const a = (i / ring) * Math.PI * 2 + Math.random() * 0.4;
    const r = ISLAND_MIN_R + Math.random() * (ISLAND_MAX_R - ISLAND_MIN_R);
    islands.push({
      x: Math.cos(a) * (RING_DIST + Math.random() * 8),
      z: Math.sin(a) * (RING_DIST + Math.random() * 8),
      r,
      topY: (Math.random() - 0.5) * 3,
      collapseAt: COLLAPSE_START_S + (order[i] ?? i) * COLLAPSE_GAP_S,
      seed: Math.random() * 1000,
    });
  }
  return islands;
}

/** Collapse progress: 1 = intact, 0 = fully sunk. */
export function liveOf(isl: IslandSpec, t: number): number {
  if (t < isl.collapseAt) return 1;
  return Math.max(0, 1 - (t - isl.collapseAt) / COLLAPSE_DUR_S);
}

/** Current surface height, after any collapse descent. */
export function effTop(isl: IslandSpec, t: number): number {
  return isl.topY - (1 - liveOf(isl, t)) * COLLAPSE_DROP;
}

/** Index of the island under (x,z) — radius shrinks as the island sinks. */
export function islandAt(world: World, x: number, z: number): number {
  for (let i = 0; i < world.islands.length; i++) {
    const isl = world.islands[i]!;
    const live = liveOf(isl, world.t);
    if (live <= 0) continue;
    const dx = x - isl.x;
    const dz = z - isl.z;
    if (dx * dx + dz * dz < isl.r * live * (isl.r * live)) return i;
  }
  return -1;
}

// ---- world construction --------------------------------------------------------

export function freshInput(): InputState {
  return { mx: 0, mz: 0, aimX: 0, aimZ: 0, fire: false, held: false, release: false };
}

export function makeCraft(id: string, name: string, hue: number, bot: boolean): Craft {
  return {
    id,
    name,
    hue,
    bot,
    x: 0,
    y: HOVER_H,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    yaw: 0,
    alive: true,
    respawnIn: 0,
    protectIn: 0,
    hookCd: 0,
    hook: null,
    pts: 0,
    kos: 0,
    lastHitBy: null,
    lastHitAge: 0,
    input: freshInput(),
  };
}

export function freshWorld(): World {
  return {
    status: 'menu',
    mode: 'idle',
    t: 0,
    count: 0,
    left: MATCH_S,
    islands: makeIslands(),
    crafts: [],
    orbs: [],
    feed: [],
    winner: null,
  };
}

function spawnPoint(world: World, idx: number, total: number): { x: number; y: number; z: number } {
  // Spread starting crafts around the central island's rim.
  const c = world.islands[0]!;
  const a = (idx / Math.max(1, total)) * Math.PI * 2;
  const d = c.r * 0.55;
  return { x: c.x + Math.cos(a) * d, y: c.topY + HOVER_H, z: c.z + Math.sin(a) * d };
}

export function placeOrb(world: World, orb: Orb): void {
  // Pick a random island that is still (mostly) alive.
  const alive: number[] = [];
  for (let i = 0; i < world.islands.length; i++) {
    if (liveOf(world.islands[i]!, world.t) > 0.5) alive.push(i);
  }
  const idx = alive[Math.floor(Math.random() * alive.length)] ?? 0;
  const isl = world.islands[idx]!;
  const a = Math.random() * Math.PI * 2;
  const d = Math.sqrt(Math.random()) * isl.r * 0.7;
  orb.island = idx;
  orb.x = isl.x + Math.cos(a) * d;
  orb.z = isl.z + Math.sin(a) * d;
  orb.y = effTop(isl, world.t) + ORB_HOVER;
}

/** (Re)build crafts + orbs for a match. Roster order fixes hues/slots. */
export function setupMatch(
  world: World,
  roster: { id: string; name: string; hue?: number; bot: boolean }[],
): void {
  world.t = 0;
  world.count = COUNTDOWN_S;
  world.left = MATCH_S;
  world.status = 'countdown';
  world.winner = null;
  world.feed = [];
  world.islands = makeIslands();
  world.crafts = roster.map((r, i) => {
    const c = makeCraft(r.id, r.name, r.hue ?? PALETTE[i % PALETTE.length]!, r.bot);
    const p = spawnPoint(world, i, roster.length);
    c.x = p.x;
    c.y = p.y;
    c.z = p.z;
    c.yaw = Math.atan2(-c.x, -c.z);
    return c;
  });
  world.orbs = Array.from({ length: ORB_COUNT }, () => {
    const orb: Orb = { x: 0, y: 0, z: 0, island: 0 };
    placeOrb(world, orb);
    return orb;
  });
}

export function addFeed(world: World, line: string): void {
  world.feed.unshift(line);
  if (world.feed.length > FEED_MAX) world.feed.length = FEED_MAX;
}

// ---- hook hitscan ----------------------------------------------------------------

function craftById(world: World, id: string | null): Craft | null {
  if (id === null) return null;
  for (const c of world.crafts) if (c.id === id) return c;
  return null;
}

/**
 * Instant 2D (XZ-plane) hitscan from `shooter` toward its aim point.
 * Crafts are tested first (generous radius), then island rims.
 */
export function fireHook(world: World, shooter: Craft): void {
  if (shooter.hookCd > 0 || shooter.hook) return;
  shooter.hookCd = HOOK_CD_S;
  const dx0 = shooter.input.aimX - shooter.x;
  const dz0 = shooter.input.aimZ - shooter.z;
  const len0 = Math.hypot(dx0, dz0);
  if (len0 < 0.01) return;
  const dirX = dx0 / len0;
  const dirZ = dz0 / len0;

  // 1) Crafts: closest ray-point distance within range.
  let bestT = Infinity;
  let victim: Craft | null = null;
  for (const c of world.crafts) {
    if (c === shooter || !c.alive || c.protectIn > 0) continue;
    const rx = c.x - shooter.x;
    const rz = c.z - shooter.z;
    const t = rx * dirX + rz * dirZ; // projection along the ray
    if (t < 0 || t > HOOK_RANGE) continue;
    const px = rx - dirX * t;
    const pz = rz - dirZ * t;
    if (px * px + pz * pz < CRAFT_R * 1.8 * (CRAFT_R * 1.8) && t < bestT) {
      bestT = t;
      victim = c;
    }
  }
  if (victim) {
    shooter.hook = {
      kind: 'craft',
      x: victim.x,
      y: victim.y,
      z: victim.z,
      victimId: victim.id,
      len: bestT,
      age: 0,
    };
    victim.lastHitBy = shooter.id;
    victim.lastHitAge = 0;
    return;
  }

  // 2) Islands: ray vs circle (rim), nearest entry point within range. The
  // island under the shooter is skipped — the hook flies above the rock you
  // stand on, otherwise it would always win as the nearest hit and make
  // cross-island shots impossible.
  let hitT = Infinity;
  let hitIsl = -1;
  for (let i = 0; i < world.islands.length; i++) {
    const isl = world.islands[i]!;
    const live = liveOf(isl, world.t);
    if (live <= 0.05) continue;
    const r = isl.r * live;
    const cx = isl.x - shooter.x;
    const cz = isl.z - shooter.z;
    if (cx * cx + cz * cz < r * r) continue; // standing on / over this island
    const proj = cx * dirX + cz * dirZ;
    if (proj < 0) continue;
    const perp2 = cx * cx + cz * cz - proj * proj;
    if (perp2 > r * r) continue;
    const t = proj - Math.sqrt(r * r - perp2); // entry point on the rim
    if (t <= HOOK_RANGE && t < hitT) {
      hitT = t;
      hitIsl = i;
    }
  }
  if (hitIsl >= 0) {
    const isl = world.islands[hitIsl]!;
    const ax = shooter.x + dirX * hitT;
    const az = shooter.z + dirZ * hitT;
    const ay = effTop(isl, world.t);
    const dist = Math.hypot(ax - shooter.x, ay - shooter.y, az - shooter.z);
    shooter.hook = { kind: 'rock', x: ax, y: ay, z: az, victimId: null, len: dist, age: 0 };
  }
}

export function releaseHook(world: World, shooter: Craft): void {
  const hook = shooter.hook;
  if (!hook) return;
  if (hook.kind === 'craft') {
    const victim = craftById(world, hook.victimId);
    if (victim && victim.alive) {
      // The fling: victim inherits the attacker's momentum direction.
      const speed = Math.hypot(shooter.vx, shooter.vz);
      if (speed > 1) {
        const j = speed * FLING_MULT;
        victim.vx += (shooter.vx / speed) * j;
        victim.vz += (shooter.vz / speed) * j;
        victim.lastHitBy = shooter.id;
        victim.lastHitAge = 0;
      }
    }
  }
  shooter.hook = null;
}

// ---- per-step systems --------------------------------------------------------------

function applyHook(world: World, c: Craft, dt: number): void {
  const hook = c.hook;
  if (!hook) return;
  hook.age += dt;

  if (hook.kind === 'rock') {
    if (!c.input.held || hook.age > HOOK_MAX_S) {
      c.hook = null;
      return;
    }
    // Reel in while held — this is the slingshot speed source.
    hook.len = Math.max(ROPE_MIN, hook.len - REEL_RATE * dt);
    const dx = hook.x - c.x;
    const dy = hook.y - c.y;
    const dz = hook.z - c.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist > hook.len && dist > 0.01) {
      const f = (dist - hook.len) * ROPE_K * dt;
      c.vx += (dx / dist) * f;
      c.vy += (dy / dist) * f;
      c.vz += (dz / dist) * f;
    }
    return;
  }

  // kind === 'craft': drag the victim toward us, then fling on release/expiry.
  const victim = craftById(world, hook.victimId);
  if (!victim || !victim.alive) {
    c.hook = null;
    return;
  }
  hook.x = victim.x;
  hook.y = victim.y;
  hook.z = victim.z;
  if (!c.input.held || hook.age > LATCH_S) {
    releaseHook(world, c);
    return;
  }
  const dx = c.x - victim.x;
  const dz = c.z - victim.z;
  const dist = Math.hypot(dx, dz);
  if (dist > CRAFT_R * 2.5) {
    const f = LATCH_PULL * dt;
    victim.vx += (dx / dist) * f;
    victim.vz += (dz / dist) * f;
    victim.lastHitBy = c.id;
    victim.lastHitAge = 0;
  }
}

function bumpCrafts(world: World): void {
  const list = world.crafts;
  for (let i = 0; i < list.length; i++) {
    const a = list[i]!;
    if (!a.alive) continue;
    for (let j = i + 1; j < list.length; j++) {
      const b = list[j]!;
      if (!b.alive) continue;
      if (a.protectIn > 0 || b.protectIn > 0) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dz = b.z - a.z;
      const d = Math.hypot(dx, dy, dz);
      const minD = CRAFT_R * 2;
      if (d >= minD || d < 0.001) continue;
      const nx = dx / d;
      const ny = dy / d;
      const nz = dz / d;
      // Separate the overlap evenly.
      const push = (minD - d) / 2;
      a.x -= nx * push;
      a.z -= nz * push;
      b.x += nx * push;
      b.z += nz * push;
      // Exchange the normal velocity components (equal masses).
      const va = a.vx * nx + a.vy * ny + a.vz * nz;
      const vb = b.vx * nx + b.vy * ny + b.vz * nz;
      if (va - vb <= 0) continue; // already separating
      const ja = (vb - va) * REST;
      a.vx += nx * ja;
      a.vy += ny * ja;
      a.vz += nz * ja;
      b.vx -= nx * ja;
      b.vy -= ny * ja;
      b.vz -= nz * ja;
      a.lastHitBy = b.id;
      a.lastHitAge = 0;
      b.lastHitBy = a.id;
      b.lastHitAge = 0;
    }
  }
}

function stepCraft(world: World, c: Craft, dt: number): void {
  if (!c.alive) {
    c.respawnIn -= dt;
    if (c.respawnIn <= 0) {
      // Respawn on a random still-healthy island.
      const healthy: number[] = [];
      for (let i = 0; i < world.islands.length; i++) {
        if (liveOf(world.islands[i]!, world.t) > 0.6) healthy.push(i);
      }
      const idx = healthy[Math.floor(Math.random() * healthy.length)] ?? 0;
      const isl = world.islands[idx]!;
      const a = Math.random() * Math.PI * 2;
      const d = Math.sqrt(Math.random()) * isl.r * 0.5;
      c.x = isl.x + Math.cos(a) * d;
      c.z = isl.z + Math.sin(a) * d;
      c.y = effTop(isl, world.t) + HOVER_H;
      c.vx = 0;
      c.vy = 0;
      c.vz = 0;
      c.alive = true;
      c.protectIn = PROTECT_S;
      c.lastHitBy = null;
      c.hook = null;
    }
    return;
  }

  c.protectIn = Math.max(0, c.protectIn - dt);
  c.hookCd = Math.max(0, c.hookCd - dt);
  c.lastHitAge += dt;

  // Input edges.
  if (c.input.fire) fireHook(world, c);
  if (c.input.release) releaseHook(world, c);

  // Drive.
  const mlen = Math.hypot(c.input.mx, c.input.mz);
  if (mlen > 0.01) {
    c.vx += (c.input.mx / Math.max(1, mlen)) * ACCEL * dt;
    c.vz += (c.input.mz / Math.max(1, mlen)) * ACCEL * dt;
  }
  const drag = 1 / (1 + DRAG * dt);
  c.vx *= drag;
  c.vz *= drag;

  // Hook forces.
  applyHook(world, c, dt);

  // Hover spring over an island; gravity over the void.
  const idx = islandAt(world, c.x, c.z);
  if (idx >= 0) {
    const top = effTop(world.islands[idx]!, world.t);
    // Once well below the surface (and not roped), the fall is committed —
    // no popping back up through the rock. A taut rope can still save you.
    if (c.y > top - COMMIT_DEPTH || c.hook) {
      const target = top + HOVER_H;
      c.vy += (target - c.y) * HOVER_K * dt - c.vy * HOVER_DAMP * dt;
    } else {
      c.vy -= GRAVITY * dt;
    }
  } else {
    c.vy -= GRAVITY * dt;
  }

  // Speed cap: the rope can pump energy every step (that's the slingshot),
  // but uncapped it compounds into physics-breaking velocities.
  const sp0 = Math.hypot(c.vx, c.vz);
  if (sp0 > MAX_SPEED) {
    c.vx *= MAX_SPEED / sp0;
    c.vz *= MAX_SPEED / sp0;
  }
  c.vy = Math.max(-60, Math.min(60, c.vy));

  // Integrate.
  c.x += c.vx * dt;
  c.y += c.vy * dt;
  c.z += c.vz * dt;
  const sp = Math.hypot(c.vx, c.vz);
  if (sp > 0.8) c.yaw = Math.atan2(c.vx, c.vz);

  // Orb pickup.
  for (const orb of world.orbs) {
    const dx = orb.x - c.x;
    const dz = orb.z - c.z;
    if (dx * dx + dz * dz < ORB_R * ORB_R && Math.abs(orb.y - c.y) < 2.5) {
      c.pts += ORB_PTS;
      placeOrb(world, orb);
    }
  }

  // Knocked out?
  if (c.y < KO_Y) {
    c.alive = false;
    c.respawnIn = RESPAWN_S;
    c.hook = null;
    const killer = c.lastHitAge < CREDIT_S ? craftById(world, c.lastHitBy) : null;
    if (killer && killer !== c) {
      killer.pts += KO_PTS;
      killer.kos += 1;
      addFeed(world, `${killer.name} → ${c.name} boşluğa savruldu`);
    } else {
      addFeed(world, `${c.name} boşluğa düştü`);
    }
    // Anyone hooked onto the fallen craft loses their latch.
    for (const other of world.crafts) {
      if (other.hook && other.hook.victimId === c.id) other.hook = null;
    }
  }
}

/** Advance one fixed step. The caller fills every craft's `input` first. */
export function step(world: World, dt: number): void {
  if (world.status === 'countdown') {
    world.t += dt;
    world.count -= dt;
    if (world.count <= 0) {
      world.status = 'playing';
      world.t = 0; // collapse schedule counts from match start
    }
    return;
  }
  if (world.status !== 'playing' && world.status !== 'menu') return;

  world.t += dt;
  if (world.status === 'playing') {
    world.left = Math.max(0, world.left - dt);
  }

  for (const c of world.crafts) stepCraft(world, c, dt);
  bumpCrafts(world);

  // Keep orbs riding their (possibly sinking) island; relocate off dead ones.
  for (const orb of world.orbs) {
    const isl = world.islands[orb.island];
    if (!isl || liveOf(isl, world.t) < 0.3) placeOrb(world, orb);
    else orb.y = effTop(isl, world.t) + ORB_HOVER;
  }

  // Clear input edges (held/aim persist between frames).
  for (const c of world.crafts) {
    c.input.fire = false;
    c.input.release = false;
  }

  if (world.status === 'playing' && world.left <= 0) {
    world.status = 'over';
    let best: Craft | null = null;
    let tie = false;
    for (const c of world.crafts) {
      if (!best || c.pts > best.pts) {
        best = c;
        tie = false;
      } else if (c.pts === best.pts) {
        tie = true;
      }
    }
    world.winner = best && !tie ? best.name : '';
  }
}
