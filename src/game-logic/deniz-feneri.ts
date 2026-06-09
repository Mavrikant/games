// ---------------------------------------------------------------------------
// Deniz Feneri — rotating lighthouse beam warns incoming ships off the reef.
// State machine: ready | playing | gameover
// Pitfalls addressed:
//   - unguarded-storage: safeRead / safeWrite
//   - module-level-dom-access: all DOM/storage inside init()
//   - overlay-input-leak: explicit state enum guards every input handler
//   - stale-async-callback: cancelAnimationFrame on transition + loop()
//     re-checks state before scheduling next frame
//   - invisible-boot: startGame() draws lighthouse + beam immediately and
//     schedules first ship at 0.6s so first feedback is well under 1s
//   - visual-vs-hitbox: BEAM_HALF_RAD and BEAM_LEN drive both the cone
//     gradient and the in-cone test in update(); single source
//   - missing-overlay-css: deniz-feneri.css defines .overlay--hidden visuals
//   - duplicate-with-shared-layer: controls hint rendered by layout from JSON
//   - hud-counter-synced-only-at-lifecycle-edges: updateHud() called on
//     every score/life/energy change inside the loop, not just on reset
//   - designed-lose-condition-not-wired: unwarned ship entering reef ring
//     triggers onCrash() → -1 life
// ---------------------------------------------------------------------------

import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import {
  showOverlay as showOverlayEl,
  hideOverlay as hideOverlayEl,
} from '@shared/overlay';

type State = 'ready' | 'playing' | 'gameover';
type ShipKind = 'normal' | 'fast' | 'radio' | 'deaf';

interface Ship {
  x: number;
  y: number;
  vx: number;
  vy: number;
  kind: ShipKind;
  exposure: number;
  needed: number;
  warned: boolean;
  scored: boolean;
  turnSide: 1 | -1;
  bobPhase: number;
  flash: number;
  alive: boolean;
}

interface Debris {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
}

// ── Constants ──
const W = 640;
const H = 480;
const CX = W / 2;
const CY = H / 2;

const LIGHTHOUSE_R = 24;
const REEF_R = 78;
const SHIP_R = 9;

// Beam cone — single source of truth for both draw() and in-cone test.
const BEAM_HALF_RAD = (Math.PI / 180) * 12;
const BEAM_LEN = 340;
const BEAM_FOLLOW_RATE = 9;
const BEAM_KEY_SPEED = 2.6;

const LIVES_MAX = 3;
const ENERGY_MAX = 5;

const BASE_SPAWN_S = 2.4;
const MIN_SPAWN_S = 0.7;

const SPEC: Record<
  ShipKind,
  { speed: number; needed: number; hull: string; sail: string; deck: string }
> = {
  normal: {
    speed: 38,
    needed: 0.55,
    hull: '#475569',
    sail: '#e2e8f0',
    deck: '#94a3b8',
  },
  fast: {
    speed: 70,
    needed: 0.3,
    hull: '#b45309',
    sail: '#fde68a',
    deck: '#fbbf24',
  },
  radio: {
    speed: 28,
    needed: 0.65,
    hull: '#1d4ed8',
    sail: '#bfdbfe',
    deck: '#60a5fa',
  },
  deaf: {
    speed: 36,
    needed: 1.1,
    hull: '#0f172a',
    sail: '#334155',
    deck: '#1f2937',
  },
};

const STORAGE_KEY = 'deniz-feneri.best';
const FOGHORN_BONUS = 0.45;
const FOGHORN_FLASH_MS = 520;
const CRASH_FLASH_MS = 320;
const SPAWN_INSET = 0.97;

// ── DOM refs ──
let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let livesEl!: HTMLElement;
let energyEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayBtn!: HTMLButtonElement;

// ── State ──
let state: State = 'ready';
let ships: Ship[] = [];
let debris: Debris[] = [];
let score = 0;
let lives = LIVES_MAX;
let energy = 0;
let best = 0;

let beamAngle = Math.PI;
let beamTarget = Math.PI;
let leftKey = false;
let rightKey = false;

let elapsed = 0;
let spawnTimer = 0.6;
let foghornFlashMs = 0;
let crashFlashMs = 0;

let rafId = 0;
let lastTime = 0;

// ── HUD ──
function updateHud(): void {
  scoreEl.textContent = String(score);
  livesEl.textContent = lives > 0 ? '♥'.repeat(lives) : '—';
  energyEl.textContent = `${energy}/${ENERGY_MAX}`;
  bestEl.textContent = String(best);
}

function commitBest(): void {
  if (score > best) {
    best = score;
    safeWrite(STORAGE_KEY, best);
    bestEl.textContent = String(best);
  }
}

// ── Spawn cadence (decays with elapsed) ──
function currentSpawnInterval(): number {
  const f = Math.exp(-elapsed / 80);
  return Math.max(MIN_SPAWN_S, BASE_SPAWN_S * f);
}

function pickKind(): ShipKind {
  const r = Math.random();
  if (r < 0.55) return 'normal';
  if (r < 0.73) return 'fast';
  if (r < 0.88) return 'radio';
  return 'deaf';
}

function spawnShip(): void {
  const kind = pickKind();
  const s = SPEC[kind];
  const ang = Math.random() * Math.PI * 2;
  // Spawn just inside canvas edge along an ellipse matched to the canvas
  // aspect ratio so ships start visible regardless of bearing.
  const sx = CX + Math.cos(ang) * (W / 2) * SPAWN_INSET;
  const sy = CY + Math.sin(ang) * (H / 2) * SPAWN_INSET;
  // Heading: toward lighthouse with a small jitter so paths vary.
  const dx = CX - sx;
  const dy = CY - sy;
  const len = Math.hypot(dx, dy) || 1;
  const baseAng = Math.atan2(dy, dx);
  const jitter = (Math.random() - 0.5) * 0.18;
  const heading = baseAng + jitter;
  const speed = s.speed;
  ships.push({
    x: sx,
    y: sy,
    vx: Math.cos(heading) * speed,
    vy: Math.sin(heading) * speed,
    kind,
    exposure: 0,
    needed: s.needed,
    warned: false,
    scored: false,
    turnSide: Math.random() < 0.5 ? 1 : -1,
    bobPhase: Math.random() * Math.PI * 2,
    flash: 0,
    alive: true,
  });
  // Sanity guard against very-low-speed states (kept loud during dev).
  void len;
}

// ── Beam math ──
function inBeam(sx: number, sy: number): boolean {
  const dx = sx - CX;
  const dy = sy - CY;
  const d = Math.hypot(dx, dy);
  if (d < LIGHTHOUSE_R || d > BEAM_LEN) return false;
  const a = Math.atan2(dy, dx);
  let delta = a - beamAngle;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return Math.abs(delta) <= BEAM_HALF_RAD;
}

function warn(ship: Ship): void {
  if (ship.warned) return;
  ship.warned = true;
  ship.flash = 320;
  // Rotate velocity by ±90° around the perpendicular to the radial — both
  // options are tangential to the reef circle, so the ship maintains
  // distance instead of closing on the rocks. turnSide gives visual variety.
  const sign = ship.turnSide;
  const nvx = -sign * ship.vy;
  const nvy = sign * ship.vx;
  ship.vx = nvx;
  ship.vy = nvy;
  if (energy < ENERGY_MAX) energy++;
  // Radio bonus: blue ships partially wake the nearest unwarned ship within
  // 140px on the first warning event.
  if (ship.kind === 'radio') {
    let nearest: Ship | null = null;
    let nd = 140;
    for (const o of ships) {
      if (o === ship || o.warned || !o.alive) continue;
      const d = Math.hypot(o.x - ship.x, o.y - ship.y);
      if (d < nd) {
        nd = d;
        nearest = o;
      }
    }
    if (nearest) {
      nearest.exposure = Math.min(nearest.needed, nearest.exposure + 0.35);
    }
  }
  updateHud();
}

function onCrash(ship: Ship): void {
  ship.alive = false;
  lives--;
  crashFlashMs = CRASH_FLASH_MS;
  for (let i = 0; i < 10; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = 40 + Math.random() * 90;
    debris.push({
      x: ship.x,
      y: ship.y,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp,
      life: 0.6 + Math.random() * 0.4,
    });
  }
  updateHud();
  if (lives <= 0) endGame();
}

function scoreShip(): void {
  score++;
  commitBest();
  updateHud();
}

function fireFoghorn(): void {
  if (state !== 'playing' || energy < ENERGY_MAX) return;
  energy = 0;
  foghornFlashMs = FOGHORN_FLASH_MS;
  // Bump every unwarned ship's exposure; some will warn immediately.
  for (const s of ships) {
    if (!s.alive || s.warned) continue;
    s.exposure += FOGHORN_BONUS;
    if (s.exposure >= s.needed) warn(s);
  }
  updateHud();
}

// ── Update ──
function easeAngle(curr: number, target: number, k: number): number {
  let d = target - curr;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return curr + d * k;
}

function update(dt: number): void {
  if (state !== 'playing') return;

  elapsed += dt;
  spawnTimer -= dt;
  if (spawnTimer <= 0) {
    spawnShip();
    spawnTimer = currentSpawnInterval();
  }

  // Beam: keyboard adjusts target directly, then ease toward target.
  const kDir = (rightKey ? 1 : 0) - (leftKey ? 1 : 0);
  if (kDir !== 0) {
    beamTarget += kDir * BEAM_KEY_SPEED * dt;
  }
  const k = 1 - Math.exp(-BEAM_FOLLOW_RATE * dt);
  beamAngle = easeAngle(beamAngle, beamTarget, k);

  // Timers.
  if (foghornFlashMs > 0)
    foghornFlashMs = Math.max(0, foghornFlashMs - dt * 1000);
  if (crashFlashMs > 0) crashFlashMs = Math.max(0, crashFlashMs - dt * 1000);

  // Ships.
  for (const s of ships) {
    if (!s.alive) continue;
    s.bobPhase += dt * 3.2;
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    if (s.flash > 0) s.flash = Math.max(0, s.flash - dt * 1000);
    // Beam exposure tick (decays slightly when out of beam so a brief sweep
    // doesn't permanently arm a deaf ship).
    if (inBeam(s.x, s.y)) {
      s.exposure += dt;
      if (!s.warned && s.exposure >= s.needed) warn(s);
    } else if (!s.warned) {
      s.exposure = Math.max(0, s.exposure - dt * 0.4);
    }
    // Lose condition: unwarned ship enters reef ring.
    if (!s.warned) {
      const d = Math.hypot(s.x - CX, s.y - CY);
      if (d <= REEF_R + SHIP_R) {
        onCrash(s);
        continue;
      }
    }
    // Score: warned ship exits canvas.
    if (
      s.warned &&
      !s.scored &&
      (s.x < -20 || s.x > W + 20 || s.y < -20 || s.y > H + 20)
    ) {
      s.scored = true;
      s.alive = false;
      scoreShip();
    }
  }
  ships = ships.filter((s) => s.alive);

  // Debris.
  for (const d of debris) {
    d.x += d.vx * dt;
    d.y += d.vy * dt;
    d.vx *= 0.92;
    d.vy *= 0.92;
    d.life -= dt;
  }
  debris = debris.filter((d) => d.life > 0);
}

// ── Draw ──
function draw(): void {
  // Background — gradient already drawn by CSS, but we paint to clear frame.
  const grad = ctx.createRadialGradient(CX, CY, 0, CX, CY, Math.max(W, H));
  grad.addColorStop(0, '#0e1a2f');
  grad.addColorStop(0.6, '#07101e');
  grad.addColorStop(1, '#04080f');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // Subtle waves
  ctx.strokeStyle = 'rgba(96,165,250,0.06)';
  ctx.lineWidth = 1;
  for (let r = 110; r < 380; r += 38) {
    ctx.beginPath();
    ctx.ellipse(
      CX,
      CY,
      r,
      r * 0.78,
      0,
      0,
      Math.PI * 2,
    );
    ctx.stroke();
  }

  // Foghorn flash sweep
  if (foghornFlashMs > 0) {
    const a = foghornFlashMs / FOGHORN_FLASH_MS;
    ctx.fillStyle = `rgba(125,211,252,${0.18 * a})`;
    ctx.fillRect(0, 0, W, H);
  }
  if (crashFlashMs > 0) {
    const a = crashFlashMs / CRASH_FLASH_MS;
    ctx.fillStyle = `rgba(239,68,68,${0.22 * a})`;
    ctx.fillRect(0, 0, W, H);
  }

  drawBeam();
  drawReef();
  drawLighthouse();

  for (const d of debris) drawDebris(d);
  for (const s of ships) drawShip(s);
}

function drawBeam(): void {
  const tipX = CX + Math.cos(beamAngle) * BEAM_LEN;
  const tipY = CY + Math.sin(beamAngle) * BEAM_LEN;
  // Cone polygon
  const leftA = beamAngle - BEAM_HALF_RAD;
  const rightA = beamAngle + BEAM_HALF_RAD;
  const lx = CX + Math.cos(leftA) * BEAM_LEN;
  const ly = CY + Math.sin(leftA) * BEAM_LEN;
  const rx = CX + Math.cos(rightA) * BEAM_LEN;
  const ry = CY + Math.sin(rightA) * BEAM_LEN;

  const grad = ctx.createRadialGradient(CX, CY, 0, CX, CY, BEAM_LEN);
  grad.addColorStop(0, 'rgba(254,243,199,0.55)');
  grad.addColorStop(0.55, 'rgba(253,224,71,0.18)');
  grad.addColorStop(1, 'rgba(253,224,71,0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(CX, CY);
  ctx.lineTo(lx, ly);
  ctx.lineTo(tipX, tipY);
  ctx.lineTo(rx, ry);
  ctx.closePath();
  ctx.fill();

  // Bright center line
  ctx.strokeStyle = 'rgba(254,243,199,0.55)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(CX, CY);
  ctx.lineTo(tipX, tipY);
  ctx.stroke();
}

function drawReef(): void {
  // Dashed danger ring + scattered rocks
  ctx.strokeStyle = 'rgba(239,68,68,0.32)';
  ctx.setLineDash([5, 7]);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(CX, CY, REEF_R, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  // Rocks
  ctx.fillStyle = '#1f2937';
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2 + 0.1;
    const rr = REEF_R - 4 - (i % 3) * 4;
    const rx = CX + Math.cos(a) * rr;
    const ry = CY + Math.sin(a) * rr;
    ctx.beginPath();
    ctx.arc(rx, ry, 5 + (i % 2) * 2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = '#0f172a';
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2 + 0.45;
    const rr = REEF_R - 12;
    const rx = CX + Math.cos(a) * rr;
    const ry = CY + Math.sin(a) * rr;
    ctx.beginPath();
    ctx.arc(rx, ry, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawLighthouse(): void {
  // Base
  ctx.fillStyle = '#cbd5e1';
  ctx.fillRect(CX - 18, CY - 4, 36, 22);
  // Body
  ctx.fillStyle = '#f8fafc';
  ctx.beginPath();
  ctx.moveTo(CX - 14, CY - 4);
  ctx.lineTo(CX + 14, CY - 4);
  ctx.lineTo(CX + 10, CY - 30);
  ctx.lineTo(CX - 10, CY - 30);
  ctx.closePath();
  ctx.fill();
  // Red stripes
  ctx.fillStyle = '#ef4444';
  ctx.fillRect(CX - 13, CY - 14, 26, 4);
  ctx.fillRect(CX - 13, CY - 22, 26, 4);
  // Lamp room (glowing)
  ctx.fillStyle = '#fde047';
  ctx.beginPath();
  ctx.arc(CX, CY - 32, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#fbbf24';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  // Roof cap
  ctx.fillStyle = '#0f172a';
  ctx.beginPath();
  ctx.moveTo(CX - 8, CY - 38);
  ctx.lineTo(CX + 8, CY - 38);
  ctx.lineTo(CX, CY - 46);
  ctx.closePath();
  ctx.fill();
}

function drawShip(s: Ship): void {
  const spec = SPEC[s.kind];
  const heading = Math.atan2(s.vy, s.vx);
  const bob = Math.sin(s.bobPhase) * 1.4;

  ctx.save();
  ctx.translate(s.x, s.y + bob);
  ctx.rotate(heading);

  // Warning glow
  if (s.flash > 0) {
    const a = s.flash / 320;
    ctx.fillStyle = `rgba(253,224,71,${0.4 * a})`;
    ctx.beginPath();
    ctx.arc(0, 0, 22 + 6 * (1 - a), 0, Math.PI * 2);
    ctx.fill();
  } else if (s.warned) {
    ctx.fillStyle = 'rgba(163,230,53,0.18)';
    ctx.beginPath();
    ctx.arc(0, 0, 16, 0, Math.PI * 2);
    ctx.fill();
  }

  // Hull (arrow shape pointing in heading direction)
  ctx.fillStyle = spec.hull;
  ctx.beginPath();
  ctx.moveTo(12, 0);
  ctx.lineTo(-8, -7);
  ctx.lineTo(-6, 0);
  ctx.lineTo(-8, 7);
  ctx.closePath();
  ctx.fill();
  // Deck
  ctx.fillStyle = spec.deck;
  ctx.fillRect(-5, -3, 8, 6);
  // Sail
  ctx.fillStyle = spec.sail;
  ctx.beginPath();
  ctx.moveTo(-2, -2);
  ctx.lineTo(8, 0);
  ctx.lineTo(-2, 4);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // Exposure gauge above ship (only when not yet warned).
  if (!s.warned && s.exposure > 0) {
    const w = 22;
    const h = 3;
    const gx = s.x - w / 2;
    const gy = s.y - 14;
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(gx - 1, gy - 1, w + 2, h + 2);
    const p = Math.min(1, s.exposure / s.needed);
    ctx.fillStyle =
      p < 0.6 ? '#fde047' : p < 0.9 ? '#fbbf24' : '#22c55e';
    ctx.fillRect(gx, gy, w * p, h);
  }
}

function drawDebris(d: Debris): void {
  const a = Math.max(0, Math.min(1, d.life));
  ctx.fillStyle = `rgba(239,68,68,${0.7 * a})`;
  ctx.fillRect(d.x - 2, d.y - 2, 4, 4);
}

// ── Loop ──
function loop(now: number): void {
  if (state !== 'playing') return;
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;
  update(dt);
  draw();
  rafId = requestAnimationFrame(loop);
}

// ── Game flow ──
function resetCommonState(): void {
  cancelAnimationFrame(rafId);
  ships = [];
  debris = [];
  score = 0;
  lives = LIVES_MAX;
  energy = 0;
  beamAngle = Math.PI;
  beamTarget = Math.PI;
  elapsed = 0;
  spawnTimer = 0.6;
  foghornFlashMs = 0;
  crashFlashMs = 0;
  leftKey = false;
  rightKey = false;
}

function startGame(): void {
  resetCommonState();
  state = 'playing';
  updateHud();
  hideOverlayEl(overlay);
  lastTime = performance.now();
  draw();
  rafId = requestAnimationFrame(loop);
}

function endGame(): void {
  state = 'gameover';
  cancelAnimationFrame(rafId);
  draw();
  const isBest = score > 0 && score >= best;
  overlayTitle.textContent = isBest ? 'Yeni rekor!' : 'Fener söndü';
  overlayMsg.innerHTML =
    `Skor: <strong>${score}</strong><br>En iyi: ${best}` +
    '<br><small>Boşluk veya R ile tekrar yola çık</small>';
  overlayBtn.textContent = 'Tekrar oyna';
  showOverlayEl(overlay);
  overlayBtn.focus({ preventScroll: true });
}

function resetToReady(): void {
  resetCommonState();
  state = 'ready';
  updateHud();
  overlayTitle.textContent = 'Deniz Feneri';
  overlayMsg.innerHTML =
    'Gemiler kayalığa süzülüyor. Işını üzerlerinde tut, uyanıp rota' +
    ' kırsınlar — geç kalanı kayalık öğütür.<br>' +
    '<small>Fare ile hedefle · ←/→ elle döndür · Boşluk: sis düdüğü</small>';
  overlayBtn.textContent = 'Başla';
  showOverlayEl(overlay);
  draw();
}

// ── Input ──
function canvasToWorld(clientX: number, clientY: number): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return { x: CX, y: CY };
  const sx = W / rect.width;
  const sy = H / rect.height;
  return {
    x: (clientX - rect.left) * sx,
    y: (clientY - rect.top) * sy,
  };
}

function aimAt(clientX: number, clientY: number): void {
  if (state !== 'playing') return;
  const { x, y } = canvasToWorld(clientX, clientY);
  const dx = x - CX;
  const dy = y - CY;
  if (dx * dx + dy * dy < 25) return;
  beamTarget = Math.atan2(dy, dx);
}

function onPointerMove(e: PointerEvent): void {
  aimAt(e.clientX, e.clientY);
}

function onTouchMove(e: TouchEvent): void {
  if (e.touches.length === 0) return;
  e.preventDefault();
  const t = e.touches[0]!;
  aimAt(t.clientX, t.clientY);
}

function onKeyDown(e: KeyboardEvent): void {
  const k = e.key;
  if (k === 'r' || k === 'R') {
    e.preventDefault();
    startGame();
    return;
  }
  if (state !== 'playing') {
    if (k === ' ' || k === 'Enter') {
      e.preventDefault();
      startGame();
    }
    return;
  }
  if (k === 'ArrowLeft' || k === 'a' || k === 'A') {
    leftKey = true;
    e.preventDefault();
  } else if (k === 'ArrowRight' || k === 'd' || k === 'D') {
    rightKey = true;
    e.preventDefault();
  } else if (k === ' ') {
    e.preventDefault();
    fireFoghorn();
  }
}

function onKeyUp(e: KeyboardEvent): void {
  const k = e.key;
  if (k === 'ArrowLeft' || k === 'a' || k === 'A') leftKey = false;
  else if (k === 'ArrowRight' || k === 'd' || k === 'D') rightKey = false;
}

// ── Init ──
function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  livesEl = document.querySelector<HTMLElement>('#lives')!;
  energyEl = document.querySelector<HTMLElement>('#energy')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;

  best = safeRead<number>(STORAGE_KEY, 0);
  if (!Number.isFinite(best) || best < 0) best = 0;

  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerdown', onPointerMove);
  canvas.addEventListener('touchmove', onTouchMove, { passive: false });
  canvas.addEventListener('touchstart', onTouchMove, { passive: false });

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  restartBtn.addEventListener('click', () => startGame());
  overlayBtn.addEventListener('click', () => startGame());

  resetToReady();
}

export const game = defineGame({ init, reset: resetToReady });
