import { defineGame } from '@shared/game-module';
import { reportGameOver } from '@shared/leaderboard';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';

// Çilingir — pin-tumbler timing game.
// Set each lock pin while its oscillating marker is inside the green safe
// zone. Clear all pins to open the lock; harder locks follow. Three failed
// presses end the run. pitfalls guarded: visual-vs-hitbox (marker position
// and zone hit-test share markerPos()/yFromNorm()), overlay-input-leak
// (single `state` enum routes every handler), invisible-boot (first frame
// already animates), unguarded-storage (@shared/storage).

type State = 'ready' | 'playing' | 'gameover';

interface Pin {
  center: number; // safe-zone center, normalized 0..1 along the track
  half: number; // safe-zone half-width, normalized
  phase: number; // current oscillation phase 0..1
  speed: number; // cycles per second
  set: boolean;
}

const STORAGE_BEST = 'cilingir.best';
const SCORE_DESC = { gameId: 'cilingir', storageKey: STORAGE_BEST, direction: 'higher' as const };
const START_PICKS = 3;

// Track geometry in canvas pixels (single source for draw + hit-test).
const TRACK_TOP = 56;
const TRACK_BOT_PAD = 56;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let picksEl!: HTMLElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let actionBtn!: HTMLButtonElement;
let restartBtn!: HTMLButtonElement;
let setBtn!: HTMLButtonElement;

let state: State = 'ready';
let pins: Pin[] = [];
let active = 0;
let score = 0;
let best = 0;
let picks = START_PICKS;

let rafId: number | null = null;
let lastTs = 0;
let openFlashUntil = 0;
let missFlashUntil = 0;

function buildPins(level: number): Pin[] {
  const count = Math.min(3 + Math.floor(level / 2), 7);
  const baseSpeed = Math.min(0.42 + level * 0.05, 1.25);
  const half = Math.max(0.16 - level * 0.009, 0.062);
  const margin = half + 0.06;
  const out: Pin[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      center: margin + Math.random() * (1 - 2 * margin),
      half,
      phase: Math.random(),
      speed: baseSpeed * (0.9 + Math.random() * 0.2),
      set: false,
    });
  }
  return out;
}

function newLock(level: number): void {
  pins = buildPins(level);
  active = 0;
}

// Smooth oscillation (slower near the extremes), normalized 0..1.
function markerPos(pin: Pin): number {
  return (1 - Math.cos(pin.phase * Math.PI * 2)) / 2;
}

function yFromNorm(n: number): number {
  const top = TRACK_TOP;
  const bot = canvas.height - TRACK_BOT_PAD;
  return bot - n * (bot - top);
}

function updateHud(): void {
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
  picksEl.textContent = String(picks);
}

function showOverlay(title: string, msg: string, action: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  actionBtn.textContent = action;
  showOverlayEl(overlay);
}

function startLoop(): void {
  if (rafId !== null) return;
  lastTs = performance.now();
  rafId = requestAnimationFrame(frame);
}

function frame(ts: number): void {
  if (state !== 'playing') {
    rafId = null;
    return;
  }
  const dt = Math.min((ts - lastTs) / 1000, 0.05);
  lastTs = ts;
  const pin = pins[active];
  if (pin && !pin.set) {
    pin.phase = (pin.phase + pin.speed * dt) % 1;
  }
  draw();
  rafId = requestAnimationFrame(frame);
}

function startGame(): void {
  state = 'playing';
  score = 0;
  picks = START_PICKS;
  updateHud();
  newLock(0);
  openFlashUntil = 0;
  missFlashUntil = 0;
  hideOverlayEl(overlay);
  draw();
  startLoop();
}

function resetToReady(): void {
  state = 'ready';
  score = 0;
  picks = START_PICKS;
  updateHud();
  newLock(0);
  draw();
  showOverlay(
    'Çilingir',
    'Aktif pimin kayan göstergesi yeşil emniyet bölgesindeyken sabitle. Üç maymuncuk hakkın var.',
    'Başla',
  );
}

function openLock(): void {
  score++;
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
  updateHud();
  openFlashUntil = performance.now() + 420;
  newLock(score);
}

function gameOver(): void {
  state = 'gameover';
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
  updateHud();
  draw();
  reportGameOver(SCORE_DESC, score);
  showOverlay('Yakalandın!', `Açtığın kilit: ${score}\nRekor: ${best}`, 'Tekrar');
}

function attempt(): void {
  if (state !== 'playing') return;
  const pin = pins[active];
  if (!pin || pin.set) return;
  const pos = markerPos(pin);
  if (Math.abs(pos - pin.center) <= pin.half) {
    pin.set = true;
    // Freeze the marker at the zone center for the locked visual.
    pin.phase = Math.acos(1 - 2 * pin.center) / (Math.PI * 2);
    active++;
    if (active >= pins.length) {
      openLock();
    }
  } else {
    picks--;
    updateHud();
    missFlashUntil = performance.now() + 320;
    if (picks <= 0) gameOver();
  }
  draw();
}

const cssCache = new Map<string, string>();
function getCss(name: string, fallback: string): string {
  const cached = cssCache.get(name);
  if (cached !== undefined) return cached;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const out = v || fallback;
  cssCache.set(name, out);
  return out;
}

function roundRect(x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function draw(): void {
  const W = canvas.width;
  const H = canvas.height;
  const now = performance.now();

  ctx.fillStyle = getCss('--surface', '#14171c');
  ctx.fillRect(0, 0, W, H);

  const count = pins.length || 1;
  const colW = W / count;
  const trackW = Math.min(colW * 0.46, 40);
  const baseY = H - TRACK_BOT_PAD;

  for (let i = 0; i < pins.length; i++) {
    const pin = pins[i]!;
    const cx = (i + 0.5) * colW;
    const tx = cx - trackW / 2;
    const isActive = i === active && state === 'playing';

    // Track.
    ctx.fillStyle = getCss('--cl-track', '#1a1e25');
    roundRect(tx, TRACK_TOP, trackW, baseY - TRACK_TOP, trackW / 2);
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = isActive
      ? getCss('--accent', '#818cf8')
      : getCss('--cl-track-edge', '#2a3038');
    ctx.stroke();

    if (pin.set) {
      const zTop = yFromNorm(pin.center + pin.half);
      const zBot = yFromNorm(pin.center - pin.half);
      ctx.fillStyle = getCss('--cl-zone-soft', 'rgba(52,211,153,0.16)');
      roundRect(tx + 3, zTop, trackW - 6, zBot - zTop, 6);
      ctx.fill();
      const my = yFromNorm(pin.center);
      ctx.fillStyle = getCss('--cl-set', '#34d399');
      roundRect(tx - 3, my - 5, trackW + 6, 10, 5);
      ctx.fill();
    } else if (isActive) {
      const zTop = yFromNorm(pin.center + pin.half);
      const zBot = yFromNorm(pin.center - pin.half);
      ctx.fillStyle = getCss('--cl-zone-soft', 'rgba(52,211,153,0.16)');
      roundRect(tx + 3, zTop, trackW - 6, zBot - zTop, 6);
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = getCss('--cl-zone', '#34d399');
      ctx.stroke();
      const my = yFromNorm(markerPos(pin));
      ctx.fillStyle = getCss('--cl-marker', '#fbbf24');
      roundRect(tx - 4, my - 6, trackW + 8, 12, 6);
      ctx.fill();
    }
    // Future pins (unset, not active): track only, zone hidden.

    ctx.fillStyle = pin.set
      ? getCss('--cl-set', '#34d399')
      : isActive
        ? getCss('--accent', '#818cf8')
        : getCss('--cl-dim', '#3a414c');
    ctx.beginPath();
    ctx.arc(cx, baseY + 22, 5, 0, Math.PI * 2);
    ctx.fill();
  }

  let flash = '';
  if (now < openFlashUntil) flash = getCss('--cl-set', '#34d399');
  else if (now < missFlashUntil) flash = getCss('--cl-miss', '#fb7185');
  if (flash) {
    ctx.lineWidth = 6;
    ctx.strokeStyle = flash;
    roundRect(4, 4, W - 8, H - 8, 14);
    ctx.stroke();
  }
}

function onKey(e: KeyboardEvent): void {
  const k = e.key.toLowerCase();
  if (k === ' ' || k === 'enter' || k === 'spacebar') {
    if (state === 'playing') attempt();
    else startGame();
    e.preventDefault();
  } else if (k === 'r') {
    resetToReady();
    e.preventDefault();
  }
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  picksEl = document.querySelector<HTMLElement>('#picks')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  actionBtn = document.querySelector<HTMLButtonElement>('#action')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  setBtn = document.querySelector<HTMLButtonElement>('#set-btn')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  window.addEventListener('keydown', onKey);
  canvas.addEventListener('pointerdown', (e) => {
    if (state === 'playing') {
      attempt();
      e.preventDefault();
    }
  });
  actionBtn.addEventListener('click', startGame);
  setBtn.addEventListener('click', () => {
    if (state === 'playing') attempt();
  });
  restartBtn.addEventListener('click', resetToReady);

  resetToReady();
}

export const game = defineGame({ init, reset: resetToReady });
