import { defineGame } from '@shared/game-module';
import { reportGameOver } from '@shared/leaderboard';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay, hideOverlay } from '@shared/overlay';

// Hava Trafik — air-traffic-control / flight-routing.
// Draw a path for a plane by dragging; it follows the path then flies straight.
// Land each plane at the gate matching its colour; never let two planes touch
// and never let a plane fly off the screen.
//
// PITFALLS guarded here (see docs/PITFALLS.md):
// - unguarded-storage: safeRead/safeWrite wrap localStorage.
// - stale-async-callback: gen token cancels the rAF loop on every (re)start.
// - overlay-input-leak: explicit `state` enum guards every input handler;
//   pointer routing on the canvas only acts while `playing`.
// - visual-vs-hitbox: PLANE_R / COLLISION_DIST / LAND_DIST / GATE_R are the
//   single source of truth for BOTH draw() and the update() physics.
// - invisible-boot: startGame() spawns one plane immediately + draws a frame.
// - module-level-dom-access: all DOM/storage access lives in init().

const STORAGE_BEST = 'hava-trafik.best';
const SCORE_DESC = { gameId: 'hava-trafik', storageKey: STORAGE_BEST, direction: 'higher' as const };

// --- Geometry: shared by render AND physics. Never duplicate these. ---
const W = 480;
const H = 480;
const PLANE_R = 9; // visual + hit radius of a plane
const COLLISION_DIST = 2 * PLANE_R; // centre distance => crash
const GATE_R = 22; // visual gate radius
const LAND_DIST = GATE_R; // centre within this of matching gate => land
const SELECT_R = 30; // pointer pick radius around a plane
const WAYPOINT_REACH = 7; // distance to consider a waypoint reached
const MIN_WP_DIST = 14; // min spacing when recording drawn path points
const SPEED = 62; // px / second
const EXIT_MARGIN = 46; // remove plane once this far outside the screen
const MAX_PLANES = 7;
const SPAWN_START = 3.4; // seconds between spawns at the start
const SPAWN_MIN = 1.35;

const PALETTE = ['#f8717f', '#34d399', '#fbbf24', '#60a5fa'] as const;

interface Vec {
  x: number;
  y: number;
}

interface Gate {
  x: number;
  y: number;
  color: number; // index into PALETTE
}

interface Plane {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: number;
  path: Vec[];
}

// Gates sit at the middle of each edge, one per colour.
const GATES: Gate[] = [
  { x: W / 2, y: 0, color: 0 }, // top
  { x: W, y: H / 2, color: 1 }, // right
  { x: W / 2, y: H, color: 2 }, // bottom
  { x: 0, y: H / 2, color: 3 }, // left
];

const gen = createGenToken();
let state: State = 'ready';
let score = 0;
let best = 0;

let planes: Plane[] = [];
let nextId = 0;
let spawnTimer = 0;
let spawnInterval = SPAWN_START;
let crash: Vec | null = null;
let dragId: number | null = null;

type State = 'ready' | 'playing' | 'gameover';

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;

let rafId = 0;
let lastTs = 0;

function dist(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return Math.hypot(dx, dy);
}

function planeById(id: number): Plane | undefined {
  return planes.find((p) => p.id === id);
}

function spawnPlane(): void {
  if (planes.length >= MAX_PLANES) return;
  const color = Math.floor(Math.random() * PALETTE.length);
  // Try a few times to find a spawn that is clear of existing planes.
  for (let attempt = 0; attempt < 12; attempt++) {
    const edge = Math.floor(Math.random() * 4);
    let x = 0;
    let y = 0;
    const t = 0.18 + Math.random() * 0.64; // keep away from corners
    if (edge === 0) {
      x = t * W;
      y = 0;
    } else if (edge === 1) {
      x = W;
      y = t * H;
    } else if (edge === 2) {
      x = t * W;
      y = H;
    } else {
      x = 0;
      y = t * H;
    }
    // Aim toward a random point in the central area.
    const tx = W * (0.3 + Math.random() * 0.4);
    const ty = H * (0.3 + Math.random() * 0.4);
    const dx = tx - x;
    const dy = ty - y;
    const len = Math.hypot(dx, dy) || 1;

    const clash = planes.some((p) => dist(p.x, p.y, x, y) < COLLISION_DIST * 3);
    if (clash) continue;

    planes.push({
      id: nextId++,
      x,
      y,
      vx: (dx / len) * SPEED,
      vy: (dy / len) * SPEED,
      color,
      path: [],
    });
    return;
  }
}

function update(dt: number): void {
  // Move every plane along its path (or straight if it has none).
  for (const p of planes) {
    let remaining = SPEED * dt;
    while (remaining > 0 && p.path.length > 0) {
      const wp = p.path[0]!;
      const d = dist(p.x, p.y, wp.x, wp.y);
      if (d <= WAYPOINT_REACH || d === 0) {
        p.path.shift();
        continue;
      }
      const ux = (wp.x - p.x) / d;
      const uy = (wp.y - p.y) / d;
      p.vx = ux * SPEED;
      p.vy = uy * SPEED;
      const move = Math.min(remaining, d);
      p.x += ux * move;
      p.y += uy * move;
      remaining -= move;
      if (move >= d - WAYPOINT_REACH) p.path.shift();
    }
    if (remaining > 0) {
      // No path left: keep flying straight on the current heading.
      const speed = Math.hypot(p.vx, p.vy) || 1;
      p.x += (p.vx / speed) * remaining;
      p.y += (p.vy / speed) * remaining;
    }
  }

  // Landings: a plane at its matching gate scores and is removed.
  planes = planes.filter((p) => {
    const g = GATES[p.color]!;
    if (dist(p.x, p.y, g.x, g.y) <= LAND_DIST) {
      score += 1;
      scoreEl.textContent = String(score);
      if (dragId === p.id) dragId = null;
      return false;
    }
    return true;
  });

  // A plane that leaves the airspace is a failed landing => game over.
  const lost = planes.find(
    (p) =>
      p.x < -EXIT_MARGIN ||
      p.x > W + EXIT_MARGIN ||
      p.y < -EXIT_MARGIN ||
      p.y > H + EXIT_MARGIN,
  );
  if (lost) {
    // Mark the edge the plane escaped through so the failure is visible.
    crash = {
      x: Math.max(PLANE_R, Math.min(W - PLANE_R, lost.x)),
      y: Math.max(PLANE_R, Math.min(H - PLANE_R, lost.y)),
    };
    if (dragId === lost.id) dragId = null;
    endGame('lost');
    return;
  }

  // Collisions => game over.
  for (let i = 0; i < planes.length; i++) {
    for (let j = i + 1; j < planes.length; j++) {
      const a = planes[i]!;
      const b = planes[j]!;
      if (dist(a.x, a.y, b.x, b.y) < COLLISION_DIST) {
        crash = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        endGame('crash');
        return;
      }
    }
  }

  // Spawn cadence ramps up with score.
  spawnTimer += dt;
  spawnInterval = Math.max(SPAWN_MIN, SPAWN_START - score * 0.06);
  if (spawnTimer >= spawnInterval) {
    spawnTimer = 0;
    spawnPlane();
  }
}

function drawBackground(): void {
  ctx.fillStyle = '#0c0f14';
  ctx.fillRect(0, 0, W, H);
  // Subtle radar grid.
  ctx.strokeStyle = 'rgba(129, 140, 248, 0.08)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 6; i++) {
    const p = (i / 6) * W;
    ctx.beginPath();
    ctx.moveTo(p, 0);
    ctx.lineTo(p, H);
    ctx.moveTo(0, p);
    ctx.lineTo(W, p);
    ctx.stroke();
  }
}

function drawGate(g: Gate): void {
  const color = PALETTE[g.color]!;
  // Pull the gate marker slightly inward so it sits on screen.
  const ix = g.x === 0 ? GATE_R * 0.5 : g.x === W ? W - GATE_R * 0.5 : g.x;
  const iy = g.y === 0 ? GATE_R * 0.5 : g.y === H ? H - GATE_R * 0.5 : g.y;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.22;
  ctx.beginPath();
  ctx.arc(g.x, g.y, GATE_R, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(g.x, g.y, GATE_R, 0, Math.PI * 2);
  ctx.stroke();
  // Inner runway tick.
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(ix - 7, iy);
  ctx.lineTo(ix + 7, iy);
  ctx.stroke();
  ctx.restore();
}

function drawPlane(p: Plane): void {
  const color = PALETTE[p.color]!;
  // Draw the planned route.
  if (p.path.length > 0) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.4;
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 6]);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    for (const wp of p.path) ctx.lineTo(wp.x, wp.y);
    ctx.stroke();
    ctx.restore();
  }
  // Triangle pointing along the heading.
  const ang = Math.atan2(p.vy, p.vx);
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(ang);
  ctx.fillStyle = color;
  ctx.strokeStyle = '#0c0f14';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(PLANE_R + 2, 0);
  ctx.lineTo(-PLANE_R, PLANE_R - 1);
  ctx.lineTo(-PLANE_R + 3, 0);
  ctx.lineTo(-PLANE_R, -(PLANE_R - 1));
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
  // Highlight ring while being routed.
  if (dragId === p.id) {
    ctx.save();
    ctx.strokeStyle = '#f5f6f8';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(p.x, p.y, PLANE_R + 6, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

function drawCrash(): void {
  if (!crash) return;
  ctx.save();
  ctx.fillStyle = '#fb7185';
  ctx.globalAlpha = 0.85;
  ctx.beginPath();
  ctx.arc(crash.x, crash.y, PLANE_R + 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 0.35;
  ctx.beginPath();
  ctx.arc(crash.x, crash.y, PLANE_R + 18, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function draw(): void {
  drawBackground();
  for (const g of GATES) drawGate(g);
  for (const p of planes) drawPlane(p);
  drawCrash();
}

function loop(ts: number, myGen: number): void {
  if (!gen.isCurrent(myGen) || state !== 'playing') return;
  if (!lastTs) lastTs = ts;
  let dt = (ts - lastTs) / 1000;
  lastTs = ts;
  if (dt > 0.05) dt = 0.05; // clamp after tab switch / first frame
  update(dt);
  if (state === 'playing') {
    draw();
    rafId = requestAnimationFrame((t) => loop(t, myGen));
  }
}

function startGame(): void {
  gen.bump();
  cancelAnimationFrame(rafId);
  planes = [];
  nextId = 0;
  spawnTimer = 0;
  spawnInterval = SPAWN_START;
  crash = null;
  dragId = null;
  score = 0;
  state = 'playing';
  hideOverlay(overlay);
  scoreEl.textContent = '0';
  spawnPlane(); // instant visible feedback (PITFALLS#invisible-boot)
  draw();
  lastTs = 0;
  const myGen = gen.current();
  rafId = requestAnimationFrame((t) => loop(t, myGen));
}

function endGame(reason: 'crash' | 'lost'): void {
  state = 'gameover';
  gen.bump();
  cancelAnimationFrame(rafId);
  dragId = null;
  commitBest();
  reportGameOver(SCORE_DESC, score);
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
  overlayTitle.textContent = reason === 'crash' ? 'Çarpışma!' : 'Uçak kayboldu!';
  overlayMsg.textContent = `İndirdiğin uçak: ${score}\n\nYeniden başlamak için ekrana dokun.`;
  draw();
  showOverlay(overlay);
}

function commitBest(): void {
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
}

function reset(): void {
  gen.bump();
  cancelAnimationFrame(rafId);
  commitBest();
  state = 'ready';
  planes = [];
  crash = null;
  dragId = null;
  score = 0;
  spawnTimer = 0;
  spawnInterval = SPAWN_START;
  scoreEl.textContent = '0';
  bestEl.textContent = String(best);
  overlayTitle.textContent = 'Hava Trafik';
  overlayMsg.textContent =
    'Bir uçağa dokun ve parmağını sürükleyerek pistine giden rotayı çiz. Her uçağı kendi rengindeki piste indir; iki uçağı çarpıştırma ve hiçbir uçağın ekrandan çıkmasına izin verme.\n\nBaşlamak için ekrana dokun.';
  draw();
  showOverlay(overlay);
}

function toCanvas(e: PointerEvent): Vec {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((e.clientX - rect.left) / rect.width) * W,
    y: ((e.clientY - rect.top) / rect.height) * H,
  };
}

function nearestPlane(pt: Vec): Plane | null {
  let pick: Plane | null = null;
  let bestD = SELECT_R;
  for (const p of planes) {
    const d = dist(p.x, p.y, pt.x, pt.y);
    if (d <= bestD) {
      bestD = d;
      pick = p;
    }
  }
  return pick;
}

function onPointerDown(e: PointerEvent): void {
  if (state !== 'playing') {
    startGame();
    return;
  }
  const pt = toCanvas(e);
  const p = nearestPlane(pt);
  if (!p) return;
  e.preventDefault();
  dragId = p.id;
  p.path = [{ x: pt.x, y: pt.y }];
  canvas.setPointerCapture(e.pointerId);
}

function onPointerMove(e: PointerEvent): void {
  if (state !== 'playing' || dragId === null) return;
  const p = planeById(dragId);
  if (!p) {
    dragId = null;
    return;
  }
  const pt = toCanvas(e);
  const last = p.path[p.path.length - 1];
  if (!last || dist(last.x, last.y, pt.x, pt.y) >= MIN_WP_DIST) {
    p.path.push(pt);
  }
}

function onPointerUp(e: PointerEvent): void {
  if (dragId !== null) {
    const p = planeById(dragId);
    if (p && p.path.length === 1) p.path = []; // a tap, not a drag
  }
  dragId = null;
  if (canvas.hasPointerCapture?.(e.pointerId)) {
    canvas.releasePointerCapture(e.pointerId);
  }
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'r' || e.key === 'R') {
    e.preventDefault();
    startGame();
  }
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;

  best = safeRead<number>(STORAGE_BEST, 0);
  bestEl.textContent = String(best);

  restartBtn.addEventListener('click', startGame);
  overlay.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    startGame();
  });
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  window.addEventListener('keydown', onKey);

  reset();
}

export const game = defineGame({ init, reset });
