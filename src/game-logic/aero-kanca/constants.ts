// Single source of truth for every dimension and tuning value. world.ts
// (physics), scene.ts (render), bots.ts (AI) all import from here so the
// drawn arena and the simulated arena can never disagree.
// pitfall: visual-vs-hitbox.

// ---- match ----------------------------------------------------------------
export const MATCH_S = 120; // match length (seconds)
export const COUNTDOWN_S = 3; // pre-match countdown
export const TOTAL_CRAFTS = 5; // humans + bots, always this many in the arena
export const SIM_DT = 1 / 60; // fixed physics step
export const MAX_SUBSTEPS = 3; // per rendered frame (tab-return safety)
export const FRAME_DT_CLAMP = 0.05; // clamp rAF delta (tab switch / jank)

// ---- arena / islands --------------------------------------------------------
export const KO_Y = -28; // fall below this → knocked out
export const HOVER_H = 1.2; // hover height above island surface
export const CLOUD_Y = -16; // visual cloud deck height
export const ISLAND_MIN_R = 8;
export const ISLAND_MAX_R = 13;
export const CENTER_R = 16; // central island radius (never collapses)
export const ISLAND_COUNT = 7; // including the central island
export const RING_DIST = 34; // distance of outer islands from center
export const COLLAPSE_START_S = 50; // first island starts sinking at t=…
export const COLLAPSE_GAP_S = 10; // stagger between island collapses
export const COLLAPSE_DUR_S = 18; // sink duration (live 1 → 0)
export const COLLAPSE_DROP = 6; // how far a sinking island descends
export const SHAKE_LEAD_S = 3; // pre-collapse warning shake window

// ---- craft physics ----------------------------------------------------------
export const CRAFT_R = 1.1; // craft collision sphere radius
export const ACCEL = 38; // drive acceleration (u/s²)
export const DRAG = 1.6; // quadratic-ish velocity drag
export const MAX_SPEED = 40; // horizontal speed cap (rope can pump energy)
export const GRAVITY = 28; // fall acceleration over the void
export const HOVER_K = 14; // hover spring stiffness
export const HOVER_DAMP = 6; // hover spring damping
export const REST = 0.85; // craft-craft restitution
export const COMMIT_DEPTH = 2; // below surface−this, the fall is committed

// ---- hook -------------------------------------------------------------------
export const HOOK_RANGE = 34;
export const ROPE_K = 26; // rope spring stiffness (island anchor)
export const REEL_RATE = 10; // rope shortening while held (u/s)
export const ROPE_MIN = 3; // can't reel shorter than this
export const HOOK_MAX_S = 3.5; // auto-release an island anchor after …
export const HOOK_CD_S = 0.6; // cooldown between hook shots
export const LATCH_S = 1.4; // craft-latch duration before auto-fling
export const LATCH_PULL = 20.8; // pull force on a latched victim (ROPE_K·0.8)
export const FLING_MULT = 1.4; // victim impulse = attacker speed × this

// ---- scoring / respawn -------------------------------------------------------
export const KO_PTS = 3;
export const ORB_PTS = 1;
export const CREDIT_S = 4; // KO credit window after last hook/bump
export const RESPAWN_S = 2.5;
export const PROTECT_S = 2; // spawn protection
export const ORB_COUNT = 5; // concurrent orbs
export const ORB_R = 1.6; // pickup radius
export const ORB_HOVER = 0.9; // orb height above the surface

// ---- camera / render ---------------------------------------------------------
export const CAM_UP = 19; // camera offset above the player
export const CAM_BACK = 23; // camera offset behind (+z) the player
export const CAM_EASE = 4; // follow easing rate
export const FOG_NEAR = 60;
export const FOG_FAR = 160;
export const SKY = '#2b3a55'; // dusk sky
export const PALETTE = [205, 15, 130, 48, 290]; // craft hues; slot 0 = you

// ---- networking ----------------------------------------------------------------
export const SNAP_MS = 100; // host snapshot cadence (10/s)
export const INPUT_MS = 100; // guest input throttle
export const MAX_HUMANS = 5;
export const FEED_MAX = 3; // KO feed lines kept

export const BOT_NAMES = [
  'Kancakafa',
  'Rüzgargülü',
  'SisKaptanı',
  'YamaçAjanı',
  'Bulutsörfçüsü',
  'Çapakanca',
];
