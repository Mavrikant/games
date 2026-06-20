import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import {
  showOverlay as showOverlayEl,
  hideOverlay as hideOverlayEl,
} from '@shared/overlay';

// PITFALLS guarded:
// - unguarded-storage: safeRead/safeWrite
// - stale-async-callback: gen-token gates the RAF loop after reset
// - overlay-input-leak: explicit `state` enum; every handler returns early
//   when state isn't 'playing'
// - module-level-dom-access: all queries inside init()
// - missing-overlay-css: per-game CSS defines `.overlay--hidden`

type State = 'ready' | 'playing' | 'paused' | 'gameover';

const STORAGE_BEST = 'kus-yemi.best';
const W = 640;
const H = 420;

const SEEDS_PER_ROUND = 24;
const ROUND_SECONDS = 60;

const BIRD_RADIUS = 14;
const BIRD_SPEED = 95; // px/sec
const BIRD_TURN_RATE = 2.4; // rad/sec — moderate turning radius
const SENSE_RADIUS = 220; // px — bird targets nearest seed inside this

const SEED_RADIUS = 6;
const SEED_LIFETIME = 9; // seconds

const GOLD_RADIUS = 10;
const GOLD_LIFETIME = 6;
const GOLD_INTERVAL_MIN = 6;
const GOLD_INTERVAL_MAX = 10;
const GOLD_SCORE = 6;
const SEED_SCORE = 1;

const WANDER_TURN_RATE = 1.2; // rad/sec when no seed in sight
const WANDER_RETARGET_MIN = 1.4;
const WANDER_RETARGET_MAX = 2.8;

type Vec = { x: number; y: number };
type Seed = Vec & { born: number; gold: boolean };
type Bird = {
  x: number;
  y: number;
  dir: number; // radians, 0 = right
  wanderTarget: Vec;
  wanderTimer: number;
};

const gen = createGenToken();

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let seedsEl!: HTMLElement;
let timeEl!: HTMLElement;
let bestEl!: HTMLElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let restartBtn!: HTMLButtonElement;

let state: State = 'ready';
let score = 0;
let best = 0;
let seedsLeft = SEEDS_PER_ROUND;
let timeLeft = ROUND_SECONDS;
let elapsed = 0;
let lastFrame = 0;

let bird!: Bird;
let seeds: Seed[] = [];
let goldSeed: Seed | null = null;
let goldTimer = 0; // seconds until next gold spawn

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlay);
}

function hideOverlay(): void {
  hideOverlayEl(overlay);
}

function setHud(): void {
  scoreEl.textContent = String(score);
  seedsEl.textContent = String(seedsLeft);
  timeEl.textContent = String(Math.max(0, Math.ceil(timeLeft)));
  bestEl.textContent = String(best);
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function pickWanderTarget(): Vec {
  // Bias toward the interior so the bird doesn't hug walls.
  const m = 40;
  return { x: rand(m, W - m), y: rand(m, H - m) };
}

function newBird(): Bird {
  return {
    x: W / 2,
    y: H / 2,
    dir: rand(0, Math.PI * 2),
    wanderTarget: pickWanderTarget(),
    wanderTimer: rand(WANDER_RETARGET_MIN, WANDER_RETARGET_MAX),
  };
}

function scheduleGold(): void {
  goldTimer = rand(GOLD_INTERVAL_MIN, GOLD_INTERVAL_MAX);
}

function placeGold(): Seed {
  const m = 50;
  return {
    x: rand(m, W - m),
    y: rand(m, H - m),
    born: elapsed,
    gold: true,
  };
}

function reset(): void {
  gen.bump();
  state = 'ready';
  score = 0;
  seedsLeft = SEEDS_PER_ROUND;
  timeLeft = ROUND_SECONDS;
  elapsed = 0;
  seeds = [];
  goldSeed = null;
  scheduleGold();
  bird = newBird();
  setHud();
  draw();
  showOverlay(
    'Kuş Yemi',
    'Aç kuşu altın çekirdeklere yemle yönlendir. Başlamak için bahçeye dokun veya boşluğa bas.',
  );
}

function start(): void {
  if (state !== 'ready' && state !== 'gameover') return;
  if (state === 'gameover') reset();
  state = 'playing';
  hideOverlay();
  lastFrame = performance.now();
  scheduleRaf();
}

function togglePause(): void {
  if (state === 'playing') {
    state = 'paused';
    showOverlay('Duraklatıldı', 'Devam için boşluğa bas.');
  } else if (state === 'paused') {
    state = 'playing';
    hideOverlay();
    lastFrame = performance.now();
    scheduleRaf();
  }
}

function endRound(): void {
  state = 'gameover';
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
  setHud();
  showOverlay(
    'Tur bitti',
    `Skor: ${score} · En iyi: ${best}\nR ile veya tıklayarak yeniden başla.`,
  );
}

function dropSeed(x: number, y: number): void {
  if (state !== 'playing') return;
  if (seedsLeft <= 0) return;
  seeds.push({ x, y, born: elapsed, gold: false });
  seedsLeft--;
  setHud();
}

function nearestSeed(): Seed | null {
  let best: Seed | null = null;
  let bestD2 = SENSE_RADIUS * SENSE_RADIUS;
  for (const s of seeds) {
    const dx = s.x - bird.x;
    const dy = s.y - bird.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = s;
    }
  }
  if (goldSeed) {
    const dx = goldSeed.x - bird.x;
    const dy = goldSeed.y - bird.y;
    const d2 = dx * dx + dy * dy;
    // Gold gets a small attraction bonus so it's preferred when seeds are
    // similarly distant — the player can still bait the bird away with a
    // closer chain of seeds.
    if (d2 < bestD2 * 1.25) {
      best = goldSeed;
    }
  }
  return best;
}

function angleTo(target: Vec): number {
  return Math.atan2(target.y - bird.y, target.x - bird.x);
}

function turnToward(targetDir: number, maxTurn: number): void {
  let delta = targetDir - bird.dir;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  if (delta > maxTurn) delta = maxTurn;
  else if (delta < -maxTurn) delta = -maxTurn;
  bird.dir += delta;
}

function updateBird(dt: number): void {
  const target = nearestSeed();
  if (target) {
    turnToward(angleTo(target), BIRD_TURN_RATE * dt);
  } else {
    // Wander toward current target; pick a new one when timer expires or
    // we're close enough to it.
    const dx = bird.wanderTarget.x - bird.x;
    const dy = bird.wanderTarget.y - bird.y;
    if (Math.hypot(dx, dy) < 30 || bird.wanderTimer <= 0) {
      bird.wanderTarget = pickWanderTarget();
      bird.wanderTimer = rand(WANDER_RETARGET_MIN, WANDER_RETARGET_MAX);
    } else {
      bird.wanderTimer -= dt;
    }
    turnToward(angleTo(bird.wanderTarget), WANDER_TURN_RATE * dt);
  }

  bird.x += Math.cos(bird.dir) * BIRD_SPEED * dt;
  bird.y += Math.sin(bird.dir) * BIRD_SPEED * dt;

  // Soft wall bounce: nudge direction away from edge so the bird stays in.
  const margin = 24;
  if (bird.x < margin) {
    bird.x = margin;
    bird.dir = reflectAroundAxis(bird.dir, 'x');
  } else if (bird.x > W - margin) {
    bird.x = W - margin;
    bird.dir = reflectAroundAxis(bird.dir, 'x');
  }
  if (bird.y < margin) {
    bird.y = margin;
    bird.dir = reflectAroundAxis(bird.dir, 'y');
  } else if (bird.y > H - margin) {
    bird.y = H - margin;
    bird.dir = reflectAroundAxis(bird.dir, 'y');
  }
}

function reflectAroundAxis(dir: number, axis: 'x' | 'y'): number {
  // x-wall: flip horizontal component (dir → π - dir)
  // y-wall: flip vertical component (dir → -dir)
  return axis === 'x' ? Math.PI - dir : -dir;
}

function tryEat(): void {
  // Regular seeds.
  const eatR = BIRD_RADIUS + SEED_RADIUS;
  const eatR2 = eatR * eatR;
  for (let i = seeds.length - 1; i >= 0; i--) {
    const s = seeds[i]!;
    const dx = s.x - bird.x;
    const dy = s.y - bird.y;
    if (dx * dx + dy * dy <= eatR2) {
      seeds.splice(i, 1);
      score += SEED_SCORE;
    }
  }
  // Gold seed.
  if (goldSeed) {
    const gr = BIRD_RADIUS + GOLD_RADIUS;
    const dx = goldSeed.x - bird.x;
    const dy = goldSeed.y - bird.y;
    if (dx * dx + dy * dy <= gr * gr) {
      goldSeed = null;
      score += GOLD_SCORE;
      scheduleGold();
    }
  }
  setHud();
}

function expireSeeds(): void {
  for (let i = seeds.length - 1; i >= 0; i--) {
    if (elapsed - seeds[i]!.born > SEED_LIFETIME) {
      seeds.splice(i, 1);
    }
  }
  if (goldSeed && elapsed - goldSeed.born > GOLD_LIFETIME) {
    goldSeed = null;
    scheduleGold();
  }
}

function updateGoldSpawn(dt: number): void {
  if (goldSeed) return;
  goldTimer -= dt;
  if (goldTimer <= 0) {
    goldSeed = placeGold();
  }
}

function scheduleRaf(): void {
  const myGen = gen.current();
  requestAnimationFrame((t) => loop(t, myGen));
}

function loop(t: number, myGen: number): void {
  if (!gen.isCurrent(myGen)) return;
  if (state !== 'playing') return;
  const dt = Math.min(0.05, (t - lastFrame) / 1000);
  lastFrame = t;
  elapsed += dt;
  timeLeft -= dt;

  updateBird(dt);
  tryEat();
  updateGoldSpawn(dt);
  expireSeeds();
  setHud();
  draw();

  if (timeLeft <= 0) {
    endRound();
    return;
  }
  if (seedsLeft <= 0 && seeds.length === 0 && !goldSeed) {
    // Player ran out of options for this round; end early.
    endRound();
    return;
  }

  requestAnimationFrame((tt) => loop(tt, myGen));
}

function getCss(varName: string): string {
  return getComputedStyle(document.documentElement)
    .getPropertyValue(varName)
    .trim();
}

let cssCache: { [k: string]: string } = {};
function css(varName: string): string {
  const cached = cssCache[varName];
  if (cached !== undefined) return cached;
  const v = getCss(varName);
  cssCache[varName] = v;
  return v;
}

function drawGrassStripes(): void {
  ctx.fillStyle = css('--ky-grass');
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = css('--ky-grass-stripe');
  const stripeH = 28;
  for (let y = 0; y < H; y += stripeH * 2) {
    ctx.fillRect(0, y, W, stripeH);
  }
}

function drawSeed(s: Seed): void {
  if (s.gold) {
    const glow = ctx.createRadialGradient(s.x, s.y, 2, s.x, s.y, GOLD_RADIUS * 2.2);
    glow.addColorStop(0, css('--ky-gold-glow'));
    glow.addColorStop(1, 'rgba(255, 213, 74, 0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(s.x, s.y, GOLD_RADIUS * 2.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = css('--ky-gold');
    ctx.beginPath();
    ctx.arc(s.x, s.y, GOLD_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.fillStyle = css('--ky-seed-shadow');
  ctx.beginPath();
  ctx.ellipse(s.x, s.y + 2, SEED_RADIUS, SEED_RADIUS * 0.6, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = css('--ky-seed');
  ctx.beginPath();
  ctx.ellipse(s.x, s.y, SEED_RADIUS, SEED_RADIUS * 0.75, 0, 0, Math.PI * 2);
  ctx.fill();
}

function drawBird(): void {
  ctx.save();
  ctx.translate(bird.x, bird.y);
  ctx.rotate(bird.dir);

  // Body (ellipse)
  ctx.fillStyle = css('--ky-bird');
  ctx.beginPath();
  ctx.ellipse(0, 0, BIRD_RADIUS * 1.15, BIRD_RADIUS * 0.85, 0, 0, Math.PI * 2);
  ctx.fill();

  // Wing — wobble with elapsed time for a subtle flap
  const flap = Math.sin(elapsed * 14) * 3;
  ctx.fillStyle = css('--ky-bird-wing');
  ctx.beginPath();
  ctx.ellipse(-2, -2 + flap * 0.3, BIRD_RADIUS * 0.65, BIRD_RADIUS * 0.4, -0.4, 0, Math.PI * 2);
  ctx.fill();

  // Beak (triangle)
  ctx.fillStyle = css('--ky-bird-beak');
  ctx.beginPath();
  ctx.moveTo(BIRD_RADIUS * 1.1, 0);
  ctx.lineTo(BIRD_RADIUS * 1.6, -3);
  ctx.lineTo(BIRD_RADIUS * 1.6, 3);
  ctx.closePath();
  ctx.fill();

  // Eye
  ctx.fillStyle = '#1a1f25';
  ctx.beginPath();
  ctx.arc(BIRD_RADIUS * 0.55, -BIRD_RADIUS * 0.3, 1.8, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

function draw(): void {
  drawGrassStripes();
  for (const s of seeds) drawSeed(s);
  if (goldSeed) drawSeed(goldSeed);
  drawBird();
}

function canvasPoint(e: PointerEvent): Vec {
  const rect = canvas.getBoundingClientRect();
  const sx = canvas.width / rect.width;
  const sy = canvas.height / rect.height;
  return {
    x: (e.clientX - rect.left) * sx,
    y: (e.clientY - rect.top) * sy,
  };
}

function onCanvasPointer(e: PointerEvent): void {
  // Single source of truth for clicks/taps. preventDefault avoids the
  // browser firing a synthetic click after a touch (which would double-drop
  // a seed) and also stops touch scrolling.
  e.preventDefault();
  if (state === 'ready' || state === 'gameover') {
    start();
    return;
  }
  if (state !== 'playing') return;
  const p = canvasPoint(e);
  dropSeed(p.x, p.y);
}

function onKey(e: KeyboardEvent): void {
  const k = e.key.toLowerCase();
  if (k === ' ') {
    e.preventDefault();
    if (state === 'ready' || state === 'gameover') {
      start();
    } else {
      togglePause();
    }
  } else if (k === 'r') {
    e.preventDefault();
    reset();
  }
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  seedsEl = document.querySelector<HTMLElement>('#seeds')!;
  timeEl = document.querySelector<HTMLElement>('#time')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  canvas.addEventListener('pointerdown', onCanvasPointer);
  // Pointer events on the overlay too — backdrop tap should also start.
  // pitfall: unreachable-start-state
  overlay.addEventListener('pointerdown', (e) => {
    if (state !== 'ready' && state !== 'gameover' && state !== 'paused') return;
    e.preventDefault();
    if (state === 'paused') togglePause();
    else start();
  });
  window.addEventListener('keydown', onKey);
  restartBtn.addEventListener('click', () => reset());

  reset();
}

export const game = defineGame({ init, reset });
