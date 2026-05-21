import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';

type GameState = 'ready' | 'playing' | 'gameover';
type Side = -1 | 1;

interface Piece {
  weight: number;
  colorVar: string;
}

interface PlacedPiece extends Piece {
  side: Side;
  stackIndex: number;
}

interface FallingPiece extends Piece {
  side: Side;
  startTime: number;
  duration: number;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  targetStackIndex: number;
}

const CANVAS_W = 480;
const CANVAS_H = 640;
const PIVOT_X = CANVAS_W / 2;
const PIVOT_Y = 470;
const ARM = 150;
const PIECE_R = 16;
const BEAM_THICK = 10;
const PREVIEW_Y = 70;
const FAIL_ANGLE = Math.PI / 4;
const FAIL_GRACE_MS = 450;
const TILT_EASE = 0.14;
const DROP_DURATION = 220;
const STORAGE_BEST = 'terazi.best';

const COLOR_VARS = [
  '--terazi-w1',
  '--terazi-w2',
  '--terazi-w3',
  '--terazi-w4',
  '--terazi-w5',
];

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let tiltEl!: HTMLElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let zoneLeft!: HTMLButtonElement;
let zoneRight!: HTMLButtonElement;

let state: GameState = 'ready';
let placed: PlacedPiece[] = [];
let leftStack = 0;
let rightStack = 0;
let totalLeft = 0;
let totalRight = 0;
let nextPiece: Piece | null = null;
let falling: FallingPiece | null = null;
let score = 0;
let best = 0;
let currentTilt = 0;
let targetTilt = 0;
let pieceFuseMs = 3000;
let pieceTimerMs = 3000;
let failTimerMs = 0;
let lastFrameTime = 0;

function loadBest(): number {
  const v = safeRead<number>(STORAGE_BEST, 0);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

const cssCache = new Map<string, string>();
function getCss(name: string): string {
  const cached = cssCache.get(name);
  if (cached !== undefined) return cached;
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  cssCache.set(name, v);
  return v;
}

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlay);
}

function hideOverlay(): void {
  hideOverlayEl(overlay);
}

function weightForScore(s: number): number {
  if (s < 8) return 1 + Math.floor(Math.random() * 2);
  if (s < 20) return 1 + Math.floor(Math.random() * 3);
  if (s < 40) return 1 + Math.floor(Math.random() * 4);
  return 1 + Math.floor(Math.random() * 5);
}

function fuseForScore(s: number): number {
  const base = 3000 - s * 55;
  return Math.max(900, base);
}

function makeNextPiece(): void {
  const w = weightForScore(score);
  nextPiece = { weight: w, colorVar: COLOR_VARS[w - 1] ?? COLOR_VARS[0]! };
  pieceFuseMs = fuseForScore(score);
  pieceTimerMs = pieceFuseMs;
}

function reset(): void {
  state = 'ready';
  placed = [];
  leftStack = 0;
  rightStack = 0;
  totalLeft = 0;
  totalRight = 0;
  falling = null;
  score = 0;
  currentTilt = 0;
  targetTilt = 0;
  failTimerMs = 0;
  scoreEl.textContent = '0';
  bestEl.textContent = String(best);
  tiltEl.textContent = '0°';
  makeNextPiece();
  showOverlay('Terazi', 'Sol veya sağ tarafa dokun · İlk taş düşer ve oyun başlar.');
}

function recalcTarget(): void {
  const diff = totalRight - totalLeft;
  const tilt = Math.atan(diff * 0.22);
  targetTilt = Math.max(-Math.PI / 2.05, Math.min(Math.PI / 2.05, tilt));
}

function localToWorld(lx: number, ly: number, tilt: number): { x: number; y: number } {
  const c = Math.cos(tilt);
  const s = Math.sin(tilt);
  return {
    x: PIVOT_X + c * lx - s * ly,
    y: PIVOT_Y + s * lx + c * ly,
  };
}

function placeOnSide(s: Side): void {
  if (falling || !nextPiece) return;
  if (state === 'gameover') return;
  if (state === 'ready') {
    state = 'playing';
    hideOverlay();
  }
  const stackIdx = s === -1 ? leftStack : rightStack;
  const trayLocalX = s * ARM;
  const trayLocalY = -BEAM_THICK / 2 - PIECE_R - stackIdx * PIECE_R * 2;
  const world = localToWorld(trayLocalX, trayLocalY, currentTilt);
  falling = {
    weight: nextPiece.weight,
    colorVar: nextPiece.colorVar,
    side: s,
    startTime: performance.now(),
    duration: DROP_DURATION,
    startX: PIVOT_X,
    startY: PREVIEW_Y,
    endX: world.x,
    endY: world.y,
    targetStackIndex: stackIdx,
  };
  nextPiece = null;
}

function settleFalling(): void {
  if (!falling) return;
  const f = falling;
  placed.push({
    weight: f.weight,
    colorVar: f.colorVar,
    side: f.side,
    stackIndex: f.targetStackIndex,
  });
  if (f.side === -1) {
    leftStack++;
    totalLeft += f.weight;
  } else {
    rightStack++;
    totalRight += f.weight;
  }
  score++;
  scoreEl.textContent = String(score);
  if (score > best) {
    best = score;
    bestEl.textContent = String(best);
    safeWrite(STORAGE_BEST, best);
  }
  falling = null;
  recalcTarget();
  makeNextPiece();
}

function gameOver(): void {
  state = 'gameover';
  showOverlay('Devrildi!', `Skor: ${score} · Tekrar için dokun veya R`);
}

function tick(now: number, dt: number): void {
  if (state === 'playing') {
    currentTilt += (targetTilt - currentTilt) * TILT_EASE;

    if (falling) {
      const elapsed = now - falling.startTime;
      if (elapsed >= falling.duration) {
        settleFalling();
      }
    }

    if (!falling && nextPiece) {
      pieceTimerMs -= dt;
      if (pieceTimerMs <= 0) {
        const auto: Side = totalRight >= totalLeft ? 1 : -1;
        placeOnSide(auto);
      }
    }

    if (Math.abs(currentTilt) > FAIL_ANGLE) {
      failTimerMs += dt;
      if (failTimerMs > FAIL_GRACE_MS) {
        gameOver();
      }
    } else {
      failTimerMs = 0;
    }
  } else {
    currentTilt += (targetTilt - currentTilt) * TILT_EASE * 0.5;
  }

  const deg = Math.round((currentTilt * 180) / Math.PI);
  tiltEl.textContent = `${deg > 0 ? '+' : ''}${deg}°`;
}

function drawPiece(x: number, y: number, p: { weight: number; colorVar: string }): void {
  const r = PIECE_R - 1;
  ctx.fillStyle = getCss(p.colorVar);
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.stroke();
  ctx.fillStyle = '#0a0b0e';
  ctx.font = 'bold 15px Inter, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(p.weight), x, y + 1);
}

function drawPivot(): void {
  ctx.fillStyle = getCss('--surface-3');
  ctx.beginPath();
  ctx.moveTo(PIVOT_X - 28, PIVOT_Y + 90);
  ctx.lineTo(PIVOT_X + 28, PIVOT_Y + 90);
  ctx.lineTo(PIVOT_X, PIVOT_Y);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = getCss('--border-strong');
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = getCss('--surface-2');
  ctx.fillRect(PIVOT_X - 80, PIVOT_Y + 90, 160, 12);
  ctx.strokeRect(PIVOT_X - 80.5, PIVOT_Y + 89.5, 161, 13);
}

function drawBeamAndStacks(): void {
  ctx.save();
  ctx.translate(PIVOT_X, PIVOT_Y);
  ctx.rotate(currentTilt);

  const armEnd = ARM + 28;
  ctx.fillStyle = getCss('--text-muted');
  ctx.fillRect(-armEnd, -BEAM_THICK / 2, armEnd * 2, BEAM_THICK);

  ctx.fillStyle = getCss('--accent-strong');
  ctx.beginPath();
  ctx.arc(0, 0, 6, 0, Math.PI * 2);
  ctx.fill();

  for (const side of [-1, 1] as Side[]) {
    const lx = side * ARM;
    ctx.fillStyle = getCss('--surface-3');
    ctx.fillRect(lx - 30, -BEAM_THICK / 2 - 6, 60, 6);
    ctx.strokeStyle = getCss('--border-strong');
    ctx.strokeRect(lx - 30.5, -BEAM_THICK / 2 - 6.5, 61, 7);
  }

  for (const p of placed) {
    const lx = p.side * ARM;
    const ly = -BEAM_THICK / 2 - PIECE_R - p.stackIndex * PIECE_R * 2;
    drawPiece(lx, ly, p);
  }

  ctx.restore();
}

function drawFalling(now: number): void {
  if (!falling) return;
  const t = Math.min(1, (now - falling.startTime) / falling.duration);
  const ease = t * t;
  const x = falling.startX + (falling.endX - falling.startX) * ease;
  const y = falling.startY + (falling.endY - falling.startY) * ease;
  drawPiece(x, y, falling);
}

function drawPreview(): void {
  if (!nextPiece || falling) return;
  drawPiece(PIVOT_X, PREVIEW_Y, nextPiece);

  if (state === 'playing') {
    const w = Math.max(0, pieceTimerMs / pieceFuseMs);
    const barW = 120;
    const barX = PIVOT_X - barW / 2;
    const barY = PREVIEW_Y + PIECE_R + 12;
    ctx.fillStyle = getCss('--border');
    ctx.fillRect(barX, barY, barW, 5);
    ctx.fillStyle = w < 0.25 ? getCss('--terazi-warn') : getCss('--accent');
    ctx.fillRect(barX, barY, barW * w, 5);
  }
}

function drawTotals(): void {
  ctx.font = '600 13px Inter, system-ui, sans-serif';
  ctx.textBaseline = 'top';
  ctx.fillStyle = getCss('--text-dim');
  ctx.textAlign = 'left';
  ctx.fillText('Sol', 22, 20);
  ctx.textAlign = 'right';
  ctx.fillText('Sağ', CANVAS_W - 22, 20);

  ctx.font = '700 20px Inter, system-ui, sans-serif';
  ctx.fillStyle = getCss('--text');
  ctx.textAlign = 'left';
  ctx.fillText(String(totalLeft), 22, 36);
  ctx.textAlign = 'right';
  ctx.fillText(String(totalRight), CANVAS_W - 22, 36);
}

function drawDangerHint(): void {
  if (state !== 'playing') return;
  if (Math.abs(currentTilt) <= FAIL_ANGLE) return;
  const alpha = Math.min(1, failTimerMs / FAIL_GRACE_MS);
  ctx.fillStyle = `rgba(248, 113, 113, ${0.1 + 0.18 * alpha})`;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
}

function draw(now: number): void {
  ctx.fillStyle = getCss('--surface');
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  drawTotals();
  drawPivot();
  drawBeamAndStacks();
  drawFalling(now);
  drawPreview();
  drawDangerHint();
}

function loop(now: number): void {
  if (lastFrameTime === 0) lastFrameTime = now;
  const dt = Math.min(64, now - lastFrameTime);
  lastFrameTime = now;
  tick(now, dt);
  draw(now);
  requestAnimationFrame(loop);
}

function handleInput(input: 'left' | 'right' | 'restart'): void {
  if (input === 'restart') {
    reset();
    return;
  }
  if (state === 'gameover') {
    reset();
    return;
  }
  const side: Side = input === 'left' ? -1 : 1;
  placeOnSide(side);
}

function bindZone(btn: HTMLButtonElement, side: 'left' | 'right'): void {
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handleInput(side);
  });
  btn.addEventListener('click', (e) => {
    e.preventDefault();
  });
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  tiltEl = document.querySelector<HTMLElement>('#tilt')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  zoneLeft = document.querySelector<HTMLButtonElement>('#zone-left')!;
  zoneRight = document.querySelector<HTMLButtonElement>('#zone-right')!;

  best = loadBest();

  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'arrowleft' || k === 'a') {
      handleInput('left');
      e.preventDefault();
    } else if (k === 'arrowright' || k === 'd') {
      handleInput('right');
      e.preventDefault();
    } else if (k === 'r') {
      handleInput('restart');
      e.preventDefault();
    } else if (k === ' ' || k === 'enter') {
      if (state === 'gameover' || state === 'ready') {
        handleInput('restart');
        e.preventDefault();
      }
    }
  });

  bindZone(zoneLeft, 'left');
  bindZone(zoneRight, 'right');

  restartBtn.addEventListener('click', () => handleInput('restart'));

  reset();
  requestAnimationFrame(loop);
}

export const game = defineGame({ init, reset });
