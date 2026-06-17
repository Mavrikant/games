import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';
import { reportGameOver } from '@shared/leaderboard';

// Kürek — top-down rowing precision game.
//
// Mechanic: alternate L/R oar strokes. Each stroke pushes the boat along its
// heading and nudges heading toward the opposite side (left oar rotates the
// boat clockwise, right oar counter-clockwise). Alternating cancels rotation
// → straight forward path. Same side twice = boat accumulates heading and
// veers off course. A constant sideways current biases drift; logs scroll
// downward as obstacles; stamina drains per stroke and recovers when idle.
//
// PITFALLS guarded:
// - unguarded-storage: all storage via safeRead/safeWrite + try/catch.
// - stale-async-callback: gen.bump() in reset() invalidates the rAF chain.
// - overlay-input-leak: state enum gates every input handler.
// - module-level-dom-access: all DOM/listener wiring lives in init().
// - missing-overlay-css: kurek.css defines .overlay positioning + hidden state.
// - visual-vs-hitbox: boat AABB and triangle drawing both derive from
//   BOAT_HALF/BOAT_HW constants — no parallel hard-coded numbers.

type State = 'ready' | 'rowing' | 'win' | 'lost';
type Side = 'left' | 'right';

const W = 360;
const H = 600;
const BOAT_Y = 478;
const BOAT_HALF = 22;          // half-length of boat (nose to tail)
const BOAT_HW = 11;             // half-width of boat hull
const TARGET_DISTANCE = 1500;

const STROKE_THRUST = 28;       // forward distance gained per stroke at heading=0
const STROKE_TURN = 0.07;       // radians of heading change per stroke
const STROKE_COOLDOWN_MS = 150; // too-quick = wasted
const HEADING_DECAY = 0.94;     // each frame; pulls heading slowly back to 0
const HEADING_CAP = 1.2;        // radians; ~68°, beyond this boat is sideways
const FORWARD_LOG_SCROLL = 0.85;

const CURRENT_BASE = 0.45;      // px/frame sideways, increases with distance
const STAMINA_MAX = 100;
const STAMINA_PER_STROKE = 3;
const STAMINA_RECOVER = 0.18;
const STAMINA_RECOVER_DELAY_MS = 500;
const STAMINA_LOG_HIT = 18;
const INVULN_MS = 600;

const LOG_W = 92;
const LOG_H = 18;
const LOG_SPAWN_MIN_MS = 700;
const LOG_SPAWN_MAX_MS = 1500;

const STORAGE_BEST = 'kurek.best';
const SCORE_DESC = { gameId: 'kurek', storageKey: STORAGE_BEST, direction: 'higher' as const };

interface Log {
  x: number;
  y: number;
  hitFlashUntil: number;
}

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let distanceEl!: HTMLElement;
let staminaEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayBtn!: HTMLButtonElement;

const gen = createGenToken();

let state: State = 'ready';
let boatX = W / 2;
let heading = 0;
let distance = 0;
let stamina = STAMINA_MAX;
let bestDistance = 0;
let lastStrokeMs = 0;
let invulnUntil = 0;
const logs: Log[] = [];
let nextLogSpawnMs = 0;
let lastFrameMs = 0;
let rafHandle = 0;
let lastSideFlash: { side: Side; until: number } = { side: 'left', until: 0 };
let waterScrollOffset = 0;
let lastDistance = 0;

function currentSpeed(): number {
  return CURRENT_BASE + Math.min(0.4, distance / TARGET_DISTANCE * 0.4);
}

function setOverlay(title: string, msg: string, btn: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  overlayBtn.textContent = btn;
  showOverlayEl(overlay);
}

function reset(): void {
  gen.bump();
  if (rafHandle !== 0) {
    cancelAnimationFrame(rafHandle);
    rafHandle = 0;
  }
  state = 'ready';
  boatX = W / 2;
  heading = 0;
  distance = 0;
  lastDistance = 0;
  stamina = STAMINA_MAX;
  lastStrokeMs = 0;
  invulnUntil = 0;
  logs.length = 0;
  nextLogSpawnMs = 0;
  waterScrollOffset = 0;
  lastSideFlash = { side: 'left', until: 0 };
  updateHud();
  draw();
  setOverlay(
    'Kürek',
    'Sıra ile kürek çek: Sol ok / A · Sağ ok / D.\nAlternasyonu bozma. Akıntıya karşı dengeli git.',
    'Başla',
  );
  startLoop();
}

function startPlaying(): void {
  if (state === 'rowing') return;
  if (state === 'win' || state === 'lost') {
    reset();
    return;
  }
  state = 'rowing';
  lastFrameMs = performance.now();
  nextLogSpawnMs = lastFrameMs + LOG_SPAWN_MIN_MS;
  hideOverlayEl(overlay);
  try {
    canvas.focus({ preventScroll: true });
  } catch {
    /* */
  }
}

function updateHud(): void {
  distanceEl.textContent = String(Math.floor(distance));
  staminaEl.textContent = String(Math.max(0, Math.ceil(stamina)));
  bestEl.textContent = String(bestDistance);
}

function stroke(side: Side): void {
  if (state === 'ready') {
    startPlaying();
    // Fall through so first stroke also moves the boat → no invisible-boot.
  }
  if (state !== 'rowing') return;
  const now = performance.now();
  if (now - lastStrokeMs < STROKE_COOLDOWN_MS) {
    // Wasted stroke: still cost a tiny bit of stamina and flash the oar so
    // user gets feedback that they spammed.
    stamina = Math.max(0, stamina - 0.5);
    lastSideFlash = { side, until: now + 120 };
    updateHud();
    return;
  }

  const dx = Math.sin(heading) * STROKE_THRUST;
  const dy = Math.cos(heading) * STROKE_THRUST;
  boatX += dx;
  // dy positive means forward when heading=0; clamp to non-negative so that
  // tipping past π/2 doesn't make distance go backward in a confusing way.
  distance += Math.max(0, dy);

  if (side === 'left') heading += STROKE_TURN;
  else heading -= STROKE_TURN;
  heading = Math.max(-HEADING_CAP, Math.min(HEADING_CAP, heading));

  stamina -= STAMINA_PER_STROKE;
  if (stamina < 0) stamina = 0;

  lastStrokeMs = now;
  lastSideFlash = { side, until: now + 220 };

  if (distance >= TARGET_DISTANCE) {
    win();
  } else if (stamina <= 0) {
    lose();
  }

  updateHud();
}

function win(): void {
  state = 'win';
  const d = Math.floor(distance);
  if (d > bestDistance) {
    bestDistance = d;
    safeWrite(STORAGE_BEST, bestDistance);
  }
  reportGameOver(SCORE_DESC, d, { label: 'Mesafe' });
  setOverlay('İskeleye vardın!', `Mesafe: ${d} · iyi kürek.`, 'Tekrar');
}

function lose(): void {
  state = 'lost';
  const d = Math.floor(distance);
  if (d > bestDistance) {
    bestDistance = d;
    safeWrite(STORAGE_BEST, bestDistance);
  }
  reportGameOver(SCORE_DESC, d, { label: 'Mesafe' });
  setOverlay('Stamina bitti', `Mesafe: ${d} · yeniden dene.`, 'Yeniden başla');
}

function spawnLog(): void {
  const x = Math.random() * (W - LOG_W);
  logs.push({ x, y: -LOG_H - 4, hitFlashUntil: 0 });
}

function step(dt: number): void {
  // Heading decay (frame-rate independent)
  heading *= Math.pow(HEADING_DECAY, dt * 60);
  if (Math.abs(heading) < 1e-3) heading = 0;

  // Sideways current
  boatX += currentSpeed() * dt * 60;

  // Stamina recovery if no recent stroke
  const now = performance.now();
  if (now - lastStrokeMs > STAMINA_RECOVER_DELAY_MS && stamina < STAMINA_MAX) {
    stamina = Math.min(STAMINA_MAX, stamina + STAMINA_RECOVER * dt * 60);
  }

  // Clamp boat to river (bank bumps)
  if (boatX < BOAT_HW + 6) {
    boatX = BOAT_HW + 6;
    if (heading < 0) heading = -heading * 0.4;
  }
  if (boatX > W - BOAT_HW - 6) {
    boatX = W - BOAT_HW - 6;
    if (heading > 0) heading = -heading * 0.4;
  }

  // River ripple scroll
  waterScrollOffset = (waterScrollOffset + currentSpeed() * dt * 30) % 60;

  // Log scroll: base downward drift + forward delta from strokes
  const baseScroll = 1.4 * dt * 60;
  const forwardDelta = distance - lastDistance;
  lastDistance = distance;
  for (const log of logs) {
    log.y += baseScroll + forwardDelta * FORWARD_LOG_SCROLL;
  }
  for (let i = logs.length - 1; i >= 0; i--) {
    if (logs[i]!.y > H + LOG_H) logs.splice(i, 1);
  }

  if (now >= nextLogSpawnMs) {
    spawnLog();
    nextLogSpawnMs = now + LOG_SPAWN_MIN_MS + Math.random() * (LOG_SPAWN_MAX_MS - LOG_SPAWN_MIN_MS);
  }

  // Collision
  if (now > invulnUntil) {
    for (const log of logs) {
      if (collides(log)) {
        stamina -= STAMINA_LOG_HIT;
        invulnUntil = now + INVULN_MS;
        log.hitFlashUntil = now + 220;
        if (stamina <= 0) {
          stamina = 0;
          lose();
        }
        break;
      }
    }
  }

  updateHud();
}

function collides(log: Log): boolean {
  const bx = boatX - BOAT_HW;
  const by = BOAT_Y - BOAT_HALF;
  const bw = BOAT_HW * 2;
  const bh = BOAT_HALF * 2;
  return bx < log.x + LOG_W && bx + bw > log.x && by < log.y + LOG_H && by + bh > log.y;
}

function loop(now: number): void {
  if (rafHandle === 0) return;
  const myGen = gen.current();
  const dt = Math.min(0.05, (now - lastFrameMs) / 1000);
  lastFrameMs = now;
  if (state === 'rowing') {
    step(dt);
  }
  draw();
  if (gen.isCurrent(myGen)) {
    rafHandle = requestAnimationFrame(loop);
  } else {
    rafHandle = 0;
  }
}

function startLoop(): void {
  if (rafHandle !== 0) return;
  lastFrameMs = performance.now();
  rafHandle = requestAnimationFrame(loop);
}

function draw(): void {
  // Background — gradient river
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, '#0e2238');
  grad.addColorStop(1, '#1a3358');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // Water ripples
  ctx.strokeStyle = 'rgba(140, 200, 255, 0.10)';
  ctx.lineWidth = 1;
  for (let i = -1; i < 12; i++) {
    const y = i * 60 + waterScrollOffset;
    ctx.beginPath();
    for (let x = 0; x <= W; x += 30) {
      const yy = y + Math.sin((x + waterScrollOffset) * 0.05) * 3;
      if (x === 0) ctx.moveTo(x, yy);
      else ctx.lineTo(x, yy);
    }
    ctx.stroke();
  }

  // Banks
  ctx.fillStyle = 'rgba(58, 90, 60, 0.6)';
  ctx.fillRect(0, 0, 6, H);
  ctx.fillRect(W - 6, 0, 6, H);

  // Right-side progress bar
  const progress = Math.max(0, Math.min(1, distance / TARGET_DISTANCE));
  ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
  ctx.fillRect(W - 16, 60, 6, H - 200);
  ctx.fillStyle = '#6ee7b7';
  const trackH = H - 200;
  ctx.fillRect(W - 16, 60 + trackH * (1 - progress), 6, trackH * progress);

  // Dock band near top when close
  if (progress > 0.65) {
    const t = (progress - 0.65) / 0.35;
    ctx.fillStyle = `rgba(254, 234, 138, ${0.18 + t * 0.5})`;
    ctx.fillRect(8, 12, W - 16, 18);
    ctx.fillStyle = `rgba(40, 30, 10, ${0.6 + t * 0.4})`;
    ctx.font = 'bold 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('İSKELE', W / 2, 26);
  }

  // Stamina warning glow
  if (stamina < 30 && state === 'rowing') {
    const t = (30 - stamina) / 30;
    const pulse = 0.4 + 0.6 * Math.abs(Math.sin(performance.now() / 240));
    ctx.fillStyle = `rgba(251, 113, 133, ${t * 0.12 * pulse})`;
    ctx.fillRect(0, 0, W, H);
  }

  // Logs
  const now = performance.now();
  for (const log of logs) {
    const hit = now < log.hitFlashUntil;
    ctx.fillStyle = hit ? '#fb7185' : '#7c5a3a';
    ctx.fillRect(log.x, log.y, LOG_W, LOG_H);
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(log.x + 14, log.y + 4);
    ctx.lineTo(log.x + 14, log.y + LOG_H - 4);
    ctx.moveTo(log.x + LOG_W - 14, log.y + 4);
    ctx.lineTo(log.x + LOG_W - 14, log.y + LOG_H - 4);
    ctx.stroke();
    ctx.fillStyle = '#5a3f25';
    ctx.fillRect(log.x, log.y, 8, LOG_H);
    ctx.fillRect(log.x + LOG_W - 8, log.y, 8, LOG_H);
  }

  // Boat
  ctx.save();
  ctx.translate(boatX, BOAT_Y);
  ctx.rotate(heading);

  // Wake (small triangle behind boat)
  ctx.fillStyle = 'rgba(255,255,255,0.10)';
  ctx.beginPath();
  ctx.moveTo(0, BOAT_HALF);
  ctx.lineTo(-7, BOAT_HALF + 22);
  ctx.lineTo(7, BOAT_HALF + 22);
  ctx.closePath();
  ctx.fill();

  // Hull
  ctx.fillStyle = '#fde68a';
  ctx.beginPath();
  ctx.moveTo(0, -BOAT_HALF);
  ctx.lineTo(BOAT_HW, BOAT_HALF);
  ctx.lineTo(-BOAT_HW, BOAT_HALF);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#92580f';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Seat
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.fillRect(-7, -4, 14, 8);

  // Oars
  const leftActive = lastSideFlash.side === 'left' && now < lastSideFlash.until;
  const rightActive = lastSideFlash.side === 'right' && now < lastSideFlash.until;

  // Left oar
  ctx.strokeStyle = '#d6dbf5';
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(-BOAT_HW + 2, 0);
  ctx.lineTo(leftActive ? -BOAT_HW - 16 : -BOAT_HW - 10, leftActive ? 9 : 4);
  ctx.stroke();
  ctx.fillStyle = leftActive ? '#c4b5fd' : '#7d8db3';
  ctx.beginPath();
  if (leftActive) ctx.ellipse(-BOAT_HW - 17, 11, 5.5, 3, -0.3, 0, Math.PI * 2);
  else ctx.ellipse(-BOAT_HW - 11, 5, 4.5, 2.5, -0.3, 0, Math.PI * 2);
  ctx.fill();

  // Right oar
  ctx.strokeStyle = '#d6dbf5';
  ctx.beginPath();
  ctx.moveTo(BOAT_HW - 2, 0);
  ctx.lineTo(rightActive ? BOAT_HW + 16 : BOAT_HW + 10, rightActive ? 9 : 4);
  ctx.stroke();
  ctx.fillStyle = rightActive ? '#c4b5fd' : '#7d8db3';
  ctx.beginPath();
  if (rightActive) ctx.ellipse(BOAT_HW + 17, 11, 5.5, 3, 0.3, 0, Math.PI * 2);
  else ctx.ellipse(BOAT_HW + 11, 5, 4.5, 2.5, 0.3, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();

  // Invuln red flash
  if (now < invulnUntil) {
    const t = (invulnUntil - now) / INVULN_MS;
    ctx.fillStyle = `rgba(251, 113, 133, ${0.28 * t})`;
    ctx.fillRect(0, 0, W, H);
  }
}

function onKey(e: KeyboardEvent): void {
  const k = e.key.toLowerCase();
  if (k === 'arrowleft' || k === 'a') {
    stroke('left');
    e.preventDefault();
  } else if (k === 'arrowright' || k === 'd') {
    stroke('right');
    e.preventDefault();
  } else if (k === 'r') {
    reset();
    e.preventDefault();
  }
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  distanceEl = document.querySelector<HTMLElement>('#distance')!;
  staminaEl = document.querySelector<HTMLElement>('#stamina')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-action')!;

  bestDistance = safeRead<number>(STORAGE_BEST, 0);

  window.addEventListener('keydown', onKey);

  restartBtn.addEventListener('click', () => reset());
  overlayBtn.addEventListener('click', () => {
    if (state === 'ready') startPlaying();
    else if (state === 'win' || state === 'lost') reset();
  });

  document.querySelectorAll<HTMLButtonElement>('.touch__btn').forEach((btn) => {
    const side = btn.dataset.side as Side | undefined;
    if (!side) return;
    btn.addEventListener(
      'pointerdown',
      (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        e.preventDefault();
        stroke(side);
      },
      { passive: false },
    );
    btn.addEventListener('click', (e) => e.preventDefault());
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
  });

  // Suppress page scroll when interacting with the canvas on touch.
  canvas.addEventListener(
    'touchmove',
    (e) => {
      if (e.touches.length > 0) e.preventDefault();
    },
    { passive: false },
  );

  reset();
}

export const game = defineGame({ init, reset });
