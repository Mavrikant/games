// ---------------------------------------------------------------------------
// Buz Adası — top-of-iceberg, side-view balance game. Penguins waddle on a
// floating ice slab; their collective center of mass tilts the slab. Tilt past
// ±MAX_TILT and the slab capsizes — game over. The player taps a penguin to
// send it walking back to the center over RECALL_MS, redistributing weight.
// When the slab tilts past SLIDE_TILT, free-walking penguins slide downhill,
// adding positive feedback the player must counter.
//
// Score = seconds survived ×10. Every PENGUIN_INTERVAL_MS a new penguin spawns
// (capped at PENGUIN_MAX), making the equilibrium harder to keep.
//
// State machine: ready | playing | gameover
//
// Pitfalls explicitly addressed:
//  - module-level-dom-access:    all DOM access inside init()
//  - unguarded-storage:          @shared/storage safeRead/safeWrite
//  - stale-async-callback:       gen-token; RAF re-reads token each frame
//  - overlay-input-leak:         state enum guards every input handler
//  - missing-overlay-css:        per-game CSS defines .overlay--hidden
//  - visual-vs-hitbox:           hit test uses the same penguin radius and
//                                local-x → world transform as draw()
//  - invisible-boot:             resetToReady() seeds penguins and draws a
//                                static scene under the start overlay
//  - hud-counter-synced-only-at-lifecycle-edges:
//                                score/penguin HUD updated each frame
//  - unreachable-start-state:    overlay button + Space/Enter + R all start
//  - designed-lose-condition-not-wired:
//                                |angle| > MAX_TILT explicitly endGame()
// ---------------------------------------------------------------------------

import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import {
  showOverlay as showOverlayEl,
  hideOverlay as hideOverlayEl,
} from '@shared/overlay';

type State = 'ready' | 'playing' | 'gameover';

// ── Geometry (canvas px) — shared by draw + physics ────────────────────────
const CANVAS = 480;
const ICEBERG_W = 320;
const ICEBERG_H = 44;
const ICEBERG_CX = CANVAS / 2;
const ICEBERG_CY = 290;
const WATER_Y = 320;
const PENGUIN_R = 14; // body half-width; click hit-test uses this
const PENGUIN_TOP_OFFSET = PENGUIN_R + 18; // distance from slab top to penguin center

// ── Physics constants ──────────────────────────────────────────────────────
const MAX_TILT = (28 * Math.PI) / 180; // capsize threshold
const SLIDE_TILT = (6 * Math.PI) / 180; // angle past which penguins slide
const WARN_TILT = (16 * Math.PI) / 180;
const ANGLE_SPRING_K = 5.5; // spring rate toward target angle
const SLIDE_G = 320; // px/s², "gravity" along the slab when sliding
const FRICTION = 1.6; // velocity decay per second (free walking)
const WADDLE_SPEED = 22; // px/s while waddling
const WADDLE_MIN_MS = 800; // min duration of one waddle leg
const WADDLE_MAX_MS = 1800;
const RECALL_SPEED = 95; // px/s while walking to center after a tap
const EDGE_PADDING = 16; // penguins bounce this far from the slab edge

// ── Scoring + difficulty ───────────────────────────────────────────────────
const SCORE_PER_SEC = 10;
const PENGUIN_START = 3;
const PENGUIN_MAX = 9;
const PENGUIN_INTERVAL_MS = 9000; // spawn cadence
const RECALL_MS = 1500; // safety timer; penguin reaches center sooner

const STORAGE_KEY = 'buz-adasi.best';

// ── Mutable state ──────────────────────────────────────────────────────────
const gen = createGenToken();
let state: State = 'ready';
let score = 0;
let best = 0;
let angle = 0; // radians; positive = right side down

interface Penguin {
  id: number;
  x: number; // slab-local x (−ICEBERG_W/2 … +ICEBERG_W/2)
  vx: number;
  /** flipped horizontally when true (drawn facing left) */
  facing: 1 | -1;
  waddleEndAt: number; // when current waddle leg ends (free state)
  mode: 'free' | 'recall';
  recallEndAt: number;
}

const penguins: Penguin[] = [];
let nextId = 0;

let lastFrame = 0;
let runStartedAt = 0;
let lastSpawnAt = 0;
let waveT = 0;
let lastScoreShown = -1;
let lastCountShown = -1;

// DOM refs (assigned in init)
let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let boardWrap!: HTMLElement;
let scoreEl!: HTMLElement;
let countEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayBtn!: HTMLButtonElement;

// ── Helpers ────────────────────────────────────────────────────────────────
function getCssVar(name: string, fallback: string): string {
  try {
    const v = getComputedStyle(document.documentElement)
      .getPropertyValue(name)
      .trim();
    return v || fallback;
  } catch {
    return fallback;
  }
}

function halfW(): number {
  return ICEBERG_W / 2 - EDGE_PADDING;
}

function comX(): number {
  if (penguins.length === 0) return 0;
  let sum = 0;
  for (const p of penguins) sum += p.x;
  return sum / penguins.length;
}

function targetAngle(): number {
  // Map COM offset to a target tilt; an empty/centered slab sits flat.
  const com = comX();
  const t = (com / halfW()) * (MAX_TILT * 0.95);
  if (t > MAX_TILT) return MAX_TILT;
  if (t < -MAX_TILT) return -MAX_TILT;
  return t;
}

function spawnPenguin(initialX: number, now: number): Penguin {
  const p: Penguin = {
    id: nextId++,
    x: initialX,
    vx: (Math.random() < 0.5 ? -1 : 1) * (4 + Math.random() * WADDLE_SPEED),
    facing: Math.random() < 0.5 ? 1 : -1,
    waddleEndAt: now + WADDLE_MIN_MS + Math.random() * (WADDLE_MAX_MS - WADDLE_MIN_MS),
    mode: 'free',
    recallEndAt: 0,
  };
  if (p.vx < 0) p.facing = -1;
  else if (p.vx > 0) p.facing = 1;
  return p;
}

function seedPenguins(now: number): void {
  penguins.length = 0;
  // Spread the starting penguins symmetrically around the centre so the slab
  // is balanced on cold boot (PITFALLS#invisible-boot — visible static scene).
  const hw = halfW();
  const positions = [-hw * 0.4, 0, hw * 0.4];
  for (let i = 0; i < PENGUIN_START; i++) {
    penguins.push(spawnPenguin(positions[i] ?? 0, now));
  }
}

// ── State transitions ──────────────────────────────────────────────────────
function showStartOverlay(): void {
  overlayTitle.textContent = 'Buz Adası';
  overlayMsg.innerHTML =
    'Pengueni tıkla, <strong>orta noktaya</strong> yürüsün.<br>' +
    'Ağırlık merkezi kayarsa ada devrilir.<br>' +
    '<small>Tıkla · dokun · Boşluk / Enter ile başla</small>';
  overlayBtn.textContent = 'Başla';
  showOverlayEl(overlay);
  overlayBtn.focus({ preventScroll: true });
}

function showGameOverOverlay(): void {
  const isRecord = score > 0 && score >= best;
  overlayTitle.textContent = isRecord ? 'Yeni rekor!' : 'Ada devrildi';
  overlayMsg.innerHTML =
    `Skor: <strong>${score}</strong> · ${penguins.length} penguen<br>` +
    `En iyi: ${best}<br>` +
    '<small>Boşluk · Enter · R ile yeniden başla</small>';
  overlayBtn.textContent = 'Tekrar oyna';
  showOverlayEl(overlay);
  overlayBtn.focus({ preventScroll: true });
}

function resetToReady(): void {
  gen.bump();
  state = 'ready';
  score = 0;
  angle = 0;
  waveT = 0;
  const now = performance.now();
  seedPenguins(now);
  scoreEl.textContent = '0';
  countEl.textContent = String(penguins.length);
  bestEl.textContent = String(best);
  lastScoreShown = 0;
  lastCountShown = penguins.length;
  // Render one static frame so the playfield is visible behind the overlay
  // (PITFALLS#invisible-boot).
  draw(now);
  showStartOverlay();
}

function startGame(): void {
  gen.bump();
  state = 'playing';
  score = 0;
  angle = 0;
  waveT = 0;
  const now = performance.now();
  seedPenguins(now);
  runStartedAt = now;
  lastSpawnAt = now;
  lastFrame = now;
  scoreEl.textContent = '0';
  countEl.textContent = String(penguins.length);
  bestEl.textContent = String(best);
  lastScoreShown = 0;
  lastCountShown = penguins.length;
  hideOverlayEl(overlay);
  scheduleFrame();
}

function endGame(): void {
  if (state === 'gameover') return;
  state = 'gameover';
  gen.bump();
  if (score > best) {
    best = score;
    safeWrite(STORAGE_KEY, best);
  }
  bestEl.textContent = String(best);
  showGameOverOverlay();
}

// ── Frame loop ─────────────────────────────────────────────────────────────
function scheduleFrame(): void {
  const myToken = gen.current();
  requestAnimationFrame((t) => {
    if (myToken !== gen.current()) return;
    if (state !== 'playing') return;
    frame(t);
    scheduleFrame();
  });
}

function frame(now: number): void {
  let dt = (now - lastFrame) / 1000;
  if (dt > 0.05) dt = 0.05; // clamp on tab-switch / hitch
  if (dt < 0) dt = 0;
  lastFrame = now;
  waveT += dt;

  const hw = halfW();
  const slideA = SLIDE_G * Math.sin(angle); // > 0 → push +x (right)

  // Penguin updates ---------------------------------------------------------
  for (const p of penguins) {
    if (p.mode === 'recall') {
      // Walk straight to the centre, no sliding, no waddle.
      const dir = p.x > 0 ? -1 : 1;
      const step = RECALL_SPEED * dt;
      if (Math.abs(p.x) <= step || now >= p.recallEndAt) {
        p.x = 0;
        p.vx = 0;
        p.mode = 'free';
        p.waddleEndAt =
          now + WADDLE_MIN_MS + Math.random() * (WADDLE_MAX_MS - WADDLE_MIN_MS);
        p.vx = (Math.random() < 0.5 ? -1 : 1) * (4 + Math.random() * WADDLE_SPEED);
      } else {
        p.x += dir * step;
        p.facing = dir > 0 ? 1 : -1;
      }
      continue;
    }

    // Free state: waddle + slide.
    if (Math.abs(angle) > SLIDE_TILT) {
      p.vx += slideA * dt;
    } else {
      // Friction only when the slab is roughly level; otherwise gravity wins.
      p.vx -= p.vx * FRICTION * dt;
    }
    // Pick a new waddle leg occasionally.
    if (now >= p.waddleEndAt) {
      const newVx = (Math.random() < 0.5 ? -1 : 1) * (4 + Math.random() * WADDLE_SPEED);
      // Bias the waddle uphill so the player has a fighting chance at recovery.
      const uphill = -Math.sign(angle);
      const bias = uphill * 6;
      p.vx = newVx + bias;
      p.waddleEndAt =
        now + WADDLE_MIN_MS + Math.random() * (WADDLE_MAX_MS - WADDLE_MIN_MS);
    }
    // Clamp velocity so single penguins can't yo-yo across the slab.
    const maxV = 90;
    if (p.vx > maxV) p.vx = maxV;
    if (p.vx < -maxV) p.vx = -maxV;

    p.x += p.vx * dt;
    // Bounce off the edges; this is the only thing keeping penguins on the
    // slab when the tilt is mild. Heavy tilt simply increases the count of
    // penguins crushed against the downhill edge, pushing COM further out.
    if (p.x > hw) {
      p.x = hw;
      if (p.vx > 0) p.vx = -p.vx * 0.3;
      p.facing = -1;
    } else if (p.x < -hw) {
      p.x = -hw;
      if (p.vx < 0) p.vx = -p.vx * 0.3;
      p.facing = 1;
    }
    if (p.vx > 1) p.facing = 1;
    else if (p.vx < -1) p.facing = -1;
  }

  // Slab tilt --------------------------------------------------------------
  const tgt = targetAngle();
  angle += (tgt - angle) * ANGLE_SPRING_K * dt;

  // Spawn new penguins -----------------------------------------------------
  if (
    penguins.length < PENGUIN_MAX &&
    now - lastSpawnAt >= PENGUIN_INTERVAL_MS
  ) {
    // Drop the newcomer at the side opposite the current COM, near the
    // centre line — minimises the surprise tilt impulse.
    const side = comX() > 0 ? -1 : 1;
    const x = side * (hw * 0.25 + Math.random() * hw * 0.15);
    penguins.push(spawnPenguin(x, now));
    lastSpawnAt = now;
  }

  // Score ------------------------------------------------------------------
  const elapsedS = (now - runStartedAt) / 1000;
  const newScore = Math.floor(elapsedS * SCORE_PER_SEC);
  if (newScore > score) score = newScore;

  // HUD sync (PITFALLS#hud-counter-synced-only-at-lifecycle-edges) --------
  if (score !== lastScoreShown) {
    scoreEl.textContent = String(score);
    lastScoreShown = score;
  }
  if (penguins.length !== lastCountShown) {
    countEl.textContent = String(penguins.length);
    lastCountShown = penguins.length;
  }

  // Lose check (PITFALLS#designed-lose-condition-not-wired) ---------------
  if (Math.abs(angle) >= MAX_TILT) {
    angle = angle > 0 ? MAX_TILT : -MAX_TILT;
    draw(now);
    endGame();
    return;
  }

  draw(now);
}

// ── Render ─────────────────────────────────────────────────────────────────
function draw(now: number): void {
  ctx.save();
  // Sky -------------------------------------------------------------------
  ctx.fillStyle = getCssVar('--bz-sky', '#0d1b2a');
  ctx.fillRect(0, 0, CANVAS, CANVAS);
  const skyGrad = ctx.createLinearGradient(0, 0, 0, WATER_Y);
  skyGrad.addColorStop(0, 'rgba(124, 168, 255, 0.20)');
  skyGrad.addColorStop(1, 'rgba(124, 168, 255, 0)');
  ctx.fillStyle = skyGrad;
  ctx.fillRect(0, 0, CANVAS, WATER_Y);

  // Stars / moon (purely decorative; ready-state ambience)
  drawStars();

  // Water -----------------------------------------------------------------
  ctx.fillStyle = getCssVar('--bz-water', '#10324a');
  ctx.fillRect(0, WATER_Y, CANVAS, CANVAS - WATER_Y);
  drawWavesOn(WATER_Y);

  // Iceberg + penguins ----------------------------------------------------
  ctx.save();
  ctx.translate(ICEBERG_CX, ICEBERG_CY);
  ctx.rotate(angle);

  // Underwater belly (drawn first so it sits behind the slab visually).
  drawIcebergBelly();
  // Slab body
  drawIcebergSlab();
  // Penguins on top
  for (const p of penguins) drawPenguin(p);
  // Centre mark
  drawCenterMark();

  ctx.restore();

  // COM indicator at the top of the canvas (purely informational) --------
  drawComBar();

  // Tilt-warning tint when we're nearing capsize.
  const tiltFrac = Math.min(1, Math.abs(angle) / MAX_TILT);
  if (state === 'playing' && tiltFrac > 0.55) {
    const alpha = (tiltFrac - 0.55) / 0.45;
    ctx.fillStyle = `rgba(251, 113, 133, ${alpha * 0.16})`;
    ctx.fillRect(0, 0, CANVAS, CANVAS);
  }

  // suppress unused-arg in tabs that don't read `now` directly
  void now;
  ctx.restore();
}

function drawStars(): void {
  // Static-feeling speckle (deterministic by index, no RNG noise).
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  const pts: Array<[number, number, number]> = [
    [42, 30, 1.5],
    [110, 64, 1],
    [78, 110, 0.9],
    [220, 22, 1.2],
    [296, 80, 1],
    [340, 40, 1.5],
    [400, 96, 1],
    [60, 200, 0.8],
    [430, 200, 0.8],
    [184, 156, 1.1],
  ];
  for (const [x, y, r] of pts) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  // Moon
  ctx.fillStyle = 'rgba(245, 240, 220, 0.85)';
  ctx.beginPath();
  ctx.arc(390, 70, 22, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = getCssVar('--bz-sky', '#0d1b2a');
  ctx.beginPath();
  ctx.arc(380, 64, 22, 0, Math.PI * 2);
  ctx.fill();
}

function drawWavesOn(y: number): void {
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  ctx.lineWidth = 1.5;
  for (let row = 0; row < 4; row++) {
    const yy = y + 14 + row * 28;
    ctx.beginPath();
    for (let x = 0; x <= CANVAS; x += 8) {
      const w = Math.sin((x + waveT * 40 + row * 24) * 0.06) * 3;
      if (x === 0) ctx.moveTo(x, yy + w);
      else ctx.lineTo(x, yy + w);
    }
    ctx.stroke();
  }
}

function drawIcebergSlab(): void {
  const w = ICEBERG_W;
  const h = ICEBERG_H;
  // Trapezoidal top → narrower bottom so it reads as a chunk of ice.
  ctx.beginPath();
  ctx.moveTo(-w / 2, -h / 2);
  ctx.lineTo(w / 2, -h / 2);
  ctx.lineTo(w / 2 - 18, h / 2);
  ctx.lineTo(-w / 2 + 18, h / 2);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, -h / 2, 0, h / 2);
  grad.addColorStop(0, '#eaf3ff');
  grad.addColorStop(0.6, '#c5d8ec');
  grad.addColorStop(1, '#94a8c0');
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.strokeStyle = 'rgba(20, 30, 50, 0.35)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  // Top facet highlight
  ctx.strokeStyle = 'rgba(255,255,255,0.7)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-w / 2 + 6, -h / 2 + 2);
  ctx.lineTo(w / 2 - 6, -h / 2 + 2);
  ctx.stroke();
  // Crack texture
  ctx.strokeStyle = 'rgba(60, 80, 120, 0.25)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(-w / 2 + 60, -h / 2 + 6);
  ctx.lineTo(-w / 2 + 80, h / 2 - 4);
  ctx.moveTo(w / 2 - 90, -h / 2 + 8);
  ctx.lineTo(w / 2 - 80, h / 2 - 6);
  ctx.stroke();
}

function drawIcebergBelly(): void {
  const w = ICEBERG_W;
  const h = ICEBERG_H;
  ctx.beginPath();
  ctx.moveTo(-w / 2 + 18, h / 2);
  ctx.lineTo(w / 2 - 18, h / 2);
  ctx.lineTo(w / 2 - 56, h / 2 + 56);
  ctx.lineTo(-w / 2 + 56, h / 2 + 56);
  ctx.closePath();
  ctx.fillStyle = 'rgba(180, 210, 230, 0.35)';
  ctx.fill();
}

function drawCenterMark(): void {
  ctx.fillStyle = 'rgba(60, 220, 120, 0.7)';
  ctx.beginPath();
  ctx.arc(0, -ICEBERG_H / 2 - 2, 3, 0, Math.PI * 2);
  ctx.fill();
}

function penguinScreenPos(p: Penguin): { x: number; y: number } {
  // Local (in iceberg frame) → world (canvas) coordinates.
  const lx = p.x;
  const ly = -ICEBERG_H / 2 - PENGUIN_TOP_OFFSET;
  const cosA = Math.cos(angle);
  const sinA = Math.sin(angle);
  return {
    x: ICEBERG_CX + lx * cosA - ly * sinA,
    y: ICEBERG_CY + lx * sinA + ly * cosA,
  };
}

function drawPenguin(p: Penguin): void {
  ctx.save();
  ctx.translate(p.x, -ICEBERG_H / 2 - PENGUIN_TOP_OFFSET);
  // Tiny waddle bob (purely cosmetic).
  const bob = Math.sin((p.x + waveT * 60) * 0.05) * 1.2;
  ctx.translate(0, bob);
  // Body
  ctx.fillStyle = '#0c1320';
  ctx.beginPath();
  ctx.ellipse(0, 0, PENGUIN_R, PENGUIN_R + 4, 0, 0, Math.PI * 2);
  ctx.fill();
  // White belly
  ctx.fillStyle = '#f5f9ff';
  ctx.beginPath();
  ctx.ellipse(0, 3, PENGUIN_R - 5, PENGUIN_R - 1, 0, 0, Math.PI * 2);
  ctx.fill();
  // Beak (oriented by facing)
  ctx.fillStyle = '#f7b733';
  ctx.beginPath();
  const bx = p.facing * 4;
  ctx.moveTo(bx, -2);
  ctx.lineTo(bx + p.facing * 7, -1);
  ctx.lineTo(bx, 2);
  ctx.closePath();
  ctx.fill();
  // Eye
  ctx.fillStyle = '#f5f9ff';
  ctx.beginPath();
  ctx.arc(p.facing * 3, -5, 2.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#0c1320';
  ctx.beginPath();
  ctx.arc(p.facing * 4, -5, 1.3, 0, Math.PI * 2);
  ctx.fill();
  // Recall halo — telegraphs "I'm walking to centre"
  if (p.mode === 'recall') {
    ctx.strokeStyle = 'rgba(60, 220, 120, 0.85)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, PENGUIN_R + 6, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function drawComBar(): void {
  // Show where the centre of mass sits relative to the slab. A dot near
  // either edge is the warning that the slab is about to flip.
  const barX = 90;
  const barY = 18;
  const barW = CANVAS - 180;
  const barH = 8;
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.10)';
  ctx.fillRect(barX, barY, barW, barH);
  // Safe band
  const safeW = barW * 0.5;
  ctx.fillStyle = 'rgba(60, 220, 120, 0.22)';
  ctx.fillRect(barX + (barW - safeW) / 2, barY, safeW, barH);
  // Dot at COM
  const com = comX();
  const frac = Math.max(-1, Math.min(1, com / halfW()));
  const cx = barX + barW / 2 + frac * (barW / 2 - 4);
  const cy = barY + barH / 2;
  const warn = Math.abs(angle) > WARN_TILT;
  ctx.fillStyle = warn ? '#fb7185' : '#facc15';
  ctx.beginPath();
  ctx.arc(cx, cy, 5, 0, Math.PI * 2);
  ctx.fill();
  // Centre tick
  ctx.strokeStyle = 'rgba(255,255,255,0.4)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(barX + barW / 2, barY - 2);
  ctx.lineTo(barX + barW / 2, barY + barH + 2);
  ctx.stroke();
  // Label
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.font = '600 10px system-ui, ui-sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('AĞIRLIK MERKEZİ', CANVAS / 2, barY - 6);
  ctx.restore();
}

// ── Input ──────────────────────────────────────────────────────────────────
function canvasCoordsFromEvent(e: PointerEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const scaleX = CANVAS / rect.width;
  const scaleY = CANVAS / rect.height;
  return {
    x: (e.clientX - rect.left) * scaleX,
    y: (e.clientY - rect.top) * scaleY,
  };
}

function hitTestPenguin(x: number, y: number): Penguin | null {
  // Compare against on-screen positions so the hit box always matches what
  // the player sees, even when the slab is tilted (PITFALLS#visual-vs-hitbox).
  // Generous hit radius — fingers are imprecise.
  const r = PENGUIN_R + 10;
  let best: Penguin | null = null;
  let bestD2 = r * r;
  for (const p of penguins) {
    const sp = penguinScreenPos(p);
    const dx = sp.x - x;
    const dy = sp.y - y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = p;
    }
  }
  return best;
}

function onPointerDown(e: PointerEvent): void {
  if (state !== 'playing') return;
  e.preventDefault();
  const { x, y } = canvasCoordsFromEvent(e);
  const p = hitTestPenguin(x, y);
  if (!p) return;
  if (p.mode === 'recall') return; // already on the way
  p.mode = 'recall';
  p.recallEndAt = performance.now() + RECALL_MS;
  p.vx = 0;
}

function onKeyDown(e: KeyboardEvent): void {
  // Restart on R from any state.
  if (e.key === 'r' || e.key === 'R') {
    e.preventDefault();
    startGame();
    return;
  }
  if (state === 'ready' || state === 'gameover') {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      startGame();
    }
  }
}

// ── Init ───────────────────────────────────────────────────────────────────
function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  boardWrap = document.querySelector<HTMLElement>('#board-wrap')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  countEl = document.querySelector<HTMLElement>('#count')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;
  void boardWrap;

  const stored = safeRead<number>(STORAGE_KEY, 0);
  best = Number.isFinite(stored) && stored >= 0 ? stored : 0;
  bestEl.textContent = String(best);

  canvas.addEventListener('pointerdown', onPointerDown);
  restartBtn.addEventListener('click', startGame);
  overlayBtn.addEventListener('click', startGame);
  window.addEventListener('keydown', onKeyDown);

  resetToReady();
}

export const game = defineGame({ init, reset: resetToReady });
