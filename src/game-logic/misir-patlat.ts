import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import {
  showOverlay as showOverlayEl,
  hideOverlay as hideOverlayEl,
} from '@shared/overlay';

type State = 'ready' | 'playing' | 'gameover';
type KernelState = 'raw' | 'popped' | 'burned';

interface Kernel {
  x: number;
  y: number;
  vy: number;
  vx: number;
  energy: number;
  damage: number;
  popThreshold: number;
  burnThreshold: number;
  state: KernelState;
  popAge: number;
  hue: number;
}

const STORAGE_KEY = 'misir-patlat.best';
const KERNEL_COUNT = 30;
const ROUND_MS = 45_000;

const HEAT_UP_RATE = 0.06;
const HEAT_DOWN_RATE = 0.07;
const HEAT_MIN = 0;
const HEAT_MAX = 100;
const SWEET_LO = 55;
const SWEET_HI = 80;
const BURN_LO = 80;

const POT_X = 110;
const POT_Y = 220;
const POT_W = 280;
const POT_H = 180;
const POT_RIM_H = 12;
const KERNEL_R = 7;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let burnedEl!: HTMLElement;
let timeEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;

let state: State = 'ready';
let kernels: Kernel[] = [];
let heat = 0;
let heating = false;
let popped = 0;
let burned = 0;
let best = 0;
let timeLeft = ROUND_MS;
let lastFrame = 0;
let rafHandle: number | null = null;
let flameWobble = 0;

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function setOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlay);
}

function hideMessage(): void {
  hideOverlayEl(overlay);
}

function makeKernel(): Kernel {
  const innerLeft = POT_X + 22;
  const innerRight = POT_X + POT_W - 22;
  const innerTop = POT_Y + 70;
  const innerBottom = POT_Y + POT_H - 18;
  return {
    x: rand(innerLeft, innerRight),
    y: rand(innerTop, innerBottom),
    vx: 0,
    vy: 0,
    energy: 0,
    damage: 0,
    popThreshold: rand(0.6, 1.1),
    burnThreshold: rand(0.9, 1.3),
    state: 'raw',
    popAge: 0,
    hue: rand(38, 52),
  };
}

function resetKernels(): void {
  kernels = [];
  for (let i = 0; i < KERNEL_COUNT; i++) kernels.push(makeKernel());
}

function reset(): void {
  if (rafHandle !== null) {
    cancelAnimationFrame(rafHandle);
    rafHandle = null;
  }
  state = 'ready';
  heat = 0;
  heating = false;
  popped = 0;
  burned = 0;
  timeLeft = ROUND_MS;
  resetKernels();
  scoreEl.textContent = '0';
  burnedEl.textContent = '0';
  timeEl.textContent = '45';
  bestEl.textContent = String(best);
  setOverlay(
    'Mısır Patlat',
    'Basılı tut: ateş yükselir. Bırak: söner.\n70-80\'de patlar, 85+\'da yanar.\nBaşlamak için tıkla veya Space.',
  );
  draw();
}

function startGame(): void {
  if (state !== 'ready') return;
  state = 'playing';
  hideMessage();
  lastFrame = performance.now();
  if (rafHandle === null) rafHandle = requestAnimationFrame(loop);
}

function endGame(timeOut: boolean): void {
  state = 'gameover';
  heating = false;
  if (rafHandle !== null) {
    cancelAnimationFrame(rafHandle);
    rafHandle = null;
  }
  const net = popped - burned;
  if (net > best) {
    best = net;
    bestEl.textContent = String(best);
    safeWrite(STORAGE_KEY, best);
  }
  const reasonLine = timeOut
    ? 'Süre doldu.'
    : 'Bütün mısırlar ocaktan kalktı.';
  setOverlay(
    'Bitti',
    `${reasonLine}\nPatlayan: ${popped} · Yanan: ${burned}\nNet skor: ${net}\nR ile yeniden başla.`,
  );
}

function loop(now: number): void {
  rafHandle = requestAnimationFrame(loop);
  const dt = Math.min(40, now - lastFrame);
  lastFrame = now;
  update(dt);
  draw();
}

function update(dt: number): void {
  if (state !== 'playing') return;

  if (heating) heat = Math.min(HEAT_MAX, heat + HEAT_UP_RATE * dt);
  else heat = Math.max(HEAT_MIN, heat - HEAT_DOWN_RATE * dt);

  timeLeft -= dt;
  if (timeLeft <= 0) {
    timeLeft = 0;
    timeEl.textContent = '0';
    endGame(true);
    return;
  }
  timeEl.textContent = String(Math.ceil(timeLeft / 1000));

  let rawLeft = 0;
  for (const k of kernels) {
    if (k.state === 'raw') {
      rawLeft++;
      if (heat > SWEET_LO) {
        // Past 85 the kernel structure starts breaking down — cooking
        // efficiency plateaus while damage keeps climbing. This is what
        // makes "high heat finishes the round faster" trade off against
        // "high heat burns".
        const effective = Math.min(heat, 85);
        k.energy += (effective - SWEET_LO) * 0.00007 * dt;
      }
      if (heat > BURN_LO) {
        k.damage += (heat - BURN_LO) * 0.00025 * dt;
      }
      if (k.damage >= k.burnThreshold) {
        k.state = 'burned';
        burned++;
        burnedEl.textContent = String(burned);
      } else if (k.energy >= k.popThreshold) {
        k.state = 'popped';
        k.popAge = 0;
        k.vy = -rand(0.35, 0.65);
        k.vx = rand(-0.18, 0.18);
        popped++;
        scoreEl.textContent = String(popped);
      }
    } else if (k.state === 'popped') {
      k.popAge += dt;
      k.vy += 0.0014 * dt;
      k.x += k.vx * dt;
      k.y += k.vy * dt;
      const innerBottom = POT_Y + POT_H - 18;
      if (k.y > innerBottom) {
        k.y = innerBottom;
        k.vy = 0;
        k.vx *= 0.6;
      }
    }
  }
  if (rawLeft === 0) {
    endGame(false);
    return;
  }

  flameWobble += dt * 0.012;
}

function draw(): void {
  ctx.fillStyle = '#0a0b0e';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  drawHeatBar();
  drawTimeBar();
  drawFlame();
  drawPot();
  drawKernels();
  drawSteam();
}

function drawHeatBar(): void {
  const x = 24;
  const y = 60;
  const w = 22;
  const h = 360;
  ctx.fillStyle = '#1c2027';
  ctx.fillRect(x - 4, y - 4, w + 8, h + 8);
  ctx.fillStyle = '#0e1014';
  ctx.fillRect(x, y, w, h);

  const sweetTop = y + h - (SWEET_HI / HEAT_MAX) * h;
  const sweetBottom = y + h - (SWEET_LO / HEAT_MAX) * h;
  ctx.fillStyle = 'rgba(52,211,153,0.25)';
  ctx.fillRect(x, sweetTop, w, sweetBottom - sweetTop);

  const dangerBottom = y + h - (85 / HEAT_MAX) * h;
  ctx.fillStyle = 'rgba(248,113,113,0.22)';
  ctx.fillRect(x, y, w, dangerBottom - y);

  const fillH = (heat / HEAT_MAX) * h;
  const hue = 200 - (heat / HEAT_MAX) * 200;
  ctx.fillStyle = `hsl(${hue}, 90%, 55%)`;
  ctx.fillRect(x, y + h - fillH, w, fillH);

  ctx.fillStyle = '#5a6473';
  ctx.font = '10px Inter, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText('ISI', x + w, y - 10);
  ctx.textAlign = 'left';
  ctx.fillText(Math.round(heat).toString(), x + w + 6, y + h - fillH + 4);
}

function drawTimeBar(): void {
  const x = 80;
  const y = 28;
  const w = 360;
  const h = 14;
  ctx.fillStyle = '#1c2027';
  ctx.fillRect(x - 2, y - 2, w + 4, h + 4);
  ctx.fillStyle = '#0e1014';
  ctx.fillRect(x, y, w, h);
  const ratio = Math.max(0, timeLeft / ROUND_MS);
  ctx.fillStyle = ratio > 0.33 ? '#818cf8' : '#f87171';
  ctx.fillRect(x, y, w * ratio, h);
}

function drawPot(): void {
  const grad = ctx.createLinearGradient(POT_X, POT_Y, POT_X, POT_Y + POT_H);
  grad.addColorStop(0, '#2a2f38');
  grad.addColorStop(1, '#0e1216');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(POT_X, POT_Y);
  ctx.lineTo(POT_X + POT_W, POT_Y);
  ctx.lineTo(POT_X + POT_W - 14, POT_Y + POT_H);
  ctx.quadraticCurveTo(
    POT_X + POT_W / 2,
    POT_Y + POT_H + 12,
    POT_X + 14,
    POT_Y + POT_H,
  );
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = '#3a4150';
  ctx.fillRect(POT_X - 6, POT_Y - 4, POT_W + 12, POT_RIM_H);
  ctx.fillStyle = '#1c2027';
  ctx.fillRect(POT_X - 6, POT_Y + POT_RIM_H - 4, POT_W + 12, 4);

  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.beginPath();
  ctx.moveTo(POT_X + 8, POT_Y + POT_RIM_H);
  ctx.lineTo(POT_X + POT_W - 8, POT_Y + POT_RIM_H);
  ctx.lineTo(POT_X + POT_W - 18, POT_Y + POT_H - 6);
  ctx.quadraticCurveTo(
    POT_X + POT_W / 2,
    POT_Y + POT_H + 4,
    POT_X + 18,
    POT_Y + POT_H - 6,
  );
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = '#3a4150';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(POT_X - 4, POT_Y + 36, 18, Math.PI * 0.4, Math.PI * 1.6);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(POT_X + POT_W + 4, POT_Y + 36, 18, -Math.PI * 0.6, Math.PI * 0.6);
  ctx.stroke();
}

function drawFlame(): void {
  if (heat <= 1) return;
  const cx = POT_X + POT_W / 2;
  const baseY = POT_Y + POT_H + 18;
  const intensity = heat / HEAT_MAX;
  const flameH = 18 + intensity * 70;
  const flameW = 60 + intensity * 90;

  const glow = ctx.createRadialGradient(
    cx,
    baseY,
    4,
    cx,
    baseY,
    flameW * 0.9,
  );
  glow.addColorStop(0, `rgba(255, 180, 80, ${0.45 * intensity})`);
  glow.addColorStop(1, 'rgba(255, 120, 40, 0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(cx, baseY, flameW * 0.9, 0, Math.PI * 2);
  ctx.fill();

  const tongues = 5;
  for (let i = 0; i < tongues; i++) {
    const off = (i - (tongues - 1) / 2) * (flameW / tongues);
    const wob = Math.sin(flameWobble * 1.6 + i * 1.7) * 4;
    const h = flameH * (0.6 + Math.random() * 0.5);
    const w = flameW / tongues + 4;
    const hue = 30 + Math.random() * 18;
    ctx.fillStyle = `hsla(${hue}, 95%, 55%, 0.85)`;
    ctx.beginPath();
    ctx.moveTo(cx + off - w / 2, baseY);
    ctx.quadraticCurveTo(cx + off + wob, baseY - h * 0.7, cx + off, baseY - h);
    ctx.quadraticCurveTo(cx + off - wob, baseY - h * 0.7, cx + off + w / 2, baseY);
    ctx.closePath();
    ctx.fill();
  }

  ctx.fillStyle = `rgba(255, 245, 200, ${0.5 * intensity})`;
  ctx.beginPath();
  ctx.ellipse(cx, baseY - 6, flameW * 0.18, flameH * 0.3, 0, 0, Math.PI * 2);
  ctx.fill();
}

function drawKernels(): void {
  for (const k of kernels) {
    if (k.state === 'raw') {
      const sat = 85;
      const light = 55 - Math.min(25, k.energy * 28) - Math.min(20, k.damage * 30);
      const hue = k.hue - Math.min(20, k.energy * 18);
      ctx.fillStyle = `hsl(${hue}, ${sat}%, ${Math.max(20, light)}%)`;
      ctx.beginPath();
      ctx.ellipse(k.x, k.y, KERNEL_R, KERNEL_R * 0.78, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.beginPath();
      ctx.ellipse(k.x - 2, k.y - 2, 1.6, 1.2, 0, 0, Math.PI * 2);
      ctx.fill();
    } else if (k.state === 'popped') {
      drawPuff(k);
    } else {
      ctx.fillStyle = '#2a1a14';
      ctx.beginPath();
      ctx.arc(k.x, k.y, KERNEL_R, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#0a0608';
      ctx.beginPath();
      ctx.arc(k.x + 2, k.y - 1, KERNEL_R * 0.55, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawPuff(k: Kernel): void {
  const grow = Math.min(1, k.popAge / 220);
  const r = KERNEL_R + grow * 9;
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + (k.x % 7);
    const dx = Math.cos(a) * r * 0.55;
    const dy = Math.sin(a) * r * 0.55;
    ctx.fillStyle = i === 0 ? '#fff8e6' : '#fff3d6';
    ctx.beginPath();
    ctx.arc(k.x + dx, k.y + dy, r * 0.62, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = '#fffcec';
  ctx.beginPath();
  ctx.arc(k.x, k.y, r * 0.55, 0, Math.PI * 2);
  ctx.fill();
}

function drawSteam(): void {
  if (heat < SWEET_LO || state !== 'playing') return;
  const intensity = Math.min(1, (heat - SWEET_LO) / 40);
  ctx.fillStyle = `rgba(200, 215, 235, ${0.05 + 0.08 * intensity})`;
  for (let i = 0; i < 4; i++) {
    const t = (flameWobble * 30 + i * 50) % 120;
    const x = POT_X + 60 + i * 50;
    const y = POT_Y - 6 - t;
    const r = 14 + t * 0.18;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function startHeating(e?: Event): void {
  e?.preventDefault();
  if (state === 'ready') startGame();
  if (state === 'playing') heating = true;
}

function stopHeating(e?: Event): void {
  e?.preventDefault();
  heating = false;
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  burnedEl = document.querySelector<HTMLElement>('#burned')!;
  timeEl = document.querySelector<HTMLElement>('#time')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;

  best = safeRead<number>(STORAGE_KEY, 0);

  canvas.addEventListener('pointerdown', startHeating);
  window.addEventListener('pointerup', stopHeating);
  canvas.addEventListener('pointercancel', stopHeating);
  canvas.addEventListener('pointerleave', stopHeating);

  overlay.addEventListener('pointerdown', startHeating);

  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    if (e.code === 'Space') {
      e.preventDefault();
      if (state === 'ready') startGame();
      if (state === 'playing') heating = true;
    } else if (e.key.toLowerCase() === 'r') {
      e.preventDefault();
      reset();
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') {
      e.preventDefault();
      heating = false;
    }
  });

  restartBtn.addEventListener('click', () => reset());

  reset();
}

export const game = defineGame({ init, reset });
