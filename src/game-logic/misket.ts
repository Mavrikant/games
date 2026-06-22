import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay, hideOverlay, isOverlayHidden } from '@shared/overlay';

// PITFALLS guarded:
// - module-level-dom-access: all DOM access in init()
// - unguarded-storage: safeRead/safeWrite
// - stale-async-callback: gen-token + cancelAnimationFrame around RAF loop
// - overlay-input-leak: explicit `state` enum, guards at each handler
// - visual-vs-hitbox: marble radii used for both draw and collide (single const block)
// - invisible-boot: initial draw() at end of reset() before user input
// - missing-overlay-css: .overlay--hidden defined in styles/games/misket.css
// - hud-counter-synced-only-at-lifecycle-edges: syncHud() at every score change

const STORAGE_BEST = 'misket.best';

const CANVAS_W = 520;
const CANVAS_H = 520;
const RING_CX = CANVAS_W / 2;
const RING_CY = CANVAS_H / 2;
const RING_R = 145;

const SHOOTER_R = 14;
const TARGET_R = 12;

const SHOOTER_START_X = CANVAS_W / 2;
const SHOOTER_START_Y = CANVAS_H - 50;

const MAX_DRAG = 140;
const MAX_LAUNCH_VEL = 1100;
const FRICTION_K = 1.35;
const REST_THRESHOLD = 8;
const WALL_RESTITUTION = 0.55;
const COLLIDE_RESTITUTION = 0.95;

const NUM_TARGETS = 8;
const MAX_SHOTS = 10;

type State = 'ready' | 'aiming' | 'shooting' | 'gameover';

const TARGET_COLORS = [
  '#e76f51',
  '#f4a261',
  '#f6c552',
  '#7bb663',
  '#3da5d9',
  '#9a6cff',
  '#e94e77',
  '#23b5b5',
];

interface Marble {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  color: string;
  shadow: string;
  alive: boolean;
}

interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  color: string;
}

const gen = createGenToken();
let state: State = 'ready';
let score = 0;
let best = 0;
let shotsTaken = 0;

let shooter: Marble = freshShooter(SHOOTER_START_X, SHOOTER_START_Y);
let targets: Marble[] = [];
let sparks: Spark[] = [];

const aim = {
  active: false,
  toX: 0,
  toY: 0,
  pointerId: -1,
};

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let shotsEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlayEl!: HTMLElement;
let overlayTitleEl!: HTMLElement;
let overlayMsgEl!: HTMLElement;

let lastFrame = 0;
let rafId = 0;

function darken(hex: string, amt = 0.5): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgb(${Math.round(r * amt)},${Math.round(g * amt)},${Math.round(b * amt)})`;
}

function freshShooter(x: number, y: number): Marble {
  return {
    x,
    y,
    vx: 0,
    vy: 0,
    r: SHOOTER_R,
    color: '#f4ead5',
    shadow: '#7a6a45',
    alive: true,
  };
}

function makeTargets(): Marble[] {
  const out: Marble[] = [];
  const minDist = 2 * TARGET_R + 4;
  let attempts = 0;
  while (out.length < NUM_TARGETS && attempts < 800) {
    attempts++;
    const angle = Math.random() * Math.PI * 2;
    const dist = Math.sqrt(Math.random()) * (RING_R - TARGET_R - 14);
    const x = RING_CX + Math.cos(angle) * dist;
    const y = RING_CY + Math.sin(angle) * dist;
    let ok = true;
    for (const m of out) {
      const dx = m.x - x;
      const dy = m.y - y;
      if (dx * dx + dy * dy < minDist * minDist) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const color = TARGET_COLORS[out.length % TARGET_COLORS.length]!;
    out.push({
      x,
      y,
      vx: 0,
      vy: 0,
      r: TARGET_R,
      color,
      shadow: darken(color, 0.45),
      alive: true,
    });
  }
  return out;
}

function setMsg(title: string, msg: string): void {
  overlayTitleEl.textContent = title;
  overlayMsgEl.textContent = msg;
}

function syncHud(): void {
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
  shotsEl.textContent = `${shotsTaken}/${MAX_SHOTS}`;
}

function commitBest(): void {
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
}

function startGame(): void {
  state = 'aiming';
  score = 0;
  shotsTaken = 0;
  shooter = freshShooter(SHOOTER_START_X, SHOOTER_START_Y);
  targets = makeTargets();
  sparks = [];
  aim.active = false;
  hideOverlay(overlayEl);
  syncHud();
  const myGen = gen.current();
  cancelAnimationFrame(rafId);
  lastFrame = performance.now();
  const loop = (now: number): void => {
    if (!gen.isCurrent(myGen)) return;
    const dt = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;
    tick(dt);
    draw();
    if (state !== 'gameover' && state !== 'ready') {
      rafId = requestAnimationFrame(loop);
    }
  };
  rafId = requestAnimationFrame(loop);
}

function endGame(reason: 'lost' | 'cleared' | 'out-of-shots'): void {
  state = 'gameover';
  let bonus = 0;
  if (reason === 'cleared') {
    bonus = (MAX_SHOTS - shotsTaken) * 2;
    score += bonus;
  }
  commitBest();
  const lines: string[] = [];
  if (reason === 'cleared') {
    lines.push(
      bonus > 0
        ? `Halka temizlendi! Kalan atış bonusu: +${bonus}`
        : 'Halka temizlendi!',
    );
  } else if (reason === 'lost') {
    lines.push('Nişancın halka içinde durdu — misketini kaybettin.');
  } else {
    lines.push('Atışların bitti.');
  }
  lines.push(`\nVurulan: ${score}`);
  lines.push(`En iyi: ${best}`);
  lines.push("\nYeniden başlamak için tıkla veya Boşluk'a bas.");
  setMsg(
    reason === 'cleared'
      ? 'Helal olsun!'
      : reason === 'lost'
        ? 'Misket gitti'
        : 'Eller bitti',
    lines.join('\n'),
  );
  showOverlay(overlayEl);
  syncHud();
}

function applyFriction(m: Marble, dt: number): void {
  const decay = Math.exp(-FRICTION_K * dt);
  m.vx *= decay;
  m.vy *= decay;
  if (Math.hypot(m.vx, m.vy) < REST_THRESHOLD) {
    m.vx = 0;
    m.vy = 0;
  }
}

function moveMarble(m: Marble, dt: number): void {
  m.x += m.vx * dt;
  m.y += m.vy * dt;
  if (m.x - m.r < 0) {
    m.x = m.r;
    m.vx = -m.vx * WALL_RESTITUTION;
  } else if (m.x + m.r > CANVAS_W) {
    m.x = CANVAS_W - m.r;
    m.vx = -m.vx * WALL_RESTITUTION;
  }
  if (m.y - m.r < 0) {
    m.y = m.r;
    m.vy = -m.vy * WALL_RESTITUTION;
  } else if (m.y + m.r > CANVAS_H) {
    m.y = CANVAS_H - m.r;
    m.vy = -m.vy * WALL_RESTITUTION;
  }
}

function collidePair(a: Marble, b: Marble): void {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dist = Math.hypot(dx, dy);
  const minDist = a.r + b.r;
  if (dist === 0 || dist >= minDist) return;
  const nx = dx / dist;
  const ny = dy / dist;
  const overlap = minDist - dist;
  a.x -= nx * (overlap / 2);
  a.y -= ny * (overlap / 2);
  b.x += nx * (overlap / 2);
  b.y += ny * (overlap / 2);
  const dvx = b.vx - a.vx;
  const dvy = b.vy - a.vy;
  const relVel = dvx * nx + dvy * ny;
  if (relVel > 0) return;
  const j = (-(1 + COLLIDE_RESTITUTION) * relVel) / 2;
  a.vx -= j * nx;
  a.vy -= j * ny;
  b.vx += j * nx;
  b.vy += j * ny;
  spawnSparks((a.x + b.x) / 2, (a.y + b.y) / 2, b.color, 4);
}

function spawnSparks(x: number, y: number, color: string, count = 7): void {
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const s = 50 + Math.random() * 130;
    sparks.push({
      x,
      y,
      vx: Math.cos(a) * s,
      vy: Math.sin(a) * s,
      life: 0.3 + Math.random() * 0.3,
      color,
    });
  }
}

function isInsideRing(m: Marble): boolean {
  const dx = m.x - RING_CX;
  const dy = m.y - RING_CY;
  const limit = RING_R - m.r * 0.4;
  return dx * dx + dy * dy < limit * limit;
}

function isOutsideRing(m: Marble): boolean {
  const dx = m.x - RING_CX;
  const dy = m.y - RING_CY;
  const limit = RING_R + m.r;
  return dx * dx + dy * dy > limit * limit;
}

function tick(dt: number): void {
  for (let i = sparks.length - 1; i >= 0; i--) {
    const s = sparks[i]!;
    s.life -= dt;
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    s.vx *= Math.exp(-2.4 * dt);
    s.vy *= Math.exp(-2.4 * dt);
    if (s.life <= 0) sparks.splice(i, 1);
  }

  if (state !== 'shooting') return;

  applyFriction(shooter, dt);
  moveMarble(shooter, dt);
  for (const t of targets) {
    if (!t.alive) continue;
    applyFriction(t, dt);
    moveMarble(t, dt);
  }

  for (const t of targets) {
    if (!t.alive) continue;
    collidePair(shooter, t);
  }
  for (let i = 0; i < targets.length; i++) {
    for (let j = i + 1; j < targets.length; j++) {
      const a = targets[i]!;
      const b = targets[j]!;
      if (!a.alive || !b.alive) continue;
      collidePair(a, b);
    }
  }

  for (const t of targets) {
    if (!t.alive) continue;
    if (isOutsideRing(t)) {
      t.alive = false;
      score += 1;
      spawnSparks(t.x, t.y, t.color, 10);
      syncHud();
    }
  }

  const allRest =
    shooter.vx === 0 &&
    shooter.vy === 0 &&
    targets.every((t) => !t.alive || (t.vx === 0 && t.vy === 0));
  if (!allRest) return;

  const aliveLeft = targets.filter((t) => t.alive).length;
  if (aliveLeft === 0) {
    endGame('cleared');
    return;
  }
  if (isInsideRing(shooter)) {
    endGame('lost');
    return;
  }
  if (shotsTaken >= MAX_SHOTS) {
    endGame('out-of-shots');
    return;
  }
  state = 'aiming';
}

// ── Drawing ───────────────────────────────────────────────────────────────

function draw(): void {
  const g = ctx.createRadialGradient(
    RING_CX,
    RING_CY,
    20,
    RING_CX,
    RING_CY,
    CANVAS_W * 0.7,
  );
  g.addColorStop(0, '#3d2f1f');
  g.addColorStop(1, '#1a130a');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  ctx.fillStyle = 'rgba(255,220,160,0.05)';
  for (let i = 0; i < 60; i++) {
    const x = (i * 53) % CANVAS_W;
    const y = (i * 91) % CANVAS_H;
    ctx.fillRect(x, y, 1, 1);
  }

  drawRing();
  drawTargets();
  drawShooter();
  drawAim();
  drawSparks();
}

function drawRing(): void {
  ctx.save();
  ctx.strokeStyle = 'rgba(255,245,220,0.16)';
  ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.arc(RING_CX, RING_CY, RING_R, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(255,250,235,0.78)';
  ctx.lineWidth = 3;
  ctx.setLineDash([7, 5]);
  ctx.beginPath();
  ctx.arc(RING_CX, RING_CY, RING_R, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = 'rgba(255,245,220,0.18)';
  ctx.beginPath();
  ctx.arc(RING_CX, RING_CY, 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawMarble(m: Marble): void {
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.beginPath();
  ctx.ellipse(m.x + 2, m.y + m.r * 0.85, m.r * 0.9, m.r * 0.32, 0, 0, Math.PI * 2);
  ctx.fill();

  const grad = ctx.createRadialGradient(
    m.x - m.r * 0.4,
    m.y - m.r * 0.5,
    1,
    m.x,
    m.y,
    m.r,
  );
  grad.addColorStop(0, m.color);
  grad.addColorStop(1, m.shadow);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.beginPath();
  ctx.ellipse(
    m.x - m.r * 0.4,
    m.y - m.r * 0.45,
    m.r * 0.35,
    m.r * 0.22,
    -0.3,
    0,
    Math.PI * 2,
  );
  ctx.fill();
  ctx.restore();
}

function drawTargets(): void {
  for (const t of targets) {
    if (!t.alive) continue;
    drawMarble(t);
  }
}

function drawShooter(): void {
  drawMarble(shooter);
  ctx.save();
  ctx.strokeStyle =
    state === 'aiming' ? 'rgba(255,235,180,0.95)' : 'rgba(255,235,180,0.4)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(shooter.x, shooter.y, shooter.r + 4, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawAim(): void {
  if (state !== 'aiming' || !aim.active) return;
  const dx = aim.toX - shooter.x;
  const dy = aim.toY - shooter.y;
  const d = Math.hypot(dx, dy);
  if (d < 4) return;
  const clamped = Math.min(d, MAX_DRAG);
  const nx = dx / d;
  const ny = dy / d;
  const tipX = shooter.x + nx * clamped;
  const tipY = shooter.y + ny * clamped;
  const power = clamped / MAX_DRAG;

  ctx.save();
  const r = Math.round(120 + 130 * power);
  const gC = Math.round(220 - 120 * power);
  const bC = 80;
  ctx.strokeStyle = `rgb(${r},${gC},${bC})`;
  ctx.lineWidth = 3;
  ctx.setLineDash([7, 5]);
  ctx.beginPath();
  ctx.moveTo(shooter.x, shooter.y);
  ctx.lineTo(tipX, tipY);
  ctx.stroke();
  ctx.setLineDash([]);

  const ah = 12;
  const ax = -ny;
  const ay = nx;
  ctx.fillStyle = `rgb(${r},${gC},${bC})`;
  ctx.beginPath();
  ctx.moveTo(tipX + nx * ah, tipY + ny * ah);
  ctx.lineTo(tipX + ax * 7, tipY + ay * 7);
  ctx.lineTo(tipX - ax * 7, tipY - ay * 7);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = `rgba(${r},${gC},${bC},0.9)`;
  ctx.beginPath();
  ctx.arc(shooter.x, shooter.y, 4 + power * 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawSparks(): void {
  ctx.save();
  for (const s of sparks) {
    const a = Math.max(0, s.life * 2.8);
    ctx.globalAlpha = Math.min(1, a);
    ctx.fillStyle = s.color;
    ctx.beginPath();
    ctx.arc(s.x, s.y, 2.4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// ── Input ─────────────────────────────────────────────────────────────────

function canvasCoords(e: PointerEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((e.clientX - rect.left) / rect.width) * CANVAS_W,
    y: ((e.clientY - rect.top) / rect.height) * CANVAS_H,
  };
}

function startFromOverlay(): void {
  if (state === 'ready') {
    startGame();
  } else if (state === 'gameover') {
    reset();
    startGame();
  }
}

function onPointerDown(e: PointerEvent): void {
  if (e.button !== 0 && e.pointerType === 'mouse') return;
  e.preventDefault();

  if (state === 'ready' || state === 'gameover') {
    startFromOverlay();
    return;
  }
  if (state !== 'aiming') return;
  const { x, y } = canvasCoords(e);
  aim.active = true;
  aim.toX = x;
  aim.toY = y;
  aim.pointerId = e.pointerId;
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {
    /* ignore */
  }
}

function onPointerMove(e: PointerEvent): void {
  if (!aim.active || e.pointerId !== aim.pointerId) return;
  if (state !== 'aiming') return;
  const { x, y } = canvasCoords(e);
  aim.toX = x;
  aim.toY = y;
}

function onPointerUp(e: PointerEvent): void {
  if (!aim.active || e.pointerId !== aim.pointerId) return;
  aim.active = false;
  try {
    canvas.releasePointerCapture(e.pointerId);
  } catch {
    /* ignore */
  }
  if (state !== 'aiming') return;
  const dx = aim.toX - shooter.x;
  const dy = aim.toY - shooter.y;
  const d = Math.hypot(dx, dy);
  if (d < 8) return;
  const clamped = Math.min(d, MAX_DRAG);
  const nx = dx / d;
  const ny = dy / d;
  const power = clamped / MAX_DRAG;
  shooter.vx = nx * power * MAX_LAUNCH_VEL;
  shooter.vy = ny * power * MAX_LAUNCH_VEL;
  shotsTaken++;
  state = 'shooting';
  syncHud();
}

function onPointerCancel(e: PointerEvent): void {
  if (!aim.active || e.pointerId !== aim.pointerId) return;
  aim.active = false;
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'r' || e.key === 'R') {
    e.preventDefault();
    reset();
    return;
  }
  if (e.code === 'Space' || e.key === 'Enter') {
    e.preventDefault();
    if (state === 'ready' || state === 'gameover') {
      startFromOverlay();
    }
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────

function reset(): void {
  gen.bump();
  cancelAnimationFrame(rafId);
  state = 'ready';
  score = 0;
  shotsTaken = 0;
  shooter = freshShooter(SHOOTER_START_X, SHOOTER_START_Y);
  targets = makeTargets();
  sparks = [];
  aim.active = false;
  commitBest();
  syncHud();
  setMsg(
    'Misket',
    "Halkadaki rakip misketleri nişancı misketinle dışarı uçur. Nişancı sürükle, bırak. Nişancın halkanın içinde durursa elin biter.\n\nBaşlamak için tıkla veya Boşluk'a bas.",
  );
  showOverlay(overlayEl);
  draw();
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  shotsEl = document.querySelector<HTMLElement>('#shots')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlayEl = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitleEl = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsgEl = document.querySelector<HTMLElement>('#overlay-msg')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  restartBtn.addEventListener('click', () => {
    reset();
  });
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);
  overlayEl.addEventListener('pointerdown', (e) => {
    if (isOverlayHidden(overlayEl)) return;
    e.preventDefault();
    startFromOverlay();
  });
  window.addEventListener('keydown', onKey);

  reset();
}

export const game = defineGame({ init, reset });
