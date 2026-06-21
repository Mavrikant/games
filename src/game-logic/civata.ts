import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import {
  showOverlay as showOverlayEl,
  hideOverlay as hideOverlayEl,
} from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';

const BOLTS = 8;
const STAR_ORDER: readonly number[] = [0, 4, 1, 5, 2, 6, 3, 7];
const STORAGE_BEST = 'civata.best';
const PLATE_INSET = 64;
const PLATE_TOP = 40;
const PLATE_BOTTOM = 380;
const GAUGE_Y = 460;
const GAUGE_X1 = 60;
const GAUGE_X2 = 420;
const GAUGE_W = GAUGE_X2 - GAUGE_X1;

type Phase = 'ready' | 'picking' | 'gauging' | 'levelDone' | 'gameOver';

const gen = createGenToken();
let phase: Phase = 'ready';
let level = 1;
let score = 0;
let best = 0;
let plateWarp = 0;
let stepIdx = 0;
let activeBolt = -1;
let pulse = 0;
let gaugeT = 0;
let gaugeDir = 1;
let gaugeSpeed = 0.018;
let bandHalf = 0.16;
let lastFrame = 0;

const boltState: number[] = new Array(BOLTS).fill(0);

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let levelEl!: HTMLElement;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayBtn!: HTMLButtonElement;

const cssCache = new Map<string, string>();
function css(name: string): string {
  const cached = cssCache.get(name);
  if (cached !== undefined) return cached;
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  cssCache.set(name, v);
  return v;
}

function boltPos(i: number): { x: number; y: number } {
  const cx = canvas.width / 2;
  const cy = (PLATE_TOP + PLATE_BOTTOM) / 2;
  const rx = canvas.width / 2 - PLATE_INSET;
  const ry = (PLATE_BOTTOM - PLATE_TOP) / 2 - 16;
  const angle = (i / BOLTS) * Math.PI * 2 - Math.PI / 2;
  return { x: cx + Math.cos(angle) * rx, y: cy + Math.sin(angle) * ry };
}

function setOverlay(title: string, msg: string, btn?: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  if (btn) {
    overlayBtn.textContent = btn;
    overlayBtn.style.display = '';
  } else {
    overlayBtn.style.display = 'none';
  }
  showOverlayEl(overlay);
}

function hideOverlay(): void {
  hideOverlayEl(overlay);
}

function configureLevel(): void {
  gaugeSpeed = 0.014 + (level - 1) * 0.004;
  bandHalf = Math.max(0.045, 0.16 - (level - 1) * 0.018);
}

function startLevel(): void {
  configureLevel();
  for (let i = 0; i < BOLTS; i++) boltState[i] = 0;
  plateWarp = 0;
  stepIdx = 0;
  activeBolt = -1;
  gaugeT = 0;
  gaugeDir = 1;
  phase = 'picking';
  levelEl.textContent = String(level);
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
  hideOverlay();
}

function reset(): void {
  gen.bump();
  level = 1;
  score = 0;
  phase = 'ready';
  for (let i = 0; i < BOLTS; i++) boltState[i] = 0;
  plateWarp = 0;
  stepIdx = 0;
  activeBolt = -1;
  configureLevel();
  levelEl.textContent = '1';
  scoreEl.textContent = '0';
  bestEl.textContent = String(best);
  setOverlay(
    'Civata',
    'Yanıp sönen civataya tıkla. Tork göstergesi sallandığında yeşil bölgede tekrar tıkla.',
    'Başla',
  );
}

function commitBest(): void {
  if (level > best) {
    best = level;
    safeWrite(STORAGE_BEST, best);
    bestEl.textContent = String(best);
  }
}

function expectedBolt(): number {
  return STAR_ORDER[stepIdx]!;
}

let wrongFlash = 0;
let wrongFlashBolt = -1;

function onBoltClick(i: number): void {
  if (boltState[i] !== 0) return;
  const expected = expectedBolt();
  if (i !== expected) {
    plateWarp += 14;
    wrongFlash = 18;
    wrongFlashBolt = i;
    if (plateWarp >= 100) {
      finishLevelFailure();
      return;
    }
    return;
  }
  activeBolt = i;
  gaugeT = 0;
  gaugeDir = 1;
  phase = 'gauging';
}

function onGaugeStop(): void {
  if (phase !== 'gauging' || activeBolt < 0) return;
  const dist = Math.abs(gaugeT - 0.5);
  let quality: number;
  if (dist <= bandHalf) {
    const norm = 1 - dist / bandHalf;
    quality = 1 + Math.round(norm * 4);
    score += quality * 10;
  } else {
    quality = -1;
    const overshoot = (dist - bandHalf) / (0.5 - bandHalf);
    plateWarp += 10 + Math.round(overshoot * 18);
  }
  boltState[activeBolt] = quality === -1 ? -1 : quality;
  scoreEl.textContent = String(score);
  stepIdx++;
  activeBolt = -1;

  if (plateWarp >= 100) {
    finishLevelFailure();
    return;
  }
  if (stepIdx >= BOLTS) {
    finishLevelComplete();
    return;
  }
  phase = 'picking';
}

function finishLevelComplete(): void {
  phase = 'levelDone';
  const warpBonus = Math.max(0, 50 - plateWarp);
  score += warpBonus;
  scoreEl.textContent = String(score);
  level++;
  commitBest();
  setOverlay(
    'Seviye tamam',
    `Plaka eğimi: ${Math.round(plateWarp)} · Bonus: ${warpBonus}\nSıradaki seviye: ${level}`,
    'Devam',
  );
}

function finishLevelFailure(): void {
  phase = 'gameOver';
  commitBest();
  setOverlay(
    'Plaka eğildi!',
    `Sıkma hatası fazla — motor başlığı sızıntı yapar.\nSeviye ${level} · Skor ${score}`,
    'Yeniden başla',
  );
}

function pickPointer(px: number, py: number): number {
  if (phase !== 'picking') return -1;
  let closest = -1;
  let minD = Infinity;
  for (let i = 0; i < BOLTS; i++) {
    if (boltState[i] !== 0) continue;
    const p = boltPos(i);
    const d = (p.x - px) ** 2 + (p.y - py) ** 2;
    if (d < minD) {
      minD = d;
      closest = i;
    }
  }
  if (minD <= 36 * 36) return closest;
  return -1;
}

function eventToCanvas(e: PointerEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * canvas.width;
  const y = ((e.clientY - rect.top) / rect.height) * canvas.height;
  return { x, y };
}

function onPointer(e: PointerEvent): void {
  if (phase === 'ready' || phase === 'levelDone' || phase === 'gameOver') {
    return;
  }
  if (phase === 'gauging') {
    onGaugeStop();
    return;
  }
  const { x, y } = eventToCanvas(e);
  const idx = pickPointer(x, y);
  if (idx >= 0) onBoltClick(idx);
}

function draw(): void {
  const w = canvas.width;
  const h = canvas.height;

  ctx.fillStyle = css('--surface');
  ctx.fillRect(0, 0, w, h);

  const warpT = Math.min(1, plateWarp / 100);
  const cx = w / 2;
  const cy = (PLATE_TOP + PLATE_BOTTOM) / 2;
  const py = cy + Math.sin(performance.now() / 600) * 1.5;

  ctx.save();
  ctx.translate(cx, py);
  ctx.rotate(warpT * 0.04);
  ctx.scale(1, 1 - warpT * 0.04);
  ctx.fillStyle = '#2a2f38';
  const plateW = w - PLATE_INSET * 1.4;
  const plateH = PLATE_BOTTOM - PLATE_TOP - 8;
  roundRect(ctx, -plateW / 2, -plateH / 2, plateW, plateH, 28);
  ctx.fill();
  ctx.strokeStyle = '#1a1e25';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = '#1f242c';
  ctx.beginPath();
  ctx.arc(0, 0, 56, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#11151b';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();

  for (let i = 0; i < BOLTS; i++) {
    const p = boltPos(i);
    drawBolt(p.x, p.y, boltState[i]!, i === activeBolt);
  }

  if (wrongFlash > 0 && wrongFlashBolt >= 0) {
    const p = boltPos(wrongFlashBolt);
    ctx.strokeStyle = '#f87171';
    ctx.lineWidth = 3;
    ctx.globalAlpha = wrongFlash / 18;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 22, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
    wrongFlash--;
  }

  const next = expectedBolt();
  if (phase === 'picking' && boltState[next] === 0) {
    const p = boltPos(next);
    pulse = (pulse + 0.06) % (Math.PI * 2);
    const ringR = 20 + Math.sin(pulse) * 4;
    ctx.strokeStyle = css('--accent') || '#7dd3fc';
    ctx.lineWidth = 3;
    ctx.globalAlpha = 0.6 + 0.4 * Math.sin(pulse);
    ctx.beginPath();
    ctx.arc(p.x, p.y, ringR, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = css('--text-dim') || '#94a3b8';
    ctx.font = 'bold 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(String(stepIdx + 1), p.x, p.y - 28);
  }

  drawGauge();
  drawWarpBar();
  void h;
}

function drawBolt(x: number, y: number, state: number, active: boolean): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = '#0a0b0e';
  ctx.beginPath();
  ctx.arc(0, 0, 16, 0, Math.PI * 2);
  ctx.fill();

  let color = '#4b5563';
  if (state === -1) color = '#f87171';
  else if (state >= 1 && state <= 5) {
    color = ['#fbbf24', '#a3e635', '#4ade80', '#22d3ee', '#34d399'][state - 1]!;
  }
  if (active) color = css('--accent') || '#7dd3fc';

  ctx.fillStyle = color;
  ctx.beginPath();
  const r = 13;
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
    const px = Math.cos(a) * r;
    const py = Math.sin(a) * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#0a0b0e';
  ctx.lineWidth = 2;
  ctx.stroke();

  if (state >= 1) {
    ctx.fillStyle = '#0a0b0e';
    ctx.beginPath();
    ctx.arc(0, 0, 4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawGauge(): void {
  ctx.fillStyle = '#1f242c';
  roundRect(ctx, GAUGE_X1 - 6, GAUGE_Y - 22, GAUGE_W + 12, 44, 10);
  ctx.fill();

  ctx.fillStyle = '#0a0b0e';
  roundRect(ctx, GAUGE_X1, GAUGE_Y - 10, GAUGE_W, 20, 8);
  ctx.fill();

  const bandX1 = GAUGE_X1 + (0.5 - bandHalf) * GAUGE_W;
  const bandX2 = GAUGE_X1 + (0.5 + bandHalf) * GAUGE_W;
  ctx.fillStyle = '#16a34a';
  ctx.fillRect(bandX1, GAUGE_Y - 10, bandX2 - bandX1, 20);
  ctx.fillStyle = 'rgba(255,255,255,0.15)';
  ctx.fillRect(GAUGE_X1 + 0.5 * GAUGE_W - 1, GAUGE_Y - 10, 2, 20);

  if (phase === 'gauging') {
    const ix = GAUGE_X1 + gaugeT * GAUGE_W;
    ctx.fillStyle = '#fafafa';
    ctx.beginPath();
    ctx.moveTo(ix, GAUGE_Y - 16);
    ctx.lineTo(ix + 6, GAUGE_Y - 26);
    ctx.lineTo(ix - 6, GAUGE_Y - 26);
    ctx.closePath();
    ctx.fill();
    ctx.fillRect(ix - 1.5, GAUGE_Y - 14, 3, 28);
  }

  ctx.fillStyle = css('--text-dim') || '#94a3b8';
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('TORK', GAUGE_X1, GAUGE_Y + 22);
  ctx.textAlign = 'right';
  ctx.fillText(
    phase === 'gauging' ? 'Tıkla → durdur' : 'Civata seç',
    GAUGE_X2,
    GAUGE_Y + 22,
  );
  ctx.textAlign = 'left';
}

function drawWarpBar(): void {
  ctx.fillStyle = css('--text-dim') || '#94a3b8';
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('Plaka eğimi', 60, 18);

  ctx.fillStyle = '#1f242c';
  roundRect(ctx, 60, 22, 360, 8, 4);
  ctx.fill();

  const t = Math.min(1, plateWarp / 100);
  const grad = ctx.createLinearGradient(60, 0, 420, 0);
  grad.addColorStop(0, '#34d399');
  grad.addColorStop(0.5, '#fbbf24');
  grad.addColorStop(1, '#f87171');
  ctx.fillStyle = grad;
  roundRect(ctx, 60, 22, 360 * t, 8, 4);
  ctx.fill();
}

function roundRect(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + rr, y);
  c.lineTo(x + w - rr, y);
  c.quadraticCurveTo(x + w, y, x + w, y + rr);
  c.lineTo(x + w, y + h - rr);
  c.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  c.lineTo(x + rr, y + h);
  c.quadraticCurveTo(x, y + h, x, y + h - rr);
  c.lineTo(x, y + rr);
  c.quadraticCurveTo(x, y, x + rr, y);
  c.closePath();
}

function frame(now: number, myGen: number): void {
  if (!gen.isCurrent(myGen)) return;
  const dt = Math.max(0, Math.min(50, now - lastFrame));
  lastFrame = now;
  if (phase === 'gauging') {
    gaugeT += gaugeDir * gaugeSpeed * (dt / 16.67);
    if (gaugeT >= 1) {
      gaugeT = 1;
      gaugeDir = -1;
    } else if (gaugeT <= 0) {
      gaugeT = 0;
      gaugeDir = 1;
    }
  }
  draw();
  requestAnimationFrame((t) => frame(t, myGen));
}

function handleOverlayBtn(): void {
  if (phase === 'gameOver') {
    score = 0;
    level = 1;
    startLevel();
  } else if (phase === 'ready' || phase === 'levelDone') {
    startLevel();
  }
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  levelEl = document.querySelector<HTMLElement>('#level')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;

  best = safeRead<number>(STORAGE_BEST, 0);
  bestEl.textContent = String(best);

  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    onPointer(e);
  });
  restartBtn.addEventListener('click', () => {
    reset();
  });
  overlayBtn.addEventListener('click', () => {
    handleOverlayBtn();
  });
  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'r') {
      reset();
      e.preventDefault();
    } else if (k === ' ' || k === 'enter') {
      if (phase === 'gauging') {
        onGaugeStop();
        e.preventDefault();
      } else if (
        phase === 'ready' ||
        phase === 'levelDone' ||
        phase === 'gameOver'
      ) {
        handleOverlayBtn();
        e.preventDefault();
      }
    }
  });

  reset();
  lastFrame = performance.now();
  const myGen = gen.current();
  requestAnimationFrame((t) => frame(t, myGen));
}

export const game = defineGame({ init, reset });
