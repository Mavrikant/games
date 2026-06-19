import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';

type GameState = 'ready' | 'playing' | 'gameover';
type BridgeState = 'closed' | 'opening' | 'open' | 'closing';

interface Vehicle {
  id: number;
  kind: 'car' | 'boat';
  x: number;
  y: number;
  width: number;
  height: number;
  speed: number;
  colorVar: string;
}

const CANVAS_W = 480;
const CANVAS_H = 540;

const ROAD_TOP = 86;
const ROAD_BOTTOM = 122;
const ROAD_MID = (ROAD_TOP + ROAD_BOTTOM) / 2;
const LANE_RIGHT_Y = ROAD_TOP + 9;
const LANE_LEFT_Y = ROAD_BOTTOM - 9;

const PILLAR_LEFT_X = 160;
const PILLAR_RIGHT_X = 310;
const PILLAR_WIDTH = 10;
const GAP_LEFT = PILLAR_LEFT_X + PILLAR_WIDTH;
const GAP_RIGHT = PILLAR_RIGHT_X;
const HALF_LEN = (GAP_RIGHT - GAP_LEFT) / 2;
const HINGE_LEFT_X = GAP_LEFT;
const HINGE_RIGHT_X = GAP_RIGHT;
const HINGE_Y = ROAD_MID;
const DECK_THICKNESS = ROAD_BOTTOM - ROAD_TOP;

const RIVER_TOP = 170;
const RIVER_BOTTOM = 446;
const BOAT_LANE_Y = (RIVER_TOP + RIVER_BOTTOM) / 2;

const HUD_TOP = 458;

const CAR_W = 32;
const CAR_H = 14;
const BOAT_W = 66;
const BOAT_H = 22;

const BRIDGE_ANIM_MS = 600;
const CAR_COLORS = ['--kbk-car-1', '--kbk-car-2', '--kbk-car-3', '--kbk-car-4'];
const BOAT_COLORS = ['--kbk-boat-1', '--kbk-boat-2'];

const STORAGE_BEST = 'kopru-bekcisi.best';

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let toggleBtn!: HTMLButtonElement;

let gameState: GameState = 'ready';
let bridgeState: BridgeState = 'closed';
let bridgeAnim = 0;
let score = 0;
let best = 0;
let vehicles: Vehicle[] = [];
let nextId = 1;
let carSpawnTimer = 0;
let boatSpawnTimer = 0;
let lastTime = 0;
let nextCarRight = true;
let nextBoatRight = true;
let collisionFlash = 0;
let waterPhase = 0;

const cssCache = new Map<string, string>();
function getCss(name: string): string {
  const c = cssCache.get(name);
  if (c !== undefined) return c;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  cssCache.set(name, v);
  return v;
}

function loadBest(): number {
  const v = safeRead<number>(STORAGE_BEST, 0);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function bridgeOpenness(): number {
  if (bridgeState === 'closed') return 0;
  if (bridgeState === 'open') return 1;
  if (bridgeState === 'opening') return bridgeAnim;
  return 1 - bridgeAnim;
}

function carSpawnIntervalMs(s: number): number {
  const base = Math.max(1300, 2900 - s * 35);
  return base + Math.random() * 500;
}
function boatSpawnIntervalMs(s: number): number {
  const base = Math.max(2400, 4200 - s * 45);
  return base + Math.random() * 700;
}
function carSpeed(s: number): number {
  return 95 + Math.min(55, s * 1.2);
}
function boatSpeed(s: number): number {
  return 48 + Math.min(28, s * 0.7);
}

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlay);
}
function hideOverlay(): void {
  hideOverlayEl(overlay);
}

function toggleBridge(): void {
  if (gameState !== 'playing') return;
  if (bridgeState === 'closed') {
    bridgeState = 'opening';
    bridgeAnim = 0;
  } else if (bridgeState === 'open') {
    bridgeState = 'closing';
    bridgeAnim = 0;
  } else if (bridgeState === 'opening') {
    bridgeState = 'closing';
    bridgeAnim = 1 - bridgeAnim;
  } else {
    bridgeState = 'opening';
    bridgeAnim = 1 - bridgeAnim;
  }
}

function spawnCar(): void {
  const goingRight = nextCarRight;
  nextCarRight = !nextCarRight;
  const y = goingRight ? LANE_RIGHT_Y : LANE_LEFT_Y;
  const x = goingRight ? -CAR_W / 2 - 4 : CANVAS_W + CAR_W / 2 + 4;
  const sp = carSpeed(score) * (goingRight ? 1 : -1);
  vehicles.push({
    id: nextId++,
    kind: 'car',
    x, y,
    width: CAR_W,
    height: CAR_H,
    speed: sp,
    colorVar: CAR_COLORS[Math.floor(Math.random() * CAR_COLORS.length)]!,
  });
}

function spawnBoat(): void {
  const goingRight = nextBoatRight;
  nextBoatRight = !nextBoatRight;
  const x = goingRight ? -BOAT_W / 2 - 6 : CANVAS_W + BOAT_W / 2 + 6;
  const sp = boatSpeed(score) * (goingRight ? 1 : -1);
  vehicles.push({
    id: nextId++,
    kind: 'boat',
    x,
    y: BOAT_LANE_Y,
    width: BOAT_W,
    height: BOAT_H,
    speed: sp,
    colorVar: BOAT_COLORS[Math.floor(Math.random() * BOAT_COLORS.length)]!,
  });
}

function vehicleInGap(v: Vehicle): boolean {
  const left = v.x - v.width / 2;
  const right = v.x + v.width / 2;
  return right > GAP_LEFT && left < GAP_RIGHT;
}

function vehicleSafe(v: Vehicle): boolean {
  const o = bridgeOpenness();
  if (v.kind === 'car') return o < 0.001;
  return o > 0.999;
}

function bumpBest(): void {
  if (score > best) {
    best = score;
    bestEl.textContent = String(best);
    safeWrite(STORAGE_BEST, best);
  }
}

function crash(v: Vehicle): void {
  collisionFlash = 0.7;
  gameState = 'gameover';
  bumpBest();
  showOverlay(
    v.kind === 'car' ? 'Araba köprüden düştü' : 'Tekne köprüye çarptı',
    `Skor: ${score} · Boşluk veya R ile tekrar dene.`,
  );
}

function tick(dt: number): void {
  waterPhase += dt / 1000;

  if (gameState !== 'playing') {
    if (collisionFlash > 0) collisionFlash = Math.max(0, collisionFlash - dt / 1000);
    return;
  }

  if (bridgeState === 'opening') {
    bridgeAnim += dt / BRIDGE_ANIM_MS;
    if (bridgeAnim >= 1) {
      bridgeAnim = 1;
      bridgeState = 'open';
    }
  } else if (bridgeState === 'closing') {
    bridgeAnim += dt / BRIDGE_ANIM_MS;
    if (bridgeAnim >= 1) {
      bridgeAnim = 0;
      bridgeState = 'closed';
    }
  }

  carSpawnTimer -= dt;
  if (carSpawnTimer <= 0) {
    spawnCar();
    carSpawnTimer = carSpawnIntervalMs(score);
  }
  boatSpawnTimer -= dt;
  if (boatSpawnTimer <= 0) {
    spawnBoat();
    boatSpawnTimer = boatSpawnIntervalMs(score);
  }

  const remaining: Vehicle[] = [];
  for (const v of vehicles) {
    v.x += (v.speed * dt) / 1000;

    if (vehicleInGap(v) && !vehicleSafe(v)) {
      crash(v);
      return;
    }

    const off = v.x > CANVAS_W + v.width || v.x < -v.width;
    if (off) {
      score += 1;
      scoreEl.textContent = String(score);
      bumpBest();
    } else {
      remaining.push(v);
    }
  }
  vehicles = remaining;
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

function drawSky(): void {
  ctx.fillStyle = getCss('--kbk-sky');
  ctx.fillRect(0, 0, CANVAS_W, ROAD_TOP);
}

function drawRoadSlab(x0: number, w: number): void {
  ctx.fillStyle = getCss('--kbk-road');
  ctx.fillRect(x0, ROAD_TOP, w, DECK_THICKNESS);
  ctx.fillStyle = getCss('--kbk-road-edge');
  ctx.fillRect(x0, ROAD_TOP, w, 3);
  ctx.fillRect(x0, ROAD_BOTTOM - 3, w, 3);
}

function drawRoadLane(x0: number, x1: number): void {
  ctx.strokeStyle = getCss('--kbk-lane');
  ctx.setLineDash([12, 8]);
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(x0, ROAD_MID);
  ctx.lineTo(x1, ROAD_MID);
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawApproach(): void {
  drawRoadSlab(0, PILLAR_LEFT_X);
  drawRoadSlab(PILLAR_RIGHT_X + PILLAR_WIDTH, CANVAS_W - (PILLAR_RIGHT_X + PILLAR_WIDTH));
  drawRoadLane(0, PILLAR_LEFT_X - 2);
  drawRoadLane(PILLAR_RIGHT_X + PILLAR_WIDTH + 2, CANVAS_W);
}

function drawBank(): void {
  ctx.fillStyle = getCss('--kbk-bank');
  ctx.fillRect(0, ROAD_BOTTOM, CANVAS_W, RIVER_TOP - ROAD_BOTTOM);
  ctx.fillStyle = getCss('--kbk-bank-edge');
  ctx.fillRect(0, ROAD_BOTTOM, CANVAS_W, 4);
  ctx.fillRect(0, RIVER_TOP - 4, CANVAS_W, 4);
}

function drawRiver(): void {
  ctx.fillStyle = getCss('--kbk-water');
  ctx.fillRect(0, RIVER_TOP, CANVAS_W, RIVER_BOTTOM - RIVER_TOP);
  ctx.strokeStyle = getCss('--kbk-water-line');
  ctx.lineWidth = 1;
  for (let y = RIVER_TOP + 22; y < RIVER_BOTTOM; y += 36) {
    ctx.beginPath();
    for (let x = 0; x <= CANVAS_W; x += 14) {
      const yy = y + Math.sin(x / 28 + waterPhase * 1.2 + y * 0.03) * 2;
      if (x === 0) ctx.moveTo(x, yy);
      else ctx.lineTo(x, yy);
    }
    ctx.stroke();
  }
}

function drawFooter(): void {
  ctx.fillStyle = getCss('--kbk-bank');
  ctx.fillRect(0, RIVER_BOTTOM, CANVAS_W, HUD_TOP - RIVER_BOTTOM);
  ctx.fillStyle = getCss('--kbk-bank-edge');
  ctx.fillRect(0, RIVER_BOTTOM, CANVAS_W, 4);
}

function drawPillars(): void {
  ctx.fillStyle = getCss('--kbk-pillar');
  ctx.fillRect(PILLAR_LEFT_X, ROAD_TOP - 6, PILLAR_WIDTH, RIVER_BOTTOM - ROAD_TOP + 12);
  ctx.fillRect(PILLAR_RIGHT_X, ROAD_TOP - 6, PILLAR_WIDTH, RIVER_BOTTOM - ROAD_TOP + 12);
  ctx.strokeStyle = getCss('--kbk-pillar-edge');
  ctx.lineWidth = 1;
  ctx.strokeRect(PILLAR_LEFT_X + 0.5, ROAD_TOP - 5.5, PILLAR_WIDTH - 1, RIVER_BOTTOM - ROAD_TOP + 11);
  ctx.strokeRect(PILLAR_RIGHT_X + 0.5, ROAD_TOP - 5.5, PILLAR_WIDTH - 1, RIVER_BOTTOM - ROAD_TOP + 11);
  // Pillar caps
  ctx.fillStyle = getCss('--kbk-pillar-cap');
  ctx.fillRect(PILLAR_LEFT_X - 2, ROAD_TOP - 8, PILLAR_WIDTH + 4, 4);
  ctx.fillRect(PILLAR_RIGHT_X - 2, ROAD_TOP - 8, PILLAR_WIDTH + 4, 4);
}

function drawBridgeHalf(hingeX: number, side: 'left' | 'right'): void {
  const angle = (Math.PI / 2) * bridgeOpenness();
  const rot = side === 'left' ? -angle : angle;
  const dir = side === 'left' ? 1 : -1;

  ctx.save();
  ctx.translate(hingeX, HINGE_Y);
  ctx.rotate(rot);

  // Deck rectangle in local coords: extends from x=0 to x=dir*HALF_LEN, y -DECK/2 to DECK/2
  const x0 = side === 'left' ? 0 : -HALF_LEN;
  const w = HALF_LEN;
  const y0 = -DECK_THICKNESS / 2;
  const h = DECK_THICKNESS;

  ctx.fillStyle = getCss('--kbk-road');
  ctx.fillRect(x0, y0, w, h);

  // Edge strips
  ctx.fillStyle = getCss('--kbk-road-edge');
  ctx.fillRect(x0, y0, w, 3);
  ctx.fillRect(x0, y0 + h - 3, w, 3);

  // Lane stripes (only meaningful when closed-ish)
  if (bridgeOpenness() < 0.4) {
    ctx.strokeStyle = getCss('--kbk-lane');
    ctx.setLineDash([10, 6]);
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(x0, 0);
    ctx.lineTo(x0 + w, 0);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Trusses (decorative beams) — visible when lifted
  if (bridgeOpenness() > 0.05) {
    ctx.strokeStyle = getCss('--kbk-bridge-truss');
    ctx.lineWidth = 1.4;
    const trussCount = 3;
    for (let i = 1; i <= trussCount; i++) {
      const px = side === 'left' ? (w * i) / (trussCount + 1) : -(w * i) / (trussCount + 1);
      ctx.beginPath();
      ctx.moveTo(px, y0 + 2);
      ctx.lineTo(px, y0 + h - 2);
      ctx.stroke();
    }
  }

  // Free-end cap (the tip that lifts)
  ctx.fillStyle = getCss('--kbk-bridge-tip');
  if (side === 'left') {
    ctx.fillRect(x0 + w - 3, y0, 3, h);
  } else {
    ctx.fillRect(x0, y0, 3, h);
  }

  // Frame
  ctx.strokeStyle = getCss('--kbk-bridge-frame');
  ctx.lineWidth = 1.2;
  ctx.strokeRect(x0 + 0.5, y0 + 0.5, w - 1, h - 1);

  ctx.restore();
  void dir;
}

function drawBridge(): void {
  drawBridgeHalf(HINGE_LEFT_X, 'left');
  drawBridgeHalf(HINGE_RIGHT_X, 'right');
}

function drawCar(v: Vehicle): void {
  const x = v.x - v.width / 2;
  const y = v.y - v.height / 2;
  // Body
  ctx.fillStyle = getCss(v.colorVar);
  roundRect(x, y, v.width, v.height, 4);
  ctx.fill();
  // Roof shadow
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.fillRect(x + 2, y + v.height - 5, v.width - 4, 2);
  // Windshield (front side)
  ctx.fillStyle = 'rgba(220, 235, 255, 0.7)';
  if (v.speed > 0) {
    roundRect(x + v.width * 0.55, y + 2, v.width * 0.32, v.height - 5, 2);
  } else {
    roundRect(x + v.width * 0.13, y + 2, v.width * 0.32, v.height - 5, 2);
  }
  ctx.fill();
  // Wheels
  ctx.fillStyle = '#15161b';
  ctx.fillRect(x + 4, y + v.height - 3, 6, 4);
  ctx.fillRect(x + v.width - 10, y + v.height - 3, 6, 4);
  // Headlights
  ctx.fillStyle = 'rgba(255, 240, 200, 0.95)';
  if (v.speed > 0) {
    ctx.fillRect(x + v.width - 2, y + 3, 2, 3);
    ctx.fillRect(x + v.width - 2, y + v.height - 6, 2, 3);
  } else {
    ctx.fillRect(x, y + 3, 2, 3);
    ctx.fillRect(x, y + v.height - 6, 2, 3);
  }
}

function drawBoat(v: Vehicle): void {
  const x = v.x;
  const y = v.y;
  const w = v.width;
  const h = v.height;
  // Hull (trapezoid)
  ctx.fillStyle = getCss(v.colorVar);
  ctx.beginPath();
  ctx.moveTo(x - w / 2, y);
  ctx.lineTo(x - w / 2 + 8, y + h / 2);
  ctx.lineTo(x + w / 2 - 8, y + h / 2);
  ctx.lineTo(x + w / 2, y);
  ctx.closePath();
  ctx.fill();
  // Hull rim
  ctx.fillStyle = getCss('--kbk-boat-rim');
  ctx.fillRect(x - w / 2, y - 2, w, 2);
  // Cabin
  ctx.fillStyle = getCss('--kbk-boat-cabin');
  const cabinW = w * 0.45;
  const cabinH = h * 0.7;
  roundRect(x - cabinW / 2, y - cabinH, cabinW, cabinH, 2);
  ctx.fill();
  // Window
  ctx.fillStyle = 'rgba(220, 235, 255, 0.7)';
  ctx.fillRect(x - cabinW / 2 + 4, y - cabinH + 4, cabinW - 8, cabinH * 0.45);
  // Mast + flag
  ctx.strokeStyle = '#3a3a45';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(x, y - cabinH);
  ctx.lineTo(x, y - cabinH - 10);
  ctx.stroke();
  ctx.fillStyle = getCss('--kbk-boat-flag');
  const dir = v.speed > 0 ? 1 : -1;
  ctx.beginPath();
  ctx.moveTo(x, y - cabinH - 10);
  ctx.lineTo(x + 8 * dir, y - cabinH - 7);
  ctx.lineTo(x, y - cabinH - 4);
  ctx.closePath();
  ctx.fill();
  // Wake
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  const wakeX = v.speed > 0 ? x - w / 2 - 8 : x + w / 2 + 2;
  ctx.fillRect(wakeX, y + h / 2 - 1, 6, 2);
  ctx.fillRect(wakeX + (v.speed > 0 ? -4 : 4), y + h / 2 + 2, 4, 1);
}

function drawWarnings(): void {
  if (gameState !== 'playing') return;
  const closed = bridgeState === 'closed';
  const open = bridgeState === 'open';
  for (const v of vehicles) {
    const danger = v.kind === 'car' ? !closed : !open;
    if (!danger) continue;
    // Distance from vehicle leading edge to gap
    let dist: number;
    if (v.speed > 0) {
      const lead = v.x + v.width / 2;
      dist = GAP_LEFT - lead;
    } else {
      const lead = v.x - v.width / 2;
      dist = lead - GAP_RIGHT;
    }
    if (dist <= 0 || dist > 80) continue;
    // Pulse triangle above vehicle
    const t = (Math.sin(waterPhase * 8) + 1) / 2;
    ctx.fillStyle = `rgba(255, 96, 96, ${0.55 + t * 0.4})`;
    const px = v.x;
    const py = v.kind === 'car' ? v.y - v.height - 2 : v.y - v.height * 1.5 - 12;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(px - 5, py - 7);
    ctx.lineTo(px + 5, py - 7);
    ctx.closePath();
    ctx.fill();
  }
}

function drawHud(): void {
  const y = HUD_TOP;
  ctx.fillStyle = getCss('--kbk-hud-bg');
  ctx.fillRect(0, y, CANVAS_W, CANVAS_H - y);
  ctx.strokeStyle = getCss('--border');
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, y + 0.5);
  ctx.lineTo(CANVAS_W, y + 0.5);
  ctx.stroke();

  // State chip
  const isStable = bridgeState === 'closed' || bridgeState === 'open';
  const chipBg = isStable ? '--kbk-state-stable' : '--kbk-state-trans';
  const chipColor = isStable ? '--kbk-state-stable-fg' : '--kbk-state-trans-fg';
  const labels: Record<BridgeState, string> = {
    closed: 'KAPALI',
    opening: 'AÇILIYOR',
    open: 'AÇIK',
    closing: 'KAPANIYOR',
  };
  const label = labels[bridgeState];
  ctx.font = '600 12px Inter, system-ui, sans-serif';
  const chipW = ctx.measureText(label).width + 22;
  const chipX = 16;
  const chipY = y + 14;
  ctx.fillStyle = getCss(chipBg);
  roundRect(chipX, chipY, chipW, 22, 11);
  ctx.fill();
  ctx.fillStyle = getCss(chipColor);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, chipX + chipW / 2, chipY + 11);

  // Sub-label
  ctx.font = '500 12px Inter, system-ui, sans-serif';
  ctx.fillStyle = getCss('--text-muted');
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const sub = {
    closed: 'arabalar geçer · tekneler bekler',
    opening: 'köprü açılıyor · kimse geçemez',
    open: 'tekneler geçer · arabalar bekler',
    closing: 'köprü kapanıyor · kimse geçemez',
  }[bridgeState];
  ctx.fillText(sub, chipX + chipW + 12, chipY + 11);

  // Bridge angle indicator (bottom right)
  const aIndW = 80;
  const aIndH = 10;
  const aIndX = CANVAS_W - aIndW - 16;
  const aIndY = chipY + 6;
  ctx.fillStyle = getCss('--border');
  ctx.fillRect(aIndX, aIndY, aIndW, aIndH);
  ctx.fillStyle = getCss(isStable ? '--kbk-state-stable' : '--kbk-state-trans');
  ctx.fillRect(aIndX, aIndY, aIndW * bridgeOpenness(), aIndH);
  ctx.font = '500 10px Inter, system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillStyle = getCss('--text-dim');
  ctx.fillText('açıklık', aIndX - 6, aIndY + 5);
}

function drawCollisionFlash(): void {
  if (collisionFlash > 0) {
    ctx.fillStyle = `rgba(255, 70, 70, ${Math.min(0.55, collisionFlash * 0.7)})`;
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  }
}

function draw(): void {
  drawSky();
  drawApproach();
  drawBank();
  drawRiver();
  drawFooter();
  drawPillars();
  drawBridge();
  // Vehicles
  for (const v of vehicles) {
    if (v.kind === 'car') drawCar(v);
    else drawBoat(v);
  }
  drawWarnings();
  drawHud();
  drawCollisionFlash();
}

function loop(now: number): void {
  if (lastTime === 0) lastTime = now;
  const dt = Math.min(120, now - lastTime);
  lastTime = now;
  tick(dt);
  draw();
  requestAnimationFrame(loop);
}

function startPlaying(): void {
  if (gameState === 'gameover') {
    reset();
  }
  if (gameState === 'ready') {
    gameState = 'playing';
    hideOverlay();
  }
}

function reset(): void {
  gameState = 'ready';
  bridgeState = 'closed';
  bridgeAnim = 0;
  score = 0;
  vehicles = [];
  nextId = 1;
  carSpawnTimer = 1500;
  boatSpawnTimer = 3800;
  collisionFlash = 0;
  nextCarRight = true;
  nextBoatRight = true;
  scoreEl.textContent = '0';
  bestEl.textContent = String(best);
  showOverlay(
    'Köprü Bekçisi',
    'Köprü kapalıyken arabalar, açıkken tekneler geçer.\nBoşluk, Enter ya da köprüye tıkla.',
  );
}

function onActivate(): void {
  if (gameState === 'ready' || gameState === 'gameover') {
    startPlaying();
  } else {
    toggleBridge();
  }
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  toggleBtn = document.querySelector<HTMLButtonElement>('#toggle')!;

  best = loadBest();

  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    onActivate();
  });

  overlay.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    onActivate();
  });

  toggleBtn.addEventListener('click', (e) => {
    e.preventDefault();
    onActivate();
  });

  window.addEventListener('keydown', (e) => {
    const k = e.key;
    if (k === ' ' || k === 'Enter') {
      e.preventDefault();
      onActivate();
      return;
    }
    if (k.toLowerCase() === 'r') {
      e.preventDefault();
      reset();
    }
  });

  restartBtn.addEventListener('click', () => reset());

  reset();
  requestAnimationFrame(loop);
}

export const game = defineGame({ init, reset });
