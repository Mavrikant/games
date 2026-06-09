// ---------------------------------------------------------------------------
// Berber — precision hair-cutting puzzle.
// State machine: ready | playing | review | gameover
// Mechanic: drag mouse/finger to draw a scissor line. Every strand the line
// crosses is cut at that intersection's Y (only shortens, never lengthens).
// Tap (no drag) cuts the single nearest strand. 8 cuts per customer, 5
// customers per round. Score = how close the final hair matches the target.
// Pitfalls addressed:
//   - unguarded-storage: safeRead / safeWrite
//   - module-level-dom-access: all DOM/storage in init()
//   - overlay-input-leak: explicit state enum guards every input handler
//   - stale-async-callback: gen.bump() in resetToReady cancels review timer
//   - invisible-boot: first draw happens immediately in resetToReady()
//   - visual-vs-hitbox: strands have a single `length` field used by both
//     draw() and cut() — no separate hit rect
//   - missing-overlay-css: berber.css defines .overlay--hidden visuals
//   - duplicate-with-shared-layer: controls hint rendered by layout from JSON
// ---------------------------------------------------------------------------

import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import {
  showOverlay as showOverlayEl,
  hideOverlay as hideOverlayEl,
} from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';

type State = 'ready' | 'playing' | 'review' | 'gameover';

interface FallingPiece {
  x: number;
  y: number;
  vy: number;
  length: number;
  color: string;
  age: number;
}

interface Customer {
  name: string;
  target: number[]; // per-strand target length (px)
}

// ── Geometry constants ──
const W = 480;
const H = 420;
const STRAND_COUNT = 24;
const STRAND_X0 = 100;
const STRAND_X1 = 380;
const STRAND_SPACING = (STRAND_X1 - STRAND_X0) / (STRAND_COUNT - 1);
const ATTACH_Y = 110;
const STRAND_INITIAL_LEN = 220;
const TAP_THRESHOLD_PX = 6;
const TAP_PICK_RADIUS = 18;

// ── Scoring ──
const CUTS_PER_CUSTOMER = 8;
const CUSTOMER_COUNT = 5;
const ERROR_FULL_PENALTY = 120; // px error at which quality = 0

const STORAGE_KEY = 'berber.best';

// ── Hair colors (cycled across customers for variety) ──
const HAIR_COLORS = ['#3b2410', '#5b3a16', '#2a1b08', '#6b4423', '#1a1208'];

// ── Customer hairstyle generators ──
function makeCustomers(): Customer[] {
  const list: Customer[] = [];
  // 1. Buzz cut — uniform short
  list.push({
    name: 'Asker Kesim',
    target: Array(STRAND_COUNT).fill(24),
  });
  // 2. Klasik düz — uniform medium
  list.push({
    name: 'Klasik Düz',
    target: Array(STRAND_COUNT).fill(70),
  });
  // 3. V kesim — sides short, middle long (V pointing down)
  list.push({
    name: 'V Kesim',
    target: Array.from({ length: STRAND_COUNT }, (_, i) => {
      const center = (STRAND_COUNT - 1) / 2;
      const dist = Math.abs(i - center);
      return Math.round(140 - dist * 9); // 140 at center → ~36 at edges
    }),
  });
  // 4. Mohawk — middle long, sides very short
  list.push({
    name: 'Mohavk',
    target: Array.from({ length: STRAND_COUNT }, (_, i) => {
      const center = (STRAND_COUNT - 1) / 2;
      const dist = Math.abs(i - center);
      return dist < 3 ? 150 : dist < 5 ? 80 : 20;
    }),
  });
  // 5. Merdiven (staircase) — 4 sections of 6 strands each
  list.push({
    name: 'Merdiven',
    target: Array.from({ length: STRAND_COUNT }, (_, i) => {
      const step = Math.floor(i / 6);
      return [40, 80, 120, 160][step]!;
    }),
  });
  return list;
}

// ── DOM refs ──
let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let customerEl!: HTMLElement;
let cutsEl!: HTMLElement;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let submitBtn!: HTMLButtonElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayBtn!: HTMLButtonElement;

// ── State ──
let state: State = 'ready';
let customers: Customer[] = [];
let customerIdx = 0;
let strandLens: number[] = []; // current per-strand length
let cutsRemaining = CUTS_PER_CUSTOMER;
let totalScore = 0;
let perCustomerScore: number[] = [];
let best = 0;
let hairColor = HAIR_COLORS[0]!;

// ── Drag state ──
let dragging = false;
let dragStart: { x: number; y: number } | null = null;
let dragCurrent: { x: number; y: number } | null = null;
let activePointerId: number | null = null;

// ── Animation ──
let falling: FallingPiece[] = [];
let cutFlash: { idx: number; age: number }[] = [];
let lastCutLine: { x1: number; y1: number; x2: number; y2: number; age: number } | null =
  null;
let reviewMessage: { text: string; age: number; color: string } | null = null;

let rafId = 0;
let lastTime = 0;
const gen = createGenToken();

// ── Helpers ──
function strandX(i: number): number {
  return STRAND_X0 + i * STRAND_SPACING;
}

function clampLen(v: number): number {
  if (v < 4) return 4; // never fully zero — leaves a stub
  if (v > STRAND_INITIAL_LEN) return STRAND_INITIAL_LEN;
  return v;
}

function targetTipY(targetLen: number): number {
  return ATTACH_Y + targetLen;
}

function strandTipY(i: number): number {
  return ATTACH_Y + strandLens[i]!;
}

// ── Score ──
function customerQuality(): number {
  if (customers.length === 0) return 0;
  const target = customers[customerIdx]!.target;
  let sumQ = 0;
  for (let i = 0; i < STRAND_COUNT; i++) {
    const err = Math.abs(strandLens[i]! - target[i]!);
    const q = Math.max(0, 1 - err / ERROR_FULL_PENALTY);
    sumQ += q;
  }
  return sumQ / STRAND_COUNT;
}

function customerScore(): number {
  return Math.round(customerQuality() * 100);
}

// ── HUD ──
function updateHud(): void {
  customerEl.textContent = `${Math.min(customerIdx + 1, CUSTOMER_COUNT)}/${CUSTOMER_COUNT}`;
  cutsEl.textContent = String(cutsRemaining);
  scoreEl.textContent = String(totalScore);
  bestEl.textContent = String(best);
}

function commitBest(): void {
  if (totalScore > best) {
    best = totalScore;
    safeWrite(STORAGE_KEY, best);
    bestEl.textContent = String(best);
  }
}

// ── Cutting ──
function applyDragCut(x1: number, y1: number, x2: number, y2: number): boolean {
  // Returns true if at least one strand was actually shortened.
  let anyCut = false;
  const minX = Math.min(x1, x2);
  const maxX = Math.max(x1, x2);
  const dx = x2 - x1;
  for (let i = 0; i < STRAND_COUNT; i++) {
    const sx = strandX(i);
    if (sx < minX || sx > maxX) continue;
    let yAt: number;
    if (Math.abs(dx) < 0.5) {
      yAt = (y1 + y2) / 2;
    } else {
      const t = (sx - x1) / dx;
      yAt = y1 + t * (y2 - y1);
    }
    if (yAt <= ATTACH_Y + 4) continue; // can't cut at the scalp
    const currentTipY = strandTipY(i);
    if (yAt < currentTipY) {
      const oldLen = strandLens[i]!;
      const newLen = clampLen(yAt - ATTACH_Y);
      strandLens[i] = newLen;
      spawnFalling(sx, yAt, oldLen - newLen);
      cutFlash.push({ idx: i, age: 0 });
      anyCut = true;
    }
  }
  return anyCut;
}

function applyTapCut(x: number, y: number): boolean {
  if (y <= ATTACH_Y + 4) return false;
  // find nearest strand by x
  let bestIdx = -1;
  let bestDx = Infinity;
  for (let i = 0; i < STRAND_COUNT; i++) {
    const d = Math.abs(strandX(i) - x);
    if (d < bestDx) {
      bestDx = d;
      bestIdx = i;
    }
  }
  if (bestIdx < 0 || bestDx > TAP_PICK_RADIUS) return false;
  const currentTipY = strandTipY(bestIdx);
  if (y >= currentTipY) return false;
  const sx = strandX(bestIdx);
  const oldLen = strandLens[bestIdx]!;
  const newLen = clampLen(y - ATTACH_Y);
  strandLens[bestIdx] = newLen;
  spawnFalling(sx, y, oldLen - newLen);
  cutFlash.push({ idx: bestIdx, age: 0 });
  return true;
}

function spawnFalling(x: number, y: number, length: number): void {
  if (length < 4) return;
  falling.push({
    x,
    y,
    vy: 30 + Math.random() * 30,
    length: Math.min(length, 120),
    color: hairColor,
    age: 0,
  });
}

// ── Game flow ──
function loadCustomer(idx: number): void {
  customerIdx = idx;
  hairColor = HAIR_COLORS[idx % HAIR_COLORS.length]!;
  strandLens = Array.from(
    { length: STRAND_COUNT },
    () => STRAND_INITIAL_LEN - Math.random() * 6,
  );
  cutsRemaining = CUTS_PER_CUSTOMER;
  falling = [];
  cutFlash = [];
  lastCutLine = null;
  dragging = false;
  dragStart = null;
  dragCurrent = null;
  activePointerId = null;
}

function startGame(): void {
  gen.bump();
  cancelAnimationFrame(rafId);
  customers = makeCustomers();
  totalScore = 0;
  perCustomerScore = [];
  loadCustomer(0);
  state = 'playing';
  hideOverlayEl(overlay);
  updateHud();
  lastTime = performance.now();
  // immediate first frame so user sees the chair / customer before any input
  draw();
  rafId = requestAnimationFrame(loop);
}

function endCurrentCustomer(): void {
  if (state !== 'playing') return;
  const points = customerScore();
  perCustomerScore.push(points);
  totalScore += points;
  commitBest();
  updateHud();

  state = 'review';
  const tone =
    points >= 85 ? '#86efac' : points >= 60 ? '#fde047' : '#fca5a5';
  reviewMessage = {
    text: `${customers[customerIdx]!.name}: +${points}`,
    age: 0,
    color: tone,
  };

  // Pause briefly, then advance to next customer or game over.
  const myGen = gen.current();
  setTimeout(() => {
    if (!gen.isCurrent(myGen)) return;
    if (customerIdx + 1 >= CUSTOMER_COUNT) {
      gotoGameOver();
    } else {
      loadCustomer(customerIdx + 1);
      state = 'playing';
      reviewMessage = null;
      updateHud();
    }
  }, 1400);
}

function gotoGameOver(): void {
  state = 'gameover';
  cancelAnimationFrame(rafId);
  draw();
  const breakdown = perCustomerScore
    .map((s, i) => `${customers[i]!.name}: ${s}`)
    .join('<br>');
  const isBest = totalScore > 0 && totalScore >= best;
  overlayTitle.textContent = isBest ? 'Yeni rekor!' : 'Vardiya bitti';
  overlayMsg.innerHTML =
    `Toplam: <strong>${totalScore}</strong> / ${CUSTOMER_COUNT * 100}` +
    `<br>En iyi: ${best}` +
    `<br><br><small>${breakdown}</small>`;
  overlayBtn.textContent = 'Tekrar oyna';
  showOverlayEl(overlay);
  overlayBtn.focus({ preventScroll: true });
}

function resetToReady(): void {
  gen.bump();
  cancelAnimationFrame(rafId);
  customers = makeCustomers();
  totalScore = 0;
  perCustomerScore = [];
  loadCustomer(0);
  state = 'ready';
  updateHud();
  overlayTitle.textContent = 'Berber';
  overlayMsg.innerHTML =
    'Müşterinin saçını hedef siluete göre kes. <strong>Sürükle</strong> —' +
    ' çizdiğin makas çizgisi geçtiği her teli aynı yükseklikten keser.' +
    '<br><small>Her müşteri için 8 makas hakkın var. Tek tık: en yakın tel.</small>';
  overlayBtn.textContent = 'Başla';
  showOverlayEl(overlay);
  draw();
}

// ── Drawing ──
function draw(): void {
  ctx.fillStyle = '#0a0f1a';
  ctx.fillRect(0, 0, W, H);

  drawChair();
  drawHead();
  drawTargetSilhouette();
  drawStrands();
  drawFallingPieces();
  drawScissorPreview();
  drawCutFlash();
  drawReviewMessage();
  drawHints();
}

function drawChair(): void {
  // Barber chair base under the head
  ctx.fillStyle = '#1a2030';
  ctx.fillRect(140, H - 60, 200, 36);
  ctx.fillStyle = '#252d40';
  ctx.fillRect(140, H - 60, 200, 6);
  // chair post
  ctx.fillStyle = '#16192a';
  ctx.fillRect(225, H - 80, 30, 24);
}

function drawHead(): void {
  // Skin-toned head behind the hair
  ctx.fillStyle = '#e7c39a';
  ctx.beginPath();
  ctx.ellipse(240, ATTACH_Y + 40, 100, 56, 0, 0, Math.PI * 2);
  ctx.fill();
  // neck
  ctx.fillStyle = '#cba37e';
  ctx.fillRect(210, ATTACH_Y + 78, 60, 28);
  // simple face hint (eyes + mouth)
  ctx.fillStyle = '#1a1208';
  ctx.beginPath();
  ctx.arc(220, ATTACH_Y + 46, 2.5, 0, Math.PI * 2);
  ctx.arc(260, ATTACH_Y + 46, 2.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#1a1208';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(240, ATTACH_Y + 62, 8, 0.2, Math.PI - 0.2);
  ctx.stroke();
}

function drawTargetSilhouette(): void {
  if (state === 'gameover') return;
  if (customers.length === 0) return;
  const target = customers[customerIdx]!.target;
  // Dashed line connecting target tip Y per strand — the "hedef siluet"
  ctx.save();
  ctx.strokeStyle = 'rgba(125, 211, 252, 0.7)';
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  for (let i = 0; i < STRAND_COUNT; i++) {
    const x = strandX(i);
    const y = targetTipY(target[i]!);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  // small ticks at each target tip
  ctx.fillStyle = 'rgba(125, 211, 252, 0.8)';
  for (let i = 0; i < STRAND_COUNT; i++) {
    const x = strandX(i);
    const y = targetTipY(target[i]!);
    ctx.fillRect(x - 1, y - 1, 3, 3);
  }
  ctx.restore();
}

function drawStrands(): void {
  const flashSet = new Map<number, number>();
  for (const f of cutFlash) flashSet.set(f.idx, 1 - f.age / 250);

  ctx.lineCap = 'round';
  for (let i = 0; i < STRAND_COUNT; i++) {
    const x = strandX(i);
    const len = strandLens[i]!;
    const tipY = ATTACH_Y + len;
    const flash = flashSet.get(i) ?? 0;

    // base hair color, slight per-strand variation
    const wobble = ((i * 31) % 20) - 10;
    const base = hairColor;
    ctx.strokeStyle = base;
    ctx.lineWidth = 4;
    ctx.beginPath();
    // wavy strand: slight horizontal bow for natural look
    const midY = (ATTACH_Y + tipY) / 2;
    ctx.moveTo(x, ATTACH_Y);
    ctx.quadraticCurveTo(x + wobble * 0.2, midY, x, tipY);
    ctx.stroke();

    // tip highlight
    ctx.fillStyle = '#fde68a';
    ctx.fillRect(x - 2, tipY - 1, 4, 2);

    // flash overlay (just-cut indicator)
    if (flash > 0) {
      ctx.strokeStyle = `rgba(134, 239, 172, ${flash})`;
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.moveTo(x, ATTACH_Y);
      ctx.quadraticCurveTo(x + wobble * 0.2, midY, x, tipY);
      ctx.stroke();
    }
  }
}

function drawFallingPieces(): void {
  for (const p of falling) {
    ctx.strokeStyle = p.color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + 1, p.y + p.length);
    ctx.stroke();
  }
}

function drawScissorPreview(): void {
  // While dragging — dashed red line from start to current pointer
  if (dragging && dragStart && dragCurrent) {
    ctx.save();
    ctx.strokeStyle = '#fca5a5';
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 6]);
    ctx.beginPath();
    ctx.moveTo(dragStart.x, dragStart.y);
    ctx.lineTo(dragCurrent.x, dragCurrent.y);
    ctx.stroke();
    ctx.setLineDash([]);
    // scissor tip marker
    ctx.fillStyle = '#ef4444';
    ctx.beginPath();
    ctx.arc(dragCurrent.x, dragCurrent.y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  // After release — brief solid red flash of the last cut
  if (lastCutLine && lastCutLine.age < 200) {
    const a = 1 - lastCutLine.age / 200;
    ctx.save();
    ctx.strokeStyle = `rgba(239, 68, 68, ${a})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(lastCutLine.x1, lastCutLine.y1);
    ctx.lineTo(lastCutLine.x2, lastCutLine.y2);
    ctx.stroke();
    ctx.restore();
  }
}

function drawCutFlash(): void {
  // (Flash is drawn together with strands; this hook exists for clarity.)
}

function drawReviewMessage(): void {
  if (!reviewMessage) return;
  const a = Math.max(0, 1 - reviewMessage.age / 1400);
  ctx.save();
  ctx.fillStyle = `rgba(10, 15, 26, ${0.7 * a})`;
  ctx.fillRect(60, 30, W - 120, 56);
  ctx.fillStyle = reviewMessage.color;
  ctx.globalAlpha = a;
  ctx.font = '700 22px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(reviewMessage.text, W / 2, 58);
  ctx.restore();
}

function drawHints(): void {
  if (state !== 'playing') return;
  ctx.save();
  ctx.fillStyle = 'rgba(148, 163, 184, 0.65)';
  ctx.font = '12px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(
    `Hedef: ${customers[customerIdx]!.name}`,
    16,
    H - 14,
  );
  ctx.textAlign = 'right';
  ctx.fillText(
    `Makas: ${cutsRemaining}/${CUTS_PER_CUSTOMER}`,
    W - 16,
    H - 14,
  );
  ctx.restore();
}

// ── Loop ──
function loop(now: number): void {
  if (state === 'gameover' || state === 'ready') return;
  const dtMs = Math.min(50, now - lastTime);
  lastTime = now;
  const dt = dtMs / 1000;

  // falling pieces
  for (const p of falling) {
    p.age += dtMs;
    p.vy += 240 * dt;
    p.y += p.vy * dt;
  }
  falling = falling.filter((p) => p.y < H + 40 && p.age < 1800);

  // flashes
  for (const f of cutFlash) f.age += dtMs;
  cutFlash = cutFlash.filter((f) => f.age < 250);

  if (lastCutLine) {
    lastCutLine.age += dtMs;
    if (lastCutLine.age > 200) lastCutLine = null;
  }
  if (reviewMessage) reviewMessage.age += dtMs;

  draw();
  rafId = requestAnimationFrame(loop);
}

// ── Input ──
function canvasPoint(clientX: number, clientY: number): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
  const sx = W / rect.width;
  const sy = H / rect.height;
  return {
    x: (clientX - rect.left) * sx,
    y: (clientY - rect.top) * sy,
  };
}

function onPointerDown(e: PointerEvent): void {
  if (state !== 'playing') return;
  if (cutsRemaining <= 0) return;
  e.preventDefault();
  if (canvas.setPointerCapture) {
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }
  activePointerId = e.pointerId;
  const p = canvasPoint(e.clientX, e.clientY);
  dragStart = p;
  dragCurrent = { x: p.x, y: p.y };
  dragging = true;
}

function onPointerMove(e: PointerEvent): void {
  if (!dragging) return;
  if (activePointerId !== null && e.pointerId !== activePointerId) return;
  e.preventDefault();
  dragCurrent = canvasPoint(e.clientX, e.clientY);
}

function onPointerUp(e: PointerEvent): void {
  if (!dragging) return;
  if (activePointerId !== null && e.pointerId !== activePointerId) return;
  e.preventDefault();
  dragging = false;
  const start = dragStart;
  const end = dragCurrent;
  dragStart = null;
  dragCurrent = null;
  activePointerId = null;
  if (!start || !end) return;
  if (state !== 'playing' || cutsRemaining <= 0) return;

  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dist = Math.hypot(dx, dy);

  let did: boolean;
  if (dist < TAP_THRESHOLD_PX) {
    did = applyTapCut(start.x, start.y);
  } else {
    did = applyDragCut(start.x, start.y, end.x, end.y);
  }

  // Always consume a cut on a deliberate gesture, even if no strand changed —
  // forces the player to plan rather than spam. Tap with no nearby strand
  // is a no-op (no cut consumed).
  if (did || dist >= TAP_THRESHOLD_PX) {
    cutsRemaining--;
    lastCutLine = {
      x1: start.x,
      y1: start.y,
      x2: end.x,
      y2: end.y,
      age: 0,
    };
    updateHud();
    if (cutsRemaining <= 0) {
      endCurrentCustomer();
    }
  }
}

function onPointerCancel(e: PointerEvent): void {
  if (activePointerId !== null && e.pointerId !== activePointerId) return;
  dragging = false;
  dragStart = null;
  dragCurrent = null;
  activePointerId = null;
}

function onKeyDown(e: KeyboardEvent): void {
  const k = e.key;
  if (k === 'r' || k === 'R') {
    e.preventDefault();
    startGame();
    return;
  }
  if (state !== 'playing') {
    if (k === ' ' || k === 'Enter') {
      e.preventDefault();
      startGame();
    }
    return;
  }
  if (k === 'Enter') {
    e.preventDefault();
    endCurrentCustomer();
  }
}

// ── Init ──
function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  customerEl = document.querySelector<HTMLElement>('#customer')!;
  cutsEl = document.querySelector<HTMLElement>('#cuts')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  submitBtn = document.querySelector<HTMLButtonElement>('#submit')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;

  best = safeRead<number>(STORAGE_KEY, 0);
  if (!Number.isFinite(best) || best < 0) best = 0;

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);
  canvas.addEventListener('pointerleave', onPointerCancel);

  window.addEventListener('keydown', onKeyDown);

  submitBtn.addEventListener('click', () => {
    if (state === 'playing') endCurrentCustomer();
  });
  restartBtn.addEventListener('click', () => startGame());
  overlayBtn.addEventListener('click', () => startGame());

  resetToReady();
}

export const game = defineGame({ init, reset: resetToReady });
