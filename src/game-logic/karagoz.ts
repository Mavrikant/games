import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';

const STORAGE_BEST = 'karagoz.best';
const ROUND_SECONDS = 60;

const STAGE_W = 720;
const STAGE_H = 480;

const LIGHT_X = 60;
const LIGHT_Y = STAGE_H / 2;
const PERDE_X = 640;
const PERDE_W = 56;
const SPAN = PERDE_X - LIGHT_X;

const PUPPET_BODY_H = 44;
const PUPPET_BODY_W = 18;

const PUPPET_MIN_X = LIGHT_X + 40;
const PUPPET_MAX_X = PERDE_X - 30;
const PUPPET_MIN_Y = 90;
const PUPPET_MAX_Y = STAGE_H - 90;

const HEIGHT_TOLERANCE = 11;
const CENTER_TOLERANCE = 16;
const LOCK_TIME_MS = 700;

type State = 'ready' | 'playing' | 'gameover';

type Target = {
  targetHeight: number;
  targetCenterY: number;
};

const gen = createGenToken();
let state: State = 'ready';
let score = 0;
let best = 0;
let timeLeftMs = ROUND_SECONDS * 1000;
let lockMs = 0;
let lastTs = 0;

let target: Target = { targetHeight: 100, targetCenterY: STAGE_H / 2 };
let puppetX = (LIGHT_X + PERDE_X) / 2;
let puppetY = STAGE_H / 2;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let timeEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let actionBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function shadowScaleFor(px: number): number {
  return SPAN / (px - LIGHT_X);
}

function shadowHeight(px: number): number {
  return PUPPET_BODY_H * shadowScaleFor(px);
}

function shadowCenterY(px: number, py: number): number {
  const scale = shadowScaleFor(px);
  return LIGHT_Y + (py - LIGHT_Y) * scale;
}

function newTarget(): Target {
  const minH = 60;
  const maxH = 230;
  const h = minH + Math.random() * (maxH - minH);
  const halfH = h / 2;
  const minCy = halfH + 30;
  const maxCy = STAGE_H - halfH - 30;
  const cy = minCy + Math.random() * Math.max(1, maxCy - minCy);
  return { targetHeight: h, targetCenterY: cy };
}

function isLockMatch(): boolean {
  const sh = shadowHeight(puppetX);
  const sy = shadowCenterY(puppetX, puppetY);
  return (
    Math.abs(sh - target.targetHeight) < HEIGHT_TOLERANCE &&
    Math.abs(sy - target.targetCenterY) < CENTER_TOLERANCE
  );
}

function updateHud(): void {
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
  timeEl.textContent = String(Math.max(0, Math.ceil(timeLeftMs / 1000)));
}

function commitBest(): void {
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
}

function showOverlay(title: string, msg: string, btn: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  actionBtn.textContent = btn;
  showOverlayEl(overlay);
}

function hideOverlay(): void {
  hideOverlayEl(overlay);
}

function startRun(): void {
  gen.bump();
  state = 'playing';
  score = 0;
  timeLeftMs = ROUND_SECONDS * 1000;
  lockMs = 0;
  target = newTarget();
  hideOverlay();
  updateHud();
  lastTs = 0;
  scheduleLoop();
}

function endRun(): void {
  state = 'gameover';
  commitBest();
  updateHud();
  draw();
  showOverlay(
    'Perde indi',
    `Skor: ${score}\nRekor: ${best}\nYeniden başlamak için Boşluk'a bas veya butona dokun.`,
    'Tekrar',
  );
}

function reset(): void {
  gen.bump();
  state = 'ready';
  score = 0;
  timeLeftMs = ROUND_SECONDS * 1000;
  lockMs = 0;
  target = newTarget();
  updateHud();
  draw();
  showOverlay(
    'Karagöz Gölge Tiyatrosu',
    `Soldaki mum ile sağdaki perde arasında kuklayı dolaştır.
Işığa yaklaştırırsan gölge büyür, perdeye yaklaştırırsan küçülür.
Perdedeki kesik silueti tutturup kısa bir an sabit kalırsan tamamlanır.

Başlamak için Boşluk'a bas veya Başla'ya dokun.`,
    'Başla',
  );
}

function scheduleLoop(): void {
  const myGen = gen.current();
  const step = (ts: number): void => {
    if (!gen.isCurrent(myGen)) return;
    if (state !== 'playing') return;
    if (lastTs === 0) lastTs = ts;
    const dt = Math.min(64, ts - lastTs);
    lastTs = ts;

    timeLeftMs -= dt;
    if (timeLeftMs <= 0) {
      timeLeftMs = 0;
      updateHud();
      draw();
      endRun();
      return;
    }

    if (isLockMatch()) {
      lockMs += dt;
      if (lockMs >= LOCK_TIME_MS) {
        score += 1;
        if (score > best) {
          best = score;
          safeWrite(STORAGE_BEST, best);
        }
        target = newTarget();
        lockMs = 0;
      }
    } else {
      lockMs = Math.max(0, lockMs - dt * 0.6);
    }

    updateHud();
    draw();
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function drawBackground(): void {
  const grad = ctx.createLinearGradient(0, 0, 0, STAGE_H);
  grad.addColorStop(0, '#10131a');
  grad.addColorStop(1, '#06070a');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, STAGE_W, STAGE_H);

  ctx.fillStyle = 'rgba(40, 30, 18, 0.55)';
  ctx.fillRect(0, STAGE_H - 36, STAGE_W, 36);
}

function drawLight(): void {
  const flicker = 1 + Math.sin(performance.now() / 120) * 0.04 + (Math.random() - 0.5) * 0.05;
  const outer = ctx.createRadialGradient(LIGHT_X, LIGHT_Y, 6, LIGHT_X, LIGHT_Y, 220 * flicker);
  outer.addColorStop(0, 'rgba(255, 220, 140, 0.55)');
  outer.addColorStop(0.4, 'rgba(255, 180, 90, 0.18)');
  outer.addColorStop(1, 'rgba(255, 180, 90, 0)');
  ctx.fillStyle = outer;
  ctx.fillRect(0, 0, STAGE_W, STAGE_H);

  ctx.fillStyle = '#3a2814';
  ctx.fillRect(LIGHT_X - 8, LIGHT_Y + 4, 16, 60);
  ctx.fillStyle = '#5a3a1a';
  ctx.fillRect(LIGHT_X - 14, LIGHT_Y + 60, 28, 6);

  ctx.fillStyle = '#ead7a8';
  ctx.fillRect(LIGHT_X - 3, LIGHT_Y - 6, 6, 14);

  ctx.beginPath();
  ctx.ellipse(LIGHT_X, LIGHT_Y - 12, 4.2, 8 * flicker, 0, 0, Math.PI * 2);
  ctx.fillStyle = '#ffd06a';
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(LIGHT_X, LIGHT_Y - 14, 2.2, 4 * flicker, 0, 0, Math.PI * 2);
  ctx.fillStyle = '#fff2c2';
  ctx.fill();
}

function puppetPath(p: CanvasRenderingContext2D, cx: number, cy: number, w: number, h: number): void {
  const hh = h / 2;
  const hw = w / 2;
  p.beginPath();
  // hat
  p.moveTo(cx - hw * 0.9, cy - hh + hh * 0.18);
  p.lineTo(cx - hw * 1.4, cy - hh + hh * 0.18);
  p.lineTo(cx - hw * 1.1, cy - hh - hh * 0.05);
  p.lineTo(cx - hw * 0.3, cy - hh - hh * 0.32);
  p.lineTo(cx + hw * 0.4, cy - hh - hh * 0.2);
  p.lineTo(cx + hw * 0.6, cy - hh + hh * 0.05);
  // head
  p.lineTo(cx + hw * 0.9, cy - hh + hh * 0.18);
  p.lineTo(cx + hw * 1.0, cy - hh + hh * 0.34);
  p.lineTo(cx + hw * 0.8, cy - hh + hh * 0.5);
  // beard
  p.lineTo(cx + hw * 1.5, cy - hh + hh * 0.7);
  p.lineTo(cx + hw * 0.7, cy - hh + hh * 0.78);
  // shoulders + body
  p.lineTo(cx + hw * 1.4, cy - hh + hh * 0.95);
  p.lineTo(cx + hw * 1.05, cy + hh * 0.2);
  p.lineTo(cx + hw * 0.55, cy + hh * 0.55);
  // legs
  p.lineTo(cx + hw * 0.4, cy + hh);
  p.lineTo(cx + hw * 0.05, cy + hh);
  p.lineTo(cx + hw * 0.05, cy + hh * 0.7);
  p.lineTo(cx - hw * 0.1, cy + hh * 0.7);
  p.lineTo(cx - hw * 0.1, cy + hh);
  p.lineTo(cx - hw * 0.45, cy + hh);
  // left side back up
  p.lineTo(cx - hw * 0.55, cy + hh * 0.55);
  p.lineTo(cx - hw * 1.1, cy + hh * 0.2);
  p.lineTo(cx - hw * 1.4, cy - hh + hh * 0.95);
  p.lineTo(cx - hw * 0.6, cy - hh + hh * 0.78);
  p.lineTo(cx - hw * 0.95, cy - hh + hh * 0.5);
  p.lineTo(cx - hw * 1.05, cy - hh + hh * 0.32);
  p.closePath();
}

function drawPerde(): void {
  ctx.fillStyle = 'rgba(230, 200, 130, 0.92)';
  ctx.fillRect(PERDE_X, 0, PERDE_W, STAGE_H);

  ctx.strokeStyle = 'rgba(120, 80, 30, 0.85)';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(PERDE_X, 0);
  ctx.lineTo(PERDE_X, STAGE_H);
  ctx.moveTo(PERDE_X + PERDE_W, 0);
  ctx.lineTo(PERDE_X + PERDE_W, STAGE_H);
  ctx.stroke();

  for (let y = 0; y < STAGE_H; y += 18) {
    ctx.strokeStyle = 'rgba(200, 160, 80, 0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PERDE_X + 2, y);
    ctx.lineTo(PERDE_X + PERDE_W - 2, y);
    ctx.stroke();
  }
}

function drawTarget(): void {
  const tcx = PERDE_X + PERDE_W / 2;
  const tcy = target.targetCenterY;
  const th = target.targetHeight;
  const tw = th * (PUPPET_BODY_W / PUPPET_BODY_H);

  ctx.save();
  ctx.setLineDash([6, 5]);
  ctx.lineWidth = 2;
  ctx.strokeStyle = isLockMatch() ? '#5fe089' : '#284a86';
  puppetPath(ctx, tcx, tcy, tw, th);
  ctx.stroke();
  ctx.restore();

  // helpful pin marks for top/bottom
  ctx.fillStyle = 'rgba(40, 70, 130, 0.55)';
  ctx.fillRect(PERDE_X - 6, tcy - th / 2 - 1, 6, 2);
  ctx.fillRect(PERDE_X - 6, tcy + th / 2 - 1, 6, 2);
}

function drawShadow(): void {
  const scale = shadowScaleFor(puppetX);
  const sh = PUPPET_BODY_H * scale;
  const sw = PUPPET_BODY_W * scale;
  const sy = LIGHT_Y + (puppetY - LIGHT_Y) * scale;
  const sx = PERDE_X + PERDE_W / 2;

  ctx.save();
  const matched = isLockMatch();
  ctx.fillStyle = matched ? 'rgba(36, 78, 38, 0.85)' : 'rgba(20, 18, 14, 0.78)';
  puppetPath(ctx, sx, sy, sw, sh);
  ctx.fill();
  ctx.restore();
}

function drawPuppet(): void {
  ctx.save();
  ctx.fillStyle = '#1a1410';
  puppetPath(ctx, puppetX, puppetY, PUPPET_BODY_W, PUPPET_BODY_H);
  ctx.fill();
  ctx.strokeStyle = 'rgba(220, 180, 90, 0.5)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // stick from below
  ctx.strokeStyle = 'rgba(180, 130, 60, 0.7)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(puppetX, puppetY + PUPPET_BODY_H / 2);
  ctx.lineTo(puppetX, STAGE_H - 20);
  ctx.stroke();
  ctx.restore();
}

function drawLockMeter(): void {
  if (state !== 'playing') return;
  if (lockMs <= 0) return;
  const pct = Math.min(1, lockMs / LOCK_TIME_MS);
  const w = 220;
  const x = (STAGE_W - w) / 2;
  const y = STAGE_H - 24;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.fillRect(x, y, w, 10);
  ctx.fillStyle = '#5fe089';
  ctx.fillRect(x + 2, y + 2, (w - 4) * pct, 6);
}

function drawHint(): void {
  if (state !== 'ready') return;
  ctx.fillStyle = 'rgba(255, 240, 200, 0.55)';
  ctx.font = '13px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Mum ←', LIGHT_X, LIGHT_Y - 80);
  ctx.fillText('Perde →', PERDE_X + PERDE_W / 2, 30);
  ctx.textAlign = 'left';
}

function draw(): void {
  drawBackground();
  drawLight();
  drawPerde();
  drawTarget();
  drawShadow();
  drawPuppet();
  drawHint();
  drawLockMeter();
}

function canvasCoordsFromEvent(clientX: number, clientY: number): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const sx = STAGE_W / rect.width;
  const sy = STAGE_H / rect.height;
  return { x: (clientX - rect.left) * sx, y: (clientY - rect.top) * sy };
}

function setPuppetFromPointer(clientX: number, clientY: number): void {
  const c = canvasCoordsFromEvent(clientX, clientY);
  puppetX = clamp(c.x, PUPPET_MIN_X, PUPPET_MAX_X);
  puppetY = clamp(c.y, PUPPET_MIN_Y, PUPPET_MAX_Y);
  if (state === 'ready') draw();
}

function onPointerMove(e: PointerEvent): void {
  setPuppetFromPointer(e.clientX, e.clientY);
}

function onTouchMove(e: TouchEvent): void {
  if (e.touches.length === 0) return;
  const t = e.touches[0]!;
  setPuppetFromPointer(t.clientX, t.clientY);
  e.preventDefault();
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.key === 'r' || e.key === 'R') {
    reset();
    e.preventDefault();
    return;
  }
  if (e.key === ' ' || e.key === 'Enter') {
    if (state === 'ready' || state === 'gameover') {
      startRun();
      e.preventDefault();
    }
  }
}

function onActionBtn(): void {
  if (state === 'playing') return;
  startRun();
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#stage')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  timeEl = document.querySelector<HTMLElement>('#time')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  actionBtn = document.querySelector<HTMLButtonElement>('#action-btn')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('touchmove', onTouchMove, { passive: false });
  canvas.addEventListener('pointerdown', (e) => {
    setPuppetFromPointer(e.clientX, e.clientY);
    if (state === 'ready' || state === 'gameover') startRun();
  });
  restartBtn.addEventListener('click', reset);
  actionBtn.addEventListener('click', onActionBtn);
  window.addEventListener('keydown', onKeyDown);

  reset();
}

export const game = defineGame({ init, reset });
