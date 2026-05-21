import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';

type GameState = 'ready' | 'playing' | 'gameover';

interface Passenger {
  id: number;
  fromFloor: number;
  toFloor: number;
  patience: number;
  totalPatience: number;
  riding: boolean;
  colorVar: string;
}

const FLOORS = 5;
const CANVAS_W = 480;
const CANVAS_H = 640;
const TOP_PAD = 36;
const BOTTOM_PAD = 36;
const FLOOR_H = (CANVAS_H - TOP_PAD - BOTTOM_PAD) / FLOORS;
const SHAFT_X = 200;
const SHAFT_W = 90;
const ELEVATOR_SPEED = 220;
const CAPACITY = 3;
const STORAGE_BEST = 'lift.best';

const COLOR_VARS = [
  '--lift-p1',
  '--lift-p2',
  '--lift-p3',
  '--lift-p4',
  '--lift-p5',
];

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let floorEl!: HTMLElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let restartBtn!: HTMLButtonElement;

let state: GameState = 'ready';
let elevatorY = 0;
let targetFloor = 1;
let score = 0;
let best = 0;
let waiting: Passenger[] = [];
let riding: Passenger[] = [];
let nextPassengerId = 1;
let spawnTimerMs = 0;
let lastFrameTime = 0;

function loadBest(): number {
  const v = safeRead<number>(STORAGE_BEST, 0);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

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

function floorToY(floor: number): number {
  return CANVAS_H - BOTTOM_PAD - (floor - 1) * FLOOR_H - FLOOR_H / 2;
}

function currentFloor(): number {
  for (let f = 1; f <= FLOORS; f++) {
    if (Math.abs(elevatorY - floorToY(f)) < 1) return f;
  }
  return 0;
}

function nearestFloor(): number {
  let nearest = 1;
  let nearestDist = Infinity;
  for (let f = 1; f <= FLOORS; f++) {
    const d = Math.abs(elevatorY - floorToY(f));
    if (d < nearestDist) {
      nearestDist = d;
      nearest = f;
    }
  }
  return nearest;
}

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlay);
}

function hideOverlay(): void {
  hideOverlayEl(overlay);
}

function patienceForScore(s: number): number {
  if (s < 5) return 16;
  if (s < 15) return 13;
  if (s < 30) return 11;
  return 9;
}

function spawnIntervalForScore(s: number): number {
  if (s < 5) return 3800;
  if (s < 15) return 3000;
  if (s < 30) return 2400;
  return 1900;
}

function spawnPassenger(): void {
  const totalWaiting: Record<number, number> = {};
  for (const p of waiting) totalWaiting[p.fromFloor] = (totalWaiting[p.fromFloor] ?? 0) + 1;

  const candidates: number[] = [];
  for (let f = 1; f <= FLOORS; f++) {
    if ((totalWaiting[f] ?? 0) < 3) candidates.push(f);
  }
  if (candidates.length === 0) return;

  const fromFloor = candidates[Math.floor(Math.random() * candidates.length)]!;
  let toFloor = 1 + Math.floor(Math.random() * FLOORS);
  while (toFloor === fromFloor) {
    toFloor = 1 + Math.floor(Math.random() * FLOORS);
  }
  const total = patienceForScore(score);
  waiting.push({
    id: nextPassengerId++,
    fromFloor,
    toFloor,
    patience: total,
    totalPatience: total,
    riding: false,
    colorVar: COLOR_VARS[(toFloor - 1) % COLOR_VARS.length]!,
  });
}

function reset(): void {
  state = 'ready';
  elevatorY = floorToY(1);
  targetFloor = 1;
  score = 0;
  waiting = [];
  riding = [];
  nextPassengerId = 1;
  spawnTimerMs = 0;
  lastFrameTime = 0;
  scoreEl.textContent = '0';
  bestEl.textContent = String(best);
  floorEl.textContent = '1';
  showOverlay('Lift', 'Yolcuyu katından al, hedef katına bırak. Boşluk veya bir kata dokun ile başla.');
}

function startPlaying(): void {
  if (state === 'gameover') {
    reset();
  }
  if (state === 'ready') {
    state = 'playing';
    hideOverlay();
    // Spawn an initial passenger so first feedback is immediate.
    spawnPassenger();
    spawnTimerMs = spawnIntervalForScore(0);
    // If spawned at the elevator's floor, board now (otherwise they wait until arrival).
    handleArrival();
  }
}

function gameOver(): void {
  state = 'gameover';
  if (score > best) {
    best = score;
    bestEl.textContent = String(best);
    safeWrite(STORAGE_BEST, best);
  }
  showOverlay('Sabırlar tükendi', `Skor: ${score} · Tekrar için bir kata dokun veya R`);
}

function handleArrival(): void {
  const f = currentFloor();
  if (f === 0) return;

  // Drop off riding passengers whose destination is this floor.
  const stillRiding: Passenger[] = [];
  for (const p of riding) {
    if (p.toFloor === f) {
      score += 1;
      scoreEl.textContent = String(score);
      if (score > best) {
        best = score;
        bestEl.textContent = String(best);
        safeWrite(STORAGE_BEST, best);
      }
    } else {
      stillRiding.push(p);
    }
  }
  riding = stillRiding;

  // Board waiting passengers from this floor (FIFO) up to capacity.
  const remainingWaiting: Passenger[] = [];
  for (const p of waiting) {
    if (p.fromFloor === f && riding.length < CAPACITY) {
      p.riding = true;
      riding.push(p);
    } else {
      remainingWaiting.push(p);
    }
  }
  waiting = remainingWaiting;
}

function selectFloor(floor: number): void {
  if (floor < 1 || floor > FLOORS) return;
  if (state === 'gameover') {
    reset();
    targetFloor = floor;
    startPlaying();
    return;
  }
  if (state === 'ready') {
    targetFloor = floor;
    startPlaying();
    return;
  }
  targetFloor = floor;
}

function tick(dt: number): void {
  if (state !== 'playing') return;

  const targetY = floorToY(targetFloor);
  const dy = targetY - elevatorY;
  const move = (ELEVATOR_SPEED * dt) / 1000;
  if (Math.abs(dy) <= move) {
    if (elevatorY !== targetY) {
      elevatorY = targetY;
      handleArrival();
    }
  } else {
    elevatorY += Math.sign(dy) * move;
  }
  floorEl.textContent = String(nearestFloor());

  // Drain patience for both waiting and riding (riding drains slower).
  for (const p of waiting) p.patience -= dt / 1000;
  for (const p of riding) p.patience -= dt / 2000;

  for (const p of waiting) {
    if (p.patience <= 0) {
      gameOver();
      return;
    }
  }
  for (const p of riding) {
    if (p.patience <= 0) {
      gameOver();
      return;
    }
  }

  // Spawn new passengers; if elevator is idle at their floor, board now.
  spawnTimerMs -= dt;
  if (spawnTimerMs <= 0) {
    spawnPassenger();
    spawnTimerMs = spawnIntervalForScore(score);
    if (elevatorY === floorToY(targetFloor)) {
      handleArrival();
    }
  }
}

function drawBuilding(): void {
  ctx.fillStyle = getCss('--surface');
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  // Outer building outline
  ctx.strokeStyle = getCss('--border-strong');
  ctx.lineWidth = 1;
  ctx.strokeRect(20.5, TOP_PAD - 8.5, CANVAS_W - 41, CANVAS_H - TOP_PAD - BOTTOM_PAD + 16);

  // Shaft background
  ctx.fillStyle = getCss('--surface-2');
  ctx.fillRect(SHAFT_X, TOP_PAD - 8, SHAFT_W, CANVAS_H - TOP_PAD - BOTTOM_PAD + 16);
  ctx.strokeStyle = getCss('--border');
  ctx.strokeRect(SHAFT_X + 0.5, TOP_PAD - 7.5, SHAFT_W - 1, CANVAS_H - TOP_PAD - BOTTOM_PAD + 15);

  // Floor lines + labels
  ctx.font = '600 13px Inter, system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  for (let f = 1; f <= FLOORS; f++) {
    const y = floorToY(f);
    const slabY = y + FLOOR_H / 2;
    ctx.strokeStyle = getCss('--border');
    ctx.beginPath();
    ctx.moveTo(20, slabY);
    ctx.lineTo(CANVAS_W - 20, slabY);
    ctx.stroke();

    ctx.fillStyle = getCss('--text-dim');
    ctx.textAlign = 'left';
    ctx.fillText(`Kat ${f}`, 28, y);
  }
}

function drawWaitingPassengers(): void {
  // Group by floor and side (left of shaft).
  const perFloor: Record<number, Passenger[]> = {};
  for (const p of waiting) {
    (perFloor[p.fromFloor] ??= []).push(p);
  }

  for (const fStr of Object.keys(perFloor)) {
    const f = Number(fStr);
    const arr = perFloor[f]!;
    const y = floorToY(f);
    // Place passengers right side, between shaft and edge.
    const startX = SHAFT_X + SHAFT_W + 16;
    arr.forEach((p, i) => {
      const x = startX + i * 36;
      drawPassenger(x, y, p, false);
    });
  }
}

function drawPassenger(x: number, y: number, p: Passenger, inElevator: boolean): void {
  const r = 12;
  ctx.fillStyle = getCss(p.colorVar);
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.45)';
  ctx.lineWidth = 1.2;
  ctx.stroke();

  // Destination number
  ctx.fillStyle = '#0a0b0e';
  ctx.font = 'bold 12px Inter, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(p.toFloor), x, y + 1);

  // Patience bar (skip inside elevator to keep it clean)
  if (!inElevator) {
    const ratio = Math.max(0, Math.min(1, p.patience / p.totalPatience));
    const barW = 26;
    const barH = 4;
    const barX = x - barW / 2;
    const barY = y + r + 4;
    ctx.fillStyle = getCss('--border');
    ctx.fillRect(barX, barY, barW, barH);
    ctx.fillStyle =
      ratio < 0.25
        ? getCss('--lift-warn')
        : ratio < 0.55
          ? getCss('--lift-mid')
          : getCss('--accent');
    ctx.fillRect(barX, barY, barW * ratio, barH);
  }
}

function drawElevator(): void {
  const carH = FLOOR_H - 10;
  const carY = elevatorY - carH / 2;
  const carX = SHAFT_X + 6;
  const carW = SHAFT_W - 12;

  // Cables (decorative)
  ctx.strokeStyle = getCss('--border-strong');
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(carX + 12, TOP_PAD - 8);
  ctx.lineTo(carX + 12, carY);
  ctx.moveTo(carX + carW - 12, TOP_PAD - 8);
  ctx.lineTo(carX + carW - 12, carY);
  ctx.stroke();

  // Car body
  ctx.fillStyle = getCss('--surface-3');
  ctx.fillRect(carX, carY, carW, carH);
  ctx.strokeStyle = getCss('--accent');
  ctx.lineWidth = 1.5;
  ctx.strokeRect(carX + 0.5, carY + 0.5, carW - 1, carH - 1);

  // Door line
  ctx.strokeStyle = getCss('--border');
  ctx.beginPath();
  ctx.moveTo(carX + carW / 2, carY + 4);
  ctx.lineTo(carX + carW / 2, carY + carH - 4);
  ctx.stroke();

  // Riding passengers inside (small dots with number)
  const slotCount = CAPACITY;
  const slotGap = (carW - 14) / (slotCount + 1);
  riding.forEach((p, i) => {
    const px = carX + 7 + slotGap * (i + 1);
    const py = carY + carH - 14;
    drawPassenger(px, py, p, true);
  });
}

function drawTargetIndicator(): void {
  if (state !== 'playing') return;
  if (Math.abs(elevatorY - floorToY(targetFloor)) < 0.5) return;
  const y = floorToY(targetFloor);
  ctx.strokeStyle = getCss('--accent');
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(SHAFT_X - 4, y);
  ctx.lineTo(SHAFT_X + SHAFT_W + 4, y);
  ctx.stroke();
  ctx.setLineDash([]);
}

function draw(): void {
  drawBuilding();
  drawTargetIndicator();
  drawWaitingPassengers();
  drawElevator();
}

function loop(now: number): void {
  if (lastFrameTime === 0) lastFrameTime = now;
  const dt = Math.min(64, now - lastFrameTime);
  lastFrameTime = now;
  tick(dt);
  draw();
  requestAnimationFrame(loop);
}

function pickFloorFromPointer(clientY: number): number {
  const rect = canvas.getBoundingClientRect();
  const scaleY = CANVAS_H / rect.height;
  const yCanvas = (clientY - rect.top) * scaleY;
  // Map clicked Y to floor.
  for (let f = 1; f <= FLOORS; f++) {
    const cy = floorToY(f);
    if (Math.abs(yCanvas - cy) <= FLOOR_H / 2) return f;
  }
  return 0;
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  floorEl = document.querySelector<HTMLElement>('#floor')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;

  best = loadBest();

  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const f = pickFloorFromPointer(e.clientY);
    if (f > 0) selectFloor(f);
  });

  window.addEventListener('keydown', (e) => {
    const k = e.key;
    if (k >= '1' && k <= String(FLOORS)) {
      selectFloor(Number(k));
      e.preventDefault();
      return;
    }
    if (k === 'ArrowUp') {
      selectFloor(Math.min(FLOORS, nearestFloor() + 1));
      e.preventDefault();
      return;
    }
    if (k === 'ArrowDown') {
      selectFloor(Math.max(1, nearestFloor() - 1));
      e.preventDefault();
      return;
    }
    if (k === ' ' || k === 'Enter') {
      if (state === 'ready' || state === 'gameover') {
        startPlaying();
      }
      e.preventDefault();
      return;
    }
    if (k.toLowerCase() === 'r') {
      reset();
      e.preventDefault();
    }
  });

  restartBtn.addEventListener('click', () => reset());

  reset();
  requestAnimationFrame(loop);
}

export const game = defineGame({ init, reset });
