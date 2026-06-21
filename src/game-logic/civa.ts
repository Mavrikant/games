// ---------------------------------------------------------------------------
// Cıva — tilt-tray mercury merging puzzle. The player tilts a flat tray
// (keyboard or pointer) to slide droplets around; touching droplets merge
// instantly with area-conserving radius growth and momentum-preserving
// velocity. Sinkholes drain mass on contact. A level is cleared when only
// one droplet remains; the game ends when all droplets are drained.
//
// State machine: ready | playing | levelclear | gameover
//
// PITFALLS addressed:
//  - module-level-dom-access:        all DOM access inside init()
//  - unguarded-storage:              @shared/storage safeRead/safeWrite
//  - stale-async-callback:           gen-token guards RAF chain
//  - overlay-input-leak:             state enum guards every input handler
//  - missing-overlay-css:            per-game CSS defines .overlay--hidden
//  - visual-vs-hitbox:               draw() and collide() read the same
//                                    `radius` field on each droplet
//  - invisible-boot:                 ready state renders the populated tray
//                                    behind the overlay so the cold load is
//                                    not a black square
//  - hud-counter-synced-only-at-lifecycle-edges:
//                                    score / drops / level pushed each frame
//                                    whenever the underlying values change
//  - unreachable-start-state:        overlay button + Space/Enter both start;
//                                    R restarts from any state
//  - designed-lose-condition-not-wired:
//                                    alive-count reaching 0 calls endGame()
//  - deadzone-blocks-keyboard-steering:
//                                    keyboard direction normalized to unit
//                                    vector before scaling, never compared
//                                    to a pixel threshold
//  - cap-counts-dead-entities:       merge pass + level checks use the live
//                                    droplet list rebuilt each pass
// ---------------------------------------------------------------------------

import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import {
  showOverlay as showOverlayEl,
  hideOverlay as hideOverlayEl,
} from '@shared/overlay';

type State = 'ready' | 'playing' | 'levelclear' | 'gameover';

// ── Geometry (canvas px) ───────────────────────────────────────────────────
const CANVAS = 480;
const TRAY_MARGIN = 14;
const TRAY_X0 = TRAY_MARGIN;
const TRAY_Y0 = TRAY_MARGIN;
const TRAY_X1 = CANVAS - TRAY_MARGIN;
const TRAY_Y1 = CANVAS - TRAY_MARGIN;

// ── Physics constants ──────────────────────────────────────────────────────
const GRAVITY = 520; // px/s² at full tilt
const FRICTION = 1.4; // per-second exponential decay of velocity
const WALL_BOUNCE = 0.55; // velocity multiplier on wall hit
const MERGE_MOMENTUM_LOSS = 0.85; // post-merge velocity scaled by this
const MIN_RADIUS = 6; // below this, droplet is absorbed
const HOLE_DRAIN_RATE = 14; // radius shrink px/s while overlapping a hole
const TILT_RETURN = 6.0; // per-second decay of unforced tilt → 0
const POINTER_MAX_PX = 130; // pointer offset for tilt = 1.0

// ── Scoring constants ──────────────────────────────────────────────────────
const LEVEL_BASE_BONUS = 25;
const LEVEL_MASS_BONUS = 80; // × preservedFraction × level

const STORAGE_KEY = 'civa.best';

// ── Types ──────────────────────────────────────────────────────────────────
interface Drop {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  alive: boolean;
}

interface Hole {
  x: number;
  y: number;
  r: number;
}

// ── Mutable state ──────────────────────────────────────────────────────────
const gen = createGenToken();
let state: State = 'ready';
let score = 0;
let best = 0;
let level = 1;

let drops: Drop[] = [];
let holes: Hole[] = [];
let levelStartArea = 0;

// Tilt = current gravity direction (continuous). length ∈ [0,1].
let tiltX = 0;
let tiltY = 0;

// Input
let keyLeft = false;
let keyRight = false;
let keyUp = false;
let keyDown = false;
let pointerActive = false;
let pointerDx = 0;
let pointerDy = 0;

// Loop timing
let lastFrame = 0;

// HUD shadow
let lastScoreShown = -1;
let lastLevelShown = -1;
let lastDropsShown = -1;

// DOM refs
let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let levelEl!: HTMLElement;
let dropsEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayBtn!: HTMLButtonElement;

// ── Helpers ────────────────────────────────────────────────────────────────
function dropArea(d: Drop): number {
  return Math.PI * d.r * d.r;
}

function liveDrops(): Drop[] {
  return drops.filter((d) => d.alive);
}

function totalLiveArea(): number {
  let s = 0;
  for (const d of drops) if (d.alive) s += dropArea(d);
  return s;
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function placeDropsForLevel(lv: number): void {
  drops = [];
  holes = [];

  const count = Math.min(3 + lv, 9);
  const minR = 14;
  const maxR = 22;

  // Place drops without overlapping each other; keep them away from walls.
  let attempts = 0;
  while (drops.length < count && attempts < 600) {
    attempts++;
    const r = rand(minR, maxR);
    const x = rand(TRAY_X0 + r + 4, TRAY_X1 - r - 4);
    const y = rand(TRAY_Y0 + r + 4, TRAY_Y1 - r - 4);
    let ok = true;
    for (const o of drops) {
      const dx = o.x - x;
      const dy = o.y - y;
      if (Math.hypot(dx, dy) < o.r + r + 12) {
        ok = false;
        break;
      }
    }
    if (ok) drops.push({ x, y, vx: 0, vy: 0, r, alive: true });
  }

  // Holes: start at 0 for level 1, grow gently. Cap so the tray stays fair.
  const holeCount = Math.min(Math.max(0, lv - 1), 5);
  attempts = 0;
  while (holes.length < holeCount && attempts < 400) {
    attempts++;
    const hr = rand(14, 20);
    const x = rand(TRAY_X0 + hr + 30, TRAY_X1 - hr - 30);
    const y = rand(TRAY_Y0 + hr + 30, TRAY_Y1 - hr - 30);
    // Avoid putting a hole right under a starting droplet.
    let ok = true;
    for (const d of drops) {
      if (Math.hypot(d.x - x, d.y - y) < d.r + hr + 14) {
        ok = false;
        break;
      }
    }
    for (const h of holes) {
      if (Math.hypot(h.x - x, h.y - y) < h.r + hr + 20) {
        ok = false;
        break;
      }
    }
    if (ok) holes.push({ x, y, r: hr });
  }

  levelStartArea = totalLiveArea();
}

// ── State transitions ──────────────────────────────────────────────────────
function showStartOverlay(): void {
  overlayTitle.textContent = 'Cıva';
  overlayMsg.innerHTML =
    'Tepsiyi eğ, dağılan damlaları <strong>birleştir</strong>.<br>' +
    '<small>← ↑ ↓ → · WASD · veya sahaya parmakla sürükle</small>';
  overlayBtn.textContent = 'Başla';
  showOverlayEl(overlay);
  overlayBtn.focus({ preventScroll: true });
}

function showLevelClearOverlay(bonus: number): void {
  overlayTitle.textContent = `Seviye ${level} tamam`;
  const pct = levelStartArea > 0
    ? Math.round((totalLiveArea() / levelStartArea) * 100)
    : 0;
  overlayMsg.innerHTML =
    `Kütlenin <strong>${pct}%</strong>'si korundu · +${bonus} puan<br>` +
    `Toplam skor: ${score}<br>` +
    '<small>Boşluk · Enter · veya butona bas</small>';
  overlayBtn.textContent = 'Sonraki seviye';
  showOverlayEl(overlay);
  overlayBtn.focus({ preventScroll: true });
}

function showGameOverOverlay(): void {
  const isRecord = score > 0 && score >= best;
  overlayTitle.textContent = isRecord ? 'Yeni rekor!' : 'Cıva tükendi';
  overlayMsg.innerHTML =
    `Skor: <strong>${score}</strong> · Seviye: ${level}<br>` +
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
  level = 1;
  tiltX = 0;
  tiltY = 0;
  keyLeft = keyRight = keyUp = keyDown = false;
  pointerActive = false;
  pointerDx = pointerDy = 0;
  placeDropsForLevel(level);
  syncHud();
  draw();
  showStartOverlay();
}

function startGame(): void {
  // Used both for fresh start and "next level" transition. Caller decides
  // whether to advance level/keep score first.
  gen.bump();
  state = 'playing';
  tiltX = 0;
  tiltY = 0;
  keyLeft = keyRight = keyUp = keyDown = false;
  pointerActive = false;
  pointerDx = pointerDy = 0;
  syncHud();
  lastFrame = performance.now();
  hideOverlayEl(overlay);
  scheduleFrame();
}

function startFresh(): void {
  score = 0;
  level = 1;
  placeDropsForLevel(level);
  startGame();
}

function advanceLevel(): void {
  level += 1;
  placeDropsForLevel(level);
  startGame();
}

function clearLevel(): void {
  if (state !== 'playing') return;
  state = 'levelclear';
  gen.bump();
  const preservedFrac = levelStartArea > 0
    ? Math.min(1, totalLiveArea() / levelStartArea)
    : 0;
  const bonus =
    LEVEL_BASE_BONUS + Math.round(preservedFrac * LEVEL_MASS_BONUS * level);
  score += bonus;
  commitBest();
  syncHud();
  showLevelClearOverlay(bonus);
}

function endGame(): void {
  if (state === 'gameover') return;
  state = 'gameover';
  gen.bump();
  commitBest();
  syncHud();
  showGameOverOverlay();
}

function commitBest(): void {
  if (score > best) {
    best = score;
    safeWrite(STORAGE_KEY, best);
  }
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

function readInputTilt(): { x: number; y: number } {
  if (pointerActive) {
    const len = Math.hypot(pointerDx, pointerDy);
    if (len < 6) return { x: 0, y: 0 }; // pointer-only deadzone (pixels)
    const scale = Math.min(1, len / POINTER_MAX_PX) / len;
    return { x: pointerDx * scale, y: pointerDy * scale };
  }
  // Keyboard: any pressed key contributes a unit-vector component. We
  // normalize so diagonal pairs don't exceed magnitude 1, and we DO NOT
  // apply a pixel-mode deadzone here (PITFALLS#deadzone-blocks-keyboard-steering).
  let kx = 0;
  let ky = 0;
  if (keyLeft) kx -= 1;
  if (keyRight) kx += 1;
  if (keyUp) ky -= 1;
  if (keyDown) ky += 1;
  if (kx === 0 && ky === 0) return { x: 0, y: 0 };
  const klen = Math.hypot(kx, ky);
  return { x: kx / klen, y: ky / klen };
}

function frame(now: number): void {
  let dt = (now - lastFrame) / 1000;
  if (dt > 0.05) dt = 0.05;
  if (dt < 0) dt = 0;
  lastFrame = now;

  // Tilt easing: blend toward input vector to avoid jolting transitions.
  const desired = readInputTilt();
  const blend = Math.min(1, TILT_RETURN * dt);
  tiltX += (desired.x - tiltX) * blend;
  tiltY += (desired.y - tiltY) * blend;
  if (Math.hypot(tiltX, tiltY) < 0.001) {
    tiltX = 0;
    tiltY = 0;
  }

  const ax = tiltX * GRAVITY;
  const ay = tiltY * GRAVITY;

  // Per-drop physics --------------------------------------------------------
  const decay = Math.exp(-FRICTION * dt);
  for (const d of drops) {
    if (!d.alive) continue;
    d.vx = (d.vx + ax * dt) * decay;
    d.vy = (d.vy + ay * dt) * decay;
    d.x += d.vx * dt;
    d.y += d.vy * dt;

    // Wall bounce
    if (d.x - d.r < TRAY_X0) {
      d.x = TRAY_X0 + d.r;
      if (d.vx < 0) d.vx = -d.vx * WALL_BOUNCE;
    }
    if (d.x + d.r > TRAY_X1) {
      d.x = TRAY_X1 - d.r;
      if (d.vx > 0) d.vx = -d.vx * WALL_BOUNCE;
    }
    if (d.y - d.r < TRAY_Y0) {
      d.y = TRAY_Y0 + d.r;
      if (d.vy < 0) d.vy = -d.vy * WALL_BOUNCE;
    }
    if (d.y + d.r > TRAY_Y1) {
      d.y = TRAY_Y1 - d.r;
      if (d.vy > 0) d.vy = -d.vy * WALL_BOUNCE;
    }

    // Sinkholes: drain mass while the droplet center is within hole + half r.
    for (const h of holes) {
      const dist = Math.hypot(d.x - h.x, d.y - h.y);
      if (dist < h.r + d.r * 0.4) {
        d.r -= HOLE_DRAIN_RATE * dt;
        if (d.r < MIN_RADIUS) {
          d.alive = false;
          break;
        }
      }
    }
  }

  // Merge pass: repeat until no merges occur. Per-pass: scan all live pairs.
  for (let safety = 0; safety < 10; safety++) {
    const live = liveDrops();
    let mergedAny = false;
    outer: for (let i = 0; i < live.length; i++) {
      const a = live[i]!;
      for (let j = i + 1; j < live.length; j++) {
        const b = live[j]!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy);
        if (dist < a.r + b.r - 0.5) {
          mergeDrops(a, b);
          mergedAny = true;
          break outer;
        }
      }
    }
    if (!mergedAny) break;
  }

  // Lose / win checks ------------------------------------------------------
  const aliveCount = drops.reduce((n, d) => n + (d.alive ? 1 : 0), 0);
  if (aliveCount === 0) {
    draw();
    endGame();
    return;
  }
  if (aliveCount === 1) {
    draw();
    clearLevel();
    return;
  }

  syncHud();
  draw();
}

function mergeDrops(a: Drop, b: Drop): void {
  // Conserve area → r = sqrt(r1² + r2²). Conserve linear momentum.
  const aArea = dropArea(a);
  const bArea = dropArea(b);
  const totalArea = aArea + bArea;
  const ma = aArea;
  const mb = bArea;
  const totalMass = ma + mb;

  // Position: mass-weighted average.
  a.x = (a.x * ma + b.x * mb) / totalMass;
  a.y = (a.y * ma + b.y * mb) / totalMass;
  // Velocity: conserve momentum, then lose a small fraction to merging.
  a.vx = ((a.vx * ma + b.vx * mb) / totalMass) * MERGE_MOMENTUM_LOSS;
  a.vy = ((a.vy * ma + b.vy * mb) / totalMass) * MERGE_MOMENTUM_LOSS;
  a.r = Math.sqrt(totalArea / Math.PI);
  // Clamp to tray after radius grows so the new sphere doesn't poke out.
  a.x = Math.max(TRAY_X0 + a.r, Math.min(TRAY_X1 - a.r, a.x));
  a.y = Math.max(TRAY_Y0 + a.r, Math.min(TRAY_Y1 - a.r, a.y));
  b.alive = false;
}

// ── HUD ─────────────────────────────────────────────────────────────────────
function syncHud(): void {
  if (score !== lastScoreShown) {
    scoreEl.textContent = String(score);
    lastScoreShown = score;
  }
  if (level !== lastLevelShown) {
    levelEl.textContent = String(level);
    lastLevelShown = level;
  }
  const aliveCount = drops.reduce((n, d) => n + (d.alive ? 1 : 0), 0);
  if (aliveCount !== lastDropsShown) {
    dropsEl.textContent = String(aliveCount);
    lastDropsShown = aliveCount;
  }
  if (Number(bestEl.textContent) !== best) {
    bestEl.textContent = String(best);
  }
}

// ── Render ─────────────────────────────────────────────────────────────────
function draw(): void {
  ctx.save();
  // Tray background — subtle metallic gradient shifted by tilt for "feel".
  const shiftX = tiltX * 18;
  const shiftY = tiltY * 18;
  const grad = ctx.createRadialGradient(
    CANVAS / 2 - shiftX,
    CANVAS / 2 - shiftY,
    20,
    CANVAS / 2,
    CANVAS / 2,
    CANVAS * 0.75,
  );
  grad.addColorStop(0, '#2b3140');
  grad.addColorStop(1, '#0f1218');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, CANVAS, CANVAS);

  // Tray rim (inset rectangle)
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 2;
  ctx.strokeRect(TRAY_X0, TRAY_Y0, TRAY_X1 - TRAY_X0, TRAY_Y1 - TRAY_Y0);

  // Sinkholes
  for (const h of holes) {
    const hg = ctx.createRadialGradient(h.x, h.y, 1, h.x, h.y, h.r);
    hg.addColorStop(0, '#000');
    hg.addColorStop(0.7, '#0a0c12');
    hg.addColorStop(1, 'rgba(10,12,18,0)');
    ctx.fillStyle = hg;
    ctx.beginPath();
    ctx.arc(h.x, h.y, h.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(180,200,255,0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(h.x, h.y, h.r, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Tilt indicator: small arrow from canvas center.
  const tlen = Math.hypot(tiltX, tiltY);
  if (tlen > 0.04) {
    const cx = CANVAS / 2;
    const cy = CANVAS / 2;
    const lx = tiltX * 60;
    const ly = tiltY * 60;
    ctx.save();
    ctx.globalAlpha = 0.18;
    ctx.strokeStyle = '#9ca3af';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + lx, cy + ly);
    ctx.stroke();
    ctx.restore();
  }

  // Droplets — sorted by radius so smaller ones don't bury big highlights.
  const live = liveDrops().sort((a, b) => b.r - a.r);
  for (const d of live) {
    drawDroplet(d);
  }

  ctx.restore();
}

function drawDroplet(d: Drop): void {
  // Soft outer shadow
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.beginPath();
  ctx.arc(d.x + 2, d.y + 4, d.r, 0, Math.PI * 2);
  ctx.fill();

  // Mercury body — radial silver gradient, highlight offset by tilt.
  const hx = d.x - d.r * 0.35 - tiltX * d.r * 0.3;
  const hy = d.y - d.r * 0.4 - tiltY * d.r * 0.3;
  const g = ctx.createRadialGradient(hx, hy, d.r * 0.1, d.x, d.y, d.r);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(0.18, '#e7eaf0');
  g.addColorStop(0.55, '#9ea4b3');
  g.addColorStop(1, '#3e4453');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
  ctx.fill();

  // Rim
  ctx.strokeStyle = 'rgba(0,0,0,0.4)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
  ctx.stroke();

  // Specular highlight
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.beginPath();
  ctx.arc(hx, hy, Math.max(2, d.r * 0.25), 0, Math.PI * 2);
  ctx.fill();
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

function onPointerDown(e: PointerEvent): void {
  if (state !== 'playing') return;
  e.preventDefault();
  const p = canvasCoordsFromEvent(e);
  pointerActive = true;
  pointerDx = p.x - CANVAS / 2;
  pointerDy = p.y - CANVAS / 2;
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {
    // synthetic events can throw; safe to ignore.
  }
}

function onPointerMove(e: PointerEvent): void {
  if (!pointerActive) return;
  const p = canvasCoordsFromEvent(e);
  pointerDx = p.x - CANVAS / 2;
  pointerDy = p.y - CANVAS / 2;
}

function onPointerUp(e: PointerEvent): void {
  pointerActive = false;
  pointerDx = 0;
  pointerDy = 0;
  try {
    canvas.releasePointerCapture(e.pointerId);
  } catch {
    // ignore
  }
}

function startOrAdvance(): void {
  if (state === 'ready' || state === 'gameover') {
    startFresh();
  } else if (state === 'levelclear') {
    advanceLevel();
  }
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.key === 'r' || e.key === 'R') {
    e.preventDefault();
    startFresh();
    return;
  }
  if (state !== 'playing') {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      startOrAdvance();
    }
    return;
  }
  switch (e.key) {
    case 'ArrowLeft':
    case 'a':
    case 'A':
      e.preventDefault();
      keyLeft = true;
      break;
    case 'ArrowRight':
    case 'd':
    case 'D':
      e.preventDefault();
      keyRight = true;
      break;
    case 'ArrowUp':
    case 'w':
    case 'W':
      e.preventDefault();
      keyUp = true;
      break;
    case 'ArrowDown':
    case 's':
    case 'S':
      e.preventDefault();
      keyDown = true;
      break;
  }
}

function onKeyUp(e: KeyboardEvent): void {
  switch (e.key) {
    case 'ArrowLeft':
    case 'a':
    case 'A':
      keyLeft = false;
      break;
    case 'ArrowRight':
    case 'd':
    case 'D':
      keyRight = false;
      break;
    case 'ArrowUp':
    case 'w':
    case 'W':
      keyUp = false;
      break;
    case 'ArrowDown':
    case 's':
    case 'S':
      keyDown = false;
      break;
  }
}

// ── Init ────────────────────────────────────────────────────────────────────
function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  levelEl = document.querySelector<HTMLElement>('#level')!;
  dropsEl = document.querySelector<HTMLElement>('#drops')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;

  const stored = safeRead<number>(STORAGE_KEY, 0);
  best = Number.isFinite(stored) && stored >= 0 ? stored : 0;
  bestEl.textContent = String(best);

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('pointerleave', onPointerUp);

  restartBtn.addEventListener('click', () => {
    startFresh();
  });
  overlayBtn.addEventListener('click', () => {
    startOrAdvance();
  });

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  resetToReady();
}

export const game = defineGame({ init, reset: resetToReady });
