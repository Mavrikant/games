import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';

// PITFALLS guarded:
// - unguarded-storage: safeRead/safeWrite wrap localStorage.
// - stale-async-callback: gen-token guards the RAF loop after reset (R-spam safe).
// - overlay-input-leak: explicit `state` enum; overlay swallows pointer; canvas
//   handler early-returns when state !== 'playing'.
// - module-level-dom-access: all DOM/storage access lives in init().
// - missing-overlay-css: per-game CSS defines .overlay--hidden visual collapse.
// - visual-vs-hitbox: slotCenter(i) drives both rendering and hit-testing.
// - invisible-boot: first frame already shows drum + 6 queued frames before any
//   gravity/vibration ticks, so the player sees a populated scene immediately.
// - hud-counter-synced-only-at-lifecycle-edges: scoreEl/crackEl are written from
//   inside tick() each frame, not only at start/end.
// - designed-lose-condition-not-wired: cracks >= MAX_CRACKS triggers endGame()
//   inside the same tick that detected it.

const STORAGE_BEST = 'bal-suzme.best';

const CANVAS_W = 480;
const CANVAS_H = 600;

const DRUM_CX = 240;
const DRUM_CY = 230;
const DRUM_R = 170;
const HUB_R = 38;
const SLOT_DIST = 108;
const SLOT_HIT_R = 46;        // hit radius around each slot center (visual + hitbox share this)
const FRAME_W = 64;
const FRAME_H = 80;

const SLOT_ANGLES = [
  -Math.PI / 2, // 0: top
  0,            // 1: right
  Math.PI / 2,  // 2: bottom
  Math.PI,      // 3: left
];
const SLOT_COUNT = 4;

const QUEUE_SHOW = 4;
const QUEUE_Y = 470;
const FRAME_QW = 60;
const FRAME_QH = 80;
const QUEUE_GAP = 10;

const BASE_SPIN = 0.9;
const BOOST_SPIN = 2.0;
const SPIN_ACCEL = 2.0;       // per second toward boost target
const SPIN_DECAY = 1.6;       // per second toward base target

const DRAIN_PER_SEC = 7;      // fill-units per loaded slot per second at speed=1.0
const VIB_GAIN_K = 0.30;      // per second: imbalance × speed² × K
const VIB_DECAY = 12;         // per second baseline decay
const VIB_DECAY_CALM = 22;    // per second decay when imbalance < 4
const VIB_MAX = 100;
const MAX_CRACKS = 3;

const FILL_MIN = 60;
const FILL_MAX = 100;
const REPLENISH_SECS = 2.6;
const QUEUE_INITIAL = 6;

type State = 'ready' | 'playing' | 'gameover';

interface Slot {
  loaded: boolean;
  fill: number;
  breakProgress: number; // 0 quiet → 1 freshly broken; decays
}

interface QueueFrame {
  fill: number;
}

const gen = createGenToken();
let state: State = 'ready';
let playMs = 0;
let lastTickMs = 0;
let speed = BASE_SPIN;
let drumAngle = 0;
let vibration = 0;
let cracks = 0;
let honey = 0;
let best = 0;
let slots: Slot[] = freshSlots();
let queue: QueueFrame[] = [];
let replenishTimer = 0;
let boostHeld = false;
let lastCrackFlashMs = -9999;
let rafHandle: number | null = null;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let honeyEl!: HTMLElement;
let bestEl!: HTMLElement;
let crackEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;

function freshSlots(): Slot[] {
  const arr: Slot[] = [];
  for (let i = 0; i < SLOT_COUNT; i++) {
    arr.push({ loaded: false, fill: 0, breakProgress: 0 });
  }
  return arr;
}

function randFill(): number {
  return FILL_MIN + Math.random() * (FILL_MAX - FILL_MIN);
}

function newQueueFrame(): QueueFrame {
  return { fill: randFill() };
}

function slotCenter(i: number): { x: number; y: number } {
  const a = SLOT_ANGLES[i]!;
  return {
    x: DRUM_CX + Math.cos(a) * SLOT_DIST,
    y: DRUM_CY + Math.sin(a) * SLOT_DIST,
  };
}

function loadOrEjectSlot(i: number): void {
  if (state !== 'playing') return;
  const slot = slots[i]!;
  if (slot.loaded) {
    slot.loaded = false;
    slot.fill = 0;
    return;
  }
  if (queue.length === 0) return;
  const frame = queue.shift()!;
  slot.loaded = true;
  slot.fill = frame.fill;
}

function fillOf(i: number): number {
  const s = slots[i]!;
  return s.loaded ? s.fill : 0;
}

function computeImbalance(): number {
  const tb = Math.abs(fillOf(0) - fillOf(2));
  const lr = Math.abs(fillOf(1) - fillOf(3));
  return (tb + lr) / 2;
}

function applyCrack(): void {
  const loaded: number[] = [];
  for (let i = 0; i < SLOT_COUNT; i++) {
    if (slots[i]!.loaded) loaded.push(i);
  }
  vibration = 0;
  if (loaded.length === 0) return; // nothing to break this round
  const idx = loaded[Math.floor(Math.random() * loaded.length)]!;
  slots[idx]!.loaded = false;
  slots[idx]!.fill = 0;
  slots[idx]!.breakProgress = 1;
  cracks++;
  lastCrackFlashMs = playMs;
}

function tick(now: number, myGen: number): void {
  if (!gen.isCurrent(myGen)) {
    rafHandle = null;
    return;
  }
  if (state !== 'playing') {
    rafHandle = null;
    return;
  }
  const rawDt = now - lastTickMs;
  lastTickMs = now;
  const dt = Math.min(48, rawDt);
  const dtSec = dt / 1000;
  playMs += dt;

  // Speed updates toward target
  const target = boostHeld ? BOOST_SPIN : BASE_SPIN;
  if (speed < target) {
    speed = Math.min(target, speed + SPIN_ACCEL * dtSec);
  } else if (speed > target) {
    speed = Math.max(target, speed - SPIN_DECAY * dtSec);
  }

  drumAngle += speed * 1.6 * dtSec;

  // Drain frames
  let drained = 0;
  for (const s of slots) {
    if (!s.loaded) continue;
    const drain = DRAIN_PER_SEC * speed * dtSec;
    const take = Math.min(s.fill, drain);
    s.fill -= take;
    drained += take;
    if (s.fill <= 0.001) {
      s.loaded = false;
      s.fill = 0;
    }
  }
  honey += drained;

  // Vibration update
  const imbalance = computeImbalance();
  const gain = imbalance * speed * speed * VIB_GAIN_K * dtSec;
  const decay = (imbalance < 4 ? VIB_DECAY_CALM : VIB_DECAY) * dtSec;
  vibration = Math.max(0, vibration + gain - decay);
  if (vibration >= VIB_MAX) {
    applyCrack();
  }

  // Replenish queue (capped)
  replenishTimer += dtSec;
  if (replenishTimer >= REPLENISH_SECS) {
    replenishTimer = 0;
    if (queue.length < 10) queue.push(newQueueFrame());
  }

  // Break flash fade
  for (const s of slots) {
    if (s.breakProgress > 0) {
      s.breakProgress = Math.max(0, s.breakProgress - dtSec * 1.6);
    }
  }

  // HUD per frame
  honeyEl.textContent = String(Math.floor(honey));
  crackEl.textContent = `${cracks}/${MAX_CRACKS}`;

  // Lose check
  if (cracks >= MAX_CRACKS) {
    endGame();
    draw();
    return;
  }

  draw();
  rafHandle = requestAnimationFrame((t) => tick(t, myGen));
}

function startLoop(): void {
  if (rafHandle !== null) return;
  const myGen = gen.current();
  lastTickMs = performance.now();
  rafHandle = requestAnimationFrame((t) => tick(t, myGen));
}

function stopLoop(): void {
  if (rafHandle !== null) {
    cancelAnimationFrame(rafHandle);
    rafHandle = null;
  }
}

function startGame(): void {
  if (state === 'playing') return;
  gen.bump();
  state = 'playing';
  playMs = 0;
  speed = BASE_SPIN;
  drumAngle = 0;
  vibration = 0;
  cracks = 0;
  honey = 0;
  slots = freshSlots();
  queue = [];
  for (let i = 0; i < QUEUE_INITIAL; i++) queue.push(newQueueFrame());
  replenishTimer = 0;
  boostHeld = false;
  lastCrackFlashMs = -9999;
  honeyEl.textContent = '0';
  crackEl.textContent = `0/${MAX_CRACKS}`;
  hideOverlayEl(overlay);
  startLoop();
}

function endGame(): void {
  state = 'gameover';
  stopLoop();
  const finalScore = Math.floor(honey);
  if (finalScore > best) {
    best = finalScore;
    safeWrite(STORAGE_BEST, best);
    bestEl.textContent = String(best);
  }
  overlayTitle.textContent = 'Tambur kırıldı!';
  overlayMsg.textContent = `Topladığın bal: ${finalScore} kg\nDokun veya R ile tekrar dene.`;
  showOverlayEl(overlay);
}

function reset(): void {
  gen.bump();
  stopLoop();
  state = 'ready';
  playMs = 0;
  speed = BASE_SPIN;
  drumAngle = 0;
  vibration = 0;
  cracks = 0;
  honey = 0;
  slots = freshSlots();
  queue = [];
  for (let i = 0; i < QUEUE_INITIAL; i++) queue.push(newQueueFrame());
  replenishTimer = 0;
  boostHeld = false;
  lastCrackFlashMs = -9999;
  honeyEl.textContent = '0';
  crackEl.textContent = `0/${MAX_CRACKS}`;
  bestEl.textContent = String(best);
  overlayTitle.textContent = 'Bal Süzme';
  overlayMsg.textContent =
    'Petekleri dengeli yerleştir, kolu çevir.\nDengesizlik titreşim yapar; yüksek hızda tambur kırılır.\nBaşlamak için tıkla.';
  showOverlayEl(overlay);
  draw();
}

// ---------- Rendering ----------

function shakeOffset(): { x: number; y: number } {
  const intensity = vibration / VIB_MAX;
  const recentCrack = playMs - lastCrackFlashMs < 360;
  const i2 = recentCrack ? Math.max(intensity, 0.9) : intensity;
  if (i2 < 0.35) return { x: 0, y: 0 };
  const k = (i2 - 0.35) / 0.65;
  const amp = k * k * 7;
  return {
    x: (Math.random() - 0.5) * amp,
    y: (Math.random() - 0.5) * amp,
  };
}

function drawBg(): void {
  const grad = ctx.createLinearGradient(0, 0, 0, CANVAS_H);
  grad.addColorStop(0, '#1d1305');
  grad.addColorStop(1, '#0b0703');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  // Floor shadow under the drum to anchor it visually
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.beginPath();
  ctx.ellipse(DRUM_CX, DRUM_CY + DRUM_R + 14, DRUM_R * 0.85, 12, 0, 0, Math.PI * 2);
  ctx.fill();
}

function drawBalanceHint(): void {
  ctx.save();
  ctx.strokeStyle = 'rgba(120, 220, 255, 0.07)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(DRUM_CX, DRUM_CY - SLOT_DIST - 36);
  ctx.lineTo(DRUM_CX, DRUM_CY + SLOT_DIST + 36);
  ctx.moveTo(DRUM_CX - SLOT_DIST - 36, DRUM_CY);
  ctx.lineTo(DRUM_CX + SLOT_DIST + 36, DRUM_CY);
  ctx.stroke();
  ctx.restore();
}

function drawDrum(off: { x: number; y: number }): void {
  ctx.save();
  ctx.translate(off.x, off.y);

  // Outer shell
  ctx.beginPath();
  ctx.arc(DRUM_CX, DRUM_CY, DRUM_R + 6, 0, Math.PI * 2);
  ctx.fillStyle = '#3a3a44';
  ctx.fill();

  // Inner bowl
  ctx.beginPath();
  ctx.arc(DRUM_CX, DRUM_CY, DRUM_R, 0, Math.PI * 2);
  ctx.fillStyle = '#23232a';
  ctx.fill();

  // Inner ring decoration
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  for (let r = 50; r < DRUM_R; r += 30) {
    ctx.beginPath();
    ctx.arc(DRUM_CX, DRUM_CY, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Spinning hub
  ctx.save();
  ctx.translate(DRUM_CX, DRUM_CY);
  ctx.rotate(drumAngle);
  ctx.fillStyle = '#5d4310';
  ctx.beginPath();
  ctx.arc(0, 0, HUB_R, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ffb84a';
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, HUB_R - 4, a, a + 0.22);
    ctx.closePath();
    ctx.fill();
  }
  ctx.fillStyle = '#2a1a05';
  ctx.beginPath();
  ctx.arc(0, 0, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Slots
  for (let i = 0; i < SLOT_COUNT; i++) {
    const c = slotCenter(i);
    drawSlot(c.x, c.y, SLOT_ANGLES[i]!, slots[i]!);
  }

  // Vibration ring on outer drum
  const vibFrac = Math.min(1, vibration / VIB_MAX);
  if (vibFrac > 0.05) {
    const g = Math.floor(180 - 180 * vibFrac);
    ctx.strokeStyle = `rgba(255, ${g}, 40, ${0.55 + 0.4 * vibFrac})`;
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(DRUM_CX, DRUM_CY, DRUM_R - 3, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * vibFrac);
    ctx.stroke();
  }

  ctx.restore();
}

function roundRect(x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawSlot(cx: number, cy: number, angle: number, slot: Slot): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle + Math.PI / 2);
  const w = FRAME_W;
  const h = FRAME_H;

  // Frame backing
  ctx.fillStyle = '#1a1208';
  roundRect(-w / 2, -h / 2, w, h, 8);
  ctx.fill();
  ctx.strokeStyle = '#544020';
  ctx.lineWidth = 2;
  ctx.stroke();

  if (slot.loaded) {
    const fillH = (slot.fill / 100) * (h - 6);
    const y0 = h / 2 - 3 - fillH;
    const grad = ctx.createLinearGradient(0, y0, 0, h / 2 - 3);
    grad.addColorStop(0, '#ffcc4a');
    grad.addColorStop(1, '#b87a0a');
    ctx.save();
    ctx.beginPath();
    roundRect(-w / 2 + 3, -h / 2 + 3, w - 6, h - 6, 5);
    ctx.clip();
    ctx.fillStyle = grad;
    ctx.fillRect(-w / 2 + 3, y0, w - 6, fillH);

    // Honeycomb dot pattern overlay (only in filled region)
    ctx.fillStyle = 'rgba(60,30,5,0.4)';
    for (let gy = -h / 2 + 8; gy < h / 2 - 4; gy += 9) {
      const ox = ((gy / 9) | 0) % 2 === 0 ? 0 : 4;
      for (let gx = -w / 2 + 6; gx < w / 2 - 4; gx += 9) {
        if (gy < y0 - 2) continue;
        ctx.beginPath();
        ctx.arc(gx + ox, gy, 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();

    // Fill percentage text
    ctx.fillStyle = '#fffae3';
    ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${Math.round(slot.fill)}`, 0, -h / 2 + 12);
  } else {
    // Empty slot prompt
    ctx.strokeStyle = 'rgba(255, 200, 100, 0.35)';
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1.5;
    ctx.strokeRect(-w / 2 + 4, -h / 2 + 4, w - 8, h - 8);
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255, 220, 140, 0.55)';
    ctx.font = 'bold 20px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('+', 0, 0);
  }

  // Break flash
  if (slot.breakProgress > 0) {
    ctx.fillStyle = `rgba(255, 60, 60, ${0.5 * slot.breakProgress})`;
    roundRect(-w / 2, -h / 2, w, h, 8);
    ctx.fill();
  }

  ctx.restore();
}

function drawSpeedGauge(): void {
  const gx = 14;
  const gy = 60;
  const gw = 14;
  const gh = 200;
  ctx.fillStyle = '#15140e';
  ctx.fillRect(gx, gy, gw, gh);
  const frac = Math.min(1, speed / BOOST_SPIN);
  const fh = gh * frac;
  // gradient: green at base, orange when boosting
  const boostFrac = Math.max(0, (speed - BASE_SPIN) / (BOOST_SPIN - BASE_SPIN));
  const r = Math.floor(95 + 160 * boostFrac);
  const g = Math.floor(191 - 130 * boostFrac);
  const b = Math.floor(106 - 60 * boostFrac);
  ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
  ctx.fillRect(gx, gy + gh - fh, gw, fh);
  // base marker (the resting speed)
  const baseY = gy + gh - gh * (BASE_SPIN / BOOST_SPIN);
  ctx.strokeStyle = 'rgba(255,255,255,0.4)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(gx - 2, baseY);
  ctx.lineTo(gx + gw + 2, baseY);
  ctx.stroke();
  ctx.strokeStyle = '#3a3a44';
  ctx.strokeRect(gx, gy, gw, gh);
  ctx.fillStyle = '#aaa';
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('HIZ', gx - 2, gy - 14);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = 'rgba(160,160,160,0.65)';
  ctx.fillText('boşluk', gx - 4, gy + gh + 4);
}

function drawVibGauge(): void {
  const vx = CANVAS_W - 28;
  const vy = 60;
  const vw = 14;
  const vh = 200;
  ctx.fillStyle = '#15140e';
  ctx.fillRect(vx, vy, vw, vh);
  const vibFrac = Math.min(1, vibration / VIB_MAX);
  const fh = vh * vibFrac;
  const color = vibFrac < 0.5 ? '#ddc44a' : vibFrac < 0.8 ? '#e88a30' : '#ff3838';
  ctx.fillStyle = color;
  ctx.fillRect(vx, vy + vh - fh, vw, fh);
  ctx.strokeStyle = '#3a3a44';
  ctx.strokeRect(vx, vy, vw, vh);
  ctx.fillStyle = '#aaa';
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'top';
  ctx.fillText('TİT.', vx + vw + 2, vy - 14);
}

function drawQueue(): void {
  const baseY = QUEUE_Y;
  ctx.fillStyle = '#bbb';
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('Sıra (sonraki petekler)', 24, baseY - 16);

  const startX = 24;
  for (let i = 0; i < QUEUE_SHOW; i++) {
    const x = startX + i * (FRAME_QW + QUEUE_GAP);
    const y = baseY;
    ctx.fillStyle = '#1a1208';
    roundRect(x, y, FRAME_QW, FRAME_QH, 6);
    ctx.fill();
    ctx.strokeStyle = i === 0 && queue.length > 0 ? '#b88410' : '#544020';
    ctx.lineWidth = i === 0 && queue.length > 0 ? 2 : 1.5;
    ctx.stroke();
    if (i < queue.length) {
      const f = queue[i]!.fill;
      const fillH = (f / 100) * (FRAME_QH - 6);
      const y0 = y + FRAME_QH - 3 - fillH;
      const grad = ctx.createLinearGradient(0, y0, 0, y + FRAME_QH - 3);
      grad.addColorStop(0, '#ffcc4a');
      grad.addColorStop(1, '#b87a0a');
      ctx.save();
      ctx.beginPath();
      roundRect(x + 3, y + 3, FRAME_QW - 6, FRAME_QH - 6, 4);
      ctx.clip();
      ctx.fillStyle = grad;
      ctx.fillRect(x + 3, y0, FRAME_QW - 6, fillH);
      ctx.restore();

      ctx.fillStyle = '#fffae3';
      ctx.font = 'bold 11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${Math.round(f)}`, x + FRAME_QW / 2, y + 12);
    } else {
      ctx.fillStyle = 'rgba(255, 220, 140, 0.22)';
      ctx.font = '14px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('—', x + FRAME_QW / 2, y + FRAME_QH / 2);
    }
  }

  ctx.fillStyle = '#bbb';
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'top';
  ctx.fillText(`Kalan: ${queue.length}`, CANVAS_W - 24, baseY - 16);
}

function draw(): void {
  const off = shakeOffset();
  drawBg();
  drawBalanceHint();
  drawDrum(off);
  drawSpeedGauge();
  drawVibGauge();
  drawQueue();
}

// ---------- Input ----------

function getCanvasPos(clientX: number, clientY: number): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((clientX - rect.left) / rect.width) * CANVAS_W,
    y: ((clientY - rect.top) / rect.height) * CANVAS_H,
  };
}

function onCanvasPointerDown(e: PointerEvent): void {
  if (state !== 'playing') return;
  e.preventDefault();
  const p = getCanvasPos(e.clientX, e.clientY);
  // Hit-test slots by nearest within radius (visual circles share SLOT_HIT_R).
  let best = -1;
  let bestD2 = SLOT_HIT_R * SLOT_HIT_R;
  for (let i = 0; i < SLOT_COUNT; i++) {
    const c = slotCenter(i);
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    const d2 = dx * dx + dy * dy;
    if (d2 <= bestD2) {
      best = i;
      bestD2 = d2;
    }
  }
  if (best >= 0) loadOrEjectSlot(best);
}

function onOverlayPointerDown(e: PointerEvent): void {
  e.preventDefault();
  if (state === 'ready' || state === 'gameover') {
    startGame();
  }
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.repeat) {
    if (e.key === ' ' && state === 'playing') {
      e.preventDefault();
      boostHeld = true;
    }
    return;
  }
  if (e.key === 'r' || e.key === 'R') {
    e.preventDefault();
    reset();
    return;
  }
  if (e.key === ' ') {
    e.preventDefault();
    if (state === 'ready' || state === 'gameover') {
      startGame();
      return;
    }
    if (state === 'playing') {
      boostHeld = true;
    }
    return;
  }
  if (e.key === 'Enter' && (state === 'ready' || state === 'gameover')) {
    e.preventDefault();
    startGame();
  }
}

function onKeyUp(e: KeyboardEvent): void {
  if (e.key === ' ') {
    boostHeld = false;
  }
}

function onBlur(): void {
  boostHeld = false;
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  const c = canvas.getContext('2d');
  if (!c) return;
  ctx = c;
  honeyEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  crackEl = document.querySelector<HTMLElement>('#cracks')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;

  best = safeRead<number>(STORAGE_BEST, 0);
  bestEl.textContent = String(best);

  restartBtn.addEventListener('click', () => reset());
  overlay.addEventListener('pointerdown', onOverlayPointerDown);
  canvas.addEventListener('pointerdown', onCanvasPointerDown);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);

  reset();
}

export const game = defineGame({ init, reset });
