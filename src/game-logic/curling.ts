import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import {
  showOverlay as showOverlayEl,
  hideOverlay as hideOverlayEl,
} from '@shared/overlay';

// Curling — top-down strategy-physics. 4 red stones to throw; gray opponent
// stones pre-placed as guards. Real curling end-scoring: each red closer to
// center than the closest gray scores 1; +1 bonus for any red fully in button.
//
// Pitfall guards:
//   - unguarded-storage: safeRead/safeWrite wrap localStorage.
//   - stale-async-callback: gen.bump() on reset; RAF loop checks token.
//   - overlay-input-leak: explicit `state` enum guards every handler.
//   - missing-overlay-css: .overlay--hidden + .overlay positioning in CSS.
//   - module-level-dom-access: all DOM access in init().
//   - visual-vs-hitbox: STONE_R and RING_RADII are single consts shared by
//     draw + physics + scoring. No hard-coded sizes anywhere else.
//   - invisible-boot: reset() places gray stones + active red on cold boot,
//     so the rink is fully drawn before the player taps Başla.

const STORAGE_BEST = 'curling.best';

// ---- Sabitler ----

const W = 480;
const H = 720;

const HOUSE_CX = W / 2;
const HOUSE_CY = 130;

// Outer → inner. Index 0 = outer ring, index 3 = button.
const RING_RADII = [80, 60, 40, 18] as const;
const BUTTON_R = RING_RADII[3];
const OUTER_R = RING_RADII[0];

const STONE_R = 14;

const RELEASE_Y = H - 70;
const BACKBOARD_Y = 35;
const SIDE_PAD = 32;
const HOG_LINE_Y = H - 180;

const FRICTION = 0.988;
const STOP_VEL_SQ = 0.0016;
const MAX_PULL = 130;
const POWER_SCALE = 0.115;
const MIN_FIRE_PULL = 16;

const RED_PER_END = 4;
const MAX_GRAY = 5;
const SUBSTEPS = 4;

type State = 'ready' | 'aiming' | 'sliding' | 'roundOver';
type Side = 'red' | 'gray';

interface Stone {
  x: number;
  y: number;
  vx: number;
  vy: number;
  side: Side;
  alive: boolean;
}

// ---- DOM refs ----

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let roundEl!: HTMLElement;
let throwsEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayAction!: HTMLButtonElement;

// ---- Mutable state ----

const gen = createGenToken();

let state: State = 'ready';
let stones: Stone[] = [];
let activeStone: Stone | null = null;
let pullDX = 0;
let pullDY = 0;
let isPulling = false;
let pointerId: number | null = null;

let throwsLeft = RED_PER_END;
let round = 1;
let totalScore = 0;
let best = 0;

let animHandle: number | null = null;

// ---- Storage ----

function loadBest(): number {
  const raw = safeRead<number>(STORAGE_BEST, 0);
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0
    ? Math.floor(raw)
    : 0;
}

function commitBest(roundScore: number): void {
  if (roundScore > best) {
    best = roundScore;
    safeWrite(STORAGE_BEST, best);
  }
}

// ---- Helpers ----

function canvasPoint(e: PointerEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const sx = canvas.width / rect.width;
  const sy = canvas.height / rect.height;
  return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy };
}

function clampPull(dx: number, dy: number): [number, number] {
  const len = Math.hypot(dx, dy);
  if (len <= MAX_PULL) return [dx, dy];
  const k = MAX_PULL / len;
  return [dx * k, dy * k];
}

function dist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

// ---- Round setup ----

function placeGrayStones(): void {
  const count = Math.min(2 + Math.floor((round - 1)), MAX_GRAY);
  let placed = 0;
  let tries = 0;
  const minSep = STONE_R * 2 + 4;
  while (placed < count && tries < 400) {
    tries++;
    const inHouseSide = Math.random() < 0.55;
    let x: number;
    let y: number;
    if (inHouseSide) {
      const ang = Math.random() * Math.PI * 2;
      const minD = round <= 1 ? 30 : 14;
      const maxD = OUTER_R - STONE_R - 2;
      const d = rand(minD, maxD);
      x = HOUSE_CX + Math.cos(ang) * d;
      y = HOUSE_CY + Math.sin(ang) * d;
    } else {
      x = HOUSE_CX + rand(-90, 90);
      y = HOUSE_CY + OUTER_R + rand(20, 160 + round * 6);
    }
    if (x < SIDE_PAD + STONE_R || x > W - SIDE_PAD - STONE_R) continue;
    if (y < BACKBOARD_Y + STONE_R || y > HOG_LINE_Y - STONE_R) continue;
    let ok = true;
    for (const s of stones) {
      if (dist2(s.x, s.y, x, y) < minSep * minSep) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    stones.push({ x, y, vx: 0, vy: 0, side: 'gray', alive: true });
    placed++;
  }
}

function spawnActiveRed(): void {
  activeStone = {
    x: HOUSE_CX,
    y: RELEASE_Y,
    vx: 0,
    vy: 0,
    side: 'red',
    alive: true,
  };
}

function setupRound(): void {
  stones = [];
  placeGrayStones();
  throwsLeft = RED_PER_END;
  spawnActiveRed();
  state = 'aiming';
  updateHud();
  draw();
}

// ---- Physics ----

function stepPhysics(): boolean {
  let anyMoving = false;
  for (let s = 0; s < SUBSTEPS; s++) {
    for (const st of stones) {
      if (!st.alive) continue;
      st.x += st.vx / SUBSTEPS;
      st.y += st.vy / SUBSTEPS;
    }
    for (const st of stones) {
      if (!st.alive) continue;
      if (st.x < SIDE_PAD + STONE_R) {
        st.x = SIDE_PAD + STONE_R;
        st.vx = -st.vx * 0.6;
      } else if (st.x > W - SIDE_PAD - STONE_R) {
        st.x = W - SIDE_PAD - STONE_R;
        st.vx = -st.vx * 0.6;
      }
      if (st.y < BACKBOARD_Y) {
        st.alive = false;
      }
      if (st.y > H + STONE_R) {
        st.alive = false;
      }
    }
    for (let i = 0; i < stones.length; i++) {
      const a = stones[i];
      if (!a || !a.alive) continue;
      for (let j = i + 1; j < stones.length; j++) {
        const b = stones[j];
        if (!b || !b.alive) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d2 = dx * dx + dy * dy;
        const r = STONE_R * 2;
        if (d2 < r * r && d2 > 0) {
          const d = Math.sqrt(d2);
          const nx = dx / d;
          const ny = dy / d;
          const overlap = r - d;
          a.x -= nx * overlap * 0.5;
          a.y -= ny * overlap * 0.5;
          b.x += nx * overlap * 0.5;
          b.y += ny * overlap * 0.5;
          const va = a.vx * nx + a.vy * ny;
          const vb = b.vx * nx + b.vy * ny;
          const diff = vb - va;
          a.vx += diff * nx;
          a.vy += diff * ny;
          b.vx -= diff * nx;
          b.vy -= diff * ny;
        }
      }
    }
  }
  for (const st of stones) {
    if (!st.alive) continue;
    st.vx *= FRICTION;
    st.vy *= FRICTION;
    const v2 = st.vx * st.vx + st.vy * st.vy;
    if (v2 < STOP_VEL_SQ) {
      st.vx = 0;
      st.vy = 0;
    } else {
      anyMoving = true;
    }
  }
  stones = stones.filter((s) => s.alive);
  return anyMoving;
}

// ---- Scoring (real curling) ----

function inHouse(s: Stone): boolean {
  return dist2(s.x, s.y, HOUSE_CX, HOUSE_CY) <= (OUTER_R + STONE_R) ** 2;
}

function inButton(s: Stone): boolean {
  return dist2(s.x, s.y, HOUSE_CX, HOUSE_CY) <= (BUTTON_R - 1) ** 2;
}

function scoreRound(): number {
  const distOf = (s: Stone) => dist2(s.x, s.y, HOUSE_CX, HOUSE_CY);
  const reds = stones
    .filter((s) => s.side === 'red' && inHouse(s))
    .map(distOf)
    .sort((a, b) => a - b);
  const grays = stones
    .filter((s) => s.side === 'gray' && inHouse(s))
    .map(distOf)
    .sort((a, b) => a - b);
  let base = 0;
  if (reds.length === 0) {
    base = 0;
  } else if (grays.length === 0) {
    base = reds.length;
  } else {
    const grayClosest = grays[0]!;
    for (const r of reds) {
      if (r < grayClosest) base++;
    }
  }
  let bonus = 0;
  for (const s of stones) {
    if (s.side === 'red' && inButton(s)) bonus++;
  }
  return base + bonus;
}

// ---- Render ----

function draw(): void {
  ctx.clearRect(0, 0, W, H);

  ctx.fillStyle = '#0a3b54';
  ctx.fillRect(0, 0, SIDE_PAD, H);
  ctx.fillRect(W - SIDE_PAD, 0, SIDE_PAD, H);

  ctx.strokeStyle = 'rgba(20, 60, 90, 0.35)';
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 8]);
  ctx.beginPath();
  ctx.moveTo(W / 2, BACKBOARD_Y);
  ctx.lineTo(W / 2, H - 20);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.strokeStyle = 'rgba(30, 60, 90, 0.5)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(SIDE_PAD, HOG_LINE_Y);
  ctx.lineTo(W - SIDE_PAD, HOG_LINE_Y);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(30, 60, 90, 0.4)';
  ctx.beginPath();
  ctx.moveTo(SIDE_PAD, RELEASE_Y + STONE_R + 8);
  ctx.lineTo(W - SIDE_PAD, RELEASE_Y + STONE_R + 8);
  ctx.stroke();

  const ringColors = ['#e63946', '#ffffff', '#1d4ed8', '#ffffff'];
  for (let i = 0; i < RING_RADII.length; i++) {
    ctx.fillStyle = ringColors[i]!;
    ctx.beginPath();
    ctx.arc(HOUSE_CX, HOUSE_CY, RING_RADII[i]!, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.18)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(HOUSE_CX, HOUSE_CY, OUTER_R, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(30, 60, 90, 0.45)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(SIDE_PAD, HOUSE_CY);
  ctx.lineTo(W - SIDE_PAD, HOUSE_CY);
  ctx.stroke();

  for (const s of stones) {
    drawStone(s);
  }
  if (activeStone) {
    drawStone(activeStone, true);
  }

  if (state === 'aiming' && isPulling && activeStone) {
    const fireVx = -pullDX * POWER_SCALE;
    const fireVy = -pullDY * POWER_SCALE;
    const pullLen = Math.hypot(pullDX, pullDY);

    ctx.strokeStyle = 'rgba(220, 38, 38, 0.55)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(activeStone.x, activeStone.y);
    ctx.lineTo(activeStone.x + pullDX, activeStone.y + pullDY);
    ctx.stroke();

    if (pullLen >= MIN_FIRE_PULL) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 6]);
      ctx.beginPath();
      ctx.moveTo(activeStone.x, activeStone.y);
      let px = activeStone.x;
      let py = activeStone.y;
      let pvx = fireVx;
      let pvy = fireVy;
      for (let i = 0; i < 240; i++) {
        px += pvx;
        py += pvy;
        if (px < SIDE_PAD + STONE_R) {
          px = SIDE_PAD + STONE_R;
          pvx = -pvx * 0.6;
        }
        if (px > W - SIDE_PAD - STONE_R) {
          px = W - SIDE_PAD - STONE_R;
          pvx = -pvx * 0.6;
        }
        pvx *= FRICTION;
        pvy *= FRICTION;
        if (pvx * pvx + pvy * pvy < STOP_VEL_SQ) break;
        if (py < BACKBOARD_Y) break;
        ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    const barW = 50;
    const barH = 6;
    const bx = activeStone.x - barW / 2;
    const by = activeStone.y - STONE_R - 14;
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fillRect(bx, by, barW, barH);
    const fillW = (Math.min(pullLen, MAX_PULL) / MAX_PULL) * barW;
    ctx.fillStyle = pullLen >= MIN_FIRE_PULL ? '#dc2626' : '#94a3b8';
    ctx.fillRect(bx, by, fillW, barH);
  }
}

function drawStone(s: Stone, isActive = false): void {
  const grad = ctx.createRadialGradient(
    s.x - STONE_R * 0.4,
    s.y - STONE_R * 0.4,
    STONE_R * 0.2,
    s.x,
    s.y,
    STONE_R,
  );
  if (s.side === 'red') {
    grad.addColorStop(0, '#fca5a5');
    grad.addColorStop(1, '#b91c1c');
  } else {
    grad.addColorStop(0, '#d1d5db');
    grad.addColorStop(1, '#4b5563');
  }
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(s.x, s.y, STONE_R, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = s.side === 'red' ? '#7f1d1d' : '#1f2937';
  ctx.beginPath();
  ctx.arc(s.x, s.y, STONE_R * 0.38, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = 'rgba(0,0,0,0.45)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(s.x, s.y, STONE_R - 0.5, 0, Math.PI * 2);
  ctx.stroke();

  if (isActive && state === 'aiming') {
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(s.x, s.y, STONE_R + 3, 0, Math.PI * 2);
    ctx.stroke();
  }
}

// ---- HUD ----

function updateHud(): void {
  scoreEl.textContent = String(totalScore);
  roundEl.textContent = String(round);
  throwsEl.textContent = `${throwsLeft}/${RED_PER_END}`;
  bestEl.textContent = best > 0 ? String(best) : '—';
}

// ---- Overlay ----

function showOverlayWith(title: string, msg: string, actionLabel: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  overlayAction.textContent = actionLabel;
  showOverlayEl(overlay);
  try {
    overlayAction.focus({ preventScroll: true });
  } catch {
    /* ignore */
  }
}

function hideOverlay(): void {
  hideOverlayEl(overlay);
}

// ---- Lifecycle ----

function reset(): void {
  gen.bump();
  stopLoop();
  state = 'ready';
  isPulling = false;
  pullDX = 0;
  pullDY = 0;
  pointerId = null;
  activeStone = null;
  stones = [];
  throwsLeft = RED_PER_END;
  round = 1;
  totalScore = 0;
  // Cold-boot scene: a preview round so the canvas isn't blank behind the
  // overlay (PITFALLS#invisible-boot).
  placeGrayStones();
  spawnActiveRed();
  updateHud();
  draw();
  showOverlayWith(
    'Curling',
    'Buz pisti üstünde 4 kırmızı taşı kaydır.\nTaşı bastır, geri-aşağı sürükle, bırak.\nGri taşlardan daha merkeze yerleştir.',
    'Başla',
  );
}

function startSession(): void {
  if (state !== 'ready') return;
  stones = [];
  activeStone = null;
  round = 1;
  totalScore = 0;
  hideOverlay();
  setupRound();
}

function startLoop(): void {
  if (animHandle !== null) return;
  const myGen = gen.current();
  const loop = (): void => {
    if (!gen.isCurrent(myGen)) {
      animHandle = null;
      return;
    }
    const moving = stepPhysics();
    draw();
    if (!moving) {
      stopLoop();
      onAllStopped();
      return;
    }
    animHandle = requestAnimationFrame(loop);
  };
  animHandle = requestAnimationFrame(loop);
}

function stopLoop(): void {
  if (animHandle !== null) {
    cancelAnimationFrame(animHandle);
    animHandle = null;
  }
}

function onAllStopped(): void {
  if (state !== 'sliding') return;
  // Red stones that didn't pass the hog line are removed (real curling rule).
  stones = stones.filter((s) => {
    if (!s.alive) return false;
    if (s.side === 'red' && s.y > HOG_LINE_Y) {
      return false;
    }
    return true;
  });

  if (throwsLeft > 0) {
    spawnActiveRed();
    state = 'aiming';
    updateHud();
    draw();
    return;
  }

  const roundScore = scoreRound();
  totalScore += roundScore;
  commitBest(roundScore);
  state = 'roundOver';
  updateHud();
  draw();
  const msg = `Tur skoru: ${roundScore}\nToplam: ${totalScore}\nEn iyi tek tur: ${best}`;
  const nextLabel = `Tur ${round + 1} →`;
  showOverlayWith(
    roundScore > 0 ? 'Güzel atış!' : 'Bu turu kaybettin',
    msg,
    nextLabel,
  );
}

function nextRound(): void {
  if (state !== 'roundOver') return;
  round++;
  stones = [];
  activeStone = null;
  hideOverlay();
  setupRound();
}

// ---- Input ----

function tryFire(): void {
  if (state !== 'aiming') return;
  if (!activeStone) return;
  const len = Math.hypot(pullDX, pullDY);
  if (len < MIN_FIRE_PULL) return;
  activeStone.vx = -pullDX * POWER_SCALE;
  activeStone.vy = -pullDY * POWER_SCALE;
  stones.push(activeStone);
  activeStone = null;
  throwsLeft--;
  state = 'sliding';
  isPulling = false;
  pullDX = 0;
  pullDY = 0;
  pointerId = null;
  updateHud();
  startLoop();
}

function onPointerDown(e: PointerEvent): void {
  if (state !== 'aiming') return;
  if (!activeStone) return;
  if (pointerId !== null) return;
  pointerId = e.pointerId;
  const p = canvasPoint(e);
  isPulling = true;
  let dx = p.x - activeStone.x;
  let dy = p.y - activeStone.y;
  [dx, dy] = clampPull(dx, dy);
  pullDX = dx;
  pullDY = dy;
  e.preventDefault();
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {
    /* ignore */
  }
  draw();
}

function onPointerMove(e: PointerEvent): void {
  if (!isPulling) return;
  if (pointerId !== null && e.pointerId !== pointerId) return;
  if (!activeStone) return;
  const p = canvasPoint(e);
  let dx = p.x - activeStone.x;
  let dy = p.y - activeStone.y;
  [dx, dy] = clampPull(dx, dy);
  pullDX = dx;
  pullDY = dy;
  e.preventDefault();
  draw();
}

function onPointerUp(e: PointerEvent): void {
  if (!isPulling) return;
  if (pointerId !== null && e.pointerId !== pointerId) return;
  // Reject forward-only pulls (stones can only travel toward the house).
  if (pullDY < MIN_FIRE_PULL * 0.5) {
    isPulling = false;
    pullDX = 0;
    pullDY = 0;
    pointerId = null;
    draw();
    return;
  }
  tryFire();
  draw();
}

function onPointerCancel(): void {
  isPulling = false;
  pullDX = 0;
  pullDY = 0;
  pointerId = null;
  draw();
}

function onKey(e: KeyboardEvent): void {
  const k = e.key;
  if (k === 'r' || k === 'R') {
    reset();
    e.preventDefault();
    return;
  }
  if ((k === ' ' || k === 'Enter') && (state === 'ready' || state === 'roundOver')) {
    if (state === 'ready') {
      startSession();
    } else {
      nextRound();
    }
    e.preventDefault();
  }
}

// ---- Init ----

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  roundEl = document.querySelector<HTMLElement>('#round')!;
  throwsEl = document.querySelector<HTMLElement>('#throws')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayAction = document.querySelector<HTMLButtonElement>('#overlay-action')!;

  best = loadBest();

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);

  restartBtn.addEventListener('click', reset);
  overlayAction.addEventListener('click', () => {
    if (state === 'ready') {
      startSession();
    } else if (state === 'roundOver') {
      nextRound();
    }
  });

  window.addEventListener('keydown', onKey);

  reset();
}

export const game = defineGame({ init, reset });
