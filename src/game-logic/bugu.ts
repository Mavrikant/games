import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';

const STORAGE_BEST = 'bugu.best';
const SYMBOL_COUNT = 8;
const SYMBOL_NAMES = ['Kalp', 'Yıldız', 'Ay', 'Baklava', 'Daire', 'Kare', 'Üçgen', 'Artı'];
const ROUND_TIME = 60;
const WRONG_PENALTY = 4;
const WIPE_RADIUS = 34;
const REFOG_PER_FRAME = 0.0055;
const FLASH_REFOG_ALPHA = 0.95;
const SVG_NS = 'http://www.w3.org/2000/svg';

type State = 'ready' | 'playing' | 'gameover';

const gen = createGenToken();
let state: State = 'ready';
let score = 0;
let best = 0;
let timeLeft = ROUND_TIME;
let correctIdx = 0;
let options: number[] = [];

let mirror!: HTMLCanvasElement;
let mctx!: CanvasRenderingContext2D;
let fog!: HTMLCanvasElement;
let fctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let timeEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let choicesEl!: HTMLElement;

let wiping = false;
let lastWipe: { x: number; y: number } | null = null;
let timerHandle: number | null = null;

function setOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlay);
}

function pickInt(max: number): number {
  return Math.floor(Math.random() * max);
}

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = pickInt(i + 1);
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
  return arr;
}

function pickOptions(correct: number): number[] {
  const pool: number[] = [];
  for (let i = 0; i < SYMBOL_COUNT; i++) if (i !== correct) pool.push(i);
  shuffle(pool);
  const others = pool.slice(0, 3);
  return shuffle([correct, ...others]);
}

function newRound(): void {
  correctIdx = pickInt(SYMBOL_COUNT);
  options = pickOptions(correctIdx);
  renderChoices();
  flashRefog();
}

function flashRefog(): void {
  fctx.globalCompositeOperation = 'source-over';
  fctx.fillStyle = `rgba(250,253,255,${FLASH_REFOG_ALPHA})`;
  fctx.fillRect(0, 0, fog.width, fog.height);
}

function fullRefog(): void {
  fctx.globalCompositeOperation = 'source-over';
  fctx.fillStyle = 'rgba(250,253,255,1)';
  fctx.fillRect(0, 0, fog.width, fog.height);
}

function renderChoices(): void {
  choicesEl.textContent = '';
  options.forEach((idx, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'choice';
    btn.dataset.idx = String(idx);
    btn.setAttribute('aria-label', `Seçenek ${i + 1}: ${SYMBOL_NAMES[idx]}`);

    const numEl = document.createElement('span');
    numEl.className = 'choice__num';
    numEl.textContent = String(i + 1);
    btn.appendChild(numEl);

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 64 64');
    svg.setAttribute('class', 'choice__icon');
    svg.setAttribute('aria-hidden', 'true');
    svg.appendChild(symbolSvgNode(idx));
    btn.appendChild(svg);

    btn.addEventListener('click', () => answer(idx));
    choicesEl.appendChild(btn);
  });
}

function symbolSvgNode(idx: number): SVGElement {
  const wrap = document.createElementNS(SVG_NS, 'g');
  wrap.setAttribute('fill', 'currentColor');
  wrap.setAttribute('stroke', 'none');

  if (idx === 0) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute(
      'd',
      'M32 54 L9 32 C2 24 8 12 18 12 C24 12 28 16 32 21 C36 16 40 12 46 12 C56 12 62 24 55 32 Z',
    );
    wrap.appendChild(path);
  } else if (idx === 1) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', starPathStr(32, 33, 24, 11, 5, -Math.PI / 2));
    wrap.appendChild(path);
  } else if (idx === 2) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', 'M44 14 A22 22 0 1 0 44 50 A18 18 0 1 1 44 14 Z');
    wrap.appendChild(path);
  } else if (idx === 3) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', 'M32 6 L58 32 L32 58 L6 32 Z');
    wrap.appendChild(path);
  } else if (idx === 4) {
    const c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('cx', '32');
    c.setAttribute('cy', '32');
    c.setAttribute('r', '24');
    wrap.appendChild(c);
  } else if (idx === 5) {
    const r = document.createElementNS(SVG_NS, 'rect');
    r.setAttribute('x', '10');
    r.setAttribute('y', '10');
    r.setAttribute('width', '44');
    r.setAttribute('height', '44');
    r.setAttribute('rx', '4');
    wrap.appendChild(r);
  } else if (idx === 6) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', 'M32 6 L58 54 L6 54 Z');
    wrap.appendChild(path);
  } else if (idx === 7) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', 'M26 8 H38 V26 H56 V38 H38 V56 H26 V38 H8 V26 H26 Z');
    wrap.appendChild(path);
  }
  return wrap;
}

function starPathStr(
  cx: number,
  cy: number,
  rOuter: number,
  rInner: number,
  points: number,
  rot: number,
): string {
  let d = '';
  const step = Math.PI / points;
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? rOuter : rInner;
    const a = rot + i * step;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    d += (i === 0 ? 'M' : 'L') + x.toFixed(2) + ' ' + y.toFixed(2) + ' ';
  }
  return d + 'Z';
}

function drawSymbolOnMirror(idx: number): void {
  const cx = mirror.width / 2;
  const cy = mirror.height / 2;
  const size = Math.min(mirror.width, mirror.height) * 0.6;
  mctx.save();
  mctx.translate(cx - size / 2, cy - size / 2);
  const scale = size / 64;
  mctx.scale(scale, scale);
  mctx.fillStyle = '#0e1218';
  mctx.strokeStyle = '#0e1218';

  if (idx === 0) {
    mctx.beginPath();
    mctx.moveTo(32, 54);
    mctx.lineTo(9, 32);
    mctx.bezierCurveTo(2, 24, 8, 12, 18, 12);
    mctx.bezierCurveTo(24, 12, 28, 16, 32, 21);
    mctx.bezierCurveTo(36, 16, 40, 12, 46, 12);
    mctx.bezierCurveTo(56, 12, 62, 24, 55, 32);
    mctx.closePath();
    mctx.fill();
  } else if (idx === 1) {
    drawStar(mctx, 32, 33, 24, 11, 5, -Math.PI / 2);
    mctx.fill();
  } else if (idx === 2) {
    mctx.beginPath();
    mctx.arc(32, 32, 22, 0, Math.PI * 2);
    mctx.fill();
    mctx.globalCompositeOperation = 'destination-out';
    mctx.beginPath();
    mctx.arc(40, 32, 18, 0, Math.PI * 2);
    mctx.fill();
    mctx.globalCompositeOperation = 'source-over';
  } else if (idx === 3) {
    mctx.beginPath();
    mctx.moveTo(32, 6);
    mctx.lineTo(58, 32);
    mctx.lineTo(32, 58);
    mctx.lineTo(6, 32);
    mctx.closePath();
    mctx.fill();
  } else if (idx === 4) {
    mctx.beginPath();
    mctx.arc(32, 32, 24, 0, Math.PI * 2);
    mctx.fill();
  } else if (idx === 5) {
    roundRect(mctx, 10, 10, 44, 44, 4);
    mctx.fill();
  } else if (idx === 6) {
    mctx.beginPath();
    mctx.moveTo(32, 6);
    mctx.lineTo(58, 54);
    mctx.lineTo(6, 54);
    mctx.closePath();
    mctx.fill();
  } else if (idx === 7) {
    mctx.beginPath();
    mctx.moveTo(26, 8);
    mctx.lineTo(38, 8);
    mctx.lineTo(38, 26);
    mctx.lineTo(56, 26);
    mctx.lineTo(56, 38);
    mctx.lineTo(38, 38);
    mctx.lineTo(38, 56);
    mctx.lineTo(26, 56);
    mctx.lineTo(26, 38);
    mctx.lineTo(8, 38);
    mctx.lineTo(8, 26);
    mctx.lineTo(26, 26);
    mctx.closePath();
    mctx.fill();
  }
  mctx.restore();
}

function drawStar(
  c: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  rOuter: number,
  rInner: number,
  points: number,
  rot: number,
): void {
  c.beginPath();
  const step = Math.PI / points;
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? rOuter : rInner;
    const a = rot + i * step;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i === 0) c.moveTo(x, y);
    else c.lineTo(x, y);
  }
  c.closePath();
}

function roundRect(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  c.beginPath();
  c.moveTo(x + r, y);
  c.lineTo(x + w - r, y);
  c.quadraticCurveTo(x + w, y, x + w, y + r);
  c.lineTo(x + w, y + h - r);
  c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  c.lineTo(x + r, y + h);
  c.quadraticCurveTo(x, y + h, x, y + h - r);
  c.lineTo(x, y + r);
  c.quadraticCurveTo(x, y, x + r, y);
  c.closePath();
}

function drawMirrorBackground(): void {
  const w = mirror.width;
  const h = mirror.height;
  const grad = mctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, '#cdd9e4');
  grad.addColorStop(1, '#9fb1c4');
  mctx.fillStyle = grad;
  mctx.fillRect(0, 0, w, h);
}

function frame(): void {
  drawMirrorBackground();
  drawSymbolOnMirror(correctIdx);

  if (state === 'playing') {
    fctx.globalCompositeOperation = 'source-over';
    fctx.fillStyle = `rgba(250,253,255,${REFOG_PER_FRAME})`;
    fctx.fillRect(0, 0, fog.width, fog.height);
  }

  mctx.drawImage(fog, 0, 0, mirror.width, mirror.height);
  requestAnimationFrame(frame);
}

function startGameIfReady(): void {
  if (state !== 'ready') return;
  state = 'playing';
  hideOverlayEl(overlay);
  startTimer();
}

function startTimer(): void {
  stopTimer();
  const token = gen.current();
  timerHandle = window.setInterval(() => {
    if (!gen.isCurrent(token)) return;
    if (state !== 'playing') return;
    timeLeft = Math.max(0, timeLeft - 1);
    timeEl.textContent = String(timeLeft);
    if (timeLeft <= 0) gameOver();
  }, 1000);
}

function stopTimer(): void {
  if (timerHandle !== null) {
    clearInterval(timerHandle);
    timerHandle = null;
  }
}

function answer(idx: number): void {
  if (state !== 'playing') return;
  if (idx === correctIdx) {
    score++;
    scoreEl.textContent = String(score);
    if (score > best) {
      best = score;
      bestEl.textContent = String(best);
      safeWrite(STORAGE_BEST, best);
    }
    newRound();
  } else {
    timeLeft = Math.max(0, timeLeft - WRONG_PENALTY);
    timeEl.textContent = String(timeLeft);
    flashRefog();
    if (timeLeft <= 0) gameOver();
  }
}

function gameOver(): void {
  state = 'gameover';
  stopTimer();
  fullRefog();
  setOverlay('Süre doldu', `Skor: ${score} · R ile yeniden başla`);
  Array.from(choicesEl.querySelectorAll<HTMLButtonElement>('.choice')).forEach((btn) => {
    btn.disabled = true;
  });
}

function reset(): void {
  gen.bump();
  stopTimer();
  state = 'ready';
  score = 0;
  timeLeft = ROUND_TIME;
  scoreEl.textContent = '0';
  bestEl.textContent = String(best);
  timeEl.textContent = String(ROUND_TIME);
  newRound();
  Array.from(choicesEl.querySelectorAll<HTMLButtonElement>('.choice')).forEach((btn) => {
    btn.disabled = false;
  });
  fullRefog();
  setOverlay('Buğu', 'Aynayı silmeye başla.');
}

function pointerPos(e: PointerEvent): { x: number; y: number } {
  const rect = mirror.getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * mirror.width;
  const y = ((e.clientY - rect.top) / rect.height) * mirror.height;
  return { x, y };
}

function wipeAt(x: number, y: number): void {
  fctx.globalCompositeOperation = 'destination-out';
  fctx.beginPath();
  fctx.arc(x, y, WIPE_RADIUS, 0, Math.PI * 2);
  fctx.fill();
}

function wipeStroke(from: { x: number; y: number }, to: { x: number; y: number }): void {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  const steps = Math.max(1, Math.ceil(dist / 8));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    wipeAt(from.x + dx * t, from.y + dy * t);
  }
}

function onPointerDown(e: PointerEvent): void {
  if (e.button !== undefined && e.button !== 0 && e.pointerType === 'mouse') return;
  if (state === 'gameover') {
    reset();
    e.preventDefault();
    return;
  }
  wiping = true;
  if (typeof mirror.setPointerCapture === 'function') {
    try {
      mirror.setPointerCapture(e.pointerId);
    } catch {
      // older browsers
    }
  }
  const p = pointerPos(e);
  lastWipe = p;
  wipeAt(p.x, p.y);
  startGameIfReady();
  e.preventDefault();
}

function onPointerMove(e: PointerEvent): void {
  if (!wiping) return;
  if (state === 'gameover') return;
  const p = pointerPos(e);
  if (lastWipe) wipeStroke(lastWipe, p);
  else wipeAt(p.x, p.y);
  lastWipe = p;
  e.preventDefault();
}

function onPointerUp(): void {
  wiping = false;
  lastWipe = null;
}

function init(): void {
  mirror = document.querySelector<HTMLCanvasElement>('#mirror')!;
  mctx = mirror.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  timeEl = document.querySelector<HTMLElement>('#time')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  choicesEl = document.querySelector<HTMLElement>('#choices')!;

  fog = document.createElement('canvas');
  fog.width = mirror.width;
  fog.height = mirror.height;
  fctx = fog.getContext('2d')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  mirror.addEventListener('pointerdown', onPointerDown);
  mirror.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  mirror.addEventListener('pointercancel', onPointerUp);

  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'r') {
      reset();
      e.preventDefault();
      return;
    }
    if (state !== 'playing') return;
    if (k >= '1' && k <= '4') {
      const slot = Number(k) - 1;
      const idx = options[slot];
      if (idx !== undefined) {
        answer(idx);
        e.preventDefault();
      }
    }
  });

  restartBtn.addEventListener('click', reset);

  reset();
  requestAnimationFrame(frame);
}

export const game = defineGame({ init, reset });
