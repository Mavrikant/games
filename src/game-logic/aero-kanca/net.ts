// Network message encoding + runtime validation. This module never touches
// Supabase — the entry passes messages through the @shared/realtime-channel
// handle. Every decoder narrows `unknown` field-by-field; a malformed payload
// is dropped silently (pitfall: realtime-must-degrade-silently).

import { liveOf } from './world';
import type { InputMsg, InputState, IslandSpec, NetCraft, Snapshot, StartMsg, World } from './types';

function num(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function str(v: unknown): v is string {
  return typeof v === 'string';
}

// ---- host → guests: world snapshot --------------------------------------------

export function encodeSnapshot(world: World): Snapshot {
  return {
    st: world.status,
    ct: world.count,
    lf: world.left,
    cr: world.crafts.map((c): NetCraft => {
      const n: NetCraft = {
        id: c.id,
        nm: c.name,
        hu: c.hue,
        x: round2(c.x),
        y: round2(c.y),
        z: round2(c.z),
        vx: round2(c.vx),
        vy: round2(c.vy),
        vz: round2(c.vz),
        yw: round2(c.yaw),
        al: c.alive ? 1 : 0,
        pr: c.protectIn > 0 ? 1 : 0,
        pt: c.pts,
        ko: c.kos,
      };
      if (c.hook) {
        n.hx = round2(c.hook.x);
        n.hy = round2(c.hook.y);
        n.hz = round2(c.hook.z);
        if (c.hook.victimId) n.ht = c.hook.victimId;
      }
      return n;
    }),
    ob: world.orbs.map((o) => ({ x: round2(o.x), y: round2(o.y), z: round2(o.z) })),
    sk: world.islands.map((isl) => round2(liveOf(isl, world.t))),
    fd: world.feed.slice(),
    wn: world.winner,
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

export function decodeSnapshot(data: unknown): Snapshot | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Partial<Snapshot>;
  if (!str(d.st) || !num(d.ct) || !num(d.lf)) return null;
  if (!Array.isArray(d.cr) || !Array.isArray(d.ob) || !Array.isArray(d.sk)) return null;
  for (const c of d.cr) {
    const n = c as Partial<NetCraft>;
    if (!str(n.id) || !str(n.nm) || !num(n.x) || !num(n.y) || !num(n.z)) return null;
  }
  return d as Snapshot;
}

// ---- host → guests: match start ----------------------------------------------

export function encodeStart(world: World): StartMsg {
  return {
    islands: world.islands.map((i) => ({ ...i, collapseAt: i.collapseAt === Infinity ? -1 : i.collapseAt })),
    roster: world.crafts.map((c) => ({ id: c.id, name: c.name, hue: c.hue, bot: c.bot })),
  };
}

export function decodeStart(data: unknown): StartMsg | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Partial<StartMsg>;
  if (!Array.isArray(d.islands) || !Array.isArray(d.roster)) return null;
  const islands: IslandSpec[] = [];
  for (const raw of d.islands) {
    const i = raw as Partial<IslandSpec>;
    if (!num(i.x) || !num(i.z) || !num(i.r) || !num(i.topY) || !num(i.collapseAt) || !num(i.seed)) {
      return null;
    }
    islands.push({
      x: i.x,
      z: i.z,
      r: i.r,
      topY: i.topY,
      collapseAt: i.collapseAt < 0 ? Infinity : i.collapseAt,
      seed: i.seed,
    });
  }
  const roster: StartMsg['roster'] = [];
  for (const raw of d.roster) {
    const r = raw as Partial<StartMsg['roster'][number]>;
    if (!str(r.id) || !str(r.name) || !num(r.hue)) return null;
    roster.push({ id: r.id, name: r.name, hue: r.hue, bot: r.bot === true });
  }
  return { islands, roster };
}

// ---- guest → host: input ----------------------------------------------------------

export function encodeInput(input: InputState): InputMsg {
  return {
    mx: round2(input.mx),
    mz: round2(input.mz),
    ax: round2(input.aimX),
    az: round2(input.aimZ),
    fire: input.fire,
    held: input.held,
    release: input.release,
  };
}

export function decodeInput(data: unknown): InputMsg | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Partial<InputMsg>;
  if (!num(d.mx) || !num(d.mz) || !num(d.ax) || !num(d.az)) return null;
  return {
    mx: Math.max(-1, Math.min(1, d.mx)),
    mz: Math.max(-1, Math.min(1, d.mz)),
    ax: d.ax,
    az: d.az,
    fire: d.fire === true,
    held: d.held === true,
    release: d.release === true,
  };
}

export function decodeHello(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const n = (data as { name?: unknown }).name;
  if (!str(n) || !n.trim()) return null;
  return n.trim().slice(0, 14);
}
