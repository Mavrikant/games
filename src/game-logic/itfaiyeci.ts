import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';

type State = 'ready' | 'playing' | 'gameover';

const STORAGE_BEST = 'itfaiyeci.best';

const W = 480;
const H = 540;

const COLS = 4;
const ROWS = 5;
const BLDG_X = 240;
const BLDG_Y = 70;
const BLDG_W = 220;
const BLDG_H = 380;
const WIN_PAD_X = 14;
const WIN_PAD_Y = 18;
const WIN_GAP_X = 10;
const WIN_GAP_Y = 14;
const WIN_W =
  (BLDG_W - WIN_PAD_X * 2 - WIN_GAP_X * (COLS - 1)) / COLS;
const WIN_H =
  (BLDG_H - WIN_PAD_Y * 2 - WIN_GAP_Y * (ROWS - 1)) / ROWS;

const HOSE_X = 110;
const HOSE_Y = 420;

const GRAVITY = 0.32;
const SHOOT_SPEED = 14.5;
const FIRE_COOLDOWN_MS = 240;
const ANGLE_MIN = 18;
const ANGLE_MAX = 80;
const ANGLE_STEP = 1.2;
const TRAIL_LEN = 7;

const MAX_LOST = 3;

interface Fire {
  col: number;
  row: number;
  intensity: number;
  nextBurnAt: number;
  flicker: number;
}

interface Drop {
  x: number;
  y: number;
  vx: number;
  vy: number;
  trail: { x: number; y: number }[];
  age: number;
}

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let lostEl!: HTMLElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let restartBtn!: HTMLButtonElement;

let state: State = 'ready';
let score = 0;
let best = 0;
let lost = 0;
let angleDeg = 55;
let aimUp = false;
let aimDown = false;
let drops: Drop[] = [];
let fires: Map<string, Fire> = new Map();
let lastShotAt = 0;
let lastSpawnAt = 0;
let spawnIntervalMs = 4500;
let wind = 0;
let windTarget = 0;
let lastWindRetargetAt = 0;
let lastFrameAt = 0;
let elapsedSec = 0;

function winKey(col: number, row: number): string {
  return `${col},${row}`;
}

function winRect(col: number, row: number): { x: number; y: number; w: number; h: number } {
  const x = BLDG_X + WIN_PAD_X + col * (WIN_W + WIN_GAP_X);
  const y = BLDG_Y + WIN_PAD_Y + row * (WIN_H + WIN_GAP_Y);
  return { x, y, w: WIN_W, h: WIN_H };
}

function pickFreeWindow(): { col: number; row: number } | null {
  const free: { col: number; row: number }[] = [];
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const f = fires.get(winKey(col, row));
      if (!f) free.push({ col, row });
    }
  }
  if (free.length === 0) return null;
  return free[Math.floor(Math.random() * free.length)]!;
}

function burnIntervalForLevel(intensity: number): number {
  if (intensity === 1) return 5200;
  return 4200;
}

function spawnFire(now: number): void {
  const pick = pickFreeWindow();
  if (!pick) return;
  fires.set(winKey(pick.col, pick.row), {
    col: pick.col,
    row: pick.row,
    intensity: 1,
    nextBurnAt: now + burnIntervalForLevel(1),
    flicker: Math.random() * Math.PI * 2,
  });
}

function setOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlay);
}

function hideOverlay(): void {
  hideOverlayEl(overlay);
}

function startGame(): void {
  state = 'playing';
  score = 0;
  lost = 0;
  drops = [];
  fires = new Map();
  angleDeg = 55;
  aimUp = false;
  aimDown = false;
  lastShotAt = 0;
  const now = performance.now();
  lastSpawnAt = now;
  spawnIntervalMs = 4500;
  wind = 0;
  windTarget = (Math.random() - 0.5) * 2.4;
  lastWindRetargetAt = now;
  elapsedSec = 0;
  spawnFire(now);
  updateHud();
  hideOverlay();
}

function reset(): void {
  state = 'ready';
  drops = [];
  fires = new Map();
  score = 0;
  lost = 0;
  angleDeg = 55;
  aimUp = false;
  aimDown = false;
  updateHud();
  setOverlay(
    'İtfaiyeci',
    'Yangını söndür! Bina küle dönmesin.\n↑/↓: nişan açısı · Boşluk: su · R: yeniden',
  );
}

function updateHud(): void {
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
  lostEl.textContent = `${lost}/${MAX_LOST}`;
}

function gameOver(): void {
  state = 'gameover';
  drops = [];
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
  updateHud();
  setOverlay(
    'Bina düştü!',
    `Skor: ${score}\nBoşluk ile yeni tur · R: yeniden`,
  );
}

function shoot(now: number): void {
  if (state !== 'playing') return;
  if (now - lastShotAt < FIRE_COOLDOWN_MS) return;
  lastShotAt = now;
  const rad = (angleDeg * Math.PI) / 180;
  const vx = Math.cos(rad) * SHOOT_SPEED;
  const vy = -Math.sin(rad) * SHOOT_SPEED;
  drops.push({
    x: HOSE_X + Math.cos(rad) * 22,
    y: HOSE_Y - Math.sin(rad) * 22,
    vx,
    vy,
    trail: [],
    age: 0,
  });
}

function step(dtMs: number, now: number): void {
  const dt = Math.min(dtMs / (1000 / 60), 2.2);
  elapsedSec += dtMs / 1000;

  if (aimUp) angleDeg = Math.min(ANGLE_MAX, angleDeg + ANGLE_STEP * dt);
  if (aimDown) angleDeg = Math.max(ANGLE_MIN, angleDeg - ANGLE_STEP * dt);

  if (now - lastWindRetargetAt > 3000) {
    const intensity = Math.min(1, elapsedSec / 60);
    windTarget = (Math.random() - 0.5) * (1.4 + intensity * 1.6);
    lastWindRetargetAt = now;
  }
  wind += (windTarget - wind) * 0.04 * dt;

  spawnIntervalMs = Math.max(2000, 4500 - Math.floor(elapsedSec / 12) * 250);
  if (now - lastSpawnAt > spawnIntervalMs) {
    spawnFire(now);
    lastSpawnAt = now;
  }

  for (const f of fires.values()) {
    f.flicker += 0.18 * dt;
    if (f.intensity >= 3) continue;
    if (now >= f.nextBurnAt) {
      f.intensity++;
      if (f.intensity >= 3) {
        lost++;
        updateHud();
        if (lost >= MAX_LOST) {
          gameOver();
          return;
        }
      } else {
        f.nextBurnAt = now + burnIntervalForLevel(f.intensity);
      }
    }
  }

  for (const d of drops) {
    d.trail.push({ x: d.x, y: d.y });
    if (d.trail.length > TRAIL_LEN) d.trail.shift();
    d.vy += GRAVITY * dt;
    d.vx += wind * 0.05 * dt;
    d.x += d.vx * dt;
    d.y += d.vy * dt;
    d.age += dt;
  }

  for (const d of drops) {
    if (d.age <= 0) continue;
    if (
      d.x >= BLDG_X &&
      d.x <= BLDG_X + BLDG_W &&
      d.y >= BLDG_Y &&
      d.y <= BLDG_Y + BLDG_H
    ) {
      for (const f of fires.values()) {
        if (f.intensity < 1 || f.intensity > 2) continue;
        const r = winRect(f.col, f.row);
        if (
          d.x >= r.x &&
          d.x <= r.x + r.w &&
          d.y >= r.y &&
          d.y <= r.y + r.h
        ) {
          f.intensity--;
          score += f.intensity === 0 ? 5 : 1;
          if (f.intensity === 0) {
            fires.delete(winKey(f.col, f.row));
          } else {
            f.nextBurnAt = now + burnIntervalForLevel(f.intensity);
          }
          if (score > best) {
            best = score;
            safeWrite(STORAGE_BEST, best);
          }
          updateHud();
          break;
        }
      }
      d.age = -1;
    }
  }

  drops = drops.filter(
    (d) => d.age >= 0 && d.x > -20 && d.x < W + 20 && d.y < H + 20,
  );
}

function draw(): void {
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, getCss('--it-sky-top') || '#1b2547');
  grad.addColorStop(1, getCss('--it-sky') || '#0c1224');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
  for (let i = 0; i < 30; i++) {
    const sx = (i * 73) % W;
    const sy = (i * 41) % 60;
    ctx.fillRect(sx, sy, 1, 1);
  }

  ctx.beginPath();
  ctx.arc(60, 60, 22, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255, 245, 215, 0.85)';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(54, 56, 18, 0, Math.PI * 2);
  ctx.fillStyle = getCss('--it-sky-top') || '#1b2547';
  ctx.fill();

  ctx.fillStyle = getCss('--it-ground') || '#1a3a1d';
  ctx.fillRect(0, 480, W, H - 480);

  ctx.fillStyle = '#3b3f50';
  ctx.fillRect(0, 478, W, 4);

  drawWindIndicator();
  drawBuilding();
  drawFires();
  drawTruck();
  drawAimGuide();
  drawDroplets();
}

function drawWindIndicator(): void {
  const cx = W / 2;
  const cy = 28;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.65)';
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('RÜZGAR', cx, cy - 10);
  const len = Math.min(60, Math.abs(wind) * 25 + 8);
  const dir = wind >= 0 ? 1 : -1;
  ctx.strokeStyle = getCss('--it-wind') || 'rgba(255,255,255,0.55)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx - (dir * len) / 2, cy);
  ctx.lineTo(cx + (dir * len) / 2, cy);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx + (dir * len) / 2, cy);
  ctx.lineTo(cx + (dir * len) / 2 - dir * 6, cy - 4);
  ctx.lineTo(cx + (dir * len) / 2 - dir * 6, cy + 4);
  ctx.closePath();
  ctx.fillStyle = getCss('--it-wind') || 'rgba(255,255,255,0.55)';
  ctx.fill();
}

function drawBuilding(): void {
  ctx.fillStyle = getCss('--it-bldg') || '#2a3149';
  ctx.fillRect(BLDG_X, BLDG_Y, BLDG_W, BLDG_H);

  ctx.fillStyle = getCss('--it-bldg-edge') || '#1a1f30';
  ctx.fillRect(BLDG_X - 6, BLDG_Y - 8, BLDG_W + 12, 8);

  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const r = winRect(col, row);
      const f = fires.get(winKey(col, row));
      let bg = getCss('--it-window-lit') || '#ffd166';
      if (f && f.intensity >= 3) bg = getCss('--it-fire-3') || '#6b7280';
      else if (f) bg = '#3a2410';
      ctx.fillStyle = bg;
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.fillStyle = getCss('--it-bldg-edge') || '#1a1f30';
      ctx.fillRect(r.x + r.w / 2 - 1, r.y, 2, r.h);
      ctx.fillRect(r.x, r.y + r.h / 2 - 1, r.w, 2);
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = 1;
      ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
    }
  }

  const doorW = 40;
  const doorH = 50;
  ctx.fillStyle = getCss('--it-bldg-edge') || '#1a1f30';
  ctx.fillRect(BLDG_X + BLDG_W / 2 - doorW / 2, BLDG_Y + BLDG_H - doorH, doorW, doorH);
}

function drawFires(): void {
  for (const f of fires.values()) {
    const r = winRect(f.col, f.row);
    if (f.intensity >= 3) continue;
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h - 6;
    const baseH = f.intensity === 1 ? 22 : 38;
    const flicker = Math.sin(f.flicker) * 2 + Math.cos(f.flicker * 1.7) * 1.5;
    const h = baseH + flicker;
    drawFlame(cx, cy, h * 0.6, h, f.intensity);
  }
}

function drawFlame(cx: number, cy: number, w: number, h: number, intensity: number): void {
  ctx.fillStyle = getCss('--it-fire-2') || '#ef4444';
  ctx.beginPath();
  ctx.ellipse(cx, cy - h * 0.35, w * 0.6, h * 0.7, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = getCss('--it-fire-1') || '#f59e0b';
  ctx.beginPath();
  ctx.ellipse(cx, cy - h * 0.25, w * 0.4, h * 0.5, 0, 0, Math.PI * 2);
  ctx.fill();
  if (intensity >= 2) {
    ctx.strokeStyle = 'rgba(255, 180, 70, 0.18)';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.ellipse(cx, cy - h * 0.3, w * 0.9, h * 0.9, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawTruck(): void {
  ctx.fillStyle = '#0c0e15';
  ctx.beginPath();
  ctx.arc(60, 470, 10, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(150, 470, 10, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = getCss('--it-truck') || '#d72638';
  ctx.fillRect(30, 430, 150, 40);
  ctx.fillStyle = getCss('--it-bldg-edge') || '#1a1f30';
  ctx.fillRect(140, 415, 40, 25);
  ctx.fillStyle = '#9bd7ff';
  ctx.fillRect(146, 420, 28, 14);
  ctx.fillStyle = getCss('--it-truck-trim') || '#f4f4f5';
  ctx.fillRect(30, 448, 110, 4);

  ctx.fillStyle = '#bcc1d1';
  ctx.fillRect(50, 420, 6, 12);
  ctx.fillRect(70, 420, 6, 12);

  ctx.fillStyle = '#fdfdff';
  ctx.beginPath();
  ctx.arc(HOSE_X, HOSE_Y, 4, 0, Math.PI * 2);
  ctx.fill();
}

function drawAimGuide(): void {
  if (state === 'gameover') return;
  const rad = (angleDeg * Math.PI) / 180;
  const vx0 = Math.cos(rad) * SHOOT_SPEED;
  const vy0 = -Math.sin(rad) * SHOOT_SPEED;
  ctx.fillStyle = getCss('--it-aim') || 'rgba(103,212,255,0.45)';
  let x = HOSE_X + Math.cos(rad) * 22;
  let y = HOSE_Y - Math.sin(rad) * 22;
  let vx = vx0;
  let vy = vy0;
  for (let i = 0; i < 28; i++) {
    for (let s = 0; s < 4; s++) {
      vy += GRAVITY;
      x += vx;
      y += vy;
      if (x > W || y > H || x < 0) break;
    }
    if (x > W || y > H || x < 0) break;
    ctx.beginPath();
    ctx.arc(x, y, 1.6, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.strokeStyle = '#fdfdff';
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(HOSE_X, HOSE_Y);
  ctx.lineTo(HOSE_X + Math.cos(rad) * 26, HOSE_Y - Math.sin(rad) * 26);
  ctx.stroke();
}

function drawDroplets(): void {
  for (const d of drops) {
    for (let i = 0; i < d.trail.length; i++) {
      const t = d.trail[i]!;
      const alpha = (i + 1) / d.trail.length;
      ctx.fillStyle = `rgba(103, 212, 255, ${alpha * 0.45})`;
      ctx.beginPath();
      ctx.arc(t.x, t.y, 2 + alpha * 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = getCss('--it-water') || '#67d4ff';
    ctx.beginPath();
    ctx.arc(d.x, d.y, 4, 0, Math.PI * 2);
    ctx.fill();
  }
}

const cssCache = new Map<string, string>();
function getCss(varName: string): string {
  const cached = cssCache.get(varName);
  if (cached !== undefined) return cached;
  const val = getComputedStyle(document.documentElement)
    .getPropertyValue(varName)
    .trim();
  cssCache.set(varName, val);
  return val;
}

function loop(now: number): void {
  requestAnimationFrame(loop);
  const dt = lastFrameAt ? now - lastFrameAt : 16;
  lastFrameAt = now;
  if (state === 'playing') {
    step(dt, now);
  }
  draw();
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  lostEl = document.querySelector<HTMLElement>('#lost')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  window.addEventListener('keydown', (e) => {
    const k = e.key;
    if (k === 'ArrowUp' || k === 'w' || k === 'W') {
      aimUp = true;
      e.preventDefault();
    } else if (k === 'ArrowDown' || k === 's' || k === 'S') {
      aimDown = true;
      e.preventDefault();
    } else if (k === ' ' || k === 'Spacebar' || k === 'Enter') {
      if (state === 'ready' || state === 'gameover') {
        startGame();
      } else {
        shoot(performance.now());
      }
      e.preventDefault();
    } else if (k === 'r' || k === 'R') {
      reset();
      e.preventDefault();
    }
  });
  window.addEventListener('keyup', (e) => {
    const k = e.key;
    if (k === 'ArrowUp' || k === 'w' || k === 'W') aimUp = false;
    else if (k === 'ArrowDown' || k === 's' || k === 'S') aimDown = false;
  });

  document.querySelectorAll<HTMLButtonElement>('.touch__btn').forEach((btn) => {
    const act = btn.dataset.act;
    if (!act) return;
    if (act === 'fire') {
      btn.addEventListener('click', () => {
        if (state === 'ready' || state === 'gameover') {
          startGame();
        } else {
          shoot(performance.now());
        }
      });
    } else if (act === 'up') {
      btn.addEventListener('pointerdown', () => {
        aimUp = true;
      });
      btn.addEventListener('pointerup', () => {
        aimUp = false;
      });
      btn.addEventListener('pointercancel', () => {
        aimUp = false;
      });
      btn.addEventListener('pointerleave', () => {
        aimUp = false;
      });
    } else if (act === 'down') {
      btn.addEventListener('pointerdown', () => {
        aimDown = true;
      });
      btn.addEventListener('pointerup', () => {
        aimDown = false;
      });
      btn.addEventListener('pointercancel', () => {
        aimDown = false;
      });
      btn.addEventListener('pointerleave', () => {
        aimDown = false;
      });
    }
  });

  restartBtn.addEventListener('click', reset);

  canvas.addEventListener('pointerdown', () => {
    if (state === 'ready' || state === 'gameover') {
      startGame();
    } else {
      shoot(performance.now());
    }
  });

  reset();
  requestAnimationFrame(loop);
}

export const game = defineGame({ init, reset });
