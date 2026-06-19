import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import {
  showOverlay as showOverlayEl,
  hideOverlay as hideOverlayEl,
} from '@shared/overlay';
import { reportGameOver } from '@shared/leaderboard';

const STORAGE_BEST = 'manti.best';
const SCORE_DESC = {
  gameId: 'manti',
  storageKey: STORAGE_BEST,
  direction: 'higher' as const,
};

const W = 480;
const H = 540;

const TRAY_PER_ROUND = 5;

const CORNER_GRAB_R = 28;

const DOUGH_SIZE_BASE = 130;

type State = 'ready' | 'playing' | 'gameover';

interface Corner {
  ox: number;
  oy: number;
  cx: number;
  cy: number;
  sealed: boolean;
  quality: number;
}

interface Manti {
  cx: number;
  cy: number;
  size: number;
  rot: number;
  sealOX: number;
  sealOY: number;
  corners: Corner[];
  finished: boolean;
  finishAnim: number;
  outcomePts: number;
  outcomeLabel: string;
  outcomeColor: string;
}

interface RoundConfig {
  tolerance: number;
  duration: number;
  boatOffset: number;
}

const gen = createGenToken();

let state: State = 'ready';
let score = 0;
let best = 0;
let round = 1;
let trayCount = 0;
let timeLeft = 0;

let manti: Manti | null = null;
let dragIdx = -1;
let dragX = 0;
let dragY = 0;

let liveDist = 0;
let pulse = 0;
let lastTs = 0;
let rafId: number | null = null;

let flash: { text: string; until: number; color: string } | null = null;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let roundEl!: HTMLElement;
let trayEl!: HTMLElement;
let timeEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;

function roundConfig(r: number): RoundConfig {
  const tolerance = Math.max(16, 34 - (r - 1) * 3);
  const duration = Math.max(28, 46 - (r - 1) * 2);
  const boatOffset = r >= 3 ? Math.min(28, 8 + (r - 3) * 4) : 0;
  return { tolerance, duration, boatOffset };
}

function showStartOverlay(): void {
  overlayTitle.textContent = 'Mantı';
  overlayMsg.textContent =
    'Her hamurun dört köşesini, ortasındaki parlak kapanış noktasına sürükle.\nKöşe kapanışa ne kadar yakın bırakılırsa mantı o kadar zarif olur.\nBoşluk ile başla.';
  showOverlayEl(overlay);
}

function showGameOverOverlay(): void {
  overlayTitle.textContent = 'Mola';
  overlayMsg.textContent = `Süre doldu.\nSkor: ${score} · Tur: ${round}\nR veya Boşluk ile yeniden başla`;
  showOverlayEl(overlay);
}

function updateHud(): void {
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
  roundEl.textContent = String(round);
  trayEl.textContent = `${trayCount}/${TRAY_PER_ROUND}`;
  timeEl.textContent = String(Math.ceil(Math.max(0, timeLeft)));
}

function commitBest(): void {
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
}

function spawnManti(): void {
  const cfg = roundConfig(round);
  const size = DOUGH_SIZE_BASE - Math.min(20, (round - 1) * 2);
  const rot = (Math.random() - 0.5) * 0.18;
  const cx = W / 2;
  const cy = 290;

  const boatDir = Math.random() < 0.5 ? -1 : 1;
  const sealOX = 0;
  const sealOY = -cfg.boatOffset * boatDir;

  const corners: Corner[] = [];
  const half = size / 2;
  const local: Array<[number, number]> = [
    [-half, -half],
    [half, -half],
    [half, half],
    [-half, half],
  ];
  for (const p of local) {
    const lx = p[0]!;
    const ly = p[1]!;
    const wx = cx + lx * Math.cos(rot) - ly * Math.sin(rot);
    const wy = cy + lx * Math.sin(rot) + ly * Math.cos(rot);
    corners.push({
      ox: wx,
      oy: wy,
      cx: wx,
      cy: wy,
      sealed: false,
      quality: 0,
    });
  }

  manti = {
    cx,
    cy,
    size,
    rot,
    sealOX,
    sealOY,
    corners,
    finished: false,
    finishAnim: 0,
    outcomePts: 0,
    outcomeLabel: '',
    outcomeColor: '#facc15',
  };
}

function reset(): void {
  gen.bump();
  state = 'ready';
  score = 0;
  round = 1;
  trayCount = 0;
  timeLeft = roundConfig(1).duration;
  dragIdx = -1;
  flash = null;
  manti = null;
  spawnManti();
  updateHud();
  showStartOverlay();
  ensureLoop();
}

function ensureLoop(): void {
  if (rafId !== null) return;
  lastTs = performance.now();
  rafId = window.requestAnimationFrame(loop);
}

function loop(ts: number): void {
  rafId = window.requestAnimationFrame(loop);
  const dt = Math.min(0.033, Math.max(0, (ts - lastTs) / 1000));
  lastTs = ts;
  step(dt);
  draw();
}

function step(dt: number): void {
  pulse += dt * 3;
  if (state === 'playing') {
    timeLeft -= dt;
    if (timeLeft <= 0) {
      timeLeft = 0;
      gameOver();
    }
    updateHud();
    if (manti !== null && manti.finished) {
      manti.finishAnim += dt * 2.4;
      if (manti.finishAnim >= 1) onMantiDone();
    }
  }
  if (flash !== null && performance.now() > flash.until) flash = null;
}

function onMantiDone(): void {
  trayCount++;
  score += manti!.outcomePts;
  commitBest();
  updateHud();
  if (trayCount >= TRAY_PER_ROUND) {
    const timeBonus = Math.round(Math.max(0, timeLeft) * 5);
    if (timeBonus > 0) {
      score += timeBonus;
      flashSet(`Tur bonusu +${timeBonus}`, '#fde68a', 1100);
      commitBest();
    } else {
      flashSet(`Tur ${round} tamam`, '#fde68a', 900);
    }
    round++;
    trayCount = 0;
    timeLeft = roundConfig(round).duration;
  }
  manti = null;
  spawnManti();
  updateHud();
}

function startFromReady(): void {
  if (state !== 'ready') return;
  state = 'playing';
  hideOverlayEl(overlay);
}

function gameOver(): void {
  if (state !== 'playing') return;
  state = 'gameover';
  commitBest();
  reportGameOver(SCORE_DESC, score);
  showGameOverOverlay();
  updateHud();
}

function flashSet(text: string, color: string, ms: number): void {
  flash = { text, color, until: performance.now() + ms };
}

function sealPos(m: Manti): { x: number; y: number } {
  return { x: m.cx + m.sealOX, y: m.cy + m.sealOY };
}

function pickCorner(x: number, y: number): number {
  if (manti === null || manti.finished) return -1;
  let best = -1;
  let bestD = CORNER_GRAB_R;
  for (let i = 0; i < manti.corners.length; i++) {
    const c = manti.corners[i]!;
    if (c.sealed) continue;
    const d = Math.hypot(c.cx - x, c.cy - y);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

function startDrag(x: number, y: number): void {
  if (state !== 'playing' || manti === null) return;
  const idx = pickCorner(x, y);
  if (idx < 0) return;
  dragIdx = idx;
  dragX = x;
  dragY = y;
  const sp = sealPos(manti);
  liveDist = Math.hypot(x - sp.x, y - sp.y);
}

function moveDrag(x: number, y: number): void {
  if (dragIdx < 0 || manti === null) return;
  dragX = x;
  dragY = y;
  const sp = sealPos(manti);
  liveDist = Math.hypot(x - sp.x, y - sp.y);
}

function endDrag(x: number, y: number): void {
  if (dragIdx < 0 || manti === null) return;
  const c = manti.corners[dragIdx]!;
  c.cx = x;
  c.cy = y;
  c.sealed = true;
  const sp = sealPos(manti);
  const d = Math.hypot(x - sp.x, y - sp.y);
  const cfg = roundConfig(round);
  c.quality = Math.max(0, 1 - d / cfg.tolerance);
  dragIdx = -1;

  if (manti.corners.every((cc) => cc.sealed)) finishManti();
}

function finishManti(): void {
  if (manti === null) return;
  const avg =
    manti.corners.reduce((s, c) => s + c.quality, 0) / manti.corners.length;
  let pts: number;
  let label: string;
  let color: string;
  if (avg >= 0.9) {
    pts = 150;
    label = 'Şef mantısı +150';
    color = '#fde047';
  } else if (avg >= 0.7) {
    pts = 100;
    label = 'İyi +100';
    color = '#86efac';
  } else if (avg >= 0.4) {
    pts = 60;
    label = 'Olur +60';
    color = '#fcd34d';
  } else {
    pts = 20;
    label = 'Çiğ +20';
    color = '#fca5a5';
  }
  manti.outcomePts = pts;
  manti.outcomeLabel = label;
  manti.outcomeColor = color;
  manti.finished = true;
  manti.finishAnim = 0;
  flashSet(label, color, 900);
}

function draw(): void {
  ctx.clearRect(0, 0, W, H);
  drawCounter();
  drawTrayStrip();
  if (manti !== null) drawManti(manti);
  drawDragLine();
  drawQualityRing();
  drawFlash();
}

function drawCounter(): void {
  ctx.save();
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, '#7a5a37');
  grad.addColorStop(1, '#553a20');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  // wood grain lines
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
  ctx.lineWidth = 1;
  for (let y = 20; y < H; y += 28) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    for (let x = 0; x <= W; x += 24) {
      const off = Math.sin((x + y) * 0.04) * 1.4;
      ctx.lineTo(x, y + off);
    }
    ctx.stroke();
  }
  ctx.restore();
}

function drawTrayStrip(): void {
  ctx.save();
  const ty = H - 90;
  ctx.fillStyle = 'rgba(15, 23, 42, 0.4)';
  ctx.fillRect(24, ty, W - 48, 64);
  ctx.strokeStyle = 'rgba(250, 204, 21, 0.4)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(24, ty, W - 48, 64);
  ctx.fillStyle = 'rgba(253, 224, 71, 0.75)';
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('TEPSİ', 32, ty - 14);

  const slotW = (W - 48 - 16) / TRAY_PER_ROUND;
  for (let i = 0; i < TRAY_PER_ROUND; i++) {
    const sx = 32 + i * (slotW + 4);
    const sy = ty + 8;
    const filled = i < trayCount;
    ctx.fillStyle = filled
      ? 'rgba(250, 204, 21, 0.18)'
      : 'rgba(255, 255, 255, 0.05)';
    ctx.strokeStyle = filled
      ? 'rgba(250, 204, 21, 0.7)'
      : 'rgba(255, 255, 255, 0.18)';
    ctx.lineWidth = 1;
    ctx.fillRect(sx, sy, slotW - 4, 48);
    ctx.strokeRect(sx, sy, slotW - 4, 48);
    if (filled) {
      const mx = sx + (slotW - 4) / 2;
      const my = sy + 24;
      drawMiniManti(mx, my, 14);
    }
  }
  ctx.restore();
}

function drawMiniManti(mx: number, my: number, r: number): void {
  ctx.save();
  ctx.translate(mx, my);
  ctx.fillStyle = '#e6c990';
  ctx.beginPath();
  ctx.moveTo(0, -r);
  ctx.lineTo(r, 0);
  ctx.lineTo(0, r);
  ctx.lineTo(-r, 0);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#7a5a37';
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.fillStyle = '#7a3220';
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.32, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawManti(m: Manti): void {
  ctx.save();
  const fade = m.finished ? 1 - m.finishAnim : 1;
  const scale = m.finished ? 1 - m.finishAnim * 0.6 : 1;
  ctx.globalAlpha = Math.max(0, fade);
  ctx.translate(m.cx, m.cy + (m.finished ? m.finishAnim * 80 : 0));
  ctx.scale(scale, scale);
  ctx.rotate(m.rot);

  // dough body — rounded square shading
  const half = m.size / 2;
  const r = 8;
  const grd = ctx.createRadialGradient(0, 0, half * 0.2, 0, 0, half * 1.3);
  grd.addColorStop(0, '#f0d9a8');
  grd.addColorStop(1, '#caa66a');
  ctx.fillStyle = grd;
  roundedRect(-half, -half, m.size, m.size, r);
  ctx.fill();
  ctx.strokeStyle = '#8a6840';
  ctx.lineWidth = 1.2;
  roundedRect(-half, -half, m.size, m.size, r);
  ctx.stroke();

  // filling dollop near center, offset toward seal
  ctx.fillStyle = '#a23a25';
  ctx.beginPath();
  ctx.arc(m.sealOX, m.sealOY, Math.min(14, m.size * 0.12), 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#6b1f12';
  ctx.beginPath();
  ctx.arc(
    m.sealOX - 2,
    m.sealOY - 2,
    Math.min(6, m.size * 0.05),
    0,
    Math.PI * 2,
  );
  ctx.fill();

  ctx.rotate(-m.rot);

  // folded triangles
  for (const c of m.corners) {
    if (!c.sealed) continue;
    drawFoldedTriangle(m, c);
  }
  ctx.restore();

  // corners on top (world coords; not inside transform)
  for (let i = 0; i < m.corners.length; i++) {
    const c = m.corners[i]!;
    drawCornerKnob(c, i === dragIdx);
  }

  // seal point (also world coords)
  const sp = sealPos(m);
  drawSealPoint(sp.x, sp.y);
}

function drawFoldedTriangle(m: Manti, c: Corner): void {
  ctx.save();
  ctx.translate(-m.cx, -m.cy);
  ctx.rotate(-m.rot);
  ctx.fillStyle = '#d9bd86';
  ctx.strokeStyle = '#8a6840';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(c.ox, c.oy);
  ctx.lineTo(c.cx, c.cy);
  // pick a side: a small perpendicular flap. Compute by taking the perpendicular
  // unit vector at the midpoint.
  const mx = (c.ox + c.cx) / 2;
  const my = (c.oy + c.cy) / 2;
  const dx = c.cx - c.ox;
  const dy = c.cy - c.oy;
  const len = Math.max(1, Math.hypot(dx, dy));
  const px = (-dy / len) * 10;
  const py = (dx / len) * 10;
  ctx.lineTo(mx + px, my + py);
  ctx.closePath();
  ctx.globalAlpha = 0.55;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.stroke();
  ctx.restore();
}

function drawCornerKnob(c: Corner, active: boolean): void {
  ctx.save();
  const x = active && dragIdx >= 0 ? dragX : c.cx;
  const y = active && dragIdx >= 0 ? dragY : c.cy;
  if (c.sealed) {
    ctx.fillStyle = 'rgba(15, 23, 42, 0.0)';
  } else {
    ctx.fillStyle = active ? '#fde047' : 'rgba(15, 23, 42, 0.55)';
    ctx.strokeStyle = active ? '#fff' : '#fde68a';
    ctx.lineWidth = active ? 2 : 1.5;
    ctx.beginPath();
    ctx.arc(x, y, active ? 9 : 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

function drawSealPoint(x: number, y: number): void {
  ctx.save();
  const cfg = roundConfig(round);
  const r = cfg.tolerance * 0.7;
  const t = 0.5 + 0.5 * Math.sin(pulse);
  ctx.globalAlpha = 0.35 + 0.25 * t;
  ctx.fillStyle = '#fde047';
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = '#facc15';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = '#fff8dc';
  ctx.beginPath();
  ctx.arc(x, y, 4 + t * 1.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawDragLine(): void {
  if (dragIdx < 0 || manti === null) return;
  const c = manti.corners[dragIdx]!;
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
  ctx.lineWidth = 1.2;
  ctx.setLineDash([6, 5]);
  ctx.beginPath();
  ctx.moveTo(c.ox, c.oy);
  ctx.lineTo(dragX, dragY);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

function drawQualityRing(): void {
  if (dragIdx < 0) return;
  const cfg = roundConfig(round);
  const q = Math.max(0, 1 - liveDist / cfg.tolerance);
  const cx = W / 2;
  const cy = 28;
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(cx, cy, 14, 0, Math.PI * 2);
  ctx.stroke();
  let col = '#fca5a5';
  if (q >= 0.9) col = '#fde047';
  else if (q >= 0.7) col = '#86efac';
  else if (q >= 0.4) col = '#fcd34d';
  ctx.strokeStyle = col;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(cx, cy, 14, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * q);
  ctx.stroke();
  ctx.fillStyle = col;
  ctx.font = 'bold 10px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(Math.round(q * 100)), cx, cy);
  ctx.restore();
}

function drawFlash(): void {
  if (flash === null) return;
  ctx.save();
  ctx.fillStyle = flash.color;
  ctx.font = 'bold 22px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(flash.text, W / 2, 90);
  ctx.restore();
}

function roundedRect(
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function canvasCoords(ev: PointerEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const sx = W / rect.width;
  const sy = H / rect.height;
  return { x: (ev.clientX - rect.left) * sx, y: (ev.clientY - rect.top) * sy };
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  roundEl = document.querySelector<HTMLElement>('#round')!;
  trayEl = document.querySelector<HTMLElement>('#tray')!;
  timeEl = document.querySelector<HTMLElement>('#time')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  canvas.addEventListener('pointerdown', (e) => {
    if (state !== 'playing') return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    const { x, y } = canvasCoords(e);
    startDrag(x, y);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (dragIdx < 0) return;
    e.preventDefault();
    const { x, y } = canvasCoords(e);
    moveDrag(x, y);
  });
  const releasePointer = (e: PointerEvent): void => {
    if (dragIdx < 0) return;
    e.preventDefault();
    const { x, y } = canvasCoords(e);
    endDrag(x, y);
  };
  canvas.addEventListener('pointerup', releasePointer);
  canvas.addEventListener('pointercancel', releasePointer);

  overlay.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (state === 'ready') startFromReady();
    else if (state === 'gameover') reset();
  });

  window.addEventListener('keydown', (e) => {
    const k = e.key;
    if (k === ' ' || k === 'Enter') {
      if (e.repeat) return;
      e.preventDefault();
      if (state === 'ready') startFromReady();
      else if (state === 'gameover') reset();
    } else if (k === 'r' || k === 'R') {
      e.preventDefault();
      reset();
    }
  });

  restartBtn.addEventListener('click', reset);

  reset();
}

export const game = defineGame({ init, reset });
