import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import {
  showOverlay as showOverlayEl,
  hideOverlay as hideOverlayEl,
} from '@shared/overlay';

type State = 'ready' | 'playing' | 'levelDone' | 'gameDone';

interface Candle {
  x: number;
  baseY: number;
  height: number;
  width: number;
  maxHp: number;
  hp: number;
  bend: number;
  bendVel: number;
  flickerSeed: number;
  outAt: number;
}

interface Wall {
  x: number;
  y: number;
  w: number;
  h: number;
}

type ParticleKind = 'breath' | 'smoke';

interface Particle {
  kind: ParticleKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
}

interface LevelDef {
  candles: Array<{ x: number; height?: number; hp?: number }>;
  walls?: Wall[];
}

const STORAGE_BEST = 'mum-sondur.best';

const W = 720;
const H = 420;
const CAKE_TOP = 340;
const MAX_DRAG = 220;
const CONE_HALF_ANGLE = Math.PI / 5;
const MAX_RANGE = 360;
const DAMAGE_SCALE = 110;
const TAN_CONE = Math.tan(CONE_HALF_ANGLE);

const LEVELS: LevelDef[] = [
  {
    candles: [{ x: 220 }, { x: 320 }, { x: 420 }, { x: 520 }],
  },
  {
    candles: [{ x: 170 }, { x: 270 }, { x: 370 }, { x: 470 }, { x: 570 }],
  },
  {
    candles: [
      { x: 140 },
      { x: 220 },
      { x: 305 },
      { x: 420 },
      { x: 505 },
      { x: 585 },
    ],
    walls: [{ x: 360, y: 250, w: 14, h: 90 }],
  },
  {
    candles: [
      { x: 120 },
      { x: 205 },
      { x: 295, height: 88, hp: 170 },
      { x: 395 },
      { x: 485 },
      { x: 570 },
      { x: 640 },
    ],
    walls: [
      { x: 165, y: 250, w: 12, h: 90 },
      { x: 530, y: 250, w: 12, h: 90 },
    ],
  },
  {
    candles: [
      { x: 105 },
      { x: 180 },
      { x: 255, height: 84, hp: 150 },
      { x: 345 },
      { x: 440, height: 84, hp: 150 },
      { x: 530 },
      { x: 605 },
      { x: 660 },
    ],
    walls: [
      { x: 140, y: 250, w: 12, h: 90 },
      { x: 485, y: 230, w: 12, h: 110 },
    ],
  },
];

const TOTAL_CANDLES = LEVELS.reduce((s, l) => s + l.candles.length, 0);

const gen = createGenToken();

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let levelEl!: HTMLElement;
let puffEl!: HTMLElement;
let totalEl!: HTMLElement;
let bestEl!: HTMLElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let startBtn!: HTMLButtonElement;
let restartBtn!: HTMLButtonElement;

let state: State = 'ready';
let levelIdx = 0;
let puffsThisLevel = 0;
let totalPuffs = 0;
let best: number | null = null;
let candles: Candle[] = [];
let walls: Wall[] = [];
let particles: Particle[] = [];

let dragging = false;
let dragStartX = 0;
let dragStartY = 0;
let dragX = 0;
let dragY = 0;

let rafId = 0;
let lastFrame = 0;
let levelDoneAt = 0;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function fmtBest(): string {
  return best === null ? '—' : String(best);
}

function updateHud(): void {
  levelEl.textContent = `${levelIdx + 1}/${LEVELS.length}`;
  puffEl.textContent = String(puffsThisLevel);
  totalEl.textContent = String(totalPuffs);
  bestEl.textContent = fmtBest();
}

function loadLevel(idx: number): void {
  const lvl = LEVELS[idx]!;
  candles = lvl.candles.map((c) => ({
    x: c.x,
    baseY: CAKE_TOP,
    height: c.height ?? 60,
    width: 14,
    maxHp: c.hp ?? 100,
    hp: c.hp ?? 100,
    bend: 0,
    bendVel: 0,
    flickerSeed: Math.random() * 1000,
    outAt: -1,
  }));
  walls = (lvl.walls ?? []).map((w) => ({ ...w }));
  particles = [];
  puffsThisLevel = 0;
}

function showOverlay(title: string, msg: string, buttonText: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  startBtn.textContent = buttonText;
  showOverlayEl(overlay);
}

function hideOverlay(): void {
  hideOverlayEl(overlay);
}

function reset(): void {
  gen.bump();
  levelIdx = 0;
  totalPuffs = 0;
  puffsThisLevel = 0;
  dragging = false;
  particles = [];
  loadLevel(0);
  state = 'ready';
  updateHud();
  showOverlay(
    'Mum Söndür',
    `${LEVELS.length} seviye, ${TOTAL_CANDLES} mum.\nSürükle ve bırak: nefes ver.\nAçın ve mesafen önemli — en az nefeste hepsini söndür.`,
    'Başla',
  );
}

function startGame(): void {
  levelIdx = 0;
  totalPuffs = 0;
  loadLevel(0);
  state = 'playing';
  updateHud();
  hideOverlay();
}

function advanceLevel(): void {
  if (levelIdx + 1 < LEVELS.length) {
    levelIdx++;
    loadLevel(levelIdx);
    state = 'playing';
    updateHud();
  } else {
    completeGame();
  }
}

function completeGame(): void {
  state = 'gameDone';
  let improved = false;
  if (best === null || totalPuffs < best) {
    best = totalPuffs;
    safeWrite(STORAGE_BEST, best);
    improved = true;
  }
  updateHud();
  const tail = improved
    ? `Yeni rekor: ${best} nefes!`
    : `En iyi: ${fmtBest()} nefes.`;
  showOverlay(
    'Tüm mumlar söndü!',
    `Toplam ${totalPuffs} nefes harcadın.\n${tail}\nDilek tut, tekrar dene.`,
    'Tekrar oyna',
  );
}

function lineHitsRect(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  rx: number,
  ry: number,
  rw: number,
  rh: number,
): boolean {
  let tmin = 0;
  let tmax = 1;
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (Math.abs(dx) < 1e-9) {
    if (x1 < rx || x1 > rx + rw) return false;
  } else {
    const inv = 1 / dx;
    let t1 = (rx - x1) * inv;
    let t2 = (rx + rw - x1) * inv;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return false;
  }
  if (Math.abs(dy) < 1e-9) {
    if (y1 < ry || y1 > ry + rh) return false;
  } else {
    const inv = 1 / dy;
    let t1 = (ry - y1) * inv;
    let t2 = (ry + rh - y1) * inv;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return false;
  }
  return true;
}

function applyBreath(sx: number, sy: number, ex: number, ey: number): void {
  const vx = ex - sx;
  const vy = ey - sy;
  const len = Math.hypot(vx, vy);
  if (len < 12) return;
  const strength = clamp(len, 0, MAX_DRAG) / MAX_DRAG;
  const dx = vx / len;
  const dy = vy / len;
  const perpX = -dy;
  const perpY = dx;

  puffsThisLevel++;
  totalPuffs++;
  updateHud();

  for (let i = 0; i < 22; i++) {
    const d = Math.random() * MAX_RANGE * 0.45 * strength;
    const lateralFrac = (Math.random() - 0.5) * 2;
    const lateral = d * TAN_CONE * lateralFrac;
    particles.push({
      kind: 'breath',
      x: sx + dx * d + perpX * lateral,
      y: sy + dy * d + perpY * lateral,
      vx: dx * (90 + Math.random() * 110) + perpX * lateral * 0.4,
      vy: dy * (90 + Math.random() * 110) + perpY * lateral * 0.4,
      life: 0,
      maxLife: 320 + Math.random() * 180,
      size: 3 + Math.random() * 3,
    });
  }

  for (const c of candles) {
    if (c.outAt >= 0) continue;
    const cx = c.x;
    const cy = c.baseY - c.height;
    const ox = cx - sx;
    const oy = cy - sy;
    const pAlong = ox * dx + oy * dy;
    if (pAlong <= 0 || pAlong > MAX_RANGE) continue;
    const pPerpAbs = Math.abs(ox * perpX + oy * perpY);
    const maxLat = Math.max(28, pAlong * TAN_CONE);
    if (pPerpAbs > maxLat) continue;

    let blocked = false;
    for (const w of walls) {
      if (lineHitsRect(sx, sy, cx, cy + 6, w.x, w.y, w.w, w.h)) {
        blocked = true;
        break;
      }
    }
    if (blocked) continue;

    const damage =
      strength *
      (1 - pAlong / MAX_RANGE) *
      (1 - pPerpAbs / maxLat) *
      DAMAGE_SCALE;
    c.hp -= damage;
    c.bendVel += dx * strength * 7;

    if (c.hp <= 0) {
      c.hp = 0;
      c.outAt = performance.now();
      for (let i = 0; i < 9; i++) {
        particles.push({
          kind: 'smoke',
          x: cx + (Math.random() - 0.5) * 6,
          y: cy + (Math.random() - 0.5) * 6,
          vx: (Math.random() - 0.5) * 30,
          vy: -25 - Math.random() * 25,
          life: 0,
          maxLife: 700 + Math.random() * 300,
          size: 5 + Math.random() * 4,
        });
      }
    }
  }

  const allOut = candles.every((c) => c.outAt >= 0);
  if (allOut) {
    state = 'levelDone';
    levelDoneAt = performance.now();
  }
}

function tick(now: number): void {
  const dt = lastFrame === 0 ? 0.016 : Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;

  for (const c of candles) {
    c.bendVel += (-c.bend * 28 - c.bendVel * 5) * dt;
    c.bend += c.bendVel * dt;
  }

  for (const p of particles) {
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    if (p.kind === 'smoke') {
      p.vy -= 18 * dt;
      p.vx *= Math.pow(0.6, dt);
    } else {
      const decay = Math.pow(0.35, dt);
      p.vx *= decay;
      p.vy *= decay;
    }
    p.life += dt * 1000;
  }
  particles = particles.filter((p) => p.life < p.maxLife);

  if (state === 'levelDone' && now - levelDoneAt > 1400) {
    advanceLevel();
  }

  draw(now);
  rafId = requestAnimationFrame(tick);
}

function roundRect(x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

function draw(now: number): void {
  ctx.fillStyle = '#0e1118';
  ctx.fillRect(0, 0, W, H);

  const bgGrad = ctx.createRadialGradient(
    W / 2,
    CAKE_TOP - 40,
    20,
    W / 2,
    CAKE_TOP - 40,
    360,
  );
  bgGrad.addColorStop(0, 'rgba(255, 170, 80, 0.06)');
  bgGrad.addColorStop(1, 'rgba(255, 170, 80, 0)');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  ctx.beginPath();
  ctx.ellipse(W / 2, H - 14, W * 0.42, 10, 0, 0, Math.PI * 2);
  ctx.fill();

  const cake = ctx.createLinearGradient(0, CAKE_TOP, 0, H);
  cake.addColorStop(0, '#6b4423');
  cake.addColorStop(0.5, '#553219');
  cake.addColorStop(1, '#2f1b0c');
  ctx.fillStyle = cake;
  roundRect(60, CAKE_TOP, W - 120, H - CAKE_TOP - 8, 12);
  ctx.fill();

  ctx.fillStyle = '#f9d2a8';
  roundRect(60, CAKE_TOP - 2, W - 120, 10, 4);
  ctx.fill();

  ctx.fillStyle = '#f9d2a8';
  for (let i = 0; i < 14; i++) {
    const x = 80 + i * ((W - 160) / 13);
    const h = 8 + ((i * 13) % 7);
    ctx.beginPath();
    ctx.moveTo(x - 4, CAKE_TOP + 8);
    ctx.quadraticCurveTo(x, CAKE_TOP + 8 + h, x + 4, CAKE_TOP + 8);
    ctx.closePath();
    ctx.fill();
  }

  for (const w of walls) {
    const g = ctx.createLinearGradient(w.x, w.y, w.x + w.w, w.y);
    g.addColorStop(0, '#3a4658');
    g.addColorStop(0.5, '#5a6a82');
    g.addColorStop(1, '#3a4658');
    ctx.fillStyle = g;
    roundRect(w.x, w.y, w.w, w.h, 3);
    ctx.fill();
    ctx.fillStyle = '#8aa0c0';
    ctx.fillRect(w.x, w.y, w.w, 3);
  }

  for (const c of candles) drawCandle(c, now);

  for (const p of particles) {
    const t = p.life / p.maxLife;
    const alpha = (1 - t) * (p.kind === 'breath' ? 0.55 : 0.45);
    ctx.fillStyle =
      p.kind === 'breath'
        ? `rgba(220, 235, 255, ${alpha.toFixed(3)})`
        : `rgba(170, 170, 180, ${alpha.toFixed(3)})`;
    const r = p.size * (p.kind === 'smoke' ? 1 + t * 1.3 : 1);
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  if (dragging && state === 'playing') {
    drawDragIndicator(dragStartX, dragStartY, dragX, dragY);
  }

  if (state === 'levelDone') {
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#f8e3b3';
    ctx.font = '700 28px system-ui, sans-serif';
    ctx.textAlign = 'center';
    const title =
      levelIdx + 1 < LEVELS.length
        ? `Seviye ${levelIdx + 1} bitti`
        : 'Son seviye!';
    ctx.fillText(title, W / 2, H / 2 - 6);
    ctx.fillStyle = '#cbb98a';
    ctx.font = '500 16px system-ui, sans-serif';
    ctx.fillText(
      `${puffsThisLevel} nefes · toplam ${totalPuffs}`,
      W / 2,
      H / 2 + 22,
    );
  }
}

function drawCandle(c: Candle, now: number): void {
  const cx = c.x;
  const top = c.baseY - c.height + 4;
  const bottom = c.baseY + 6;
  const isOut = c.outAt >= 0;

  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.beginPath();
  ctx.ellipse(cx, c.baseY + 7, c.width * 0.6, 3, 0, 0, Math.PI * 2);
  ctx.fill();

  const wax = ctx.createLinearGradient(
    cx - c.width / 2,
    top,
    cx + c.width / 2,
    top,
  );
  if (isOut) {
    wax.addColorStop(0, '#a99b86');
    wax.addColorStop(1, '#7a6c58');
  } else if (c.maxHp > 100) {
    wax.addColorStop(0, '#ffc9a3');
    wax.addColorStop(1, '#d3895b');
  } else {
    wax.addColorStop(0, '#f5e5c2');
    wax.addColorStop(1, '#cdb887');
  }
  ctx.fillStyle = wax;
  ctx.fillRect(cx - c.width / 2, top, c.width, bottom - top);

  ctx.fillStyle = isOut ? '#867460' : '#ecd9b2';
  ctx.beginPath();
  ctx.ellipse(cx, top, c.width / 2, 3, 0, 0, Math.PI * 2);
  ctx.fill();

  const wickTop = top - 8;
  ctx.strokeStyle = isOut ? '#1a1410' : '#322217';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(cx, top - 1);
  ctx.lineTo(cx, wickTop);
  ctx.stroke();

  if (!isOut && c.hp < c.maxHp) {
    const frac = c.hp / c.maxHp;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(cx - c.width / 2 - 1, top - 4, c.width + 2, 3);
    ctx.fillStyle =
      frac > 0.5 ? '#7be084' : frac > 0.25 ? '#f0c84a' : '#e55d4c';
    ctx.fillRect(cx - c.width / 2, top - 3, c.width * frac, 1);
  }

  if (!isOut) drawFlame(cx, wickTop, c.hp / c.maxHp, c.bend, c.flickerSeed, now);
}

function drawFlame(
  cx: number,
  cy: number,
  hpFrac: number,
  bend: number,
  seed: number,
  now: number,
): void {
  const flicker = 0.85 + 0.15 * Math.sin(now / 80 + seed);
  const scale = (0.55 + 0.45 * hpFrac) * flicker;
  const h = 22 * scale;
  const w = 9 * scale;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(bend);

  const glow = ctx.createRadialGradient(0, -h * 0.5, 0, 0, -h * 0.5, h * 2.2);
  glow.addColorStop(0, `rgba(255, 200, 90, ${(0.35 * hpFrac).toFixed(3)})`);
  glow.addColorStop(1, 'rgba(255, 200, 90, 0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(0, -h * 0.5, h * 2, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#ff8a2a';
  ctx.beginPath();
  ctx.moveTo(0, -h * 1.15);
  ctx.quadraticCurveTo(w, -h * 0.6, w * 0.85, -h * 0.1);
  ctx.quadraticCurveTo(w * 0.6, h * 0.05, 0, h * 0.05);
  ctx.quadraticCurveTo(-w * 0.6, h * 0.05, -w * 0.85, -h * 0.1);
  ctx.quadraticCurveTo(-w, -h * 0.6, 0, -h * 1.15);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = '#ffd86b';
  ctx.beginPath();
  ctx.ellipse(0, -h * 0.4, w * 0.5, h * 0.55, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#7ec0ff';
  ctx.beginPath();
  ctx.ellipse(0, 0, w * 0.4, 3, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

function drawDragIndicator(sx: number, sy: number, ex: number, ey: number): void {
  const vx = ex - sx;
  const vy = ey - sy;
  const len = Math.hypot(vx, vy);
  if (len < 6) {
    ctx.fillStyle = '#cce4ff';
    ctx.beginPath();
    ctx.arc(sx, sy, 5, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  const strength = clamp(len, 0, MAX_DRAG) / MAX_DRAG;
  const dx = vx / len;
  const dy = vy / len;
  const perpX = -dy;
  const perpY = dx;
  const reach = MAX_RANGE * strength;
  const halfWidth = reach * TAN_CONE;

  ctx.fillStyle = `rgba(120, 200, 255, ${(0.07 + 0.18 * strength).toFixed(3)})`;
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  ctx.lineTo(
    sx + dx * reach + perpX * halfWidth,
    sy + dy * reach + perpY * halfWidth,
  );
  ctx.lineTo(
    sx + dx * reach - perpX * halfWidth,
    sy + dy * reach - perpY * halfWidth,
  );
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = `rgba(180, 220, 255, ${(0.4 + 0.4 * strength).toFixed(3)})`;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  ctx.lineTo(ex, ey);
  ctx.stroke();

  ctx.fillStyle = '#cce4ff';
  ctx.beginPath();
  ctx.arc(sx, sy, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(ex, ey, 4, 0, Math.PI * 2);
  ctx.fill();
}

function getCoords(e: PointerEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) * (canvas.width / rect.width),
    y: (e.clientY - rect.top) * (canvas.height / rect.height),
  };
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  levelEl = document.querySelector<HTMLElement>('#level')!;
  puffEl = document.querySelector<HTMLElement>('#puffs')!;
  totalEl = document.querySelector<HTMLElement>('#total')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  startBtn = document.querySelector<HTMLButtonElement>('#start')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;

  const stored = safeRead<number | null>(STORAGE_BEST, null);
  best = typeof stored === 'number' && stored > 0 ? stored : null;

  canvas.addEventListener('pointerdown', (e) => {
    if (state !== 'playing') return;
    canvas.setPointerCapture(e.pointerId);
    const { x, y } = getCoords(e);
    dragging = true;
    dragStartX = x;
    dragStartY = y;
    dragX = x;
    dragY = y;
    e.preventDefault();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const { x, y } = getCoords(e);
    dragX = x;
    dragY = y;
  });

  function endDrag(e: PointerEvent): void {
    if (!dragging) return;
    const { x, y } = getCoords(e);
    dragX = x;
    dragY = y;
    dragging = false;
    if (state === 'playing') {
      applyBreath(dragStartX, dragStartY, dragX, dragY);
    }
  }
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('pointerleave', (e) => {
    if (dragging && state === 'playing') {
      endDrag(e);
    }
  });

  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'r') {
      reset();
      e.preventDefault();
      return;
    }
    if (state === 'ready' || state === 'gameDone') {
      if (e.key === ' ' || e.key === 'Enter') {
        startGame();
        e.preventDefault();
      }
      return;
    }
    if (state === 'playing' && k === 'n') {
      for (const c of candles) {
        if (c.outAt < 0) {
          c.hp = 0;
          c.outAt = performance.now();
        }
      }
      state = 'levelDone';
      levelDoneAt = performance.now();
      e.preventDefault();
    }
  });

  startBtn.addEventListener('click', () => {
    if (state === 'ready' || state === 'gameDone') startGame();
  });
  restartBtn.addEventListener('click', reset);

  reset();
  rafId = requestAnimationFrame(tick);
  void rafId;
}

export const game = defineGame({ init, reset });
