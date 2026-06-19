import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';

const STORAGE_BEST = 'pekmez.best';
const W = 480;
const H = 540;

const JAR_COUNT = 3;
const JAR_W = 78;
const JAR_H = 130;
const JAR_GAP = 36;
const JARS_TOTAL_W = JAR_COUNT * JAR_W + (JAR_COUNT - 1) * JAR_GAP;
const JARS_LEFT = (W - JARS_TOTAL_W) / 2;
const JAR_TOP = 360;

const SPOUT_Y = 90;
const SPOUT_HALF_W = 26;
const POUR_RATE = 0.0058;
const STREAM_FALL_PX_PER_S = 720;

type State = 'ready' | 'playing' | 'roundover';

interface Jar {
  x: number;
  target: number;
  fill: number;
  scored: boolean;
}

const gen = createGenToken();

let state: State = 'ready';
let supply = 0;
let round = 1;
let score = 0;
let best = 0;
let jarMaxSupply = 100;
let tolerance = 0.04;

let jars: Jar[] = [];
let ibrikX = W / 2;
let ibrikTargetX = W / 2;
let pouring = false;
let streamHead = SPOUT_Y;
let mouseControl = false;
let lastFrameMs = 0;
let rafHandle: number | null = null;
let droplets: { x: number; y: number; vy: number; life: number }[] = [];
let wasted = 0;

let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let roundEl!: HTMLElement;
let supplyEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let startBtn!: HTMLButtonElement;
let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;

let keyLeft = false;
let keyRight = false;

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v.length > 0 ? v : fallback;
}

function showMessage(title: string, msg: string, btnLabel: string | null): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  if (btnLabel === null) {
    startBtn.hidden = true;
  } else {
    startBtn.hidden = false;
    startBtn.textContent = btnLabel;
  }
  showOverlayEl(overlay);
}

function hideMessage(): void {
  hideOverlayEl(overlay);
}

function jarCenterX(idx: number): number {
  return JARS_LEFT + idx * (JAR_W + JAR_GAP) + JAR_W / 2;
}

function newJars(): Jar[] {
  const minTarget = 0.25;
  const maxTarget = 0.9;
  return Array.from({ length: JAR_COUNT }, (_, i) => ({
    x: jarCenterX(i),
    target: +(minTarget + Math.random() * (maxTarget - minTarget)).toFixed(2),
    fill: 0,
    scored: false,
  }));
}

function activeJarIndex(): number {
  for (let i = 0; i < jars.length; i++) {
    const j = jars[i]!;
    if (Math.abs(ibrikX - j.x) <= JAR_W / 2 - 6) return i;
  }
  return -1;
}

function startRound(): void {
  gen.bump();
  jarMaxSupply = 110 + Math.floor(round * 2);
  supply = jarMaxSupply;
  jars = newJars();
  ibrikX = W / 2;
  ibrikTargetX = W / 2;
  pouring = false;
  streamHead = SPOUT_Y;
  droplets = [];
  wasted = 0;
  tolerance = Math.max(0.025, 0.045 - round * 0.0015);
  state = 'playing';
  supplyEl.textContent = String(Math.round(supply));
  roundEl.textContent = String(round);
  hideMessage();
  startLoop();
}

function reset(): void {
  gen.bump();
  state = 'ready';
  score = 0;
  round = 1;
  jars = newJars();
  ibrikX = W / 2;
  ibrikTargetX = W / 2;
  pouring = false;
  streamHead = SPOUT_Y;
  droplets = [];
  wasted = 0;
  supply = 110;
  scoreEl.textContent = '0';
  bestEl.textContent = String(best);
  roundEl.textContent = '1';
  supplyEl.textContent = String(supply);
  draw();
  showMessage(
    'Pekmez',
    'Hedef: her kavanozu KESİK ÇİZGİYE kadar doldur. İbriği fareyle (ya da ← →) gez, Boşluk / tıkla / dokun ile dök. İbrik iki kavanoz arasındayken dökersen ziyan olur. Pekmez biterse tur biter.',
    'Başla',
  );
  stopLoop();
}

function endRound(reason: 'empty' | 'all-filled'): void {
  if (state !== 'playing') return;
  state = 'roundover';
  pouring = false;
  let roundScore = 0;
  let perfectCount = 0;
  for (const j of jars) {
    if (!j.scored) {
      const diff = Math.abs(j.fill - j.target);
      let pts = 0;
      if (diff <= tolerance) {
        pts = 100;
        perfectCount += 1;
      } else if (diff <= tolerance * 3) {
        pts = Math.round(100 * (1 - (diff - tolerance) / (tolerance * 2)));
      } else if (j.fill < j.target) {
        pts = Math.round(40 * (j.fill / j.target));
      } else {
        pts = 0;
      }
      roundScore += Math.max(0, pts);
      j.scored = true;
    }
  }
  if (perfectCount === JAR_COUNT) roundScore += 60;
  roundScore -= Math.round(wasted * 0.4);
  if (roundScore < 0) roundScore = 0;

  score += roundScore;
  scoreEl.textContent = String(score);
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
    bestEl.textContent = String(best);
  }

  draw();
  const reasonText = reason === 'all-filled' ? 'Tüm kavanozlar doldu.' : 'Pekmez tükendi.';
  const perfectText = perfectCount === JAR_COUNT ? ' (3 kavanoz tam isabet, +60 bonus!)' : '';
  showMessage(
    `Tur ${round} bitti`,
    `${reasonText}\nTur puanı: ${roundScore}${perfectText}\nIsraf: ${Math.round(wasted)} damla`,
    'Sıradaki tur',
  );
  stopLoop();
}

function startLoop(): void {
  if (rafHandle !== null) return;
  lastFrameMs = performance.now();
  const myGen = gen.current();
  const step = (now: number): void => {
    if (!gen.isCurrent(myGen)) {
      rafHandle = null;
      return;
    }
    const dt = Math.min(0.05, (now - lastFrameMs) / 1000);
    lastFrameMs = now;
    update(dt);
    draw();
    rafHandle = requestAnimationFrame(step);
  };
  rafHandle = requestAnimationFrame(step);
}

function stopLoop(): void {
  if (rafHandle !== null) {
    cancelAnimationFrame(rafHandle);
    rafHandle = null;
  }
}

function update(dt: number): void {
  if (state !== 'playing') return;

  if (!mouseControl) {
    const dir = (keyRight ? 1 : 0) - (keyLeft ? 1 : 0);
    if (dir !== 0) ibrikTargetX += dir * 280 * dt;
  }
  ibrikTargetX = Math.max(SPOUT_HALF_W + 4, Math.min(W - SPOUT_HALF_W - 4, ibrikTargetX));
  const ease = 1 - Math.pow(0.0001, dt);
  ibrikX += (ibrikTargetX - ibrikX) * ease;

  if (pouring && supply > 0) {
    const drawAmt = Math.min(supply, 38 * dt);
    supply -= drawAmt;
    streamHead = Math.min(JAR_TOP + JAR_H - 4, streamHead + STREAM_FALL_PX_PER_S * dt);

    if (streamHead >= JAR_TOP - 2) {
      const idx = activeJarIndex();
      if (idx >= 0) {
        const j = jars[idx]!;
        j.fill = Math.min(1.1, j.fill + drawAmt * POUR_RATE);
      } else {
        wasted += drawAmt;
        for (let k = 0; k < 2; k++) {
          droplets.push({
            x: ibrikX + (Math.random() - 0.5) * 8,
            y: JAR_TOP + JAR_H - 6,
            vy: 30 + Math.random() * 40,
            life: 0.7,
          });
        }
      }
    }
    supplyEl.textContent = String(Math.max(0, Math.round(supply)));
  } else {
    streamHead = Math.max(SPOUT_Y, streamHead - STREAM_FALL_PX_PER_S * 1.4 * dt);
  }

  for (const d of droplets) {
    d.y += d.vy * dt;
    d.vy += 220 * dt;
    d.life -= dt;
  }
  droplets = droplets.filter((d) => d.life > 0 && d.y < H + 10);

  if (supply <= 0.01 && !pouring) {
    endRound('empty');
    return;
  }
  const allInBand = jars.every((j) => j.fill >= j.target - tolerance && j.fill <= j.target + tolerance);
  if (allInBand && !pouring) {
    endRound('all-filled');
  }
}

function draw(): void {
  ctx.fillStyle = cssVar('--surface', '#15171c');
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = cssVar('--border', '#2c2f37');
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, JAR_TOP + JAR_H + 18);
  ctx.lineTo(W, JAR_TOP + JAR_H + 18);
  ctx.stroke();

  if (state === 'playing' || state === 'roundover') {
    drawIbrik(ibrikX, SPOUT_Y - 56);
    if (pouring || streamHead > SPOUT_Y + 2) {
      drawStream(ibrikX, SPOUT_Y, streamHead);
    }
  }

  for (let i = 0; i < jars.length; i++) {
    drawJar(jars[i]!, i);
  }

  for (const d of droplets) {
    ctx.fillStyle = 'rgba(140,68,28,0.7)';
    ctx.beginPath();
    ctx.arc(d.x, d.y, 2.4, 0, Math.PI * 2);
    ctx.fill();
  }

  if (state === 'playing') {
    const idx = activeJarIndex();
    if (idx >= 0) {
      const j = jars[idx]!;
      ctx.strokeStyle = 'rgba(255,200,120,0.75)';
      ctx.lineWidth = 2;
      ctx.strokeRect(j.x - JAR_W / 2 - 2, JAR_TOP - 2, JAR_W + 4, JAR_H + 4);
    }
  }
}

function drawIbrik(x: number, y: number): void {
  ctx.save();
  ctx.fillStyle = cssVar('--text-dim', '#9aa0aa');
  ctx.strokeStyle = cssVar('--text', '#e6e6e6');
  ctx.lineWidth = 2;
  const bodyW = 64;
  const bodyH = 52;
  ctx.beginPath();
  ctx.moveTo(x - bodyW / 2, y);
  ctx.quadraticCurveTo(x - bodyW / 2 - 6, y + bodyH / 2, x - bodyW / 2 + 4, y + bodyH);
  ctx.lineTo(x + bodyW / 2 - 4, y + bodyH);
  ctx.quadraticCurveTo(x + bodyW / 2 + 6, y + bodyH / 2, x + bodyW / 2, y);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(x - SPOUT_HALF_W, y + bodyH);
  ctx.lineTo(x + SPOUT_HALF_W, y + bodyH);
  ctx.lineTo(x + SPOUT_HALF_W * 0.6, y + bodyH + 14);
  ctx.lineTo(x - SPOUT_HALF_W * 0.6, y + bodyH + 14);
  ctx.closePath();
  ctx.fillStyle = cssVar('--text', '#e6e6e6');
  ctx.fill();

  ctx.strokeStyle = cssVar('--text-dim', '#9aa0aa');
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(x, y - 6, 14, Math.PI, 0);
  ctx.stroke();

  if (pouring) {
    ctx.fillStyle = 'rgba(140,68,28,0.9)';
    ctx.beginPath();
    ctx.arc(x, y + bodyH + 16, 4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawStream(x: number, top: number, bottom: number): void {
  ctx.save();
  const grd = ctx.createLinearGradient(x, top, x, bottom);
  grd.addColorStop(0, 'rgba(180, 92, 40, 0.95)');
  grd.addColorStop(1, 'rgba(120, 56, 24, 0.95)');
  ctx.fillStyle = grd;
  const wTop = 4;
  const wBot = 7;
  ctx.beginPath();
  ctx.moveTo(x - wTop / 2, top);
  ctx.lineTo(x + wTop / 2, top);
  ctx.lineTo(x + wBot / 2, bottom);
  ctx.lineTo(x - wBot / 2, bottom);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawJar(j: Jar, idx: number): void {
  const left = j.x - JAR_W / 2;
  const top = JAR_TOP;
  const accent = idx === 0 ? '#d77a3a' : idx === 1 ? '#3a9fd7' : '#9a6dd1';

  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.05)';
  ctx.strokeStyle = cssVar('--border', '#3a3e48');
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(left, top, JAR_W, JAR_H, [12, 12, 6, 6]);
  ctx.fill();
  ctx.stroke();

  const fillVisual = Math.min(1, j.fill);
  const fillH = JAR_H * fillVisual;
  const grd = ctx.createLinearGradient(left, top + JAR_H - fillH, left, top + JAR_H);
  grd.addColorStop(0, 'rgba(170,84,36,0.95)');
  grd.addColorStop(1, 'rgba(90,38,12,0.95)');
  ctx.fillStyle = grd;
  ctx.beginPath();
  ctx.roundRect(left + 2, top + JAR_H - fillH, JAR_W - 4, fillH, [0, 0, 5, 5]);
  ctx.fill();

  if (j.fill > 1.0) {
    ctx.fillStyle = 'rgba(220,80,60,0.4)';
    ctx.fillRect(left, top - 4, JAR_W, 4);
  }

  const targetY = top + JAR_H * (1 - j.target);
  ctx.strokeStyle = accent;
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(left - 4, targetY);
  ctx.lineTo(left + JAR_W + 4, targetY);
  ctx.stroke();
  ctx.setLineDash([]);

  const bandTop = top + JAR_H * (1 - Math.min(1, j.target + tolerance));
  const bandBot = top + JAR_H * (1 - Math.max(0, j.target - tolerance));
  ctx.fillStyle = `${accent}33`;
  ctx.fillRect(left, bandTop, JAR_W, bandBot - bandTop);

  ctx.fillStyle = accent;
  ctx.font = 'bold 13px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`${Math.round(j.target * 100)}%`, j.x, top - 8);

  ctx.fillStyle = 'rgba(230,230,230,0.65)';
  ctx.font = '11px system-ui, sans-serif';
  ctx.fillText(`${Math.round(j.fill * 100)}`, j.x, top + JAR_H + 14);

  ctx.restore();
}

function setPour(v: boolean): void {
  if (state !== 'playing') return;
  if (v && supply <= 0) return;
  pouring = v;
  if (!v) streamHead = SPOUT_Y;
}

function onPointerMove(e: PointerEvent): void {
  if (state !== 'playing') return;
  const rect = canvas.getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * W;
  ibrikTargetX = x;
  mouseControl = true;
}

function advanceFromOverlay(): void {
  if (state === 'ready') startRound();
  else if (state === 'roundover') {
    round += 1;
    startRound();
  }
}

function onPointerDown(e: PointerEvent): void {
  if (state !== 'playing') {
    advanceFromOverlay();
    return;
  }
  const rect = canvas.getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * W;
  ibrikTargetX = x;
  mouseControl = true;
  setPour(true);
  canvas.setPointerCapture(e.pointerId);
}

function onPointerUp(e: PointerEvent): void {
  setPour(false);
  if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
}

function onKeyDown(e: KeyboardEvent): void {
  const k = e.key.toLowerCase();
  if (k === 'arrowleft' || k === 'a') {
    keyLeft = true;
    mouseControl = false;
    e.preventDefault();
  } else if (k === 'arrowright' || k === 'd') {
    keyRight = true;
    mouseControl = false;
    e.preventDefault();
  } else if (k === ' ' || k === 'enter') {
    if (state === 'playing') setPour(true);
    else advanceFromOverlay();
    e.preventDefault();
  } else if (k === 'r') {
    reset();
    e.preventDefault();
  }
}

function onKeyUp(e: KeyboardEvent): void {
  const k = e.key.toLowerCase();
  if (k === 'arrowleft' || k === 'a') keyLeft = false;
  else if (k === 'arrowright' || k === 'd') keyRight = false;
  else if (k === ' ' || k === 'enter') setPour(false);
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  roundEl = document.querySelector<HTMLElement>('#round')!;
  supplyEl = document.querySelector<HTMLElement>('#supply')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  startBtn = document.querySelector<HTMLButtonElement>('#start')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  restartBtn.addEventListener('click', reset);
  startBtn.addEventListener('click', advanceFromOverlay);
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  reset();
}

export const game = defineGame({ init, reset });
