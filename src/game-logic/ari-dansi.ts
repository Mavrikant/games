import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import {
  showOverlay as showOverlayEl,
  hideOverlay as hideOverlayEl,
} from '@shared/overlay';

const STORAGE_BEST = 'ari-dansi.best';

type Phase = 'ready' | 'observe' | 'guess' | 'reveal' | 'gameover';

const CANVAS_W = 480;
const CANVAS_H = 600;
const TOTAL_ROUNDS = 5;

const COMB_CX = CANVAS_W / 2;
const COMB_CY = CANVAS_H / 2;
const COMB_R = 220;

const FIELD_TOP = 60;
const FIELD_BOTTOM = CANVAS_H - 20;
const FIELD_LEFT = 20;
const FIELD_RIGHT = CANVAS_W - 20;
const FIELD_W = FIELD_RIGHT - FIELD_LEFT;
const FIELD_H = FIELD_BOTTOM - FIELD_TOP;
const HIVE_X = CANVAS_W / 2;
const HIVE_Y = FIELD_BOTTOM - 28;

const DIST_MIN = 90;
const DIST_MAX = 260;

const WAGGLE_LEN_MIN = 50;
const WAGGLE_LEN_MAX = 150;

const WAGGLE_DURATION_MS = 1000;
const LOOP_DURATION_MS = 700;
const DANCE_LOOPS = 2;

const gen = createGenToken();

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let roundEl!: HTMLElement;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let phaseTag!: HTMLElement;

let phase: Phase = 'ready';
let round = 0;
let score = 0;
let best = 0;

let targetAngle = 0;
let targetDist = 0;
let waggleLen = 0;
let guessX = 0;
let guessY = 0;
let roundPoints = 0;
let danceStartMs = 0;
let revealStartMs = 0;
let lastFrameTime = 0;
let rafId = 0;

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

function setPhaseTag(text: string, visible: boolean): void {
  phaseTag.textContent = text;
  phaseTag.style.display = visible ? '' : 'none';
}

function loadBest(): number {
  const v = safeRead<number>(STORAGE_BEST, 0);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

function commitBest(): void {
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
}

function updateHud(): void {
  roundEl.textContent = `${Math.min(round + 1, TOTAL_ROUNDS)}/${TOTAL_ROUNDS}`;
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
}

function angleToFieldPoint(angle: number, dist: number): { x: number; y: number } {
  // angle: 0 = up (toward sun), clockwise positive.
  // Convert to canvas coords from hive.
  const rad = angle - Math.PI / 2;
  return {
    x: HIVE_X + Math.cos(rad) * dist,
    y: HIVE_Y + Math.sin(rad) * dist,
  };
}

function fieldPointToHiveOffset(x: number, y: number): { angle: number; dist: number } {
  const dx = x - HIVE_X;
  const dy = y - HIVE_Y;
  const dist = Math.hypot(dx, dy);
  const angle = Math.atan2(dy, dx) + Math.PI / 2;
  return { angle, dist };
}

function clampToField(x: number, y: number): { x: number; y: number } {
  return {
    x: Math.max(FIELD_LEFT + 4, Math.min(FIELD_RIGHT - 4, x)),
    y: Math.max(FIELD_TOP + 4, Math.min(FIELD_BOTTOM - 4, y)),
  };
}

function pickRound(): void {
  // Pick angle (in radians), clockwise from "up".
  // Bias away from the very bottom (angle ~ π) so the flower stays in field.
  // Range: [-2.3, 2.3] (roughly ±130 degrees from up).
  targetAngle = (Math.random() * 2 - 1) * 2.3;
  targetDist = DIST_MIN + Math.random() * (DIST_MAX - DIST_MIN);
  // Make sure the flower lands inside the field box.
  let p = angleToFieldPoint(targetAngle, targetDist);
  let safety = 12;
  while (
    safety-- > 0 &&
    (p.x < FIELD_LEFT + 20 ||
      p.x > FIELD_RIGHT - 20 ||
      p.y < FIELD_TOP + 30 ||
      p.y > FIELD_BOTTOM - 60)
  ) {
    targetAngle = (Math.random() * 2 - 1) * 2.0;
    targetDist = DIST_MIN + Math.random() * (DIST_MAX - DIST_MIN);
    p = angleToFieldPoint(targetAngle, targetDist);
  }
  // Map dist linearly to waggle length so the player can decode it.
  const t = (targetDist - DIST_MIN) / (DIST_MAX - DIST_MIN);
  waggleLen = WAGGLE_LEN_MIN + t * (WAGGLE_LEN_MAX - WAGGLE_LEN_MIN);
}

function drawCombBackground(): void {
  ctx.fillStyle = getCss('--ari-comb') || '#f5b942';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  ctx.strokeStyle = getCss('--ari-comb-edge') || '#b67d1a';
  ctx.lineWidth = 1.2;
  const r = 22;
  const dx = r * Math.sqrt(3);
  const dy = r * 1.5;
  for (let row = -1; row * dy < CANVAS_H + r; row++) {
    for (let col = -1; col * dx < CANVAS_W + r; col++) {
      const cx = col * dx + (row % 2 === 0 ? 0 : dx / 2);
      const cy = row * dy;
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i + Math.PI / 6;
        const px = cx + Math.cos(a) * r;
        const py = cy + Math.sin(a) * r;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.stroke();
    }
  }
  // "Up" indicator showing sun direction on the comb.
  ctx.fillStyle = getCss('--ari-sun') || '#ffd24a';
  ctx.strokeStyle = '#7a4d00';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(COMB_CX, 36, 14, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  for (let i = 0; i < 8; i++) {
    const a = (Math.PI * 2 * i) / 8;
    const x1 = COMB_CX + Math.cos(a) * 18;
    const y1 = 36 + Math.sin(a) * 18;
    const x2 = COMB_CX + Math.cos(a) * 24;
    const y2 = 36 + Math.sin(a) * 24;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
  ctx.fillStyle = '#2a1a00';
  ctx.font = '600 12px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('güneş', COMB_CX, 64);
  ctx.textAlign = 'left';
}

function drawBee(x: number, y: number, headingRad: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(headingRad);
  // wings
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.beginPath();
  ctx.ellipse(-2, -8, 8, 4, -0.3, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(-2, 8, 8, 4, 0.3, 0, Math.PI * 2);
  ctx.fill();
  // body
  ctx.fillStyle = getCss('--ari-bee-stripe') || '#ffd24a';
  ctx.beginPath();
  ctx.ellipse(0, 0, 14, 7, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = getCss('--ari-bee') || '#1f1f1f';
  for (let i = -1; i <= 1; i++) {
    ctx.fillRect(i * 5 - 1.5, -7, 3, 14);
  }
  ctx.beginPath();
  ctx.arc(9, 0, 5, 0, Math.PI * 2);
  ctx.fill();
  // eye dot
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(11, -1.5, 1.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// Compute bee position along the figure-8 path at progress p in [0, 1).
// Phases inside one full loop:
//   0      .. tWaggle      : straight waggle run, center -> tip, with wiggle
//   tWaggle .. tWaggle+tArc1: arc back to center along the right loop
//   ... +tWaggle           : straight waggle run again (same direction)
//                            -> we draw waggle twice per "loop" for figure-8.
// We split a full figure-8 loop into 4 phases:
//   A: waggle run (center -> tip)
//   B: loop right back to center
//   C: waggle run (center -> tip)
//   D: loop left back to center
function beePositionAtProgress(p: number): {
  x: number;
  y: number;
  heading: number;
  inWaggle: boolean;
} {
  // p in [0, 1] for one full figure-8 loop.
  const W = 0.32; // waggle fraction (each waggle pass)
  const L = 0.18; // arc fraction (each side loop)
  // Phase ranges: [0,W) waggleA, [W,W+L) arcRight, [W+L, 2W+L) waggleB, [2W+L, 1) arcLeft
  const dirX = Math.cos(targetAngle - Math.PI / 2);
  const dirY = Math.sin(targetAngle - Math.PI / 2);
  const perpX = -dirY;
  const perpY = dirX;
  const baseX = COMB_CX;
  const baseY = COMB_CY;

  // Wiggle amplitude perpendicular to direction.
  const wiggleAmp = 5;
  const wiggleFreq = 14;

  if (p < W) {
    const t = p / W;
    const along = t * waggleLen;
    const wiggle = Math.sin(t * wiggleFreq) * wiggleAmp;
    return {
      x: baseX + dirX * along + perpX * wiggle,
      y: baseY + dirY * along + perpY * wiggle,
      heading: targetAngle - Math.PI / 2,
      inWaggle: true,
    };
  }
  if (p < W + L) {
    // Arc to the right: from tip back to center, semi-circle on +perp side.
    const t = (p - W) / L;
    const tipX = baseX + dirX * waggleLen;
    const tipY = baseY + dirY * waggleLen;
    // Center of the arc is midpoint between tip and base, offset on +perp.
    const midX = (tipX + baseX) / 2;
    const midY = (tipY + baseY) / 2;
    const arcCx = midX + perpX * (waggleLen * 0.45);
    const arcCy = midY + perpY * (waggleLen * 0.45);
    const arcR = Math.hypot(tipX - arcCx, tipY - arcCy);
    // start angle from arc center to tip, end angle to base.
    const a0 = Math.atan2(tipY - arcCy, tipX - arcCx);
    const a1 = Math.atan2(baseY - arcCy, baseX - arcCx);
    // ensure we go the long way (semi-loop)
    let aDelta = a1 - a0;
    while (aDelta < 0) aDelta += Math.PI * 2;
    const a = a0 + aDelta * t;
    const x = arcCx + Math.cos(a) * arcR;
    const y = arcCy + Math.sin(a) * arcR;
    const heading = a + Math.PI / 2;
    return { x, y, heading, inWaggle: false };
  }
  if (p < 2 * W + L) {
    const t = (p - (W + L)) / W;
    const along = t * waggleLen;
    const wiggle = Math.sin(t * wiggleFreq) * wiggleAmp;
    return {
      x: baseX + dirX * along + perpX * wiggle,
      y: baseY + dirY * along + perpY * wiggle,
      heading: targetAngle - Math.PI / 2,
      inWaggle: true,
    };
  }
  // arc to the left
  const t = (p - (2 * W + L)) / L;
  const tipX = baseX + dirX * waggleLen;
  const tipY = baseY + dirY * waggleLen;
  const midX = (tipX + baseX) / 2;
  const midY = (tipY + baseY) / 2;
  const arcCx = midX - perpX * (waggleLen * 0.45);
  const arcCy = midY - perpY * (waggleLen * 0.45);
  const arcR = Math.hypot(tipX - arcCx, tipY - arcCy);
  const a0 = Math.atan2(tipY - arcCy, tipX - arcCx);
  const a1 = Math.atan2(baseY - arcCy, baseX - arcCx);
  let aDelta = a1 - a0;
  while (aDelta > 0) aDelta -= Math.PI * 2;
  const a = a0 + aDelta * t;
  const x = arcCx + Math.cos(a) * arcR;
  const y = arcCy + Math.sin(a) * arcR;
  const heading = a + Math.PI / 2;
  return { x, y, heading, inWaggle: false };
}

function drawObservePhase(elapsedMs: number): void {
  drawCombBackground();
  const loopMs = WAGGLE_DURATION_MS + LOOP_DURATION_MS;
  const totalMs = loopMs * DANCE_LOOPS;
  const t = Math.min(elapsedMs / totalMs, 0.9999);
  const localP = (t * DANCE_LOOPS) % 1;

  // Draw faint dance path (figure-8) for clarity.
  const dirX = Math.cos(targetAngle - Math.PI / 2);
  const dirY = Math.sin(targetAngle - Math.PI / 2);
  const tipX = COMB_CX + dirX * waggleLen;
  const tipY = COMB_CY + dirY * waggleLen;
  ctx.strokeStyle = 'rgba(70, 40, 0, 0.35)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(COMB_CX, COMB_CY);
  ctx.lineTo(tipX, tipY);
  ctx.stroke();

  // Hive center indicator.
  ctx.fillStyle = 'rgba(80, 50, 0, 0.5)';
  ctx.beginPath();
  ctx.arc(COMB_CX, COMB_CY, 4, 0, Math.PI * 2);
  ctx.fill();

  const beePos = beePositionAtProgress(localP);
  drawBee(beePos.x, beePos.y, beePos.heading);

  // Helper text under bee
  ctx.fillStyle = '#2a1a00';
  ctx.font = '600 13px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  const remain = Math.max(0, Math.ceil((totalMs - elapsedMs) / 1000));
  ctx.fillText(`İzle: ${remain}s`, COMB_CX, CANVAS_H - 22);
  ctx.textAlign = 'left';
}

function drawFieldBackground(): void {
  ctx.fillStyle = getCss('--ari-field') || '#b6e2a1';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  // top sky band
  const grad = ctx.createLinearGradient(0, 0, 0, FIELD_TOP);
  grad.addColorStop(0, '#9ec9f5');
  grad.addColorStop(1, '#cfe6f8');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, CANVAS_W, FIELD_TOP);
  // sun
  ctx.fillStyle = getCss('--ari-sun') || '#ffd24a';
  ctx.beginPath();
  ctx.arc(CANVAS_W / 2, 22, 16, 0, Math.PI * 2);
  ctx.fill();
  for (let i = 0; i < 8; i++) {
    const a = (Math.PI * 2 * i) / 8;
    ctx.strokeStyle = '#e0a800';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(CANVAS_W / 2 + Math.cos(a) * 20, 22 + Math.sin(a) * 20);
    ctx.lineTo(CANVAS_W / 2 + Math.cos(a) * 28, 22 + Math.sin(a) * 28);
    ctx.stroke();
  }
  // hint label
  ctx.fillStyle = '#2a1a00';
  ctx.font = '600 12px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('güneş', CANVAS_W / 2, 56);
  ctx.textAlign = 'left';

  // hive box at bottom
  ctx.fillStyle = '#9c6b2a';
  ctx.strokeStyle = '#5a3e18';
  ctx.lineWidth = 2;
  ctx.fillRect(HIVE_X - 22, HIVE_Y - 12, 44, 32);
  ctx.strokeRect(HIVE_X - 22, HIVE_Y - 12, 44, 32);
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    ctx.moveTo(HIVE_X - 22, HIVE_Y - 12 + 8 + i * 8);
    ctx.lineTo(HIVE_X + 22, HIVE_Y - 12 + 8 + i * 8);
    ctx.stroke();
  }
  ctx.fillStyle = '#2a1a00';
  ctx.beginPath();
  ctx.arc(HIVE_X, HIVE_Y + 8, 4, 0, Math.PI * 2);
  ctx.fill();
}

function drawFlower(x: number, y: number, alpha = 1): void {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = getCss('--ari-flower') || '#f06292';
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI * 2 * i) / 6;
    ctx.beginPath();
    ctx.ellipse(x + Math.cos(a) * 6, y + Math.sin(a) * 6, 6, 4, a, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = getCss('--ari-flower-center') || '#fff7c2';
  ctx.beginPath();
  ctx.arc(x, y, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawGuessMark(x: number, y: number): void {
  ctx.strokeStyle = getCss('--ari-guess') || '#4dd0e1';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(x, y, 10, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x - 14, y);
  ctx.lineTo(x + 14, y);
  ctx.moveTo(x, y - 14);
  ctx.lineTo(x, y + 14);
  ctx.stroke();
}

function drawGuessPhase(): void {
  drawFieldBackground();
  ctx.fillStyle = '#1f3a14';
  ctx.font = '600 13px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Çiçeğin tahmini yerine tıkla', CANVAS_W / 2, FIELD_TOP + 18);
  ctx.textAlign = 'left';
}

function drawRevealPhase(): void {
  drawFieldBackground();
  const target = angleToFieldPoint(targetAngle, targetDist);
  // Line from hive to actual flower (through guess if any).
  ctx.strokeStyle = 'rgba(60, 90, 40, 0.55)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(HIVE_X, HIVE_Y);
  ctx.lineTo(target.x, target.y);
  ctx.stroke();
  ctx.setLineDash([]);
  drawFlower(target.x, target.y, 1);
  drawGuessMark(guessX, guessY);
  ctx.fillStyle = '#1f3a14';
  ctx.font = '700 16px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`+${roundPoints} puan`, CANVAS_W / 2, FIELD_TOP + 22);
  ctx.textAlign = 'left';
}

function scorePoints(errPx: number): number {
  // Maximum reasonable error: across the field (~ hypot of field dims).
  const maxErr = Math.hypot(FIELD_W, FIELD_H);
  const t = Math.max(0, 1 - errPx / (maxErr * 0.4));
  return Math.round(100 * t);
}

function loop(myGen: number, nowMs: number): void {
  if (!gen.isCurrent(myGen)) return;
  if (phase === 'ready' || phase === 'gameover') return;
  const dt = nowMs - lastFrameTime;
  lastFrameTime = nowMs;
  if (phase === 'observe') {
    const elapsed = nowMs - danceStartMs;
    const total = (WAGGLE_DURATION_MS + LOOP_DURATION_MS) * DANCE_LOOPS;
    drawObservePhase(elapsed);
    if (elapsed >= total) {
      enterGuessPhase();
    }
  } else if (phase === 'guess') {
    drawGuessPhase();
  } else if (phase === 'reveal') {
    drawRevealPhase();
    if (nowMs - revealStartMs > 1400) {
      nextRound();
      return;
    }
  }
  // Reference dt so TS strict doesn't flag unused warning.
  void dt;
  rafId = requestAnimationFrame((t) => loop(myGen, t));
}

function startLoop(): void {
  cancelAnimationFrame(rafId);
  lastFrameTime = performance.now();
  const myGen = gen.current();
  rafId = requestAnimationFrame((t) => loop(myGen, t));
}

function enterObservePhase(): void {
  phase = 'observe';
  setPhaseTag('İzle', true);
  danceStartMs = performance.now();
  startLoop();
}

function enterGuessPhase(): void {
  phase = 'guess';
  setPhaseTag('Tahmin et', true);
  drawGuessPhase();
}

function enterRevealPhase(): void {
  phase = 'reveal';
  setPhaseTag('Sonuç', true);
  revealStartMs = performance.now();
  startLoop();
}

function nextRound(): void {
  round += 1;
  updateHud();
  if (round >= TOTAL_ROUNDS) {
    finishGame();
    return;
  }
  pickRound();
  enterObservePhase();
}

function finishGame(): void {
  phase = 'gameover';
  setPhaseTag('Bitti', false);
  commitBest();
  updateHud();
  const isNewBest = score >= best && score > 0;
  const summary = isNewBest
    ? `Toplam: ${score} puan (yeni rekor!)`
    : `Toplam: ${score} puan`;
  showOverlay(
    'Tur bitti',
    `${summary}\nTekrar oynamak için tıkla veya boşluk.`,
  );
}

function startNewGame(): void {
  gen.bump();
  phase = 'ready';
  round = 0;
  score = 0;
  roundPoints = 0;
  updateHud();
  pickRound();
  hideOverlay();
  enterObservePhase();
}

function reset(): void {
  gen.bump();
  cancelAnimationFrame(rafId);
  commitBest();
  phase = 'ready';
  round = 0;
  score = 0;
  roundPoints = 0;
  updateHud();
  setPhaseTag('Hazır', false);
  // Clear canvas to neutral state.
  ctx.fillStyle = getCss('--ari-comb') || '#f5b942';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  showOverlay(
    'Arı Dansı',
    'Arı petekteki figure-8 dansı ile çiçeğin yerini söylüyor.\nDüz koşunun açısı yönü, uzunluğu uzaklığı kodluyor.\nDansı izle, sonra tarlada çiçeği işaretle.\nBaşlamak için tıkla veya boşluk.',
  );
}

function handleClickAt(cx: number, cy: number): void {
  if (phase !== 'guess') return;
  const clamped = clampToField(cx, cy);
  guessX = clamped.x;
  guessY = clamped.y;
  const target = angleToFieldPoint(targetAngle, targetDist);
  const err = Math.hypot(guessX - target.x, guessY - target.y);
  roundPoints = scorePoints(err);
  score += roundPoints;
  updateHud();
  enterRevealPhase();
}

function canvasPointFromEvent(e: PointerEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const scaleX = CANVAS_W / rect.width;
  const scaleY = CANVAS_H / rect.height;
  return {
    x: (e.clientX - rect.left) * scaleX,
    y: (e.clientY - rect.top) * scaleY,
  };
}

function onPointerDownCanvas(e: PointerEvent): void {
  if (phase === 'guess') {
    e.preventDefault();
    const p = canvasPointFromEvent(e);
    handleClickAt(p.x, p.y);
  }
}

function onOverlayClick(): void {
  if (phase === 'ready' || phase === 'gameover') {
    startNewGame();
  }
}

function onKey(e: KeyboardEvent): void {
  if (e.key === ' ' || e.code === 'Space') {
    if (phase === 'ready' || phase === 'gameover') {
      e.preventDefault();
      startNewGame();
    }
  } else if (e.key === 'r' || e.key === 'R') {
    e.preventDefault();
    reset();
  }
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  roundEl = document.querySelector<HTMLElement>('#round')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  phaseTag = document.querySelector<HTMLElement>('#phase')!;

  best = loadBest();
  updateHud();
  setPhaseTag('Hazır', false);

  restartBtn.addEventListener('click', () => reset());
  canvas.addEventListener('pointerdown', onPointerDownCanvas);
  overlay.addEventListener('pointerdown', onOverlayClick);
  window.addEventListener('keydown', onKey);

  ctx.fillStyle = getCss('--ari-comb') || '#f5b942';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
}

export const game = defineGame({ init, reset });
