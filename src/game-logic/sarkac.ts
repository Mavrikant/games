import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';

const STORAGE_BEST = 'sarkac.best';
const ROUND_MS = 60_000;

type State = 'ready' | 'playing' | 'gameover';
type Tier = 0 | 1 | 2;

interface Brick {
  angle: number;
  radius: number;
  tier: Tier;
  hp: number;
  cooldown: number;
}

const PIVOT_X = 240;
const PIVOT_Y = 90;
const ROPE_LEN = 290;
const BOB_R = 18;
const BRICK_R = 16;
// Tuned so the natural period (at small amplitude) is roughly 0.9 s:
//   T = 2π / √g  →  g ≈ 0.0000487 for T ≈ 900 ms.
// All other rates are per millisecond, matching dt from performance.now().
const GRAVITY = 0.00005;
const DAMPING = 0.000005;
const PUMP_GAIN = 0.000045;
const PUMP_BRAKE = 0.00008;
const MAX_OMEGA = 0.013;

const TIER_THRESHOLD = [0.0, 0.005, 0.0085];
const TIER_POINTS: Record<Tier, number> = { 0: 1, 1: 3, 2: 5 };
const TIER_COLOR_VAR = ['--sarkac-white', '--sarkac-yellow', '--sarkac-red'] as const;
const BRICK_RESPAWN_MS = 1100;
const MAX_BRICKS = 8;

const gen = createGenToken();

let state: State = 'ready';
let score = 0;
let best = 0;
let timeLeftMs = ROUND_MS;
let lastTs = 0;
let theta = 0;
let omega = 0;
let leftPressed = false;
let rightPressed = false;
let bricks: Brick[] = [];
let rafHandle = 0;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let timeEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlayEl!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let speedFill!: HTMLElement;

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

function tierForSpeed(absOmega: number): Tier {
  if (absOmega >= TIER_THRESHOLD[2]!) return 2;
  if (absOmega >= TIER_THRESHOLD[1]!) return 1;
  return 0;
}

function randAngle(): number {
  // Bricks live in an arc roughly +- 70° from straight down. We bias toward the
  // outer arc (further from rest) so they aren't all clustered at the bottom.
  const sign = Math.random() < 0.5 ? -1 : 1;
  const mag = 0.25 + Math.random() * 1.05; // ~14° to ~74°
  return sign * mag;
}

function randRadius(tier: Tier): number {
  // Higher tiers sit closer to the bob's path so they're reachable; the actual
  // hit depends on bob radius + brick radius regardless. We use small jitter
  // so the field doesn't look like a perfect arc.
  const base = ROPE_LEN;
  const jitter = (Math.random() - 0.5) * 18;
  // Slight bias: red bricks live a touch closer to the bob (forgiving),
  // because they require the most precise timing.
  const bias = tier === 2 ? -4 : tier === 1 ? 0 : 2;
  return base + jitter + bias;
}

function spawnBrick(): Brick | null {
  if (bricks.length >= MAX_BRICKS) return null;
  // Tier mix: more whites early, weighted distribution.
  const roll = Math.random();
  const tier: Tier = roll < 0.5 ? 0 : roll < 0.85 ? 1 : 2;
  // Avoid spawning on top of an existing brick: try a few times.
  for (let attempt = 0; attempt < 8; attempt++) {
    const angle = randAngle();
    const radius = randRadius(tier);
    const overlap = bricks.some((b) => {
      const dx = Math.sin(angle) * radius - Math.sin(b.angle) * b.radius;
      const dy = Math.cos(angle) * radius - Math.cos(b.angle) * b.radius;
      return dx * dx + dy * dy < (BRICK_R * 2.4) ** 2;
    });
    if (!overlap) {
      return { angle, radius, tier, hp: 1, cooldown: 0 };
    }
  }
  return null;
}

function seedField(): void {
  bricks = [];
  for (let i = 0; i < 6; i++) {
    const b = spawnBrick();
    if (b) bricks.push(b);
  }
}

function resizeBob(): void {
  // Keep cellSize-style responsive scaling: CSS scales width; canvas internal
  // resolution stays at design size (480x640). No work needed here.
}

function reset(): void {
  gen.bump();
  state = 'ready';
  score = 0;
  timeLeftMs = ROUND_MS;
  theta = 0.12; // small starting angle so player sees motion immediately
  omega = 0;
  leftPressed = false;
  rightPressed = false;
  scoreEl.textContent = '0';
  timeEl.textContent = '60';
  bestEl.textContent = String(best);
  seedField();
  draw();
  showOverlay(
    'Sarkaç',
    '← veya → ile sarkacı pompala. Hızlandıkça daha sert tuğlaları kırarsın.<br/>Boşluk veya bir ok tuşuna basarak başla.',
  );
}

function startPlaying(): void {
  if (state !== 'ready') return;
  state = 'playing';
  lastTs = performance.now();
  hideOverlay();
  rafHandle = requestAnimationFrame(loop);
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
    `Skor: ${score}<br/>R veya tıklama ile yeniden başla.`,
  );
}

function loop(ts: number): void {
  if (state !== 'playing') return;
  const dtRaw = ts - lastTs;
  lastTs = ts;
  // Cap dt: if the tab was backgrounded, don't simulate a 5-second catch-up.
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

  rafHandle = requestAnimationFrame(loop);
}

function step(dt: number): void {
  // Pendulum dynamics: omega' = -(g/L) sin(theta) - damping*omega
  const accel = -GRAVITY * Math.sin(theta) - DAMPING * omega;
  omega += accel * dt;

  // Pump: arrow in direction of motion increases |omega|. Wrong direction brakes.
  // We use sign(omega) to determine the motion direction. If omega ~ 0 we still
  // allow a small kick to break stasis.
  const movingRight = omega > 0;
  const movingLeft = omega < 0;
  if (leftPressed) {
    if (movingLeft) omega -= PUMP_GAIN * dt;
    else if (movingRight) omega -= PUMP_BRAKE * dt;
    else omega -= PUMP_GAIN * dt * 0.5;
  }
  if (rightPressed) {
    if (movingRight) omega += PUMP_GAIN * dt;
    else if (movingLeft) omega += PUMP_BRAKE * dt;
    else omega += PUMP_GAIN * dt * 0.5;
  }

  // Clamp omega so we don't escape to infinity
  if (omega > MAX_OMEGA) omega = MAX_OMEGA;
  if (omega < -MAX_OMEGA) omega = -MAX_OMEGA;

  theta += omega * dt;

  // Bob position
  const bobX = PIVOT_X + Math.sin(theta) * ROPE_LEN;
  const bobY = PIVOT_Y + Math.cos(theta) * ROPE_LEN;
  const absOmega = Math.abs(omega);
  const hitTier = tierForSpeed(absOmega);

  // Brick collisions + respawn timers
  const nextBricks: Brick[] = [];
  for (const b of bricks) {
    if (b.cooldown > 0) {
      b.cooldown -= dt;
      if (b.cooldown <= 0) {
        const replacement = spawnBrick();
        if (replacement) {
          nextBricks.push(replacement);
          continue;
        }
        // No spawn slot available right now; let it pop in next tick.
        b.cooldown = 1;
        nextBricks.push(b);
        continue;
      }
      nextBricks.push(b);
      continue;
    }
    const bx = PIVOT_X + Math.sin(b.angle) * b.radius;
    const by = PIVOT_Y + Math.cos(b.angle) * b.radius;
    const dx = bobX - bx;
    const dy = bobY - by;
    const dist2 = dx * dx + dy * dy;
    const rsum = BOB_R + BRICK_R;
    if (dist2 <= rsum * rsum && hitTier >= b.tier) {
      // Break!
      score += TIER_POINTS[b.tier];
      scoreEl.textContent = String(score);
      nextBricks.push({ ...b, hp: 0, cooldown: BRICK_RESPAWN_MS });
      continue;
    }
    nextBricks.push(b);
  }
  bricks = nextBricks;

  // Speed meter UI
  const pct = Math.min(1, absOmega / MAX_OMEGA);
  speedFill.style.width = (pct * 100).toFixed(1) + '%';
  speedFill.style.background =
    hitTier === 2
      ? css('--sarkac-red')
      : hitTier === 1
        ? css('--sarkac-yellow')
        : css('--sarkac-white');
}

function draw(): void {
  ctx.fillStyle = css('--surface');
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Subtle arc guide showing the swing path
  ctx.strokeStyle = css('--sarkac-arc');
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(PIVOT_X, PIVOT_Y, ROPE_LEN, Math.PI * 0.18, Math.PI * 0.82);
  ctx.stroke();

  // Bricks
  for (const b of bricks) {
    if (b.cooldown > 0) {
      // Ghost respawn indicator
      const bx = PIVOT_X + Math.sin(b.angle) * b.radius;
      const by = PIVOT_Y + Math.cos(b.angle) * b.radius;
      ctx.globalAlpha = 0.18;
      ctx.fillStyle = css(TIER_COLOR_VAR[b.tier]);
      ctx.beginPath();
      ctx.arc(bx, by, BRICK_R * 0.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      continue;
    }
    const bx = PIVOT_X + Math.sin(b.angle) * b.radius;
    const by = PIVOT_Y + Math.cos(b.angle) * b.radius;
    // Outer ring shows required tier
    ctx.strokeStyle = css(TIER_COLOR_VAR[b.tier]);
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(bx, by, BRICK_R, 0, Math.PI * 2);
    ctx.stroke();
    // Filled core
    ctx.fillStyle = css(TIER_COLOR_VAR[b.tier]);
    ctx.globalAlpha = 0.45;
    ctx.beginPath();
    ctx.arc(bx, by, BRICK_R - 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // Rope
  const bobX = PIVOT_X + Math.sin(theta) * ROPE_LEN;
  const bobY = PIVOT_Y + Math.cos(theta) * ROPE_LEN;
  ctx.strokeStyle = css('--sarkac-rope');
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(PIVOT_X, PIVOT_Y);
  ctx.lineTo(bobX, bobY);
  ctx.stroke();

  // Pivot
  ctx.fillStyle = css('--sarkac-rope');
  ctx.beginPath();
  ctx.arc(PIVOT_X, PIVOT_Y, 6, 0, Math.PI * 2);
  ctx.fill();

  // Bob — its color reflects current speed tier
  const absOmega = Math.abs(omega);
  const bobTier = tierForSpeed(absOmega);
  ctx.fillStyle = css(TIER_COLOR_VAR[bobTier]);
  ctx.beginPath();
  ctx.arc(bobX, bobY, BOB_R, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = css('--sarkac-rope');
  ctx.lineWidth = 2;
  ctx.stroke();
}

function pressDir(dir: 'left' | 'right', down: boolean): void {
  if (state === 'gameover') return;
  if (state === 'ready' && down) startPlaying();
  if (dir === 'left') leftPressed = down;
  else rightPressed = down;
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
  speedFill = document.querySelector<HTMLElement>('#speed-fill')!;

  best = safeRead<number>(STORAGE_BEST, 0);
  resizeBob();

  restartBtn.addEventListener('click', () => {
    reset();
    cancelAnimationFrame(rafHandle);
  });

  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    const k = e.key.toLowerCase();
    if (k === 'arrowleft' || k === 'a') {
      pressDir('left', true);
      e.preventDefault();
    } else if (k === 'arrowright' || k === 'd') {
      pressDir('right', true);
      e.preventDefault();
    } else if (k === ' ' || k === 'spacebar') {
      if (state === 'ready') startPlaying();
      else if (state === 'gameover') reset();
      e.preventDefault();
    } else if (k === 'r') {
      reset();
      cancelAnimationFrame(rafHandle);
      e.preventDefault();
    }
  });
  window.addEventListener('keyup', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'arrowleft' || k === 'a') {
      pressDir('left', false);
      e.preventDefault();
    } else if (k === 'arrowright' || k === 'd') {
      pressDir('right', false);
      e.preventDefault();
    }
  });

  // Touch buttons: pump while held, release on pointerup.
  document.querySelectorAll<HTMLButtonElement>('.touch__btn').forEach((btn) => {
    const dir = btn.dataset.dir as 'left' | 'right' | undefined;
    if (!dir) return;
    btn.addEventListener('pointerdown', (e) => {
      pressDir(dir, true);
      e.preventDefault();
    });
    const releaseFn = (e: Event): void => {
      pressDir(dir, false);
      e.preventDefault();
    };
    btn.addEventListener('pointerup', releaseFn);
    btn.addEventListener('pointercancel', releaseFn);
    btn.addEventListener('pointerleave', releaseFn);
  });

  // Click overlay to start / restart from the modal itself.
  overlayEl.addEventListener('click', () => {
    if (state === 'ready') startPlaying();
    else if (state === 'gameover') reset();
  });

  reset();
}

export const game = defineGame({ init, reset });
