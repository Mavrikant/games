import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import {
  showOverlay as showOverlayEl,
  hideOverlay as hideOverlayEl,
} from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';

// Ay Yürüyüşü: low-gravity charge-and-release plateau hopping.
// PITFALLS notes:
// - unguarded-storage: safeRead/safeWrite wrap localStorage.
// - stale-async-callback: gen.bump() in reset() invalidates the RAF chain.
// - overlay-input-leak: every input handler guards on `state`.
// - visual-vs-hitbox: plateau widths used by draw() and the landing test
//   come from the same Plateau record (no duplicated constants).
// - hud-counter-synced-only-at-lifecycle-edges: score/oxygen DOM writes
//   happen in updateHud(), which is called every frame in update().

const STORAGE_BEST = 'ay-yuruyusu.best';

const CANVAS_W = 480;
const CANVAS_H = 600;

// Camera-relative coordinate system:
//   The astronaut's world X position starts at 0 (first plateau center).
//   The camera scrolls so the astronaut is always near a fixed screen X.
const ASTRO_SCREEN_X = 150;
const GROUND_Y = 470;          // screen Y of plateau-top line.
const SKY_TOP = 0;

// Astronaut visual + collision:
const ASTRO_RADIUS = 11;       // body radius for collision + draw.
const ASTRO_BODY_H = 28;       // full height for draw (head + body + boots).

// Physics — Earth would feel like GRAVITY ~ 0.6 here; we use 0.20 to feel lunar.
// Tuned so:
//   - 0% charge:  horizontal range ~70 px (falls into any real gap)
//   - 50% charge: ~270 px (clears the average plateau distance)
//   - 100% charge: ~520 px (covers max gap with margin)
const GRAVITY = 0.20;          // px per frame^2 (frame = 1/60 sec).
const MAX_CHARGE_MS = 650;     // hold this long to reach full power.
const MIN_LAUNCH_VY = -3.0;    // upward kick even at 0% charge (test feedback).
const MAX_LAUNCH_VY = -8.6;    // upward kick at 100% charge.
const MIN_LAUNCH_VX = 2.0;     // rightward at 0% charge.
const MAX_LAUNCH_VX = 6.0;     // rightward at 100% charge.
const AIR_DRIFT_ACCEL = 0.10;  // arrow key in-air control.
const MAX_AIR_DRIFT_VX = 8;    // cap horizontal vel from drift.
const JET_BOOST_VY = -3.4;     // one-shot upward thrust.
const JET_BOOST_O2_COST = 4;   // seconds.

// Oxygen + scoring:
const O2_INITIAL = 30;         // seconds.
const O2_DRAIN_PER_SEC = 1;    // seconds of O2 per real second.
const O2_PER_LANDING = 3;      // bonus on each new plateau.
const O2_PER_CRYSTAL = 8;
const SCORE_PER_LANDING = 1;
const SCORE_PER_CRYSTAL = 5;
const O2_MAX = 60;             // cap so collecting many crystals doesn't trivialize.

// Plateau generation:
const FIRST_PLATEAU_W = 200;   // wide starting platform so cold-boot is forgiving.
const MIN_PLATEAU_W = 46;
const MAX_PLATEAU_W = 110;
const MIN_GAP = 70;            // gap between plateau edges.
const MAX_GAP = 220;
const MAX_HEIGHT_STEP = 70;    // how much the plateau top can rise/fall between hops.
const MIN_PLATEAU_Y = 290;     // tallest (smallest Y).
const MAX_PLATEAU_Y = 460;     // lowest plateau top.
const CRYSTAL_CHANCE = 0.32;   // probability a new plateau spawns a crystal.
// First few plateaus are standardized "training" gaps so a new player learns
// the charge feel before randomness kicks in.
const TRAINING_PLATEAU_COUNT = 5;
const TRAINING_GAP = 100;
const TRAINING_W = 90;

// Stars / parallax:
const STAR_COUNT = 70;

type State = 'ready' | 'playing' | 'gameover';

type Plateau = {
  // World-space horizontal extent (left and right edges).
  x1: number;
  x2: number;
  topY: number;        // screen Y (smaller = higher).
  crystal: boolean;    // crystal present?
  crystalTaken: boolean;
  visited: boolean;    // landed at least once → no rebonus.
  craters: number[];   // small decorative crater offsets along the top.
};

type Star = { x: number; y: number; r: number; tw: number };

const gen = createGenToken();

let state: State = 'ready';
let score = 0;
let best = 0;
let oxygenMs = O2_INITIAL * 1000;
let plateaus: Plateau[] = [];
let cameraX = 0;          // world X at left edge of screen.
let astroX = 0;           // world X of astronaut center.
let astroY = 0;           // screen Y of astronaut center (camera is X-only).
let astroVx = 0;
let astroVy = 0;
let onPlateau: Plateau | null = null;
let charging = false;
let chargeStart = 0;
let chargeT = 0;          // 0..1 normalized charge level (also drives UI).
let jetUsedThisJump = false;
let leftHeld = false;
let rightHeld = false;
let stars: Star[] = [];
let lastFrame = 0;
let rafHandle: number | null = null;
let landingFlash = 0;     // ms remaining of a small landing visual flash.
let crystalFlash = 0;     // ms remaining of a crystal pickup flash.
let oxygenWarn = 0;       // ms of red HUD pulse left.
let touchActive = false;  // for mobile pointer charging.
let touchDriftDir = 0;    // -1, 0, +1 derived from touch X position.

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let oxygenEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayBtn!: HTMLButtonElement;

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function makeStars(): Star[] {
  const out: Star[] = [];
  for (let i = 0; i < STAR_COUNT; i++) {
    out.push({
      x: Math.random() * CANVAS_W,
      y: Math.random() * (GROUND_Y - 80),
      r: Math.random() < 0.8 ? 0.8 : 1.6,
      tw: Math.random() * Math.PI * 2,
    });
  }
  return out;
}

function makePlateau(prev: Plateau | null, isFirst: boolean): Plateau {
  if (isFirst) {
    const topY = 420;
    return {
      x1: -40,
      x2: -40 + FIRST_PLATEAU_W,
      topY,
      crystal: false,
      crystalTaken: false,
      visited: true,
      craters: [0.25, 0.55, 0.78],
    };
  }
  // prev is guaranteed non-null when isFirst === false.
  const p = prev!;
  // Plateau index = how many plateaus have been created so far (0-indexed of
  // current plateau being made). The first generated plateau (index 0) is
  // the start; the next 5 (1..5) are training; difficulty kicks in after.
  const index = plateaus.length; // index of the plateau being created.
  const isTraining = index <= TRAINING_PLATEAU_COUNT;
  let gap: number;
  let w: number;
  let dy: number;
  if (isTraining) {
    gap = TRAINING_GAP;
    w = TRAINING_W;
    dy = 0;
  } else {
    // Difficulty scales gently with index past training.
    const diff = Math.min(1, (index - TRAINING_PLATEAU_COUNT) / 25);
    const minGap = MIN_GAP + diff * 20;
    const maxGap = Math.min(MAX_GAP, MIN_GAP + 60 + diff * 110);
    const minW = Math.max(MIN_PLATEAU_W, MAX_PLATEAU_W - diff * 60);
    const maxW = MAX_PLATEAU_W - diff * 20;
    gap = rand(minGap, maxGap);
    w = rand(minW, maxW);
    dy = rand(-MAX_HEIGHT_STEP, MAX_HEIGHT_STEP);
  }
  const x1 = p.x2 + gap;
  const x2 = x1 + w;
  let topY = p.topY + dy;
  if (topY < MIN_PLATEAU_Y) topY = MIN_PLATEAU_Y;
  if (topY > MAX_PLATEAU_Y) topY = MAX_PLATEAU_Y;
  const crystal = !isTraining && Math.random() < CRYSTAL_CHANCE;
  const craterN = Math.max(1, Math.floor(w / 30));
  const craters: number[] = [];
  for (let i = 0; i < craterN; i++) craters.push(0.15 + Math.random() * 0.7);
  return {
    x1,
    x2,
    topY,
    crystal,
    crystalTaken: false,
    visited: false,
    craters,
  };
}

function ensurePlateausAhead(): void {
  // Keep ~6 plateaus generated past the camera's right edge so the player
  // can always see the next 2-3 jump targets.
  const rightEdgeWorld = cameraX + CANVAS_W + 200;
  while (true) {
    const last = plateaus[plateaus.length - 1];
    if (!last || last.x2 < rightEdgeWorld) {
      plateaus.push(makePlateau(last ?? null, plateaus.length === 0));
    } else {
      break;
    }
  }
}

function dropOldPlateaus(): void {
  // Remove plateaus entirely behind the camera so the array doesn't grow
  // unbounded (cap-counts-dead-entities cousin: keep `plateaus.length`
  // strictly representing live targets).
  const cutoff = cameraX - 50;
  while (plateaus.length > 1 && plateaus[0]!.x2 < cutoff) {
    plateaus.shift();
  }
}

function findPlateauAt(worldX: number): Plateau | null {
  for (const p of plateaus) {
    if (worldX >= p.x1 && worldX <= p.x2) return p;
  }
  return null;
}

function updateHud(): void {
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
  const o2 = Math.max(0, Math.ceil(oxygenMs / 1000));
  oxygenEl.textContent = String(o2);
}

function showReadyOverlay(): void {
  overlayTitle.textContent = 'Ay Yürüyüşü';
  overlayMsg.textContent =
    'Astronotu düşük yerçekiminde plato plato zıplat.\n' +
    'BOŞLUK basılı tut → güç doldur, bırak → zıpla.\n' +
    'Havada ← / → küçük yön düzeltir, BOŞLUK bir kez jet boost verir (–4 sn O₂).\n' +
    'Plato +1 skor +3 sn O₂ · Mavi kristal +5 skor +8 sn O₂.\n' +
    'Oksijen bitince ya da boşluğa düşünce oyun biter.';
  overlayBtn.textContent = 'Başla';
  showOverlayEl(overlay);
}

function showGameOverOverlay(reason: 'fall' | 'oxygen'): void {
  overlayTitle.textContent = reason === 'fall' ? 'Boşluğa düştün' : 'Oksijen bitti';
  const fresh = score === best && best > 0;
  overlayMsg.textContent =
    `Skor: ${score}` +
    (fresh ? '  ·  Yeni rekor!' : `\nRekor: ${best}`) +
    '\n\nBOŞLUK / Enter ya da Tekrar dene.';
  overlayBtn.textContent = 'Tekrar dene';
  showOverlayEl(overlay);
}

function commitBest(): void {
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
}

function reset(): void {
  gen.bump();
  stopRaf();
  state = 'ready';
  commitBest();
  score = 0;
  oxygenMs = O2_INITIAL * 1000;
  plateaus = [];
  cameraX = -ASTRO_SCREEN_X;
  ensurePlateausAhead();
  const first = plateaus[0]!;
  first.visited = true;
  astroX = (first.x1 + first.x2) * 0.5;
  astroY = first.topY - ASTRO_RADIUS;
  astroVx = 0;
  astroVy = 0;
  onPlateau = first;
  charging = false;
  chargeT = 0;
  jetUsedThisJump = false;
  leftHeld = false;
  rightHeld = false;
  landingFlash = 0;
  crystalFlash = 0;
  oxygenWarn = 0;
  touchActive = false;
  touchDriftDir = 0;
  updateHud();
  draw();
  showReadyOverlay();
}

function startRound(): void {
  if (state === 'playing') return;
  hideOverlayEl(overlay);
  state = 'playing';
  score = 0;
  oxygenMs = O2_INITIAL * 1000;
  plateaus = [];
  cameraX = -ASTRO_SCREEN_X;
  ensurePlateausAhead();
  const first = plateaus[0]!;
  first.visited = true;
  astroX = (first.x1 + first.x2) * 0.5;
  astroY = first.topY - ASTRO_RADIUS;
  astroVx = 0;
  astroVy = 0;
  onPlateau = first;
  charging = false;
  chargeT = 0;
  jetUsedThisJump = false;
  leftHeld = false;
  rightHeld = false;
  landingFlash = 0;
  crystalFlash = 0;
  oxygenWarn = 0;
  touchActive = false;
  touchDriftDir = 0;
  updateHud();
  startRaf();
}

function startRaf(): void {
  if (rafHandle !== null) return;
  const myGen = gen.current();
  lastFrame = performance.now();
  const loop = (t: number): void => {
    if (!gen.isCurrent(myGen)) {
      rafHandle = null;
      return;
    }
    const dt = Math.min(40, t - lastFrame);
    lastFrame = t;
    update(dt);
    draw();
    if (state === 'playing') {
      rafHandle = requestAnimationFrame(loop);
    } else {
      rafHandle = null;
    }
  };
  rafHandle = requestAnimationFrame(loop);
}

function stopRaf(): void {
  if (rafHandle !== null) {
    cancelAnimationFrame(rafHandle);
    rafHandle = null;
  }
}

function update(dt: number): void {
  if (state !== 'playing') return;

  // Oxygen drain.
  oxygenMs -= dt * O2_DRAIN_PER_SEC;
  if (oxygenMs <= 0) {
    oxygenMs = 0;
    finishRound('oxygen');
    return;
  }

  // Visual flash decays.
  if (landingFlash > 0) landingFlash = Math.max(0, landingFlash - dt);
  if (crystalFlash > 0) crystalFlash = Math.max(0, crystalFlash - dt);
  if (oxygenWarn > 0) oxygenWarn = Math.max(0, oxygenWarn - dt);
  if (oxygenMs < 6000) oxygenWarn = 240;

  // Charge bar (visual feedback while holding).
  if (charging && onPlateau) {
    const elapsed = performance.now() - chargeStart;
    chargeT = Math.min(1, elapsed / MAX_CHARGE_MS);
  }

  // Convert frame-time (ms) into physics ticks (60 fps reference).
  const ticks = dt / (1000 / 60);

  if (!onPlateau) {
    // In-air physics.
    // Drift control. Apply small horizontal acceleration; cap with friction
    // so taps add fine-grained nudges.
    if (leftHeld || touchDriftDir < 0) {
      astroVx -= AIR_DRIFT_ACCEL * ticks;
    }
    if (rightHeld || touchDriftDir > 0) {
      astroVx += AIR_DRIFT_ACCEL * ticks;
    }
    if (astroVx > MAX_AIR_DRIFT_VX) astroVx = MAX_AIR_DRIFT_VX;
    if (astroVx < -MAX_AIR_DRIFT_VX) astroVx = -MAX_AIR_DRIFT_VX;

    // Gravity + integrate.
    astroVy += GRAVITY * ticks;
    astroX += astroVx * ticks;
    astroY += astroVy * ticks;

    // Camera follows astronaut, but never moves left (player can't backtrack
    // and explore void).
    const desiredCameraX = astroX - ASTRO_SCREEN_X;
    if (desiredCameraX > cameraX) cameraX = desiredCameraX;

    ensurePlateausAhead();
    dropOldPlateaus();

    // Landing test: the astronaut lands when his bottom (astroY + radius)
    // touches or crosses a plateau top from above (vy > 0).
    const bottomY = astroY + ASTRO_RADIUS;
    if (astroVy > 0) {
      const p = findPlateauAt(astroX);
      if (p && bottomY >= p.topY && bottomY - astroVy * ticks <= p.topY + 2) {
        // Snap to top.
        astroY = p.topY - ASTRO_RADIUS;
        astroVx = 0;
        astroVy = 0;
        onPlateau = p;
        jetUsedThisJump = false;
        landingFlash = 260;
        if (!p.visited) {
          p.visited = true;
          score += SCORE_PER_LANDING;
          oxygenMs = Math.min(O2_MAX * 1000, oxygenMs + O2_PER_LANDING * 1000);
          commitBest();
        }
        if (p.crystal && !p.crystalTaken) {
          p.crystalTaken = true;
          score += SCORE_PER_CRYSTAL;
          oxygenMs = Math.min(O2_MAX * 1000, oxygenMs + O2_PER_CRYSTAL * 1000);
          crystalFlash = 500;
          commitBest();
        }
      }
    }

    // Death: fall below canvas (or off camera left).
    if (astroY > CANVAS_H + 40) {
      finishRound('fall');
      return;
    }
    // Also: if astronaut's x drifts behind the left edge (rare since camera
    // doesn't follow left and drift cap is moderate), treat as fall once he's
    // below the deepest plateau line.
    if (astroX < cameraX - 60 && astroY > MAX_PLATEAU_Y + 40) {
      finishRound('fall');
      return;
    }
  } else {
    // Standing on a plateau. Camera idle. Drift keys do nothing on ground.
  }

  updateHud();
}

function launchJump(): void {
  if (!onPlateau) return;
  const t = chargeT;
  const vx = MIN_LAUNCH_VX + (MAX_LAUNCH_VX - MIN_LAUNCH_VX) * t;
  const vy = MIN_LAUNCH_VY + (MAX_LAUNCH_VY - MIN_LAUNCH_VY) * t;
  astroVx = vx;
  astroVy = vy;
  onPlateau = null;
  jetUsedThisJump = false;
  charging = false;
  chargeT = 0;
}

function jetBoost(): void {
  if (onPlateau || jetUsedThisJump) return;
  if (oxygenMs <= JET_BOOST_O2_COST * 1000) return;
  astroVy = Math.min(astroVy, 0) + JET_BOOST_VY;
  // Cap negative vy so a boost doesn't make the jump silly-high.
  if (astroVy < -10) astroVy = -10;
  oxygenMs -= JET_BOOST_O2_COST * 1000;
  jetUsedThisJump = true;
  crystalFlash = 180; // small flash to confirm.
}

function finishRound(reason: 'fall' | 'oxygen'): void {
  state = 'gameover';
  charging = false;
  chargeT = 0;
  leftHeld = false;
  rightHeld = false;
  touchActive = false;
  touchDriftDir = 0;
  stopRaf();
  commitBest();
  updateHud();
  draw();
  showGameOverOverlay(reason);
}

// --- Input ---

function onKeyDown(e: KeyboardEvent): void {
  const k = e.key;
  const lk = k.toLowerCase();
  if (lk === 'r') {
    reset();
    e.preventDefault();
    return;
  }
  if (state === 'ready' || state === 'gameover') {
    if (k === ' ' || k === 'Enter') {
      startRound();
      e.preventDefault();
    }
    return;
  }
  // Playing.
  if (k === ' ') {
    e.preventDefault();
    if (onPlateau) {
      if (!charging) {
        charging = true;
        chargeStart = performance.now();
        chargeT = 0;
      }
    } else {
      // In air → jet boost (one-shot per jump).
      if (!e.repeat) jetBoost();
    }
    return;
  }
  if (k === 'ArrowLeft' || lk === 'a') {
    leftHeld = true;
    e.preventDefault();
    return;
  }
  if (k === 'ArrowRight' || lk === 'd') {
    rightHeld = true;
    e.preventDefault();
    return;
  }
}

function onKeyUp(e: KeyboardEvent): void {
  const k = e.key;
  const lk = k.toLowerCase();
  if (state !== 'playing') {
    // Ensure no stuck modifiers leak into next round.
    if (k === ' ') charging = false;
    if (k === 'ArrowLeft' || lk === 'a') leftHeld = false;
    if (k === 'ArrowRight' || lk === 'd') rightHeld = false;
    return;
  }
  if (k === ' ') {
    e.preventDefault();
    if (charging && onPlateau) {
      launchJump();
    }
    charging = false;
    return;
  }
  if (k === 'ArrowLeft' || lk === 'a') {
    leftHeld = false;
    e.preventDefault();
    return;
  }
  if (k === 'ArrowRight' || lk === 'd') {
    rightHeld = false;
    e.preventDefault();
    return;
  }
}

function pointToCanvas(e: PointerEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const sx = canvas.width / rect.width;
  const sy = canvas.height / rect.height;
  return {
    x: (e.clientX - rect.left) * sx,
    y: (e.clientY - rect.top) * sy,
  };
}

function onPointerDown(e: PointerEvent): void {
  e.preventDefault();
  if (state === 'ready' || state === 'gameover') {
    startRound();
    return;
  }
  if (state !== 'playing') return;
  const pt = pointToCanvas(e);
  touchActive = true;
  // Touch drift: tap left half = left, right half = right (only while in air).
  touchDriftDir = pt.x < CANVAS_W * 0.5 ? -1 : 1;
  if (onPlateau) {
    if (!charging) {
      charging = true;
      chargeStart = performance.now();
      chargeT = 0;
    }
  } else {
    // In-air pointer down → jet boost, on the *first* tap (no boost-spam).
    jetBoost();
  }
  // Capture so we still get the matching pointerup if the finger leaves
  // the canvas.
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {
    /* ignored */
  }
}

function onPointerMove(e: PointerEvent): void {
  if (!touchActive || state !== 'playing') return;
  const pt = pointToCanvas(e);
  if (!onPlateau) {
    touchDriftDir = pt.x < CANVAS_W * 0.5 ? -1 : 1;
  }
}

function onPointerUp(e: PointerEvent): void {
  e.preventDefault();
  if (state !== 'playing') {
    touchActive = false;
    touchDriftDir = 0;
    return;
  }
  if (charging && onPlateau) {
    launchJump();
  }
  charging = false;
  touchActive = false;
  touchDriftDir = 0;
  try {
    canvas.releasePointerCapture(e.pointerId);
  } catch {
    /* ignored */
  }
}

// --- Render ---

function draw(): void {
  const w = canvas.width;
  const h = canvas.height;

  // Sky gradient — deep purple-blue near horizon, near-black at top.
  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, '#03040a');
  sky.addColorStop(0.55, '#0c0820');
  sky.addColorStop(1, '#1b1538');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);

  // Stars — twinkle.
  const tNow = performance.now() * 0.001;
  for (const s of stars) {
    const tw = 0.55 + 0.45 * Math.sin(tNow * 2 + s.tw);
    ctx.fillStyle = `rgba(255,255,255,${tw * (s.r > 1 ? 0.95 : 0.55)})`;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Distant Earth in the corner — purely decorative.
  drawEarth();

  // Plateaus (back to front).
  for (const p of plateaus) drawPlateau(p);

  // Astronaut.
  drawAstronaut();

  // Trajectory preview (while charging, before launch). Shows the parabolic
  // arc the astronaut will follow at the current charge level — critical
  // for learning the charge feel.
  if (state === 'playing' && charging && onPlateau) {
    drawTrajectoryPreview();
  }

  // Charge bar (only on ground, while charging).
  if (state === 'playing' && charging && onPlateau) {
    drawChargeBar();
  }

  // Next-target hint arrow when on a plateau.
  if (state === 'playing' && onPlateau) {
    drawNextHint();
  }

  // Oxygen tint warning.
  if (oxygenWarn > 0) {
    ctx.fillStyle = `rgba(255,80,80,${(oxygenWarn / 240) * 0.18})`;
    ctx.fillRect(0, 0, w, h);
  }

  // Landing flash.
  if (landingFlash > 0) {
    const t = landingFlash / 260;
    ctx.fillStyle = `rgba(255,255,255,${t * 0.12})`;
    ctx.fillRect(0, 0, w, h);
  }
  if (crystalFlash > 0) {
    const t = crystalFlash / 500;
    ctx.fillStyle = `rgba(120,200,255,${t * 0.18})`;
    ctx.fillRect(0, 0, w, h);
  }

  // Ready-state hint label inside canvas (just helps cold boot read).
  if (state === 'ready') {
    ctx.fillStyle = 'rgba(255,255,255,0.0)';
  }
}

function worldToScreen(x: number): number {
  return x - cameraX;
}

function drawEarth(): void {
  // Small Earth in upper-right.
  const cx = CANVAS_W - 60;
  const cy = 70;
  const r = 28;
  const g = ctx.createRadialGradient(cx - 8, cy - 8, 4, cx, cy, r);
  g.addColorStop(0, '#5fa6ff');
  g.addColorStop(0.6, '#2c5fb5');
  g.addColorStop(1, '#0a1d44');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  // A couple of green continent patches.
  ctx.fillStyle = 'rgba(110, 200, 130, 0.45)';
  ctx.beginPath();
  ctx.ellipse(cx - 6, cy + 2, 9, 4, -0.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(cx + 8, cy - 6, 6, 3, 0.6, 0, Math.PI * 2);
  ctx.fill();
  // Limb glow.
  ctx.strokeStyle = 'rgba(150, 200, 255, 0.35)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(cx, cy, r + 1.5, 0, Math.PI * 2);
  ctx.stroke();
}

function drawPlateau(p: Plateau): void {
  const sx1 = worldToScreen(p.x1);
  const sx2 = worldToScreen(p.x2);
  // Skip plateaus completely offscreen for tiny perf and cleaner debug.
  if (sx2 < -10 || sx1 > CANVAS_W + 10) return;
  const top = p.topY;
  const bottom = CANVAS_H + 20;

  // Side cliffs — gradient from light surface to darker depth.
  const grad = ctx.createLinearGradient(0, top, 0, bottom);
  grad.addColorStop(0, '#9a9eb2');
  grad.addColorStop(0.15, '#6b6c83');
  grad.addColorStop(0.5, '#3a3a52');
  grad.addColorStop(1, '#161826');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(sx1, top);
  ctx.lineTo(sx2, top);
  ctx.lineTo(sx2 + 2, bottom);
  ctx.lineTo(sx1 - 2, bottom);
  ctx.closePath();
  ctx.fill();

  // Top surface highlight.
  ctx.strokeStyle = 'rgba(220, 220, 240, 0.65)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(sx1, top - 1);
  ctx.lineTo(sx2, top - 1);
  ctx.stroke();

  // Craters along the top — small dimples.
  for (const offset of p.craters) {
    const x = sx1 + (sx2 - sx1) * offset;
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.beginPath();
    ctx.ellipse(x, top + 2, 5, 1.6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.beginPath();
    ctx.ellipse(x, top, 5, 1.4, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // Crystal (if any, not yet taken).
  if (p.crystal && !p.crystalTaken) {
    const cx = (sx1 + sx2) * 0.5;
    const cy = top - 16;
    const sway = Math.sin(performance.now() * 0.004 + p.x1 * 0.01) * 1.6;
    drawCrystal(cx, cy + sway);
  }
}

function drawCrystal(cx: number, cy: number): void {
  ctx.save();
  ctx.translate(cx, cy);
  // Glow halo.
  const halo = ctx.createRadialGradient(0, 0, 1, 0, 0, 22);
  halo.addColorStop(0, 'rgba(140,210,255,0.45)');
  halo.addColorStop(1, 'rgba(140,210,255,0)');
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(0, 0, 22, 0, Math.PI * 2);
  ctx.fill();
  // Diamond shape.
  ctx.beginPath();
  ctx.moveTo(0, -10);
  ctx.lineTo(7, 0);
  ctx.lineTo(0, 12);
  ctx.lineTo(-7, 0);
  ctx.closePath();
  const g = ctx.createLinearGradient(-7, -10, 7, 12);
  g.addColorStop(0, '#bfeaff');
  g.addColorStop(0.5, '#5fb6ff');
  g.addColorStop(1, '#1e4f9e');
  ctx.fillStyle = g;
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 1;
  ctx.stroke();
  // Inner highlight.
  ctx.beginPath();
  ctx.moveTo(-2, -7);
  ctx.lineTo(0, -2);
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.stroke();
  ctx.restore();
}

function drawAstronaut(): void {
  // Astronaut is rendered at fixed screen X (ASTRO_SCREEN_X) when grounded
  // OR offset by (astroX - cameraX) when airborne — since camera follows
  // the astronaut, the screen X is identical in both cases; we just use
  // worldToScreen() to keep render consistent.
  const sx = worldToScreen(astroX);
  const sy = astroY;

  // Drop shadow on the nearest plateau under the astronaut.
  const groundP = findPlateauAt(astroX);
  if (groundP) {
    const shadowY = groundP.topY + 1.5;
    const shadowR = Math.max(4, 12 - (shadowY - sy) * 0.04);
    ctx.fillStyle = 'rgba(0,0,0,0.32)';
    ctx.beginPath();
    ctx.ellipse(sx, shadowY, shadowR, 2.4, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // Jetpack flame (in air with rising vy after boost).
  if (!onPlateau && jetUsedThisJump && astroVy < 0) {
    const flameH = 18 + Math.random() * 6;
    ctx.fillStyle = 'rgba(255, 180, 90, 0.85)';
    ctx.beginPath();
    ctx.moveTo(sx - 5, sy + 8);
    ctx.lineTo(sx + 5, sy + 8);
    ctx.lineTo(sx, sy + 8 + flameH);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(255, 240, 200, 0.9)';
    ctx.beginPath();
    ctx.moveTo(sx - 2, sy + 8);
    ctx.lineTo(sx + 2, sy + 8);
    ctx.lineTo(sx, sy + 8 + flameH * 0.55);
    ctx.closePath();
    ctx.fill();
  }

  // Body (suit) — slightly oval white shape.
  ctx.fillStyle = '#e9ecf2';
  ctx.strokeStyle = '#1a1c2a';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.ellipse(sx, sy + 3, ASTRO_RADIUS - 1, ASTRO_RADIUS + 2, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Backpack (small box behind suit — only visible from this angle as a hint).
  ctx.fillStyle = '#9aa1b3';
  ctx.fillRect(sx + 6, sy - 4, 5, 12);
  ctx.strokeRect(sx + 6, sy - 4, 5, 12);

  // Helmet — circle on top of body.
  ctx.fillStyle = '#f5f7ff';
  ctx.beginPath();
  ctx.arc(sx, sy - 7, ASTRO_RADIUS - 1, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Visor — dark glass with cyan highlight.
  ctx.fillStyle = '#0a1a30';
  ctx.beginPath();
  ctx.ellipse(sx + 1, sy - 7, 6, 5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(120,210,255,0.65)';
  ctx.beginPath();
  ctx.ellipse(sx + 3, sy - 9, 1.6, 1.0, 0, 0, Math.PI * 2);
  ctx.fill();

  // Red mission patch on chest.
  ctx.fillStyle = '#d24252';
  ctx.fillRect(sx - 3, sy + 4, 3, 3);

  // Boots when grounded.
  if (onPlateau) {
    ctx.fillStyle = '#444a5e';
    ctx.fillRect(sx - 7, sy + ASTRO_RADIUS + 1, 5, 3);
    ctx.fillRect(sx + 2, sy + ASTRO_RADIUS + 1, 5, 3);
  }
}

function drawTrajectoryPreview(): void {
  // Simulate the parabolic flight at the current chargeT and draw dotted dots
  // along the trajectory. The simulation mirrors the physics in update() so
  // visual prediction matches actual flight (avoids visual-vs-hitbox class
  // bug: the constants come from the same source).
  const t = chargeT;
  let vx = MIN_LAUNCH_VX + (MAX_LAUNCH_VX - MIN_LAUNCH_VX) * t;
  let vy = MIN_LAUNCH_VY + (MAX_LAUNCH_VY - MIN_LAUNCH_VY) * t;
  let x = astroX;
  let y = astroY;
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  for (let step = 0; step < 140; step++) {
    vy += GRAVITY;
    x += vx;
    y += vy;
    if (step % 4 === 0) {
      const sx = worldToScreen(x);
      if (sx < -20 || sx > CANVAS_W + 20) break;
      if (y > CANVAS_H + 20) break;
      ctx.beginPath();
      ctx.arc(sx, y, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
    // Stop when arc crosses a plateau top (so the dotted line ends at the
    // landing spot, not somewhere past it).
    if (vy > 0) {
      const p = findPlateauAt(x);
      if (p && y + ASTRO_RADIUS >= p.topY) break;
    }
  }
  ctx.restore();
}

function drawChargeBar(): void {
  // Vertical bar to the right of the astronaut, fixed near top-right.
  const x = CANVAS_W - 22;
  const y = 110;
  const w = 10;
  const h = 140;
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  ctx.fillRect(x, y, w, h);
  const fill = h * chargeT;
  const hue = 200 - chargeT * 200; // blue → red as more dangerous.
  ctx.fillStyle = `hsl(${hue},80%,60%)`;
  ctx.fillRect(x, y + h - fill, w, fill);
  ctx.strokeStyle = 'rgba(255,255,255,0.45)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, w, h);
  // "Sweet spot" tick at ~65% (typical good jump).
  const tickY = y + h * (1 - 0.65);
  ctx.strokeStyle = 'rgba(255,255,255,0.7)';
  ctx.beginPath();
  ctx.moveTo(x - 4, tickY);
  ctx.lineTo(x + w + 4, tickY);
  ctx.stroke();
}

function drawNextHint(): void {
  if (!onPlateau) return;
  // Find the next plateau (first plateau with x1 > current plateau.x2).
  let next: Plateau | null = null;
  for (const p of plateaus) {
    if (p.x1 > onPlateau.x2 + 1) {
      next = p;
      break;
    }
  }
  if (!next) return;
  const sx = worldToScreen((next.x1 + next.x2) * 0.5);
  // Draw a small downward arrow above next plateau if visible.
  if (sx > -10 && sx < CANVAS_W + 10) {
    const y = next.topY - 36;
    const wob = Math.sin(performance.now() * 0.005) * 2;
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.beginPath();
    ctx.moveTo(sx - 6, y + wob);
    ctx.lineTo(sx + 6, y + wob);
    ctx.lineTo(sx, y + wob + 8);
    ctx.closePath();
    ctx.fill();
  }
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  oxygenEl = document.querySelector<HTMLElement>('#oxygen')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;

  best = safeRead<number>(STORAGE_BEST, 0);
  stars = makeStars();

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  restartBtn.addEventListener('click', reset);
  overlayBtn.addEventListener('click', () => startRound());
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  // If the tab loses focus while a key is held, release the key state
  // (avoids stuck charge / drift). PITFALLS#overlay-input-leak cousin.
  window.addEventListener('blur', () => {
    charging = false;
    chargeT = 0;
    leftHeld = false;
    rightHeld = false;
    touchActive = false;
    touchDriftDir = 0;
  });

  reset();
}

export const game = defineGame({ init, reset });
