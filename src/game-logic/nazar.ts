import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';

const STORAGE_BEST = 'nazar.best';
const DIRS = 8;
const TAU = Math.PI * 2;

type State = 'ready' | 'playing' | 'gameover';

interface Eye {
  dir: number;        // 0..7 position index
  progress: number;   // 0..1 (1 = strikes)
  charge: number;     // ms total charge time
  age: number;        // ms since spawn
}

let state: State = 'ready';
let eyes: Eye[] = [];
let amuletDir = 0;
let score = 0;
let best = 0;
let lives = 3;
let lastTime = 0;
let spawnTimer = 0;
let flashDir = -1;
let flashTimer = 0;
let hitTimer = 0;
let rafRunning = false;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let livesEl!: HTMLElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let restartBtn!: HTMLButtonElement;

const cssCache = new Map<string, string>();
function getCss(name: string, fallback: string): string {
  const c = cssCache.get(name);
  if (c !== undefined) return c || fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  cssCache.set(name, v);
  return v || fallback;
}

function dirToAngle(dir: number): number {
  // dir 0 = top (north), going clockwise. canvas +y is down so top = -PI/2.
  return -Math.PI / 2 + (dir * TAU) / DIRS;
}

function dirPosition(dir: number, radius: number): { x: number; y: number } {
  const ang = dirToAngle(dir);
  return {
    x: canvas.width / 2 + Math.cos(ang) * radius,
    y: canvas.height / 2 + Math.sin(ang) * radius,
  };
}

function spawnEye(): void {
  const occupied = new Set(eyes.map((e) => e.dir));
  const free: number[] = [];
  for (let i = 0; i < DIRS; i++) if (!occupied.has(i)) free.push(i);
  if (free.length === 0) return;
  const dir = free[Math.floor(Math.random() * free.length)]!;
  const charge = Math.max(1100, 3400 - score * 45);
  eyes.push({ dir, progress: 0, charge, age: 0 });
}

function deflect(dir: number): void {
  const idx = eyes.findIndex((e) => e.dir === dir);
  if (idx < 0) return;
  eyes.splice(idx, 1);
  score++;
  scoreEl.textContent = String(score);
  if (score > best) {
    best = score;
    bestEl.textContent = String(best);
    safeWrite(STORAGE_BEST, best);
  }
  flashDir = dir;
  flashTimer = 220;
}

function faceDir(dir: number): void {
  if (state === 'gameover') return;
  if (dir < 0 || dir >= DIRS) return;
  if (state === 'ready') startPlaying();
  amuletDir = dir;
  deflect(dir);
}

function rotateAmulet(delta: number): void {
  if (state === 'gameover') return;
  if (state === 'ready') startPlaying();
  amuletDir = ((amuletDir + delta) % DIRS + DIRS) % DIRS;
  deflect(amuletDir);
}

function startPlaying(): void {
  state = 'playing';
  hideOverlayEl(overlay);
  spawnTimer = 600;
}

function loseLife(): void {
  lives--;
  hitTimer = 360;
  updateLives();
  if (lives <= 0) gameOver();
}

function updateLives(): void {
  livesEl.textContent = lives > 0 ? '●'.repeat(lives) : '—';
}

function gameOver(): void {
  state = 'gameover';
  eyes = [];
  overlayTitle.textContent = 'Kem göz değdi!';
  overlayMsg.textContent =
    `Skor: ${score} · Rekor: ${best}\n` +
    'Tekrar denemek için Boşluk veya R.';
  showOverlayEl(overlay);
}

function reset(): void {
  state = 'ready';
  score = 0;
  lives = 3;
  eyes = [];
  amuletDir = 0;
  flashDir = -1;
  flashTimer = 0;
  hitTimer = 0;
  spawnTimer = 0;
  scoreEl.textContent = '0';
  bestEl.textContent = String(best);
  updateLives();
  overlayTitle.textContent = 'Nazar';
  overlayMsg.textContent =
    'Sekiz yönde kem gözler açılır. Muskayı çevir, dolgu tamamlanmadan savuştur.\n' +
    '1-8: yöne bak · ←/→: 45° döndür · Tıkla: o yöne bak · Boşluk: başla';
  showOverlayEl(overlay);
}

function step(dt: number): void {
  if (state !== 'playing') return;

  spawnTimer -= dt;
  if (spawnTimer <= 0) {
    spawnEye();
    const interval = Math.max(320, 950 - score * 18);
    spawnTimer = interval + Math.random() * 250;
  }

  for (const e of eyes) {
    e.age += dt;
    e.progress += dt / e.charge;
  }
  for (let i = eyes.length - 1; i >= 0; i--) {
    if (eyes[i]!.progress >= 1) {
      eyes.splice(i, 1);
      loseLife();
      if (state !== 'playing') return;
    }
  }

  if (flashTimer > 0) flashTimer = Math.max(0, flashTimer - dt);
  if (hitTimer > 0) hitTimer = Math.max(0, hitTimer - dt);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function draw(): void {
  const W = canvas.width;
  const H = canvas.height;
  const cx = W / 2;
  const cy = H / 2;
  const radius = Math.min(W, H) * 0.36;

  ctx.fillStyle = getCss('--nazar-bg', '#0a0d18');
  ctx.fillRect(0, 0, W, H);

  ctx.save();
  ctx.globalAlpha = 0.55;
  for (let i = 0; i < 56; i++) {
    const seedX = ((i * 9301 + 49297) % 233280) / 233280;
    const seedY = ((i * 4691 + 13713) % 233280) / 233280;
    const x = seedX * W;
    const y = seedY * H;
    const inset = Math.hypot(x - cx, y - cy);
    if (inset < radius - 30) continue;
    const s = (i % 3) + 1;
    ctx.fillStyle = i % 6 === 0 ? '#f0b73b' : '#5b6ccc';
    ctx.fillRect(x, y, s * 0.6, s * 0.6);
  }
  ctx.restore();

  if (hitTimer > 0) {
    const t = hitTimer / 360;
    ctx.fillStyle = `rgba(220, 38, 38, ${0.18 * t})`;
    ctx.fillRect(0, 0, W, H);
  }

  ctx.save();
  ctx.strokeStyle = getCss('--nazar-ring', '#1d2638');
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, TAU);
  ctx.stroke();
  for (let d = 0; d < DIRS; d++) {
    const ang = dirToAngle(d);
    const x1 = cx + Math.cos(ang) * (radius - 8);
    const y1 = cy + Math.sin(ang) * (radius - 8);
    const x2 = cx + Math.cos(ang) * (radius + 8);
    const y2 = cy + Math.sin(ang) * (radius + 8);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
  ctx.restore();

  for (const e of eyes) drawEye(e, radius);

  drawAmulet(cx, cy);

  if (flashTimer > 0 && flashDir >= 0) {
    const t = flashTimer / 220;
    ctx.save();
    ctx.strokeStyle = `rgba(125, 211, 252, ${0.7 * t})`;
    ctx.lineWidth = 4 + 8 * t;
    const ang = dirToAngle(flashDir);
    const r1 = 50;
    const r2 = radius - 30;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(ang) * r1, cy + Math.sin(ang) * r1);
    ctx.lineTo(cx + Math.cos(ang) * r2, cy + Math.sin(ang) * r2);
    ctx.stroke();
    ctx.restore();
  }
}

function drawEye(e: Eye, ringRadius: number): void {
  const { x, y } = dirPosition(e.dir, ringRadius);
  const r = 26;
  const ang = dirToAngle(e.dir);

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(ang + Math.PI / 2);

  ctx.fillStyle = '#f6efe0';
  ctx.beginPath();
  ctx.ellipse(0, 0, r, r * 0.62, 0, 0, TAU);
  ctx.fill();

  const ir = Math.round(lerp(80, 220, e.progress));
  const ig = Math.round(lerp(120, 30, e.progress));
  const ib = Math.round(lerp(220, 30, e.progress));
  ctx.fillStyle = `rgb(${ir}, ${ig}, ${ib})`;
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.42, 0, TAU);
  ctx.fill();

  ctx.fillStyle = '#0a0a0a';
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.22, 0, TAU);
  ctx.fill();

  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(-r * 0.12, -r * 0.1, r * 0.08, 0, TAU);
  ctx.fill();
  ctx.restore();

  const ringColour =
    e.progress > 0.75 ? '#ef4444' : e.progress > 0.45 ? '#f59e0b' : '#86efac';
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = ringColour;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(0, 0, r + 8, -Math.PI / 2, -Math.PI / 2 + e.progress * TAU);
  ctx.stroke();
  ctx.restore();
}

function drawAmulet(cx: number, cy: number): void {
  const baseR = 28;

  ctx.save();
  ctx.shadowColor = '#22d3ee';
  ctx.shadowBlur = 18;
  ctx.fillStyle = '#0e7490';
  ctx.beginPath();
  ctx.arc(cx, cy, baseR + 4, 0, TAU);
  ctx.fill();
  ctx.restore();

  ctx.fillStyle = '#0c4a6e';
  ctx.beginPath();
  ctx.arc(cx, cy, baseR, 0, TAU);
  ctx.fill();

  ctx.fillStyle = '#f0f9ff';
  ctx.beginPath();
  ctx.arc(cx, cy, baseR * 0.72, 0, TAU);
  ctx.fill();

  ctx.fillStyle = '#0ea5e9';
  ctx.beginPath();
  ctx.arc(cx, cy, baseR * 0.5, 0, TAU);
  ctx.fill();

  ctx.fillStyle = '#0c2330';
  ctx.beginPath();
  ctx.arc(cx, cy, baseR * 0.22, 0, TAU);
  ctx.fill();

  const ang = dirToAngle(amuletDir);
  const tip = baseR + 22;
  const baseDist = baseR + 6;
  const halfW = 9;
  const tx = cx + Math.cos(ang) * tip;
  const ty = cy + Math.sin(ang) * tip;
  const nx = Math.cos(ang + Math.PI / 2);
  const ny = Math.sin(ang + Math.PI / 2);
  const bx1 = cx + Math.cos(ang) * baseDist + nx * halfW;
  const by1 = cy + Math.sin(ang) * baseDist + ny * halfW;
  const bx2 = cx + Math.cos(ang) * baseDist - nx * halfW;
  const by2 = cy + Math.sin(ang) * baseDist - ny * halfW;

  ctx.save();
  ctx.fillStyle = '#fbbf24';
  ctx.shadowColor = '#fbbf24';
  ctx.shadowBlur = 14;
  ctx.beginPath();
  ctx.moveTo(tx, ty);
  ctx.lineTo(bx1, by1);
  ctx.lineTo(bx2, by2);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function frame(t: number): void {
  if (lastTime === 0) lastTime = t;
  const dt = Math.min(60, t - lastTime);
  lastTime = t;

  step(dt);
  draw();

  requestAnimationFrame(frame);
}

function dirFromPointer(clientX: number, clientY: number): number {
  const rect = canvas.getBoundingClientRect();
  const px = ((clientX - rect.left) / rect.width) * canvas.width;
  const py = ((clientY - rect.top) / rect.height) * canvas.height;
  const dx = px - canvas.width / 2;
  const dy = py - canvas.height / 2;
  if (dx === 0 && dy === 0) return amuletDir;
  let normalized = Math.atan2(dy, dx) + Math.PI / 2;
  while (normalized < 0) normalized += TAU;
  return Math.round((normalized / TAU) * DIRS) % DIRS;
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  livesEl = document.querySelector<HTMLElement>('#lives')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  window.addEventListener('keydown', (e) => {
    const k = e.key;
    if (k >= '1' && k <= '8') {
      const idx = k.charCodeAt(0) - '1'.charCodeAt(0);
      faceDir(idx);
      e.preventDefault();
    } else if (k === 'ArrowLeft' || k.toLowerCase() === 'a') {
      rotateAmulet(-1);
      e.preventDefault();
    } else if (k === 'ArrowRight' || k.toLowerCase() === 'd') {
      rotateAmulet(1);
      e.preventDefault();
    } else if (k === ' ' || k === 'Enter') {
      if (state === 'ready') {
        startPlaying();
        e.preventDefault();
      } else if (state === 'gameover') {
        reset();
        e.preventDefault();
      }
    } else if (k.toLowerCase() === 'r') {
      reset();
      e.preventDefault();
    }
  });

  canvas.addEventListener('pointerdown', (e) => {
    if (state === 'gameover') {
      reset();
      e.preventDefault();
      return;
    }
    const dir = dirFromPointer(e.clientX, e.clientY);
    faceDir(dir);
    e.preventDefault();
  });

  document.querySelectorAll<HTMLButtonElement>('.touch__btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      if (action === 'start') {
        if (state === 'ready') startPlaying();
        else if (state === 'gameover') reset();
        return;
      }
      const dirAttr = btn.dataset.dir;
      if (dirAttr === undefined) return;
      faceDir(parseInt(dirAttr, 10));
    });
  });

  overlay.addEventListener('pointerdown', (e) => {
    if (state === 'ready') {
      startPlaying();
      e.preventDefault();
    } else if (state === 'gameover') {
      reset();
      e.preventDefault();
    }
  });

  restartBtn.addEventListener('click', reset);

  reset();

  if (!rafRunning) {
    rafRunning = true;
    requestAnimationFrame(frame);
  }
}

export const game = defineGame({ init, reset });
