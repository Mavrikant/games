import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOv, hideOverlay as hideOv } from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';

type State = 'ready' | 'playing' | 'gameover';

interface Drop {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

const STORAGE_BEST = 'semsiye.best';

const GROUND_Y = 360;
const HEAD_R = 10;
const BODY_HALF_W = 8;
const HEAD_TOP_Y = GROUND_Y - 50;
const FEET_Y = GROUND_Y - 2;
const UMBRELLA_W = 130;
const UMBRELLA_H = 26;
const UMBRELLA_CENTER_Y = GROUND_Y - 100;
const MOVE_SPEED = 280;
const WET_LIMIT = 100;
const WET_PER_HIT = 6;
const WIND_MAX_VX = 220;
const GRAVITY_BASE = 320;
const GRAVITY_VARIANCE = 70;
const SPAWN_BASE = 1.6;
const SPAWN_GROWTH = 0.085;
const MAX_DROPS = 220;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let wetEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let startBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;

let state: State = 'ready';
let score = 0;
let best = 0;
let wet = 0;
let playerX = 360;
let drops: Drop[] = [];
let wind = 0;
let windTarget = 0;
let windChangeAt = 0;
let lastFrame = 0;
let startedAt = 0;
let leftHeld = false;
let rightHeld = false;
let touchDir = 0;
let rafId = 0;
let spawnAccum = 0;
const gen = createGenToken();

function formatScore(deci: number): string {
  return (deci / 10).toFixed(1);
}

function setOverlay(title: string, msg: string, btn: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  startBtn.textContent = btn;
  showOv(overlay);
}

function spawnDrop(): void {
  if (drops.length >= MAX_DROPS) return;
  const baseVx = wind * WIND_MAX_VX;
  drops.push({
    x: Math.random() * canvas.width,
    y: -8,
    vx: baseVx + (Math.random() - 0.5) * 12,
    vy: GRAVITY_BASE + Math.random() * GRAVITY_VARIANCE,
  });
}

function reset(): void {
  gen.bump();
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
  state = 'ready';
  score = 0;
  wet = 0;
  playerX = canvas.width / 2;
  drops = [];
  wind = 0;
  windTarget = 0;
  spawnAccum = 0;
  leftHeld = false;
  rightHeld = false;
  touchDir = 0;
  scoreEl.textContent = '0.0';
  bestEl.textContent = formatScore(best);
  wetEl.textContent = '0%';
  draw();
  setOverlay(
    'Şemsiye',
    'Sol/sağ ok (ya da A/D) ile yürü, savrulan damlaların altına şemsiyeyi tut. Rüzgâr 4-6 saniyede bir döner.',
    'Başla',
  );
}

function start(): void {
  if (state === 'playing') return;
  state = 'playing';
  startedAt = performance.now();
  lastFrame = startedAt;
  windChangeAt = startedAt + 3500 + Math.random() * 2000;
  windTarget = (Math.random() * 2 - 1) * 0.35;
  drops = [];
  for (let i = 0; i < 8; i++) {
    spawnDrop();
    const d = drops[drops.length - 1]!;
    d.y = Math.random() * GROUND_Y * 0.7;
  }
  hideOv(overlay);
  const myGen = gen.current();
  rafId = requestAnimationFrame(function tick(t: number) {
    if (!gen.isCurrent(myGen)) return;
    if (state !== 'playing') return;
    loop(t);
    rafId = requestAnimationFrame(tick);
  });
}

function gameOver(): void {
  if (state !== 'playing') return;
  state = 'gameover';
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
  gen.bump();
  if (score > best) {
    best = score;
    bestEl.textContent = formatScore(best);
    safeWrite(STORAGE_BEST, best);
  }
  draw();
  setOverlay(
    'Sırılsıklam!',
    `${formatScore(score)} saniye kuru kaldın.\nRekor: ${formatScore(best)} saniye`,
    'Tekrar dene',
  );
}

function pointInUmbrella(px: number, py: number): boolean {
  const cy = UMBRELLA_CENTER_Y;
  if (py > cy) return false;
  const nx = (px - playerX) / (UMBRELLA_W / 2);
  const ny = (py - cy) / UMBRELLA_H;
  return nx * nx + ny * ny <= 1;
}

function pointOnCharacter(px: number, py: number): boolean {
  if (py < HEAD_TOP_Y || py > FEET_Y) return false;
  const dx = px - playerX;
  const dyHead = py - (HEAD_TOP_Y + HEAD_R);
  if (dyHead * dyHead + dx * dx <= (HEAD_R + 1) * (HEAD_R + 1)) return true;
  if (py >= HEAD_TOP_Y + HEAD_R * 2 && Math.abs(dx) <= BODY_HALF_W + 1) return true;
  return false;
}

function loop(now: number): void {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  const elapsed = (now - startedAt) / 1000;

  if (now >= windChangeAt) {
    const maxMag = 0.4 + Math.min(0.55, elapsed / 35);
    let newTarget = (Math.random() * 2 - 1) * maxMag;
    if (Math.abs(newTarget - windTarget) < 0.25) {
      newTarget = -windTarget * maxMag;
    }
    windTarget = newTarget;
    windChangeAt = now + 3500 + Math.random() * 2500;
  }
  wind += (windTarget - wind) * Math.min(1, dt * 1.4);

  let mv = 0;
  if (leftHeld) mv -= 1;
  if (rightHeld) mv += 1;
  if (mv === 0) mv = touchDir;
  playerX += mv * MOVE_SPEED * dt;
  const minX = HEAD_R + 6;
  const maxX = canvas.width - HEAD_R - 6;
  if (playerX < minX) playerX = minX;
  if (playerX > maxX) playerX = maxX;

  const rate = SPAWN_BASE + elapsed * SPAWN_GROWTH;
  spawnAccum += rate * dt;
  while (spawnAccum >= 1) {
    spawnDrop();
    spawnAccum -= 1;
  }

  const alive: Drop[] = [];
  let hitThisFrame = 0;
  for (const d of drops) {
    d.x += d.vx * dt;
    d.y += d.vy * dt;
    if (pointInUmbrella(d.x, d.y)) continue;
    if (pointOnCharacter(d.x, d.y)) {
      hitThisFrame += WET_PER_HIT;
      continue;
    }
    if (d.y > GROUND_Y + 6) continue;
    if (d.x < -30 || d.x > canvas.width + 30) continue;
    alive.push(d);
  }
  drops = alive;
  if (hitThisFrame > 0) {
    wet = Math.min(WET_LIMIT, wet + hitThisFrame);
    wetEl.textContent = Math.floor(wet) + '%';
    if (wet >= WET_LIMIT) {
      gameOver();
      return;
    }
  }

  score = Math.floor((now - startedAt) / 100);
  scoreEl.textContent = formatScore(score);

  draw();
}

function draw(): void {
  const w = canvas.width;
  const h = canvas.height;

  const sky = ctx.createLinearGradient(0, 0, 0, GROUND_Y);
  sky.addColorStop(0, '#1c2533');
  sky.addColorStop(1, '#0c121b');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, GROUND_Y);

  ctx.fillStyle = '#1a1f29';
  ctx.fillRect(0, GROUND_Y, w, h - GROUND_Y);
  ctx.strokeStyle = 'rgba(125, 211, 252, 0.18)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, GROUND_Y + 0.5);
  ctx.lineTo(w, GROUND_Y + 0.5);
  ctx.stroke();

  drawDrops();
  drawCharacter();
  drawWindIndicator();
  if (state === 'playing') drawWetBar();
}

function drawDrops(): void {
  ctx.strokeStyle = '#7dd3fc';
  ctx.lineWidth = 1.6;
  ctx.lineCap = 'round';
  for (const d of drops) {
    const speed = Math.hypot(d.vx, d.vy);
    if (speed < 1) continue;
    const tail = Math.min(14, 9 + speed * 0.012);
    const ux = (d.vx / speed) * tail;
    const uy = (d.vy / speed) * tail;
    ctx.beginPath();
    ctx.moveTo(d.x, d.y);
    ctx.lineTo(d.x - ux, d.y - uy);
    ctx.stroke();
  }
}

function drawCharacter(): void {
  ctx.fillStyle = '#cbd5e1';
  const bodyTop = HEAD_TOP_Y + HEAD_R * 2;
  ctx.fillRect(playerX - BODY_HALF_W, bodyTop, BODY_HALF_W * 2, FEET_Y - bodyTop);
  ctx.beginPath();
  ctx.arc(playerX, HEAD_TOP_Y + HEAD_R, HEAD_R, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(playerX - 1, HEAD_TOP_Y + HEAD_R - 1, 2, 2);

  ctx.strokeStyle = '#94a3b8';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(playerX, UMBRELLA_CENTER_Y);
  ctx.lineTo(playerX, HEAD_TOP_Y - 2);
  ctx.stroke();

  ctx.fillStyle = '#ef4444';
  ctx.beginPath();
  ctx.ellipse(
    playerX,
    UMBRELLA_CENTER_Y,
    UMBRELLA_W / 2,
    UMBRELLA_H,
    0,
    Math.PI,
    Math.PI * 2,
  );
  ctx.lineTo(playerX - UMBRELLA_W / 2, UMBRELLA_CENTER_Y);
  ctx.fill();

  ctx.strokeStyle = '#7f1d1d';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.ellipse(
    playerX,
    UMBRELLA_CENTER_Y,
    UMBRELLA_W / 2,
    UMBRELLA_H,
    0,
    Math.PI,
    Math.PI * 2,
  );
  ctx.stroke();

  ctx.strokeStyle = '#7f1d1d';
  ctx.lineWidth = 1;
  for (let i = -2; i <= 2; i++) {
    const t = i / 2.4;
    const ex = playerX + (UMBRELLA_W / 2) * t * 0.95;
    const ey = UMBRELLA_CENTER_Y - UMBRELLA_H * Math.sqrt(Math.max(0, 1 - t * t * 0.9));
    ctx.beginPath();
    ctx.moveTo(playerX, UMBRELLA_CENTER_Y - UMBRELLA_H);
    ctx.lineTo(ex, ey);
    ctx.stroke();
  }
}

function drawWindIndicator(): void {
  const cx = canvas.width / 2;
  const cy = 26;
  const dx = wind * 70;
  const absW = Math.abs(wind);
  const color = absW < 0.05 ? '#475569' : absW > 0.55 ? '#fbbf24' : '#94a3b8';

  ctx.strokeStyle = 'rgba(148, 163, 184, 0.18)';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(cx - 70, cy);
  ctx.lineTo(cx + 70, cy);
  ctx.stroke();

  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + dx, cy);
  ctx.stroke();

  if (Math.abs(dx) > 4) {
    const sgn = Math.sign(dx);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(cx + dx, cy);
    ctx.lineTo(cx + dx - sgn * 9, cy - 6);
    ctx.lineTo(cx + dx - sgn * 9, cy + 6);
    ctx.closePath();
    ctx.fill();
  }

  ctx.fillStyle = '#94a3b8';
  ctx.font = '600 10px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('RÜZGÂR', cx, cy - 10);
}

function drawWetBar(): void {
  const barW = 130;
  const barH = 12;
  const x = canvas.width - barW - 18;
  const y = 16;
  ctx.fillStyle = 'rgba(15, 23, 42, 0.7)';
  ctx.fillRect(x, y, barW, barH);
  const frac = wet / WET_LIMIT;
  const color = frac < 0.5 ? '#22c55e' : frac < 0.8 ? '#fbbf24' : '#ef4444';
  ctx.fillStyle = color;
  ctx.fillRect(x, y, barW * frac, barH);
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.45)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, barW - 1, barH - 1);

  ctx.fillStyle = '#cbd5e1';
  ctx.font = '600 11px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText('ISLAKLIK', x - 8, y + 10);
}

function handleStartInput(): void {
  if (state === 'gameover') reset();
  start();
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  wetEl = document.querySelector<HTMLElement>('#wet')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  startBtn = document.querySelector<HTMLButtonElement>('#start')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  window.addEventListener('keydown', (e) => {
    if (e.key === 'r' || e.key === 'R') {
      reset();
      e.preventDefault();
      return;
    }
    if (state === 'ready' || state === 'gameover') {
      if (e.key === ' ' || e.key === 'Enter') {
        handleStartInput();
        e.preventDefault();
      }
      return;
    }
    if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') {
      leftHeld = true;
      e.preventDefault();
    } else if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') {
      rightHeld = true;
      e.preventDefault();
    }
  });

  window.addEventListener('keyup', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') leftHeld = false;
    else if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') rightHeld = false;
  });

  startBtn.addEventListener('click', handleStartInput);
  restartBtn.addEventListener('click', reset);

  let touchActive = false;
  canvas.addEventListener('pointerdown', (e) => {
    if (state !== 'playing') return;
    const rect = canvas.getBoundingClientRect();
    const sx = canvas.width / rect.width;
    const px = (e.clientX - rect.left) * sx;
    touchDir = px < playerX ? -1 : 1;
    touchActive = true;
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!touchActive || state !== 'playing') return;
    const rect = canvas.getBoundingClientRect();
    const sx = canvas.width / rect.width;
    const px = (e.clientX - rect.left) * sx;
    touchDir = px < playerX - 4 ? -1 : px > playerX + 4 ? 1 : 0;
  });
  const endTouch = (e: PointerEvent): void => {
    if (!touchActive) return;
    touchActive = false;
    touchDir = 0;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  };
  canvas.addEventListener('pointerup', endTouch);
  canvas.addEventListener('pointercancel', endTouch);
  canvas.addEventListener('pointerleave', endTouch);

  reset();
}

export const game = defineGame({ init, reset });
