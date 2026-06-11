// Shared data shapes. The simulation works on plain numbers/objects (no
// three.js types) so world.ts runs — and the smoke test passes — even when
// WebGL is unavailable.

export type Mode = 'idle' | 'bots' | 'online-host' | 'online-guest';

export type Status = 'menu' | 'waiting' | 'connecting' | 'countdown' | 'playing' | 'over';

// One normalized input frame per craft. Edges (fire/release) are consumed by
// the sim and cleared; held is level-triggered.
export interface InputState {
  mx: number; // move direction x, -1..1
  mz: number; // move direction z, -1..1
  aimX: number; // world-space aim point
  aimZ: number;
  fire: boolean; // edge: hook button pressed this frame
  held: boolean; // level: hook button currently held
  release: boolean; // edge: hook button released this frame
}

export interface IslandSpec {
  x: number;
  z: number;
  r: number;
  topY: number;
  collapseAt: number; // sim seconds; Infinity = never (central island)
  seed: number; // silhouette noise seed (render only)
}

// Hook state lives on the craft that fired it.
//   kind 'rock'  → anchored to a world point, rope spring + reel
//   kind 'craft' → latched onto victim (by id) for a short pull window
export interface Hook {
  kind: 'rock' | 'craft';
  x: number; // anchor point (rock) — updated to victim position when latched
  y: number;
  z: number;
  victimId: string | null;
  len: number; // current rope length (rock anchor)
  age: number; // seconds since fired
}

export interface Craft {
  id: string; // channel id for humans, 'bot1'.. for bots
  name: string;
  hue: number;
  bot: boolean;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  yaw: number; // render-facing only
  alive: boolean;
  respawnIn: number; // sim-seconds countdown while dead (no setTimeout)
  protectIn: number; // spawn-protection countdown
  hookCd: number;
  hook: Hook | null;
  pts: number;
  kos: number;
  // KO credit: who hit/hooked me last, and how long ago.
  lastHitBy: string | null;
  lastHitAge: number;
  input: InputState;
}

export interface Orb {
  x: number;
  y: number;
  z: number;
  island: number; // island index it sits on
}

export interface World {
  status: Status;
  mode: Mode;
  t: number; // sim seconds since countdown start
  count: number; // countdown remaining
  left: number; // match seconds remaining
  islands: IslandSpec[];
  crafts: Craft[];
  orbs: Orb[];
  feed: string[]; // newest first, FEED_MAX entries
  winner: string | null; // craft name, '' = draw
}

// ---- network messages -------------------------------------------------------
export interface NetCraft {
  id: string;
  nm: string;
  hu: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  yw: number;
  al: 0 | 1;
  pr: 0 | 1; // spawn protection active
  pt: number;
  ko: number;
  // hook anchor (absent when no hook): rock point or latched victim position
  hx?: number;
  hy?: number;
  hz?: number;
  ht?: string; // latched victim id
}

export interface Snapshot {
  st: Status;
  ct: number; // countdown
  lf: number; // seconds left
  cr: NetCraft[];
  ob: { x: number; y: number; z: number }[];
  sk: number[]; // per-island live factor 0..1
  fd: string[];
  wn: string | null;
}

export interface StartMsg {
  islands: IslandSpec[];
  roster: { id: string; name: string; hue: number; bot: boolean }[];
}

export interface InputMsg {
  mx: number;
  mz: number;
  ax: number; // aim point (world xz)
  az: number;
  fire: boolean;
  held: boolean;
  release: boolean;
}
