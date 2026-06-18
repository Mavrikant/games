// Shared data shapes. The simulation works on plain numbers/objects (no
// three.js types) so world.ts runs — and the smoke test passes — even when
// WebGL is unavailable.

export type Mode = 'idle' | 'online-host' | 'online-guest';

export type Role = 'hider' | 'seeker';

export type Status =
  | 'menu'
  | 'waiting'
  | 'connecting'
  | 'countdown'
  | 'prep'
  | 'hunt'
  | 'over';

// One normalized input frame per player, in first-person terms. `fire` is an
// edge (consumed by the sim and cleared); movement + facing are level-triggered.
export interface InputState {
  fwd: number; // forward/back relative to facing, -1..1
  strafe: number; // left/right relative to facing, -1..1
  yaw: number; // look direction (radians); movement + tongue are relative to it
  fire: boolean; // edge: action pressed this frame
}

// An axis-aligned wall segment (either vertical x=const or horizontal z=const).
// Deterministic from the grid constants, so both peers compute the same map and
// it never needs serialising.
export interface WallSeg {
  ax: number;
  az: number;
  bx: number;
  bz: number;
}

export type PropKind =
  | 'crate'
  | 'barrel'
  | 'plant'
  | 'rock'
  | 'lamp'
  | 'bush'
  | 'column'
  | 'shelf'
  | 'urn'
  | 'statue'
  | 'table';

// Static cover object. Position + footprint + hue. Generated on the host and
// sent verbatim to guests in the 'start' message so both peers share geometry.
export interface PropSpec {
  x: number;
  z: number;
  r: number; // footprint radius (collision + blend proximity)
  h: number; // visual height
  hue: number;
  kind: PropKind;
  seed: number; // render-only jitter
}

// A seeker's extending tongue. Lives on the seeker that fired it.
export interface Tongue {
  // direction unit vector (xz)
  dx: number;
  dz: number;
  len: number; // current extension
  max: number; // target reach
  retract: boolean; // past full reach → pulling back
  hitId: string | null; // caught hider id (render: tip sticks to victim)
}

export interface Player {
  id: string; // realtime-channel id
  name: string;
  role: Role;
  x: number;
  z: number;
  yaw: number; // facing (render + reveal cone)
  vx: number;
  vz: number;
  bodyHue: number; // current skin colour
  targetHue: number; // sampled colour the skin eases toward
  stillFor: number; // seconds below STILL_SPEED
  blend: number; // 0..1 camouflage quality (hiders)
  visible: number; // 0..1 render opacity / detectability (hiders)
  caught: boolean; // hider has been tongued
  tongueCd: number; // seeker cooldown
  tongue: Tongue | null;
  score: number;
  catches: number; // seeker tally
  input: InputState;
}

export interface World {
  status: Status;
  mode: Mode;
  t: number; // sim seconds since the current phase began
  phaseLeft: number; // seconds remaining in countdown/prep/hunt
  props: PropSpec[];
  walls: WallSeg[];
  players: Player[];
  feed: string[]; // newest first, FEED_MAX entries
  winner: '' | 'hider' | 'seeker' | null; // '' = nobody hidden & nobody caught edge
}

// ---- network messages -------------------------------------------------------
export interface NetPlayer {
  id: string;
  nm: string;
  ro: 0 | 1; // 0 hider, 1 seeker
  x: number;
  z: number;
  yw: number;
  bh: number; // body hue
  ca: 0 | 1; // caught
  vi: number; // visibility (hiders)
  sc: number;
  // tongue (absent when none): direction + length + optional victim
  tx?: number;
  tz?: number;
  tl?: number;
  tv?: string;
}

export interface Snapshot {
  st: Status;
  pl: number; // phaseLeft
  pr: NetPlayer[];
  fd: string[];
  wn: '' | 'hider' | 'seeker' | null;
}

export interface StartMsg {
  props: PropSpec[];
  roster: { id: string; name: string; role: Role; hue: number }[];
}

export interface InputMsg {
  f: number; // fwd
  s: number; // strafe
  y: number; // yaw
  fire: boolean;
}
