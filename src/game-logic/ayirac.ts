import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOv, hideOverlay as hideOv } from '@shared/overlay';

const STORAGE_BEST = 'ayirac.best';
const W = 480;
const H = 480;
const CX = W / 2;
const CY = H / 2;
const DISC_R = 110;
const HIT_R = DISC_R + 6;
const SECTORS = 4;
const SECTOR_ANGLE = (Math.PI * 2) / SECTORS;
const TAU = Math.PI * 2;

// Sector colors, clockwise starting from disc-local angle 0 (east).
const COLORS = ['#ef4444', '#22c55e', '#3b82f6', '#facc15'];
const ROTATE_SPEED = 3.4; // rad/sec when key held

type State = 'ready' | 'playing' | 'paused' | 'gameover';
type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  colorIdx: number;
  dying?: 'absorbed' | 'rejected';
  age: number;
};

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let livesEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;

let state: State = 'ready';
let score = 0;
let best = 0;
let lives = 3;
let discRotation = 0;
let particles: Particle[] = [];
let spawnTimer = 0;
let elapsed = 0;
let lastTime = 0;
let rafHandle: number | null = null;
let flashUntil = 0;

const keysHeld = new Set<string>();

let dragging = false;
let dragLastAngle = 0;

function setOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOv(overlay);
}

function hideOverlay(): void {
  hideOv(overlay);
}

function currentSpawnInterval(): number {
  return Math.max(420, 1500 - elapsed * 18);
}

function currentParticleSpeed(): number {
  return Math.min(220, 90 + elapsed * 2.4);
}

function spawnParticle(): void {
  const angle = Math.random() * TAU;
  const spawnR = Math.max(W, H) / 2 + 40;
  const x = CX + Math.cos(angle) * spawnR;
  const y = CY + Math.sin(angle) * spawnR;
  const speed = currentParticleSpeed();
  const vx = -Math.cos(angle) * speed;
  const vy = -Math.sin(angle) * speed;
  const colorIdx = Math.floor(Math.random() * SECTORS);
  particles.push({ x, y, vx, vy, colorIdx, age: 0 });
}

function sectorAt(worldAngle: number): number {
  let local = worldAngle - discRotation;
  local = ((local % TAU) + TAU) % TAU;
  return Math.floor(local / SECTOR_ANGLE);
}

function onParticleHit(p: Particle): void {
  const ang = Math.atan2(p.y - CY, p.x - CX);
  const idx = sectorAt(ang);
  if (idx === p.colorIdx) {
    p.dying = 'absorbed';
    p.age = 0;
    score++;
    if (score > best) {
      best = score;
      safeWrite(STORAGE_BEST, best);
    }
    scoreEl.textContent = String(score);
    bestEl.textContent = String(best);
  } else {
    p.dying = 'rejected';
    p.age = 0;
    p.vx = -p.vx * 0.7;
    p.vy = -p.vy * 0.7;
    lives--;
    livesEl.textContent = String(lives);
    flashUntil = performance.now() + 220;
    if (lives <= 0) gameOver();
  }
}

function update(dt: number): void {
  if (state !== 'playing') return;
  elapsed += dt;

  let r = 0;
  if (keysHeld.has('left')) r -= ROTATE_SPEED;
  if (keysHeld.has('right')) r += ROTATE_SPEED;
  discRotation = ((discRotation + r * dt) % TAU + TAU) % TAU;

  spawnTimer += dt * 1000;
  const si = currentSpawnInterval();
  while (spawnTimer >= si) {
    spawnTimer -= si;
    spawnParticle();
  }

  for (const p of particles) {
    if (p.dying === 'absorbed') {
      p.age += dt;
      continue;
    }
    if (p.dying === 'rejected') {
      p.age += dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      continue;
    }
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    const dist = Math.hypot(p.x - CX, p.y - CY);
    if (dist <= HIT_R) {
      onParticleHit(p);
    }
  }

  particles = particles.filter((p) => {
    if (!p.dying) return true;
    return p.age < 0.5;
  });
}

function drawBg(): void {
  ctx.fillStyle = '#0a0b0e';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(255,255,255,0.035)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 40; i < W; i += 40) {
    ctx.moveTo(i, 0);
    ctx.lineTo(i, H);
    ctx.moveTo(0, i);
    ctx.lineTo(W, i);
  }
  ctx.stroke();
}

function drawHitRing(): void {
  const now = performance.now();
  const flashing = now < flashUntil;
  ctx.beginPath();
  ctx.arc(CX, CY, HIT_R + 4, 0, TAU);
  ctx.strokeStyle = flashing ? 'rgba(239,68,68,0.55)' : 'rgba(255,255,255,0.08)';
  ctx.lineWidth = flashing ? 4 : 1;
  ctx.stroke();
}

function drawDisc(): void {
  ctx.save();
  ctx.translate(CX, CY);

  for (let i = 0; i < SECTORS; i++) {
    const a0 = discRotation + i * SECTOR_ANGLE;
    const a1 = a0 + SECTOR_ANGLE;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, DISC_R, a0, a1);
    ctx.closePath();
    ctx.fillStyle = COLORS[i] ?? '#fff';
    ctx.fill();
  }

  ctx.strokeStyle = 'rgba(0,0,0,0.45)';
  ctx.lineWidth = 1.5;
  for (let i = 0; i < SECTORS; i++) {
    const a = discRotation + i * SECTOR_ANGLE;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(a) * DISC_R, Math.sin(a) * DISC_R);
    ctx.stroke();
  }

  ctx.beginPath();
  ctx.arc(0, 0, DISC_R, 0, TAU);
  ctx.strokeStyle = '#0a0b0e';
  ctx.lineWidth = 3;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(0, 0, 28, 0, TAU);
  ctx.fillStyle = '#0a0b0e';
  ctx.fill();
  ctx.strokeStyle = '#334';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Tick mark at center to indicate rotation axis is a wheel.
  ctx.beginPath();
  ctx.arc(0, 0, 4, 0, TAU);
  ctx.fillStyle = '#888';
  ctx.fill();

  ctx.restore();
}

function drawParticle(p: Particle): void {
  ctx.save();
  if (p.dying === 'absorbed') {
    const t = 1 - Math.min(1, p.age / 0.35);
    ctx.globalAlpha = t;
    ctx.translate(p.x, p.y);
    const r = 9 + (1 - t) * 14;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, TAU);
    ctx.strokeStyle = COLORS[p.colorIdx] ?? '#fff';
    ctx.lineWidth = 2.5;
    ctx.stroke();
  } else if (p.dying === 'rejected') {
    const t = 1 - Math.min(1, p.age / 0.5);
    ctx.globalAlpha = t;
    ctx.translate(p.x, p.y);
    ctx.beginPath();
    ctx.arc(0, 0, 9, 0, TAU);
    ctx.fillStyle = COLORS[p.colorIdx] ?? '#fff';
    ctx.fill();
    // X mark
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-5, -5);
    ctx.lineTo(5, 5);
    ctx.moveTo(5, -5);
    ctx.lineTo(-5, 5);
    ctx.stroke();
  } else {
    // Trail
    const sp = Math.hypot(p.vx, p.vy) || 1;
    const tlen = 22;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x - (p.vx / sp) * tlen, p.y - (p.vy / sp) * tlen);
    ctx.strokeStyle = (COLORS[p.colorIdx] ?? '#fff') + '88';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.stroke();
    // Body
    ctx.beginPath();
    ctx.arc(p.x, p.y, 9, 0, TAU);
    ctx.fillStyle = COLORS[p.colorIdx] ?? '#fff';
    ctx.fill();
    ctx.strokeStyle = '#0a0b0e';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  ctx.restore();
}

function draw(): void {
  drawBg();
  drawHitRing();
  drawDisc();
  for (const p of particles) drawParticle(p);
}

function loop(now: number): void {
  rafHandle = requestAnimationFrame(loop);
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;
  update(dt);
  draw();
}

function startLoop(): void {
  if (rafHandle !== null) return;
  lastTime = performance.now();
  rafHandle = requestAnimationFrame(loop);
}

function startGame(): void {
  state = 'playing';
  hideOverlay();
}

function pauseGame(): void {
  state = 'paused';
  setOverlay('Duraklatıldı', "Devam etmek için Boşluk'a bas.");
}

function resumeGame(): void {
  state = 'playing';
  hideOverlay();
}

function gameOver(): void {
  state = 'gameover';
  setOverlay(
    'Bitti',
    `Skor: ${score} · Rekor: ${best}\n\nYeniden başlamak için Boşluk veya R'ye bas.`,
  );
}

function reset(): void {
  state = 'ready';
  score = 0;
  lives = 3;
  particles = [];
  spawnTimer = 0;
  elapsed = 0;
  discRotation = 0;
  keysHeld.clear();
  dragging = false;
  scoreEl.textContent = '0';
  livesEl.textContent = '3';
  bestEl.textContent = String(best);
  setOverlay(
    'Ayıraç',
    "Diski döndür, taneciği renk yuvasına yönlendir.\n\n← → veya A / D · Boşluk: Başla",
  );
}

function spaceAction(): void {
  if (state === 'ready') startGame();
  else if (state === 'playing') pauseGame();
  else if (state === 'paused') resumeGame();
  else if (state === 'gameover') reset();
}

function onKeyDown(e: KeyboardEvent): void {
  const k = e.key;
  const lk = k.toLowerCase();
  if (lk === 'r') {
    e.preventDefault();
    reset();
    return;
  }
  if (k === ' ' || k === 'Spacebar') {
    e.preventDefault();
    spaceAction();
    return;
  }
  if (k === 'ArrowLeft' || lk === 'a') {
    e.preventDefault();
    keysHeld.add('left');
    if (state === 'ready') startGame();
    return;
  }
  if (k === 'ArrowRight' || lk === 'd') {
    e.preventDefault();
    keysHeld.add('right');
    if (state === 'ready') startGame();
    return;
  }
}

function onKeyUp(e: KeyboardEvent): void {
  const k = e.key;
  const lk = k.toLowerCase();
  if (k === 'ArrowLeft' || lk === 'a') keysHeld.delete('left');
  if (k === 'ArrowRight' || lk === 'd') keysHeld.delete('right');
}

function pointToCanvas(e: PointerEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * W;
  const y = ((e.clientY - rect.top) / rect.height) * H;
  return { x, y };
}

function onPointerDown(e: PointerEvent): void {
  const { x, y } = pointToCanvas(e);
  const dx = x - CX;
  const dy = y - CY;
  if (Math.hypot(dx, dy) > DISC_R + 60) return;
  if (state === 'ready') startGame();
  else if (state === 'paused') resumeGame();
  else if (state === 'gameover') {
    reset();
    return;
  }
  dragging = true;
  dragLastAngle = Math.atan2(dy, dx);
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {
    // ignore (older browsers/test envs)
  }
  e.preventDefault();
}

function onPointerMove(e: PointerEvent): void {
  if (!dragging) return;
  const { x, y } = pointToCanvas(e);
  const ang = Math.atan2(y - CY, x - CX);
  let delta = ang - dragLastAngle;
  if (delta > Math.PI) delta -= TAU;
  if (delta < -Math.PI) delta += TAU;
  discRotation = ((discRotation + delta) % TAU + TAU) % TAU;
  dragLastAngle = ang;
}

function onPointerUp(): void {
  dragging = false;
}

function onOverlayPointerDown(e: PointerEvent): void {
  if (state === 'ready') startGame();
  else if (state === 'paused') resumeGame();
  else if (state === 'gameover') reset();
  e.preventDefault();
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  livesEl = document.querySelector<HTMLElement>('#lives')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  restartBtn.addEventListener('click', reset);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  overlay.addEventListener('pointerdown', onOverlayPointerDown);

  reset();
  startLoop();
}

export const game = defineGame({ init, reset });
