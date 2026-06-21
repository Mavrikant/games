import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import {
  showOverlay as showOverlayEl,
  hideOverlay as hideOverlayEl,
} from '@shared/overlay';

type State = 'ready' | 'playing' | 'paused' | 'won' | 'lost';

interface Lamp {
  x: number;
  on: boolean;
  radius: number;
}

interface Pothole {
  x: number;
  width: number;
}

const STORAGE_KEY = 'sokak-lambasi.best';
const LAMP_COUNT = 9;
const LAMP_RADIUS_BASE = 70;
const LAMP_Y = 110;
const ROAD_Y = 240;
const ROAD_H = 60;
const BIKE_SPEED_BASE = 56;
const BUDGET_BASE = 30;
const POTHOLE_MIN = 4;
const POTHOLE_MAX = 7;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let budgetEl!: HTMLElement;
let bestEl!: HTMLElement;
let levelEl!: HTMLElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let restartBtn!: HTMLButtonElement;

let state: State = 'ready';
let level = 1;
let best = 0;
let budget = BUDGET_BASE;
let totalScore = 0;
let lamps: Lamp[] = [];
let potholes: Pothole[] = [];
let bikeX = 0;
let bikePulseT = 0;
let rafHandle: number | null = null;
let lastT = 0;
let goalX = 0;

const cssCache = new Map<string, string>();
function getCss(name: string): string {
  const cached = cssCache.get(name);
  if (cached !== undefined) return cached;
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  cssCache.set(name, v);
  return v;
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlay);
}

function hideOverlay(): void {
  hideOverlayEl(overlay);
}

function lampSpacing(): number {
  return (canvas.width - 80) / (LAMP_COUNT - 1);
}

function buildLevel(n: number): void {
  lamps = [];
  const spacing = lampSpacing();
  const radius = LAMP_RADIUS_BASE + Math.max(0, 4 - n) * 2;
  for (let i = 0; i < LAMP_COUNT; i++) {
    lamps.push({ x: 40 + i * spacing, on: false, radius });
  }

  potholes = [];
  const target =
    Math.min(POTHOLE_MAX, POTHOLE_MIN + Math.floor((n - 1) / 1.5));
  const playStart = 60;
  const playEnd = canvas.width - 100;
  const tries = 60;
  let placed = 0;
  let attempt = 0;
  while (placed < target && attempt < tries) {
    attempt++;
    const w = rand(22, 36);
    const x = rand(playStart, playEnd - w);
    let overlaps = false;
    for (const p of potholes) {
      if (x < p.x + p.width + 28 && x + w + 28 > p.x) {
        overlaps = true;
        break;
      }
    }
    if (overlaps) continue;
    potholes.push({ x, width: w });
    placed++;
  }
  potholes.sort((a, b) => a.x - b.x);

  bikeX = 16;
  goalX = canvas.width - 24;
  bikePulseT = 0;
}

function startBudgetFor(n: number): number {
  return BUDGET_BASE + (n - 1) * 6;
}

function startLevel(n: number): void {
  level = n;
  levelEl.textContent = String(n);
  budget = startBudgetFor(n);
  budgetEl.textContent = budget.toFixed(1);
  buildLevel(n);
  state = 'playing';
  hideOverlay();
}

function readyLevel(n: number): void {
  level = n;
  levelEl.textContent = String(n);
  budget = startBudgetFor(n);
  budgetEl.textContent = budget.toFixed(0);
  buildLevel(n);
  state = 'ready';
  const tip =
    n === 1
      ? 'Lambalara tıklayarak ışığı aç. Bisikletli ışık altında çukurdan zarar görmez.'
      : `Seviye ${n}: ${potholes.length} çukur, bütçe ${Math.round(budget)} birim.`;
  showOverlay(
    `Seviye ${n} hazır`,
    `${tip}\nBaşlamak için tıkla ya da Boşluk'a bas.`,
  );
}

function reset(): void {
  state = 'ready';
  level = 1;
  totalScore = 0;
  readyLevel(1);
}

function bikeOver(x: number): Pothole | null {
  for (const p of potholes) {
    if (x >= p.x && x <= p.x + p.width) return p;
  }
  return null;
}

function isCovered(x: number): boolean {
  for (const lamp of lamps) {
    if (!lamp.on) continue;
    const dx = x - lamp.x;
    if (dx >= -lamp.radius && dx <= lamp.radius) {
      const cone = coneWidthAt(lamp, ROAD_Y);
      if (Math.abs(dx) <= cone) return true;
    }
  }
  return false;
}

function coneWidthAt(lamp: Lamp, atY: number): number {
  const dy = atY - LAMP_Y;
  if (dy <= 0) return 6;
  const fall = (atY - LAMP_Y) / (ROAD_Y + ROAD_H - LAMP_Y);
  return Math.max(8, lamp.radius * (0.35 + 0.65 * fall));
}

function loseLevel(reason: 'pit' | 'budget'): void {
  state = 'lost';
  if (totalScore > best) {
    best = totalScore;
    safeWrite(STORAGE_KEY, best);
    bestEl.textContent = String(best);
  }
  const title = reason === 'pit' ? 'Bisikletli çukura düştü!' : 'Elektrik bitti!';
  const msg =
    reason === 'pit'
      ? `Karanlık bir çukur bisikletliyi yere serdi.\nToplam skor: ${totalScore}\nR ile yeniden başla.`
      : `Bütçe sıfırlandı, sokak karanlığa gömüldü.\nToplam skor: ${totalScore}\nR ile yeniden başla.`;
  showOverlay(title, msg);
}

function winLevel(): void {
  const bonus = Math.max(0, Math.round(budget * 10));
  totalScore += bonus + level * 5;
  if (totalScore > best) {
    best = totalScore;
    safeWrite(STORAGE_KEY, best);
    bestEl.textContent = String(best);
  }
  state = 'won';
  showOverlay(
    `Seviye ${level} bitti`,
    `Kalan bütçe bonusu: +${bonus}\nToplam skor: ${totalScore}\nSonraki seviyeye geçmek için tıkla ya da Boşluk'a bas.`,
  );
}

function drawRoad(): void {
  ctx.fillStyle = '#0a0c11';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = '#0f1320';
  ctx.fillRect(0, 0, canvas.width, ROAD_Y);

  ctx.fillStyle = getCss('--road-mid') || '#161922';
  ctx.fillRect(0, ROAD_Y, canvas.width, ROAD_H);

  ctx.strokeStyle = '#2a2f3e';
  ctx.lineWidth = 2;
  ctx.setLineDash([14, 12]);
  ctx.beginPath();
  ctx.moveTo(0, ROAD_Y + ROAD_H / 2);
  ctx.lineTo(canvas.width, ROAD_Y + ROAD_H / 2);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = '#1b2230';
  ctx.fillRect(0, ROAD_Y + ROAD_H, canvas.width, canvas.height - ROAD_Y - ROAD_H);
}

function drawLampPosts(): void {
  for (const lamp of lamps) {
    ctx.strokeStyle = '#2a2f3a';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(lamp.x, LAMP_Y);
    ctx.lineTo(lamp.x, ROAD_Y);
    ctx.stroke();

    ctx.fillStyle = '#1c2230';
    ctx.fillRect(lamp.x - 10, LAMP_Y - 8, 20, 10);

    ctx.fillStyle = lamp.on ? getCss('--lamp-warm') || '#fbbf24' : '#3a4154';
    ctx.beginPath();
    ctx.arc(lamp.x, LAMP_Y + 4, 6, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawLampCones(): void {
  for (const lamp of lamps) {
    if (!lamp.on) continue;
    const grad = ctx.createRadialGradient(
      lamp.x,
      LAMP_Y + 4,
      4,
      lamp.x,
      LAMP_Y + 4,
      lamp.radius * 1.8,
    );
    grad.addColorStop(0, 'rgba(251, 191, 36, 0.55)');
    grad.addColorStop(0.6, 'rgba(251, 191, 36, 0.18)');
    grad.addColorStop(1, 'rgba(251, 191, 36, 0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    const topY = LAMP_Y + 4;
    const botY = ROAD_Y + ROAD_H + 8;
    const topW = 4;
    const botW = lamp.radius;
    ctx.moveTo(lamp.x - topW, topY);
    ctx.lineTo(lamp.x + topW, topY);
    ctx.lineTo(lamp.x + botW, botY);
    ctx.lineTo(lamp.x - botW, botY);
    ctx.closePath();
    ctx.fill();
  }
}

function drawPotholes(): void {
  for (const p of potholes) {
    const covered = isCovered(p.x + p.width / 2);
    ctx.fillStyle = covered
      ? getCss('--pothole-warn') || '#f97316'
      : '#1f1410';
    ctx.beginPath();
    ctx.ellipse(
      p.x + p.width / 2,
      ROAD_Y + ROAD_H / 2,
      p.width / 2,
      ROAD_H / 2.6,
      0,
      0,
      Math.PI * 2,
    );
    ctx.fill();
    if (!covered) {
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.ellipse(
        p.x + p.width / 2,
        ROAD_Y + ROAD_H / 2 + 2,
        p.width / 2 - 4,
        ROAD_H / 3,
        0,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    } else {
      ctx.strokeStyle = 'rgba(249, 115, 22, 0.8)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }
}

function drawBike(): void {
  const y = ROAD_Y + ROAD_H / 2;
  const pulse = 1 + Math.sin(bikePulseT * 6) * 0.06;

  ctx.save();
  ctx.translate(bikeX, y);

  ctx.fillStyle = '#2a2f3a';
  ctx.beginPath();
  ctx.arc(-7, 7, 6 * pulse, 0, Math.PI * 2);
  ctx.arc(7, 7, 6 * pulse, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = '#94a3b8';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-7, 7);
  ctx.lineTo(0, -2);
  ctx.lineTo(7, 7);
  ctx.moveTo(0, -2);
  ctx.lineTo(2, -8);
  ctx.stroke();

  ctx.fillStyle = '#e2e8f0';
  ctx.beginPath();
  ctx.arc(2, -12, 4, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

function drawGoal(): void {
  ctx.fillStyle = '#22c55e';
  ctx.fillRect(goalX - 3, ROAD_Y - 6, 6, ROAD_H + 12);
  ctx.fillStyle = 'rgba(34, 197, 94, 0.18)';
  ctx.fillRect(goalX - 16, ROAD_Y - 6, 32, ROAD_H + 12);
}

function drawFog(): void {
  const grad = ctx.createLinearGradient(0, ROAD_Y - 24, 0, ROAD_Y + ROAD_H + 8);
  grad.addColorStop(0, 'rgba(10, 12, 20, 0.0)');
  grad.addColorStop(0.5, 'rgba(20, 24, 36, 0.0)');
  grad.addColorStop(1, 'rgba(15, 18, 28, 0.45)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, ROAD_Y - 24, canvas.width, ROAD_H + 32);
}

function draw(): void {
  drawRoad();
  drawLampCones();
  drawLampPosts();
  drawGoal();
  drawPotholes();
  drawFog();
  drawBike();
}

function loop(t: number): void {
  const dt = Math.min(0.05, (t - lastT) / 1000);
  lastT = t;

  if (state === 'playing') {
    bikePulseT += dt;
    bikeX += BIKE_SPEED_BASE * dt;

    let activeLamps = 0;
    for (const lamp of lamps) if (lamp.on) activeLamps++;
    if (activeLamps > 0) {
      budget = Math.max(0, budget - activeLamps * dt);
      budgetEl.textContent = budget.toFixed(1);
      if (budget <= 0) {
        for (const lamp of lamps) lamp.on = false;
        budget = 0;
        budgetEl.textContent = '0';
      }
    }

    const hit = bikeOver(bikeX);
    if (hit && !isCovered(bikeX)) {
      draw();
      loseLevel('pit');
      rafHandle = requestAnimationFrame(loop);
      return;
    }

    if (bikeX >= goalX) {
      winLevel();
    }
  }

  draw();
  rafHandle = requestAnimationFrame(loop);
}

function toggleLampAtCanvas(cx: number, cy: number): void {
  if (state !== 'playing') return;
  let nearest: Lamp | null = null;
  let nd = Infinity;
  for (const lamp of lamps) {
    const dx = cx - lamp.x;
    const dy = cy - (LAMP_Y + 4);
    const d2 = dx * dx + dy * dy;
    if (d2 < nd) {
      nd = d2;
      nearest = lamp;
    }
  }
  if (nearest === null) return;
  if (nd > 60 * 60) return;
  if (!nearest.on && budget <= 0) return;
  nearest.on = !nearest.on;
}

function pointerCanvasPos(e: PointerEvent): { x: number; y: number } {
  const r = canvas.getBoundingClientRect();
  const sx = canvas.width / r.width;
  const sy = canvas.height / r.height;
  return { x: (e.clientX - r.left) * sx, y: (e.clientY - r.top) * sy };
}

function handleStateAdvance(): void {
  if (state === 'ready') {
    state = 'playing';
    hideOverlay();
  } else if (state === 'won') {
    startLevel(level + 1);
  } else if (state === 'lost') {
    reset();
  } else if (state === 'paused') {
    state = 'playing';
    hideOverlay();
  }
}

function onCanvasPointer(e: PointerEvent): void {
  e.preventDefault();
  if (state !== 'playing') {
    handleStateAdvance();
    return;
  }
  const p = pointerCanvasPos(e);
  toggleLampAtCanvas(p.x, p.y);
}

function onOverlayPointer(e: PointerEvent): void {
  e.preventDefault();
  handleStateAdvance();
}

function onKey(e: KeyboardEvent): void {
  const k = e.key.toLowerCase();
  if (k === 'r') {
    reset();
    e.preventDefault();
    return;
  }
  if (k === ' ' || k === 'enter') {
    if (state === 'playing') {
      state = 'paused';
      showOverlay('Durdu', 'Devam etmek için tıkla ya da Boşluk\'a bas.');
    } else {
      handleStateAdvance();
    }
    e.preventDefault();
  }
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  budgetEl = document.querySelector<HTMLElement>('#budget')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  levelEl = document.querySelector<HTMLElement>('#level')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;

  best = safeRead<number>(STORAGE_KEY, 0);
  bestEl.textContent = String(best);

  canvas.addEventListener('pointerdown', onCanvasPointer);
  overlay.addEventListener('pointerdown', onOverlayPointer);
  window.addEventListener('keydown', onKey);
  restartBtn.addEventListener('click', () => {
    reset();
  });

  reset();
  lastT = performance.now();
  rafHandle = requestAnimationFrame(loop);
}

export const game = defineGame({ init, reset });
