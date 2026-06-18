// Single source of truth for every dimension and tuning value. world.ts
// (simulation), scene.ts (render) and bots.ts (AI) all import from here so the
// drawn arena and the simulated arena can never disagree (pitfall:
// visual-vs-hitbox).

// ---- match phases -----------------------------------------------------------
export const COUNTDOWN_S = 3; // role reveal before prep
export const PREP_S = 18; // hiders paint + position; seekers blinded
export const HUNT_S = 80; // seekers hunt the hiders
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

// ---- arena ------------------------------------------------------------------
export const ARENA_R = 26; // play radius (circular room)
export const WALL_H = 6;
export const PLAYER_R = 0.85; // body collision radius
export const PROP_COUNT = 22; // scattered cover objects
export const FLOOR_HUE = 28; // warm wood floor (HSL hue)
export const WALL_HUE = 210; // cool wall

// ---- movement ---------------------------------------------------------------
export const MOVE_SPEED = 8.2; // hider/seeker top speed (u/s)
export const SEEKER_SPEED = 9.0; // seekers a touch faster
export const ACCEL = 60; // approach speed quickly (responsive)
export const STILL_SPEED = 0.6; // below this counts as "standing still"
export const STILL_TIME = 0.5; // seconds of stillness to be "frozen"

// ---- camouflage / visibility ------------------------------------------------
export const SAMPLE_RANGE = 4.2; // eyedropper reach to a prop
export const BLEND_RANGE = 5.0; // surface considered for blend scoring
export const HUE_TOLERANCE = 50; // hue degrees that still read as a match
export const PAINT_EASE = 4.0; // body hue eases to sampled hue at this rate
export const VIS_MIN = 0.07; // floor visibility for a perfect hide
export const VIS_MOVE = 0.85; // visibility while moving (mismatch aside)
export const REVEAL_DIST = 6.5; // a near, facing seeker forces a hider visible
export const REVEAL_FOV = 0.55; // dot(view, toHider) above this = "looking at"

// ---- seeker tongue ----------------------------------------------------------
export const TONGUE_RANGE = 13; // max reach of the sticky tongue
export const TONGUE_SPEED = 46; // extend speed (u/s)
export const TONGUE_CATCH_R = 1.5; // tip radius that catches a hider
export const TONGUE_CD_S = 1.1; // cooldown after a lash
export const TONGUE_MISS_CD_S = 1.7; // longer cooldown on a miss

// ---- scoring ----------------------------------------------------------------
export const CATCH_PTS = 100; // seeker: per hider caught
export const SURVIVE_PTS = 150; // hider: survived the whole hunt
export const BLEND_RATE = 14; // hider: points/sec scaled by blend quality
export const TEAM_WIN_BONUS = 60; // everyone on the winning side

// ---- camera / render --------------------------------------------------------
export const CAM_UP = 16;
export const CAM_BACK = 15;
export const CAM_EASE = 4;
export const FOG_NEAR = 34;
export const FOG_FAR = 90;
export const SKY = '#10141c';

// Prop hues form the camouflage palette — a hider can only be as hidden as the
// colours actually present in the room.
export const PROP_HUES = [4, 28, 48, 92, 140, 170, 200, 270, 320];

// ---- networking -------------------------------------------------------------
export const SNAP_MS = 100; // host snapshot cadence (10/s)
export const INPUT_MS = 100; // guest input throttle
export const FEED_MAX = 3;
