import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import {
  showOverlay as showOverlayEl,
  hideOverlay as hideOverlayEl,
} from '@shared/overlay';

// PITFALLS guarded here (see docs/PITFALLS.md):
// - unguarded-storage: storage goes through safeRead/safeWrite.
// - overlay-input-leak: every input handler tops out with a state guard,
//   and the overlay element itself eats pointerdown so the canvas listener
//   doesn't race the same input.
// - invisible-boot: first whip immediately moves the visible top (rpm bump
//   + tilt halve are written into the same animation frame).
// - module-level side effects: all DOM access lives in init().

const STORAGE_BEST = 'topac.best';

type State = 'ready' | 'playing' | 'gameover';
type GustEdge = 'top' | 'right' | 'bottom' | 'left';

interface Gust {
  edge: GustEdge;
  // Strength in tilt-units per second while active.
  push: number;
  // Remaining lifetime in seconds.
  remaining: number;
}

const W = 480;
const H = 480;
const CX = W / 2;
const CY = H / 2;

const MAX_RPM = 100;
const MIN_RPM = 0;
const RPM_DECAY_PER_SEC = 4; // 25 seconds of free fall with no whips.
const RPM_BUMP = 22;
const WHIP_COOLDOWN_MS = 380;
const TILT_DECAY_PER_SEC = 0.18; // tilt drifts back when not gusting.
const GUST_MIN_GAP_S = 4;
const GUST_MAX_GAP_S = 8;
const GUST_DURATION_S = 1.3;
const GUST_PUSH_MIN = 0.5;
const GUST_PUSH_MAX = 0.8;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let timeEl!: HTMLElement;
let bestEl!: HTMLElement;
let rpmEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayStartBtn!: HTMLButtonElement;

let state: State = 'ready';
let best = 0;
let elapsedMs = 0;
let rpm = 0;
// tilt is a vector — direction the top is leaning (units of "amount" 0..1).
let tiltX = 0;
let tiltY = 0;
// Visual spin angle (radians), advanced by rpm.
let spinAngle = 0;
// Cooldown timer in ms; whip is allowed at 0.
let whipCooldownMs = 0;
// Gust scheduling: time until next gust starts, in seconds.
let nextGustIn = 0;
let gust: Gust | null = null;
// Visual whip flash (counts down in ms).
let whipFlashMs = 0;

let rafId = 0;
let lastFrameMs = 0;

const cssCache = new Map<string, string>();
function getCss(name: string, fallback: string): string {
  const cached = cssCache.get(name);
  if (cached !== undefined) return cached || fallback;
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  cssCache.set(name, v);
  return v || fallback;
}

function tiltMagnitude(): number {
  return Math.hypot(tiltX, tiltY);
}

function setTime(ms: number): void {
  elapsedMs = ms;
  timeEl.textContent = String(Math.floor(ms / 1000));
}

function setBest(v: number): void {
  best = v;
  bestEl.textContent = String(best);
}

function setRpm(v: number): void {
  rpm = Math.max(MIN_RPM, Math.min(MAX_RPM, v));
  rpmEl.textContent = String(Math.round(rpm));
}

function scheduleNextGust(): void {
  nextGustIn =
    GUST_MIN_GAP_S + Math.random() * (GUST_MAX_GAP_S - GUST_MIN_GAP_S);
}

function startGust(): void {
  const edges: GustEdge[] = ['top', 'right', 'bottom', 'left'];
  const edge = edges[Math.floor(Math.random() * edges.length)]!;
  const push = GUST_PUSH_MIN + Math.random() * (GUST_PUSH_MAX - GUST_PUSH_MIN);
  gust = { edge, push, remaining: GUST_DURATION_S };
}

function gustVector(edge: GustEdge): { x: number; y: number } {
  // Wind blows AWAY from the edge it comes from, so the top leans toward
  // the opposite side. e.g. wind from 'left' pushes tilt vector to the right.
  switch (edge) {
    case 'top':
      return { x: 0, y: 1 };
    case 'right':
      return { x: -1, y: 0 };
    case 'bottom':
      return { x: 0, y: -1 };
    case 'left':
      return { x: 1, y: 0 };
  }
}

function whip(): void {
  if (state === 'ready') {
    startPlaying();
    return;
  }
  if (state === 'gameover') {
    reset();
    startPlaying();
    return;
  }
  if (whipCooldownMs > 0) return;

  setRpm(rpm + RPM_BUMP);
  // Whip also damps tilt — bringing the top back toward upright.
  tiltX *= 0.5;
  tiltY *= 0.5;
  whipCooldownMs = WHIP_COOLDOWN_MS;
  whipFlashMs = 200;
}

function endGame(reason: 'stopped' | 'toppled'): void {
  state = 'gameover';
  const seconds = Math.floor(elapsedMs / 1000);
  if (seconds > best) {
    setBest(seconds);
    safeWrite(STORAGE_BEST, seconds);
  }
  const title = reason === 'stopped' ? 'Topaç durdu' : 'Topaç devrildi';
  const msg =
    `Süre: ${seconds} sn · Rekor: ${best} sn\n` +
    `Tekrar oynamak için Boşluk'a bas veya alana tıkla.`;
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  overlayStartBtn.textContent = 'Tekrar oyna';
  showOverlayEl(overlay);
}

function step(dtMs: number): void {
  if (state !== 'playing') return;
  const dt = dtMs / 1000;

  setTime(elapsedMs + dtMs);

  // Spin decays from friction.
  setRpm(rpm - RPM_DECAY_PER_SEC * dt);

  // Advance visual spin (full revs per second = rpm / 60, but exaggerate
  // for visibility since this is a slow per-second display).
  spinAngle += (rpm / 60) * dt * Math.PI * 2 * 3;
  if (spinAngle > Math.PI * 2) spinAngle -= Math.PI * 2;

  // Tilt update: gust pushes outward, otherwise tilt decays back to 0.
  if (gust !== null) {
    const v = gustVector(gust.edge);
    tiltX += v.x * gust.push * dt;
    tiltY += v.y * gust.push * dt;
    gust.remaining -= dt;
    if (gust.remaining <= 0) {
      gust = null;
      scheduleNextGust();
    }
  } else {
    const mag = tiltMagnitude();
    if (mag > 0) {
      const decay = TILT_DECAY_PER_SEC * dt;
      if (mag <= decay) {
        tiltX = 0;
        tiltY = 0;
      } else {
        const k = (mag - decay) / mag;
        tiltX *= k;
        tiltY *= k;
      }
    }
    nextGustIn -= dt;
    if (nextGustIn <= 0) startGust();
  }

  // Clamp tilt magnitude — if it goes past 1, the top topples.
  const tiltMag = tiltMagnitude();
  if (tiltMag >= 1) {
    endGame('toppled');
    return;
  }

  if (rpm <= MIN_RPM) {
    endGame('stopped');
    return;
  }

  if (whipCooldownMs > 0) {
    whipCooldownMs = Math.max(0, whipCooldownMs - dtMs);
  }
  if (whipFlashMs > 0) {
    whipFlashMs = Math.max(0, whipFlashMs - dtMs);
  }
}

function drawFloor(): void {
  // Wooden parquet floor with simple radial gradient + plank lines.
  ctx.save();
  const bg = ctx.createRadialGradient(CX, CY, 40, CX, CY, 320);
  bg.addColorStop(0, '#1c2231');
  bg.addColorStop(1, '#0a0d14');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // Floor disc — the spinning "table".
  const tableR = 200;
  const disc = ctx.createRadialGradient(CX - 30, CY - 50, 20, CX, CY, tableR);
  disc.addColorStop(0, '#3a2d20');
  disc.addColorStop(0.6, '#231a12');
  disc.addColorStop(1, '#15100a');
  ctx.beginPath();
  ctx.arc(CX, CY, tableR, 0, Math.PI * 2);
  ctx.fillStyle = disc;
  ctx.fill();

  // Plank rings.
  ctx.strokeStyle = 'rgba(78, 50, 28, 0.55)';
  ctx.lineWidth = 1;
  for (let r = 40; r < tableR; r += 36) {
    ctx.beginPath();
    ctx.arc(CX, CY, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(40, 28, 18, 0.85)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(CX, CY, tableR, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawTop(): void {
  const accent = getCss('--tp-accent', '#f59e0b');
  const woodLight = '#caa164';
  const woodDark = '#6e4b22';
  const tip = '#e7eef9';

  const tiltMag = tiltMagnitude();
  // Convert tilt vector into pixel offset and pitch angle.
  const offsetPx = tiltMag * 70; // up to 70 px lean.
  const dirX = tiltMag > 0 ? tiltX / tiltMag : 0;
  const dirY = tiltMag > 0 ? tiltY / tiltMag : 0;

  const baseX = CX + dirX * offsetPx;
  const baseY = CY + dirY * offsetPx;

  // The top sits on its tip; the body leans away from "up" toward the
  // tilt direction. Pitch angle for visual rotation.
  const pitch = Math.atan2(dirX, -dirY) || 0;
  const lean = tiltMag * 0.6; // up to ~0.6 rad tilt (≈34°).

  ctx.save();
  ctx.translate(baseX, baseY);
  ctx.rotate(pitch);
  ctx.rotate(lean);

  // Tip (the contact point).
  ctx.beginPath();
  ctx.moveTo(-3, 0);
  ctx.lineTo(3, 0);
  ctx.lineTo(0, 14);
  ctx.closePath();
  ctx.fillStyle = '#1a1a1a';
  ctx.fill();

  // Body — wide top (cone+disc combined), narrowing upward.
  const bodyW = 64;
  const bodyTop = -78;
  const bodyMid = -10;
  const shoulder = -36;

  const grad = ctx.createLinearGradient(-bodyW / 2, 0, bodyW / 2, 0);
  grad.addColorStop(0, woodDark);
  grad.addColorStop(0.5, woodLight);
  grad.addColorStop(1, woodDark);

  ctx.beginPath();
  ctx.moveTo(0, 0); // tip
  ctx.lineTo(bodyW / 2, bodyMid);
  ctx.lineTo(bodyW / 2 - 8, shoulder);
  ctx.lineTo(8, bodyTop);
  ctx.lineTo(-8, bodyTop);
  ctx.lineTo(-bodyW / 2 + 8, shoulder);
  ctx.lineTo(-bodyW / 2, bodyMid);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.strokeStyle = '#3a2614';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Painted band that visualizes spin — rotate within local frame.
  ctx.save();
  ctx.translate(0, bodyMid - 10);
  ctx.rotate(spinAngle);
  ctx.beginPath();
  ctx.ellipse(0, 0, bodyW / 2 - 4, 6, 0, 0, Math.PI * 2);
  ctx.fillStyle = '#1f2733';
  ctx.fill();
  // Two contrasting marks so the eye sees spin.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    ctx.beginPath();
    ctx.ellipse(
      Math.cos(a) * (bodyW / 2 - 8),
      Math.sin(a) * 4,
      4,
      2.5,
      0,
      0,
      Math.PI * 2,
    );
    ctx.fillStyle = i % 2 === 0 ? accent : tip;
    ctx.fill();
  }
  ctx.restore();

  // Top knob.
  ctx.beginPath();
  ctx.moveTo(-8, bodyTop);
  ctx.lineTo(8, bodyTop);
  ctx.lineTo(6, bodyTop - 8);
  ctx.lineTo(-6, bodyTop - 8);
  ctx.closePath();
  ctx.fillStyle = woodDark;
  ctx.fill();
  ctx.strokeStyle = '#3a2614';
  ctx.lineWidth = 1.2;
  ctx.stroke();

  ctx.restore();

  // Subtle shadow on the floor under the tip.
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(baseX, baseY + 4, 28, 6, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fill();
  ctx.restore();
}

function drawGust(): void {
  if (gust === null) return;
  const fade = Math.min(1, gust.remaining / GUST_DURATION_S);
  const alpha = 0.45 + 0.35 * fade;
  ctx.save();
  ctx.strokeStyle = `rgba(248, 113, 113, ${alpha})`;
  ctx.fillStyle = `rgba(248, 113, 113, ${alpha})`;
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';

  const draw = (x: number, y: number, dx: number, dy: number): void => {
    const len = 60;
    const tipX = x + dx * len;
    const tipY = y + dy * len;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(tipX, tipY);
    ctx.stroke();
    // Arrowhead.
    const ang = Math.atan2(dy, dx);
    const head = 12;
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(
      tipX - Math.cos(ang - 0.45) * head,
      tipY - Math.sin(ang - 0.45) * head,
    );
    ctx.lineTo(
      tipX - Math.cos(ang + 0.45) * head,
      tipY - Math.sin(ang + 0.45) * head,
    );
    ctx.closePath();
    ctx.fill();
  };

  switch (gust.edge) {
    case 'top':
      draw(CX, 20, 0, 1);
      break;
    case 'right':
      draw(W - 20, CY, -1, 0);
      break;
    case 'bottom':
      draw(CX, H - 20, 0, -1);
      break;
    case 'left':
      draw(20, CY, 1, 0);
      break;
  }
  ctx.restore();
}

function drawGauges(): void {
  // RPM bar — right side.
  const barX = W - 26;
  const barY = 40;
  const barH = H - 80;
  const barW = 14;

  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  ctx.fillRect(barX, barY, barW, barH);
  const rpmFrac = rpm / MAX_RPM;
  const fillH = barH * rpmFrac;
  const rpmGrad = ctx.createLinearGradient(0, barY + barH, 0, barY);
  rpmGrad.addColorStop(0, '#f87171');
  rpmGrad.addColorStop(0.5, '#fbbf24');
  rpmGrad.addColorStop(1, '#34d399');
  ctx.fillStyle = rpmGrad;
  ctx.fillRect(barX, barY + barH - fillH, barW, fillH);
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 1;
  ctx.strokeRect(barX, barY, barW, barH);
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.font = '600 10px Inter, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('RPM', barX + barW / 2, barY - 8);

  // Tilt bar — bottom-right horizontal.
  const tBarX = 60;
  const tBarY = H - 22;
  const tBarW = 220;
  const tBarH = 10;
  const tMag = tiltMagnitude();
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  ctx.fillRect(tBarX, tBarY, tBarW, tBarH);
  ctx.fillStyle =
    tMag < 0.5
      ? '#34d399'
      : tMag < 0.8
        ? '#fbbf24'
        : '#f87171';
  ctx.fillRect(tBarX, tBarY, tBarW * Math.min(1, tMag), tBarH);
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 1;
  ctx.strokeRect(tBarX, tBarY, tBarW, tBarH);
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.font = '600 10px Inter, system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('YATIK', tBarX, tBarY - 4);

  // Cooldown ring near top-left when active.
  if (whipCooldownMs > 0) {
    const frac = whipCooldownMs / WHIP_COOLDOWN_MS;
    ctx.beginPath();
    ctx.arc(28, 28, 12, -Math.PI / 2, -Math.PI / 2 + (1 - frac) * Math.PI * 2);
    ctx.strokeStyle = 'rgba(94, 234, 212, 0.85)';
    ctx.lineWidth = 3;
    ctx.stroke();
  } else {
    ctx.fillStyle = 'rgba(94, 234, 212, 0.85)';
    ctx.font = '600 11px Inter, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('hazır', 14, 32);
  }
  ctx.restore();
}

function drawWhipFlash(): void {
  if (whipFlashMs <= 0) return;
  const a = whipFlashMs / 200;
  ctx.save();
  ctx.strokeStyle = `rgba(94, 234, 212, ${a * 0.8})`;
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(CX, CY, 80, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function draw(): void {
  drawFloor();
  drawWhipFlash();
  drawGust();
  drawTop();
  drawGauges();
}

function tick(now: number): void {
  const dtMs = lastFrameMs === 0 ? 16 : Math.min(50, now - lastFrameMs);
  lastFrameMs = now;
  step(dtMs);
  draw();
  rafId = requestAnimationFrame(tick);
}

function startPlaying(): void {
  state = 'playing';
  hideOverlayEl(overlay);
  elapsedMs = 0;
  setTime(0);
  setRpm(MAX_RPM);
  tiltX = 0;
  tiltY = 0;
  whipCooldownMs = 0;
  whipFlashMs = 0;
  gust = null;
  scheduleNextGust();
}

function reset(): void {
  state = 'ready';
  elapsedMs = 0;
  setTime(0);
  setRpm(MAX_RPM);
  tiltX = 0;
  tiltY = 0;
  spinAngle = 0;
  whipCooldownMs = 0;
  whipFlashMs = 0;
  gust = null;
  scheduleNextGust();
  overlayTitle.textContent = 'Topaç';
  overlayMsg.textContent =
    'Topaç yavaşladıkça yatar; rüzgâr esintisi de eğer. Kırbaçla hem hızı topla hem dengeyi düzelt. Başlamak için Boşluk\'a bas ya da alana tıkla.';
  overlayStartBtn.textContent = 'Başla';
  showOverlayEl(overlay);
  draw();
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  timeEl = document.querySelector<HTMLElement>('#time')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  rpmEl = document.querySelector<HTMLElement>('#rpm')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayStartBtn = document.querySelector<HTMLButtonElement>('#overlay-start')!;

  best = safeRead<number>(STORAGE_BEST, 0);
  setBest(best);

  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    whip();
  });

  // Overlay itself catches the click so we don't double-fire with canvas
  // when the overlay still covers the board.
  overlay.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    whip();
  });
  overlayStartBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    whip();
  });

  restartBtn.addEventListener('click', () => {
    reset();
  });

  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    const k = e.key;
    if (k === ' ' || k === 'Enter') {
      whip();
      e.preventDefault();
      return;
    }
    if (k === 'r' || k === 'R') {
      reset();
      e.preventDefault();
    }
  });

  reset();
  if (rafId !== 0) cancelAnimationFrame(rafId);
  lastFrameMs = 0;
  rafId = requestAnimationFrame(tick);
}

export const game = defineGame({ init, reset });
