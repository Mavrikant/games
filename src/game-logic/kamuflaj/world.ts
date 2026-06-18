// Pure simulation: movement, camouflage scoring, the seeker tongue, the phase
// clock and win resolution. No three.js, no DOM, no networking — so the host
// runs it, bots drive it, and the headless smoke test exercises it without a
// GPU. The host broadcasts the resulting state; guests render snapshots.

import {
  ACCEL,
  ARENA_R,
  BLEND_RANGE,
  BLEND_RATE,
  CATCH_PTS,
  COUNTDOWN_S,
  FEED_MAX,
  FLOOR_HUE,
  HUE_TOLERANCE,
  HUNT_S,
  MOVE_SPEED,
  PAINT_EASE,
  PLAYER_R,
  PREP_S,
  PROP_COUNT,
  PROP_HUES,
  REVEAL_DIST,
  REVEAL_FOV,
  SAMPLE_RANGE,
  SEEKER_SPEED,
  STILL_SPEED,
  STILL_TIME,
  SURVIVE_PTS,
  TEAM_WIN_BONUS,
  TONGUE_CATCH_R,
  TONGUE_CD_S,
  TONGUE_MISS_CD_S,
  TONGUE_RANGE,
  TONGUE_SPEED,
  VIS_MIN,
  WALL_HUE,
} from './constants';
import type {
  InputState,
  Player,
  PropKind,
  PropSpec,
  Role,
  World,
} from './types';

export function freshInput(): InputState {
  return { mx: 0, mz: 0, aimX: 0, aimZ: 0, fire: false };
}

export function freshWorld(): World {
  return {
    status: 'menu',
    mode: 'idle',
    t: 0,
    phaseLeft: 0,
    props: [],
    players: [],
    feed: [],
    winner: null,
  };
}

export function makePlayer(
  id: string,
  name: string,
  role: Role,
  hue: number,
  bot: boolean,
): Player {
  return {
    id,
    name,
    role,
    bot,
    x: 0,
    z: 0,
    yaw: 0,
    vx: 0,
    vz: 0,
    bodyHue: hue,
    targetHue: hue,
    stillFor: 0,
    blend: 0,
    visible: 1,
    caught: false,
    tongueCd: 0,
    tongue: null,
    score: 0,
    catches: 0,
    input: freshInput(),
  };
}

// ---- deterministic RNG (seeded) --------------------------------------------
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

const PROP_KINDS: PropKind[] = ['crate', 'barrel', 'plant', 'rock', 'lamp'];

function makeProps(seed: number): PropSpec[] {
  const rand = mulberry32(seed);
  const props: PropSpec[] = [];
  let guard = 0;
  while (props.length < PROP_COUNT && guard < PROP_COUNT * 40) {
    guard++;
    const ang = rand() * Math.PI * 2;
    const rad = 3 + rand() * (ARENA_R - 5);
    const x = Math.cos(ang) * rad;
    const z = Math.sin(ang) * rad;
    const r = 0.9 + rand() * 1.5;
    // Keep props apart so cover spots read distinctly.
    let ok = true;
    for (const p of props) {
      if (Math.hypot(p.x - x, p.z - z) < p.r + r + 1.6) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const kind = PROP_KINDS[Math.floor(rand() * PROP_KINDS.length)]!;
    props.push({
      x,
      z,
      r,
      h: 1.4 + rand() * 2.6,
      hue: PROP_HUES[Math.floor(rand() * PROP_HUES.length)]!,
      kind,
      seed: Math.floor(rand() * 1e6),
    });
  }
  return props;
}

// ---- match setup ------------------------------------------------------------

/** (Re)seat a roster into a fresh countdown. Generates props (host/bots);
 *  guests overwrite props from the host's 'start' message. */
export function setupMatch(
  world: World,
  roster: { id: string; name: string; role: Role; hue: number; bot: boolean }[],
  seed = Math.floor(Math.random() * 1e6),
): void {
  world.props = makeProps(seed);
  world.players = roster.map((r) => makePlayer(r.id, r.name, r.role, r.hue, r.bot));
  world.status = 'countdown';
  world.t = 0;
  world.phaseLeft = COUNTDOWN_S;
  world.winner = null;
  world.feed = [];
  seatPlayers(world);
}

/** Seekers cluster near the centre (blinded during prep); hiders spread to the
 *  cover ring so they have time to reach a spot and paint. */
export function seatPlayers(world: World): void {
  const hiders = world.players.filter((p) => p.role === 'hider');
  const seekers = world.players.filter((p) => p.role === 'seeker');
  hiders.forEach((p, i) => {
    const ang = (i / Math.max(1, hiders.length)) * Math.PI * 2;
    p.x = Math.cos(ang) * (ARENA_R * 0.55);
    p.z = Math.sin(ang) * (ARENA_R * 0.55);
    p.yaw = ang + Math.PI;
    p.vx = p.vz = 0;
    p.caught = false;
  });
  seekers.forEach((p, i) => {
    const ang = (i / Math.max(1, seekers.length)) * Math.PI * 2;
    p.x = Math.cos(ang) * 2.2;
    p.z = Math.sin(ang) * 2.2;
    p.yaw = ang;
    p.vx = p.vz = 0;
  });
}

// ---- math helpers -----------------------------------------------------------

/** Circular hue distance in degrees, 0..180. */
export function hueDist(a: number, b: number): number {
  let d = Math.abs(((a % 360) + 360) % 360 - (((b % 360) + 360) % 360));
  if (d > 180) d = 360 - d;
  return d;
}

function pushFeed(world: World, line: string): void {
  world.feed.unshift(line);
  if (world.feed.length > FEED_MAX) world.feed.length = FEED_MAX;
}

/** Best camouflage surface near a hider: the prop/floor/wall whose hue the body
 *  most closely matches, weighted by how close the body hugs it. Returns the
 *  resulting blend quality 0..1 (and the surface hue, for the eyedropper). */
export function surfaceFor(world: World, x: number, z: number): {
  hue: number;
  proximity: number;
} {
  let bestHue = FLOOR_HUE;
  let bestProx = 0.4; // you always lie on the floor — weak cover on its own
  for (const p of world.props) {
    const gap = Math.hypot(p.x - x, p.z - z) - p.r;
    if (gap < BLEND_RANGE) {
      const prox = Math.max(0, Math.min(1, 1 - gap / BLEND_RANGE));
      if (prox > bestProx) {
        bestProx = prox;
        bestHue = p.hue;
      }
    }
  }
  // Near the wall ring? The wall is a big flat surface to hug.
  const edgeGap = ARENA_R - Math.hypot(x, z);
  if (edgeGap < BLEND_RANGE) {
    const prox = Math.max(0, Math.min(1, 1 - edgeGap / BLEND_RANGE)) * 0.85;
    if (prox > bestProx) {
      bestProx = prox;
      bestHue = WALL_HUE;
    }
  }
  return { hue: bestHue, proximity: bestProx };
}

function blendOf(bodyHue: number, surfaceHue: number, proximity: number): number {
  const cm = Math.max(0, 1 - hueDist(bodyHue, surfaceHue) / HUE_TOLERANCE);
  return cm * (0.35 + 0.65 * proximity);
}

// ---- integration ------------------------------------------------------------

function moveAndCollide(world: World, p: Player, speed: number, dt: number): void {
  const m = Math.hypot(p.input.mx, p.input.mz);
  let tvx = 0;
  let tvz = 0;
  if (m > 0.001) {
    tvx = (p.input.mx / m) * speed * Math.min(1, m);
    tvz = (p.input.mz / m) * speed * Math.min(1, m);
  }
  const k = Math.min(1, ACCEL * dt);
  p.vx += (tvx - p.vx) * k;
  p.vz += (tvz - p.vz) * k;
  p.x += p.vx * dt;
  p.z += p.vz * dt;

  // Prop collisions (circle push-out).
  for (const pr of world.props) {
    const dx = p.x - pr.x;
    const dz = p.z - pr.z;
    const min = pr.r + PLAYER_R;
    const d = Math.hypot(dx, dz);
    if (d < min && d > 0.0001) {
      const push = (min - d) / d;
      p.x += dx * push;
      p.z += dz * push;
    }
  }
  // Arena wall.
  const rr = Math.hypot(p.x, p.z);
  const lim = ARENA_R - PLAYER_R;
  if (rr > lim) {
    p.x = (p.x / rr) * lim;
    p.z = (p.z / rr) * lim;
  }

  // Facing: follow movement; idle keeps last yaw.
  if (Math.hypot(p.vx, p.vz) > 0.4) p.yaw = Math.atan2(p.vx, p.vz);
}

function stepTongue(world: World, s: Player, dt: number): void {
  const t = s.tongue;
  if (!t) return;
  if (!t.retract) {
    t.len += TONGUE_SPEED * dt;
    // Catch check along the way (skip if already stuck to a victim).
    if (!t.hitId) {
      const tipX = s.x + t.dx * t.len;
      const tipZ = s.z + t.dz * t.len;
      for (const h of world.players) {
        if (h.role !== 'hider' || h.caught) continue;
        if (Math.hypot(h.x - tipX, h.z - tipZ) < TONGUE_CATCH_R + PLAYER_R) {
          h.caught = true;
          h.vx = h.vz = 0;
          t.hitId = h.id;
          t.retract = true;
          s.catches++;
          s.score += CATCH_PTS;
          pushFeed(world, `${s.name} 👅 ${h.name}`);
          break;
        }
      }
    }
    if (t.len >= t.max) t.retract = true;
  } else {
    // Victim is dragged toward the seeker as the tongue retracts.
    if (t.hitId) {
      const h = world.players.find((p) => p.id === t.hitId);
      if (h) {
        const tipX = s.x + t.dx * t.len;
        const tipZ = s.z + t.dz * t.len;
        h.x += (tipX - h.x) * Math.min(1, dt * 8);
        h.z += (tipZ - h.z) * Math.min(1, dt * 8);
      }
    }
    t.len -= TONGUE_SPEED * dt;
    if (t.len <= 0) {
      s.tongueCd = t.hitId ? TONGUE_CD_S : TONGUE_MISS_CD_S;
      s.tongue = null;
    }
  }
}

function fireTongue(s: Player): void {
  let dx = s.input.aimX - s.x;
  let dz = s.input.aimZ - s.z;
  let d = Math.hypot(dx, dz);
  if (d < 0.001) {
    // No aim → straight ahead.
    dx = Math.sin(s.yaw);
    dz = Math.cos(s.yaw);
    d = 1;
  }
  dx /= d;
  dz /= d;
  s.yaw = Math.atan2(dx, dz);
  s.tongue = { dx, dz, len: 0, max: TONGUE_RANGE, retract: false, hitId: null };
}

// ---- per-frame update -------------------------------------------------------

export function step(world: World, dt: number): void {
  world.t += dt;
  if (world.status === 'countdown' || world.status === 'prep' || world.status === 'hunt') {
    world.phaseLeft -= dt;
  }

  if (world.status === 'countdown') {
    if (world.phaseLeft <= 0) {
      world.status = 'prep';
      world.t = 0;
      world.phaseLeft = PREP_S;
      pushFeed(world, 'Saklananlar boyanıyor — avcılar uyuyor');
    }
    return;
  }

  if (world.status === 'over') return;

  if (world.status === 'prep' && world.phaseLeft <= 0) {
    world.status = 'hunt';
    world.t = 0;
    world.phaseLeft = HUNT_S;
    pushFeed(world, 'Av başladı — saklananları bul!');
  }

  const hunting = world.status === 'hunt';
  const prepping = world.status === 'prep';

  for (const p of world.players) {
    if (p.caught) {
      p.vx = p.vz = 0;
      continue;
    }
    const frozenSeeker = p.role === 'seeker' && prepping; // blinded in prep
    if (frozenSeeker) {
      p.vx = p.vz = 0;
    } else {
      const speed = p.role === 'seeker' ? SEEKER_SPEED : MOVE_SPEED;
      moveAndCollide(world, p, speed, dt);
    }

    // Stillness.
    const spd = Math.hypot(p.vx, p.vz);
    if (spd < STILL_SPEED) p.stillFor += dt;
    else p.stillFor = 0;

    if (p.role === 'hider') {
      // Eyedropper: sample the nearest prop within reach on the fire edge.
      if (p.input.fire) {
        let best: PropSpec | null = null;
        let bestGap = SAMPLE_RANGE;
        for (const pr of world.props) {
          const gap = Math.hypot(pr.x - p.x, pr.z - p.z) - pr.r;
          if (gap < bestGap) {
            bestGap = gap;
            best = pr;
          }
        }
        const edgeGap = ARENA_R - Math.hypot(p.x, p.z);
        if (best) p.targetHue = best.hue;
        else if (edgeGap < SAMPLE_RANGE) p.targetHue = WALL_HUE;
        else p.targetHue = FLOOR_HUE;
      }
      // Skin eases toward the sampled hue.
      const dh = ((p.targetHue - p.bodyHue + 540) % 360) - 180;
      p.bodyHue += dh * Math.min(1, PAINT_EASE * dt);
      p.bodyHue = ((p.bodyHue % 360) + 360) % 360;

      // Blend + visibility.
      const surf = surfaceFor(world, p.x, p.z);
      p.blend = blendOf(p.bodyHue, surf.hue, surf.proximity);
      const still = Math.max(0, Math.min(1, p.stillFor / STILL_TIME));
      const hidden = p.blend * still;
      p.visible = VIS_MIN + (1 - VIS_MIN) * (1 - hidden);

      // Score for staying hidden during the hunt.
      if (hunting) p.score += BLEND_RATE * hidden * dt;
    } else {
      // Seeker: tongue.
      if (p.tongueCd > 0) p.tongueCd -= dt;
      if (!prepping) {
        if (p.input.fire && !p.tongue && p.tongueCd <= 0) fireTongue(p);
        stepTongue(world, p, dt);
      }
    }
    p.input.fire = false; // consume the edge
  }

  // Proximity reveal: a near seeker that is facing a hidden hider drags its
  // visibility up so good play (flushing them out) is rewarded.
  if (hunting) {
    for (const s of world.players) {
      if (s.role !== 'seeker' || s.caught) continue;
      const fx = Math.sin(s.yaw);
      const fz = Math.cos(s.yaw);
      for (const h of world.players) {
        if (h.role !== 'hider' || h.caught) continue;
        const dx = h.x - s.x;
        const dz = h.z - s.z;
        const d = Math.hypot(dx, dz);
        if (d > REVEAL_DIST || d < 0.001) continue;
        const dot = (fx * dx + fz * dz) / d;
        if (dot > REVEAL_FOV) {
          const force = 0.55 + 0.35 * (1 - d / REVEAL_DIST);
          if (h.visible < force) h.visible = force;
        }
      }
    }
  }

  // Win check.
  if (hunting) {
    const hiders = world.players.filter((p) => p.role === 'hider');
    const alive = hiders.filter((p) => !p.caught);
    if (world.phaseLeft <= 0 || alive.length === 0) resolve(world, alive.length > 0);
  }
}

function resolve(world: World, hidersSurvive: boolean): void {
  world.status = 'over';
  world.winner = hidersSurvive ? 'hider' : 'seeker';
  for (const p of world.players) {
    if (p.role === 'hider' && !p.caught) p.score += SURVIVE_PTS;
    if (
      (world.winner === 'hider' && p.role === 'hider') ||
      (world.winner === 'seeker' && p.role === 'seeker')
    ) {
      p.score += TEAM_WIN_BONUS;
    }
    p.score = Math.round(p.score);
  }
  pushFeed(
    world,
    hidersSurvive ? 'Süre doldu — saklananlar kazandı!' : 'Tüm bukalemunlar yakalandı!',
  );
}
