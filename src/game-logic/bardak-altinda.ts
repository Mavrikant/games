import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';

const STORAGE_BEST = 'bardak-altinda.best';

type Phase = 'ready' | 'reveal' | 'cover' | 'shuffle' | 'choose' | 'result';

const gen = createGenToken();

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let roundEl!: HTMLElement;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlayEl!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;

let phase: Phase = 'ready';
let round = 1;
let score = 0;
let best = 0;
let cupCount = 3;
let ballIdx = 0; // index in `cups` (which logical cup holds the ball)
let pickedIdx: number | null = null;
let lastCorrect: boolean | null = null;

interface Cup {
  x: number; // current center x
  targetX: number; // animation target
  startX: number; // animation start (for easing)
  liftT: number; // 0 = sitting on floor, 1 = fully raised
  liftTarget: number;
}

let cups: Cup[] = [];
let cupSlots: number[] = []; // x positions for the N slots, left → right

const CUP_W = 78;
const CUP_H = 110;
const CUP_LIP = 14;
const FLOOR_Y = 280;
const BALL_R = 14;

let rafHandle = 0;
let lastTs = 0;
let phaseTimer = 0; // ms remaining in current phase
let shuffleQueue: Array<[number, number, number]> = []; // [slotA, slotB, duration]
let currentSwap: { a: number; b: number; duration: number; elapsed: number } | null = null;

function getCss(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function computeSlots(): void {
  cupSlots = [];
  const totalWidth = canvas.width;
  const usable = totalWidth - 80; // 40px padding each side
  const gap = usable / cupCount;
  for (let i = 0; i < cupCount; i++) {
    cupSlots.push(40 + gap / 2 + i * gap);
  }
}

function buildCups(): void {
  computeSlots();
  cups = cupSlots.map((x) => ({ x, targetX: x, startX: x, liftT: 0, liftTarget: 0 }));
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlayEl);
}

function hideOverlay(): void {
  hideOverlayEl(overlayEl);
}

function difficulty(): { cups: number; swaps: number; swapMs: number; revealMs: number } {
  // round 1: 3 cups, 4 swaps, 520ms each
  // grow: +1 swap every round; +1 cup every 4 rounds (cap 6); speed up gradually (floor 220ms)
  const cupsN = Math.min(6, 3 + Math.floor((round - 1) / 4));
  const swapsN = 3 + Math.min(12, round);
  const swapMs = Math.max(220, 540 - (round - 1) * 25);
  const revealMs = Math.max(700, 1300 - (round - 1) * 40);
  return { cups: cupsN, swaps: swapsN, swapMs, revealMs };
}

function startRound(): void {
  const token = gen.bump();
  const d = difficulty();
  cupCount = d.cups;
  buildCups();
  ballIdx = Math.floor(Math.random() * cupCount);
  pickedIdx = null;
  lastCorrect = null;

  // Reveal phase: all cups lifted to show empty/ball.
  phase = 'reveal';
  for (const c of cups) c.liftTarget = 1;
  phaseTimer = d.revealMs;
  hideOverlay();
  updateHud();

  // Plan shuffle queue (executed after cover).
  shuffleQueue = [];
  for (let i = 0; i < d.swaps; i++) {
    let a = Math.floor(Math.random() * cupCount);
    let b = Math.floor(Math.random() * cupCount);
    if (b === a) b = (a + 1) % cupCount;
    shuffleQueue.push([a, b, d.swapMs]);
  }

  ensureLoop(token);
}

function ensureLoop(token: number): void {
  if (rafHandle) cancelAnimationFrame(rafHandle);
  lastTs = 0;
  const step = (ts: number) => {
    if (!gen.isCurrent(token)) return;
    if (!lastTs) lastTs = ts;
    const dt = Math.min(64, ts - lastTs);
    lastTs = ts;
    update(dt, token);
    draw();
    rafHandle = requestAnimationFrame(step);
  };
  rafHandle = requestAnimationFrame(step);
}

function update(dt: number, token: number): void {
  // Cup lift interpolation
  for (const c of cups) {
    if (c.liftT < c.liftTarget) c.liftT = Math.min(c.liftTarget, c.liftT + dt / 320);
    else if (c.liftT > c.liftTarget) c.liftT = Math.max(c.liftTarget, c.liftT - dt / 320);
  }

  // Active swap progression
  if (currentSwap) {
    currentSwap.elapsed += dt;
    const t = Math.min(1, currentSwap.elapsed / currentSwap.duration);
    const eased = easeInOut(t);
    // Arc trajectory: a goes over, b goes under (visual variation) — we just
    // animate x; the visual lane separation comes from a small y arc.
    const aCup = cups[currentSwap.a]!;
    const bCup = cups[currentSwap.b]!;
    aCup.x = aCup.startX + (aCup.targetX - aCup.startX) * eased;
    bCup.x = bCup.startX + (bCup.targetX - bCup.startX) * eased;
    if (t >= 1) {
      aCup.x = aCup.targetX;
      bCup.x = bCup.targetX;
      currentSwap = null;
    }
  }

  // Phase transitions
  if (phase === 'reveal') {
    phaseTimer -= dt;
    if (phaseTimer <= 0) {
      phase = 'cover';
      for (const c of cups) c.liftTarget = 0;
      phaseTimer = 420;
    }
  } else if (phase === 'cover') {
    phaseTimer -= dt;
    const allDown = cups.every((c) => c.liftT <= 0.001);
    if (phaseTimer <= 0 && allDown) {
      phase = 'shuffle';
      phaseTimer = 200; // brief pause before first swap
    }
  } else if (phase === 'shuffle') {
    if (currentSwap === null) {
      phaseTimer -= dt;
      if (phaseTimer <= 0) {
        if (shuffleQueue.length === 0) {
          phase = 'choose';
        } else {
          const swap = shuffleQueue.shift()!;
          const [a, b, duration] = swap;
          const aCup = cups[a]!;
          const bCup = cups[b]!;
          currentSwap = {
            a,
            b,
            duration,
            elapsed: 0,
          };
          aCup.startX = aCup.x;
          bCup.startX = bCup.x;
          aCup.targetX = bCup.x;
          bCup.targetX = aCup.x;
          // Update ball tracking: ball stays under the cup it is in. Find
          // which logical index corresponds to ballIdx in cups[] and after
          // swap, ballIdx may need to change.
          if (ballIdx === a) ballIdx = b;
          else if (ballIdx === b) ballIdx = a;
          phaseTimer = 60; // tiny gap between swaps
        }
      }
    }
  } else if (phase === 'result') {
    phaseTimer -= dt;
    if (phaseTimer <= 0) {
      if (lastCorrect === false) {
        // Game over → show overlay, do NOT advance.
        phase = 'ready';
        commitBest();
        showOverlay(
          'Yanıldın!',
          `Skor: ${score} · En iyi: ${best}\nYeniden başlamak için tıkla.`,
        );
      } else {
        // Correct → next round.
        round += 1;
        updateHud();
        startRound();
      }
    }
  }
}

function draw(): void {
  // background
  ctx.fillStyle = getCss('--surface', '#0f1216');
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // floor band
  const floorTop = FLOOR_Y + 4;
  ctx.fillStyle = getCss('--floor', '#1a1e25');
  ctx.fillRect(0, floorTop, canvas.width, canvas.height - floorTop);

  // floor accent line
  ctx.strokeStyle = getCss('--floor-line', '#2d3340');
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, floorTop);
  ctx.lineTo(canvas.width, floorTop);
  ctx.stroke();

  // Soft shadow under cups
  for (const c of cups) {
    drawCupShadow(c);
  }

  // Draw ball first (so cups overlap when lowered)
  drawBall();

  // Cups (sorted by x for proper overlap when crossing during swap)
  const ordered = [...cups]
    .map((c, i) => ({ c, i }))
    .sort((a, b) => a.c.x - b.c.x);
  for (const { c } of ordered) {
    drawCup(c);
  }

  // Status text bottom
  ctx.fillStyle = getCss('--text-muted', '#aab');
  ctx.font =
    '500 14px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let label = '';
  if (phase === 'reveal') label = 'Bilye burada — takip et!';
  else if (phase === 'cover') label = 'Bardaklar kapanıyor…';
  else if (phase === 'shuffle') label = 'Karıştırılıyor…';
  else if (phase === 'choose') label = 'Bilye hangi bardakta?';
  else if (phase === 'result')
    label = lastCorrect ? 'Doğru!' : 'Yanlış bardak!';
  if (label) ctx.fillText(label, canvas.width / 2, canvas.height - 30);
}

function drawCupShadow(c: Cup): void {
  const baseY = FLOOR_Y + 2;
  const lift = c.liftT;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
  ctx.beginPath();
  const shadowW = CUP_W * (0.85 + lift * 0.25);
  ctx.ellipse(c.x, baseY, shadowW / 2, 6, 0, 0, Math.PI * 2);
  ctx.fill();
}

function drawCup(c: Cup): void {
  const lift = c.liftT;
  const liftPx = lift * 90;
  const topY = FLOOR_Y - CUP_H - liftPx;
  const botY = FLOOR_Y - liftPx;

  // Trapezoid cup
  const topHalf = CUP_W / 2 - 14;
  const botHalf = CUP_W / 2;

  const body = getCss('--cup-body', '#b76a3f');
  const edge = getCss('--cup-edge', '#7a3f1e');
  const shine = getCss('--cup-shine', '#e2a679');

  // Cup body fill
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.moveTo(c.x - topHalf, topY);
  ctx.lineTo(c.x + topHalf, topY);
  ctx.lineTo(c.x + botHalf, botY);
  ctx.lineTo(c.x - botHalf, botY);
  ctx.closePath();
  ctx.fill();

  // Edge stroke
  ctx.strokeStyle = edge;
  ctx.lineWidth = 2;
  ctx.stroke();

  // Top lip ellipse (rim of cup looking down)
  ctx.fillStyle = edge;
  ctx.beginPath();
  ctx.ellipse(c.x, topY, topHalf, 6, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.ellipse(c.x, topY, topHalf - 3, 4, 0, 0, Math.PI * 2);
  ctx.fill();

  // Side highlight
  ctx.strokeStyle = shine;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(c.x - topHalf + 6, topY + 8);
  ctx.lineTo(c.x - botHalf + 10, botY - 10);
  ctx.stroke();

  // Bottom rim line (only when lifted enough)
  if (lift > 0.05) {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.beginPath();
    ctx.ellipse(c.x, botY, botHalf, 5, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  void shine;
  void CUP_LIP;
}

function drawBall(): void {
  // Determine ball position: under the cup at logical index ballIdx.
  // During 'result' phase show ball at correct cup's x even if lifted.
  // During 'choose' phase ball is hidden under cup (we still draw, but cup
  // covers it because lift is 0).
  const cup = cups[ballIdx]!;
  const lift = cup.liftT;
  const liftPx = lift * 90;
  const y = FLOOR_Y - liftPx - BALL_R - 4;
  const x = cup.x;

  // Only draw if visible (cup is lifted enough) — otherwise it'd be drawn
  // below the floor band visually.
  if (lift < 0.05 && phase !== 'result') return;

  ctx.fillStyle = getCss('--ball', '#fbbf24');
  ctx.beginPath();
  ctx.arc(x, y, BALL_R, 0, Math.PI * 2);
  ctx.fill();

  // Shine
  ctx.fillStyle = getCss('--ball-shine', '#fde68a');
  ctx.beginPath();
  ctx.arc(x - 4, y - 4, BALL_R / 2.4, 0, Math.PI * 2);
  ctx.fill();
}

function updateHud(): void {
  roundEl.textContent = String(round);
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
}

function commitBest(): void {
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
    bestEl.textContent = String(best);
  }
}

function reset(): void {
  gen.bump();
  if (rafHandle) {
    cancelAnimationFrame(rafHandle);
    rafHandle = 0;
  }
  phase = 'ready';
  round = 1;
  score = 0;
  cupCount = 3;
  buildCups();
  ballIdx = 0;
  pickedIdx = null;
  lastCorrect = null;
  shuffleQueue = [];
  currentSwap = null;
  updateHud();
  showOverlay('Bardak Altında', 'Bilyeyi takip et, karıştırma bitince doğru bardağa tıkla. Başlamak için tıkla.');
  // Idle draw
  const token = gen.bump();
  ensureLoop(token);
}

function handlePointer(clientX: number, clientY: number): void {
  if (phase === 'ready') {
    score = 0;
    round = 1;
    updateHud();
    startRound();
    return;
  }
  if (phase !== 'choose') return;

  const rect = canvas.getBoundingClientRect();
  const x = ((clientX - rect.left) / rect.width) * canvas.width;
  const y = ((clientY - rect.top) / rect.height) * canvas.height;

  // Hit test against cups (use cup base area)
  let hit = -1;
  let bestDist = Infinity;
  for (let i = 0; i < cups.length; i++) {
    const c = cups[i]!;
    const dx = Math.abs(x - c.x);
    if (dx <= CUP_W / 2 + 4 && y >= FLOOR_Y - CUP_H - 4 && y <= FLOOR_Y + 12) {
      if (dx < bestDist) {
        bestDist = dx;
        hit = i;
      }
    }
  }
  if (hit === -1) return;

  pickedIdx = hit;
  lastCorrect = hit === ballIdx;
  if (lastCorrect) {
    score += 1;
    commitBest();
    updateHud();
  }
  // Lift all cups so the truth is shown.
  for (const c of cups) c.liftTarget = 1;
  phase = 'result';
  phaseTimer = lastCorrect ? 950 : 1700;
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  roundEl = document.querySelector<HTMLElement>('#round')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlayEl = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  canvas.addEventListener('pointerdown', (e) => {
    handlePointer(e.clientX, e.clientY);
    e.preventDefault();
  });

  overlayEl.addEventListener('pointerdown', (e) => {
    if (phase === 'ready') {
      handlePointer(e.clientX, e.clientY);
      e.preventDefault();
    }
  });

  restartBtn.addEventListener('click', () => {
    reset();
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'r' || e.key === 'R') {
      reset();
      e.preventDefault();
    }
  });

  reset();
}

export const game = defineGame({ init, reset });
