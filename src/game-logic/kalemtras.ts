import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';
import { reportGameOver } from '@shared/leaderboard';

const STORAGE_BEST = 'kalemtras.best';
const SCORE_DESC = { gameId: 'kalemtras', storageKey: STORAGE_BEST, direction: 'higher' as const };
const ROUND_MS = 60_000;
const FILL_BASE = 0.55;
const FILL_STEP = 0.025;
const BAND_BASE_WIDTH = 0.42;
const BAND_MIN_WIDTH = 0.10;
const BAND_SHRINK = 0.018;
const BAND_CENTER_MIN = 0.46;
const BAND_CENTER_MAX = 0.82;

type State = 'ready' | 'playing' | 'gameover';
type Outcome = 'sharp' | 'dull' | 'snap';
type Particle = { x: number; y: number; vx: number; vy: number; life: number; max: number; rot: number; vr: number; color: string };

const gen = createGenToken();

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let timeEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;

let state: State = 'ready';
let score = 0;
let best = 0;
let rounds = 0;

let progress = 0;
let holding = false;
let lastFrameMs = 0;
let endsAt = 0;
let pencilLen = 1;
let handleAngle = 0;
let flashMs = 0;
let flashKind: Outcome | null = null;
let particles: Particle[] = [];
let rafId = 0;

function currentFillRate(): number {
  return FILL_BASE + Math.min(rounds, 30) * FILL_STEP;
}

function bandWidth(): number {
  return Math.max(BAND_MIN_WIDTH, BAND_BASE_WIDTH - Math.min(rounds, 30) * BAND_SHRINK);
}

function bandCenter(): number {
  const seed = rounds * 1664525 + 1013904223;
  const r = ((seed >>> 0) % 1000) / 1000;
  return BAND_CENTER_MIN + r * (BAND_CENTER_MAX - BAND_CENTER_MIN);
}

function classify(): Outcome {
  const c = bandCenter();
  const w = bandWidth();
  const low = c - w / 2;
  const high = c + w / 2;
  if (progress < low) return 'dull';
  if (progress > high) return 'snap';
  return 'sharp';
}

function setScore(n: number): void {
  score = n;
  scoreEl.textContent = String(score);
  if (score > best) {
    best = score;
    bestEl.textContent = String(best);
    safeWrite(STORAGE_BEST, best);
  }
}

function showOverlayWith(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlay);
}

function spawnShavings(n: number): void {
  const cx = 232;
  const cy = 184;
  const colors = ['#d4a17a', '#b67d4a', '#8c5a2a'];
  for (let i = 0; i < n; i++) {
    const a = Math.PI * (0.85 + Math.random() * 0.4);
    const sp = 60 + Math.random() * 80;
    particles.push({
      x: cx,
      y: cy,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp * 0.6 - 20,
      life: 0,
      max: 0.6 + Math.random() * 0.5,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 6,
      color: colors[i % colors.length]!,
    });
  }
}

function spawnSnap(): void {
  for (let i = 0; i < 14; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = 80 + Math.random() * 140;
    particles.push({
      x: 232,
      y: 178,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp - 40,
      life: 0,
      max: 0.5 + Math.random() * 0.4,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 10,
      color: '#3a2a1a',
    });
  }
}

function release(): void {
  if (state !== 'playing' || !holding) return;
  holding = false;
  canvas.classList.remove('holding');
  const out = classify();
  flashKind = out;
  flashMs = 0.45;
  if (out === 'sharp') {
    setScore(score + 1);
    pencilLen = 1;
    spawnShavings(8);
  } else if (out === 'snap') {
    setScore(Math.max(0, score - 1));
    pencilLen = 1;
    spawnSnap();
  } else {
    pencilLen = 1;
  }
  rounds++;
  progress = 0;
}

function startPress(): void {
  if (state === 'ready') {
    beginRound();
  } else if (state === 'gameover') {
    return;
  }
  if (state !== 'playing') return;
  if (holding) return;
  holding = true;
  canvas.classList.add('holding');
}

function beginRound(): void {
  gen.bump();
  state = 'playing';
  score = 0;
  rounds = 0;
  progress = 0;
  pencilLen = 1;
  handleAngle = 0;
  particles = [];
  flashMs = 0;
  flashKind = null;
  holding = false;
  canvas.classList.remove('holding');
  scoreEl.textContent = '0';
  bestEl.textContent = String(best);
  endsAt = performance.now() + ROUND_MS;
  timeEl.textContent = '60';
  hideOverlayEl(overlay);
  startLoop();
}

function endRound(): void {
  state = 'gameover';
  holding = false;
  canvas.classList.remove('holding');
  reportGameOver(SCORE_DESC, score);
  showOverlayWith(
    'Süre doldu',
    `Yontulan: ${score} · Rekor: ${best}\n\nR ile yeniden başla`,
  );
}

function reset(): void {
  gen.bump();
  state = 'ready';
  score = 0;
  rounds = 0;
  progress = 0;
  pencilLen = 1;
  handleAngle = 0;
  particles = [];
  flashMs = 0;
  flashKind = null;
  holding = false;
  canvas.classList.remove('holding');
  scoreEl.textContent = '0';
  bestEl.textContent = String(best);
  timeEl.textContent = '60';
  showOverlayWith(
    'Kalemtıraş',
    'Tuşu basılı tut, çubuk yeşil banttayken bırak.\n\nSpace veya ekrana tıkla · R: yeniden başla',
  );
}

function startLoop(): void {
  const myGen = gen.current();
  lastFrameMs = performance.now();
  const step = (now: number): void => {
    if (!gen.isCurrent(myGen)) return;
    const dt = Math.min(0.05, (now - lastFrameMs) / 1000);
    lastFrameMs = now;
    update(dt, now);
    draw();
    rafId = requestAnimationFrame(step);
  };
  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(step);
}

function update(dt: number, now: number): void {
  if (state === 'playing') {
    if (holding) {
      progress = Math.min(1, progress + currentFillRate() * dt);
      handleAngle += dt * 7;
      if (Math.random() < dt * 18) spawnShavings(1);
    } else {
      handleAngle += dt * 0.2;
    }
    const remaining = Math.max(0, endsAt - now);
    timeEl.textContent = String(Math.ceil(remaining / 1000));
    if (remaining <= 0) {
      endRound();
    }
  }
  if (flashMs > 0) flashMs = Math.max(0, flashMs - dt);
  for (const p of particles) {
    p.life += dt;
    p.vy += 280 * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.rot += p.vr * dt;
  }
  particles = particles.filter((p) => p.life < p.max && p.y < 380);
}

function getCss(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function draw(): void {
  const W = canvas.width;
  const H = canvas.height;
  ctx.fillStyle = '#14171c';
  ctx.fillRect(0, 0, W, H);

  drawBench();
  drawPencil();
  drawSharpener();
  drawHandle();
  drawParticles();
  drawBar();

  if (flashMs > 0 && flashKind) {
    const alpha = Math.min(0.35, flashMs);
    ctx.fillStyle =
      flashKind === 'sharp' ? `rgba(40,200,120,${alpha})` :
      flashKind === 'snap' ? `rgba(220,70,70,${alpha})` :
      `rgba(180,180,180,${alpha * 0.6})`;
    ctx.fillRect(0, 0, W, H);
  }

  ctx.fillStyle = getCss('--text-dim', '#9aa');
  ctx.font = '11px ui-sans-serif, system-ui';
  ctx.textAlign = 'left';
  ctx.fillText('Basılı tut → bırak', 14, H - 12);
  ctx.textAlign = 'right';
  ctx.fillText(`Tur ${rounds}`, W - 14, H - 12);
}

function drawBench(): void {
  ctx.fillStyle = '#1d2128';
  ctx.fillRect(0, 215, canvas.width, 4);
  ctx.fillStyle = '#10131a';
  ctx.fillRect(0, 219, canvas.width, 6);
}

function drawPencil(): void {
  const cx = 232;
  const baseY = 195;
  const len = 130 * pencilLen;
  const tipX = cx - 8;

  ctx.save();
  ctx.translate(tipX, baseY);

  ctx.fillStyle = '#f2c879';
  ctx.fillRect(-len, -16, len - 18, 32);

  for (let i = 0; i < 6; i++) {
    ctx.fillStyle = i % 2 === 0 ? 'rgba(0,0,0,0.10)' : 'rgba(255,255,255,0.06)';
    ctx.fillRect(-len + 14 + i * 16, -16, 6, 32);
  }

  ctx.fillStyle = '#c9963f';
  ctx.fillRect(-len, -16, 8, 32);
  ctx.fillStyle = '#a87a2d';
  ctx.fillRect(-len, 12, 8, 4);

  ctx.beginPath();
  ctx.moveTo(-18, -16);
  ctx.lineTo(0, 0);
  ctx.lineTo(-18, 16);
  ctx.closePath();
  ctx.fillStyle = '#e8c597';
  ctx.fill();

  const tipLen = holding ? 14 : 8;
  ctx.beginPath();
  ctx.moveTo(0 - tipLen, -3);
  ctx.lineTo(0, 0);
  ctx.lineTo(0 - tipLen, 3);
  ctx.closePath();
  ctx.fillStyle = '#222';
  ctx.fill();

  ctx.restore();
}

function drawSharpener(): void {
  const x = 232;
  const y = 178;
  ctx.fillStyle = '#5a8acc';
  ctx.fillRect(x - 8, y - 28, 70, 56);
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.fillRect(x - 8, y - 28, 70, 6);
  ctx.fillStyle = '#3f6aa6';
  ctx.fillRect(x - 8, y + 22, 70, 6);

  ctx.fillStyle = '#1b1d22';
  ctx.beginPath();
  ctx.ellipse(x, y, 8, 12, 0, 0, Math.PI * 2);
  ctx.fill();
}

function drawHandle(): void {
  const x = 232 + 62;
  const y = 178;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(handleAngle);
  ctx.strokeStyle = '#3a3f48';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(28, 0);
  ctx.stroke();
  ctx.fillStyle = '#d8dde6';
  ctx.beginPath();
  ctx.arc(28, 0, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = '#21252d';
  ctx.beginPath();
  ctx.arc(x, y, 5, 0, Math.PI * 2);
  ctx.fill();
}

function drawParticles(): void {
  for (const p of particles) {
    const a = 1 - p.life / p.max;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    ctx.globalAlpha = Math.max(0, a);
    ctx.fillStyle = p.color;
    ctx.fillRect(-6, -1.5, 12, 3);
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}

function drawBar(): void {
  const W = canvas.width;
  const x = 32;
  const y = 282;
  const w = W - 64;
  const h = 26;

  ctx.fillStyle = '#0b0d11';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = '#2a2f38';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);

  const c = bandCenter();
  const bw = bandWidth();
  const bx = x + (c - bw / 2) * w;
  const bxW = bw * w;
  ctx.fillStyle = 'rgba(40,200,120,0.30)';
  ctx.fillRect(bx, y + 2, bxW, h - 4);
  ctx.strokeStyle = 'rgba(40,200,120,0.85)';
  ctx.beginPath();
  ctx.moveTo(bx, y);
  ctx.lineTo(bx, y + h);
  ctx.moveTo(bx + bxW, y);
  ctx.lineTo(bx + bxW, y + h);
  ctx.stroke();

  const dangerStart = x + (c + bw / 2) * w;
  ctx.fillStyle = 'rgba(220,70,70,0.18)';
  ctx.fillRect(dangerStart, y + 2, x + w - dangerStart - 1, h - 4);

  const fillX = x + 2;
  const fillW = Math.max(0, progress * w - 4);
  let fillColor = '#cfd3da';
  if (progress > c + bw / 2) fillColor = '#dc4646';
  else if (progress >= c - bw / 2) fillColor = '#28c878';
  ctx.fillStyle = fillColor;
  ctx.fillRect(fillX, y + 4, fillW, h - 8);

  ctx.fillStyle = getCss('--text-dim', '#9aa');
  ctx.font = '10px ui-sans-serif, system-ui';
  ctx.textAlign = 'center';
  ctx.fillText('YONTMA ÇUBUĞU', x + w / 2, y - 6);
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  timeEl = document.querySelector<HTMLElement>('#time')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;

  best = safeRead<number>(STORAGE_BEST, 0);
  bestEl.textContent = String(best);

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) return;
    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      startPress();
    } else if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      reset();
    } else if (e.key === 'Enter' && (state === 'ready' || state === 'gameover')) {
      e.preventDefault();
      if (state === 'gameover') reset();
      startPress();
    }
  };
  const onKeyUp = (e: KeyboardEvent): void => {
    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      release();
    }
  };
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  const onPointerDown = (e: PointerEvent): void => {
    if (state === 'gameover') {
      reset();
      return;
    }
    e.preventDefault();
    canvas.setPointerCapture?.(e.pointerId);
    startPress();
  };
  const onPointerUp = (e: PointerEvent): void => {
    e.preventDefault();
    release();
  };
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('pointerleave', () => {
    if (holding) release();
  });

  overlay.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (state === 'gameover') {
      reset();
      return;
    }
    startPress();
  });
  overlay.addEventListener('pointerup', (e) => {
    e.preventDefault();
    release();
  });

  restartBtn.addEventListener('click', reset);

  reset();
  startLoop();
  draw();
}

export const game = defineGame({ init, reset });
