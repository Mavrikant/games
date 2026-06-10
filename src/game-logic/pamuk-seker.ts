import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';

const STORAGE_BEST = 'pamuk-seker.best';
const W = 480;
const H = 480;
const CX = W / 2;
const CY = H / 2;
const ORBIT = 170;
const MACHINE_R = 36;
const STICK_ARC = 0.42;
const STICK_INNER = ORBIT - 14;
const STICK_OUTER = ORBIT + 30;
const OMEGA_MAX = 3.6;
const OMEGA_FRICTION = 0.92;
const OMEGA_INPUT = 0.18;
const SAFE_OMEGA = 2.3;
const FLING_RATE = 0.95;
const GAME_SECONDS = 60;

type State = 'ready' | 'playing' | 'gameover';

type Particle = {
  angle: number;
  r: number;
  vr: number;
  color: 'pink' | 'blue' | 'purple';
  value: number;
  alive: boolean;
};

const gen = createGenToken();
let state: State = 'ready';
let score = 0;
let best = 0;
let stickAngle = -Math.PI / 2;
let omega = 0;
let particles: Particle[] = [];
let spawnAccum = 0;
let timeLeft = GAME_SECONDS;
let lastFrame = 0;
let rafHandle = 0;
let twirlPhase = 0;
let flashAt = -1;
let lossPulse = 0;

const keys = { left: false, right: false, brake: false };

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let timerEl!: HTMLElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let restartBtn!: HTMLButtonElement;

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlay);
}

function hideOverlay(): void {
  hideOverlayEl(overlay);
}

function commitBest(): void {
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
}

function updateHud(): void {
  scoreEl.textContent = `${Math.floor(score)}g`;
  bestEl.textContent = `${Math.floor(best)}g`;
  timerEl.textContent = String(Math.max(0, Math.ceil(timeLeft)));
}

function reset(): void {
  gen.bump();
  state = 'ready';
  commitBest();
  score = 0;
  particles = [];
  spawnAccum = 0;
  timeLeft = GAME_SECONDS;
  stickAngle = -Math.PI / 2;
  omega = 0;
  twirlPhase = 0;
  flashAt = -1;
  lossPulse = 0;
  keys.left = keys.right = keys.brake = false;
  updateHud();
  draw();
  showOverlay('Pamuk Şeker', 'Çubuğu çevir: ← →  ·  Dur: Space  ·  60 saniye, en ağır şekeri sar.');
}

function startGame(): void {
  if (state === 'playing') return;
  state = 'playing';
  score = 0;
  particles = [];
  spawnAccum = 0;
  timeLeft = GAME_SECONDS;
  flashAt = -1;
  lossPulse = 0;
  updateHud();
  hideOverlay();
  lastFrame = performance.now();
  startLoop();
}

function endGame(): void {
  state = 'gameover';
  commitBest();
  updateHud();
  const msg = `Topladığın şeker: ${Math.floor(score)}g\nRekor: ${Math.floor(best)}g\nYeniden başlamak için R.`;
  showOverlay('Süre doldu', msg);
  stopLoop();
}

function startLoop(): void {
  stopLoop();
  const myGen = gen.current();
  const step = (now: number) => {
    if (!gen.isCurrent(myGen)) return;
    if (state !== 'playing') return;
    const dt = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;
    update(dt);
    draw();
    rafHandle = requestAnimationFrame(step);
  };
  rafHandle = requestAnimationFrame((t) => {
    lastFrame = t;
    step(t);
  });
}

function stopLoop(): void {
  if (rafHandle !== 0) {
    cancelAnimationFrame(rafHandle);
    rafHandle = 0;
  }
}

function spawnParticle(): void {
  const angle = Math.random() * Math.PI * 2;
  const speed = 110 + Math.random() * 90;
  const roll = Math.random();
  const color: Particle['color'] = roll < 0.65 ? 'pink' : roll < 0.9 ? 'blue' : 'purple';
  const value = color === 'pink' ? 4 : color === 'blue' ? 9 : 16;
  particles.push({
    angle,
    r: MACHINE_R * 0.6,
    vr: speed,
    color,
    value,
    alive: true,
  });
}

function update(dt: number): void {
  timeLeft -= dt;
  if (timeLeft <= 0) {
    timeLeft = 0;
    updateHud();
    endGame();
    return;
  }

  twirlPhase += dt * 4;

  if (keys.brake) {
    omega *= Math.pow(0.005, dt);
  } else {
    if (keys.left) omega -= OMEGA_INPUT;
    if (keys.right) omega += OMEGA_INPUT;
    omega *= Math.pow(OMEGA_FRICTION, dt * 60);
  }
  if (omega > OMEGA_MAX) omega = OMEGA_MAX;
  if (omega < -OMEGA_MAX) omega = -OMEGA_MAX;

  stickAngle += omega * dt;
  while (stickAngle > Math.PI) stickAngle -= Math.PI * 2;
  while (stickAngle < -Math.PI) stickAngle += Math.PI * 2;

  const overSpeed = Math.abs(omega) - SAFE_OMEGA;
  if (overSpeed > 0 && score > 0) {
    const lossPerSec = FLING_RATE * overSpeed * overSpeed;
    const lost = Math.min(score, score * (1 - Math.exp(-lossPerSec * dt)));
    score -= lost;
    lossPulse = Math.min(1, lossPulse + lost * 0.08);
  }
  lossPulse = Math.max(0, lossPulse - dt * 1.5);

  const baseRate = 2.6;
  const surge = (GAME_SECONDS - timeLeft) / GAME_SECONDS;
  const rate = baseRate + surge * 1.8;
  spawnAccum += rate * dt;
  while (spawnAccum >= 1) {
    spawnParticle();
    spawnAccum -= 1;
  }

  for (const p of particles) {
    if (!p.alive) continue;
    p.r += p.vr * dt;
    const crossed = p.r >= ORBIT && p.r - p.vr * dt < ORBIT;
    if (crossed) {
      if (angleInArc(p.angle, stickAngle, STICK_ARC)) {
        p.alive = false;
        score += p.value;
        flashAt = performance.now();
      }
    }
    if (p.r > Math.hypot(W, H)) p.alive = false;
  }
  particles = particles.filter((p) => p.alive);

  updateHud();
}

function angleInArc(target: number, center: number, arc: number): boolean {
  let diff = target - center;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return Math.abs(diff) <= arc / 2;
}

const cssCache = new Map<string, string>();
function getCss(name: string, fallback: string): string {
  const cached = cssCache.get(name);
  if (cached) return cached;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const out = v || fallback;
  cssCache.set(name, out);
  return out;
}

function colorFor(c: Particle['color']): string {
  if (c === 'pink') return '#ff8fc8';
  if (c === 'blue') return '#7cd0ff';
  return '#c89bff';
}

function draw(): void {
  ctx.fillStyle = getCss('--surface', '#13131a');
  ctx.fillRect(0, 0, W, H);

  ctx.save();
  ctx.translate(CX, CY);

  ctx.strokeStyle = 'rgba(255,255,255,0.07)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(0, 0, ORBIT, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.beginPath();
  ctx.arc(0, 0, ORBIT - 14, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, 0, ORBIT + 30, 0, Math.PI * 2);
  ctx.stroke();

  drawMachine();

  for (const p of particles) {
    if (!p.alive) continue;
    const x = Math.cos(p.angle) * p.r;
    const y = Math.sin(p.angle) * p.r;
    ctx.fillStyle = colorFor(p.color);
    ctx.shadowColor = colorFor(p.color);
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(x, y, p.color === 'purple' ? 4.5 : p.color === 'blue' ? 4 : 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.shadowBlur = 0;

  drawStick();

  ctx.restore();

  drawSpeedBar();

  if (lossPulse > 0.02) {
    ctx.fillStyle = `rgba(255,80,90,${0.18 * lossPulse})`;
    ctx.fillRect(0, 0, W, H);
  }
}

function drawMachine(): void {
  const g = ctx.createRadialGradient(0, 0, 4, 0, 0, MACHINE_R);
  g.addColorStop(0, '#fff0f6');
  g.addColorStop(0.6, '#ff79b0');
  g.addColorStop(1, '#7a2050');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, MACHINE_R, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 1.5;
  for (let i = 0; i < 6; i++) {
    const a = twirlPhase + (i * Math.PI) / 3;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(a) * MACHINE_R * 0.9, Math.sin(a) * MACHINE_R * 0.9);
    ctx.stroke();
  }

  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(0, 0, 5, 0, Math.PI * 2);
  ctx.fill();
}

function drawStick(): void {
  ctx.save();
  ctx.rotate(stickAngle);

  ctx.strokeStyle = '#c9b89b';
  ctx.lineCap = 'round';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(MACHINE_R + 8, 0);
  ctx.lineTo(STICK_OUTER, 0);
  ctx.stroke();

  const arcInner = ORBIT - 4;
  const arcOuter = ORBIT + 4;
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.beginPath();
  ctx.arc(0, 0, arcOuter, -STICK_ARC / 2, STICK_ARC / 2);
  ctx.arc(0, 0, arcInner, STICK_ARC / 2, -STICK_ARC / 2, true);
  ctx.closePath();
  ctx.fill();

  const size = Math.min(48, 6 + Math.sqrt(score) * 3.4);
  if (score > 0.5) {
    drawFluff(STICK_OUTER - 6, 0, size);
  }

  const tipDot = score > 0.5 ? '#ffd1e8' : '#888';
  ctx.fillStyle = tipDot;
  ctx.beginPath();
  ctx.arc(STICK_INNER, 0, 3, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

function drawFluff(x: number, y: number, size: number): void {
  const layers = [
    { dx: 0, dy: 0, r: size, alpha: 0.95, color: '#ffb3d4' },
    { dx: -size * 0.4, dy: -size * 0.3, r: size * 0.6, alpha: 0.85, color: '#ffd0e4' },
    { dx: size * 0.35, dy: size * 0.25, r: size * 0.55, alpha: 0.85, color: '#ff9bc6' },
    { dx: size * 0.2, dy: -size * 0.4, r: size * 0.5, alpha: 0.8, color: '#ffd6ee' },
    { dx: -size * 0.25, dy: size * 0.4, r: size * 0.5, alpha: 0.8, color: '#ff8fc0' },
  ];
  for (const l of layers) {
    ctx.fillStyle = l.color;
    ctx.globalAlpha = l.alpha;
    ctx.beginPath();
    ctx.arc(x + l.dx, y + l.dy, l.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  if (flashAt > 0) {
    const since = (performance.now() - flashAt) / 1000;
    if (since < 0.25) {
      ctx.fillStyle = `rgba(255,255,255,${0.6 * (1 - since / 0.25)})`;
      ctx.beginPath();
      ctx.arc(x, y, size * 1.1, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawSpeedBar(): void {
  const barW = 200;
  const barH = 6;
  const x = (W - barW) / 2;
  const y = H - 18;
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.fillRect(x, y, barW, barH);

  const safeFrac = SAFE_OMEGA / OMEGA_MAX;
  ctx.fillStyle = 'rgba(120,255,160,0.18)';
  ctx.fillRect(x + (barW / 2) * (1 - safeFrac), y, barW * safeFrac, barH);

  const norm = Math.max(-1, Math.min(1, omega / OMEGA_MAX));
  const cx = x + barW / 2;
  const len = (norm * barW) / 2;
  ctx.fillStyle = Math.abs(omega) > SAFE_OMEGA ? '#ff6b80' : '#a6f0c1';
  if (len >= 0) ctx.fillRect(cx, y, len, barH);
  else ctx.fillRect(cx + len, y, -len, barH);

  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.fillRect(cx - 0.5, y - 2, 1, barH + 4);
}

function onKeyDown(e: KeyboardEvent): void {
  const k = e.key.toLowerCase();
  if (k === 'r') {
    reset();
    e.preventDefault();
    return;
  }
  if (state === 'ready') {
    if (k === 'arrowleft' || k === 'a' || k === 'arrowright' || k === 'd' || k === ' ') {
      startGame();
    }
  }
  if (state !== 'playing') return;
  if (k === 'arrowleft' || k === 'a') {
    keys.left = true;
    e.preventDefault();
  } else if (k === 'arrowright' || k === 'd') {
    keys.right = true;
    e.preventDefault();
  } else if (k === ' ') {
    keys.brake = true;
    e.preventDefault();
  }
}

function onKeyUp(e: KeyboardEvent): void {
  const k = e.key.toLowerCase();
  if (k === 'arrowleft' || k === 'a') keys.left = false;
  else if (k === 'arrowright' || k === 'd') keys.right = false;
  else if (k === ' ') keys.brake = false;
}

function bindTouchButton(btn: HTMLButtonElement): void {
  const act = btn.dataset.act;
  if (!act) return;
  const set = (down: boolean) => {
    if (state === 'ready' && down) startGame();
    if (act === 'left') keys.left = down;
    else if (act === 'right') keys.right = down;
    else if (act === 'brake') keys.brake = down;
  };
  btn.addEventListener('pointerdown', (e) => {
    set(true);
    e.preventDefault();
  });
  btn.addEventListener('pointerup', () => set(false));
  btn.addEventListener('pointerleave', () => set(false));
  btn.addEventListener('pointercancel', () => set(false));
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  timerEl = document.querySelector<HTMLElement>('#timer')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  restartBtn.addEventListener('click', () => reset());

  document.querySelectorAll<HTMLButtonElement>('.touch__btn').forEach(bindTouchButton);

  reset();
}

export const game = defineGame({ init, reset });
