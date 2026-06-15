// ---------------------------------------------------------------------------
// Mıknatıs — top-down magnet/color-sort
// State: ready | playing | gameover
// Twist: tek bir kasaya yalnızca hedef renk girmeli; mıknatıs renk
//   ayırt etmez, hepsini eşit çeker. Strateji = yanıltıcı kırıntılardan
//   kaçınarak hedef rengi kasaya götürmek.
// Pitfalls:
//   - module-level-dom-access: tüm DOM init() içinde
//   - unguarded-storage: safeRead/safeWrite
//   - overlay-input-leak: state guard her input handler başında
//   - stale-async-callback: RAF iptali her transition'da + state guard
//   - visual-vs-hitbox: kasa hitbox'ı VE çizimi tek GOAL_* sabitlerinden
//   - missing-overlay-css: per-game CSS .overlay--hidden tanımlar
//   - invisible-boot: ready/start drawSnapshot() çağırır, ilk frame anında
// ---------------------------------------------------------------------------

import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import {
  showOverlay as showOverlayEl,
  hideOverlay as hideOverlayEl,
} from '@shared/overlay';

type State = 'ready' | 'playing' | 'gameover';

interface Shaving {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  color: number;
  alive: boolean;
  // 0..1 collected flash (1 → 0 fade) for visual feedback
  collected: number;
}

// ── Constants ──
const W = 480;
const H = 600;

const GOAL_X = W / 2;
const GOAL_Y = 60;
const GOAL_R = 46;

const SPAWN_AREA_TOP = 180; // shavings spawn below this y
const SPAWN_AREA_BOTTOM = H - 30;
const SPAWN_AREA_LEFT = 30;
const SPAWN_AREA_RIGHT = W - 30;

const SHAVING_R = 7;
const SHAVING_MIN_SPACING = 22; // initial spawn spacing

const MAGNET_R = 18; // visual size
const MAGNET_REACH = 110; // attraction radius
const MAGNET_FORCE = 5400; // base attraction coefficient
const SUPER_REACH = 170;
const SUPER_FORCE = 14000;
const SUPER_MS = 600;
const SUPER_CHARGES = 3;

const DRAG = 0.86; // velocity damping per (1/60)s, applied scaled by dt
const MAX_SPEED = 520; // px/s clamp

const LIVES_MAX = 3;

// Vivid palette — index 0..3
const PALETTE = [
  '#ef4444', // kırmızı
  '#3b82f6', // mavi
  '#fbbf24', // sarı
  '#10b981', // yeşil
];

const COLOR_NAMES = ['Kırmızı', 'Mavi', 'Sarı', 'Yeşil'];

const STORAGE_BEST = 'miknatis.best';

// ── DOM refs ──
let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let livesEl!: HTMLElement;
let roundEl!: HTMLElement;
let targetEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayBtn!: HTMLButtonElement;

// ── State ──
let state: State = 'ready';
let shavings: Shaving[] = [];
let score = 0;
let lives = LIVES_MAX;
let best = 0;
let round = 1;

let targetColor = 0;
let targetRemaining = 0;
let targetTotal = 0;

let superCharges = SUPER_CHARGES;
let superMs = 0;

let magnetX = W / 2;
let magnetY = H * 0.7;
let magnetTargetX = magnetX;
let magnetTargetY = magnetY;

let rafId = 0;
let lastTime = 0;
let elapsed = 0;
let flashMs = 0; // green flash on correct collect
let badFlashMs = 0; // red flash on wrong collect

// ── HUD ──
function colorChip(idx: number): string {
  return `<span class="mk-chip" style="background:${PALETTE[idx]}"></span>`;
}

function updateHud(): void {
  scoreEl.textContent = String(score);
  livesEl.textContent = lives > 0 ? '♥'.repeat(lives) : '—';
  roundEl.textContent = String(round);
  targetEl.innerHTML =
    `${colorChip(targetColor)} ` +
    `<b>${targetTotal - targetRemaining}</b>/${targetTotal}`;
  bestEl.textContent = String(best);
}

function commitBest(): void {
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
    bestEl.textContent = String(best);
  }
}

// ── Round generation ──
function roundConfig(r: number): {
  colors: number;
  targetCount: number;
  decoyCount: number;
} {
  if (r <= 1) return { colors: 2, targetCount: 5, decoyCount: 5 };
  if (r === 2) return { colors: 2, targetCount: 6, decoyCount: 8 };
  if (r === 3) return { colors: 3, targetCount: 6, decoyCount: 12 };
  if (r === 4) return { colors: 3, targetCount: 7, decoyCount: 14 };
  if (r === 5) return { colors: 4, targetCount: 7, decoyCount: 18 };
  // 6+: scale gradually
  const extra = Math.min(8, r - 5);
  return {
    colors: 4,
    targetCount: 7 + Math.floor(extra / 2),
    decoyCount: 18 + extra * 2,
  };
}

function trySpawnSpot(): { x: number; y: number } | null {
  for (let tries = 0; tries < 50; tries++) {
    const x =
      SPAWN_AREA_LEFT +
      Math.random() * (SPAWN_AREA_RIGHT - SPAWN_AREA_LEFT);
    const y =
      SPAWN_AREA_TOP +
      Math.random() * (SPAWN_AREA_BOTTOM - SPAWN_AREA_TOP);
    let ok = true;
    for (const s of shavings) {
      const dx = s.x - x;
      const dy = s.y - y;
      if (dx * dx + dy * dy < SHAVING_MIN_SPACING * SHAVING_MIN_SPACING) {
        ok = false;
        break;
      }
    }
    if (ok) return { x, y };
  }
  return null;
}

function spawnShavings(): void {
  const cfg = roundConfig(round);
  const palette: number[] = [];
  // pick `cfg.colors` distinct color indexes; target color is first.
  const all = [0, 1, 2, 3];
  // shuffle
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = all[i]!;
    all[i] = all[j]!;
    all[j] = tmp;
  }
  for (let i = 0; i < cfg.colors; i++) palette.push(all[i]!);
  targetColor = palette[0]!;
  targetTotal = cfg.targetCount;
  targetRemaining = cfg.targetCount;

  shavings = [];

  // place targets first (so they fit before crowded decoys take spots)
  for (let i = 0; i < cfg.targetCount; i++) {
    const pos = trySpawnSpot();
    if (!pos) break;
    shavings.push({
      x: pos.x,
      y: pos.y,
      vx: 0,
      vy: 0,
      r: SHAVING_R,
      color: targetColor,
      alive: true,
      collected: 0,
    });
  }
  // decoys: choose from non-target palette colors
  const decoyColors = palette.slice(1);
  if (decoyColors.length === 0) decoyColors.push((targetColor + 1) % 4);
  for (let i = 0; i < cfg.decoyCount; i++) {
    const pos = trySpawnSpot();
    if (!pos) break;
    const color = decoyColors[i % decoyColors.length]!;
    shavings.push({
      x: pos.x,
      y: pos.y,
      vx: 0,
      vy: 0,
      r: SHAVING_R,
      color,
      alive: true,
      collected: 0,
    });
  }
}

// ── Physics ──
function applyMagnet(s: Shaving, dt: number): void {
  const reach = superMs > 0 ? SUPER_REACH : MAGNET_REACH;
  const force = superMs > 0 ? SUPER_FORCE : MAGNET_FORCE;
  const dx = magnetX - s.x;
  const dy = magnetY - s.y;
  const d2 = dx * dx + dy * dy;
  const d = Math.sqrt(d2);
  if (d > reach) return;
  // clamp distance for stability; force ~ 1/(d+min)
  const inv = 1 / Math.max(d, 18);
  const a = force * inv * inv; // accel magnitude (px/s²)
  const nx = d > 0.001 ? dx / d : 0;
  const ny = d > 0.001 ? dy / d : 0;
  s.vx += nx * a * dt;
  s.vy += ny * a * dt;
}

function dampAndMove(s: Shaving, dt: number): void {
  // frame-rate independent damping: pow(DRAG, dt*60)
  const damp = Math.pow(DRAG, dt * 60);
  s.vx *= damp;
  s.vy *= damp;
  // speed clamp
  const sp = Math.hypot(s.vx, s.vy);
  if (sp > MAX_SPEED) {
    s.vx = (s.vx / sp) * MAX_SPEED;
    s.vy = (s.vy / sp) * MAX_SPEED;
  }
  s.x += s.vx * dt;
  s.y += s.vy * dt;

  // walls: clamp + bounce
  if (s.x < SHAVING_R) {
    s.x = SHAVING_R;
    s.vx = Math.abs(s.vx) * 0.4;
  } else if (s.x > W - SHAVING_R) {
    s.x = W - SHAVING_R;
    s.vx = -Math.abs(s.vx) * 0.4;
  }
  if (s.y > H - SHAVING_R) {
    s.y = H - SHAVING_R;
    s.vy = -Math.abs(s.vy) * 0.4;
  }
  // top wall: allow them to enter goal zone freely; only bounce off the
  // canvas ceiling outside the goal region
  if (s.y < SHAVING_R) {
    s.y = SHAVING_R;
    s.vy = Math.abs(s.vy) * 0.4;
  }
}

function checkGoal(s: Shaving): boolean {
  const dx = s.x - GOAL_X;
  const dy = s.y - GOAL_Y;
  return dx * dx + dy * dy < GOAL_R * GOAL_R;
}

// Simple inter-shaving repulsion to keep them from stacking on the magnet.
function repelShavings(dt: number): void {
  const minDist = SHAVING_R * 2;
  const minSq = minDist * minDist;
  for (let i = 0; i < shavings.length; i++) {
    const a = shavings[i]!;
    if (!a.alive) continue;
    for (let j = i + 1; j < shavings.length; j++) {
      const b = shavings[j]!;
      if (!b.alive) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < minSq && d2 > 0.0001) {
        const d = Math.sqrt(d2);
        const overlap = minDist - d;
        const nx = dx / d;
        const ny = dy / d;
        const push = overlap * 0.5;
        a.x -= nx * push;
        a.y -= ny * push;
        b.x += nx * push;
        b.y += ny * push;
        // small bounce
        const k = 90 * dt;
        a.vx -= nx * k;
        a.vy -= ny * k;
        b.vx += nx * k;
        b.vy += ny * k;
      }
    }
  }
}

// ── Update ──
function update(dt: number): void {
  if (state !== 'playing') return;
  elapsed += dt;

  // smooth magnet follow
  const k = 1 - Math.exp(-20 * dt);
  magnetX += (magnetTargetX - magnetX) * k;
  magnetY += (magnetTargetY - magnetY) * k;

  if (superMs > 0) superMs = Math.max(0, superMs - dt * 1000);
  if (flashMs > 0) flashMs = Math.max(0, flashMs - dt * 1000);
  if (badFlashMs > 0) badFlashMs = Math.max(0, badFlashMs - dt * 1000);

  for (const s of shavings) {
    if (!s.alive) {
      if (s.collected > 0) s.collected = Math.max(0, s.collected - dt * 2);
      continue;
    }
    applyMagnet(s, dt);
    dampAndMove(s, dt);
  }
  repelShavings(dt);

  // goal check
  for (const s of shavings) {
    if (!s.alive) continue;
    if (checkGoal(s)) {
      s.alive = false;
      s.collected = 1;
      if (s.color === targetColor) {
        score += 10 + round;
        targetRemaining = Math.max(0, targetRemaining - 1);
        flashMs = 260;
        commitBest();
        updateHud();
        if (targetRemaining === 0) {
          // small delay for visual fade then next round
          completeRound();
          return;
        }
      } else {
        lives--;
        badFlashMs = 380;
        updateHud();
        if (lives <= 0) {
          endGame();
          return;
        }
      }
    }
  }
}

function completeRound(): void {
  // round bonus: time-based, more for being fast
  const tBonus = Math.max(0, 40 - Math.floor(elapsed));
  score += 20 + tBonus + round * 5;
  // restore one charge per round, plus a bonus charge on top-up
  superCharges = Math.min(SUPER_CHARGES + 1, superCharges + 2);
  if (superCharges > SUPER_CHARGES) superCharges = SUPER_CHARGES;
  round++;
  commitBest();
  elapsed = 0;
  spawnShavings();
  updateHud();
}

// ── Draw ──
function drawBackground(): void {
  ctx.fillStyle = '#0b0d12';
  ctx.fillRect(0, 0, W, H);

  // subtle grid
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= W; x += 40) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
  }
  for (let y = 0; y <= H; y += 40) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }
}

function drawGoal(): void {
  const tColor = PALETTE[targetColor]!;
  // outer pulse
  const pulse = 0.5 + 0.5 * Math.sin(elapsed * 2.4);
  ctx.save();
  ctx.translate(GOAL_X, GOAL_Y);

  ctx.shadowColor = tColor;
  ctx.shadowBlur = 18 + pulse * 12;

  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath();
  ctx.arc(0, 0, GOAL_R, 0, Math.PI * 2);
  ctx.fill();

  // dashed ring
  ctx.shadowBlur = 0;
  ctx.strokeStyle = tColor;
  ctx.lineWidth = 3;
  ctx.setLineDash([10, 8]);
  ctx.beginPath();
  ctx.arc(0, 0, GOAL_R - 2, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);

  // inner solid ring
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(0, 0, GOAL_R - 14, 0, Math.PI * 2);
  ctx.stroke();

  // label
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.font = 'bold 14px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('KASA', 0, -2);
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.font = '11px system-ui, -apple-system, sans-serif';
  ctx.fillText(COLOR_NAMES[targetColor]!.toLocaleUpperCase('tr-TR'), 0, 14);
  ctx.restore();
}

function drawShavings(): void {
  for (const s of shavings) {
    if (!s.alive) {
      if (s.collected > 0) {
        // fade-out flash
        const a = s.collected;
        ctx.fillStyle = PALETTE[s.color]!;
        ctx.globalAlpha = a;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r * (1 + (1 - a) * 0.8), 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      continue;
    }
    const color = PALETTE[s.color]!;
    // shadow ring (looks like metal sheen)
    ctx.fillStyle = '#0a0c10';
    ctx.beginPath();
    ctx.arc(s.x + 0.5, s.y + 1, s.r + 0.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.fill();

    // highlight
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath();
    ctx.arc(s.x - 2, s.y - 2.5, s.r * 0.35, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawMagnet(): void {
  const reach = superMs > 0 ? SUPER_REACH : MAGNET_REACH;
  // attraction ring
  ctx.strokeStyle =
    superMs > 0 ? 'rgba(168,85,247,0.55)' : 'rgba(96,165,250,0.32)';
  ctx.lineWidth = superMs > 0 ? 3 : 1.5;
  ctx.setLineDash([4, 6]);
  ctx.beginPath();
  ctx.arc(magnetX, magnetY, reach, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);

  // magnet body (horseshoe-ish: two prongs)
  ctx.save();
  ctx.translate(magnetX, magnetY);
  // outer cap
  ctx.fillStyle = superMs > 0 ? '#a855f7' : '#dc2626';
  ctx.fillRect(-MAGNET_R, -MAGNET_R, MAGNET_R, MAGNET_R * 2);
  ctx.fillStyle = '#374151';
  ctx.fillRect(0, -MAGNET_R, MAGNET_R, MAGNET_R * 2);
  // gap (white stripe between)
  ctx.fillStyle = '#f1f5f9';
  ctx.fillRect(-2, -MAGNET_R, 4, MAGNET_R * 2);
  // letters N/S
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 13px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('N', -MAGNET_R / 2, 0);
  ctx.fillText('S', MAGNET_R / 2, 0);
  ctx.restore();
}

function drawCharges(): void {
  const pad = 10;
  for (let i = 0; i < SUPER_CHARGES; i++) {
    const filled = i < superCharges;
    const x = pad + i * 16 + 8;
    const y = H - 14;
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fillStyle = filled ? '#a855f7' : 'rgba(168,85,247,0.18)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.font = '10px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('SPACE: süper çekim', pad + SUPER_CHARGES * 16 + 12, H - 14);
}

function draw(): void {
  drawBackground();

  // flash overlays
  if (flashMs > 0) {
    const a = flashMs / 260;
    ctx.fillStyle = `rgba(34,197,94,${0.22 * a})`;
    ctx.fillRect(0, 0, W, H);
  }
  if (badFlashMs > 0) {
    const a = badFlashMs / 380;
    ctx.fillStyle = `rgba(239,68,68,${0.28 * a})`;
    ctx.fillRect(0, 0, W, H);
  }

  drawGoal();
  drawShavings();
  drawMagnet();
  drawCharges();
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

// ── Flow ──
function resetCommonState(): void {
  cancelAnimationFrame(rafId);
  shavings = [];
  score = 0;
  lives = LIVES_MAX;
  round = 1;
  targetRemaining = 0;
  targetTotal = 0;
  superCharges = SUPER_CHARGES;
  superMs = 0;
  magnetX = W / 2;
  magnetY = H * 0.7;
  magnetTargetX = magnetX;
  magnetTargetY = magnetY;
  elapsed = 0;
  flashMs = 0;
  badFlashMs = 0;
}

function startGame(): void {
  resetCommonState();
  spawnShavings();
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
  overlayTitle.textContent = isBest ? 'Yeni rekor!' : 'Oyun bitti';
  overlayMsg.innerHTML =
    `Skor: <strong>${score}</strong> · Tur: ${round}<br>En iyi: ${best}` +
    '<br><small>SPACE veya R ile tekrar oyna</small>';
  overlayBtn.textContent = 'Tekrar oyna';
  showOverlayEl(overlay);
  overlayBtn.focus({ preventScroll: true });
}

function resetToReady(): void {
  resetCommonState();
  state = 'ready';
  // give a preview palette so first frame isn't empty-feeling
  targetColor = 0;
  targetTotal = 0;
  targetRemaining = 0;
  updateHud();
  overlayTitle.textContent = 'Mıknatıs';
  overlayMsg.innerHTML =
    'Mıknatısı sürükle; yakındaki tüm metal kırıntılarını çeker.' +
    ' Yalnızca <b>hedef rengi</b> üstteki kasaya getir — yanlış renk' +
    ' kasaya girerse can kaybedersin.<br>' +
    '<small>Fare/dokun · SPACE: süper çekim · R: yeniden başla</small>';
  overlayBtn.textContent = 'Başla';
  showOverlayEl(overlay);
  draw();
}

// ── Input ──
function canvasToWorld(clientX: number, clientY: number): {
  x: number;
  y: number;
} {
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) {
    return { x: magnetTargetX, y: magnetTargetY };
  }
  const sx = W / rect.width;
  const sy = H / rect.height;
  let x = (clientX - rect.left) * sx;
  let y = (clientY - rect.top) * sy;
  if (x < 0) x = 0;
  else if (x > W) x = W;
  if (y < 0) y = 0;
  else if (y > H) y = H;
  return { x, y };
}

function onPointerMove(e: PointerEvent): void {
  if (state !== 'playing') return;
  const p = canvasToWorld(e.clientX, e.clientY);
  magnetTargetX = p.x;
  magnetTargetY = p.y;
}

function onPointerDown(e: PointerEvent): void {
  if (state !== 'playing') return;
  const p = canvasToWorld(e.clientX, e.clientY);
  magnetTargetX = p.x;
  magnetTargetY = p.y;
  // snap magnet position immediately on tap for responsiveness
  magnetX = p.x;
  magnetY = p.y;
}

function onTouchMove(e: TouchEvent): void {
  if (state !== 'playing') return;
  if (e.touches.length === 0) return;
  e.preventDefault();
  const t = e.touches[0]!;
  const p = canvasToWorld(t.clientX, t.clientY);
  magnetTargetX = p.x;
  magnetTargetY = p.y;
}

function triggerSuper(): void {
  if (state !== 'playing') return;
  if (superCharges <= 0) return;
  if (superMs > 0) return;
  superCharges--;
  superMs = SUPER_MS;
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
  if (k === ' ') {
    e.preventDefault();
    triggerSuper();
  }
}

// ── Init ──
function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  livesEl = document.querySelector<HTMLElement>('#lives')!;
  roundEl = document.querySelector<HTMLElement>('#round')!;
  targetEl = document.querySelector<HTMLElement>('#target')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;

  best = safeRead<number>(STORAGE_BEST, 0);
  if (!Number.isFinite(best) || best < 0) best = 0;

  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('touchmove', onTouchMove, { passive: false });
  canvas.addEventListener('touchstart', onTouchMove, { passive: false });

  window.addEventListener('keydown', onKeyDown);

  restartBtn.addEventListener('click', () => startGame());
  overlayBtn.addEventListener('click', () => startGame());

  resetToReady();
}

export const game = defineGame({ init, reset: resetToReady });
