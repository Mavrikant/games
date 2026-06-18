// Single source of truth for every dimension and tuning value. world.ts
// (simulation) and scene.ts (render) all import from here so the drawn arena
// and the simulated arena can never disagree (pitfall: visual-vs-hitbox).

// ---- match phases -----------------------------------------------------------
export const COUNTDOWN_S = 3; // role reveal before prep
export const PREP_S = 20; // hiders paint + position; seekers blinded
export const HUNT_S = 95; // seekers hunt the hiders (bigger map → longer)
export const SIM_DT = 1 / 60; // fixed physics step
export const MAX_SUBSTEPS = 3; // per rendered frame (tab-return safety)
export const FRAME_DT_CLAMP = 0.05; // clamp rAF delta (tab switch / jank)

// ---- roster -----------------------------------------------------------------
export const MAX_HUMANS = 6; // room capacity
export const MIN_PLAYERS = 2; // can't start a hide-and-seek with one person
export const MIN_SEEKERS = 1;
export const MIN_HIDERS = 1;
// Seekers scale with the roster: ~1 seeker per 3 players.
export function seekerCountFor(total: number): number {
  return Math.max(MIN_SEEKERS, Math.min(total - MIN_HIDERS, Math.round(total / 3)));
}

// ---- map: a grid of rooms joined by doorways --------------------------------
export const GRID_COLS = 3;
export const GRID_ROWS = 2;
export const ROOM = 26; // room edge length (x and z)
export const WALL_T = 0.7; // wall thickness
export const WALL_H = 5.5;
export const DOOR_W = 6.5; // doorway gap width
export const DOOR_H = 3.6; // doorway head height (wall continues above as a lintel)
export const MAP_HW = (GRID_COLS * ROOM) / 2; // half-width  (x ∈ [-HW, HW])
export const MAP_HD = (GRID_ROWS * ROOM) / 2; // half-depth  (z ∈ [-HD, HD])

export const PLAYER_R = 0.7; // body collision radius
export const PROP_COUNT = 40; // scattered cover objects across all rooms
export const FLOOR_HUE = 28; // warm wood floor (HSL hue)
export const WALL_HUE = 210; // cool wall

// ---- first-person camera ----------------------------------------------------
export const EYE_H = 1.5; // camera height above the floor
export const PITCH_LIMIT = 1.25; // max look up/down (radians)
export const LOOK_SENS = 0.0022; // pointer-lock mouse sensitivity
export const DRAG_SENS = 0.005; // drag-look / touch sensitivity

// ---- movement ---------------------------------------------------------------
export const MOVE_SPEED = 7.6; // hider top speed (u/s)
export const SEEKER_SPEED = 8.4; // seekers a touch faster
export const ACCEL = 60; // approach speed quickly (responsive)
export const STILL_SPEED = 0.6; // below this counts as "standing still"
export const STILL_TIME = 0.5; // seconds of stillness to be "frozen"

// ---- camouflage / visibility ------------------------------------------------
export const SAMPLE_RANGE = 4.2; // eyedropper reach to a prop/wall
export const BLEND_RANGE = 5.0; // surface considered for blend scoring
export const HUE_TOLERANCE = 50; // hue degrees that still read as a match
export const PAINT_EASE = 4.0; // body hue eases to sampled hue at this rate
export const VIS_MIN = 0.07; // floor visibility for a perfect hide
export const REVEAL_DIST = 7.5; // a near, facing seeker forces a hider visible
export const REVEAL_FOV = 0.6; // dot(view, toHider) above this = "looking at"

// ---- seeker tongue ----------------------------------------------------------
export const TONGUE_RANGE = 14; // max reach of the sticky tongue
export const TONGUE_SPEED = 48; // extend speed (u/s)
export const TONGUE_CATCH_R = 1.6; // tip radius that catches a hider
export const TONGUE_CD_S = 1.1; // cooldown after a lash
export const TONGUE_MISS_CD_S = 1.7; // longer cooldown on a miss

// ---- scoring ----------------------------------------------------------------
export const CATCH_PTS = 100; // seeker: per hider caught
export const SURVIVE_PTS = 150; // hider: survived the whole hunt
export const BLEND_RATE = 14; // hider: points/sec scaled by blend quality
export const TEAM_WIN_BONUS = 60; // everyone on the winning side

// ---- render -----------------------------------------------------------------
export const FOG_NEAR = 30;
export const FOG_FAR = 95;
export const SKY = '#10141c';

// Prop hues form the camouflage palette — a hider can only be as hidden as the
// colours actually present in the room.
export const PROP_HUES = [4, 28, 48, 92, 140, 170, 200, 270, 320];

// ---- networking -------------------------------------------------------------
export const SNAP_MS = 90; // host snapshot cadence (~11/s)
export const INPUT_MS = 80; // guest input throttle
export const FEED_MAX = 3;
