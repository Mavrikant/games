import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay, hideOverlay } from '@shared/overlay';

const STORAGE_BEST = 'sek-sek.best';
const TOTAL_ROUNDS = 8;
const MAX_MISS = 3;
const FRICTION = 0.955;
const STOP_SPEED = 0.8;
const POWER_K = 0.18;
const MAX_POWER_PX = 220;
const STONE_RADIUS = 10;

type Square = { n: number; cx: number; cy: number };
type Phase = 'ready' | 'aiming' | 'flying' | 'between' | 'won' | 'gameover';

const SQUARES: Square[] = [
  { n: 1, cx: 180, cy: 500 },
  { n: 2, cx: 180, cy: 415 },
  { n: 3, cx: 180, cy: 330 },
  { n: 4, cx: 138, cy: 245 },
  { n: 5, cx: 222, cy: 245 },
  { n: 6, cx: 180, cy: 160 },
  { n: 7, cx: 138, cy: 75 },
  { n: 8, cx: 222, cy: 75 },
];
const SQUARE_SIZE = 78;
const PLAYER = { x: 180, y: 565 };

const gen = createGenToken();

let phase: Phase = 'ready';
let score = 0;
let best = 0;
let round = 1;
let misses = 0;
let lastResult: 'hit' | 'miss' | null = null;
let lastResultText = '';

let aiming = false;
let aimX = 0;
let aimY = 0;

let stoneX = PLAYER.x;
let stoneY = PLAYER.y;
let stoneVX = 0;
let stoneVY = 0;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let roundEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlayEl!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayBtn!: HTMLButtonElement;

function targetSquare(): Square {
  return SQUARES[round - 1]!;
}

function startRound(): void {
  phase = 'aiming';
  aiming = false;
  aimX = PLAYER.x;
  aimY = PLAYER.y;
  stoneX = PLAYER.x;
  stoneY = PLAYER.y;
  stoneVX = 0;
  stoneVY = 0;
  hideOverlay(overlayEl);
  updateHud();
  draw();
}

function newGame(): void {
  gen.bump();
  score = 0;
  round = 1;
  misses = 0;
  lastResult = null;
  lastResultText = '';
  startRound();
}

function reset(): void {
  gen.bump();
  score = 0;
  round = 1;
  misses = 0;
  lastResult = null;
  lastResultText = '';
  phase = 'ready';
  aiming = false;
  stoneX = PLAYER.x;
  stoneY = PLAYER.y;
  stoneVX = 0;
  stoneVY = 0;
  showReadyOverlay();
  updateHud();
  draw();
}

function showReadyOverlay(): void {
  overlayTitle.textContent = 'Sek-Sek';
  overlayMsg.textContent =
    'Oyuncudan taşı tut, geriye sürükle ve hedef kareye doğru fırlat.\n3 ıska oyunu bitirir.';
  overlayBtn.textContent = 'Başla';
  showOverlay(overlayEl);
}

function showWinOverlay(): void {
  overlayTitle.textContent = '8/8 — Sek-Sek!';
  overlayMsg.textContent = `Tüm kareleri vurdun. Skor: ${score}`;
  overlayBtn.textContent = 'Tekrar oyna';
  showOverlay(overlayEl);
}

function showGameOverOverlay(): void {
  overlayTitle.textContent = 'Oyun bitti';
  overlayMsg.textContent = `${misses} ıska. Skor: ${score} · Rekor: ${best}`;
  overlayBtn.textContent = 'Yeniden';
  showOverlay(overlayEl);
}

function updateHud(): void {
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
  roundEl.textContent = `${Math.min(round, TOTAL_ROUNDS)}/${TOTAL_ROUNDS}`;
}

function squareUnder(x: number, y: number): Square | null {
  for (const s of SQUARES) {
    if (
      x >= s.cx - SQUARE_SIZE / 2 &&
      x <= s.cx + SQUARE_SIZE / 2 &&
      y >= s.cy - SQUARE_SIZE / 2 &&
      y <= s.cy + SQUARE_SIZE / 2
    ) {
      return s;
    }
  }
  return null;
}

function resolveLanding(): void {
  const landed = squareUnder(stoneX, stoneY);
  const tgt = targetSquare();
  if (landed && landed.n === tgt.n) {
    const dx = stoneX - tgt.cx;
    const dy = stoneY - tgt.cy;
    const dist = Math.hypot(dx, dy);
    const accuracy = Math.max(0, 1 - dist / (SQUARE_SIZE / 2));
    const points = 100 + Math.round(accuracy * 50);
    score += points;
    lastResult = 'hit';
    lastResultText = `+${points}`;
  } else {
    misses++;
    lastResult = 'miss';
    lastResultText = landed ? `Iska: ${landed.n}` : 'Iska';
  }

  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
  updateHud();

  phase = 'between';
  draw();

  const myGen = gen.current();
  window.setTimeout(() => {
    if (!gen.isCurrent(myGen)) return;
    if (misses >= MAX_MISS) {
      phase = 'gameover';
      showGameOverOverlay();
      draw();
      return;
    }
    if (round >= TOTAL_ROUNDS) {
      phase = 'won';
      showWinOverlay();
      draw();
      return;
    }
    round++;
    startRound();
  }, 900);
}

function step(): void {
  if (phase !== 'flying') return;
  stoneX += stoneVX;
  stoneY += stoneVY;
  stoneVX *= FRICTION;
  stoneVY *= FRICTION;

  const oob =
    stoneX < -STONE_RADIUS ||
    stoneX > canvas.width + STONE_RADIUS ||
    stoneY < -STONE_RADIUS ||
    stoneY > canvas.height + STONE_RADIUS;

  const speed = Math.hypot(stoneVX, stoneVY);
  if (oob || speed < STOP_SPEED) {
    resolveLanding();
    return;
  }

  const myGen = gen.current();
  requestAnimationFrame(() => {
    if (!gen.isCurrent(myGen)) return;
    draw();
    step();
  });
}

function launch(): void {
  const dx = aimX - PLAYER.x;
  const dy = aimY - PLAYER.y;
  const drag = Math.hypot(dx, dy);
  if (drag < 8) {
    aiming = false;
    aimX = PLAYER.x;
    aimY = PLAYER.y;
    draw();
    return;
  }
  const clamped = Math.min(drag, MAX_POWER_PX);
  const ux = dx / drag;
  const uy = dy / drag;
  const power = clamped * POWER_K;
  stoneVX = -ux * power;
  stoneVY = -uy * power;
  stoneX = PLAYER.x;
  stoneY = PLAYER.y;
  aiming = false;
  phase = 'flying';
  step();
}

function eventPos(e: PointerEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const sx = canvas.width / rect.width;
  const sy = canvas.height / rect.height;
  return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy };
}

function onPointerDown(e: PointerEvent): void {
  if (phase !== 'aiming') return;
  const { x, y } = eventPos(e);
  aiming = true;
  aimX = x;
  aimY = y;
  canvas.setPointerCapture(e.pointerId);
  draw();
  e.preventDefault();
}

function onPointerMove(e: PointerEvent): void {
  if (!aiming || phase !== 'aiming') return;
  const { x, y } = eventPos(e);
  aimX = x;
  aimY = y;
  draw();
  e.preventDefault();
}

function onPointerUp(e: PointerEvent): void {
  if (!aiming || phase !== 'aiming') return;
  canvas.releasePointerCapture(e.pointerId);
  launch();
  e.preventDefault();
}

function onPointerCancel(): void {
  if (!aiming) return;
  aiming = false;
  aimX = PLAYER.x;
  aimY = PLAYER.y;
  draw();
}

function drawSquare(s: Square, isTarget: boolean): void {
  const x = s.cx - SQUARE_SIZE / 2;
  const y = s.cy - SQUARE_SIZE / 2;
  ctx.fillStyle = isTarget ? 'rgba(253, 224, 71, 0.12)' : 'rgba(244, 236, 216, 0.04)';
  ctx.fillRect(x, y, SQUARE_SIZE, SQUARE_SIZE);

  ctx.lineWidth = isTarget ? 3 : 2;
  ctx.strokeStyle = isTarget ? '#fde047' : '#f4ecd8';
  ctx.strokeRect(x + 1.5, y + 1.5, SQUARE_SIZE - 3, SQUARE_SIZE - 3);

  ctx.fillStyle = isTarget ? '#fde047' : 'rgba(244, 236, 216, 0.85)';
  ctx.font = '700 22px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(s.n), s.cx, s.cy);
}

function drawPlayer(): void {
  ctx.fillStyle = '#38bdf8';
  ctx.beginPath();
  ctx.arc(PLAYER.x, PLAYER.y, 14, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.stroke();
}

function drawAimArrow(): void {
  if (!aiming) return;
  const dx = aimX - PLAYER.x;
  const dy = aimY - PLAYER.y;
  const drag = Math.hypot(dx, dy);
  if (drag < 4) return;
  const clamped = Math.min(drag, MAX_POWER_PX);
  const ux = dx / drag;
  const uy = dy / drag;

  // Arrow pointing OPPOSITE of drag (the throw direction).
  const ax1 = PLAYER.x;
  const ay1 = PLAYER.y;
  const ax2 = PLAYER.x - ux * clamped;
  const ay2 = PLAYER.y - uy * clamped;

  ctx.strokeStyle = '#fb923c';
  ctx.lineWidth = 3;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(ax1, ay1);
  ctx.lineTo(ax2, ay2);
  ctx.stroke();
  ctx.setLineDash([]);

  // arrowhead
  const ang = Math.atan2(-uy, -ux);
  const head = 12;
  ctx.fillStyle = '#fb923c';
  ctx.beginPath();
  ctx.moveTo(ax2, ay2);
  ctx.lineTo(
    ax2 - head * Math.cos(ang - Math.PI / 6),
    ay2 - head * Math.sin(ang - Math.PI / 6),
  );
  ctx.lineTo(
    ax2 - head * Math.cos(ang + Math.PI / 6),
    ay2 - head * Math.sin(ang + Math.PI / 6),
  );
  ctx.closePath();
  ctx.fill();

  // power bar
  const pct = clamped / MAX_POWER_PX;
  const barW = 80;
  const barH = 6;
  const bx = PLAYER.x - barW / 2;
  const by = PLAYER.y + 22;
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.fillRect(bx, by, barW, barH);
  ctx.fillStyle = pct > 0.85 ? '#f87171' : '#fb923c';
  ctx.fillRect(bx, by, barW * pct, barH);
}

function drawStone(): void {
  ctx.fillStyle = '#d6d3d1';
  ctx.beginPath();
  ctx.arc(stoneX, stoneY, STONE_RADIUS, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#57534e';
  ctx.stroke();
}

function drawMissPips(): void {
  for (let i = 0; i < MAX_MISS; i++) {
    const x = 14 + i * 18;
    const y = 14;
    ctx.fillStyle = i < misses ? '#f87171' : 'rgba(244, 236, 216, 0.2)';
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawFeedback(): void {
  if (phase !== 'between' || !lastResult) return;
  const tgt = targetSquare();
  ctx.font = '700 18px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = lastResult === 'hit' ? '#4ade80' : '#f87171';
  ctx.fillText(lastResultText, tgt.cx, tgt.cy - SQUARE_SIZE / 2 - 14);
}

function draw(): void {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#2a241c';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // subtle chalk dust texture lines along bottom
  ctx.strokeStyle = 'rgba(244, 236, 216, 0.06)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 6; i++) {
    const y = 550 + i * 8;
    ctx.beginPath();
    ctx.moveTo(40, y);
    ctx.lineTo(320, y);
    ctx.stroke();
  }

  const tgtN = phase === 'won' || phase === 'gameover' ? -1 : targetSquare().n;
  for (const s of SQUARES) drawSquare(s, s.n === tgtN);

  drawPlayer();
  if (phase === 'aiming') drawAimArrow();
  if (phase === 'flying' || phase === 'between') drawStone();
  drawFeedback();
  drawMissPips();
}

function onOverlayClick(): void {
  if (phase === 'ready') {
    newGame();
  } else if (phase === 'won' || phase === 'gameover') {
    newGame();
  }
}

function fitCanvas(): void {
  draw();
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  roundEl = document.querySelector<HTMLElement>('#round')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlayEl = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);

  restartBtn.addEventListener('click', reset);
  overlayBtn.addEventListener('click', onOverlayClick);

  window.addEventListener('resize', fitCanvas);
  fitCanvas();

  reset();
}

export const game = defineGame({ init, reset });
