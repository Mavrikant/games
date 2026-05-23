import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import {
  showOverlay as showOverlayEl,
  hideOverlay as hideOverlayEl,
} from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';

// PITFALLS guarded here (docs/PITFALLS.md):
// - unguarded-storage: safeRead/safeWrite only.
// - stale-async-callback: gen.bump() in reset() kills the in-flight RAF loop.
// - overlay-input-leak: explicit `state` enum; every handler guards on it.
// - module-level-dom-access: all DOM/listeners live in init().
// - visual-vs-hitbox: BUOY_PASS_R / BUOY_R / FINISH_Y are the single source
//   for both draw() and the rounding check.

type State = 'ready' | 'playing' | 'won';

const STORAGE_BEST = 'yelken.best';

const W = 480;
const H = 600;
const MARGIN = 22;

// Wind blows downward (toward +y); upwind = straight up (-y). heading = 0 is
// dead upwind, clockwise positive. Within NO_GO of dead upwind the sail luffs
// and the boat makes no headway — you must tack across it.
const NO_GO = (40 * Math.PI) / 180;
const SPEED_MAX = 165; // px/s on a beam reach
const TURN_RATE = 2.7; // rad/s while a steer key is held
const DRIFT = 8; // constant downwind leeway, px/s
const LUFF_DRIFT = 24; // extra downwind push while in irons, px/s
const START_HEADING = NO_GO + 0.18; // close-hauled, just out of the no-go zone

const BUOY_R = 9;
const BUOY_PASS_R = 30;
const FINISH_Y = H * 0.08;
const BUOY_COUNT = 3;

interface Buoy {
  x: number;
  y: number;
}

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let timeEl!: HTMLElement;
let bestEl!: HTMLElement;
let buoysEl!: HTMLElement;
let overlayEl!: HTMLElement;
let overlayTitleEl!: HTMLElement;
let overlayMsgEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;

const gen = createGenToken();

let state: State = 'ready';
let boatX = W / 2;
let boatY = H - 48;
let heading = START_HEADING;
let elapsed = 0; // seconds
let best: number | null = null;
let lastTime = 0;
let rafHandle = 0;
let luffing = false;

let buoys: Buoy[] = [];
let nextIndex = 0; // buoy to round next; === BUOY_COUNT → head for finish line
let wake: Array<[number, number]> = [];

const keys = { left: false, right: false };
let pointerLeft = false;
let pointerRight = false;

function showOverlay(title: string, msg: string): void {
  overlayTitleEl.textContent = title;
  overlayMsgEl.textContent = msg;
  showOverlayEl(overlayEl);
}

function hideOverlay(): void {
  hideOverlayEl(overlayEl);
}

function fmt(sec: number): string {
  return sec.toFixed(1);
}

function normalizeAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

// Angle between the boat heading and dead-upwind, 0..PI.
function angleToWind(): number {
  return Math.abs(normalizeAngle(heading));
}

// Fraction of max boat speed for the current point of sail.
function sailResponse(theta: number): number {
  if (theta < NO_GO) return 0;
  return Math.max(0.45, Math.sin(theta));
}

function buildCourse(): void {
  buoys = [];
  const ys = [H * 0.64, H * 0.42, H * 0.22];
  for (let i = 0; i < BUOY_COUNT; i++) {
    const side = i % 2 === 0 ? -1 : 1; // left, right, left → forces tacking
    const offset = 60 + Math.random() * 70;
    const x = Math.max(
      MARGIN + 30,
      Math.min(W - MARGIN - 30, W / 2 + side * offset),
    );
    buoys.push({ x, y: ys[i]! });
  }
}

function setBuoysHud(): void {
  buoysEl.textContent = `${Math.min(nextIndex, BUOY_COUNT)}/${BUOY_COUNT}`;
}

function step(now: number): void {
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;

  if (keys.left || pointerLeft) heading -= TURN_RATE * dt;
  if (keys.right || pointerRight) heading += TURN_RATE * dt;
  heading = normalizeAngle(heading);

  const theta = angleToWind();
  const resp = sailResponse(theta);
  luffing = resp === 0;

  const fwdX = Math.sin(heading);
  const fwdY = -Math.cos(heading);
  const speed = SPEED_MAX * resp;

  boatX += fwdX * speed * dt;
  boatY += fwdY * speed * dt;
  // Leeway: always drift a little downwind; drift hard while luffing.
  boatY += (DRIFT + (luffing ? LUFF_DRIFT : 0)) * dt;

  boatX = Math.max(MARGIN, Math.min(W - MARGIN, boatX));
  boatY = Math.max(MARGIN, Math.min(H - MARGIN, boatY));

  wake.push([boatX, boatY]);
  if (wake.length > 60) wake.shift();

  elapsed += dt;
  timeEl.textContent = fmt(elapsed);

  // Rounding / finish detection.
  if (nextIndex < BUOY_COUNT) {
    const b = buoys[nextIndex]!;
    const dx = boatX - b.x;
    const dy = boatY - b.y;
    if (dx * dx + dy * dy <= BUOY_PASS_R * BUOY_PASS_R) {
      nextIndex++;
      setBuoysHud();
    }
  } else if (boatY <= FINISH_Y) {
    win();
    return;
  }

  draw();
}

function win(): void {
  state = 'won';
  cancelLoop();
  const finalTime = elapsed;
  let line: string;
  if (best === null || finalTime < best) {
    best = finalTime;
    safeWrite(STORAGE_BEST, best);
    bestEl.textContent = fmt(best);
    line = `Yeni rekor: ${fmt(finalTime)} sn!`;
  } else {
    line = `Süre: ${fmt(finalTime)} sn · Rekor: ${fmt(best)} sn`;
  }
  draw();
  showOverlay(
    'Limana vardın!',
    `${line}\nTekrar için R, Boşluk ya da bir yön tuşu.`,
  );
}

function cancelLoop(): void {
  if (rafHandle !== 0) {
    cancelAnimationFrame(rafHandle);
    rafHandle = 0;
  }
}

function startLoop(): void {
  lastTime = performance.now();
  const myGen = gen.current();
  const loop = (now: number): void => {
    if (!gen.isCurrent(myGen)) return;
    if (state !== 'playing') return;
    step(now);
    if (state === 'playing') rafHandle = requestAnimationFrame(loop);
  };
  rafHandle = requestAnimationFrame(loop);
}

function start(): void {
  if (state !== 'ready') return;
  state = 'playing';
  hideOverlay();
  startLoop();
}

function reset(): void {
  gen.bump();
  cancelLoop();
  state = 'ready';
  boatX = W / 2;
  boatY = H - 48;
  heading = START_HEADING;
  elapsed = 0;
  nextIndex = 0;
  luffing = false;
  wake = [];
  keys.left = false;
  keys.right = false;
  pointerLeft = false;
  pointerRight = false;
  buildCourse();
  timeEl.textContent = '0.0';
  bestEl.textContent = best === null ? '—' : fmt(best);
  setBuoysHud();
  draw();
  showOverlay(
    'Yelken',
    "Rüzgâr yukarıdan eser; doğrudan ona karşı gidemezsin. ← / → ile dümeni kır, orsa çekerek şamandıraları dön. Başlamak için Boşluk'a bas.",
  );
}

function draw(): void {
  const sea = ctx.createLinearGradient(0, 0, 0, H);
  sea.addColorStop(0, '#0b3a5e');
  sea.addColorStop(0.5, '#0e5a86');
  sea.addColorStop(1, '#10739c');
  ctx.fillStyle = sea;
  ctx.fillRect(0, 0, W, H);

  drawWindStreaks();
  drawFinish();
  drawBuoys();
  drawWake();
  drawBoat();
  drawCompass();
}

function drawWindStreaks(): void {
  const t = performance.now() * 0.04;
  ctx.strokeStyle = 'rgba(200, 225, 245, 0.18)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 22; i++) {
    const x = (i * 53) % W;
    const y = ((i * 137 + t * 6) % (H + 40)) - 20;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, y + 16);
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(220, 235, 250, 0.7)';
  ctx.font = '12px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('rüzgâr ↓', 10, 18);
}

function drawFinish(): void {
  const active = nextIndex >= BUOY_COUNT;
  const sq = 12;
  for (let x = 0; x < W; x += sq) {
    const dark = Math.floor(x / sq) % 2 === 0;
    ctx.fillStyle = active
      ? dark
        ? '#f5f5f5'
        : '#1c1c1c'
      : dark
        ? 'rgba(245,245,245,0.35)'
        : 'rgba(28,28,28,0.35)';
    ctx.fillRect(x, FINISH_Y - sq / 2, sq, sq);
  }
  if (active) {
    ctx.fillStyle = '#ffe08a';
    ctx.font = 'bold 13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('BİTİŞ', W / 2, FINISH_Y - 10);
  }
}

function drawBuoys(): void {
  for (let i = 0; i < buoys.length; i++) {
    const b = buoys[i]!;
    const rounded = i < nextIndex;
    const isNext = i === nextIndex;

    if (isNext) {
      const pulse = 1 + Math.sin(performance.now() * 0.006) * 0.18;
      ctx.strokeStyle = 'rgba(255, 224, 138, 0.85)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(b.x, b.y, BUOY_PASS_R * pulse, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.fillStyle = rounded ? '#3ddc97' : isNext ? '#ff7043' : '#ff9d6e';
    ctx.beginPath();
    ctx.arc(b.x, b.y, BUOY_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.fillStyle = '#fff';
    ctx.font = 'bold 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(i + 1), b.x, b.y);
    ctx.textBaseline = 'alphabetic';
  }
}

function drawWake(): void {
  if (wake.length < 2) return;
  ctx.lineWidth = 2;
  for (let i = 1; i < wake.length; i++) {
    const a = wake[i - 1]!;
    const c = wake[i]!;
    ctx.strokeStyle = `rgba(255,255,255,${(i / wake.length) * 0.4})`;
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(c[0], c[1]);
    ctx.stroke();
  }
}

function drawBoat(): void {
  ctx.save();
  ctx.translate(boatX, boatY);
  ctx.rotate(heading);

  // Hull (bow points toward heading = -y).
  ctx.fillStyle = '#f4e7c9';
  ctx.strokeStyle = '#5a3d22';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, -18);
  ctx.quadraticCurveTo(9, 0, 6, 12);
  ctx.lineTo(-6, 12);
  ctx.quadraticCurveTo(-9, 0, 0, -18);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Mast.
  ctx.strokeStyle = '#5a3d22';
  ctx.beginPath();
  ctx.moveTo(0, -2);
  ctx.lineTo(0, -10);
  ctx.stroke();

  // Sail: billows when drawing, flaps when luffing.
  const flap = luffing ? Math.sin(performance.now() * 0.03) * 4 : 0;
  const bulge = luffing ? flap : 7;
  ctx.fillStyle = luffing ? 'rgba(255,255,255,0.6)' : '#ffffff';
  ctx.beginPath();
  ctx.moveTo(0, -16);
  ctx.quadraticCurveTo(bulge, -6, 0, 2);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(90,61,34,0.6)';
  ctx.stroke();

  ctx.restore();

  if (luffing && state === 'playing') {
    ctx.fillStyle = '#ffd166';
    ctx.font = 'bold 13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('ORSA! rüzgâra çok yakınsın', W / 2, H - 14);
  }
}

// Point-of-sail mini compass, bottom-left.
function drawCompass(): void {
  const cx = 32;
  const cy = H - 36;
  const r = 20;
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();

  // No-go wedge around dead upwind (up = -y).
  ctx.fillStyle = 'rgba(255,80,80,0.35)';
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.arc(cx, cy, r, -Math.PI / 2 - NO_GO, -Math.PI / 2 + NO_GO);
  ctx.closePath();
  ctx.fill();

  // Boat heading needle.
  ctx.strokeStyle = luffing ? '#ff5050' : '#3ddc97';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.sin(heading) * r, cy - Math.cos(heading) * r);
  ctx.stroke();
}

function onDirDown(): void {
  if (state === 'ready') {
    start();
  } else if (state === 'won') {
    reset();
    start();
  }
}

function onKey(e: KeyboardEvent, down: boolean): void {
  const k = e.key.toLowerCase();
  let handled = true;
  if (k === 'arrowleft' || k === 'a') {
    keys.left = down;
    if (down) onDirDown();
  } else if (k === 'arrowright' || k === 'd') {
    keys.right = down;
    if (down) onDirDown();
  } else if (k === 'r' && down) {
    reset();
  } else if ((k === ' ' || k === 'enter') && down) {
    if (state === 'ready') start();
    else if (state === 'won') {
      reset();
      start();
    }
  } else {
    handled = false;
  }
  if (handled) e.preventDefault();
}

function setupTouchButtons(): void {
  document.querySelectorAll<HTMLButtonElement>('.touch__btn').forEach((btn) => {
    const isLeft = btn.dataset['dir'] === 'left';
    const setHeld = (held: boolean): void => {
      if (isLeft) pointerLeft = held;
      else pointerRight = held;
    };
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      setHeld(true);
      onDirDown();
    });
    btn.addEventListener('pointerup', () => setHeld(false));
    btn.addEventListener('pointercancel', () => setHeld(false));
    btn.addEventListener('pointerleave', () => setHeld(false));
  });
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  timeEl = document.querySelector<HTMLElement>('#time')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  buoysEl = document.querySelector<HTMLElement>('#buoys')!;
  overlayEl = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitleEl = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsgEl = document.querySelector<HTMLElement>('#overlay-msg')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;

  const stored = safeRead<number | null>(STORAGE_BEST, null);
  best = typeof stored === 'number' ? stored : null;

  window.addEventListener('keydown', (e) => onKey(e, true));
  window.addEventListener('keyup', (e) => onKey(e, false));
  setupTouchButtons();
  restartBtn.addEventListener('click', reset);

  reset();
}

export const game = defineGame({ init, reset });
