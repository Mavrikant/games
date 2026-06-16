// ---------------------------------------------------------------------------
// Mantar — risk/reward forager. Mushrooms cycle through sprout → immature →
// ripe → super-ripe → rotten over ~4 seconds. Clicking at the peak (super-ripe)
// pays the most; letting one rot bursts spores that spawn two new sprouts at
// random nearby positions. Score over 60s.
//
// State machine: ready | playing | gameover (PITFALLS#overlay-input-leak)
// PITFALLS guarded:
//   - unguarded-storage: safeRead / safeWrite
//   - module-level-dom-access: all DOM / storage / listeners inside init()
//   - stale-async-callback: gen-token bumps cancel deferred work on reset
//   - cap-counts-dead-entities: spawn cap counts only alive shrooms; bursts
//     mark the parent dead before children are pushed
//   - designed-lose-condition-not-wired: rotten shrooms have explicit burst
//     behaviour rather than silent removal
//   - visual-vs-hitbox: shroom radius derived from a single stageRadius()
//     used by both draw() and the click hit test
//   - invisible-boot: first ready frame draws floor + ambience before play;
//     startGame() seeds the first cohort within 200ms of pressing start
//   - missing-overlay-css: mantar.css ships .overlay + .overlay--hidden
// ---------------------------------------------------------------------------

import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import {
  showOverlay as showOverlayEl,
  hideOverlay as hideOverlayEl,
} from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';
import { reportGameOver } from '@shared/leaderboard';

type State = 'ready' | 'playing' | 'gameover';
type Stage = 'sprout' | 'immature' | 'ripe' | 'peak' | 'rotten';

interface Shroom {
  x: number;
  y: number;
  birth: number;
  hue: number;
  wobble: number;
  alive: boolean;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  color: string;
  size: number;
}

interface FloatText {
  x: number;
  y: number;
  text: string;
  life: number;
  color: string;
}

// ── Constants ──
const W = 640;
const H = 480;
const ROUND_SECONDS = 60;

const SPROUT_END = 0.8;
const IMMATURE_END = 1.8;
const RIPE_END = 2.8;
const PEAK_END = 3.5;
const ROT_END = 4.4;

const RADIUS_BASE = 4;
const RADIUS_RIPE = 18;
const RADIUS_PEAK = 22;

const SCORE_SPROUT = 1;
const SCORE_IMMATURE = 3;
const SCORE_RIPE = 6;
const SCORE_PEAK = 10;

const MAX_ACTIVE = 28;
const BURST_CHILDREN = 2;
const BURST_RADIUS = 60;

const SPAWN_START = 1.0;
const SPAWN_FLOOR = 0.55;
const SPAWN_DECAY = 22;

const HIT_PAD = 6;
const EDGE_MARGIN = 32;

const STORAGE_KEY = 'mantar.best';
const SCORE_DESC = {
  gameId: 'mantar',
  storageKey: STORAGE_KEY,
  direction: 'higher' as const,
};

// ── DOM refs ──
let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let timeEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayBtn!: HTMLButtonElement;

// ── State ──
let state: State = 'ready';
let shrooms: Shroom[] = [];
let particles: Particle[] = [];
let floats: FloatText[] = [];

let score = 0;
let best = 0;
let elapsed = 0;
let remaining = ROUND_SECONDS;
let spawnTimer = 0;

let rafId = 0;
let lastTime = 0;
const gen = createGenToken();

// ── Helpers ──
function age(s: Shroom, now: number): number {
  return now - s.birth;
}

function stageOf(s: Shroom, now: number): Stage {
  const a = age(s, now);
  if (a < SPROUT_END) return 'sprout';
  if (a < IMMATURE_END) return 'immature';
  if (a < RIPE_END) return 'ripe';
  if (a < PEAK_END) return 'peak';
  return 'rotten';
}

function stageRadius(s: Shroom, now: number): number {
  const a = age(s, now);
  if (a < SPROUT_END) {
    return RADIUS_BASE + (a / SPROUT_END) * 4;
  }
  if (a < IMMATURE_END) {
    return 8 + ((a - SPROUT_END) / (IMMATURE_END - SPROUT_END)) * 6;
  }
  if (a < RIPE_END) {
    return 14 + ((a - IMMATURE_END) / (RIPE_END - IMMATURE_END)) * (RADIUS_RIPE - 14);
  }
  if (a < PEAK_END) {
    return RADIUS_RIPE + ((a - RIPE_END) / (PEAK_END - RIPE_END)) * (RADIUS_PEAK - RADIUS_RIPE);
  }
  const r = (a - PEAK_END) / (ROT_END - PEAK_END);
  return RADIUS_PEAK - r * 4;
}

function scoreFor(stage: Stage): number {
  switch (stage) {
    case 'sprout': return SCORE_SPROUT;
    case 'immature': return SCORE_IMMATURE;
    case 'ripe': return SCORE_RIPE;
    case 'peak': return SCORE_PEAK;
    case 'rotten': return 0;
  }
}

function activeCount(): number {
  let n = 0;
  for (const s of shrooms) if (s.alive) n++;
  return n;
}

function currentSpawnInterval(): number {
  const f = Math.exp(-elapsed / SPAWN_DECAY);
  return Math.max(SPAWN_FLOOR, SPAWN_START * f);
}

function pickSpawnPos(near?: { x: number; y: number }): { x: number; y: number } {
  for (let i = 0; i < 8; i++) {
    let x: number;
    let y: number;
    if (near) {
      const angle = Math.random() * Math.PI * 2;
      const dist = 22 + Math.random() * BURST_RADIUS;
      x = near.x + Math.cos(angle) * dist;
      y = near.y + Math.sin(angle) * dist;
    } else {
      x = EDGE_MARGIN + Math.random() * (W - EDGE_MARGIN * 2);
      y = EDGE_MARGIN + Math.random() * (H - EDGE_MARGIN * 2);
    }
    if (x < EDGE_MARGIN || x > W - EDGE_MARGIN) continue;
    if (y < EDGE_MARGIN || y > H - EDGE_MARGIN) continue;
    let clear = true;
    for (const s of shrooms) {
      if (!s.alive) continue;
      const dx = s.x - x;
      const dy = s.y - y;
      if (dx * dx + dy * dy < 36 * 36) {
        clear = false;
        break;
      }
    }
    if (clear) return { x, y };
  }
  return {
    x: EDGE_MARGIN + Math.random() * (W - EDGE_MARGIN * 2),
    y: EDGE_MARGIN + Math.random() * (H - EDGE_MARGIN * 2),
  };
}

function spawnShroom(near?: { x: number; y: number }): void {
  if (activeCount() >= MAX_ACTIVE) return;
  const pos = pickSpawnPos(near);
  const hueRoll = Math.random();
  const hue = hueRoll < 0.55
    ? 354 + Math.random() * 8
    : hueRoll < 0.85
      ? 22 + Math.random() * 10
      : 48 + Math.random() * 8;
  shrooms.push({
    x: pos.x,
    y: pos.y,
    birth: elapsed,
    hue,
    wobble: Math.random() * Math.PI * 2,
    alive: true,
  });
}

function emitParticles(x: number, y: number, color: string, n: number, speed: number): void {
  for (let i = 0; i < n; i++) {
    const angle = Math.random() * Math.PI * 2;
    const v = speed * (0.5 + Math.random() * 0.9);
    particles.push({
      x,
      y,
      vx: Math.cos(angle) * v,
      vy: Math.sin(angle) * v - speed * 0.3,
      life: 0,
      maxLife: 0.45 + Math.random() * 0.45,
      color,
      size: 1.5 + Math.random() * 2.5,
    });
  }
}

function floatText(x: number, y: number, text: string, color: string): void {
  floats.push({ x, y, text, life: 0.95, color });
}

function commitBest(): void {
  if (score > best) {
    best = score;
    safeWrite(STORAGE_KEY, best);
    bestEl.textContent = String(best);
  }
}

function updateHud(): void {
  scoreEl.textContent = String(score);
  timeEl.textContent = String(Math.max(0, Math.ceil(remaining)));
  bestEl.textContent = String(best);
}

function harvest(s: Shroom, stage: Stage): void {
  const pts = scoreFor(stage);
  score += pts;
  commitBest();
  updateHud();
  const isPeak = stage === 'peak';
  floatText(
    s.x,
    s.y - stageRadius(s, elapsed) - 6,
    `+${pts}`,
    isPeak ? '#fde047' : '#f8fafc',
  );
  const popColor = `hsl(${s.hue} 78% 60%)`;
  emitParticles(s.x, s.y, popColor, isPeak ? 18 : 10, isPeak ? 160 : 110);
  s.alive = false;
}

function burst(s: Shroom): void {
  emitParticles(s.x, s.y, 'rgba(180,200,140,0.85)', 22, 90);
  floatText(s.x, s.y - 18, 'spor!', '#86efac');
  s.alive = false;
  for (let i = 0; i < BURST_CHILDREN; i++) {
    spawnShroom({ x: s.x, y: s.y });
  }
}

// ── Update ──
function update(dt: number): void {
  if (state !== 'playing') return;

  elapsed += dt;
  remaining -= dt;
  if (remaining <= 0) {
    remaining = 0;
    updateHud();
    endGame();
    return;
  }

  spawnTimer -= dt;
  if (spawnTimer <= 0) {
    spawnShroom();
    spawnTimer = currentSpawnInterval();
  }

  for (const s of shrooms) {
    if (!s.alive) continue;
    s.wobble += dt * 2.4;
    if (age(s, elapsed) >= ROT_END) {
      burst(s);
    }
  }
  if (shrooms.length > 80) {
    shrooms = shrooms.filter((s) => s.alive);
  }

  for (const p of particles) {
    p.life += dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vy += 160 * dt;
    p.vx *= 1 - 1.2 * dt;
  }
  particles = particles.filter((p) => p.life < p.maxLife);

  for (const f of floats) {
    f.life -= dt;
    f.y -= 24 * dt;
  }
  floats = floats.filter((f) => f.life > 0);

  updateHud();
}

// ── Draw ──
function drawFloor(): void {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#15281a');
  g.addColorStop(1, '#0a1610');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = 'rgba(74, 124, 89, 0.10)';
  let seed = 1337;
  for (let i = 0; i < 80; i++) {
    seed = (seed * 9301 + 49297) % 233280;
    const sx = (seed / 233280) * W;
    seed = (seed * 9301 + 49297) % 233280;
    const sy = (seed / 233280) * H;
    seed = (seed * 9301 + 49297) % 233280;
    const sr = 14 + (seed / 233280) * 28;
    ctx.beginPath();
    ctx.arc(sx, sy, sr, 0, Math.PI * 2);
    ctx.fill();
  }

  const v = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 0.75);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, 'rgba(0,0,0,0.42)');
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, W, H);
}

function drawShroom(s: Shroom): void {
  const r = stageRadius(s, elapsed);
  const stage = stageOf(s, elapsed);
  const sway = Math.sin(s.wobble) * 0.6;

  const stemH = r * 1.3;
  const stemW = Math.max(4, r * 0.55);
  ctx.fillStyle = '#f1e5c8';
  ctx.beginPath();
  ctx.ellipse(s.x + sway, s.y + r * 0.55, stemW / 2, stemH / 2, 0, 0, Math.PI * 2);
  ctx.fill();

  let capColor: string;
  let capHighlight: string;
  let dotColor = 'rgba(255,255,255,0.92)';
  if (stage === 'sprout') {
    capColor = `hsl(${s.hue} 30% 55%)`;
    capHighlight = `hsl(${s.hue} 40% 65%)`;
  } else if (stage === 'immature') {
    capColor = `hsl(${s.hue} 55% 50%)`;
    capHighlight = `hsl(${s.hue} 60% 62%)`;
  } else if (stage === 'ripe') {
    capColor = `hsl(${s.hue} 75% 50%)`;
    capHighlight = `hsl(${s.hue} 78% 64%)`;
  } else if (stage === 'peak') {
    capColor = `hsl(${s.hue} 85% 52%)`;
    capHighlight = `hsl(${s.hue} 90% 70%)`;
  } else {
    capColor = '#6b6655';
    capHighlight = '#8b8674';
    dotColor = 'rgba(180,180,170,0.65)';
  }

  if (stage === 'peak') {
    const halo = ctx.createRadialGradient(s.x, s.y, r * 0.9, s.x, s.y, r * 2.1);
    halo.addColorStop(0, 'rgba(253, 224, 71, 0.55)');
    halo.addColorStop(1, 'rgba(253, 224, 71, 0)');
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(s.x, s.y, r * 2.1, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.fillStyle = capColor;
  ctx.beginPath();
  ctx.ellipse(s.x + sway, s.y, r, r * 0.78, 0, Math.PI, 0);
  ctx.fill();

  ctx.fillStyle = capHighlight;
  ctx.beginPath();
  ctx.ellipse(s.x + sway - r * 0.25, s.y - r * 0.18, r * 0.55, r * 0.32, 0, Math.PI, 0);
  ctx.fill();

  if (stage !== 'sprout') {
    ctx.fillStyle = dotColor;
    const dots = stage === 'peak' || stage === 'ripe' ? 5 : 3;
    let seed = Math.floor(s.x * 17 + s.y * 31) || 1;
    for (let i = 0; i < dots; i++) {
      seed = (seed * 9301 + 49297) % 233280;
      const dx = ((seed / 233280) - 0.5) * r * 1.3;
      seed = (seed * 9301 + 49297) % 233280;
      const dy = -((seed / 233280)) * r * 0.55;
      const dr = stage === 'peak' ? 2.2 : 1.8;
      ctx.beginPath();
      ctx.arc(s.x + sway + dx, s.y + dy, dr, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  if (stage === 'rotten') {
    const phase = (elapsed * 6) % (Math.PI * 2);
    ctx.strokeStyle = `rgba(190, 80, 80, ${0.5 + 0.4 * Math.sin(phase)})`;
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.ellipse(s.x + sway, s.y, r + 4, r * 0.78 + 3, 0, Math.PI, 0);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

function drawParticles(): void {
  for (const p of particles) {
    const a = 1 - p.life / p.maxLife;
    ctx.fillStyle = p.color;
    ctx.globalAlpha = a;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}

function drawFloats(): void {
  ctx.font = 'bold 18px system-ui, sans-serif';
  ctx.textAlign = 'center';
  for (const f of floats) {
    const a = Math.min(1, f.life / 0.6);
    ctx.globalAlpha = a;
    ctx.fillStyle = f.color;
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.lineWidth = 3;
    ctx.strokeText(f.text, f.x, f.y);
    ctx.fillText(f.text, f.x, f.y);
    ctx.globalAlpha = 1;
  }
  ctx.textAlign = 'start';
}

function draw(): void {
  drawFloor();
  const order = shrooms.filter((s) => s.alive).sort((a, b) => a.y - b.y);
  for (const s of order) drawShroom(s);
  drawParticles();
  drawFloats();
}

// ── Loop ──
function loop(now: number, token: number): void {
  if (token !== gen.current()) return;
  if (state !== 'playing') return;
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;
  update(dt);
  draw();
  rafId = requestAnimationFrame((t) => loop(t, token));
}

// ── Flow ──
function fullReset(): void {
  cancelAnimationFrame(rafId);
  gen.bump();
  shrooms = [];
  particles = [];
  floats = [];
  score = 0;
  elapsed = 0;
  remaining = ROUND_SECONDS;
  spawnTimer = 0;
  updateHud();
}

function startGame(): void {
  fullReset();
  state = 'playing';
  hideOverlayEl(overlay);
  spawnShroom();
  spawnShroom();
  spawnShroom();
  spawnTimer = currentSpawnInterval();
  lastTime = performance.now();
  draw();
  const token = gen.current();
  rafId = requestAnimationFrame((t) => loop(t, token));
}

function endGame(): void {
  state = 'gameover';
  cancelAnimationFrame(rafId);
  gen.bump();
  draw();
  const isBest = score > 0 && score >= best;
  overlayTitle.textContent = isBest ? 'Yeni rekor!' : 'Süre doldu';
  overlayMsg.innerHTML =
    `Skor: <strong>${score}</strong><br>En iyi: ${best}` +
    '<br><small>R, Boşluk veya Enter ile tekrar dene</small>';
  overlayBtn.textContent = 'Tekrar oyna';
  showOverlayEl(overlay);
  reportGameOver(SCORE_DESC, score, { label: 'Skor' });
  overlayBtn.focus({ preventScroll: true });
}

function resetToReady(): void {
  fullReset();
  state = 'ready';
  overlayTitle.textContent = 'Mantar';
  overlayMsg.innerHTML =
    'Mantarlar büyür ve ~4 saniye içinde çürür. Olgun (kırmızı) anında topla; ' +
    'altın halkalı tepe puanı 10. Çürümeye bırakırsan iki yeni mantar saçar — ' +
    'kalabalığı dengele.<br><small>60 saniyede en yüksek skor</small>';
  overlayBtn.textContent = 'Başla';
  showOverlayEl(overlay);
  draw();
}

// ── Input ──
function canvasToWorld(clientX: number, clientY: number): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0) return { x: 0, y: 0 };
  const sx = W / rect.width;
  const sy = H / rect.height;
  return {
    x: (clientX - rect.left) * sx,
    y: (clientY - rect.top) * sy,
  };
}

function clickAt(wx: number, wy: number): void {
  if (state !== 'playing') return;
  let target: Shroom | null = null;
  for (const s of shrooms) {
    if (!s.alive) continue;
    const r = stageRadius(s, elapsed) + HIT_PAD;
    const cx = s.x;
    const cy = s.y - r * 0.05;
    const dx = wx - cx;
    const dy = wy - cy;
    const rx = r;
    const ry = r * 0.85;
    const inside = (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) <= 1;
    if (inside) {
      if (target === null || s.y > target.y) target = s;
    }
  }
  if (target) {
    const stage = stageOf(target, elapsed);
    if (stage === 'rotten') {
      emitParticles(target.x, target.y, 'rgba(160,160,140,0.7)', 6, 60);
      return;
    }
    harvest(target, stage);
  }
}

function onPointer(e: PointerEvent): void {
  if (state !== 'playing') return;
  e.preventDefault();
  const p = canvasToWorld(e.clientX, e.clientY);
  clickAt(p.x, p.y);
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
  }
}

// ── Init ──
function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  timeEl = document.querySelector<HTMLElement>('#time')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;

  best = safeRead<number>(STORAGE_KEY, 0);
  if (!Number.isFinite(best) || best < 0) best = 0;

  canvas.addEventListener('pointerdown', onPointer);
  window.addEventListener('keydown', onKeyDown);
  restartBtn.addEventListener('click', () => startGame());
  overlayBtn.addEventListener('click', () => startGame());

  resetToReady();
}

export const game = defineGame({ init, reset: resetToReady });
