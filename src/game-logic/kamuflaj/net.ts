// Network message encoding + runtime validation. This module never touches
// Supabase — the entry passes messages through the @shared/realtime-channel
// handle. Every decoder narrows `unknown` field-by-field; a malformed payload
// is dropped silently (pitfall: realtime-must-degrade-silently).

import type {
  InputMsg,
  InputState,
  NetPlayer,
  PropKind,
  PropSpec,
  Role,
  Snapshot,
  StartMsg,
  World,
} from './types';

function num(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
function str(v: unknown): v is string {
  return typeof v === 'string';
}
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

const KINDS = new Set<PropKind>([
  'crate',
  'barrel',
  'plant',
  'rock',
  'lamp',
  'bush',
  'column',
  'shelf',
  'urn',
  'statue',
  'table',
]);

// ---- host → guests: world snapshot -----------------------------------------

export function encodeSnapshot(world: World): Snapshot {
  return {
    st: world.status,
    pl: round2(world.phaseLeft),
    pr: world.players.map((p): NetPlayer => {
      const n: NetPlayer = {
        id: p.id,
        nm: p.name,
        ro: p.role === 'seeker' ? 1 : 0,
        x: round2(p.x),
        z: round2(p.z),
        yw: round2(p.yaw),
        bh: Math.round(p.bodyHue),
        ca: p.caught ? 1 : 0,
        vi: round2(p.visible),
        sc: Math.round(p.score),
      };
      if (p.catches > 0) n.ct = p.catches; // seekers' tally for the scoreboard
      if (p.tongue) {
        n.tx = round2(p.tongue.dx);
        n.tz = round2(p.tongue.dz);
        n.tl = round2(p.tongue.len);
        if (p.tongue.hitId) n.tv = p.tongue.hitId;
      }
      return n;
    }),
    fd: world.feed.slice(),
    wn: world.winner,
  };
}

export function decodeSnapshot(data: unknown): Snapshot | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Partial<Snapshot>;
  if (!str(d.st) || !num(d.pl) || !Array.isArray(d.pr)) return null;
  for (const raw of d.pr) {
    const n = raw as Partial<NetPlayer>;
    if (!str(n.id) || !str(n.nm) || !num(n.x) || !num(n.z)) return null;
  }
  return d as Snapshot;
}

// ---- host → guests: match start --------------------------------------------

export function encodeStart(world: World): StartMsg {
  return {
    props: world.props.map((p) => ({ ...p })),
    roster: world.players.map((p) => ({
      id: p.id,
      name: p.name,
      role: p.role,
      hue: p.bodyHue,
    })),
  };
}

export function decodeStart(data: unknown): StartMsg | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Partial<StartMsg>;
  if (!Array.isArray(d.props) || !Array.isArray(d.roster)) return null;
  const props: PropSpec[] = [];
  for (const raw of d.props) {
    const p = raw as Partial<PropSpec>;
    if (!num(p.x) || !num(p.z) || !num(p.r) || !num(p.h) || !num(p.hue) || !num(p.seed)) {
      return null;
    }
    const kind: PropKind = KINDS.has(p.kind as PropKind) ? (p.kind as PropKind) : 'crate';
    props.push({ x: p.x, z: p.z, r: p.r, h: p.h, hue: p.hue, kind, seed: p.seed });
  }
  const roster: StartMsg['roster'] = [];
  for (const raw of d.roster) {
    const r = raw as Partial<StartMsg['roster'][number]>;
    if (!str(r.id) || !str(r.name) || !num(r.hue)) return null;
    const role: Role = r.role === 'seeker' ? 'seeker' : 'hider';
    roster.push({ id: r.id, name: r.name, role, hue: r.hue });
  }
  return { props, roster };
}

// ---- guest → host: input ----------------------------------------------------

export function encodeInput(input: InputState): InputMsg {
  return {
    f: round2(input.fwd),
    s: round2(input.strafe),
    y: round2(input.yaw),
    fire: input.fire,
  };
}

export function decodeInput(data: unknown): InputMsg | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Partial<InputMsg>;
  if (!num(d.f) || !num(d.s) || !num(d.y)) return null;
  return {
    f: Math.max(-1, Math.min(1, d.f)),
    s: Math.max(-1, Math.min(1, d.s)),
    y: d.y,
    fire: d.fire === true,
  };
}

export function decodeHello(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const n = (data as { name?: unknown }).name;
  if (!str(n) || !n.trim()) return null;
  return n.trim().slice(0, 14);
}
