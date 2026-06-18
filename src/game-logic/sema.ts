import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';

const STORAGE_BEST = 'sema.best';
const ROUND_MS = 60_000;

type State = 'ready' | 'playing' | 'gameover';
type Tier = 0 | 1 | 2;

interface Note {
  angle: number;
  radius: number;
  tier: Tier;
  life: number;
  ttl: number;
  cooldown: number;
  alive: boolean;
}

// Canvas + center
const CX = 240;
const CY = 240;

// Arm-tip radius range. Visual scale tuned so the dervish fits the 480x480
// canvas; collisions use the same numbers (PITFALLS#visual-vs-hitbox).
const ARM_MIN = 26;
const ARM_MAX = 200;

// Note ring radii (where each tier's notes spawn).
const RING_R: Record<Tier, number> = { 0: 70, 1: 130, 2: 190 };
// Match tolerance: how close (in pixels) the arm-tip radius must be to the
// note's ring for a collect. Inner notes get a wider tolerance because they
// pass under the arm faster (smaller arc length per radian).
const RING_TOL: Record<Tier, number> = { 0: 22, 1: 18, 2: 16 };
const TIER_POINTS: Record<Tier, number> = { 0: 1, 1: 3, 2: 5 };

const TIER_COLOR_VAR = ['--sema-inner', '--sema-mid', '--sema-outer'] as const;

const NOTE_ANGLE_HALF = 0.28; // ~16° arc the arm tip must sweep over the note
const NOTE_TTL_MS = 5200;
// Per-tier respawn cooldown. Outer ring is slower to refill so a player who
// camps it at max spin can't farm 5-pointers indefinitely; the optimal strat
// is to peel inward during the outer ring's downtime.
const NOTE_RESPAWN_MS: Record<Tier, number> = { 0: 700, 1: 1100, 2: 1700 };

// Dynamics. dt in ms; values per ms.
const OMEGA_MIN = 0.0010; // even at rest the dervish has slow drift
const OMEGA_MAX = 0.0090; // ~1 rev per ~700ms
const SPIN_GAIN = 0.0000110; // accel while input held
const SPIN_FRICTION = 0.0000050; // decel when not held
// Arm responds smoothly to omega rather than snapping (so a quick tap doesn't
// teleport the tip across a note).
const ARM_LERP = 0.012; // per ms

const gen = createGenToken();

let state: State = 'ready';
let score = 0;
let best = 0;
let timeLeftMs = ROUND_MS;
let lastTs = 0;
let theta = 0;
let omega = OMEGA_MIN;
let armR = ARM_MIN;
let pressed = false;
let notes: Note[] = [];
let pulse = 0;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let timeEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlayEl!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let spinFill!: HTMLElement;

const cssCache = new Map<string, string>();
function css(name: string): string {
  const cached = cssCache.get(name);
  if (cached !== undefined) return cached;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  cssCache.set(name, v || '#fff');
  return cssCache.get(name)!;
}

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.innerHTML = msg;
  showOverlayEl(overlayEl);
}

function hideOverlay(): void {
  hideOverlayEl(overlayEl);
}

function armRadiusFor(o: number): number {
  const t = (o - OMEGA_MIN) / (OMEGA_MAX - OMEGA_MIN);
  const clamped = Math.max(0, Math.min(1, t));
  return ARM_MIN + (ARM_MAX - ARM_MIN) * clamped;
}

function makeNote(tier: Tier): Note {
  return {
    angle: Math.random() * Math.PI * 2,
    radius: RING_R[tier],
    tier,
    life: 0,
    ttl: NOTE_TTL_MS,
    cooldown: 0,
    alive: true,
  };
}

function seedNotes(): void {
  // One slot per tier; recycled in step() after cooldown expires.
  notes = [makeNote(0), makeNote(1), makeNote(2)];
}

function angularDistance(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return Math.abs(d);
}

function reset(): void {
  gen.bump();
  state = 'ready';
  score = 0;
  timeLeftMs = ROUND_MS;
  theta = 0;
  omega = OMEGA_MIN;
  armR = ARM_MIN;
  pressed = false;
  pulse = 0;
  scoreEl.textContent = '0';
  timeEl.textContent = '60';
  bestEl.textContent = String(best);
  seedNotes();
  draw();
  showOverlay(
    'Sema',
    'Boşluk tuşunu <b>basılı tut</b> ki semazen hızlansın, kollar açılsın.<br/>Bırakırsan yavaşlar, kollar içe çekilir.<br/>Kolların ucu, notaların bulunduğu yarıçapı süpürdüğünde notayı toplarsın.<br/><br/><b>Başlamak için boşluğa bas.</b>',
  );
}

function startPlaying(): void {
  if (state !== 'ready') return;
  state = 'playing';
  lastTs = performance.now();
  hideOverlay();
  const myGen = gen.current();
  const tick = (ts: number): void => {
    if (!gen.isCurrent(myGen)) return;
    loop(ts);
  };
  requestAnimationFrame(tick);
}

function endRound(): void {
  state = 'gameover';
  if (score > best) {
    best = score;
    bestEl.textContent = String(best);
    safeWrite(STORAGE_BEST, best);
  }
  showOverlay(
    'Süre doldu',
    `Skor: <b>${score}</b><br/>R, boşluk veya tıklama ile yeniden başla.`,
  );
}

function loop(ts: number): void {
  if (state !== 'playing') return;
  const dtRaw = ts - lastTs;
  lastTs = ts;
  // Cap dt (PITFALLS guard against backgrounded-tab catch-up).
  const dt = Math.min(dtRaw, 50);

  step(dt);
  draw();

  timeLeftMs -= dtRaw;
  if (timeLeftMs <= 0) {
    timeLeftMs = 0;
    timeEl.textContent = '0';
    endRound();
    return;
  }
  timeEl.textContent = String(Math.ceil(timeLeftMs / 1000));

  const myGen = gen.current();
  const tick = (next: number): void => {
    if (!gen.isCurrent(myGen)) return;
    loop(next);
  };
  requestAnimationFrame(tick);
}

function step(dt: number): void {
  // Spin acceleration / friction
  if (pressed) omega += SPIN_GAIN * dt;
  else omega -= SPIN_FRICTION * dt;
  if (omega > OMEGA_MAX) omega = OMEGA_MAX;
  if (omega < OMEGA_MIN) omega = OMEGA_MIN;

  // Smooth arm radius (centrifugal extension) toward target.
  const target = armRadiusFor(omega);
  const k = 1 - Math.exp(-ARM_LERP * dt);
  armR += (target - armR) * k;

  // Rotate the dervish. theta is the angle of one arm; the other arm is +π.
  theta += omega * dt;
  pulse += dt;

  // Update notes: life, expire, respawn after cooldown.
  for (const n of notes) {
    if (!n.alive) {
      n.cooldown -= dt;
      if (n.cooldown <= 0) {
        n.angle = Math.random() * Math.PI * 2;
        n.life = 0;
        n.ttl = NOTE_TTL_MS;
        n.alive = true;
      }
      continue;
    }
    n.life += dt;
    if (n.life >= n.ttl) {
      // Expire silently — caught/missed are separate paths.
      n.alive = false;
      n.cooldown = NOTE_RESPAWN_MS[n.tier];
    }
  }

  // Collision: each of the two arm tips sweeps a small angular window.
  // For each alive note, check both tips.
  const tipAngles = [theta, theta + Math.PI];
  for (const n of notes) {
    if (!n.alive) continue;
    if (Math.abs(armR - n.radius) > RING_TOL[n.tier]) continue;
    let hit = false;
    for (const a of tipAngles) {
      if (angularDistance(a, n.angle) < NOTE_ANGLE_HALF) {
        hit = true;
        break;
      }
    }
    if (hit) {
      score += TIER_POINTS[n.tier];
      scoreEl.textContent = String(score);
      n.alive = false;
      n.cooldown = NOTE_RESPAWN_MS[n.tier];
    }
  }

  // Spin meter
  const pct = (omega - OMEGA_MIN) / (OMEGA_MAX - OMEGA_MIN);
  spinFill.style.width = (Math.max(0, Math.min(1, pct)) * 100).toFixed(1) + '%';
}

function draw(): void {
  ctx.fillStyle = css('--surface');
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Outer floor ring (Sema platform)
  ctx.strokeStyle = css('--sema-floor');
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(CX, CY, ARM_MAX + 18, 0, Math.PI * 2);
  ctx.stroke();

  // Faint guide rings showing where each tier's notes live
  for (const tier of [0, 1, 2] as Tier[]) {
    ctx.strokeStyle = css(TIER_COLOR_VAR[tier]);
    ctx.globalAlpha = 0.14;
    ctx.lineWidth = RING_TOL[tier] * 2;
    ctx.beginPath();
    ctx.arc(CX, CY, RING_R[tier], 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // Notes
  for (const n of notes) {
    if (!n.alive) continue;
    const nx = CX + Math.cos(n.angle) * n.radius;
    const ny = CY + Math.sin(n.angle) * n.radius;
    // Fade in/out around full life
    const t = n.life / n.ttl;
    const fade = t < 0.18 ? t / 0.18 : t > 0.82 ? (1 - t) / 0.18 : 1;
    ctx.globalAlpha = Math.max(0.25, fade);
    ctx.fillStyle = css(TIER_COLOR_VAR[n.tier]);
    ctx.beginPath();
    ctx.arc(nx, ny, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    // Inner dot
    ctx.fillStyle = css('--sema-note-core');
    ctx.beginPath();
    ctx.arc(nx, ny, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  // Dervish arms: a single bar across the center with two glowing tips.
  const tipAx = CX + Math.cos(theta) * armR;
  const tipAy = CY + Math.sin(theta) * armR;
  const tipBx = CX + Math.cos(theta + Math.PI) * armR;
  const tipBy = CY + Math.sin(theta + Math.PI) * armR;

  ctx.strokeStyle = css('--sema-arm');
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(tipAx, tipAy);
  ctx.lineTo(tipBx, tipBy);
  ctx.stroke();

  // Glow tips
  const glow = 9 + Math.sin(pulse * 0.012) * 1.4;
  for (const [tx, ty] of [
    [tipAx, tipAy],
    [tipBx, tipBy],
  ] as const) {
    ctx.fillStyle = css('--sema-tip');
    ctx.beginPath();
    ctx.arc(tx, ty, glow, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = css('--sema-tip-core');
    ctx.beginPath();
    ctx.arc(tx, ty, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  // Robe (center disk)
  ctx.fillStyle = css('--sema-robe');
  ctx.beginPath();
  ctx.arc(CX, CY, 18, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = css('--sema-arm');
  ctx.lineWidth = 2;
  ctx.stroke();

  // Head
  ctx.fillStyle = css('--sema-head');
  ctx.beginPath();
  ctx.arc(CX, CY, 8, 0, Math.PI * 2);
  ctx.fill();
}

function setPressed(down: boolean): void {
  if (state === 'gameover') return;
  if (state === 'ready' && down) {
    startPlaying();
  }
  pressed = down;
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  timeEl = document.querySelector<HTMLElement>('#time')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlayEl = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  spinFill = document.querySelector<HTMLElement>('#spin-fill')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  restartBtn.addEventListener('click', () => {
    reset();
  });

  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    const k = e.key.toLowerCase();
    if (k === ' ' || k === 'spacebar' || k === 'arrowup' || k === 'w') {
      if (state === 'gameover') {
        reset();
        e.preventDefault();
        return;
      }
      setPressed(true);
      e.preventDefault();
    } else if (k === 'r') {
      reset();
      e.preventDefault();
    }
  });
  window.addEventListener('keyup', (e) => {
    const k = e.key.toLowerCase();
    if (k === ' ' || k === 'spacebar' || k === 'arrowup' || k === 'w') {
      setPressed(false);
      e.preventDefault();
    }
  });

  // Touch button
  const touchBtn = document.querySelector<HTMLButtonElement>('#touch-spin');
  if (touchBtn) {
    touchBtn.addEventListener('pointerdown', (e) => {
      setPressed(true);
      e.preventDefault();
    });
    const release = (e: Event): void => {
      setPressed(false);
      e.preventDefault();
    };
    touchBtn.addEventListener('pointerup', release);
    touchBtn.addEventListener('pointercancel', release);
    touchBtn.addEventListener('pointerleave', release);
  }

  // Click overlay to start / restart from the modal itself.
  overlayEl.addEventListener('click', () => {
    if (state === 'ready') startPlaying();
    else if (state === 'gameover') reset();
  });

  reset();
}

export const game = defineGame({ init, reset });
