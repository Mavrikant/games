import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay, hideOverlay } from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';

const STORAGE_BEST = 'inis.best';

type State = 'ready' | 'playing' | 'gameover';

const W = 480;
const H = 600;
const GROUND_Y = 540;
const LANDER_W = 14;
const LANDER_H = 18;

const GRAVITY = 0.035;
const THRUST = 0.10;
const FUEL_BURN = 0.55;
const MAX_FUEL = 100;
const LAND_VY_MAX = 1.6;
const LAND_VX_MAX = 0.8;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let vyEl!: HTMLElement;
let vxEl!: HTMLElement;
let windEl!: HTMLElement;
let fuelBar!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlayEl!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;

let state: State = 'ready';
let score = 0;
let best = 0;

let x = 0;
let y = 0;
let vx = 0;
let vy = 0;
let fuel = 0;
let thrustOn = false;
let wind = 0;
let padW = 0;
let padY_cached = 0;
let padStartIdx = 0;
let padEndIdx = 0;
let terrain: number[] = [];
let stars: { x: number; y: number; r: number }[] = [];
let rafId = 0;
let lastT = 0;
const gen = createGenToken();

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function buildTerrain(): void {
  const cols = 32;
  const step = W / cols;
  terrain = new Array(cols + 1);
  let h = rand(20, 60);
  for (let i = 0; i <= cols; i++) {
    h += rand(-12, 12);
    if (h < 10) h = 10;
    if (h > 90) h = 90;
    terrain[i] = GROUND_Y + 30 - h;
  }
  padW = rand(60, 90);
  const padStart = rand(50, W - padW - 50);
  const startCol = Math.max(0, Math.floor(padStart / step));
  const endCol = Math.min(cols, Math.ceil((padStart + padW) / step));
  const padY = GROUND_Y - rand(0, 30);
  for (let i = startCol; i <= endCol; i++) {
    terrain[i] = padY;
  }
  padY_cached = padY;
  padStartIdx = startCol;
  padEndIdx = endCol;
}

function terrainAt(px: number): number {
  const cols = 32;
  const step = W / cols;
  const idx = px / step;
  const i = Math.floor(idx);
  if (i < 0) return terrain[0]!;
  if (i >= cols) return terrain[cols]!;
  const t = idx - i;
  const a = terrain[i]!;
  const b = terrain[i + 1]!;
  return a + (b - a) * t;
}

function buildStars(): void {
  stars = [];
  for (let i = 0; i < 60; i++) {
    stars.push({ x: rand(0, W), y: rand(0, GROUND_Y - 60), r: rand(0.4, 1.4) });
  }
}

function startRound(resetScore: boolean): void {
  if (resetScore) score = 0;
  buildTerrain();
  x = rand(W * 0.35, W * 0.65);
  y = 60;
  vx = 0;
  vy = 0;
  fuel = MAX_FUEL;
  thrustOn = false;
  // wind direction & magnitude; gentle range so a careful player can fight it
  const mag = rand(0.006, 0.014);
  const sign = Math.random() < 0.5 ? -1 : 1;
  wind = mag * sign;
  state = 'playing';
  hideOverlay(overlayEl);
}

function commitBest(): void {
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
  bestEl.textContent = String(best);
}

function gameOver(crashed: boolean, reason: string): void {
  state = 'gameover';
  commitBest();
  thrustOn = false;
  overlayTitle.textContent = crashed ? 'Crash!' : 'Bitti';
  overlayMsg.innerHTML = `${reason}<br />Skor: <strong>${score}</strong><br />Tekrar için <strong>R</strong> veya 'Yeniden başla'`;
  showOverlay(overlayEl);
}

function chainSuccess(): void {
  score += 1;
  scoreEl.textContent = String(score);
  commitBest();
  // brief pause then new round
  state = 'ready';
  overlayTitle.textContent = 'Yumuşak iniş!';
  overlayMsg.innerHTML = `Skor: <strong>${score}</strong><br />Yeni tur 1.2 sn içinde…`;
  showOverlay(overlayEl);
  const myGen = gen.current();
  setTimeout(() => {
    if (!gen.isCurrent(myGen)) return;
    if (state !== 'ready') return;
    startRound(false);
  }, 1200);
}

function setReadyOverlay(): void {
  overlayTitle.textContent = 'İniş';
  overlayMsg.innerHTML = 'Tek motor, tek tuş.<br /><strong>Boşluk</strong> basılı tut: motor<br />Yumuşak in — yakıtı dikkatli kullan.';
  showOverlay(overlayEl);
}

function reset(): void {
  gen.bump();
  state = 'ready';
  score = 0;
  scoreEl.textContent = '0';
  thrustOn = false;
  setReadyOverlay();
  // pre-build a terrain so the canvas isn't empty before first input
  buildTerrain();
  buildStars();
  x = W / 2;
  y = 60;
  vx = 0;
  vy = 0;
  fuel = MAX_FUEL;
  wind = 0;
  updateHud();
}

function updateHud(): void {
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
  vyEl.textContent = vy.toFixed(2);
  vxEl.textContent = vx.toFixed(2);
  if (Math.abs(vy) > LAND_VY_MAX) vyEl.classList.add('warn');
  else vyEl.classList.remove('warn');
  if (Math.abs(vx) > LAND_VX_MAX) vxEl.classList.add('warn');
  else vxEl.classList.remove('warn');
  const arrow = wind > 0 ? '→' : '←';
  const magBars = Math.min(3, Math.ceil(Math.abs(wind) * 100));
  windEl.textContent = arrow + ' ' + '▮'.repeat(magBars);
  const pct = Math.max(0, fuel) / MAX_FUEL;
  fuelBar.style.transform = `scaleX(${pct})`;
}

function tick(dt: number): void {
  if (state !== 'playing') return;
  // physics — dt is in "frames" (60fps reference) so each constant tunes naturally
  const haveFuel = fuel > 0;
  const burning = thrustOn && haveFuel;

  vy += GRAVITY * dt;
  if (burning) {
    vy -= THRUST * dt;
    fuel -= FUEL_BURN * dt;
    if (fuel < 0) fuel = 0;
  }

  // wind: full strength when engine off, halved when engine on (motor stabilizes)
  const windFactor = burning ? 0.5 : 1.0;
  vx += wind * windFactor * dt;

  // mild lateral drag so vx doesn't run away forever
  vx *= Math.pow(0.985, dt);

  x += vx * dt;
  y += vy * dt;

  // out-of-bounds (side or top exit)
  if (x < -LANDER_W || x > W + LANDER_W) {
    gameOver(true, 'Yörüngeden çıktın');
    return;
  }
  if (y < -40) {
    gameOver(true, 'Uzaya kaçtın');
    return;
  }

  // ground collision check — sample terrain under lander footprint
  const left = x - LANDER_W / 2;
  const right = x + LANDER_W / 2;
  const footY = y + LANDER_H / 2;
  const tl = terrainAt(left);
  const tr = terrainAt(right);
  const tm = terrainAt(x);
  const minGroundY = Math.min(tl, tr, tm);
  if (footY >= minGroundY) {
    // We touched ground. Determine if pad.
    const cols = 32;
    const step = W / cols;
    const padXStart = padStartIdx * step;
    const padXEnd = padEndIdx * step;
    const onPad = left >= padXStart && right <= padXEnd;
    const softVy = Math.abs(vy) <= LAND_VY_MAX;
    const softVx = Math.abs(vx) <= LAND_VX_MAX;
    if (onPad && softVy && softVx) {
      // snap to pad
      y = padY_cached - LANDER_H / 2;
      vy = 0;
      vx = 0;
      chainSuccess();
      return;
    }
    let reason: string;
    if (!onPad) reason = 'Pist dışına indin';
    else if (!softVy) reason = `Sert iniş: |Vy|=${Math.abs(vy).toFixed(2)}`;
    else reason = `Yan kayma: |Vx|=${Math.abs(vx).toFixed(2)}`;
    gameOver(true, reason);
    return;
  }
}

function drawLander(): void {
  ctx.save();
  ctx.translate(x, y);

  // flame (when thrusting & fuel)
  if (thrustOn && fuel > 0) {
    const len = 6 + Math.random() * 8;
    ctx.beginPath();
    ctx.moveTo(-3, LANDER_H / 2);
    ctx.lineTo(0, LANDER_H / 2 + len);
    ctx.lineTo(3, LANDER_H / 2);
    ctx.closePath();
    ctx.fillStyle = '#ff8a3c';
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-1.5, LANDER_H / 2);
    ctx.lineTo(0, LANDER_H / 2 + len * 0.6);
    ctx.lineTo(1.5, LANDER_H / 2);
    ctx.closePath();
    ctx.fillStyle = '#ffe46a';
    ctx.fill();
  }

  // body
  ctx.fillStyle = '#e7eaf6';
  ctx.fillRect(-LANDER_W / 2, -LANDER_H / 2, LANDER_W, LANDER_H);
  // nose
  ctx.beginPath();
  ctx.moveTo(-LANDER_W / 2, -LANDER_H / 2);
  ctx.lineTo(0, -LANDER_H / 2 - 6);
  ctx.lineTo(LANDER_W / 2, -LANDER_H / 2);
  ctx.closePath();
  ctx.fillStyle = '#c1c8de';
  ctx.fill();
  // window
  ctx.fillStyle = '#5cd2ff';
  ctx.fillRect(-3, -LANDER_H / 2 + 3, 6, 4);
  // legs
  ctx.strokeStyle = '#9aa4c2';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(-LANDER_W / 2, LANDER_H / 2);
  ctx.lineTo(-LANDER_W / 2 - 3, LANDER_H / 2 + 4);
  ctx.moveTo(LANDER_W / 2, LANDER_H / 2);
  ctx.lineTo(LANDER_W / 2 + 3, LANDER_H / 2 + 4);
  ctx.stroke();

  ctx.restore();
}

function drawTerrain(): void {
  const cols = terrain.length - 1;
  const step = W / cols;
  ctx.beginPath();
  ctx.moveTo(0, H);
  ctx.lineTo(0, terrain[0]!);
  for (let i = 1; i <= cols; i++) {
    ctx.lineTo(i * step, terrain[i]!);
  }
  ctx.lineTo(W, H);
  ctx.closePath();
  ctx.fillStyle = '#1c2236';
  ctx.fill();
  // outline
  ctx.beginPath();
  ctx.moveTo(0, terrain[0]!);
  for (let i = 1; i <= cols; i++) {
    ctx.lineTo(i * step, terrain[i]!);
  }
  ctx.strokeStyle = '#43507a';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // pad highlight
  const padXStart = padStartIdx * step;
  const padXEnd = padEndIdx * step;
  ctx.strokeStyle = '#1bd97a';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(padXStart, padY_cached);
  ctx.lineTo(padXEnd, padY_cached);
  ctx.stroke();
  // small flagpoles at pad edges
  ctx.fillStyle = '#1bd97a';
  ctx.fillRect(padXStart - 1, padY_cached - 8, 2, 8);
  ctx.fillRect(padXEnd - 1, padY_cached - 8, 2, 8);
}

function drawStars(): void {
  for (const s of stars) {
    ctx.fillStyle = `rgba(255,255,255,${0.3 + s.r * 0.4})`;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawWindIndicator(): void {
  // small arrow at top center
  const cx = W / 2;
  const cy = 18;
  const mag = Math.min(40, Math.abs(wind) * 1200);
  const dir = wind > 0 ? 1 : -1;
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx - mag * dir, cy);
  ctx.lineTo(cx + mag * dir, cy);
  ctx.stroke();
  // arrowhead
  ctx.beginPath();
  ctx.moveTo(cx + mag * dir, cy);
  ctx.lineTo(cx + mag * dir - 5 * dir, cy - 3);
  ctx.lineTo(cx + mag * dir - 5 * dir, cy + 3);
  ctx.closePath();
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.fill();
}

function render(): void {
  ctx.clearRect(0, 0, W, H);
  drawStars();
  drawWindIndicator();
  drawTerrain();
  drawLander();
}

function frame(now: number): void {
  rafId = requestAnimationFrame(frame);
  if (!lastT) lastT = now;
  const ms = now - lastT;
  lastT = now;
  // dt in "60fps frames" — clamp to avoid huge step after tab-blur
  const dt = Math.min(2.5, ms / 16.6667);
  tick(dt);
  updateHud();
  render();
}

function tryStart(): void {
  if (state === 'ready') {
    startRound(true);
  } else if (state === 'gameover') {
    reset();
    startRound(true);
  }
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.repeat) return;
  if (e.code === 'Space') {
    e.preventDefault();
    if (state === 'ready' || state === 'gameover') {
      tryStart();
    }
    thrustOn = true;
  } else if (e.code === 'KeyR') {
    e.preventDefault();
    reset();
  }
}

function onKeyUp(e: KeyboardEvent): void {
  if (e.code === 'Space') {
    e.preventDefault();
    thrustOn = false;
  }
}

function onPointerDown(e: PointerEvent): void {
  e.preventDefault();
  if (state === 'ready' || state === 'gameover') {
    tryStart();
  }
  thrustOn = true;
  canvas.setPointerCapture(e.pointerId);
}

function onPointerUp(e: PointerEvent): void {
  thrustOn = false;
  if (canvas.hasPointerCapture(e.pointerId)) {
    canvas.releasePointerCapture(e.pointerId);
  }
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  vyEl = document.querySelector<HTMLElement>('#vy')!;
  vxEl = document.querySelector<HTMLElement>('#vx')!;
  windEl = document.querySelector<HTMLElement>('#wind')!;
  fuelBar = document.querySelector<HTMLElement>('#fuel-bar')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlayEl = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  restartBtn.addEventListener('click', () => {
    reset();
  });
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  overlayEl.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (state === 'ready' || state === 'gameover') {
      tryStart();
      thrustOn = true;
    }
  });
  overlayEl.addEventListener('pointerup', () => {
    thrustOn = false;
  });

  reset();
  rafId = requestAnimationFrame(frame);
}

function destroy(): void {
  cancelAnimationFrame(rafId);
  window.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('keyup', onKeyUp);
}

export const game = defineGame({ init, reset, destroy });
