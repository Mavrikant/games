// ---------------------------------------------------------------------------
// Şimşek Tutucu — predictive lightning-catcher
// State machine: ready | playing | gameover
// Pitfalls addressed:
//   - unguarded-storage: safeRead / safeWrite
//   - module-level-dom-access: all DOM/storage inside init()
//   - overlay-input-leak: explicit state enum guards every input handler
//   - stale-async-callback: cancelAnimationFrame on every transition + loop()
//     re-checks state before scheduling next frame
//   - invisible-boot: startGame() immediately draws + schedules first cloud
//     in 0.6s so the first feedback is well under 1s
//   - visual-vs-hitbox: rod width is read by both update() and draw() from a
//     single currentRodWidth() function; bolt collision checks the rod's
//     actual draw rectangle (no separate hidden hitbox)
//   - missing-overlay-css: simsek-tutucu.css defines .overlay--hidden visuals
//   - duplicate-with-shared-layer: controls hint rendered by layout from JSON
// ---------------------------------------------------------------------------

import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import {
  showOverlay as showOverlayEl,
  hideOverlay as hideOverlayEl,
} from '@shared/overlay';

type State = 'ready' | 'playing' | 'gameover';
type CloudKind = 'normal' | 'fast' | 'wide';

interface Cloud {
  x: number;
  y: number;
  vx: number;
  charge: number;
  chargeTime: number;
  kind: CloudKind;
  fired: boolean;
}

interface Bolt {
  x: number;
  startY: number;
  y: number;
  kind: CloudKind;
  status: 'falling' | 'caught' | 'missed';
  flash: number;
  jitterSeed: number;
}

// ── Constants ──
const W = 640;
const H = 480;
const GROUND_Y = H - 16;
const ROD_Y = H - 50;
const ROD_H = 14;
const ROD_BASE_W = 70;
const ROD_BOOST_W = 140;
const ROD_BOOST_MS = 6000;
const ROD_KEY_SPEED = 480;
const ROD_FOLLOW_RATE = 14;

const BOLT_SPEED = 720;
const CLOUD_RADIUS = 32;
const CLOUD_VX_MIN = 25;
const CLOUD_VX_MAX = 75;
const CLOUD_Y_MIN = 55;
const CLOUD_Y_MAX = 140;

const CHARGE_TIMES: Record<CloudKind, number> = {
  normal: 2.0,
  fast: 1.2,
  wide: 2.6,
};
const SCORE_VALUE: Record<CloudKind, number> = {
  normal: 1,
  fast: 3,
  wide: 1,
};

const ENERGY_MAX = 5;
const LIVES_MAX = 3;
const BASE_SPAWN_S = 2.2;
const MIN_SPAWN_S = 0.6;

const STORAGE_KEY = 'simsek-tutucu.best';

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
let clouds: Cloud[] = [];
let bolts: Bolt[] = [];
let score = 0;
let lives = LIVES_MAX;
let energy = 0;
let best = 0;

let rodX = W / 2;
let rodTargetX = W / 2;
let rodWidthBoostMs = 0;
let leftKey = false;
let rightKey = false;

let elapsed = 0;
let spawnTimer = 0.6;
let burstFlashMs = 0;
let missFlashMs = 0;

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

// ── Spawn cadence ──
function currentSpawnInterval(): number {
  // Decays exponentially with elapsed seconds; floor at MIN_SPAWN_S.
  const f = Math.exp(-elapsed / 70);
  return Math.max(MIN_SPAWN_S, BASE_SPAWN_S * f);
}

function spawnCloud(): void {
  const roll = Math.random();
  const kind: CloudKind =
    roll < 0.15 ? 'fast' : roll < 0.3 ? 'wide' : 'normal';
  const x = 60 + Math.random() * (W - 120);
  const y = CLOUD_Y_MIN + Math.random() * (CLOUD_Y_MAX - CLOUD_Y_MIN);
  const dir = Math.random() < 0.5 ? -1 : 1;
  const vx = dir * (CLOUD_VX_MIN + Math.random() * (CLOUD_VX_MAX - CLOUD_VX_MIN));
  clouds.push({
    x,
    y,
    vx,
    charge: 0,
    chargeTime: CHARGE_TIMES[kind],
    kind,
    fired: false,
  });
}

function fireBolt(c: Cloud): void {
  bolts.push({
    x: c.x,
    startY: c.y + CLOUD_RADIUS * 0.4,
    y: c.y + CLOUD_RADIUS * 0.4,
    kind: c.kind,
    status: 'falling',
    flash: 0,
    jitterSeed: Math.random() * 1000,
  });
  c.fired = true;
}

function currentRodWidth(): number {
  return rodWidthBoostMs > 0 ? ROD_BOOST_W : ROD_BASE_W;
}

// ── Scoring events ──
function onCatch(kind: CloudKind): void {
  score += SCORE_VALUE[kind];
  if (kind === 'wide') {
    rodWidthBoostMs = ROD_BOOST_MS;
  }
  if (energy < ENERGY_MAX) energy++;
  commitBest();
  updateHud();
}

function onMiss(): void {
  lives--;
  missFlashMs = 280;
  updateHud();
  if (lives <= 0) {
    endGame();
  }
}

function fireBurst(): void {
  if (state !== 'playing' || energy < ENERGY_MAX) return;
  energy = 0;
  burstFlashMs = 360;
  for (const b of bolts) {
    if (b.status === 'falling') {
      b.status = 'caught';
      b.flash = 240;
      score += SCORE_VALUE[b.kind];
      if (b.kind === 'wide') rodWidthBoostMs = ROD_BOOST_MS;
    }
  }
  commitBest();
  updateHud();
}

// ── Update ──
function update(dt: number): void {
  if (state !== 'playing') return;

  elapsed += dt;
  spawnTimer -= dt;
  if (spawnTimer <= 0) {
    spawnCloud();
    spawnTimer = currentSpawnInterval();
  }

  // rod keyboard movement
  const dir = (rightKey ? 1 : 0) - (leftKey ? 1 : 0);
  if (dir !== 0) {
    rodTargetX = Math.max(
      0,
      Math.min(W, rodTargetX + dir * ROD_KEY_SPEED * dt),
    );
  }
  // smooth follow (works for both mouse and keyboard updates of rodTargetX)
  const k = 1 - Math.exp(-ROD_FOLLOW_RATE * dt);
  rodX += (rodTargetX - rodX) * k;
  if (rodX < 0) rodX = 0;
  if (rodX > W) rodX = W;

  // timers
  if (rodWidthBoostMs > 0) {
    rodWidthBoostMs = Math.max(0, rodWidthBoostMs - dt * 1000);
  }
  if (burstFlashMs > 0) {
    burstFlashMs = Math.max(0, burstFlashMs - dt * 1000);
  }
  if (missFlashMs > 0) {
    missFlashMs = Math.max(0, missFlashMs - dt * 1000);
  }

  // clouds: drift, bounce, charge, fire
  for (const c of clouds) {
    c.x += c.vx * dt;
    if (c.x < 40) {
      c.x = 40;
      c.vx = Math.abs(c.vx);
    } else if (c.x > W - 40) {
      c.x = W - 40;
      c.vx = -Math.abs(c.vx);
    }
    if (!c.fired) {
      c.charge += dt / c.chargeTime;
      if (c.charge >= 1) {
        c.charge = 1;
        fireBolt(c);
      }
    }
  }
  clouds = clouds.filter((c) => !c.fired);

  // bolts: descend, hit rod or ground
  const rodW = currentRodWidth();
  const rodLeft = rodX - rodW / 2;
  const rodRight = rodX + rodW / 2;
  for (const b of bolts) {
    if (b.status !== 'falling') continue;
    b.y += BOLT_SPEED * dt;
    // crossing the rod band catches; outside band misses ground
    if (b.y >= ROD_Y && b.x >= rodLeft && b.x <= rodRight) {
      b.status = 'caught';
      b.flash = 240;
      onCatch(b.kind);
    } else if (b.y >= GROUND_Y) {
      b.status = 'missed';
      b.flash = 320;
      onMiss();
    }
  }
  for (const b of bolts) {
    if (b.status !== 'falling' && b.flash > 0) b.flash -= dt * 1000;
  }
  bolts = bolts.filter((b) => b.status === 'falling' || b.flash > 0);
}

// ── Draw ──
function draw(): void {
  ctx.fillStyle = '#0c1118';
  ctx.fillRect(0, 0, W, H);

  // subtle stars
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  for (let i = 0; i < 28; i++) {
    const sx = (i * 73 + Math.floor(elapsed * 6)) % W;
    const sy = (i * 41) % (CLOUD_Y_MAX + 20);
    ctx.fillRect(sx, sy, 1, 1);
  }

  // miss flash (red vignette at ground)
  if (missFlashMs > 0) {
    const a = missFlashMs / 280;
    ctx.fillStyle = `rgba(239,68,68,${0.22 * a})`;
    ctx.fillRect(0, 0, W, H);
  }

  // burst flash (purple sweep)
  if (burstFlashMs > 0) {
    const a = burstFlashMs / 360;
    ctx.fillStyle = `rgba(168,85,247,${0.3 * a})`;
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = `rgba(216,180,254,${0.9 * a})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, ROD_Y - 4);
    ctx.lineTo(W, ROD_Y - 4);
    ctx.stroke();
  }

  // ground line
  ctx.strokeStyle = '#1f2937';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, GROUND_Y);
  ctx.lineTo(W, GROUND_Y);
  ctx.stroke();

  // clouds
  for (const c of clouds) drawCloud(c);
  // bolts
  for (const b of bolts) drawBolt(b);
  // rod
  drawRod();
}

function cloudColors(kind: CloudKind): { top: string; bottom: string } {
  switch (kind) {
    case 'fast':
      return { top: '#fbbf24', bottom: '#b45309' };
    case 'wide':
      return { top: '#60a5fa', bottom: '#1d4ed8' };
    default:
      return { top: '#9ca3af', bottom: '#374151' };
  }
}

function drawCloud(c: Cloud): void {
  const { top, bottom } = cloudColors(c.kind);
  ctx.fillStyle = bottom;
  ctx.beginPath();
  ctx.arc(c.x - 18, c.y + 6, CLOUD_RADIUS * 0.7, 0, Math.PI * 2);
  ctx.arc(c.x + 18, c.y + 6, CLOUD_RADIUS * 0.7, 0, Math.PI * 2);
  ctx.arc(c.x, c.y + 10, CLOUD_RADIUS * 0.85, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = top;
  ctx.beginPath();
  ctx.arc(c.x - 16, c.y - 2, CLOUD_RADIUS * 0.7, 0, Math.PI * 2);
  ctx.arc(c.x + 16, c.y - 2, CLOUD_RADIUS * 0.7, 0, Math.PI * 2);
  ctx.arc(c.x, c.y, CLOUD_RADIUS * 0.9, 0, Math.PI * 2);
  ctx.fill();

  // charge bar above cloud
  const barW = 64;
  const barH = 5;
  const barX = c.x - barW / 2;
  const barY = c.y - CLOUD_RADIUS - 14;
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.fillRect(barX, barY, barW, barH);
  const fillW = Math.min(1, c.charge) * barW;
  const fillColor =
    c.charge < 0.6 ? '#10b981' : c.charge < 0.85 ? '#f59e0b' : '#ef4444';
  ctx.fillStyle = fillColor;
  ctx.fillRect(barX, barY, fillW, barH);
}

function drawBolt(b: Bolt): void {
  let color: string;
  if (b.status === 'caught') color = '#a3e635';
  else if (b.status === 'missed') color = '#ef4444';
  else if (b.kind === 'fast') color = '#fde047';
  else if (b.kind === 'wide') color = '#7dd3fc';
  else color = '#e2e8f0';

  ctx.strokeStyle = color;
  ctx.lineWidth = b.status === 'caught' ? 6 : 4;
  ctx.shadowColor = color;
  ctx.shadowBlur = 14;
  ctx.beginPath();
  let cy = b.startY;
  let cx = b.x;
  ctx.moveTo(cx, cy);
  // Stable jitter that doesn't twitch each frame: seed-based.
  let seed = b.jitterSeed;
  while (cy < b.y) {
    const next = Math.min(cy + 14, b.y);
    seed = (seed * 9301 + 49297) % 233280;
    const j = ((seed / 233280) - 0.5) * 8;
    cx = b.x + j;
    ctx.lineTo(cx, next);
    cy = next;
  }
  ctx.stroke();
  ctx.shadowBlur = 0;

  if (b.status === 'caught') {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(b.x, Math.min(b.y, ROD_Y + ROD_H / 2), 7, 0, Math.PI * 2);
    ctx.fill();
  } else if (b.status === 'missed') {
    ctx.fillStyle = 'rgba(239,68,68,0.55)';
    ctx.beginPath();
    ctx.arc(b.x, GROUND_Y, 11, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawRod(): void {
  const w = currentRodWidth();
  const boosted = rodWidthBoostMs > 0;
  // bar
  ctx.fillStyle = boosted ? '#60a5fa' : '#cbd5e1';
  ctx.fillRect(rodX - w / 2, ROD_Y, w, ROD_H);
  // pole down to ground
  ctx.fillStyle = '#94a3b8';
  ctx.fillRect(rodX - 3, ROD_Y, 6, GROUND_Y - ROD_Y);
  // small antenna up
  ctx.strokeStyle = boosted ? '#93c5fd' : '#e2e8f0';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(rodX, ROD_Y);
  ctx.lineTo(rodX, ROD_Y - 10);
  ctx.stroke();
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
  clouds = [];
  bolts = [];
  score = 0;
  lives = LIVES_MAX;
  energy = 0;
  rodX = W / 2;
  rodTargetX = W / 2;
  rodWidthBoostMs = 0;
  elapsed = 0;
  spawnTimer = 0.6;
  burstFlashMs = 0;
  missFlashMs = 0;
  leftKey = false;
  rightKey = false;
}

function startGame(): void {
  resetCommonState();
  state = 'playing';
  updateHud();
  hideOverlayEl(overlay);
  lastTime = performance.now();
  // immediate draw so user sees the rod before the first cloud spawns
  draw();
  rafId = requestAnimationFrame(loop);
}

function endGame(): void {
  state = 'gameover';
  cancelAnimationFrame(rafId);
  draw();
  const isBest = score > 0 && score >= best;
  overlayTitle.textContent = isBest ? 'Yeni rekor!' : 'Oyun bitti';
  overlayMsg.innerHTML =
    `Skor: <strong>${score}</strong><br>En iyi: ${best}` +
    '<br><small>Boşluk veya R ile tekrar oyna</small>';
  overlayBtn.textContent = 'Tekrar oyna';
  showOverlayEl(overlay);
  overlayBtn.focus({ preventScroll: true });
}

function resetToReady(): void {
  resetCommonState();
  state = 'ready';
  updateHud();
  overlayTitle.textContent = 'Şimşek Tutucu';
  overlayMsg.innerHTML =
    'Bulutlar şarj olunca dikey şimşek bırakır. Paratoneri konumlandır,' +
    ' şimşeği yakala. Bulutlar hareket eder — tahmin et!<br>' +
    '<small>Mouse veya ←/→ · Boşluk: enerji dalgası</small>';
  overlayBtn.textContent = 'Başla';
  showOverlayEl(overlay);
  draw();
}

// ── Input ──
function canvasToWorldX(clientX: number): number {
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0) return rodTargetX;
  const scale = W / rect.width;
  let x = (clientX - rect.left) * scale;
  if (x < 0) x = 0;
  if (x > W) x = W;
  return x;
}

function onPointerMove(e: PointerEvent): void {
  if (state !== 'playing') return;
  rodTargetX = canvasToWorldX(e.clientX);
}

function onTouchMove(e: TouchEvent): void {
  if (state !== 'playing') return;
  if (e.touches.length === 0) return;
  e.preventDefault();
  rodTargetX = canvasToWorldX(e.touches[0]!.clientX);
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
  // playing branch
  if (k === 'ArrowLeft' || k === 'a' || k === 'A') {
    leftKey = true;
    e.preventDefault();
  } else if (k === 'ArrowRight' || k === 'd' || k === 'D') {
    rightKey = true;
    e.preventDefault();
  } else if (k === ' ') {
    e.preventDefault();
    fireBurst();
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
