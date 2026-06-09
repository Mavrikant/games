// ---------------------------------------------------------------------------
// İnci Avı — pearl-diving risk/reward arcade
// State machine: ready | playing | gameover
// Pitfalls addressed:
//   - unguarded-storage: safeRead/safeWrite wrap localStorage in try/catch
//   - module-level-dom-access: all DOM/storage inside init()
//   - overlay-input-leak: explicit state enum guards every input handler
//   - stale-async-callback: cancelAnimationFrame on every transition + loop()
//     re-checks state before scheduling next frame
//   - invisible-boot: startGame() draws first frame before first RAF so the
//     diver, boat and pearls are on screen <50ms after Başla
//   - visual-vs-hitbox: pearl/jelly collisions use the same radii used to
//     draw them (PEARL_R, JELLY_RADIUS, DIVER_R) — no separate hitbox
//   - missing-overlay-css: inci-avi.css defines .overlay--hidden visuals
//   - hud-counter-synced-only-at-lifecycle-edges: updateHud() runs every
//     update() tick, not just on start/end
//   - designed-lose-condition-not-wired: oxygen 0 underwater → onDrown()
//     (life loss), 0 lives → endGame(); drowning is a real consequence
// ---------------------------------------------------------------------------

import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import {
  showOverlay as showOverlayEl,
  hideOverlay as hideOverlayEl,
} from '@shared/overlay';

const STORAGE_KEY = 'inci-avi.best';

type State = 'ready' | 'playing' | 'gameover';

// ── Canvas (portrait — tall water column) ──
const W = 480;
const H = 640;
const SURFACE_Y = 64;
const SEABED_Y = H - 32;
const PLAY_H = SEABED_Y - SURFACE_Y;

// Depth band boundaries (used by both pearl-value and gradient draw)
const SHALLOW_END = SURFACE_Y + PLAY_H * 0.35;
const MID_END = SURFACE_Y + PLAY_H * 0.7;

// ── Diver ──
const DIVER_R = 11;
const DIVER_SPEED = 220; // px/sec (when single axis held)

// ── Oxygen ──
const OXYGEN_MAX = 100;
const OXYGEN_BASE_DRAIN = 6; // %/sec just below surface
const OXYGEN_DEEP_DRAIN = 18; // %/sec at the deepest band
const OXYGEN_REFILL = 90; // %/sec when surfaced

// ── Hazards ──
const JELLY_PENALTY = 22; // oxygen %
const JELLY_RADIUS = 14;
const JELLY_COUNT = 3;

// ── Pearls ──
const PEARL_R = 7;
const PEARLS_ACTIVE = 14;
const PEARL_RESPAWN_S = 5.0;

const LIVES_MAX = 3;

interface Pearl {
  x: number;
  y: number;
  value: 1 | 3 | 5;
  alive: boolean;
  spawnT: number;
  respawnAt: number;
}

interface Jelly {
  x: number;
  y: number;
  vx: number;
  phase: number;
}

// ── DOM refs ──
let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let oxygenEl!: HTMLElement;
let livesEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayBtn!: HTMLButtonElement;

// ── State ──
let state: State = 'ready';
let score = 0;
let best = 0;
let lives = LIVES_MAX;
let oxygen = OXYGEN_MAX;
let pearls: Pearl[] = [];
let jellies: Jelly[] = [];

let diverX = W / 2;
let diverY = SURFACE_Y - 8;

let leftKey = false;
let rightKey = false;
let upKey = false;
let downKey = false;

let rafId = 0;
let lastTime = 0;
let elapsed = 0;
let hitFlashMs = 0;
let drownFlashMs = 0;

// ── HUD ──
function updateHud(): void {
  scoreEl.textContent = String(score);
  oxygenEl.textContent = `${Math.max(0, Math.ceil(oxygen))}%`;
  livesEl.textContent = lives > 0 ? '●'.repeat(lives) : '—';
  bestEl.textContent = String(best);
}

function commitBest(): void {
  if (score > best) {
    best = score;
    safeWrite(STORAGE_KEY, best);
  }
}

// ── Helpers ──
function depthFactor(y: number): number {
  // 0 at surface, 1 at seabed
  return Math.max(0, Math.min(1, (y - SURFACE_Y) / PLAY_H));
}

function pearlValueAt(y: number): 1 | 3 | 5 {
  if (y < SHALLOW_END) return 1;
  if (y < MID_END) return 3;
  return 5;
}

function placePearl(p: Pearl): boolean {
  for (let tries = 0; tries < 24; tries++) {
    const x = 30 + Math.random() * (W - 60);
    const y = SURFACE_Y + 32 + Math.random() * (PLAY_H - 56);
    // avoid stacking too close to other alive pearls
    let bad = false;
    for (const other of pearls) {
      if (other === p) continue;
      if (other.alive && Math.hypot(other.x - x, other.y - y) < 42) {
        bad = true;
        break;
      }
    }
    // also avoid spawning right on the diver
    if (Math.hypot(diverX - x, diverY - y) < 40) bad = true;
    if (bad) continue;
    p.x = x;
    p.y = y;
    p.value = pearlValueAt(y);
    p.alive = true;
    p.spawnT = elapsed;
    p.respawnAt = 0;
    return true;
  }
  return false;
}

function initPearls(): void {
  pearls = [];
  for (let i = 0; i < PEARLS_ACTIVE; i++) {
    const p: Pearl = {
      x: 0,
      y: 0,
      value: 1,
      alive: false,
      spawnT: 0,
      respawnAt: 0,
    };
    pearls.push(p);
    placePearl(p);
  }
}

function initJellies(): void {
  jellies = [];
  for (let i = 0; i < JELLY_COUNT; i++) {
    // distribute across mid + deep zones so all bands have some pressure
    const band = i / JELLY_COUNT;
    const y = SHALLOW_END + 30 + band * (SEABED_Y - SHALLOW_END - 60);
    const vx = (Math.random() < 0.5 ? -1 : 1) * (28 + Math.random() * 22);
    jellies.push({
      x: 50 + Math.random() * (W - 100),
      y,
      vx,
      phase: Math.random() * Math.PI * 2,
    });
  }
}

// ── Update ──
function update(dt: number): void {
  if (state !== 'playing') return;
  elapsed += dt;

  // diver movement (normalized when both axes pressed)
  const dx = (rightKey ? 1 : 0) - (leftKey ? 1 : 0);
  const dy = (downKey ? 1 : 0) - (upKey ? 1 : 0);
  if (dx !== 0 || dy !== 0) {
    const m = Math.hypot(dx, dy) || 1;
    diverX += (dx / m) * DIVER_SPEED * dt;
    diverY += (dy / m) * DIVER_SPEED * dt;
  }
  diverX = Math.max(DIVER_R, Math.min(W - DIVER_R, diverX));
  diverY = Math.max(SURFACE_Y - 20, Math.min(SEABED_Y - DIVER_R, diverY));

  // oxygen
  if (diverY < SURFACE_Y + 4) {
    oxygen = Math.min(OXYGEN_MAX, oxygen + OXYGEN_REFILL * dt);
  } else {
    const df = depthFactor(diverY);
    const drain = OXYGEN_BASE_DRAIN + (OXYGEN_DEEP_DRAIN - OXYGEN_BASE_DRAIN) * df;
    oxygen -= drain * dt;
    if (oxygen <= 0) {
      oxygen = 0;
      onDrown();
      return;
    }
  }

  // flashes
  if (hitFlashMs > 0) hitFlashMs = Math.max(0, hitFlashMs - dt * 1000);
  if (drownFlashMs > 0) drownFlashMs = Math.max(0, drownFlashMs - dt * 1000);

  // jellyfish drift + collision
  for (const j of jellies) {
    j.x += j.vx * dt;
    j.phase += dt * 2;
    if (j.x < 30) {
      j.x = 30;
      j.vx = Math.abs(j.vx);
    } else if (j.x > W - 30) {
      j.x = W - 30;
      j.vx = -Math.abs(j.vx);
    }
    // only hurt diver while underwater (boat is "safe zone")
    if (diverY < SURFACE_Y) continue;
    if (Math.hypot(j.x - diverX, j.y - diverY) < JELLY_RADIUS + DIVER_R) {
      oxygen = Math.max(0, oxygen - JELLY_PENALTY);
      hitFlashMs = 300;
      // push diver out of the jelly so a single touch doesn't double-tick
      const ang = Math.atan2(diverY - j.y, diverX - j.x);
      diverX += Math.cos(ang) * 22;
      diverY += Math.sin(ang) * 22;
      diverX = Math.max(DIVER_R, Math.min(W - DIVER_R, diverX));
      diverY = Math.max(SURFACE_Y - 20, Math.min(SEABED_Y - DIVER_R, diverY));
      if (oxygen <= 0) {
        onDrown();
        return;
      }
    }
  }

  // pearl pickup
  for (const p of pearls) {
    if (!p.alive) continue;
    if (Math.hypot(p.x - diverX, p.y - diverY) < PEARL_R + DIVER_R) {
      p.alive = false;
      p.respawnAt = elapsed + PEARL_RESPAWN_S;
      score += p.value;
      commitBest();
    }
  }
  // pearl respawn (after delay, at a fresh location)
  for (const p of pearls) {
    if (!p.alive && p.respawnAt > 0 && elapsed >= p.respawnAt) {
      if (!placePearl(p)) {
        p.respawnAt = elapsed + 1; // try again shortly
      }
    }
  }

  updateHud();
}

function onDrown(): void {
  lives--;
  drownFlashMs = 500;
  updateHud();
  if (lives <= 0) {
    endGame();
    return;
  }
  // respawn at boat with full lungs
  diverX = W / 2;
  diverY = SURFACE_Y - 8;
  oxygen = OXYGEN_MAX;
  leftKey = rightKey = upKey = downKey = false;
}

// ── Draw ──
function draw(): void {
  // background gradient: sky → surface → progressively darker water
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#7dd3fc');
  g.addColorStop(SURFACE_Y / H, '#0c4a6e');
  g.addColorStop(SHALLOW_END / H, '#0e7490');
  g.addColorStop(MID_END / H, '#164e63');
  g.addColorStop(SEABED_Y / H, '#0a1a2e');
  g.addColorStop(1, '#020617');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // wave line at surface
  ctx.strokeStyle = '#bae6fd';
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.55;
  ctx.beginPath();
  const waveT = elapsed * 1.4;
  for (let x = 0; x <= W; x += 6) {
    const y = SURFACE_Y + Math.sin((x / W) * Math.PI * 4 + waveT) * 2.5;
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;

  // sun rays from sky
  ctx.globalAlpha = 0.08;
  ctx.fillStyle = '#fef9c3';
  for (let i = 0; i < 6; i++) {
    const cx = 80 + i * 70;
    ctx.beginPath();
    ctx.moveTo(cx, SURFACE_Y);
    ctx.lineTo(cx - 18, MID_END);
    ctx.lineTo(cx + 22, MID_END);
    ctx.closePath();
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // depth band tints (subtle, helps orient value zones)
  ctx.globalAlpha = 0.06;
  ctx.fillStyle = '#22d3ee';
  ctx.fillRect(0, SURFACE_Y, W, SHALLOW_END - SURFACE_Y);
  ctx.fillStyle = '#fb7185';
  ctx.fillRect(0, SHALLOW_END, W, MID_END - SHALLOW_END);
  ctx.fillStyle = '#a78bfa';
  ctx.fillRect(0, MID_END, W, SEABED_Y - MID_END);
  ctx.globalAlpha = 1;

  // band markers (right edge)
  ctx.fillStyle = '#94a3b8';
  ctx.font = 'bold 10px ui-sans-serif, system-ui';
  ctx.textAlign = 'right';
  ctx.fillText('+1', W - 6, SURFACE_Y + 14);
  ctx.fillText('+3', W - 6, SHALLOW_END + 14);
  ctx.fillText('+5', W - 6, MID_END + 14);
  ctx.textAlign = 'left';

  // boat at surface
  drawBoat(W / 2, SURFACE_Y - 14);

  // seabed
  ctx.fillStyle = '#1c1917';
  ctx.fillRect(0, SEABED_Y, W, H - SEABED_Y);
  ctx.fillStyle = '#3f3424';
  for (let i = 0; i < 7; i++) {
    ctx.beginPath();
    ctx.arc(30 + i * 70, SEABED_Y + 6, 10 + ((i * 17) % 6), 0, Math.PI, true);
    ctx.fill();
  }

  // pearls
  for (const p of pearls) drawPearl(p);

  // jellies
  for (const j of jellies) drawJelly(j);

  // diver
  drawDiver(diverX, diverY);

  // hit flash (oxygen lost)
  if (hitFlashMs > 0) {
    const a = hitFlashMs / 300;
    ctx.fillStyle = `rgba(244,114,182,${0.22 * a})`;
    ctx.fillRect(0, 0, W, H);
  }
  // drown flash (life lost)
  if (drownFlashMs > 0) {
    const a = drownFlashMs / 500;
    ctx.fillStyle = `rgba(239,68,68,${0.32 * a})`;
    ctx.fillRect(0, 0, W, H);
  }

  // oxygen bar (left edge, full height)
  drawOxygenBar();
}

function drawBoat(cx: number, cy: number): void {
  // hull
  ctx.fillStyle = '#78350f';
  ctx.beginPath();
  ctx.moveTo(cx - 26, cy);
  ctx.lineTo(cx + 26, cy);
  ctx.lineTo(cx + 18, cy + 9);
  ctx.lineTo(cx - 18, cy + 9);
  ctx.closePath();
  ctx.fill();
  // deck stripe
  ctx.fillStyle = '#fde68a';
  ctx.fillRect(cx - 22, cy + 2, 44, 2);
  // mast
  ctx.strokeStyle = '#fde047';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx, cy - 18);
  ctx.lineTo(cx, cy);
  ctx.stroke();
  // pennant
  ctx.fillStyle = '#ef4444';
  ctx.beginPath();
  ctx.moveTo(cx, cy - 18);
  ctx.lineTo(cx + 8, cy - 15);
  ctx.lineTo(cx, cy - 12);
  ctx.closePath();
  ctx.fill();
}

function drawPearl(p: Pearl): void {
  if (!p.alive) return;
  // open clam, bottom half
  ctx.fillStyle = '#a16207';
  ctx.beginPath();
  ctx.arc(p.x, p.y + 2, PEARL_R + 3, 0, Math.PI);
  ctx.fill();
  // top half (slightly lifted)
  ctx.fillStyle = '#ca8a04';
  ctx.beginPath();
  ctx.arc(p.x, p.y - 1, PEARL_R + 3, Math.PI, Math.PI * 2);
  ctx.fill();
  // pearl color encodes value
  const color = p.value === 1 ? '#f1f5f9' : p.value === 3 ? '#fda4af' : '#c4b5fd';
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(p.x, p.y, PEARL_R, 0, Math.PI * 2);
  ctx.fill();
  // shine
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.beginPath();
  ctx.arc(p.x - 2, p.y - 2, 2, 0, Math.PI * 2);
  ctx.fill();
  // spawn sparkle (first 0.8s of life)
  const age = elapsed - p.spawnT;
  if (age < 0.8 && age > 0) {
    ctx.strokeStyle = `rgba(255,255,255,${1 - age / 0.8})`;
    ctx.lineWidth = 1.5;
    const r = PEARL_R + 4 + age * 16;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawJelly(j: Jelly): void {
  const r = JELLY_RADIUS;
  // glow
  ctx.fillStyle = 'rgba(244,114,182,0.18)';
  ctx.beginPath();
  ctx.arc(j.x, j.y, r + 6, 0, Math.PI * 2);
  ctx.fill();
  // bell
  ctx.fillStyle = 'rgba(244,114,182,0.7)';
  ctx.beginPath();
  ctx.arc(j.x, j.y, r, Math.PI, 0);
  ctx.fill();
  ctx.strokeStyle = 'rgba(251,113,133,0.95)';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.arc(j.x, j.y, r, Math.PI, 0);
  ctx.stroke();
  // tentacles
  ctx.strokeStyle = 'rgba(244,114,182,0.75)';
  ctx.lineWidth = 1.2;
  for (let i = -2; i <= 2; i++) {
    const tx = j.x + i * 4;
    ctx.beginPath();
    ctx.moveTo(tx, j.y);
    const swing = Math.sin(j.phase + i * 0.7) * 3;
    ctx.quadraticCurveTo(tx + swing, j.y + 8, tx + swing * 0.5, j.y + 18);
    ctx.stroke();
  }
}

function drawDiver(x: number, y: number): void {
  // body
  ctx.fillStyle = '#fb923c';
  ctx.beginPath();
  ctx.arc(x, y, DIVER_R, 0, Math.PI * 2);
  ctx.fill();
  // mask body
  ctx.fillStyle = '#0f172a';
  ctx.beginPath();
  ctx.arc(x, y - 1, DIVER_R - 3, 0, Math.PI * 2);
  ctx.fill();
  // mask glass
  ctx.fillStyle = '#7dd3fc';
  ctx.beginPath();
  ctx.arc(x - 1, y - 2, DIVER_R - 5, 0, Math.PI * 2);
  ctx.fill();
  // mask highlight
  ctx.fillStyle = '#f0f9ff';
  ctx.beginPath();
  ctx.arc(x - 2, y - 3, 1.5, 0, Math.PI * 2);
  ctx.fill();
  // bubble trail (only underwater)
  if (y > SURFACE_Y) {
    const bt = elapsed * 2;
    for (let i = 0; i < 3; i++) {
      const ang = bt + i * 1.2;
      const bx = x + Math.sin(ang) * 4;
      const by = y - DIVER_R - 4 - ((bt * 18 + i * 8) % 26);
      ctx.fillStyle = `rgba(186,230,253,${0.55 - i * 0.12})`;
      ctx.beginPath();
      ctx.arc(bx, by, 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawOxygenBar(): void {
  const barX = 10;
  const barY = SURFACE_Y + 10;
  const barW = 10;
  const barH = PLAY_H - 20;
  // background
  ctx.fillStyle = 'rgba(15,23,42,0.65)';
  ctx.fillRect(barX, barY, barW, barH);
  // fill (top = full, drains downward)
  const fillH = Math.max(0, (oxygen / OXYGEN_MAX) * barH);
  const color =
    oxygen < 25 ? '#ef4444' : oxygen < 50 ? '#f59e0b' : '#22d3ee';
  ctx.fillStyle = color;
  ctx.fillRect(barX, barY + (barH - fillH), barW, fillH);
  // border
  ctx.strokeStyle = '#0f172a';
  ctx.lineWidth = 1;
  ctx.strokeRect(barX, barY, barW, barH);
  // label
  ctx.fillStyle = '#cbd5e1';
  ctx.font = 'bold 9px ui-sans-serif, system-ui';
  ctx.textAlign = 'center';
  ctx.fillText('O₂', barX + barW / 2, barY - 3);
  ctx.textAlign = 'left';
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
  score = 0;
  lives = LIVES_MAX;
  oxygen = OXYGEN_MAX;
  diverX = W / 2;
  diverY = SURFACE_Y - 8;
  elapsed = 0;
  hitFlashMs = 0;
  drownFlashMs = 0;
  leftKey = rightKey = upKey = downKey = false;
  initPearls();
  initJellies();
}

function startGame(): void {
  resetCommonState();
  state = 'playing';
  updateHud();
  hideOverlayEl(overlay);
  lastTime = performance.now();
  // immediate frame so the player sees diver + pearls before first RAF tick
  draw();
  rafId = requestAnimationFrame(loop);
}

function endGame(): void {
  state = 'gameover';
  cancelAnimationFrame(rafId);
  draw();
  const isBest = score > 0 && score >= best;
  overlayTitle.textContent = isBest ? 'Yeni rekor!' : 'Boğuldun!';
  overlayMsg.innerHTML =
    `İnci puanı: <strong>${score}</strong><br>En iyi: ${best}` +
    '<br><small>Boşluk veya tıkla — tekrar dal</small>';
  overlayBtn.textContent = 'Tekrar dal';
  showOverlayEl(overlay);
  overlayBtn.focus({ preventScroll: true });
}

function resetToReady(): void {
  resetCommonState();
  state = 'ready';
  updateHud();
  overlayTitle.textContent = 'İnci Avı';
  overlayMsg.innerHTML =
    'Sığ inciler 1, orta 3, derin 5 puan değerinde.<br>' +
    'Pembe denizanaları oksijenini yer.<br>' +
    'Yüzeye çıkınca nefesin tazelenir, boğulursan bir nefes hakkın gider.<br>' +
    '<small>Ok tuşları veya WASD · 3 nefes hakkın var</small>';
  overlayBtn.textContent = 'Başla';
  showOverlayEl(overlay);
  draw();
}

// ── Input ──
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
  } else if (k === 'ArrowUp' || k === 'w' || k === 'W') {
    upKey = true;
    e.preventDefault();
  } else if (k === 'ArrowDown' || k === 's' || k === 'S') {
    downKey = true;
    e.preventDefault();
  }
}

function onKeyUp(e: KeyboardEvent): void {
  const k = e.key;
  if (k === 'ArrowLeft' || k === 'a' || k === 'A') leftKey = false;
  else if (k === 'ArrowRight' || k === 'd' || k === 'D') rightKey = false;
  else if (k === 'ArrowUp' || k === 'w' || k === 'W') upKey = false;
  else if (k === 'ArrowDown' || k === 's' || k === 'S') downKey = false;
}

// ── Init ──
function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  oxygenEl = document.querySelector<HTMLElement>('#oxygen')!;
  livesEl = document.querySelector<HTMLElement>('#lives')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;

  best = safeRead<number>(STORAGE_KEY, 0);
  if (!Number.isFinite(best) || best < 0) best = 0;

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  restartBtn.addEventListener('click', () => startGame());
  overlayBtn.addEventListener('click', () => startGame());

  resetToReady();
}

export const game = defineGame({ init, reset: resetToReady });
