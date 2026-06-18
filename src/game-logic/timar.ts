import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';

// Tımar — direction-aware grooming. Each round picks a uniform "hair grain"
// direction; brushing with grain (cosine alignment > +0.4) cleans dirt under
// the cursor, while brushing against grain (< -0.35) ruffles the coat and
// re-dirties spots. Score = horses cleaned within TOTAL_TIME_MS.
//
// PITFALLS guarded:
// - unguarded-storage: safeRead/safeWrite (in init()).
// - module-level-dom-access: every DOM access lives in init().
// - stale-async-callback: requestAnimationFrame loop carries a generation
//   token; reset() bumps it so stale frames bail out.
// - overlay-input-leak: pointer handlers and the Space/Enter shortcut check
//   the explicit `state` enum before doing anything.
// - invisible-boot: reset() seeds a preview horse and renders it before the
//   user clicks "Başla", so cold boot shows the silhouette + dirt + grain
//   hint within the first frame.
// - missing-overlay-css: timar.css declares .overlay--hidden / .overlay.
// - unreachable-start-state: overlay carries a real "Başla" button plus a
//   Space/Enter keyboard fallback; R restarts at any state.
// - hud-counter-synced-only-at-lifecycle-edges: updateHud() runs every
//   animation frame, not just on round/game transitions.

const STORAGE_BEST = 'timar.best';

type State = 'ready' | 'playing' | 'gameover';
type Pt = { x: number; y: number };
type DirtSpot = { x: number; y: number; r: number; amount: number };
type Ruffle = { x: number; y: number; angle: number };
type Round = { ux: number; uy: number; label: string; dirtCount: number };

const TOTAL_TIME_MS = 75_000;

const BODY_CX = 280;
const BODY_CY = 320;
const BODY_RX = 140;
const BODY_RY = 60;
const HEAD_CX = 470;
const HEAD_CY = 235;
const HEAD_RX = 56;
const HEAD_RY = 36;

const gen = createGenToken();
let state: State = 'ready';
let horsesCleaned = 0;
let best = 0;
let lastFrameMs = 0;
let timeLeftMs = TOTAL_TIME_MS;
let currentRound: Round = makeRound(0);
let dirt: DirtSpot[] = [];
let ruffles: Ruffle[] = [];
let initialDirtTotal = 1;
let roundNumber = 0;
let ruffleCountInRound = 0;
let lastPt: Pt | null = null;
let drawing = false;
let pointerId = -1;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let timeEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let startBtn!: HTMLButtonElement;
let horsePath: Path2D | null = null;

const cssCache = new Map<string, string>();
function css(varName: string): string {
  const cached = cssCache.get(varName);
  if (cached !== undefined) return cached;
  const val = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  cssCache.set(varName, val);
  return val;
}

function buildHorsePath(): Path2D {
  const p = new Path2D();
  p.ellipse(BODY_CX, BODY_CY, BODY_RX, BODY_RY, 0, 0, Math.PI * 2);
  p.ellipse(HEAD_CX, HEAD_CY, HEAD_RX, HEAD_RY, 0, 0, Math.PI * 2);
  p.moveTo(395, 295);
  p.lineTo(425, 252);
  p.lineTo(462, 260);
  p.lineTo(438, 308);
  p.closePath();
  for (const x of [205, 252, 318, 365]) {
    p.rect(x - 10, 365, 20, 95);
  }
  p.moveTo(148, 285);
  p.lineTo(108, 318);
  p.lineTo(140, 340);
  p.closePath();
  return p;
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function makeRound(idx: number): Round {
  const SCRIPTED: Array<{ angle: number; label: string }> = [
    { angle: 0, label: 'Baş → Sağrı' },
    { angle: Math.PI / 2, label: 'Sırt → Karın' },
    { angle: Math.PI / 4, label: 'Çapraz aşağı' },
    { angle: Math.PI, label: 'Sağrı → Baş' },
    { angle: -Math.PI / 4, label: 'Çapraz yukarı' },
    { angle: -Math.PI / 2, label: 'Karın → Sırt' },
  ];
  let angle: number;
  let label: string;
  if (idx < SCRIPTED.length) {
    const r = SCRIPTED[idx]!;
    angle = r.angle;
    label = r.label;
  } else {
    angle = Math.random() * Math.PI * 2;
    label = 'Rastgele yön';
  }
  const dirtCount = Math.min(28, 12 + Math.floor(idx * 1.5));
  return { ux: Math.cos(angle), uy: Math.sin(angle), label, dirtCount };
}

function generateDirt(round: Round): DirtSpot[] {
  const out: DirtSpot[] = [];
  let attempts = 0;
  while (out.length < round.dirtCount && attempts < 600) {
    attempts++;
    const onHead = Math.random() < 0.18;
    let x: number;
    let y: number;
    if (onHead) {
      x = HEAD_CX + (Math.random() * 2 - 1) * HEAD_RX * 0.7;
      y = HEAD_CY + (Math.random() * 2 - 1) * HEAD_RY * 0.7;
    } else {
      x = BODY_CX + (Math.random() * 2 - 1) * BODY_RX * 0.85;
      y = BODY_CY + (Math.random() * 2 - 1) * BODY_RY * 0.85;
    }
    if (!horsePath || !ctx.isPointInPath(horsePath, x, y)) continue;
    let overlap = false;
    for (const d of out) {
      if (Math.hypot(d.x - x, d.y - y) < 18) {
        overlap = true;
        break;
      }
    }
    if (overlap) continue;
    out.push({ x, y, r: rand(11, 16), amount: 1 });
  }
  return out;
}

function startRound(): void {
  currentRound = makeRound(roundNumber);
  dirt = generateDirt(currentRound);
  initialDirtTotal = Math.max(1, dirt.reduce((s, d) => s + d.amount, 0));
  ruffles = [];
  ruffleCountInRound = 0;
}

function dirtRemainingFrac(): number {
  const sum = dirt.reduce((s, d) => s + Math.max(0, d.amount), 0);
  return sum / initialDirtTotal;
}

function showOverlayMessage(title: string, msg: string, btnLabel: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  startBtn.textContent = btnLabel;
  showOverlayEl(overlay);
}

function startGame(): void {
  state = 'playing';
  horsesCleaned = 0;
  roundNumber = 0;
  timeLeftMs = TOTAL_TIME_MS;
  lastFrameMs = performance.now();
  startRound();
  hideOverlayEl(overlay);
  updateHud();
  const myGen = gen.current();
  requestAnimationFrame(() => loop(myGen));
}

function endGame(): void {
  state = 'gameover';
  if (horsesCleaned > best) {
    best = horsesCleaned;
    safeWrite(STORAGE_BEST, best);
  }
  drawing = false;
  lastPt = null;
  updateHud();
  draw();
  showOverlayMessage(
    'Bitti',
    `Tımarlanan at: ${horsesCleaned}\nRekor: ${best}\n\nYön ile sürtmek hızlı temizler; karşıya gitmek tüyü kabartır.`,
    'Tekrar başla',
  );
}

function reset(): void {
  gen.bump();
  state = 'ready';
  horsesCleaned = 0;
  timeLeftMs = TOTAL_TIME_MS;
  roundNumber = 0;
  drawing = false;
  lastPt = null;
  pointerId = -1;
  currentRound = makeRound(0);
  dirt = generateDirt(currentRound);
  initialDirtTotal = Math.max(1, dirt.reduce((s, d) => s + d.amount, 0));
  ruffles = [];
  ruffleCountInRound = 0;
  updateHud();
  draw();
  showOverlayMessage(
    'Tımar',
    'Sağ üstteki ok atın tüy yönünü gösterir.\nFırçayı yön ile sürükle → toz dökülür.\nYöne karşı sürtersen post ürperir ve toz geri yapışır.\n75 saniyede kaç at tımarlayabilirsin?',
    'Başla',
  );
}

function updateHud(): void {
  scoreEl.textContent = String(horsesCleaned);
  bestEl.textContent = String(best);
  timeEl.textContent = String(Math.max(0, Math.ceil(timeLeftMs / 1000)));
}

function applyBrushSegment(a: Pt, b: Pt): void {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) return;
  const vx = dx / len;
  const vy = dy / len;
  const align = vx * currentRound.ux + vy * currentRound.uy;
  const steps = Math.max(1, Math.ceil(len / 6));
  for (let s = 0; s < steps; s++) {
    const t = (s + 0.5) / steps;
    const px = a.x + dx * t;
    const py = a.y + dy * t;
    if (!horsePath || !ctx.isPointInPath(horsePath, px, py)) continue;
    for (const d of dirt) {
      const dist = Math.hypot(d.x - px, d.y - py);
      if (dist >= d.r + 14) continue;
      if (align > 0.4) {
        const factor = (align - 0.4) / 0.6;
        d.amount = Math.max(0, d.amount - 0.085 * factor);
      } else if (align < -0.35) {
        const factor = (-align - 0.35) / 0.65;
        d.amount = Math.min(1, d.amount + 0.055 * factor);
      }
    }
    if (align < -0.4) {
      const last = ruffles[ruffles.length - 1];
      const farEnough = !last || Math.hypot(px - last.x, py - last.y) > 16;
      if (farEnough) {
        const perpAngle = Math.atan2(currentRound.uy, currentRound.ux) + Math.PI / 2;
        ruffles.push({ x: px, y: py, angle: perpAngle });
        ruffleCountInRound++;
      }
    }
  }
}

function loop(myGen: number): void {
  if (!gen.isCurrent(myGen)) return;
  if (state !== 'playing') return;
  const now = performance.now();
  const dt = Math.min(100, now - lastFrameMs);
  lastFrameMs = now;
  timeLeftMs -= dt;
  if (timeLeftMs <= 0) {
    timeLeftMs = 0;
    endGame();
    return;
  }
  if (dirtRemainingFrac() < 0.05) {
    horsesCleaned++;
    roundNumber++;
    startRound();
  }
  updateHud();
  draw();
  requestAnimationFrame(() => loop(myGen));
}

function drawGrainHatching(): void {
  const stride = 30;
  ctx.save();
  ctx.strokeStyle = 'rgba(60, 36, 20, 0.42)';
  ctx.lineWidth = 1.5;
  ctx.lineCap = 'round';
  const ux = currentRound.ux;
  const uy = currentRound.uy;
  const ang = Math.atan2(uy, ux);
  for (let y = BODY_CY - BODY_RY + 8; y <= BODY_CY + BODY_RY - 4; y += stride) {
    for (let x = BODY_CX - BODY_RX + 10; x <= BODY_CX + BODY_RX - 10; x += stride) {
      if (!horsePath || !ctx.isPointInPath(horsePath, x, y)) continue;
      const bx = x + ux * 9;
      const by = y + uy * 9;
      ctx.beginPath();
      ctx.moveTo(x - ux * 9, y - uy * 9);
      ctx.lineTo(bx, by);
      ctx.lineTo(bx - Math.cos(ang - 0.55) * 5, by - Math.sin(ang - 0.55) * 5);
      ctx.moveTo(bx, by);
      ctx.lineTo(bx - Math.cos(ang + 0.55) * 5, by - Math.sin(ang + 0.55) * 5);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function drawHintArrow(): void {
  const cx = 580;
  const cy = 70;
  const r = 34;
  ctx.save();
  ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  const ux = currentRound.ux;
  const uy = currentRound.uy;
  const ax = cx - ux * 20;
  const ay = cy - uy * 20;
  const bx = cx + ux * 20;
  const by = cy + uy * 20;
  ctx.strokeStyle = '#fbbf24';
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(bx, by);
  ctx.stroke();
  const ang = Math.atan2(uy, ux);
  ctx.beginPath();
  ctx.moveTo(bx, by);
  ctx.lineTo(bx - Math.cos(ang - 0.5) * 12, by - Math.sin(ang - 0.5) * 12);
  ctx.moveTo(bx, by);
  ctx.lineTo(bx - Math.cos(ang + 0.5) * 12, by - Math.sin(ang + 0.5) * 12);
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.78)';
  ctx.font = '500 12px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Tüy yönü', cx, cy - r - 8);
  ctx.fillText(currentRound.label, cx, cy + r + 16);
  ctx.restore();
}

function drawHorseSilhouette(): void {
  if (!horsePath) return;
  ctx.fillStyle = '#8d6243';
  ctx.fill(horsePath);
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.beginPath();
  ctx.ellipse(BODY_CX, BODY_CY + BODY_RY - 4, BODY_RX * 0.72, 7, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#3f2415';
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(400, 295);
  ctx.quadraticCurveTo(425, 248, 458, 240);
  ctx.stroke();
  ctx.strokeStyle = '#3f2415';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(140, 290);
  ctx.quadraticCurveTo(112, 305, 100, 340);
  ctx.moveTo(145, 300);
  ctx.quadraticCurveTo(120, 330, 118, 358);
  ctx.stroke();
  ctx.fillStyle = '#704a2e';
  ctx.beginPath();
  ctx.moveTo(450, 208);
  ctx.lineTo(458, 188);
  ctx.lineTo(468, 213);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#1a1a1a';
  ctx.beginPath();
  ctx.arc(HEAD_CX + 18, HEAD_CY - 4, 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(40, 24, 14, 0.7)';
  ctx.beginPath();
  ctx.arc(HEAD_CX + 42, HEAD_CY + 8, 2.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#2a1810';
  for (const x of [205, 252, 318, 365]) {
    ctx.fillRect(x - 11, 452, 22, 10);
  }
}

function draw(): void {
  const w = canvas.width;
  const h = canvas.height;
  ctx.fillStyle = css('--surface') || '#13151a';
  ctx.fillRect(0, 0, w, h);

  const grad = ctx.createLinearGradient(0, 460, 0, 520);
  grad.addColorStop(0, 'rgba(86, 60, 30, 0.18)');
  grad.addColorStop(1, 'rgba(86, 60, 30, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 460, w, 60);

  drawHorseSilhouette();

  if (horsePath) {
    ctx.save();
    ctx.clip(horsePath);
    drawGrainHatching();
    ctx.restore();
  }

  for (const d of dirt) {
    if (d.amount <= 0.02) continue;
    const baseR = d.r * (0.55 + 0.45 * d.amount);
    ctx.fillStyle = `rgba(48, 32, 18, ${d.amount * 0.85})`;
    ctx.beginPath();
    ctx.arc(d.x, d.y, baseR, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `rgba(28, 20, 12, ${d.amount * 0.55})`;
    ctx.beginPath();
    ctx.arc(d.x + 4, d.y - 2, 2, 0, Math.PI * 2);
    ctx.arc(d.x - 3, d.y + 3, 1.6, 0, Math.PI * 2);
    ctx.fill();
  }

  for (const rf of ruffles) {
    ctx.save();
    ctx.translate(rf.x, rf.y);
    ctx.rotate(rf.angle);
    ctx.strokeStyle = '#ea580c';
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-7, -5);
    ctx.lineTo(0, 6);
    ctx.lineTo(7, -5);
    ctx.stroke();
    ctx.restore();
  }

  if (state === 'playing') {
    const cleaned = 1 - dirtRemainingFrac();
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.42)';
    ctx.fillRect(20, 20, 220, 30);
    ctx.fillStyle = '#22c55e';
    ctx.fillRect(20, 20, 220 * Math.max(0, Math.min(1, cleaned)), 30);
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1;
    ctx.strokeRect(20, 20, 220, 30);
    ctx.fillStyle = '#fff';
    ctx.font = '600 13px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(`Tımar ${horsesCleaned + 1}`, 28, 35);
    if (ruffleCountInRound > 0) {
      ctx.fillStyle = '#fb923c';
      ctx.textAlign = 'right';
      ctx.fillText(`${ruffleCountInRound}× kabardı`, 234, 35);
    }
    ctx.restore();
  }

  drawHintArrow();
}

function toCanvasPt(e: PointerEvent): Pt {
  const rect = canvas.getBoundingClientRect();
  const sx = canvas.width / rect.width;
  const sy = canvas.height / rect.height;
  return {
    x: (e.clientX - rect.left) * sx,
    y: (e.clientY - rect.top) * sy,
  };
}

function onDown(e: PointerEvent): void {
  if (state !== 'playing') return;
  e.preventDefault();
  try { canvas.setPointerCapture(e.pointerId); } catch { /* unsupported */ }
  drawing = true;
  pointerId = e.pointerId;
  lastPt = toCanvasPt(e);
}

function onMove(e: PointerEvent): void {
  if (state !== 'playing') return;
  if (!drawing || e.pointerId !== pointerId) return;
  e.preventDefault();
  const p = toCanvasPt(e);
  if (lastPt) applyBrushSegment(lastPt, p);
  lastPt = p;
}

function onUp(e: PointerEvent): void {
  if (e.pointerId !== pointerId && pointerId !== -1) return;
  drawing = false;
  lastPt = null;
  try { canvas.releasePointerCapture(e.pointerId); } catch { /* unsupported */ }
  pointerId = -1;
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
  startBtn = document.querySelector<HTMLButtonElement>('#start-btn')!;

  best = safeRead<number>(STORAGE_BEST, 0);
  horsePath = buildHorsePath();

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('pointerleave', (e) => {
    if (drawing) onUp(e);
  });

  restartBtn.addEventListener('click', reset);
  startBtn.addEventListener('click', () => {
    if (state === 'gameover' || state === 'ready') startGame();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'r' || e.key === 'R') {
      reset();
      e.preventDefault();
    } else if ((e.key === ' ' || e.key === 'Enter') && state !== 'playing') {
      startGame();
      e.preventDefault();
    }
  });

  reset();
}

export const game = defineGame({ init, reset });
