import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';
import { reportGameOver } from '@shared/leaderboard';

type State = 'ready' | 'playing' | 'gameover';

const STORAGE_KEY = 'kadran.best';
const SCORE_DESC = {
  gameId: 'kadran',
  storageKey: STORAGE_KEY,
  direction: 'higher' as const,
};

const DURATION_MS = 60_000;
const NUMBER_LENGTH = 5;
const HOLE_COUNT = 10;
const TWO_PI = Math.PI * 2;
const DEG = Math.PI / 180;

const STOP_ANGLE = 120 * DEG;
const HOLE_SPACING = 30 * DEG;
const DIGIT_ORDER = [1, 2, 3, 4, 5, 6, 7, 8, 9, 0] as const;

const CANVAS_SIZE = 480;
const CENTER = CANVAS_SIZE / 2;
const DIAL_OUTER_R = 220;
const DIAL_RIM_R = 200;
const HOLE_RING_R = 165;
const HOLE_R = 26;
const HUB_R = 60;
const STOP_R_INNER = 160;
const STOP_R_OUTER = 232;
const STOP_HALF_WIDTH = 12 * DEG;
const SPRING_BACK_SPEED = 540 * DEG;
const DRAG_PICK_R = HOLE_R + 12;
const WRONG_PENALTY_MS = 1000;
const SCORE_PER_NUMBER = 5;

let state: State = 'ready';
let phoneNumber: number[] = [];
let progress = 0;
let score = 0;
let best = 0;
let endTime = 0;

let dialRotation = 0;
let dragging = false;
let dragDigitIndex = -1;
let dragStartCursorAngle = 0;
let dragLockedRotation = -1;
let springingBack = false;
let lastFrameTime = 0;

let flashTimer = 0;
let flashColor: 'correct' | 'wrong' | null = null;
let activePointerId: number | null = null;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let timeEl!: HTMLElement;
let bestEl!: HTMLElement;
let numberEl!: HTMLElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let restartBtn!: HTMLButtonElement;

const gen = createGenToken();

function normalizeAngle(a: number): number {
  const r = a % TWO_PI;
  return r < 0 ? r + TWO_PI : r;
}

function baseAngleForIndex(i: number): number {
  return normalizeAngle(STOP_ANGLE - (i + 1) * HOLE_SPACING);
}

function rotationNeededForIndex(i: number): number {
  return normalizeAngle(STOP_ANGLE - baseAngleForIndex(i));
}

function angleFromCenter(x: number, y: number): number {
  return normalizeAngle(Math.atan2(x - CENTER, -(y - CENTER)));
}

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

const colors = {
  bg: '',
  surface: '',
  text: '',
  textDim: '',
  border: '',
  dial: '',
  edge: '',
  hole: '',
  stop: '',
  ring: '',
  active: '',
  correct: '',
  wrong: '',
};

function readColors(): void {
  colors.bg = cssVar('--bg', '#0a0b0e');
  colors.surface = cssVar('--surface', '#15171c');
  colors.text = cssVar('--text', '#e8eaed');
  colors.textDim = cssVar('--text-dim', '#7d8590');
  colors.border = cssVar('--border', '#262a31');
  colors.dial = cssVar('--kadran-dial', '#1f2a36');
  colors.edge = cssVar('--kadran-dial-edge', '#0c1218');
  colors.hole = cssVar('--kadran-hole', '#08090b');
  colors.stop = cssVar('--kadran-stop', '#d4af37');
  colors.ring = cssVar('--kadran-ring', '#c9b793');
  colors.active = cssVar('--kadran-active', '#f6c26b');
  colors.correct = cssVar('--kadran-correct', '#34d399');
  colors.wrong = cssVar('--kadran-wrong', '#f87171');
}

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlay);
}

function hideOverlay(): void {
  hideOverlayEl(overlay);
}

function randomDigit(): number {
  return Math.floor(Math.random() * 10);
}

function generatePhoneNumber(): number[] {
  const digits: number[] = [];
  for (let i = 0; i < NUMBER_LENGTH; i++) digits.push(randomDigit());
  return digits;
}

function renderNumber(): void {
  numberEl.innerHTML = '';
  for (let i = 0; i < phoneNumber.length; i++) {
    const span = document.createElement('span');
    span.className = 'digit';
    if (i < progress) span.classList.add('digit--done');
    else if (i === progress) span.classList.add('digit--active');
    span.textContent = String(phoneNumber[i]);
    numberEl.appendChild(span);
  }
}

function setScore(v: number): void {
  score = v;
  scoreEl.textContent = String(score);
  if (score > best) {
    best = score;
    bestEl.textContent = String(best);
    safeWrite(STORAGE_KEY, best);
  }
}

function setTime(remainingMs: number): void {
  const s = Math.max(0, Math.ceil(remainingMs / 1000));
  if (timeEl.textContent !== String(s)) timeEl.textContent = String(s);
}

function nextNumber(): void {
  phoneNumber = generatePhoneNumber();
  progress = 0;
  renderNumber();
}

function startGame(): void {
  state = 'playing';
  setScore(0);
  endTime = performance.now() + DURATION_MS;
  setTime(DURATION_MS);
  nextNumber();
  hideOverlay();
  ensureFrameLoop();
}

function endGame(): void {
  state = 'gameover';
  dragging = false;
  activePointerId = null;
  showOverlay(
    'Süre doldu',
    `Puan: ${score}\nR ile veya 'Yeniden başla' ile yeni tur.`,
  );
  bestEl.textContent = String(best);
  reportGameOver(SCORE_DESC, score);
}

function reset(): void {
  gen.bump();
  state = 'ready';
  dialRotation = 0;
  dragging = false;
  dragDigitIndex = -1;
  dragLockedRotation = -1;
  springingBack = false;
  flashTimer = 0;
  flashColor = null;
  activePointerId = null;
  phoneNumber = [];
  progress = 0;
  setScore(0);
  setTime(DURATION_MS);
  numberEl.textContent = '— — — — —';
  showOverlay('Kadran', 'Başlamak için bir deliği yakala ve durdurucuya kadar sürükle.');
  draw();
}

function ensureFrameLoop(): void {
  const myGen = gen.current();
  lastFrameTime = 0;
  const step = (t: number): void => {
    if (!gen.isCurrent(myGen)) return;
    frame(t);
    if (state === 'playing' || springingBack || flashTimer > 0) {
      requestAnimationFrame(step);
    }
  };
  requestAnimationFrame(step);
}

function frame(t: number): void {
  const dt = lastFrameTime === 0 ? 0 : Math.min(0.05, (t - lastFrameTime) / 1000);
  lastFrameTime = t;

  if (state === 'playing') {
    const remaining = endTime - t;
    setTime(remaining);
    if (remaining <= 0) {
      endGame();
    }
  }

  if (springingBack && !dragging) {
    dialRotation -= SPRING_BACK_SPEED * dt;
    if (dialRotation <= 0) {
      dialRotation = 0;
      springingBack = false;
    }
  }

  if (flashTimer > 0) {
    flashTimer = Math.max(0, flashTimer - dt);
    if (flashTimer === 0) flashColor = null;
  }

  draw();
}

function applyCorrectDigit(): void {
  progress++;
  flashColor = 'correct';
  flashTimer = 0.35;
  if (progress >= phoneNumber.length) {
    setScore(score + SCORE_PER_NUMBER);
    nextNumber();
  } else {
    renderNumber();
  }
}

function applyWrongDigit(): void {
  flashColor = 'wrong';
  flashTimer = 0.35;
  endTime -= WRONG_PENALTY_MS;
  if (endTime <= performance.now()) {
    endGame();
  }
}

function getCanvasPoint(e: PointerEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const sx = CANVAS_SIZE / rect.width;
  const sy = CANVAS_SIZE / rect.height;
  return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy };
}

function pickHole(x: number, y: number): number {
  let bestIdx = -1;
  let bestDist = DRAG_PICK_R;
  for (let i = 0; i < HOLE_COUNT; i++) {
    const a = baseAngleForIndex(i) + dialRotation;
    const hx = CENTER + HOLE_RING_R * Math.sin(a);
    const hy = CENTER - HOLE_RING_R * Math.cos(a);
    const d = Math.hypot(x - hx, y - hy);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}

function onPointerDown(e: PointerEvent): void {
  if (state === 'gameover') return;
  if (dragging || springingBack) return;
  const p = getCanvasPoint(e);
  const idx = pickHole(p.x, p.y);
  if (idx < 0) return;
  if (state === 'ready') {
    startGame();
  }
  dragging = true;
  dragDigitIndex = idx;
  dragStartCursorAngle = angleFromCenter(p.x, p.y);
  dragLockedRotation = -1;
  dialRotation = 0;
  activePointerId = e.pointerId;
  canvas.setPointerCapture(e.pointerId);
  e.preventDefault();
}

function onPointerMove(e: PointerEvent): void {
  if (!dragging || e.pointerId !== activePointerId) return;
  const p = getCanvasPoint(e);
  const cursorAngle = angleFromCenter(p.x, p.y);

  let delta = cursorAngle - dragStartCursorAngle;
  while (delta < 0) delta += TWO_PI;
  while (delta >= TWO_PI) delta -= TWO_PI;
  const cwDelta = delta;

  const required = rotationNeededForIndex(dragDigitIndex);

  if (dragLockedRotation >= 0) {
    dialRotation = dragLockedRotation;
    return;
  }

  let candidate = cwDelta;
  const monotonicGuard = TWO_PI - HOLE_SPACING;
  if (dialRotation > monotonicGuard && cwDelta < HOLE_SPACING) {
    candidate = dialRotation;
  }
  if (candidate < dialRotation) {
    candidate = dialRotation;
  }
  if (candidate >= required) {
    dialRotation = required;
    dragLockedRotation = required;
  } else {
    dialRotation = candidate;
  }
  e.preventDefault();
}

function releaseDial(): void {
  if (!dragging) return;
  const didRegister = dragLockedRotation >= 0;
  const heldIndex = dragDigitIndex;
  dragging = false;
  dragDigitIndex = -1;
  dragLockedRotation = -1;
  activePointerId = null;
  springingBack = dialRotation > 0;

  if (didRegister && state === 'playing') {
    const dialedDigit = DIGIT_ORDER[heldIndex]!;
    const expectedDigit = phoneNumber[progress];
    if (expectedDigit === dialedDigit) {
      applyCorrectDigit();
    } else {
      applyWrongDigit();
    }
  }

  if (springingBack || flashTimer > 0) ensureFrameLoop();
}

function onPointerUp(e: PointerEvent): void {
  if (e.pointerId !== activePointerId) return;
  try {
    canvas.releasePointerCapture(e.pointerId);
  } catch {
    // already released
  }
  releaseDial();
}

function onPointerCancel(e: PointerEvent): void {
  if (e.pointerId !== activePointerId) return;
  releaseDial();
}

function draw(): void {
  ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

  ctx.fillStyle = colors.surface;
  ctx.beginPath();
  ctx.arc(CENTER, CENTER, DIAL_OUTER_R + 14, 0, TWO_PI);
  ctx.fill();

  ctx.fillStyle = colors.ring;
  ctx.beginPath();
  ctx.arc(CENTER, CENTER, DIAL_OUTER_R + 8, 0, TWO_PI);
  ctx.fill();

  ctx.fillStyle = colors.text;
  ctx.font = 'bold 18px ui-sans-serif, system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < HOLE_COUNT; i++) {
    const a = baseAngleForIndex(i);
    const labelR = DIAL_OUTER_R - 8;
    const lx = CENTER + labelR * Math.sin(a);
    const ly = CENTER - labelR * Math.cos(a);
    ctx.fillStyle = colors.edge;
    ctx.fillText(String(DIGIT_ORDER[i]), lx, ly);
  }

  ctx.save();
  ctx.translate(CENTER, CENTER);
  ctx.rotate(dialRotation);

  const grad = ctx.createRadialGradient(0, 0, HUB_R, 0, 0, DIAL_RIM_R);
  grad.addColorStop(0, colors.dial);
  grad.addColorStop(1, colors.edge);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(0, 0, DIAL_RIM_R, 0, TWO_PI);
  ctx.fill();

  ctx.strokeStyle = colors.edge;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(0, 0, DIAL_RIM_R, 0, TWO_PI);
  ctx.stroke();

  for (let i = 0; i < HOLE_COUNT; i++) {
    const a = baseAngleForIndex(i);
    const hx = HOLE_RING_R * Math.sin(a);
    const hy = -HOLE_RING_R * Math.cos(a);
    ctx.fillStyle = colors.hole;
    ctx.beginPath();
    ctx.arc(hx, hy, HOLE_R, 0, TWO_PI);
    ctx.fill();

    const isActiveDigit =
      state === 'playing' &&
      progress < phoneNumber.length &&
      DIGIT_ORDER[i] === phoneNumber[progress];
    if (isActiveDigit && !dragging) {
      ctx.strokeStyle = colors.active;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(hx, hy, HOLE_R + 3, 0, TWO_PI);
      ctx.stroke();
    }

    if (dragging && i === dragDigitIndex) {
      ctx.strokeStyle = colors.active;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(hx, hy, HOLE_R + 4, 0, TWO_PI);
      ctx.stroke();
    }
  }

  ctx.fillStyle = colors.ring;
  ctx.beginPath();
  ctx.arc(0, 0, HUB_R, 0, TWO_PI);
  ctx.fill();
  ctx.strokeStyle = colors.edge;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(0, 0, HUB_R, 0, TWO_PI);
  ctx.stroke();

  ctx.restore();

  drawStop();

  if (flashColor && flashTimer > 0) {
    const alpha = Math.min(0.45, flashTimer * 1.3);
    ctx.fillStyle =
      flashColor === 'correct'
        ? hexWithAlpha(colors.correct, alpha)
        : hexWithAlpha(colors.wrong, alpha);
    ctx.beginPath();
    ctx.arc(CENTER, CENTER, DIAL_OUTER_R + 14, 0, TWO_PI);
    ctx.fill();
  }
}

function drawStop(): void {
  const a = STOP_ANGLE;
  ctx.save();
  ctx.translate(CENTER, CENTER);
  ctx.rotate(a);
  ctx.fillStyle = colors.stop;
  ctx.beginPath();
  ctx.moveTo(-STOP_HALF_WIDTH * STOP_R_OUTER, -STOP_R_OUTER);
  ctx.lineTo(STOP_HALF_WIDTH * STOP_R_OUTER, -STOP_R_OUTER);
  ctx.lineTo(STOP_HALF_WIDTH * STOP_R_INNER * 1.4, -STOP_R_INNER);
  ctx.lineTo(-STOP_HALF_WIDTH * STOP_R_INNER * 1.4, -STOP_R_INNER);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = colors.edge;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
}

function hexWithAlpha(hex: string, alpha: number): string {
  const v = hex.replace('#', '');
  if (v.length !== 6) return `rgba(255,255,255,${alpha})`;
  const r = parseInt(v.slice(0, 2), 16);
  const g = parseInt(v.slice(2, 4), 16);
  const b = parseInt(v.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function onKeyDown(e: KeyboardEvent): void {
  const k = e.key.toLowerCase();
  if (k === 'r') {
    reset();
    e.preventDefault();
  }
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  timeEl = document.querySelector<HTMLElement>('#time')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  numberEl = document.querySelector<HTMLElement>('#number')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;

  best = safeRead<number>(STORAGE_KEY, 0);
  bestEl.textContent = String(best);
  readColors();

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);
  canvas.addEventListener('pointerleave', onPointerCancel);
  window.addEventListener('keydown', onKeyDown);
  restartBtn.addEventListener('click', reset);

  reset();
}

export const game = defineGame({ init, reset });
