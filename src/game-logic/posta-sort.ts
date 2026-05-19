// ---------------------------------------------------------------------------
// Posta Sort — Real-time mail sorting office
// State machine: Ready | Playing | GameOver
// Domain: postal sorting (Tohum 3 — gerçek dünya domeni).
// Twist: every N correct sorts, two bay assignments swap, forcing observation.
//
// Pitfalls addressed:
//   - visual-vs-hitbox: bay rect (drawn + clickable) reads SAME geometry consts
//   - overlay-input-leak: explicit `state` enum; ALL input routes through
//     handleKey/handlePointer with `state` switch and default `return`
//   - stale-async-callback: `frameToken` bumped on every reset(); rAF callbacks
//     bail if their token is stale; setTimeout uses same guard
//   - invisible-boot: first parcel spawns at visible Y on Start; pulse flash
//     paints within first frame so <250ms feedback is guaranteed
//   - unguarded-storage: safeRead/safeWrite helpers; no module-level localStorage
//   - duplicate-with-shared-layer: body has no <h1>, no <p class="hint">; controls
//     come from JSON via GameLayout
// ---------------------------------------------------------------------------

type State = 'ready' | 'playing' | 'gameover';

interface Parcel {
  /** Which city this parcel needs to go to (0..CITIES.length-1). */
  cityIdx: number;
  /** Vertical position; FLOOR_Y triggers "missed". */
  y: number;
  /** Fall speed in canvas px per frame (assuming 60fps). */
  speed: number;
  /** Frames remaining of the "sorting" animation (0 = normal falling). */
  flash: number;
  /** Direction of in-flight bay travel during flash. */
  flashKind: 'good' | 'bad' | null;
  /** Bay index this parcel was routed to (during flash animation). */
  routedBay: number;
  /** Horizontal offset during flash, in canvas pixels (animated towards bay). */
  flashX: number;
}

// ── Constants ──────────────────────────────────────────────────────────────
const CANVAS_W = 480;
const CANVAS_H = 640;

const BAYS = 5;
const BAY_AREA_H = 110; // pixels at the bottom reserved for bay drawing
const BAY_W = CANVAS_W / BAYS; // 96
const BAY_Y = CANVAS_H - BAY_AREA_H; // top edge of bay row
const BAY_BOX_H = BAY_AREA_H - 18; // visible bay rectangle height

const PARCEL_SIZE = 56;
const PARCEL_HALF = PARCEL_SIZE / 2;
const PARCEL_SPAWN_X = CANVAS_W / 2;
const PARCEL_SPAWN_Y = 40; // visible spawn so first frame is non-empty
const PARCEL_FLOOR_Y = BAY_Y - 6; // when parcel center crosses, it's "missed"

const BASE_SPEED_PER_FRAME = 1.0; // pixels per frame (at 60fps target)
const SPEED_INC_PER_SORT = 0.025;
const SPEED_MAX = 3.8;

const FLASH_FRAMES = 14; // animation length when routing a parcel
const MAX_STRIKES = 3;
const SWAP_EVERY = 8; // remap two bays every N correct sorts

const STORAGE_KEY = 'posta-sort.best';

// 5 Turkish cities — short labels (3-letter codes).
const CITIES = ['IST', 'ANK', 'IZM', 'BUR', 'ADA'] as const;
const BAY_COLOR_VARS = [
  '--ps-bay-1',
  '--ps-bay-2',
  '--ps-bay-3',
  '--ps-bay-4',
  '--ps-bay-5',
];

// ── DOM refs ───────────────────────────────────────────────────────────────
const canvas = document.querySelector<HTMLCanvasElement>('#board')!;
const ctx = canvas.getContext('2d')!;
const scoreEl = document.querySelector<HTMLElement>('#score')!;
const bestEl = document.querySelector<HTMLElement>('#best')!;
const strike1El = document.querySelector<HTMLElement>('#strike-1')!;
const strike2El = document.querySelector<HTMLElement>('#strike-2')!;
const strike3El = document.querySelector<HTMLElement>('#strike-3')!;
const overlay = document.querySelector<HTMLElement>('#overlay')!;
const overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
const overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
const restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;

// ── Safe storage ───────────────────────────────────────────────────────────
function safeReadBest(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const n = raw ? Number(raw) : 0;
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function safeWriteBest(n: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(n));
  } catch {
    /* ignore */
  }
}

// ── CSS var cache ──────────────────────────────────────────────────────────
const cssCache = new Map<string, string>();
function getCss(varName: string): string {
  const cached = cssCache.get(varName);
  if (cached !== undefined) return cached;
  const val = getComputedStyle(document.documentElement)
    .getPropertyValue(varName)
    .trim();
  cssCache.set(varName, val);
  return val;
}

// ── Game state ─────────────────────────────────────────────────────────────
let state: State = 'ready';
let score = 0;
let best = 0;
let strikes = 0;
/** Map from bay index (0..BAYS-1) to city index (0..CITIES.length-1). */
let bayAssignment: number[] = [0, 1, 2, 3, 4];
/** The single parcel currently falling (or being animated). null = none. */
let parcel: Parcel | null = null;
/** Visual pulse on bays (good/bad flash). */
let bayPulse: Array<{ frames: number; kind: 'good' | 'bad' }> = [];
/** Tracks correct sorts since last swap. */
let sortsSinceSwap = 0;
/** Bumped on every reset(); guards all rAF/setTimeout callbacks. */
let frameToken = 0;
let rafId: number | null = null;

// ── Helpers ────────────────────────────────────────────────────────────────
function shuffledBayAssignment(): number[] {
  // Start with a fresh permutation of [0..4].
  const a = [0, 1, 2, 3, 4];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const ai = a[i]!;
    const aj = a[j]!;
    a[i] = aj;
    a[j] = ai;
  }
  return a;
}

function swapTwoBays(): void {
  if (BAYS < 2) return;
  const i = Math.floor(Math.random() * BAYS);
  let j = Math.floor(Math.random() * BAYS);
  while (j === i) j = Math.floor(Math.random() * BAYS);
  const ai = bayAssignment[i]!;
  const aj = bayAssignment[j]!;
  bayAssignment[i] = aj;
  bayAssignment[j] = ai;
  // Visual notice: pulse both swapped bays briefly.
  bayPulse[i] = { frames: 22, kind: 'good' };
  bayPulse[j] = { frames: 22, kind: 'good' };
}

function currentSpeed(): number {
  return Math.min(SPEED_MAX, BASE_SPEED_PER_FRAME + score * SPEED_INC_PER_SORT);
}

function spawnParcel(): void {
  const cityIdx = Math.floor(Math.random() * CITIES.length);
  parcel = {
    cityIdx,
    y: PARCEL_SPAWN_Y,
    speed: currentSpeed(),
    flash: 0,
    flashKind: null,
    routedBay: -1,
    flashX: 0,
  };
}

function bayCenterX(bayIdx: number): number {
  return bayIdx * BAY_W + BAY_W / 2;
}

function updateStrikesDisplay(): void {
  const els = [strike1El, strike2El, strike3El];
  for (let i = 0; i < MAX_STRIKES; i++) {
    const el = els[i];
    if (!el) continue;
    el.classList.toggle('strike--used', i < strikes);
  }
}

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.innerHTML = msg;
  overlay.classList.remove('overlay--hidden');
}

function hideOverlay(): void {
  overlay.classList.add('overlay--hidden');
}

// ── Routing ────────────────────────────────────────────────────────────────
function routeToBay(bayIdx: number): void {
  if (state !== 'playing') return;
  if (!parcel) return;
  if (parcel.flash > 0) return; // already being animated
  if (bayIdx < 0 || bayIdx >= BAYS) return;

  const targetCity = bayAssignment[bayIdx]!;
  const isCorrect = targetCity === parcel.cityIdx;

  parcel.flash = FLASH_FRAMES;
  parcel.flashKind = isCorrect ? 'good' : 'bad';
  parcel.routedBay = bayIdx;
  parcel.flashX = 0;

  bayPulse[bayIdx] = {
    frames: FLASH_FRAMES,
    kind: isCorrect ? 'good' : 'bad',
  };

  if (isCorrect) {
    score++;
    scoreEl.textContent = String(score);
    if (score > best) {
      best = score;
      bestEl.textContent = String(best);
      safeWriteBest(best);
    }
    sortsSinceSwap++;
    if (sortsSinceSwap >= SWAP_EVERY) {
      sortsSinceSwap = 0;
      swapTwoBays();
    }
  } else {
    strikes++;
    updateStrikesDisplay();
  }
}

function onParcelGone(): void {
  // Called after flash animation completes.
  if (state !== 'playing') return;
  if (strikes >= MAX_STRIKES) {
    endGame();
    return;
  }
  spawnParcel();
}

function missedParcel(): void {
  if (state !== 'playing') return;
  if (!parcel) return;
  strikes++;
  updateStrikesDisplay();
  // Visual: pulse all bays red briefly.
  for (let i = 0; i < BAYS; i++) {
    bayPulse[i] = { frames: 10, kind: 'bad' };
  }
  parcel = null;
  if (strikes >= MAX_STRIKES) {
    endGame();
    return;
  }
  spawnParcel();
}

// ── Game loop ──────────────────────────────────────────────────────────────
function gameLoop(token: number): void {
  if (token !== frameToken) return; // stale guard
  if (state !== 'playing') return;
  rafId = requestAnimationFrame(() => gameLoop(token));

  // Update parcel
  if (parcel) {
    if (parcel.flash > 0) {
      parcel.flash--;
      // Animate towards routed bay
      const targetX = bayCenterX(parcel.routedBay) - PARCEL_SPAWN_X;
      const t = 1 - parcel.flash / FLASH_FRAMES;
      parcel.flashX = targetX * t;
      // Sink towards bay
      parcel.y += (BAY_Y + BAY_BOX_H / 2 - parcel.y) * 0.18;
      if (parcel.flash === 0) {
        parcel = null;
        onParcelGone();
      }
    } else {
      parcel.y += parcel.speed;
      if (parcel.y >= PARCEL_FLOOR_Y) {
        missedParcel();
      }
    }
  }

  // Update bay pulses
  for (let i = 0; i < BAYS; i++) {
    const p = bayPulse[i];
    if (p && p.frames > 0) {
      p.frames--;
      if (p.frames === 0) bayPulse[i] = { frames: 0, kind: 'good' };
    }
  }

  draw();
}

// ── Draw ───────────────────────────────────────────────────────────────────
function draw(): void {
  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

  // Background
  ctx.fillStyle = getCss('--surface');
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  // Conveyor belt strip (center)
  drawBelt();

  // Bays (bottom)
  drawBays();

  // Parcel (last, so it sits on top)
  drawParcel();

  // Strike line indicator
  if (state !== 'ready') {
    ctx.save();
    ctx.strokeStyle = getCss('--border-strong');
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.moveTo(0, PARCEL_FLOOR_Y);
    ctx.lineTo(CANVAS_W, PARCEL_FLOOR_Y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }
}

function drawBelt(): void {
  // Vertical conveyor: single lane in the middle.
  const beltW = 160;
  const beltX = (CANVAS_W - beltW) / 2;
  const beltTop = 0;
  const beltBottom = BAY_Y;
  ctx.fillStyle = getCss('--ps-belt');
  ctx.fillRect(beltX, beltTop, beltW, beltBottom - beltTop);

  // Belt edges
  ctx.strokeStyle = getCss('--ps-belt-edge');
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(beltX + 0.5, beltTop);
  ctx.lineTo(beltX + 0.5, beltBottom);
  ctx.moveTo(beltX + beltW - 0.5, beltTop);
  ctx.lineTo(beltX + beltW - 0.5, beltBottom);
  ctx.stroke();

  // Subtle tick marks for movement feel
  ctx.fillStyle = getCss('--border');
  for (let y = 24; y < beltBottom; y += 24) {
    ctx.fillRect(beltX + 10, y, beltW - 20, 1);
  }
}

function drawBays(): void {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (let i = 0; i < BAYS; i++) {
    const cityIdx = bayAssignment[i]!;
    const city = CITIES[cityIdx]!;
    const colorVar = BAY_COLOR_VARS[i % BAY_COLOR_VARS.length]!;
    const baseColor = getCss(colorVar);

    const x = i * BAY_W + 4;
    const y = BAY_Y + 4;
    const w = BAY_W - 8;
    const h = BAY_BOX_H;

    // Pulse fill (good/bad)
    const pulse = bayPulse[i];
    if (pulse && pulse.frames > 0) {
      const alpha = pulse.frames / Math.max(1, FLASH_FRAMES);
      const pulseColor =
        pulse.kind === 'good' ? getCss('--ps-good') : getCss('--ps-bad');
      ctx.save();
      ctx.globalAlpha = 0.35 * alpha;
      ctx.fillStyle = pulseColor;
      ctx.fillRect(x, y, w, h);
      ctx.restore();
    }

    // Bay outline
    ctx.strokeStyle = baseColor;
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);

    // City code (large)
    ctx.fillStyle = baseColor;
    ctx.font = 'bold 22px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(city, x + w / 2, y + h / 2 - 8);

    // Key hint (small)
    ctx.fillStyle = getCss('--text-dim');
    ctx.font = '11px ui-monospace, monospace';
    ctx.fillText(`[${i + 1}]`, x + w / 2, y + h / 2 + 16);
  }
}

function drawParcel(): void {
  if (!parcel) return;
  const cx = PARCEL_SPAWN_X + parcel.flashX;
  const cy = parcel.y;
  const cityIdx = parcel.cityIdx;
  const city = CITIES[cityIdx]!;

  ctx.save();
  // Shadow
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 3;

  // Parcel body (paper-brown)
  const isFlashing = parcel.flash > 0;
  const baseFill = '#caa17b';
  const flashFill =
    parcel.flashKind === 'good'
      ? getCss('--ps-good')
      : parcel.flashKind === 'bad'
        ? getCss('--ps-bad')
        : baseFill;
  ctx.fillStyle = isFlashing ? flashFill : baseFill;

  ctx.fillRect(
    cx - PARCEL_HALF,
    cy - PARCEL_HALF,
    PARCEL_SIZE,
    PARCEL_SIZE,
  );
  ctx.restore();

  // Tape strip
  ctx.fillStyle = '#a07b5a';
  ctx.fillRect(cx - PARCEL_HALF, cy - 4, PARCEL_SIZE, 8);

  // Label background
  ctx.fillStyle = '#fef3c7';
  ctx.fillRect(cx - 22, cy - 18, 44, 16);
  ctx.strokeStyle = '#92400e';
  ctx.lineWidth = 1;
  ctx.strokeRect(cx - 21.5, cy - 17.5, 43, 15);

  // City code on label
  ctx.fillStyle = '#3f1d04';
  ctx.font = 'bold 11px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(city, cx, cy - 10);
}

// ── Input ──────────────────────────────────────────────────────────────────
function handleKey(e: KeyboardEvent): void {
  const k = e.key;

  if (state === 'ready') {
    if (k === ' ' || k === 'Enter') {
      e.preventDefault();
      startGame();
      return;
    }
    if (k >= '1' && k <= String(BAYS)) {
      // Number key also starts the game (so first feedback is immediate).
      e.preventDefault();
      startGame();
      // Route the first parcel with this key.
      routeToBay(Number(k) - 1);
      return;
    }
    return;
  }

  if (state === 'gameover') {
    if (
      k === ' ' ||
      k === 'Enter' ||
      k.toLowerCase() === 'r' ||
      (k >= '1' && k <= String(BAYS))
    ) {
      e.preventDefault();
      reset();
      startGame();
      return;
    }
    return;
  }

  // state === 'playing'
  if (k >= '1' && k <= String(BAYS)) {
    e.preventDefault();
    routeToBay(Number(k) - 1);
    return;
  }
  if (k.toLowerCase() === 'r') {
    e.preventDefault();
    reset();
    return;
  }
  // default: ignore (no preventDefault on browser shortcuts)
}

function pickBayFromPointer(clientX: number, clientY: number): number {
  const rect = canvas.getBoundingClientRect();
  const scaleX = CANVAS_W / rect.width;
  const scaleY = CANVAS_H / rect.height;
  const x = (clientX - rect.left) * scaleX;
  const y = (clientY - rect.top) * scaleY;
  // Only bay area is clickable
  if (y < BAY_Y || y > BAY_Y + BAY_BOX_H + 4) return -1;
  if (x < 0 || x >= CANVAS_W) return -1;
  return Math.floor(x / BAY_W);
}

function handlePointer(e: PointerEvent): void {
  e.preventDefault();

  if (state === 'ready') {
    startGame();
    const idx = pickBayFromPointer(e.clientX, e.clientY);
    if (idx >= 0) routeToBay(idx);
    return;
  }
  if (state === 'gameover') {
    reset();
    startGame();
    return;
  }
  // state === 'playing'
  const idx = pickBayFromPointer(e.clientX, e.clientY);
  if (idx >= 0) routeToBay(idx);
}

// ── Lifecycle ──────────────────────────────────────────────────────────────
function startGame(): void {
  if (state === 'playing') return;
  state = 'playing';
  hideOverlay();
  // Ensure a parcel is on screen immediately for <250ms feedback.
  if (!parcel) spawnParcel();
  // Kick off rAF loop.
  const t = frameToken;
  // Initial draw so the first frame contains the parcel without waiting.
  draw();
  if (rafId !== null) cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(() => gameLoop(t));
}

function endGame(): void {
  state = 'gameover';
  parcel = null;
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  draw();
  showOverlay(
    'Posta kapandı',
    `Skor: ${score}<br />En iyi: ${best}<br /><small>Boşluk / 1-5 / tıkla → yeni gün</small>`,
  );
}

function reset(): void {
  // Bump generation token to invalidate any in-flight rAF/setTimeout.
  frameToken++;
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }

  state = 'ready';
  score = 0;
  strikes = 0;
  sortsSinceSwap = 0;
  bayAssignment = shuffledBayAssignment();
  parcel = null;
  bayPulse = [];
  for (let i = 0; i < BAYS; i++) {
    bayPulse[i] = { frames: 0, kind: 'good' };
  }
  best = safeReadBest();

  scoreEl.textContent = '0';
  bestEl.textContent = String(best);
  updateStrikesDisplay();
  draw();
  showOverlay(
    'Posta Sort',
    'Düşen pakedi doğru şehir gözüne yolla.<br />Boşluk veya 1-5 ile başla.',
  );
}

// ── Init ───────────────────────────────────────────────────────────────────
window.addEventListener('keydown', handleKey);
canvas.addEventListener('pointerdown', handlePointer);
restartBtn.addEventListener('click', () => {
  reset();
});

reset();
