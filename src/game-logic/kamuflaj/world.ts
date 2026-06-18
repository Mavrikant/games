// Pure simulation: a grid of rooms joined by doorways, first-person-relative
// movement with wall collision, camouflage scoring, the seeker tongue, the
// phase clock and win resolution. No three.js, no DOM, no networking — so the
// host runs it and the headless smoke test exercises it without a GPU.

import {
  ACCEL,
  BLEND_RANGE,
  BLEND_RATE,
  CATCH_PTS,
  COUNTDOWN_S,
  DOOR_W,
  FEED_MAX,
  FLOOR_HUE,
  GRID_COLS,
  GRID_ROWS,
  HUE_TOLERANCE,
  HUNT_S,
  MAP_HD,
  MAP_HW,
  MOVE_SPEED,
  PAINT_EASE,
  PLAYER_R,
  PREP_S,
  PROP_COUNT,
  PROP_HUES,
  REVEAL_DIST,
  REVEAL_FOV,
  ROOM,
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
  WALL_T,
} from './constants';
import type { InputState, Player, PropKind, PropSpec, Role, WallSeg, World } from './types';

export function freshInput(): InputState {
  return { fwd: 0, strafe: 0, yaw: 0, fire: false };
}

export function freshWorld(): World {
  return {
    status: 'menu',
    mode: 'idle',
    t: 0,
    phaseLeft: 0,
    props: [],
    walls: [],
    players: [],
    feed: [],
    winner: null,
  };
}

export function makePlayer(id: string, name: string, role: Role, hue: number): Player {
  return {
    id,
    name,
    role,
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

// ---- map geometry -----------------------------------------------------------

/** Perimeter walls + interior walls between adjacent rooms, each interior wall
 *  pierced by a central doorway so every room is reachable. Deterministic from
 *  the grid constants (both peers build the identical map). */
export function buildWalls(): WallSeg[] {
  const w: WallSeg[] = [];
  const HW = MAP_HW;
  const HD = MAP_HD;
  w.push({ ax: -HW, az: -HD, bx: HW, bz: -HD });
  w.push({ ax: -HW, az: HD, bx: HW, bz: HD });
  w.push({ ax: -HW, az: -HD, bx: -HW, bz: HD });
  w.push({ ax: HW, az: -HD, bx: HW, bz: HD });
  const half = DOOR_W / 2;
  for (let c = 1; c < GRID_COLS; c++) {
    const x = -HW + ROOM * c;
    for (let r = 0; r < GRID_ROWS; r++) {
      const z0 = -HD + ROOM * r;
      const z1 = z0 + ROOM;
      const zc = (z0 + z1) / 2;
      w.push({ ax: x, az: z0, bx: x, bz: zc - half });
      w.push({ ax: x, az: zc + half, bx: x, bz: z1 });
    }
  }
  for (let r = 1; r < GRID_ROWS; r++) {
    const z = -HD + ROOM * r;
    for (let c = 0; c < GRID_COLS; c++) {
      const x0 = -HW + ROOM * c;
      const x1 = x0 + ROOM;
      const xc = (x0 + x1) / 2;
      w.push({ ax: x0, az: z, bx: xc - half, bz: z });
      w.push({ ax: xc + half, az: z, bx: x1, bz: z });
    }
  }
  return w;
}

/** Doorway openings (centres) in the interior walls — used by the renderer to
 *  build lintels, door frames and corner pillars. Mirrors buildWalls() exactly,
 *  so geometry can never drift from collision. `horizontal` = the wall runs
 *  along x (the opening spans x); otherwise the wall runs along z. */
export interface Doorway {
  x: number;
  z: number;
  horizontal: boolean;
}
export function buildDoorways(): Doorway[] {
  const d: Doorway[] = [];
  const HW = MAP_HW;
  const HD = MAP_HD;
  for (let c = 1; c < GRID_COLS; c++) {
    const x = -HW + ROOM * c;
    for (let r = 0; r < GRID_ROWS; r++) {
      d.push({ x, z: -HD + ROOM * r + ROOM / 2, horizontal: false });
    }
  }
  for (let r = 1; r < GRID_ROWS; r++) {
    const z = -HD + ROOM * r;
    for (let c = 0; c < GRID_COLS; c++) {
      d.push({ x: -HW + ROOM * c + ROOM / 2, z, horizontal: true });
    }
  }
  return d;
}

/** Closest distance from a point to an axis-aligned wall segment. */
function distToWall(x: number, z: number, w: WallSeg): number {
  const cx = Math.max(Math.min(w.ax, w.bx), Math.min(Math.max(w.ax, w.bx), x));
  const cz = Math.max(Math.min(w.az, w.bz), Math.min(Math.max(w.az, w.bz), z));
  return Math.hypot(x - cx, z - cz);
}

const PROP_KINDS: PropKind[] = ['crate', 'barrel', 'plant', 'rock', 'lamp'];

function makeProps(seed: number, walls: WallSeg[]): PropSpec[] {
  const rand = mulberry32(seed);
  const props: PropSpec[] = [];
  let guard = 0;
  while (props.length < PROP_COUNT && guard < PROP_COUNT * 60) {
    guard++;
    const x = -MAP_HW + 2 + rand() * (MAP_HW * 2 - 4);
    const z = -MAP_HD + 2 + rand() * (MAP_HD * 2 - 4);
    const r = 0.9 + rand() * 1.4;
    let ok = true;
    for (const wl of walls) {
      if (distToWall(x, z, wl) < r + WALL_T + 0.6) {
        ok = false;
        break;
      }
    }
    if (ok) {
      for (const p of props) {
        if (Math.hypot(p.x - x, p.z - z) < p.r + r + 1.6) {
          ok = false;
          break;
        }
      }
    }
    if (!ok) continue;
    const kind = PROP_KINDS[Math.floor(rand() * PROP_KINDS.length)]!;
    props.push({
      x,
      z,
      r,
      h: 1.4 + rand() * 2.4,
      hue: PROP_HUES[Math.floor(rand() * PROP_HUES.length)]!,
      kind,
      seed: Math.floor(rand() * 1e6),
    });
  }
  return props;
}

function roomCenters(): { x: number; z: number }[] {
  const out: { x: number; z: number }[] = [];
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      out.push({ x: -MAP_HW + ROOM * (c + 0.5), z: -MAP_HD + ROOM * (r + 0.5) });
    }
  }
  return out;
}

// ---- match setup ------------------------------------------------------------

export function setupMatch(
  world: World,
  roster: { id: string; name: string; role: Role; hue: number }[],
  seed = Math.floor(Math.random() * 1e6),
): void {
  world.walls = buildWalls();
  world.props = makeProps(seed, world.walls);
  world.players = roster.map((r) => makePlayer(r.id, r.name, r.role, r.hue));
  world.status = 'countdown';
  world.t = 0;
  world.phaseLeft = COUNTDOWN_S;
  world.winner = null;
  world.feed = [];
  seatPlayers(world);
}

/** Seekers start in the central room (blinded during prep); hiders spread to
 *  the surrounding rooms so they have time to reach cover and paint. */
export function seatPlayers(world: World): void {
  const centers = roomCenters();
  const mid = centers[Math.floor(centers.length / 2)] ?? { x: 0, z: 0 };
  const hiders = world.players.filter((p) => p.role === 'hider');
  const seekers = world.players.filter((p) => p.role === 'seeker');
  hiders.forEach((p, i) => {
    const rm = centers[(i + 1) % centers.length] ?? mid;
    const a = (i / Math.max(1, hiders.length)) * Math.PI * 2;
    p.x = rm.x + Math.cos(a) * 3;
    p.z = rm.z + Math.sin(a) * 3;
    p.yaw = Math.atan2(rm.x - p.x, rm.z - p.z);
    p.input.yaw = p.yaw;
    p.vx = p.vz = 0;
    p.caught = false;
  });
  seekers.forEach((p, i) => {
    const a = (i / Math.max(1, seekers.length)) * Math.PI * 2;
    p.x = mid.x + Math.cos(a) * 2;
    p.z = mid.z + Math.sin(a) * 2;
    p.yaw = a;
    p.input.yaw = a;
    p.vx = p.vz = 0;
  });
}

// ---- math helpers -----------------------------------------------------------

export function hueDist(a: number, b: number): number {
  let d = Math.abs((((a % 360) + 360) % 360) - (((b % 360) + 360) % 360));
  if (d > 180) d = 360 - d;
  return d;
}

function pushFeed(world: World, line: string): void {
  world.feed.unshift(line);
  if (world.feed.length > FEED_MAX) world.feed.length = FEED_MAX;
}

/** Best camouflage surface near a hider: the prop/wall/floor whose hue the body
 *  most closely matches, weighted by how close the body hugs it. */
export function surfaceFor(world: World, x: number, z: number): { hue: number; proximity: number } {
  let bestHue = FLOOR_HUE;
  let bestProx = 0.4;
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
  for (const w of world.walls) {
    const gap = distToWall(x, z, w) - WALL_T / 2;
    if (gap < BLEND_RANGE) {
      const prox = Math.max(0, Math.min(1, 1 - gap / BLEND_RANGE)) * 0.9;
      if (prox > bestProx) {
        bestProx = prox;
        bestHue = WALL_HUE;
      }
    }
  }
  return { hue: bestHue, proximity: bestProx };
}

function blendOf(bodyHue: number, surfaceHue: number, proximity: number): number {
  const cm = Math.max(0, 1 - hueDist(bodyHue, surfaceHue) / HUE_TOLERANCE);
  return cm * (0.35 + 0.65 * proximity);
}

// ---- integration ------------------------------------------------------------

function collideWalls(world: World, p: Player): void {
  for (let pass = 0; pass < 2; pass++) {
    for (const pr of world.props) {
      const dx = p.x - pr.x;
      const dz = p.z - pr.z;
      const min = pr.r + PLAYER_R;
      const d = Math.hypot(dx, dz);
      if (d < min && d > 1e-4) {
        const push = (min - d) / d;
        p.x += dx * push;
        p.z += dz * push;
      }
    }
    for (const w of world.walls) {
      const cx = Math.max(Math.min(w.ax, w.bx), Math.min(Math.max(w.ax, w.bx), p.x));
      const cz = Math.max(Math.min(w.az, w.bz), Math.min(Math.max(w.az, w.bz), p.z));
      let dx = p.x - cx;
      let dz = p.z - cz;
      let d = Math.hypot(dx, dz);
      const min = PLAYER_R + WALL_T / 2;
      if (d >= min) continue;
      if (d < 1e-4) {
        if (w.ax === w.bx) {
          dx = p.vx <= 0 ? 1 : -1;
          dz = 0;
        } else {
          dx = 0;
          dz = p.vz <= 0 ? 1 : -1;
        }
        d = 1;
      }
      const push = (min - d) / d;
      p.x += dx * push;
      p.z += dz * push;
    }
  }
  p.x = Math.max(-MAP_HW + PLAYER_R, Math.min(MAP_HW - PLAYER_R, p.x));
  p.z = Math.max(-MAP_HD + PLAYER_R, Math.min(MAP_HD - PLAYER_R, p.z));
}

function moveAndCollide(world: World, p: Player, speed: number, dt: number): void {
  const { fwd, strafe, yaw } = p.input;
  // Basis matching the FPV camera (three.js lookAt): forward = (sin yaw, cos yaw),
  // camera-right = (-cos yaw, sin yaw). Using +cos/-sin here inverts strafe, so
  // the right vector must be negated (pitfall: strafe-mirrored).
  const fx = Math.sin(yaw);
  const fz = Math.cos(yaw);
  const rx = -Math.cos(yaw);
  const rz = Math.sin(yaw);
  const dx = fx * fwd + rx * strafe;
  const dz = fz * fwd + rz * strafe;
  const m = Math.hypot(dx, dz);
  let tvx = 0;
  let tvz = 0;
  if (m > 0.001) {
    const scale = Math.min(1, m);
    tvx = (dx / m) * speed * scale;
    tvz = (dz / m) * speed * scale;
  }
  const k = Math.min(1, ACCEL * dt);
  p.vx += (tvx - p.vx) * k;
  p.vz += (tvz - p.vz) * k;
  p.x += p.vx * dt;
  p.z += p.vz * dt;
  collideWalls(world, p);
  p.yaw = yaw;
}

function stepTongue(world: World, s: Player, dt: number): void {
  const t = s.tongue;
  if (!t) return;
  if (!t.retract) {
    t.len += TONGUE_SPEED * dt;
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
  const dx = Math.sin(s.input.yaw);
  const dz = Math.cos(s.input.yaw);
  s.yaw = s.input.yaw;
  s.tongue = { dx, dz, len: 0, max: TONGUE_RANGE, retract: false, hitId: null };
}

/** Client-side prediction for the local guest's own player: integrate one frame
 *  of movement from local input so the first-person camera is lag-free. The
 *  host stays authoritative for catches/scoring; the entry reconciles position
 *  toward the latest snapshot. */
export function predictLocal(world: World, p: Player, dt: number): void {
  if (p.caught) return;
  const speed = p.role === 'seeker' ? SEEKER_SPEED : MOVE_SPEED;
  moveAndCollide(world, p, speed, dt);
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
    const frozenSeeker = p.role === 'seeker' && prepping;
    if (frozenSeeker) {
      p.vx = p.vz = 0;
      p.yaw = p.input.yaw;
    } else {
      const speed = p.role === 'seeker' ? SEEKER_SPEED : MOVE_SPEED;
      moveAndCollide(world, p, speed, dt);
    }

    const spd = Math.hypot(p.vx, p.vz);
    if (spd < STILL_SPEED) p.stillFor += dt;
    else p.stillFor = 0;

    if (p.role === 'hider') {
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
        let wallGap = SAMPLE_RANGE;
        for (const w of world.walls) {
          const g = distToWall(p.x, p.z, w) - WALL_T / 2;
          if (g < wallGap) wallGap = g;
        }
        if (best && bestGap <= wallGap) p.targetHue = best.hue;
        else if (wallGap < SAMPLE_RANGE) p.targetHue = WALL_HUE;
        else if (best) p.targetHue = best.hue;
        else p.targetHue = FLOOR_HUE;
      }
      const dh = ((p.targetHue - p.bodyHue + 540) % 360) - 180;
      p.bodyHue += dh * Math.min(1, PAINT_EASE * dt);
      p.bodyHue = ((p.bodyHue % 360) + 360) % 360;

      const surf = surfaceFor(world, p.x, p.z);
      p.blend = blendOf(p.bodyHue, surf.hue, surf.proximity);
      const still = Math.max(0, Math.min(1, p.stillFor / STILL_TIME));
      const hidden = p.blend * still;
      p.visible = VIS_MIN + (1 - VIS_MIN) * (1 - hidden);
      if (hunting) p.score += BLEND_RATE * hidden * dt;
    } else {
      if (p.tongueCd > 0) p.tongueCd -= dt;
      if (!prepping) {
        if (p.input.fire && !p.tongue && p.tongueCd <= 0) fireTongue(p);
        stepTongue(world, p, dt);
      }
    }
    p.input.fire = false;
  }

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
