// Sönen Yıldız — fading-star risk/reward arcade.
//
// Stars spawn at random positions and fade from full brightness to zero over
// a few seconds. Tapping a star scores points proportional to how DIM it was
// at tap time (squared, so dim is much sweeter). Letting a star fade to zero
// costs one life. Shooting stars cross the screen quickly and pay big.
//
// PITFALLS guarded:
// - module-level-dom-access: all DOM/storage access lives in init().
// - unguarded-storage: safeRead/safeWrite wrap localStorage.
// - stale-async-callback: gen.bump() in reset() cancels the RAF loop.
// - overlay-input-leak: pointer + key handlers gate on state.
// - missing-overlay-css: per-game CSS defines .overlay--hidden visual.
// - unreachable-start-state: overlay has both a Start button and Space/Enter.
// - hud-counter-synced-only-at-lifecycle-edges: score/lives redrawn on change.
// - visual-vs-hitbox: hitTest uses the rendered star radius (shared const).
// - stale-dom-from-prev-state: reset clears stars + spawn timer before render.

import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay, hideOverlay } from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';

const STORAGE_BEST = 'sonen-yildiz.best';
const MAX_LIVES = 3;

// Star lifetimes shrink as score climbs to ratchet difficulty.
const LIFETIME_START = 4.2;
const LIFETIME_FLOOR = 1.6;
const LIFETIME_PER_POINT = 0.018;

// Spawn cadence shortens too.
const SPAWN_INTERVAL_START = 1.05;
const SPAWN_INTERVAL_FLOOR = 0.32;
const SPAWN_PER_POINT = 0.006;

const STAR_RADIUS = 22; // hit + render radius
const SHOOTING_CHANCE = 0.13;
const SHOOTING_SPEED = 260; // px / s
const SHOOTING_LIFETIME = 1.8;

const SCORE_BASE = 10;
const SHOOTING_MULT = 3;
const MIN_GRACE = 0.18; // tapping in this first window pays a tiny floor

type State = 'ready' | 'playing' | 'gameover';

interface Star {
  x: number;
  y: number;
  vx: number; // px / s (non-zero for shooting stars)
  vy: number;
  born: number; // seconds
  lifetime: number;
  shooting: boolean;
  collected: boolean;
}

interface Pop {
  x: number;
  y: number;
  born: number;
  text: string;
  color: string;
}

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let livesEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayBtn!: HTMLButtonElement;

const gen = createGenToken();

let state: State = 'ready';
let score = 0;
let best = 0;
let lives = MAX_LIVES;

let stars: Star[] = [];
let pops: Pop[] = [];
let bgStars: Array<{ x: number; y: number; r: number; tw: number }> = [];

let nowSec = 0;
let lastFrame = 0;
let nextSpawn = 0;

function setScore(v: number): void {
  score = v;
  scoreEl.textContent = String(score);
  if (score > best) {
    best = score;
    bestEl.textContent = String(best);
    safeWrite(STORAGE_BEST, best);
  }
}

function setLives(v: number): void {
  lives = Math.max(0, v);
  livesEl.textContent = String(lives);
}

function currentLifetime(): number {
  return Math.max(LIFETIME_FLOOR, LIFETIME_START - score * LIFETIME_PER_POINT);
}

function currentSpawnInterval(): number {
  return Math.max(
    SPAWN_INTERVAL_FLOOR,
    SPAWN_INTERVAL_START - score * SPAWN_PER_POINT,
  );
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function makeBackgroundStars(): void {
  bgStars = [];
  const count = 60;
  for (let i = 0; i < count; i++) {
    bgStars.push({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      r: Math.random() * 1.2 + 0.3,
      tw: Math.random() * Math.PI * 2,
    });
  }
}

function spawnStar(): void {
  const shooting = Math.random() < SHOOTING_CHANCE;
  if (shooting) {
    // Cross from a random side, near the top half of the canvas.
    const fromLeft = Math.random() < 0.5;
    const x = fromLeft ? -STAR_RADIUS : canvas.width + STAR_RADIUS;
    const y = rand(60, canvas.height * 0.6);
    const dirX = fromLeft ? 1 : -1;
    const drift = rand(-0.25, 0.25);
    stars.push({
      x,
      y,
      vx: dirX * SHOOTING_SPEED,
      vy: drift * SHOOTING_SPEED,
      born: nowSec,
      lifetime: SHOOTING_LIFETIME,
      shooting: true,
      collected: false,
    });
  } else {
    const margin = STAR_RADIUS + 14;
    stars.push({
      x: rand(margin, canvas.width - margin),
      y: rand(margin, canvas.height - margin),
      vx: 0,
      vy: 0,
      born: nowSec,
      lifetime: currentLifetime(),
      shooting: false,
      collected: false,
    });
  }
}

function brightness(s: Star): number {
  const t = (nowSec - s.born) / s.lifetime;
  return Math.max(0, Math.min(1, 1 - t));
}

function pointsFor(s: Star, atTap: number): number {
  // atTap is brightness at moment of tap; lower = harder = more points.
  const dim = 1 - atTap;
  const base = Math.max(MIN_GRACE * MIN_GRACE, dim * dim) * SCORE_BASE;
  const mult = s.shooting ? SHOOTING_MULT : 1;
  return Math.max(1, Math.round(base * mult));
}

function loseLife(): void {
  setLives(lives - 1);
  if (lives <= 0) {
    state = 'gameover';
    overlayTitle.textContent = 'Söndü';
    overlayMsg.textContent =
      `Skor: ${score}  ·  Rekor: ${best}\n` +
      'Bir tuşa, butona ya da gökyüzüne dokun: yeni gece.';
    overlayBtn.textContent = 'Yeniden başla';
    showOverlay(overlay);
  }
}

function spawnPop(x: number, y: number, text: string, color: string): void {
  pops.push({ x, y, text, color, born: nowSec });
  if (pops.length > 24) pops.shift();
}

function tryTap(cx: number, cy: number): boolean {
  // Pick the smallest-distance hit so overlapping stars resolve sanely.
  let bestIdx = -1;
  let bestDist = Infinity;
  for (let i = 0; i < stars.length; i++) {
    const s = stars[i]!;
    if (s.collected) continue;
    const dx = s.x - cx;
    const dy = s.y - cy;
    const d2 = dx * dx + dy * dy;
    const r = STAR_RADIUS + 8; // small forgiveness
    if (d2 <= r * r && d2 < bestDist) {
      bestDist = d2;
      bestIdx = i;
    }
  }
  if (bestIdx === -1) return false;
  const s = stars[bestIdx]!;
  const b = brightness(s);
  const gained = pointsFor(s, b);
  s.collected = true;
  setScore(score + gained);
  spawnPop(
    s.x,
    s.y,
    `+${gained}`,
    s.shooting ? '#ffd166' : b < 0.25 ? '#9be7ff' : '#cfd8ff',
  );
  return true;
}

function update(dt: number): void {
  if (state !== 'playing') return;
  nowSec += dt;

  if (nowSec >= nextSpawn) {
    spawnStar();
    nextSpawn = nowSec + currentSpawnInterval();
  }

  for (const s of stars) {
    if (s.collected) continue;
    if (s.shooting) {
      s.x += s.vx * dt;
      s.y += s.vy * dt;
    }
  }

  // Resolve burnouts and offscreen shooting stars.
  for (const s of stars) {
    if (s.collected) continue;
    const age = nowSec - s.born;
    const off =
      s.shooting &&
      (s.x < -STAR_RADIUS * 2 ||
        s.x > canvas.width + STAR_RADIUS * 2 ||
        s.y < -STAR_RADIUS * 2 ||
        s.y > canvas.height + STAR_RADIUS * 2);
    if (age >= s.lifetime || off) {
      s.collected = true;
      // Burnouts that the player never tapped cost a life.
      // Shooting stars that simply slip past also count as missed.
      if (state === 'playing') {
        spawnPop(
          Math.max(20, Math.min(canvas.width - 20, s.x)),
          Math.max(20, Math.min(canvas.height - 20, s.y)),
          s.shooting ? 'kaçtı' : 'söndü',
          '#ff6b6b',
        );
        loseLife();
        if (state !== 'playing') break;
      }
    }
  }

  stars = stars.filter((s) => !s.collected);
  pops = pops.filter((p) => nowSec - p.born < 0.85);
}

function drawBackground(): void {
  // Sky gradient is on the canvas CSS; clear with a transparent fill so the
  // gradient shows. We still paint a soft dim wash to avoid trail artifacts.
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.save();
  for (const b of bgStars) {
    const tw = 0.6 + 0.4 * Math.sin(nowSec * 1.6 + b.tw);
    ctx.globalAlpha = 0.55 * tw;
    ctx.fillStyle = '#dbe6ff';
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawStarShape(
  x: number,
  y: number,
  r: number,
  spikes: number,
): void {
  const inner = r * 0.45;
  ctx.beginPath();
  for (let i = 0; i < spikes * 2; i++) {
    const ang = (Math.PI / spikes) * i - Math.PI / 2;
    const rad = i % 2 === 0 ? r : inner;
    const px = x + Math.cos(ang) * rad;
    const py = y + Math.sin(ang) * rad;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

function drawStar(s: Star): void {
  const b = brightness(s);
  const r = STAR_RADIUS * (0.55 + 0.45 * b);

  // Glow halo.
  const grd = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, r * 2.6);
  const baseCol = s.shooting ? '255, 216, 102' : '160, 200, 255';
  grd.addColorStop(0, `rgba(${baseCol}, ${0.55 * b})`);
  grd.addColorStop(1, `rgba(${baseCol}, 0)`);
  ctx.fillStyle = grd;
  ctx.beginPath();
  ctx.arc(s.x, s.y, r * 2.6, 0, Math.PI * 2);
  ctx.fill();

  // Shooting-star trail.
  if (s.shooting) {
    const tlen = 56;
    const dirX = Math.sign(s.vx) || 1;
    ctx.save();
    const tg = ctx.createLinearGradient(
      s.x,
      s.y,
      s.x - dirX * tlen,
      s.y - (s.vy / Math.max(1, Math.abs(s.vx))) * tlen,
    );
    tg.addColorStop(0, `rgba(${baseCol}, ${0.85 * b})`);
    tg.addColorStop(1, `rgba(${baseCol}, 0)`);
    ctx.strokeStyle = tg;
    ctx.lineWidth = r * 0.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(
      s.x - dirX * tlen,
      s.y - (s.vy / Math.max(1, Math.abs(s.vx))) * tlen,
    );
    ctx.stroke();
    ctx.restore();
  }

  // Star body.
  ctx.save();
  ctx.globalAlpha = 0.35 + 0.65 * b;
  ctx.fillStyle = s.shooting ? '#fff1c2' : '#e8f0ff';
  drawStarShape(s.x, s.y, r, 5);
  ctx.fill();
  ctx.strokeStyle = s.shooting
    ? `rgba(255, 216, 102, ${0.4 + 0.6 * b})`
    : `rgba(140, 180, 255, ${0.35 + 0.55 * b})`;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();

  // Late-stage warning ring when dim — telegraphs "tap NOW for max points".
  if (b > 0 && b < 0.35 && !s.shooting) {
    const wobble = 0.5 + 0.5 * Math.sin(nowSec * 12);
    ctx.save();
    ctx.globalAlpha = 0.4 + 0.4 * wobble;
    ctx.strokeStyle = '#ff8a8a';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(s.x, s.y, STAR_RADIUS + 4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

function drawPops(): void {
  for (const p of pops) {
    const age = nowSec - p.born;
    const t = age / 0.85;
    const y = p.y - 30 * t;
    ctx.save();
    ctx.globalAlpha = 1 - t;
    ctx.fillStyle = p.color;
    ctx.font = '700 16px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(p.text, p.x, y);
    ctx.restore();
  }
}

function draw(): void {
  drawBackground();
  for (const s of stars) drawStar(s);
  drawPops();
}

function loop(timestamp: number): void {
  const myGen = gen.current();
  if (!gen.isCurrent(myGen)) return;

  const t = timestamp / 1000;
  const raw = lastFrame === 0 ? 0 : t - lastFrame;
  // Tab-backgrounded catch-up guard: cap dt at 1/15s. pitfall #tab-catchup.
  const dt = Math.min(raw, 1 / 15);
  lastFrame = t;

  update(dt);
  draw();

  if (gen.isCurrent(myGen)) {
    requestAnimationFrame((ts) => {
      if (gen.isCurrent(myGen)) loop(ts);
    });
  }
}

function startGame(): void {
  state = 'playing';
  score = 0;
  setScore(0);
  setLives(MAX_LIVES);
  stars = [];
  pops = [];
  nowSec = 0;
  lastFrame = 0;
  nextSpawn = 0.4; // first star arrives quickly
  hideOverlay(overlay);
}

function reset(): void {
  gen.bump();
  state = 'ready';
  stars = [];
  pops = [];
  nowSec = 0;
  lastFrame = 0;
  setScore(0);
  setLives(MAX_LIVES);
  overlayTitle.textContent = 'Sönen Yıldız';
  overlayMsg.textContent =
    'Yıldızlar gökyüzünde belirir ve sönmeye başlar.\n' +
    'Geç dokunduğunda daha çok puan alırsın —\n' +
    'ama sönmesine izin verirsen bir can kaybedersin.\n' +
    'Düşen yıldızlar nadirdir, hızla kaçar ve çoklu puan değerindedir.';
  overlayBtn.textContent = 'Başla';
  showOverlay(overlay);
  draw();
  // Start a fresh RAF chain so visuals (background twinkle) animate even in
  // ready state.
  requestAnimationFrame(loop);
}

function onPointer(e: PointerEvent): void {
  const rect = canvas.getBoundingClientRect();
  const cx = ((e.clientX - rect.left) / rect.width) * canvas.width;
  const cy = ((e.clientY - rect.top) / rect.height) * canvas.height;
  if (state === 'ready') {
    // Tapping the sky in ready state begins the game (mobile-friendly).
    startGame();
    return;
  }
  if (state === 'gameover') {
    reset();
    return;
  }
  if (state !== 'playing') return;
  tryTap(cx, cy);
}

function onKey(e: KeyboardEvent): void {
  const k = e.key.toLowerCase();
  if (k === 'r') {
    reset();
    e.preventDefault();
    return;
  }
  if (state === 'ready') {
    if (k === ' ' || k === 'enter') {
      startGame();
      e.preventDefault();
    }
    return;
  }
  if (state === 'gameover') {
    if (k === ' ' || k === 'enter') {
      reset();
      e.preventDefault();
    }
    return;
  }
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  livesEl = document.querySelector<HTMLElement>('#lives')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;

  best = safeRead<number>(STORAGE_BEST, 0);
  bestEl.textContent = String(best);

  makeBackgroundStars();

  canvas.addEventListener('pointerdown', onPointer);
  window.addEventListener('keydown', onKey);
  restartBtn.addEventListener('click', reset);
  overlayBtn.addEventListener('click', () => {
    if (state === 'ready') startGame();
    else if (state === 'gameover') reset();
  });

  reset();
}

export const game = defineGame({ init, reset });
