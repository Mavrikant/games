import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';

const STORAGE_BEST = 'kavusum.best';
const TAU = Math.PI * 2;

type State = 'ready' | 'playing' | 'judged' | 'gameover';

type Planet = {
  radius: number;
  omega: number;
  theta0: number;
  color: string;
};

const PLANET_COLORS = ['--accent', '--text', '--food'];
const RADII = [80, 130, 180];

const gen = createGenToken();

let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let roundEl!: HTMLElement;
let livesEl!: HTMLElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;

let state: State = 'ready';
let score = 0;
let best = 0;
let lives = 3;
let roundNo = 1;
let streak = 0;

let planets: Planet[] = [];
let targetAngle = 0;
let alignTime = 0;
let roundStart = 0;
let roundElapsed = 0;
let judgedAt = 0;

let resultText = '';
let resultColor = '--text';

function setOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlay);
}

function hideOverlay(): void {
  hideOverlayEl(overlay);
}

const cssCache = new Map<string, string>();
function getCss(varName: string): string {
  const cached = cssCache.get(varName);
  if (cached !== undefined) return cached;
  const val = getComputedStyle(document.documentElement)
    .getPropertyValue(varName)
    .trim() || '#ffffff';
  cssCache.set(varName, val);
  return val;
}

function rand(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

function randomSign(): number {
  return Math.random() < 0.5 ? -1 : 1;
}

function setupRound(): void {
  targetAngle = rand(0, TAU);
  alignTime = rand(4.5, 9.5);

  const speeds = [
    rand(0.55, 0.95) * randomSign(),
    rand(0.35, 0.7) * randomSign(),
    rand(0.22, 0.5) * randomSign(),
  ];

  planets = speeds.map((omega, i) => {
    const theta0 = ((targetAngle - omega * alignTime) % TAU + TAU) % TAU;
    return {
      radius: RADII[i]!,
      omega,
      theta0,
      color: PLANET_COLORS[i]!,
    };
  });

  roundStart = performance.now();
  roundElapsed = 0;
  state = 'playing';
  hideOverlay();
  updateHud();
}

function planetAngleAt(p: Planet, t: number): number {
  return ((p.theta0 + p.omega * t) % TAU + TAU) % TAU;
}

function angularDelta(a: number, b: number): number {
  const d = Math.abs(((a - b) % TAU + TAU) % TAU);
  return Math.min(d, TAU - d);
}

function totalErrorAt(t: number): number {
  let sum = 0;
  for (const p of planets) sum += angularDelta(planetAngleAt(p, t), targetAngle);
  return sum;
}

function judge(): void {
  if (state !== 'playing') return;
  state = 'judged';

  const t = roundElapsed;
  judgedAt = t;
  const errRad = totalErrorAt(t);
  const errDeg = (errRad * 180) / Math.PI;

  let gained = 0;
  if (errDeg <= 6) {
    gained = 25;
    streak += 1;
    if (streak >= 3) {
      gained += 20;
      streak = 0;
      resultText = `Tam isabet! +25 · Seri bonus +20`;
    } else {
      resultText = `Tam isabet! +25`;
    }
    resultColor = '--accent';
  } else if (errDeg <= 14) {
    gained = 12;
    streak = 0;
    resultText = `İyi! +12 (hata ${errDeg.toFixed(1)}°)`;
    resultColor = '--accent';
  } else if (errDeg <= 26) {
    gained = 5;
    streak = 0;
    resultText = `Yakın. +5 (hata ${errDeg.toFixed(1)}°)`;
    resultColor = '--text';
  } else {
    streak = 0;
    lives -= 1;
    resultText = `Iskaladın (hata ${errDeg.toFixed(1)}°). Can −1`;
    resultColor = '--food';
  }

  score += gained;
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
  updateHud();

  if (lives <= 0) {
    scheduleGameOver();
  } else {
    scheduleNext();
  }
}

function scheduleNext(): void {
  const myGen = gen.current();
  window.setTimeout(() => {
    if (!gen.isCurrent(myGen)) return;
    if (state !== 'judged') return;
    roundNo += 1;
    setupRound();
  }, 1400);
}

function scheduleGameOver(): void {
  const myGen = gen.current();
  window.setTimeout(() => {
    if (!gen.isCurrent(myGen)) return;
    if (state !== 'judged') return;
    state = 'gameover';
    setOverlay('Bitti!', `Skor: ${score} · Rekor: ${best}\nYeniden başlamak için R veya butona bas.`);
  }, 1400);
}

function timeoutMiss(): void {
  if (state !== 'playing') return;
  state = 'judged';
  judgedAt = roundElapsed;
  streak = 0;
  lives -= 1;
  resultText = 'Süre doldu. Can −1';
  resultColor = '--food';
  updateHud();
  if (lives <= 0) scheduleGameOver();
  else scheduleNext();
}

function updateHud(): void {
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
  roundEl.textContent = String(roundNo);
  livesEl.textContent = lives > 0 ? '●'.repeat(lives) + '○'.repeat(3 - lives) : '○○○';
}

function draw(): void {
  const w = canvas.width;
  const h = canvas.height;
  const cx = w / 2;
  const cy = h / 2;

  ctx.fillStyle = getCss('--surface');
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = getCss('--grid');
  ctx.lineWidth = 1;
  for (const r of RADII) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TAU);
    ctx.stroke();
  }

  const rayLen = 210;
  const tx = cx + Math.cos(targetAngle) * rayLen;
  const ty = cy + Math.sin(targetAngle) * rayLen;
  ctx.strokeStyle = getCss('--text');
  ctx.lineWidth = 3;
  ctx.globalAlpha = 0.92;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(tx, ty);
  ctx.stroke();
  ctx.globalAlpha = 1;

  ctx.fillStyle = getCss('--text');
  ctx.beginPath();
  ctx.arc(tx, ty, 5, 0, TAU);
  ctx.fill();

  ctx.fillStyle = '#facc15';
  ctx.beginPath();
  ctx.arc(cx, cy, 18, 0, TAU);
  ctx.fill();
  ctx.fillStyle = 'rgba(250, 204, 21, 0.25)';
  ctx.beginPath();
  ctx.arc(cx, cy, 26, 0, TAU);
  ctx.fill();

  const t = state === 'judged' ? judgedAt : roundElapsed;
  for (const p of planets) {
    const theta = planetAngleAt(p, t);
    const px = cx + Math.cos(theta) * p.radius;
    const py = cy + Math.sin(theta) * p.radius;
    ctx.fillStyle = getCss(p.color);
    ctx.beginPath();
    ctx.arc(px, py, 9, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  const maxErr = TAU * 1.5;
  const err = totalErrorAt(t);
  const errFrac = Math.min(1, err / maxErr);
  const gaugeW = 320;
  const gaugeH = 8;
  const gx = (w - gaugeW) / 2;
  const gy = h - 28;
  ctx.fillStyle = getCss('--border');
  ctx.fillRect(gx, gy, gaugeW, gaugeH);
  ctx.fillStyle = err < 0.35 ? '#22c55e' : err < 0.9 ? '#facc15' : getCss('--food');
  ctx.fillRect(gx, gy, gaugeW * (1 - errFrac), gaugeH);
  ctx.strokeStyle = getCss('--border');
  ctx.strokeRect(gx, gy, gaugeW, gaugeH);

  if (state === 'playing') {
    const remaining = Math.max(0, 12 - roundElapsed);
    ctx.fillStyle = getCss('--text');
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`${remaining.toFixed(1)} sn`, 12, 20);
  } else if (state === 'judged') {
    ctx.fillStyle = getCss(resultColor);
    ctx.font = 'bold 22px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(resultText, cx, 28);
  }
}

function loop(): void {
  if (state === 'playing') {
    roundElapsed = (performance.now() - roundStart) / 1000;
    if (roundElapsed > 12) {
      timeoutMiss();
    }
  }
  draw();
  window.requestAnimationFrame(loop);
}

function startNewGame(): void {
  gen.bump();
  score = 0;
  lives = 3;
  roundNo = 1;
  streak = 0;
  resultText = '';
  state = 'playing';
  setupRound();
}

function reset(): void {
  gen.bump();
  score = 0;
  lives = 3;
  roundNo = 1;
  streak = 0;
  state = 'ready';
  planets = [];
  targetAngle = 0;
  alignTime = 6;
  roundElapsed = 0;
  resultText = '';
  updateHud();
  setOverlay('Kavuşum', 'Üç gezegen ışına dizilecek.\nTam o anda Boşluk veya tıkla.\nBaşlamak için tıkla / Enter.');
}

function handleInputTap(): void {
  if (state === 'ready' || state === 'gameover') {
    startNewGame();
    return;
  }
  if (state === 'playing') {
    judge();
  }
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  roundEl = document.querySelector<HTMLElement>('#round')!;
  livesEl = document.querySelector<HTMLElement>('#lives')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k === ' ' || k === 'enter') {
      handleInputTap();
      e.preventDefault();
    } else if (k === 'r') {
      reset();
      e.preventDefault();
    }
  });

  canvas.addEventListener('pointerdown', (e) => {
    handleInputTap();
    e.preventDefault();
  });

  overlay.addEventListener('pointerdown', (e) => {
    handleInputTap();
    e.preventDefault();
  });

  restartBtn.addEventListener('click', reset);

  reset();
  window.requestAnimationFrame(loop);
}

export const game = defineGame({ init, reset });
