import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';

const STORAGE_BEST = 'tek-nefes.best';

const W = 480;
const H = 540;
const SURFACE_Y = 80;
const DIVER_RADIUS = 11;
const DIVER_SPEED = 145;
const PEARL_RADIUS = 9;
const BUBBLE_RADIUS = 9;
const MAX_AIR = 100;
const AIR_REGEN = 65;
const AIR_DRAIN_BASE = 5;
const AIR_DRAIN_DEEP = 19;
const PEARL_COUNT = 3;
const BUBBLE_INTERVAL_MS = 3800;
const BUBBLE_MAX = 2;
const BUBBLE_RESTORE = 22;

type State = 'ready' | 'playing' | 'over';
type Vec = { x: number; y: number };
type Pearl = { x: number; y: number; value: number };
type Bubble = { x: number; y: number; vy: number };

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let airFill!: HTMLElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let restartBtn!: HTMLButtonElement;

let state: State = 'ready';
let diver: Vec = { x: W / 2, y: SURFACE_Y - DIVER_RADIUS - 4 };
let target: Vec = { x: diver.x, y: diver.y };
let pearls: Pearl[] = [];
let bubbles: Bubble[] = [];
let air = MAX_AIR;
let score = 0;
let best = 0;
let bubbleTimerMs = 0;
let lastTs = 0;
let rafHandle: number | null = null;
let lowAirAt: number | null = null;

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.innerHTML = msg;
  showOverlayEl(overlay);
}

function hideOverlay(): void {
  hideOverlayEl(overlay);
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function spawnPearl(): Pearl {
  const y = rand(SURFACE_Y + 28, H - 26);
  const x = rand(28, W - 28);
  const depthFrac = (y - SURFACE_Y) / (H - SURFACE_Y);
  const value = 1 + Math.floor(depthFrac * 8);
  return { x, y, value };
}

function spawnBubble(): Bubble {
  return {
    x: rand(40, W - 40),
    y: rand(H - 90, H - 30),
    vy: -rand(28, 48),
  };
}

function reset(): void {
  state = 'ready';
  diver = { x: W / 2, y: SURFACE_Y - DIVER_RADIUS - 4 };
  target = { x: diver.x, y: diver.y };
  pearls = [];
  for (let i = 0; i < PEARL_COUNT; i++) pearls.push(spawnPearl());
  bubbles = [];
  air = MAX_AIR;
  score = 0;
  bubbleTimerMs = 0;
  lowAirAt = null;
  scoreEl.textContent = '0';
  bestEl.textContent = String(best);
  updateAirBar();
  stopLoop();
  draw();
  showOverlay(
    'Tek Nefes',
    'Dalmak için bir noktaya tıkla veya dokun.<br />Derinlik = değer; ama nefesini izle.',
  );
}

function startPlaying(): void {
  if (state !== 'ready') return;
  state = 'playing';
  hideOverlay();
  lastTs = performance.now();
  startLoop();
}

function startLoop(): void {
  if (rafHandle !== null) return;
  rafHandle = requestAnimationFrame(loop);
}

function stopLoop(): void {
  if (rafHandle !== null) {
    cancelAnimationFrame(rafHandle);
    rafHandle = null;
  }
}

function loop(ts: number): void {
  rafHandle = null;
  if (state !== 'playing') return;
  const dt = Math.min(0.05, (ts - lastTs) / 1000);
  lastTs = ts;
  step(dt);
  draw();
  if (state === 'playing') {
    rafHandle = requestAnimationFrame(loop);
  }
}

function step(dt: number): void {
  // Diver glides toward target.
  const dx = target.x - diver.x;
  const dy = target.y - diver.y;
  const dist = Math.hypot(dx, dy);
  if (dist > 0.5) {
    const move = Math.min(dist, DIVER_SPEED * dt);
    diver.x += (dx / dist) * move;
    diver.y += (dy / dist) * move;
  }
  diver.x = Math.max(DIVER_RADIUS, Math.min(W - DIVER_RADIUS, diver.x));
  diver.y = Math.max(DIVER_RADIUS, Math.min(H - DIVER_RADIUS, diver.y));

  // Air: regen at surface, drain underwater (deeper = faster).
  const submerged = diver.y > SURFACE_Y + 2;
  if (submerged) {
    const depthFrac = Math.max(0, Math.min(1, (diver.y - SURFACE_Y) / (H - SURFACE_Y)));
    const drain = AIR_DRAIN_BASE + AIR_DRAIN_DEEP * depthFrac;
    air -= drain * dt;
    if (air <= 0) {
      air = 0;
      updateAirBar();
      gameOver();
      return;
    }
  } else {
    air = Math.min(MAX_AIR, air + AIR_REGEN * dt);
  }
  updateAirBar();

  // Pearl pickups.
  for (let i = pearls.length - 1; i >= 0; i--) {
    const p = pearls[i]!;
    const d = Math.hypot(p.x - diver.x, p.y - diver.y);
    if (d < DIVER_RADIUS + PEARL_RADIUS) {
      score += p.value;
      scoreEl.textContent = String(score);
      pearls.splice(i, 1);
      pearls.push(spawnPearl());
    }
  }

  // Bubble spawn + pickups.
  bubbleTimerMs += dt * 1000;
  if (bubbleTimerMs >= BUBBLE_INTERVAL_MS && bubbles.length < BUBBLE_MAX) {
    bubbleTimerMs = 0;
    bubbles.push(spawnBubble());
  }
  for (let i = bubbles.length - 1; i >= 0; i--) {
    const b = bubbles[i]!;
    b.y += b.vy * dt;
    if (b.y < SURFACE_Y - 4) {
      bubbles.splice(i, 1);
      continue;
    }
    const d = Math.hypot(b.x - diver.x, b.y - diver.y);
    if (d < DIVER_RADIUS + BUBBLE_RADIUS) {
      air = Math.min(MAX_AIR, air + BUBBLE_RESTORE);
      bubbles.splice(i, 1);
      updateAirBar();
    }
  }
}

function gameOver(): void {
  state = 'over';
  stopLoop();
  if (score > best) {
    best = score;
    bestEl.textContent = String(best);
    safeWrite(STORAGE_BEST, best);
  }
  draw();
  const msg = score > 0
    ? `Skor: <strong>${score}</strong> · En iyi: ${best}<br />Yeniden başla için R'ye bas.`
    : `Hiç inci toplayamadın.<br />Yeniden başla için R'ye bas.`;
  showOverlay('Nefes Tükendi', msg);
}

function updateAirBar(): void {
  const pct = Math.max(0, Math.min(100, air));
  airFill.style.width = pct.toFixed(1) + '%';
  airFill.style.background = pct < 25 ? 'var(--tn-air-low)' : 'var(--tn-air-ok)';
  lowAirAt = pct < 25 ? performance.now() : null;
}

function draw(): void {
  // Sky band.
  ctx.fillStyle = getCss('--tn-sky') || '#79b8e8';
  ctx.fillRect(0, 0, W, SURFACE_Y);

  // Water column with vertical gradient — darker the deeper.
  const grad = ctx.createLinearGradient(0, SURFACE_Y, 0, H);
  grad.addColorStop(0, getCss('--tn-water-top') || '#1a5985');
  grad.addColorStop(0.55, getCss('--tn-water-mid') || '#07273f');
  grad.addColorStop(1, getCss('--tn-water-bot') || '#020a16');
  ctx.fillStyle = grad;
  ctx.fillRect(0, SURFACE_Y, W, H - SURFACE_Y);

  // Wavy surface line.
  const now = performance.now();
  ctx.strokeStyle = 'rgba(255,255,255,0.45)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let x = 0; x <= W; x += 8) {
    const y = SURFACE_Y + Math.sin((x + now / 220) / 22) * 2.5;
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Faint depth bands.
  ctx.fillStyle = 'rgba(255,255,255,0.045)';
  for (let y = SURFACE_Y + 80; y < H; y += 80) {
    ctx.fillRect(0, y, W, 1);
  }

  // Rising bubbles.
  for (const b of bubbles) {
    ctx.fillStyle = getCss('--tn-bubble') || '#aed7f5';
    ctx.globalAlpha = 0.55;
    ctx.beginPath();
    ctx.arc(b.x, b.y, BUBBLE_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(b.x, b.y, BUBBLE_RADIUS, 0, Math.PI * 2);
    ctx.stroke();
    // little highlight
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath();
    ctx.arc(b.x - 3, b.y - 3, 2, 0, Math.PI * 2);
    ctx.fill();
  }

  // Pearls.
  for (const p of pearls) {
    const radial = ctx.createRadialGradient(p.x - 2, p.y - 2, 1, p.x, p.y, PEARL_RADIUS + 3);
    radial.addColorStop(0, '#ffffff');
    radial.addColorStop(0.5, getCss('--tn-pearl') || '#f5fbff');
    radial.addColorStop(1, getCss('--tn-pearl-glow') || '#b9def7');
    ctx.fillStyle = radial;
    ctx.beginPath();
    ctx.arc(p.x, p.y, PEARL_RADIUS + 1, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#0b132b';
    ctx.font = '700 11px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(p.value), p.x, p.y + 0.5);
  }

  drawDiver();

  // Low-air vignette pulse.
  if (lowAirAt !== null && state === 'playing') {
    const pulse = 0.18 + 0.12 * Math.sin(now / 120);
    ctx.fillStyle = `rgba(248,113,113,${pulse.toFixed(3)})`;
    ctx.fillRect(0, 0, W, H);
  }
}

function drawDiver(): void {
  const body = getCss('--tn-diver') || '#fbbf24';
  const submerged = diver.y > SURFACE_Y + 2;

  // Body.
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(diver.x, diver.y, DIVER_RADIUS, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.45)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Goggles.
  ctx.fillStyle = '#0b132b';
  ctx.beginPath();
  ctx.ellipse(diver.x, diver.y - 1, 6, 3.5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#7dd3fc';
  ctx.fillRect(diver.x - 4, diver.y - 2.5, 3, 1.4);
  ctx.fillRect(diver.x + 1, diver.y - 2.5, 3, 1.4);

  // Tiny snorkel above water; tiny rising bubble underwater.
  if (!submerged) {
    ctx.fillStyle = '#0b132b';
    ctx.fillRect(diver.x + DIVER_RADIUS - 1, diver.y - DIVER_RADIUS - 7, 2, 7);
  } else {
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    const t = (performance.now() / 220) % 1;
    ctx.beginPath();
    ctx.arc(diver.x + 4, diver.y - DIVER_RADIUS - 4 - t * 10, 1.6 + t * 0.6, 0, Math.PI * 2);
    ctx.fill();
  }
}

const cssCache = new Map<string, string>();
function getCss(varName: string): string {
  const cached = cssCache.get(varName);
  if (cached !== undefined) return cached;
  const val = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  cssCache.set(varName, val);
  return val;
}

function pointerToCanvas(clientX: number, clientY: number): Vec {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return {
    x: (clientX - rect.left) * scaleX,
    y: (clientY - rect.top) * scaleY,
  };
}

function setTarget(clientX: number, clientY: number): void {
  if (state === 'over') return;
  const p = pointerToCanvas(clientX, clientY);
  target = {
    x: Math.max(0, Math.min(W, p.x)),
    y: Math.max(0, Math.min(H, p.y)),
  };
  if (state === 'ready') startPlaying();
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  airFill = document.querySelector<HTMLElement>('#air-fill')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  canvas.addEventListener('mousedown', (e) => {
    e.preventDefault();
    setTarget(e.clientX, e.clientY);
  });
  canvas.addEventListener('mousemove', (e) => {
    if (e.buttons === 1 && state === 'playing') {
      setTarget(e.clientX, e.clientY);
    }
  });
  canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    const t = e.touches[0];
    if (t) setTarget(t.clientX, t.clientY);
  }, { passive: false });
  canvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    if (state !== 'playing') return;
    const t = e.touches[0];
    if (t) setTarget(t.clientX, t.clientY);
  }, { passive: false });

  window.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 'r') {
      reset();
      e.preventDefault();
    }
  });

  restartBtn.addEventListener('click', reset);

  reset();
}

export const game = defineGame({ init, reset });
