// ---------------------------------------------------------------------------
// Cemre — Anatolian folklore: three warm "cemreler" fall from the sky in the
// last weeks of winter, one for air, one for water, one for earth. Catch each
// in its matching basin. Twist: routing is a two-step commit (tap cemre to
// select → tap basin to send), so the player has to judge category early
// enough to act before ground impact.
//
// State machine: ready | playing | gameover  (PITFALLS#overlay-input-leak)
// PITFALLS guarded:
//   - unguarded-storage: safeRead / safeWrite via @shared/storage
//   - module-level-dom-access: all DOM / listeners inside init()
//   - stale-async-callback: gen-token bumps cancel the RAF loop on reset
//   - missing-overlay-css: cemre.css ships .overlay + .overlay--hidden
//   - visual-vs-hitbox: single CEMRE_RADIUS used by draw() and click test
//   - invisible-boot: ready overlay drawn immediately; first cemre lands in
//     <1.2s after Başla
//   - designed-lose-condition-not-wired: cemres that reach the ground without
//     being routed apply an explicit penalty; black cemres are scored on
//     intent (routing them anywhere = penalty), not silently dropped
// ---------------------------------------------------------------------------

import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import {
  showOverlay as showOverlayEl,
  hideOverlay as hideOverlayEl,
} from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';

type State = 'ready' | 'playing' | 'gameover';
type Kind = 'hava' | 'su' | 'toprak' | 'kara' | 'altin';
type Basin = 'hava' | 'su' | 'toprak';

interface Cemre {
  id: number;
  kind: Kind;
  x: number;
  y: number;
  vy: number;
  birth: number;
  selected: boolean;
  alive: boolean;
  routing: Basin | null;
  routeProgress: number;
  routeFrom: { x: number; y: number };
  routeTo: { x: number; y: number };
  routeResult: 'ok' | 'bad' | null;
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
const BASIN_TOP = 380;
const BASIN_H = H - BASIN_TOP;
const BASIN_W = W / 3;
const ROUND_SECONDS = 60;

const CEMRE_RADIUS = 18;
const HIT_PAD = 6;
const EDGE_MARGIN = 38;

const FALL_SPEED_START = 70;
const FALL_SPEED_END = 165;
const FALL_JITTER = 18;

const SPAWN_START = 1.5;
const SPAWN_END = 0.55;

const SCORE_MATCH = 10;
const SCORE_MISMATCH = -5;
const SCORE_MISSED = -3;
const SCORE_KARA_ROUTED = -8;
const SCORE_ALTIN = 25;

const METER_WIN = 60;
const METER_MAX = 120;

const STORAGE_KEY = 'cemre.best';

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
let cemres: Cemre[] = [];
let particles: Particle[] = [];
let floats: FloatText[] = [];
let nextId = 1;

let score = 0;
let best = 0;
let elapsed = 0;
let remaining = ROUND_SECONDS;
let spawnTimer = 0;
let meters = { hava: 0, su: 0, toprak: 0 };
let selectedId: number | null = null;

let rafId = 0;
let lastTime = 0;
const gen = createGenToken();

// ── Helpers ──
function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function currentSpawnInterval(): number {
  const t = Math.min(1, elapsed / ROUND_SECONDS);
  return lerp(SPAWN_START, SPAWN_END, t);
}

function currentFallSpeed(): number {
  const t = Math.min(1, elapsed / ROUND_SECONDS);
  return lerp(FALL_SPEED_START, FALL_SPEED_END, t);
}

function pickKind(): Kind {
  const r = Math.random();
  if (r < 0.30) return 'hava';
  if (r < 0.60) return 'su';
  if (r < 0.86) return 'toprak';
  if (r < 0.96) return 'kara';
  return 'altin';
}

function basinForX(x: number): Basin {
  if (x < BASIN_W) return 'hava';
  if (x < BASIN_W * 2) return 'su';
  return 'toprak';
}

function basinCenter(b: Basin): { x: number; y: number } {
  const ix = b === 'hava' ? 0 : b === 'su' ? 1 : 2;
  return { x: BASIN_W * (ix + 0.5), y: BASIN_TOP + BASIN_H * 0.55 };
}

function kindColor(k: Kind): string {
  switch (k) {
    case 'hava': return '#7dd3fc';
    case 'su': return '#22d3ee';
    case 'toprak': return '#fbbf24';
    case 'kara': return '#475569';
    case 'altin': return '#facc15';
  }
}

function kindGlow(k: Kind): string {
  switch (k) {
    case 'hava': return 'rgba(125, 211, 252, 0.45)';
    case 'su': return 'rgba(34, 211, 238, 0.45)';
    case 'toprak': return 'rgba(251, 191, 36, 0.45)';
    case 'kara': return 'rgba(71, 85, 105, 0.55)';
    case 'altin': return 'rgba(250, 204, 21, 0.70)';
  }
}

function basinAccent(b: Basin): string {
  switch (b) {
    case 'hava': return '#7dd3fc';
    case 'su': return '#22d3ee';
    case 'toprak': return '#fbbf24';
  }
}

function basinLabel(b: Basin): string {
  switch (b) {
    case 'hava': return 'HAVA';
    case 'su': return 'SU';
    case 'toprak': return 'TOPRAK';
  }
}

function findCemre(id: number | null): Cemre | null {
  if (id === null) return null;
  for (const c of cemres) if (c.id === id && c.alive) return c;
  return null;
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
}

function floatText(x: number, y: number, text: string, color: string): void {
  floats.push({ x, y, text, life: 1.0, color });
}

function emitParticles(x: number, y: number, color: string, n: number, speed: number): void {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const v = speed * (0.5 + Math.random() * 0.9);
    particles.push({
      x, y,
      vx: Math.cos(a) * v,
      vy: Math.sin(a) * v - speed * 0.2,
      life: 0,
      maxLife: 0.5 + Math.random() * 0.4,
      color,
      size: 1.6 + Math.random() * 2.4,
    });
  }
}

function spawnCemre(): void {
  const kind = pickKind();
  const x = EDGE_MARGIN + Math.random() * (W - EDGE_MARGIN * 2);
  const speed = currentFallSpeed() + rand(-FALL_JITTER, FALL_JITTER);
  cemres.push({
    id: nextId++,
    kind,
    x,
    y: -CEMRE_RADIUS - 4,
    vy: speed,
    birth: elapsed,
    selected: false,
    alive: true,
    routing: null,
    routeProgress: 0,
    routeFrom: { x: 0, y: 0 },
    routeTo: { x: 0, y: 0 },
    routeResult: null,
  });
}

function applyScore(delta: number): void {
  score = Math.max(0, score + delta);
  updateHud();
  commitBest();
}

function meterAdd(b: Basin, delta: number): void {
  meters[b] = Math.max(0, Math.min(METER_MAX, meters[b] + delta));
}

function startRoute(c: Cemre, target: Basin): void {
  const correct = c.kind === target || c.kind === 'altin';
  const isKara = c.kind === 'kara';
  c.routing = target;
  c.routeProgress = 0;
  c.routeFrom = { x: c.x, y: c.y };
  c.routeTo = basinCenter(target);
  c.routeResult = isKara ? 'bad' : correct ? 'ok' : 'bad';
  c.selected = false;
  if (selectedId === c.id) selectedId = null;

  if (isKara) {
    applyScore(SCORE_KARA_ROUTED);
    floatText(c.x, c.y - 22, '−8', '#f87171');
    emitParticles(c.x, c.y, '#94a3b8', 10, 110);
    return;
  }
  if (c.kind === 'altin') {
    applyScore(SCORE_ALTIN);
    meterAdd(target, 18);
    floatText(c.x, c.y - 22, '+25', '#fde68a');
    emitParticles(c.x, c.y, '#facc15', 22, 160);
    return;
  }
  if (correct) {
    applyScore(SCORE_MATCH);
    meterAdd(target, 12);
    floatText(c.x, c.y - 22, '+10', '#86efac');
    emitParticles(c.x, c.y, kindColor(c.kind), 14, 130);
  } else {
    applyScore(SCORE_MISMATCH);
    meterAdd(target, -8);
    floatText(c.x, c.y - 22, '−5', '#f87171');
    emitParticles(c.x, c.y, '#fb7185', 10, 110);
  }
}

function dropCemreAtGround(c: Cemre): void {
  c.alive = false;
  if (c.kind === 'kara') {
    // Ignoring a kara cemre is fine — silent.
    return;
  }
  if (c.kind === 'altin') {
    applyScore(-2);
    floatText(c.x, BASIN_TOP - 6, '−2', '#fda4af');
    emitParticles(c.x, BASIN_TOP - 4, '#facc15', 8, 90);
    return;
  }
  applyScore(SCORE_MISSED);
  meterAdd(c.kind, -4);
  floatText(c.x, BASIN_TOP - 6, '−3', '#fda4af');
  emitParticles(c.x, BASIN_TOP - 4, '#94a3b8', 6, 80);
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
    spawnCemre();
    spawnTimer = currentSpawnInterval();
  }

  for (const c of cemres) {
    if (!c.alive) continue;
    if (c.routing) {
      c.routeProgress += dt * 2.4;
      const t = Math.min(1, c.routeProgress);
      const cx = (c.routeFrom.x + c.routeTo.x) / 2;
      const cy = Math.min(c.routeFrom.y, c.routeTo.y) - 70;
      const mx = lerp(lerp(c.routeFrom.x, cx, t), lerp(cx, c.routeTo.x, t), t);
      const my = lerp(lerp(c.routeFrom.y, cy, t), lerp(cy, c.routeTo.y, t), t);
      c.x = mx;
      c.y = my;
      if (t >= 1) c.alive = false;
      continue;
    }
    c.y += c.vy * dt;
    if (c.y >= BASIN_TOP - CEMRE_RADIUS * 0.6) {
      dropCemreAtGround(c);
    }
  }

  if (cemres.length > 60) {
    cemres = cemres.filter((c) => c.alive);
  }

  for (const p of particles) {
    p.life += dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vy += 200 * dt;
    p.vx *= 1 - 1.5 * dt;
  }
  particles = particles.filter((p) => p.life < p.maxLife);

  for (const f of floats) {
    f.life -= dt;
    f.y -= 28 * dt;
  }
  floats = floats.filter((f) => f.life > 0);
}

// ── Draw ──
function drawSky(): void {
  const t = Math.min(1, elapsed / ROUND_SECONDS);
  const top = `hsl(${220 - t * 20}, 50%, ${10 + t * 6}%)`;
  const mid = `hsl(${215 - t * 15}, 55%, ${18 + t * 14}%)`;
  const g = ctx.createLinearGradient(0, 0, 0, BASIN_TOP);
  g.addColorStop(0, top);
  g.addColorStop(1, mid);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, BASIN_TOP);

  const mx = W * 0.83 + Math.sin(elapsed * 0.1) * 6;
  const my = 64;
  const mg = ctx.createRadialGradient(mx, my, 6, mx, my, 60);
  mg.addColorStop(0, 'rgba(255, 244, 200, 0.85)');
  mg.addColorStop(1, 'rgba(255, 244, 200, 0)');
  ctx.fillStyle = mg;
  ctx.beginPath();
  ctx.arc(mx, my, 60, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#fef3c7';
  ctx.beginPath();
  ctx.arc(mx, my, 16, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = 'rgba(255,255,255,0.65)';
  let seed = 7777;
  for (let i = 0; i < 38; i++) {
    seed = (seed * 9301 + 49297) % 233280;
    const sx = (seed / 233280) * W;
    seed = (seed * 9301 + 49297) % 233280;
    const sy = (seed / 233280) * (BASIN_TOP - 30);
    seed = (seed * 9301 + 49297) % 233280;
    const sr = 0.6 + (seed / 233280) * 1.4;
    ctx.beginPath();
    ctx.arc(sx, sy, sr, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawBasins(): void {
  const labels: Basin[] = ['hava', 'su', 'toprak'];
  for (let i = 0; i < 3; i++) {
    const b = labels[i]!;
    const x = BASIN_W * i;
    const accent = basinAccent(b);
    const g = ctx.createLinearGradient(0, BASIN_TOP, 0, H);
    g.addColorStop(0, 'rgba(15, 23, 42, 0.65)');
    g.addColorStop(1, 'rgba(15, 23, 42, 0.95)');
    ctx.fillStyle = g;
    ctx.fillRect(x, BASIN_TOP, BASIN_W, BASIN_H);

    const ratio = meters[b] / METER_MAX;
    const fillW = BASIN_W * ratio;
    const fg = ctx.createLinearGradient(x, BASIN_TOP, x + BASIN_W, H);
    fg.addColorStop(0, `${accent}33`);
    fg.addColorStop(1, `${accent}77`);
    ctx.fillStyle = fg;
    ctx.fillRect(x + 1, BASIN_TOP + 2, Math.max(0, fillW - 2), BASIN_H - 4);

    const winX = x + BASIN_W * (METER_WIN / METER_MAX);
    ctx.strokeStyle = `${accent}aa`;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(winX, BASIN_TOP + 6);
    ctx.lineTo(winX, H - 6);
    ctx.stroke();
    ctx.setLineDash([]);

    if (i > 0) {
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, BASIN_TOP);
      ctx.lineTo(x, H);
      ctx.stroke();
    }

    ctx.fillStyle = accent;
    ctx.font = 'bold 14px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(basinLabel(b), x + BASIN_W / 2, BASIN_TOP + 22);

    ctx.fillStyle = 'rgba(226, 232, 240, 0.9)';
    ctx.font = 'bold 22px system-ui, sans-serif';
    ctx.fillText(String(Math.round(meters[b])), x + BASIN_W / 2, BASIN_TOP + 54);

    drawSymbol(b, x + BASIN_W / 2, BASIN_TOP + 82, 16, accent);
  }
  ctx.textAlign = 'start';
}

function drawSymbol(k: Kind, x: number, y: number, size: number, color: string): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = Math.max(2, size * 0.18);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (k === 'hava') {
    ctx.beginPath();
    ctx.arc(-size * 0.45, size * 0.08, size * 0.42, 0, Math.PI * 2);
    ctx.arc(0, -size * 0.18, size * 0.52, 0, Math.PI * 2);
    ctx.arc(size * 0.5, size * 0.05, size * 0.40, 0, Math.PI * 2);
    ctx.fill();
  } else if (k === 'su') {
    const w = size * 1.4;
    ctx.beginPath();
    ctx.moveTo(-w / 2, 0);
    ctx.bezierCurveTo(-w / 4, -size * 0.6, w / 4, size * 0.6, w / 2, 0);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-w / 2, size * 0.55);
    ctx.bezierCurveTo(-w / 4, -size * 0.1, w / 4, size * 1.2, w / 2, size * 0.55);
    ctx.stroke();
  } else if (k === 'toprak') {
    ctx.beginPath();
    ctx.moveTo(0, size * 0.7);
    ctx.lineTo(0, -size * 0.2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(-size * 0.75, -size * 0.45, -size * 0.95, size * 0.10);
    ctx.quadraticCurveTo(-size * 0.45, -size * 0.18, 0, 0);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(0, -size * 0.35);
    ctx.quadraticCurveTo(size * 0.75, -size * 0.55, size * 0.95, -size * 0.05);
    ctx.quadraticCurveTo(size * 0.45, -size * 0.30, 0, -size * 0.20);
    ctx.fill();
  } else if (k === 'kara') {
    const a = size * 0.55;
    ctx.beginPath();
    ctx.moveTo(-a, -a);
    ctx.lineTo(a, a);
    ctx.moveTo(a, -a);
    ctx.lineTo(-a, a);
    ctx.stroke();
  } else if (k === 'altin') {
    const r1 = size * 0.75;
    const r2 = size * 0.32;
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const r = i % 2 === 0 ? r1 : r2;
      const a = (i * Math.PI) / 5 - Math.PI / 2;
      const px = Math.cos(a) * r;
      const py = Math.sin(a) * r;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function drawCemre(c: Cemre): void {
  const glow = kindGlow(c.kind);
  const base = kindColor(c.kind);

  if (c.selected) {
    const pulse = 0.5 + 0.5 * Math.sin(elapsed * 8);
    const r = CEMRE_RADIUS + 10 + pulse * 4;
    const ring = ctx.createRadialGradient(c.x, c.y, CEMRE_RADIUS, c.x, c.y, r);
    ring.addColorStop(0, 'rgba(253, 224, 71, 0.55)');
    ring.addColorStop(1, 'rgba(253, 224, 71, 0)');
    ctx.fillStyle = ring;
    ctx.beginPath();
    ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
    ctx.fill();
  } else {
    const r = CEMRE_RADIUS + 14;
    const aura = ctx.createRadialGradient(c.x, c.y, CEMRE_RADIUS * 0.6, c.x, c.y, r);
    aura.addColorStop(0, glow);
    aura.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = aura;
    ctx.beginPath();
    ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  const orb = ctx.createRadialGradient(
    c.x - CEMRE_RADIUS * 0.35,
    c.y - CEMRE_RADIUS * 0.4,
    CEMRE_RADIUS * 0.2,
    c.x,
    c.y,
    CEMRE_RADIUS,
  );
  orb.addColorStop(0, 'rgba(255,255,255,0.85)');
  orb.addColorStop(0.45, base);
  orb.addColorStop(1, c.kind === 'kara' ? '#1e293b' : base);
  ctx.fillStyle = orb;
  ctx.beginPath();
  ctx.arc(c.x, c.y, CEMRE_RADIUS, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle =
    c.kind === 'altin'
      ? 'rgba(254, 240, 138, 0.85)'
      : c.kind === 'kara'
        ? 'rgba(148, 163, 184, 0.6)'
        : 'rgba(15, 23, 42, 0.5)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(c.x, c.y, CEMRE_RADIUS, 0, Math.PI * 2);
  ctx.stroke();

  const symbolColor =
    c.kind === 'kara'
      ? 'rgba(241, 245, 249, 0.85)'
      : c.kind === 'altin'
        ? 'rgba(120, 53, 15, 0.95)'
        : 'rgba(15, 23, 42, 0.85)';
  drawSymbol(c.kind, c.x, c.y, CEMRE_RADIUS * 0.62, symbolColor);
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
    const a = Math.min(1, f.life);
    ctx.globalAlpha = a;
    ctx.fillStyle = f.color;
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 3;
    ctx.strokeText(f.text, f.x, f.y);
    ctx.fillText(f.text, f.x, f.y);
    ctx.globalAlpha = 1;
  }
  ctx.textAlign = 'start';
}

function drawSelectedHint(): void {
  const c = findCemre(selectedId);
  if (!c) return;
  ctx.font = 'bold 12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(254, 240, 138, 0.9)';
  ctx.fillText('▾ havuzu seç ▾', c.x, c.y - CEMRE_RADIUS - 14);
  ctx.textAlign = 'start';
}

function draw(): void {
  drawSky();
  drawBasins();
  for (const c of cemres) if (c.alive) drawCemre(c);
  drawParticles();
  drawSelectedHint();
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
  cemres = [];
  particles = [];
  floats = [];
  score = 0;
  elapsed = 0;
  remaining = ROUND_SECONDS;
  spawnTimer = 0;
  meters = { hava: 0, su: 0, toprak: 0 };
  selectedId = null;
  nextId = 1;
  updateHud();
}

function startGame(): void {
  fullReset();
  state = 'playing';
  hideOverlayEl(overlay);
  spawnCemre();
  spawnTimer = currentSpawnInterval() * 0.6;
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
  const allWon =
    meters.hava >= METER_WIN &&
    meters.su >= METER_WIN &&
    meters.toprak >= METER_WIN;
  const isBest = score > 0 && score >= best;
  overlayTitle.textContent = allWon
    ? 'Bahar Geldi!'
    : isBest
      ? 'Yeni rekor!'
      : 'Süre doldu';
  const subtitle = allWon
    ? '<br><small style="color:#86efac">Üç havuz da eşiği geçti — kış bitti.</small>'
    : '';
  overlayMsg.innerHTML =
    `Skor: <strong>${score}</strong><br>` +
    `En iyi: ${best}<br>` +
    `Hava ${Math.round(meters.hava)} · Su ${Math.round(meters.su)} · Toprak ${Math.round(meters.toprak)}` +
    subtitle +
    '<br><small>R, Boşluk veya Enter ile tekrar dene</small>';
  overlayBtn.textContent = 'Tekrar oyna';
  showOverlayEl(overlay);
  overlayBtn.focus({ preventScroll: true });
}

function resetToReady(): void {
  fullReset();
  state = 'ready';
  overlayTitle.textContent = 'Cemre';
  overlayMsg.innerHTML =
    'Gökten üç cemre düşer: <strong style="color:#7dd3fc">Hava</strong>, ' +
    '<strong style="color:#22d3ee">Su</strong>, ' +
    '<strong style="color:#fbbf24">Toprak</strong>. ' +
    'Cemreyi tıkla, ardından havuza bas. ' +
    '<strong style="color:#94a3b8">Siyah</strong> cemre tuzaktır; ' +
    '<strong style="color:#facc15">altın</strong> her havuza yarar. ' +
    '<br><small>60 saniyede üç havuzu doldur, baharı getir.</small>';
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

function findCemreAt(wx: number, wy: number): Cemre | null {
  let target: Cemre | null = null;
  for (const c of cemres) {
    if (!c.alive || c.routing) continue;
    const dx = wx - c.x;
    const dy = wy - c.y;
    const r = CEMRE_RADIUS + HIT_PAD;
    if (dx * dx + dy * dy <= r * r) {
      if (target === null || c.y > target.y) target = c;
    }
  }
  return target;
}

function onPointerDown(e: PointerEvent): void {
  if (state !== 'playing') return;
  e.preventDefault();
  const p = canvasToWorld(e.clientX, e.clientY);

  if (p.y >= BASIN_TOP) {
    const sel = findCemre(selectedId);
    if (sel) {
      const target = basinForX(p.x);
      startRoute(sel, target);
    }
    return;
  }

  const hit = findCemreAt(p.x, p.y);
  if (hit) {
    for (const c of cemres) c.selected = false;
    hit.selected = true;
    selectedId = hit.id;
    return;
  }

  for (const c of cemres) c.selected = false;
  selectedId = null;
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
  const sel = findCemre(selectedId);
  if (!sel) return;
  if (k === '1' || k === 'a' || k === 'A' || k === 'ArrowLeft') {
    e.preventDefault();
    startRoute(sel, 'hava');
  } else if (k === '2' || k === 's' || k === 'S' || k === 'ArrowDown') {
    e.preventDefault();
    startRoute(sel, 'su');
  } else if (k === '3' || k === 'd' || k === 'D' || k === 'ArrowRight') {
    e.preventDefault();
    startRoute(sel, 'toprak');
  } else if (k === 'Escape') {
    e.preventDefault();
    sel.selected = false;
    selectedId = null;
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
  bestEl.textContent = String(best);

  canvas.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('keydown', onKeyDown);
  restartBtn.addEventListener('click', () => startGame());
  overlayBtn.addEventListener('click', () => startGame());

  resetToReady();
}

export const game = defineGame({ init, reset: resetToReady });
