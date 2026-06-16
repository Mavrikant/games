import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay, hideOverlay } from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';

const STORAGE_BEST = 'hizar.best';
const LOGS_PER_RUN = 12;
const MAX_BLADE = 100;
const BLADE_WEAR = 3;
const KNOT_DAMAGE = 22;
const PERFECT_TOL = 2;
const GOOD_TOL = 8;

type State = 'ready' | 'aiming' | 'cutting' | 'gameover';

interface Knot {
  x: number;
  y: number;
  r: number;
}

const gen = createGenToken();

let state: State = 'ready';

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let bladeHudEl!: HTMLElement;
let logNumEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlayEl!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayBtn!: HTMLButtonElement;

let score = 0;
let best = 0;
let blade = MAX_BLADE;
let logIndex = 0;
let bladeAngle = 0;
let grainAngle = 12;
let knots: Knot[] = [];
let combo = 0;
let cutAnimT = 0;
let lastCutScore = 0;
let lastCutKnotHits = 0;
let lastCutDelta = 0;

const W = 480;
const H = 480;
const LOG_W = 380;
const LOG_H = 130;
const LOG_X = (W - LOG_W) / 2;
const LOG_Y = (H - LOG_H) / 2;
const CX = W / 2;
const CY = H / 2;
const BLADE_HALF = 200;

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function makeLog(idx: number): void {
  const range = Math.min(15 + idx * 2, 38);
  grainAngle = rand(-range, range);

  const baseKnots = Math.min(Math.floor(idx / 2), 3);
  const knotCount = baseKnots + (Math.random() < 0.45 ? 1 : 0);
  knots = [];
  let tries = 0;
  while (knots.length < knotCount && tries < 80) {
    tries++;
    const x = LOG_X + 36 + Math.random() * (LOG_W - 72);
    const y = LOG_Y + 24 + Math.random() * (LOG_H - 48);
    const r = 8 + Math.random() * 7;
    let ok = true;
    for (const k of knots) {
      if (Math.hypot(k.x - x, k.y - y) < r + k.r + 10) {
        ok = false;
        break;
      }
    }
    if (ok) knots.push({ x, y, r });
  }
}

function updateHud(): void {
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
  bladeHudEl.textContent = String(Math.max(0, Math.round(blade)));
  const shownIdx = state === 'gameover' || state === 'ready' ? 0 : logIndex;
  logNumEl.textContent = `${Math.min(shownIdx + 1, LOGS_PER_RUN)}/${LOGS_PER_RUN}`;
}

function startRun(): void {
  score = 0;
  blade = MAX_BLADE;
  logIndex = 0;
  combo = 0;
  bladeAngle = 0;
  cutAnimT = 0;
  makeLog(0);
  state = 'aiming';
  hideOverlay(overlayEl);
  updateHud();
  draw();
}

function reset(): void {
  gen.bump();
  state = 'ready';
  score = 0;
  blade = MAX_BLADE;
  logIndex = 0;
  combo = 0;
  bladeAngle = 0;
  cutAnimT = 0;
  lastCutScore = 0;
  lastCutKnotHits = 0;
  lastCutDelta = 0;
  grainAngle = 14;
  knots = [];
  updateHud();
  overlayTitle.textContent = 'Hızar';
  overlayMsg.textContent =
    'Bıçağı kütüğün damar yönüne çevir, kesmek için Boşluk veya tıkla.\n' +
    '← / → veya fare hareketi: bıçak açısı. Budak halkalarını es geç.';
  overlayBtn.textContent = 'Başla';
  showOverlay(overlayEl);
  draw();
}

function countKnotHits(angleDeg: number): number {
  const rad = (angleDeg * Math.PI) / 180;
  const nx = Math.cos(rad);
  const ny = -Math.sin(rad);
  let hits = 0;
  for (const k of knots) {
    const dx = k.x - CX;
    const dy = k.y - CY;
    const dist = Math.abs(dx * nx + dy * ny);
    if (dist < k.r) hits++;
  }
  return hits;
}

function commitCut(): void {
  if (state !== 'aiming') return;
  state = 'cutting';

  const delta = Math.abs(bladeAngle - grainAngle);
  let cutScore: number;
  if (delta <= PERFECT_TOL) {
    cutScore = 100;
  } else if (delta <= GOOD_TOL) {
    cutScore = Math.round(80 - (delta - PERFECT_TOL) * 6);
  } else {
    cutScore = Math.max(0, Math.round(40 - (delta - GOOD_TOL) * 3));
  }

  const knotHits = countKnotHits(bladeAngle);
  cutScore = Math.max(0, cutScore - knotHits * 25);

  let comboBonus = 0;
  if (cutScore >= 80 && knotHits === 0) {
    combo++;
    comboBonus = combo * 5;
  } else {
    combo = 0;
  }
  cutScore += comboBonus;

  blade -= BLADE_WEAR + knotHits * KNOT_DAMAGE;

  score += cutScore;
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }

  lastCutScore = cutScore;
  lastCutKnotHits = knotHits;
  lastCutDelta = delta;

  cutAnimT = 0;
  const token = gen.current();
  const startT = performance.now();
  function step(t: number): void {
    if (!gen.isCurrent(token)) return;
    cutAnimT = Math.min(1, (t - startT) / 600);
    draw();
    drawCutPopup();
    if (cutAnimT < 1) {
      requestAnimationFrame(step);
    } else {
      window.setTimeout(() => {
        if (!gen.isCurrent(token)) return;
        nextLog();
      }, 480);
    }
  }
  requestAnimationFrame(step);
  updateHud();
}

function nextLog(): void {
  logIndex++;
  if (blade <= 0) {
    endRun('Bıçak kırıldı');
    return;
  }
  if (logIndex >= LOGS_PER_RUN) {
    endRun('Tahta yığını tükendi');
    return;
  }
  cutAnimT = 0;
  bladeAngle = 0;
  makeLog(logIndex);
  state = 'aiming';
  updateHud();
  draw();
}

function endRun(reason: string): void {
  state = 'gameover';
  overlayTitle.textContent = 'Vardiya bitti';
  overlayMsg.textContent =
    `${reason}.\nSkor: ${score} · Rekor: ${best}\nR ile yeniden başla.`;
  overlayBtn.textContent = 'Yeniden başla';
  showOverlay(overlayEl);
  draw();
}

const cssCache = new Map<string, string>();
function getCss(varName: string, fallback: string): string {
  const cached = cssCache.get(varName);
  if (cached !== undefined) return cached;
  const val =
    getComputedStyle(document.documentElement)
      .getPropertyValue(varName)
      .trim() || fallback;
  cssCache.set(varName, val);
  return val;
}

function draw(): void {
  ctx.clearRect(0, 0, W, H);

  const bgGrad = ctx.createRadialGradient(CX, CY, 80, CX, CY, 360);
  bgGrad.addColorStop(0, '#231710');
  bgGrad.addColorStop(1, '#0b0805');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, W, H);

  drawSawDust();
  drawLog();

  if (state === 'cutting') {
    drawCutLine();
  } else {
    drawBlade();
  }

  if (combo > 1 && state === 'aiming') {
    ctx.fillStyle = getCss('--accent', '#f9c46a');
    ctx.font = '700 16px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(`Üst üste ×${combo}`, W - 14, H - 14);
    ctx.textAlign = 'left';
  }

  drawBladeMeter();
}

function drawSawDust(): void {
  ctx.fillStyle = 'rgba(80, 60, 30, 0.08)';
  for (let i = 0; i < 40; i++) {
    const x = (i * 73 + 37) % W;
    const y = (i * 113 + 53) % H;
    ctx.fillRect(x, y, 1, 1);
  }
}

function drawLog(): void {
  ctx.save();
  ctx.beginPath();
  const radius = 10;
  ctx.moveTo(LOG_X + radius, LOG_Y);
  ctx.lineTo(LOG_X + LOG_W - radius, LOG_Y);
  ctx.quadraticCurveTo(LOG_X + LOG_W, LOG_Y, LOG_X + LOG_W, LOG_Y + radius);
  ctx.lineTo(LOG_X + LOG_W, LOG_Y + LOG_H - radius);
  ctx.quadraticCurveTo(LOG_X + LOG_W, LOG_Y + LOG_H, LOG_X + LOG_W - radius, LOG_Y + LOG_H);
  ctx.lineTo(LOG_X + radius, LOG_Y + LOG_H);
  ctx.quadraticCurveTo(LOG_X, LOG_Y + LOG_H, LOG_X, LOG_Y + LOG_H - radius);
  ctx.lineTo(LOG_X, LOG_Y + radius);
  ctx.quadraticCurveTo(LOG_X, LOG_Y, LOG_X + radius, LOG_Y);
  ctx.closePath();
  ctx.clip();

  const wood = ctx.createLinearGradient(LOG_X, LOG_Y, LOG_X, LOG_Y + LOG_H);
  wood.addColorStop(0, '#6b4626');
  wood.addColorStop(0.5, '#5a3a1f');
  wood.addColorStop(1, '#4a2f18');
  ctx.fillStyle = wood;
  ctx.fillRect(LOG_X, LOG_Y, LOG_W, LOG_H);

  const rad = (grainAngle * Math.PI) / 180;
  const dx = Math.sin(rad);
  const dy = Math.cos(rad);

  const lineSpacing = 11;
  const linesPerSide = 26;

  for (let i = -linesPerSide; i <= linesPerSide; i++) {
    const offset = i * lineSpacing;
    const px = CX + dy * offset;
    const py = CY - dx * offset;
    const len = LOG_W;
    const x1 = px - dx * len;
    const y1 = py - dy * len;
    const x2 = px + dx * len;
    const y2 = py + dy * len;

    const stripe = Math.abs(i) % 5;
    const color =
      stripe === 0
        ? '#7d5530'
        : stripe === 1
          ? '#6c4724'
          : stripe === 2
            ? '#7a512c'
            : stripe === 3
              ? '#603e1e'
              : '#704a28';
    ctx.strokeStyle = color;
    ctx.lineWidth = stripe === 0 ? 2 : 1;
    ctx.globalAlpha = stripe === 0 ? 0.85 : 0.6;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  for (const k of knots) {
    const grad = ctx.createRadialGradient(k.x - k.r * 0.2, k.y - k.r * 0.2, 1, k.x, k.y, k.r);
    grad.addColorStop(0, '#3a1d09');
    grad.addColorStop(0.6, '#1f0e05');
    grad.addColorStop(1, '#120703');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(k.x, k.y, k.r, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = '#080302';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(k.x, k.y, k.r * 0.55, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(20, 8, 3, 0.55)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(k.x, k.y, k.r * 0.8, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.restore();

  ctx.strokeStyle = '#2c1b0c';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(LOG_X + 0.5, LOG_Y + 0.5, LOG_W - 1, LOG_H - 1, 10);
  ctx.stroke();
}

function drawBlade(): void {
  const rad = (bladeAngle * Math.PI) / 180;
  const dx = Math.sin(rad);
  const dy = -Math.cos(rad);

  const x1 = CX - dx * BLADE_HALF;
  const y1 = CY - dy * BLADE_HALF;
  const x2 = CX + dx * BLADE_HALF;
  const y2 = CY + dy * BLADE_HALF;

  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = 8;
  ctx.shadowOffsetX = 2;
  ctx.shadowOffsetY = 2;

  const grad = ctx.createLinearGradient(x1, y1, x2, y2);
  grad.addColorStop(0, '#8b929b');
  grad.addColorStop(0.5, '#e8ebef');
  grad.addColorStop(1, '#8b929b');
  ctx.strokeStyle = grad;
  ctx.lineWidth = 6;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();

  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;

  const px = -dy;
  const py = dx;
  const toothCount = 30;
  ctx.strokeStyle = '#d0d4da';
  ctx.lineWidth = 1.4;
  for (let i = 0; i <= toothCount; i++) {
    const t = i / toothCount;
    const bx = x1 + (x2 - x1) * t;
    const by = y1 + (y2 - y1) * t;
    const tx = bx + px * 4;
    const ty = by + py * 4;
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(tx, ty);
    ctx.stroke();
  }

  ctx.fillStyle = '#fafcff';
  ctx.beginPath();
  ctx.arc(CX, CY, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#3a3d44';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.fillStyle = getCss('--text-muted', '#aab');
  ctx.font = '600 13px system-ui, sans-serif';
  ctx.textAlign = 'center';
  const sign = bladeAngle >= 0 ? '+' : '';
  ctx.fillText(`${sign}${bladeAngle.toFixed(1)}°`, CX, 26);
  ctx.textAlign = 'left';
}

function drawCutLine(): void {
  const rad = (bladeAngle * Math.PI) / 180;
  const dx = Math.sin(rad);
  const dy = -Math.cos(rad);

  const t = cutAnimT;
  const halfExtent = BLADE_HALF * t;
  const cx1 = CX - dx * halfExtent;
  const cy1 = CY - dy * halfExtent;
  const cx2 = CX + dx * halfExtent;
  const cy2 = CY + dy * halfExtent;

  const isClean = lastCutScore >= 80 && lastCutKnotHits === 0;
  const isPerfect = lastCutDelta <= PERFECT_TOL && lastCutKnotHits === 0;

  ctx.strokeStyle = '#15090a';
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(cx1, cy1);
  ctx.lineTo(cx2, cy2);
  ctx.stroke();

  if (isClean && t > 0.35) {
    ctx.shadowBlur = 16;
    ctx.shadowColor = isPerfect ? '#a2e872' : '#c4d488';
    ctx.strokeStyle = isPerfect ? '#d4ffa8' : '#e8f4be';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx1, cy1);
    ctx.lineTo(cx2, cy2);
    ctx.stroke();
    ctx.shadowBlur = 0;
  } else if (lastCutKnotHits > 0 && t > 0.35) {
    ctx.shadowBlur = 14;
    ctx.shadowColor = '#e34f3a';
    ctx.strokeStyle = '#ff9c8a';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(cx1, cy1);
    ctx.lineTo(cx2, cy2);
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  if (t < 0.96) {
    const off = (1 - t) * 80;
    const ox = -dy * off;
    const oy = dx * off;
    const bx1 = CX - dx * BLADE_HALF + ox;
    const by1 = CY - dy * BLADE_HALF + oy;
    const bx2 = CX + dx * BLADE_HALF + ox;
    const by2 = CY + dy * BLADE_HALF + oy;

    const grad = ctx.createLinearGradient(bx1, by1, bx2, by2);
    grad.addColorStop(0, '#8b929b');
    grad.addColorStop(0.5, '#e8ebef');
    grad.addColorStop(1, '#8b929b');
    ctx.strokeStyle = grad;
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(bx1, by1);
    ctx.lineTo(bx2, by2);
    ctx.stroke();
  }
}

function drawCutPopup(): void {
  if (cutAnimT < 0.45) return;
  const alpha = Math.min(1, (cutAnimT - 0.45) * 3);
  ctx.save();
  ctx.globalAlpha = alpha;

  const isPerfect = lastCutDelta <= PERFECT_TOL && lastCutKnotHits === 0;
  const isClean = lastCutScore >= 80 && lastCutKnotHits === 0;
  const hadKnot = lastCutKnotHits > 0;

  const color = isPerfect ? '#a2e872' : isClean ? '#c8e89c' : hadKnot ? '#ff9c8a' : '#f9c46a';
  ctx.fillStyle = color;
  ctx.font = '700 38px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`+${lastCutScore}`, CX, CY - 56);

  ctx.font = '600 14px system-ui, sans-serif';
  const label = isPerfect
    ? 'KUSURSUZ'
    : isClean
      ? 'TEMİZ'
      : hadKnot
        ? `BUDAK! −${lastCutKnotHits * 25}`
        : `EĞRİ (${lastCutDelta.toFixed(1)}°)`;
  ctx.fillText(label, CX, CY - 32);
  ctx.restore();
}

function drawBladeMeter(): void {
  const barX = 16;
  const barY = H - 24;
  const barW = W - 32;
  const barH = 6;
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.fillRect(barX, barY, barW, barH);
  const pct = clamp(blade / MAX_BLADE, 0, 1);
  const color = pct > 0.5 ? '#7fd4a4' : pct > 0.25 ? '#f9c46a' : '#ff8470';
  ctx.fillStyle = color;
  ctx.fillRect(barX, barY, barW * pct, barH);
}

function setAngleFromPointer(mx: number, my: number): void {
  const dx = mx - CX;
  const dy = CY - my;
  if (Math.hypot(dx, dy) < 10) return;
  let angle = (Math.atan2(dx, Math.max(dy, 0.0001)) * 180) / Math.PI;
  angle = clamp(angle, -50, 50);
  bladeAngle = angle;
}

function pointerPos(e: PointerEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((e.clientX - rect.left) / rect.width) * canvas.width,
    y: ((e.clientY - rect.top) / rect.height) * canvas.height,
  };
}

function onPointerMove(e: PointerEvent): void {
  if (state !== 'aiming') return;
  const { x, y } = pointerPos(e);
  setAngleFromPointer(x, y);
  draw();
}

function onPointerDown(e: PointerEvent): void {
  if (state === 'aiming') {
    const { x, y } = pointerPos(e);
    setAngleFromPointer(x, y);
  }
  e.preventDefault();
}

function onPointerUp(e: PointerEvent): void {
  if (state === 'aiming') {
    commitCut();
    e.preventDefault();
  }
}

function onKey(e: KeyboardEvent): void {
  const k = e.key.toLowerCase();
  if (k === 'r') {
    reset();
    e.preventDefault();
    return;
  }
  if (state === 'ready' || state === 'gameover') {
    if (k === ' ' || k === 'enter') {
      if (state === 'ready') startRun();
      else reset();
      e.preventDefault();
    }
    return;
  }
  if (state !== 'aiming') return;
  if (k === 'arrowleft' || k === 'a') {
    bladeAngle = clamp(bladeAngle - 1.5, -50, 50);
    draw();
    e.preventDefault();
  } else if (k === 'arrowright' || k === 'd') {
    bladeAngle = clamp(bladeAngle + 1.5, -50, 50);
    draw();
    e.preventDefault();
  } else if (k === ' ' || k === 'enter') {
    commitCut();
    e.preventDefault();
  }
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  bladeHudEl = document.querySelector<HTMLElement>('#blade-hud')!;
  logNumEl = document.querySelector<HTMLElement>('#log-num')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlayEl = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointerup', onPointerUp);

  restartBtn.addEventListener('click', reset);
  overlayBtn.addEventListener('click', () => {
    if (state === 'ready') startRun();
    else if (state === 'gameover') reset();
  });

  window.addEventListener('keydown', onKey);

  reset();
}

export const game = defineGame({ init, reset });
