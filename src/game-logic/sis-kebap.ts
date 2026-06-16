// Şiş Kebap — flip-timing cooking game.
//
// Four skewers sit horizontally over a glowing coal grill. Each holds 4 cubes
// of meat. The side facing the coals (down) cooks fast; the side facing up
// cooks slowly from radiant heat. Press 1-4 (or click a skewer) to flip a
// skewer 180° — its sides swap. A piece is "cooked" once a side passes the
// done threshold; the skewer auto-serves when all 4 pieces have been cooked
// on both sides. If any side burns past the burn threshold, the skewer is
// ruined. Heat ramps up over the 60-second round.
//
// PITFALLS guarded:
// - module-level-dom-access: every DOM/storage lookup lives in init().
// - unguarded-storage: safeRead/safeWrite wrap localStorage.
// - stale-async-callback: RAF loop gated on a generation token + state.
// - overlay-input-leak: input handlers early-return on state mismatch.
// - missing-overlay-css: per-game CSS defines .overlay--hidden visual.
// - unreachable-start-state: overlay has explicit Start button + Space/Enter.
// - hud-counter-synced-only-at-lifecycle-edges: HUD writes on every mutation.

import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';

const STORAGE_BEST = 'sis-kebap.best';

const CANVAS_W = 480;
const CANVAS_H = 560;

const SKEWER_COUNT = 4;
const PIECES_PER_SKEWER = 4;
const PIECE_SIZE = 56;
const PIECE_GAP = 8;
const SKEWER_ROW_HEIGHT = 96;
const SKEWER_TOP = 36;
const GRILL_TOP = CANVAS_H - 80;

const BASE_DOWN_RATE = 11;
const BASE_UP_RATE = 1.6;
const DONE_MIN = 60;
const DONE_MAX = 150;
const BURN_THRESHOLD = 170;

const ROUND_DURATION = 60;
const REPLACE_DELAY = 0.6;
const FLIP_FLASH = 0.22;
const STATUS_FLASH = 0.9;

type State = 'ready' | 'playing' | 'gameover';

interface Piece {
  sideA: number;
  sideB: number;
  sideACooked: boolean;
  sideBCooked: boolean;
}

interface Skewer {
  pieces: Piece[];
  aDown: boolean;
  rateMul: number;
  flashTime: number;
  offTime: number;
  lastResultBurnt: boolean;
}

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let timeEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayBtn!: HTMLButtonElement;

const gen = createGenToken();

let state: State = 'ready';
let score = 0;
let best = 0;
let timeLeft = ROUND_DURATION;
let lastFrameTime = 0;
let skewers: Skewer[] = [];
let completedCount = 0;
let burntCount = 0;

function newPiece(): Piece {
  return { sideA: 0, sideB: 0, sideACooked: false, sideBCooked: false };
}

function newSkewer(): Skewer {
  const pieces: Piece[] = [];
  for (let i = 0; i < PIECES_PER_SKEWER; i++) pieces.push(newPiece());
  return {
    pieces,
    aDown: true,
    rateMul: 0.85 + Math.random() * 0.4,
    flashTime: 0,
    offTime: -1,
    lastResultBurnt: false,
  };
}

function resetSkewers(): void {
  skewers = [];
  for (let i = 0; i < SKEWER_COUNT; i++) skewers.push(newSkewer());
}

function syncHud(): void {
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
  timeEl.textContent = String(Math.max(0, Math.ceil(timeLeft)));
}

function showStart(title: string, msg: string, btn: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  overlayBtn.textContent = btn;
  showOverlayEl(overlay);
}

function hideStart(): void {
  hideOverlayEl(overlay);
}

function reset(): void {
  gen.bump();
  state = 'ready';
  score = 0;
  timeLeft = ROUND_DURATION;
  completedCount = 0;
  burntCount = 0;
  resetSkewers();
  syncHud();
  showStart(
    'Şiş Kebap',
    '4 şiş, kor ateş üzerinde.\nAlt yüz hızlı pişer, üst yüz radyant ısıyla yavaş.\n\n1-4 tuşları (veya tıkla): ilgili şişi çevir.\nHer iki yüzü pişen şiş servis edilir — +10.\nYakarsan -5. Süre: 60 sn.',
    'Başla',
  );
  draw();
}

function startGame(): void {
  if (state === 'playing') return;
  state = 'playing';
  score = 0;
  timeLeft = ROUND_DURATION;
  completedCount = 0;
  burntCount = 0;
  resetSkewers();
  syncHud();
  hideStart();
  lastFrameTime = performance.now();
  beginLoop();
}

function endGame(): void {
  if (state === 'gameover') return;
  state = 'gameover';
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
  syncHud();
  showStart(
    'Süre doldu',
    `Skor: ${score}\nPişen şiş: ${completedCount} · Yanan: ${burntCount}\n\nR ile yeniden başla.`,
    'Tekrar dene',
  );
}

function beginLoop(): void {
  const myGen = gen.current();
  const tick = (now: number): void => {
    if (!gen.isCurrent(myGen)) return;
    if (state !== 'playing') return;
    const dt = Math.min(0.05, (now - lastFrameTime) / 1000);
    lastFrameTime = now;
    update(dt);
    draw();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function heatMultiplier(): number {
  // Fire heats up over the round: 1.0 at start → 1.7 by the end.
  const elapsed = ROUND_DURATION - timeLeft;
  return 1 + (Math.max(0, elapsed) / ROUND_DURATION) * 0.7;
}

function update(dt: number): void {
  timeLeft -= dt;
  if (timeLeft <= 0) {
    timeLeft = 0;
    syncHud();
    draw();
    endGame();
    return;
  }
  timeEl.textContent = String(Math.ceil(timeLeft));

  const heat = heatMultiplier();

  for (const s of skewers) {
    if (s.offTime >= 0) {
      s.offTime += dt;
      if (s.offTime >= REPLACE_DELAY) {
        const fresh = newSkewer();
        s.pieces = fresh.pieces;
        s.aDown = fresh.aDown;
        s.rateMul = fresh.rateMul;
        s.flashTime = 0;
        s.offTime = -1;
        s.lastResultBurnt = false;
      }
      continue;
    }

    if (s.flashTime > 0) s.flashTime = Math.max(0, s.flashTime - dt);

    const dRate = BASE_DOWN_RATE * s.rateMul * heat;
    const uRate = BASE_UP_RATE * s.rateMul * heat;

    let anyBurnt = false;
    let allCooked = true;
    for (const p of s.pieces) {
      if (s.aDown) {
        p.sideA += dRate * dt;
        p.sideB += uRate * dt;
      } else {
        p.sideB += dRate * dt;
        p.sideA += uRate * dt;
      }
      if (p.sideA >= DONE_MIN) p.sideACooked = true;
      if (p.sideB >= DONE_MIN) p.sideBCooked = true;
      if (p.sideA >= BURN_THRESHOLD || p.sideB >= BURN_THRESHOLD) {
        anyBurnt = true;
      }
      if (!(p.sideACooked && p.sideBCooked)) allCooked = false;
    }

    if (anyBurnt) {
      s.offTime = 0;
      s.lastResultBurnt = true;
      burntCount++;
      score = Math.max(0, score - 5);
      syncHud();
    } else if (allCooked) {
      s.offTime = 0;
      s.lastResultBurnt = false;
      completedCount++;
      score += 10;
      syncHud();
    }
  }
}

function flipSkewer(idx: number): void {
  if (state !== 'playing') return;
  if (idx < 0 || idx >= SKEWER_COUNT) return;
  const s = skewers[idx]!;
  if (s.offTime >= 0) return;
  s.aDown = !s.aDown;
  s.flashTime = FLIP_FLASH;
}

function pieceColor(side: number): string {
  const PINK = [255, 141, 161];
  const SEAR = [217, 119, 87];
  const GOLDEN = [139, 90, 43];
  const DARK = [92, 54, 23];
  const CHAR = [40, 20, 12];
  const BURNT = [14, 8, 7];
  if (side <= 0) return rgb(PINK);
  if (side >= BURN_THRESHOLD) return rgb(BURNT);
  if (side >= DONE_MAX) {
    const t = clamp01((side - DONE_MAX) / (BURN_THRESHOLD - DONE_MAX));
    return rgb(lerp(DARK, CHAR, t));
  }
  if (side >= DONE_MIN) {
    const t = (side - DONE_MIN) / (DONE_MAX - DONE_MIN);
    return rgb(lerp(GOLDEN, DARK, t));
  }
  const t = side / DONE_MIN;
  if (t < 0.5) return rgb(lerp(PINK, SEAR, t / 0.5));
  return rgb(lerp(SEAR, GOLDEN, (t - 0.5) / 0.5));
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function lerp(a: number[], b: number[], t: number): number[] {
  return [
    Math.round(a[0]! + (b[0]! - a[0]!) * t),
    Math.round(a[1]! + (b[1]! - a[1]!) * t),
    Math.round(a[2]! + (b[2]! - a[2]!) * t),
  ];
}
function rgb(c: number[]): string {
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

function skewerY(idx: number): number {
  return SKEWER_TOP + idx * SKEWER_ROW_HEIGHT;
}

function skewerStartX(): number {
  const skewerW = PIECES_PER_SKEWER * (PIECE_SIZE + PIECE_GAP) - PIECE_GAP;
  return (CANVAS_W - skewerW) / 2;
}

function draw(): void {
  ctx.fillStyle = '#0a0608';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  drawGrill();
  for (let i = 0; i < SKEWER_COUNT; i++) drawSkewer(i);
  drawHeatIndicator();
}

function drawGrill(): void {
  const grad = ctx.createLinearGradient(0, GRILL_TOP, 0, CANVAS_H);
  grad.addColorStop(0, '#3a1a08');
  grad.addColorStop(0.4, '#22100a');
  grad.addColorStop(1, '#100706');
  ctx.fillStyle = grad;
  ctx.fillRect(0, GRILL_TOP, CANVAS_W, CANVAS_H - GRILL_TOP);

  const t = performance.now() / 600;
  for (let i = 0; i < 42; i++) {
    const x = ((i * 53) % CANVAS_W) + 6;
    const yJitter = (i * 17) % 30;
    const y = GRILL_TOP + 12 + yJitter;
    const phase = i * 0.41;
    const pulse = 0.55 + 0.45 * Math.sin(t * 1.7 + phase);
    const r = 3 + pulse * 2.2;
    ctx.fillStyle = `rgba(255, ${Math.floor(110 + pulse * 90)}, 20, ${0.32 + pulse * 0.42})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.fillStyle = 'rgba(255, 110, 20, 0.06)';
  ctx.fillRect(0, GRILL_TOP - 24, CANVAS_W, 24);
}

function drawHeatIndicator(): void {
  const heat = heatMultiplier();
  const t = (heat - 1) / 0.7;
  const w = 90;
  const h = 6;
  const x = CANVAS_W - w - 14;
  const y = CANVAS_H - 14;
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.fillRect(x, y - h, w, h);
  ctx.fillStyle = `rgb(255, ${Math.floor(160 - t * 100)}, ${Math.floor(40 - t * 30)})`;
  ctx.fillRect(x, y - h, w * clamp01(t), h);
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.font = '9px ui-sans-serif, system-ui';
  ctx.textAlign = 'right';
  ctx.fillText('ATEŞ', x - 6, y - 1);
  ctx.textAlign = 'left';
}

function drawSkewer(idx: number): void {
  const s = skewers[idx]!;
  const y = skewerY(idx);
  const startX = skewerStartX();
  const skewerW = PIECES_PER_SKEWER * (PIECE_SIZE + PIECE_GAP) - PIECE_GAP;
  const midY = y + PIECE_SIZE / 2;

  const badgeColor = s.flashTime > 0 ? '#fde68a' : '#94a3b8';
  ctx.fillStyle = 'rgba(148, 163, 184, 0.10)';
  ctx.beginPath();
  ctx.arc(22, midY, 14, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = badgeColor;
  ctx.font = 'bold 16px ui-sans-serif, system-ui';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(idx + 1), 22, midY + 1);

  ctx.strokeStyle = '#9ca3af';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(startX - 22, midY);
  ctx.lineTo(startX + skewerW + 22, midY);
  ctx.stroke();
  ctx.fillStyle = '#9ca3af';
  ctx.beginPath();
  ctx.moveTo(startX - 30, midY);
  ctx.lineTo(startX - 22, midY - 3);
  ctx.lineTo(startX - 22, midY + 3);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#6b3a1a';
  ctx.fillRect(startX + skewerW + 22, midY - 5, 18, 10);
  ctx.fillStyle = '#4a2710';
  ctx.fillRect(startX + skewerW + 22, midY - 5, 18, 2);

  if (s.offTime >= 0) {
    if (s.offTime < STATUS_FLASH) {
      const label = s.lastResultBurnt ? '✗  YANDI  -5' : '✓  PİŞTİ  +10';
      ctx.fillStyle = s.lastResultBurnt ? '#f87171' : '#4ade80';
      ctx.font = 'bold 16px ui-sans-serif, system-ui';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, CANVAS_W / 2, midY);
    } else {
      ctx.fillStyle = 'rgba(148, 163, 184, 0.32)';
      ctx.font = '12px ui-sans-serif, system-ui';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('yeni şiş…', CANVAS_W / 2, midY);
    }
    return;
  }

  if (s.flashTime > 0) {
    const alpha = 0.45 * (s.flashTime / FLIP_FLASH);
    ctx.fillStyle = `rgba(253, 230, 138, ${alpha.toFixed(3)})`;
    ctx.fillRect(startX - 6, y - 6, skewerW + 12, PIECE_SIZE + 12);
  }

  for (let i = 0; i < PIECES_PER_SKEWER; i++) {
    const p = s.pieces[i]!;
    const px = startX + i * (PIECE_SIZE + PIECE_GAP);
    drawPiece(px, y, p, s.aDown);
  }

  const arrowY = y + PIECE_SIZE + 6;
  ctx.fillStyle = 'rgba(251, 146, 60, 0.85)';
  ctx.font = '12px ui-sans-serif, system-ui';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const arrowLabel = s.aDown ? 'A alta ↓' : 'B alta ↓';
  ctx.fillText(arrowLabel, CANVAS_W / 2, arrowY);
}

function drawPiece(x: number, y: number, p: Piece, aDown: boolean): void {
  const topSide = aDown ? p.sideB : p.sideA;
  const bottomSide = aDown ? p.sideA : p.sideB;

  ctx.fillStyle = pieceColor(topSide);
  ctx.fillRect(x, y, PIECE_SIZE, PIECE_SIZE / 2);
  ctx.fillStyle = pieceColor(bottomSide);
  ctx.fillRect(x, y + PIECE_SIZE / 2, PIECE_SIZE, PIECE_SIZE / 2);

  drawCharMarks(x, y, PIECE_SIZE / 2, topSide, true);
  drawCharMarks(x, y + PIECE_SIZE / 2, PIECE_SIZE / 2, bottomSide, false);

  ctx.fillStyle = '#000';
  ctx.fillRect(x, y + PIECE_SIZE / 2 - 1, PIECE_SIZE, 2);

  ctx.strokeStyle = '#0a0608';
  ctx.lineWidth = 2;
  ctx.strokeRect(x + 0.5, y + 0.5, PIECE_SIZE - 1, PIECE_SIZE - 1);

  const cookedOnBoth = p.sideACooked && p.sideBCooked;
  const nearBurn = p.sideA >= DONE_MAX || p.sideB >= DONE_MAX;
  if (cookedOnBoth) {
    ctx.strokeStyle = '#4ade80';
    ctx.lineWidth = 2.5;
    ctx.strokeRect(x + 2, y + 2, PIECE_SIZE - 4, PIECE_SIZE - 4);
  } else if (nearBurn) {
    ctx.strokeStyle = '#f97316';
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 2, y + 2, PIECE_SIZE - 4, PIECE_SIZE - 4);
  }
}

function drawCharMarks(x: number, y: number, h: number, side: number, topHalf: boolean): void {
  if (side < DONE_MIN * 0.6) return;
  const intensity = clamp01((side - DONE_MIN * 0.6) / (DONE_MAX - DONE_MIN * 0.6));
  const count = Math.floor(2 + intensity * 4);
  ctx.fillStyle = `rgba(20, 8, 4, ${0.18 + intensity * 0.42})`;
  const seed = topHalf ? 17 : 31;
  for (let i = 0; i < count; i++) {
    const sx = x + 6 + ((i * seed * 7) % (PIECE_SIZE - 12));
    const sy = y + 5 + ((i * seed * 11) % (h - 10));
    const r = 1.4 + ((i * 3) % 3) * 0.5;
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function onKeyDown(e: KeyboardEvent): void {
  const k = e.key;
  const low = k.toLowerCase();
  if (low === 'r') {
    reset();
    e.preventDefault();
    return;
  }
  if (state === 'ready' || state === 'gameover') {
    if (k === ' ' || k === 'Enter') {
      if (state === 'gameover') reset();
      startGame();
      e.preventDefault();
      return;
    }
    return;
  }
  if (k >= '1' && k <= '4') {
    const idx = parseInt(k, 10) - 1;
    flipSkewer(idx);
    e.preventDefault();
  }
}

function canvasYFromEvent(clientY: number): number {
  const rect = canvas.getBoundingClientRect();
  const scale = CANVAS_H / rect.height;
  return (clientY - rect.top) * scale;
}

function onPointerDown(e: PointerEvent): void {
  if (state !== 'playing') return;
  const y = canvasYFromEvent(e.clientY);
  for (let i = 0; i < SKEWER_COUNT; i++) {
    const top = skewerY(i);
    if (y >= top - 6 && y <= top + PIECE_SIZE + 6) {
      flipSkewer(i);
      e.preventDefault();
      return;
    }
  }
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  timeEl = document.querySelector<HTMLElement>('#time')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  window.addEventListener('keydown', onKeyDown);
  canvas.addEventListener('pointerdown', onPointerDown);
  restartBtn.addEventListener('click', () => reset());
  overlayBtn.addEventListener('click', () => {
    if (state === 'gameover') reset();
    startGame();
  });

  reset();
}

export const game = defineGame({ init, reset });
