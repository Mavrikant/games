// Hokkabaz — cascade-style juggling reflex game.
// The juggler slides along the bottom; balls trace parabolas and are caught
// automatically when the juggler stands beneath the hand line. Each catch
// flips the ball toward the opposite hand — the classic three-ball cascade.
//
// PITFALLS guarded:
// - module-level-dom-access: every DOM/storage lookup lives in init().
// - unguarded-storage: safeRead/safeWrite wrap localStorage.
// - stale-async-callback: RAF loop is gated on a generation token + state.
// - overlay-input-leak: every input handler returns early when state mismatches.
// - missing-overlay-css: per-game CSS defines .overlay--hidden visual.
// - unreachable-start-state: overlay has both a Start button and Space/Enter.
// - hud-counter-synced-only-at-lifecycle-edges: score/lives DOM updated on
//   every mutation, not only at game-over.

import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';
import { reportGameOver } from '@shared/leaderboard';

const STORAGE_BEST = 'hokkabaz.best';
const SCORE_DESC = {
  gameId: 'hokkabaz',
  storageKey: STORAGE_BEST,
  direction: 'higher' as const,
};

const CANVAS_W = 480;
const CANVAS_H = 600;
const HAND_Y = 510;
const HAND_OFFSET = 28;
const HAND_RADIUS = 18;
const BALL_RADIUS = 13;
const GRAVITY = 0.32;
const CATCH_BOUNCE_VY = -10.6;
const CATCH_VX_MIN = 1.0;
const CATCH_VX_MAX = 1.9;
const JUGGLER_HALF = HAND_OFFSET + HAND_RADIUS;
const FLOOR_Y = 580;
const JUGGLER_X_MIN = JUGGLER_HALF + 4;
const JUGGLER_X_MAX = CANVAS_W - JUGGLER_HALF - 4;
const KEY_SPEED = 6.2;
const MOUSE_FOLLOW = 0.22;
const MAX_LIVES = 3;
const START_BALLS = 3;
const BALLS_PER_LEVEL = 8;
const MAX_BALLS = 6;
const TRAIL_LEN = 6;
const FLASH_FRAMES = 8;

type State = 'ready' | 'playing' | 'gameover';

interface Ball {
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: string;
  trail: { x: number; y: number }[];
}

const COLORS = ['#fb7185', '#fbbf24', '#34d399', '#60a5fa', '#c084fc', '#f472b6'];

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let livesEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayBtn!: HTMLButtonElement;

const gen = createGenToken();

let state: State = 'ready';
let balls: Ball[] = [];
let jugglerX = CANVAS_W / 2;
let movingLeft = false;
let movingRight = false;
let pointerX: number | null = null;
let pointerActive = false;
let score = 0;
let lives = MAX_LIVES;
let best = 0;
let catchesToNextBall = BALLS_PER_LEVEL;
let leftFlash = 0;
let rightFlash = 0;
let scoreReported = false;

function showStart(title: string, msg: string, btn: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  overlayBtn.textContent = btn;
  overlayBtn.classList.remove('overlay__btn--hidden');
  showOverlayEl(overlay);
}

function hideStart(): void {
  hideOverlayEl(overlay);
}

function spawnBall(opts: { delayFrames?: number; nearJuggler?: boolean } = {}): void {
  const delay = opts.delayFrames ?? 0;
  let spawnX: number;
  let vx: number;
  if (opts.nearJuggler) {
    // First-spawn courtesy: drop close enough that the resting juggler can
    // step into the catch line without panic. Slight nudge toward center
    // keeps the ball inside the catch radius.
    const offset = (Math.random() - 0.5) * 60;
    spawnX = jugglerX + offset;
    vx = -offset * 0.01;
  } else {
    const margin = 110;
    spawnX = margin + Math.random() * (CANVAS_W - 2 * margin);
    vx = (Math.random() - 0.5) * 0.9;
  }
  const color = COLORS[balls.length % COLORS.length]!;
  balls.push({
    x: spawnX,
    y: -BALL_RADIUS - delay * 5,
    vx,
    vy: 0.5 + Math.random() * 0.3,
    color,
    trail: [],
  });
}

function syncHud(): void {
  scoreEl.textContent = String(score);
  livesEl.textContent = String(lives);
  bestEl.textContent = String(best);
}

function reset(): void {
  gen.bump();
  state = 'ready';
  balls = [];
  jugglerX = CANVAS_W / 2;
  movingLeft = false;
  movingRight = false;
  pointerActive = false;
  pointerX = null;
  score = 0;
  lives = MAX_LIVES;
  catchesToNextBall = BALLS_PER_LEVEL;
  leftFlash = 0;
  rightFlash = 0;
  scoreReported = false;
  syncHud();
  showStart(
    'Hokkabaz',
    'Topları havada tut — düşeni avucunla yakala.\nKlavye, fare veya dokunmayla hokkabazı kaydır.',
    'Başla',
  );
  draw();
}

function startGame(): void {
  if (state === 'playing') return;
  state = 'playing';
  scoreReported = false;
  balls = [];
  // Stagger the initial trio with a generous head start so the player has
  // time to read the cascade before more than one ball is on its way down.
  for (let i = 0; i < START_BALLS; i++) {
    spawnBall({ delayFrames: i * 24, nearJuggler: true });
  }
  hideStart();
  beginLoop();
}

function endGame(): void {
  if (state === 'gameover') return;
  state = 'gameover';
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
    syncHud();
  }
  if (!scoreReported) {
    scoreReported = true;
    reportGameOver(SCORE_DESC, score);
  }
  showStart('Bitti!', `Skor: ${score}\n\nR ile yeniden başla.`, 'Tekrar dene');
}

function beginLoop(): void {
  const myGen = gen.current();
  const tick = (): void => {
    if (!gen.isCurrent(myGen)) return;
    if (state !== 'playing') return;
    update();
    draw();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function update(): void {
  // Juggler movement: keyboard wins when held; otherwise pointer follow.
  let dx = 0;
  if (movingLeft) dx -= KEY_SPEED;
  if (movingRight) dx += KEY_SPEED;
  if (dx !== 0) {
    jugglerX += dx;
  } else if (pointerActive && pointerX !== null) {
    jugglerX += (pointerX - jugglerX) * MOUSE_FOLLOW;
  }
  if (jugglerX < JUGGLER_X_MIN) jugglerX = JUGGLER_X_MIN;
  if (jugglerX > JUGGLER_X_MAX) jugglerX = JUGGLER_X_MAX;

  for (let i = balls.length - 1; i >= 0; i--) {
    const b = balls[i]!;
    const prevY = b.y;
    b.x += b.vx;
    b.y += b.vy;
    b.vy += GRAVITY;

    // Side walls — soft bounce keeps balls in play.
    if (b.x < BALL_RADIUS) {
      b.x = BALL_RADIUS;
      b.vx = Math.abs(b.vx) * 0.6 + 0.4;
    } else if (b.x > CANVAS_W - BALL_RADIUS) {
      b.x = CANVAS_W - BALL_RADIUS;
      b.vx = -(Math.abs(b.vx) * 0.6 + 0.4);
    }

    b.trail.push({ x: b.x, y: b.y });
    if (b.trail.length > TRAIL_LEN) b.trail.shift();

    // Catch: ball is falling and just crossed the hand line.
    if (b.vy > 0 && prevY < HAND_Y && b.y >= HAND_Y) {
      const dx2 = b.x - jugglerX;
      if (Math.abs(dx2) <= JUGGLER_HALF) {
        // Caught. Toward which hand?
        const caughtLeft = dx2 < 0;
        if (caughtLeft) leftFlash = FLASH_FRAMES;
        else rightFlash = FLASH_FRAMES;
        b.y = HAND_Y;
        b.vy = CATCH_BOUNCE_VY;
        const mag = CATCH_VX_MIN + Math.random() * (CATCH_VX_MAX - CATCH_VX_MIN);
        // Throw toward the opposite side — classic cascade pattern.
        b.vx = caughtLeft ? mag : -mag;
        b.trail.length = 0;
        score++;
        catchesToNextBall--;
        syncHud();
        if (catchesToNextBall <= 0 && balls.length < MAX_BALLS) {
          spawnBall({ delayFrames: 12 });
          catchesToNextBall = BALLS_PER_LEVEL;
        }
        continue;
      }
    }

    // Miss: ball fell past the floor.
    if (b.y > FLOOR_Y + BALL_RADIUS) {
      balls.splice(i, 1);
      lives--;
      syncHud();
      if (lives <= 0) {
        endGame();
        return;
      }
      // Respawn from top to keep the act going.
      spawnBall({ delayFrames: 8 });
    }
  }

  if (leftFlash > 0) leftFlash--;
  if (rightFlash > 0) rightFlash--;
}

function draw(): void {
  ctx.fillStyle = getCss('--hk-bg', '#0e1117');
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  // Stage gradient — circus spotlight.
  const grad = ctx.createRadialGradient(
    CANVAS_W / 2,
    CANVAS_H + 80,
    20,
    CANVAS_W / 2,
    CANVAS_H + 80,
    520,
  );
  grad.addColorStop(0, 'rgba(96,165,250,0.18)');
  grad.addColorStop(1, 'rgba(96,165,250,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  // Floor line.
  ctx.strokeStyle = getCss('--hk-floor', '#1f2937');
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, FLOOR_Y);
  ctx.lineTo(CANVAS_W, FLOOR_Y);
  ctx.stroke();

  // Hand line — subtle guide.
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.10)';
  ctx.setLineDash([4, 8]);
  ctx.beginPath();
  ctx.moveTo(0, HAND_Y);
  ctx.lineTo(CANVAS_W, HAND_Y);
  ctx.stroke();
  ctx.setLineDash([]);

  // Balls + trails.
  for (const b of balls) {
    if (b.trail.length > 1) {
      for (let i = 0; i < b.trail.length; i++) {
        const t = b.trail[i]!;
        const alpha = (i + 1) / (b.trail.length + 2);
        ctx.fillStyle = withAlpha(b.color, alpha * 0.35);
        ctx.beginPath();
        ctx.arc(t.x, t.y, BALL_RADIUS * (0.5 + (i / b.trail.length) * 0.4), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // Glow.
    ctx.fillStyle = withAlpha(b.color, 0.25);
    ctx.beginPath();
    ctx.arc(b.x, b.y, BALL_RADIUS + 4, 0, Math.PI * 2);
    ctx.fill();
    // Body.
    ctx.fillStyle = b.color;
    ctx.beginPath();
    ctx.arc(b.x, b.y, BALL_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    // Highlight dot.
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.beginPath();
    ctx.arc(b.x - BALL_RADIUS * 0.35, b.y - BALL_RADIUS * 0.4, BALL_RADIUS * 0.25, 0, Math.PI * 2);
    ctx.fill();
  }

  drawJuggler();

  // Lives pips, bottom-left.
  for (let i = 0; i < MAX_LIVES; i++) {
    const filled = i < lives;
    ctx.fillStyle = filled ? '#f87171' : 'rgba(248,113,113,0.18)';
    ctx.beginPath();
    ctx.arc(20 + i * 18, 26, 6, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawJuggler(): void {
  const jx = jugglerX;
  const handY = HAND_Y;
  const bodyTop = handY + 12;
  const bodyBottom = FLOOR_Y - 4;
  const headY = bodyTop - 18;

  // Body.
  ctx.strokeStyle = '#cbd5f5';
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(jx, bodyTop);
  ctx.lineTo(jx, bodyBottom);
  ctx.stroke();

  // Legs.
  ctx.beginPath();
  ctx.moveTo(jx, bodyBottom);
  ctx.lineTo(jx - 10, FLOOR_Y);
  ctx.moveTo(jx, bodyBottom);
  ctx.lineTo(jx + 10, FLOOR_Y);
  ctx.stroke();

  // Arms to hands.
  ctx.beginPath();
  ctx.moveTo(jx, bodyTop + 2);
  ctx.lineTo(jx - HAND_OFFSET, handY);
  ctx.moveTo(jx, bodyTop + 2);
  ctx.lineTo(jx + HAND_OFFSET, handY);
  ctx.stroke();

  // Hands.
  const leftLit = leftFlash > 0;
  const rightLit = rightFlash > 0;
  ctx.fillStyle = leftLit ? '#fde68a' : '#94a3b8';
  ctx.beginPath();
  ctx.arc(jx - HAND_OFFSET, handY, HAND_RADIUS - 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = rightLit ? '#fde68a' : '#94a3b8';
  ctx.beginPath();
  ctx.arc(jx + HAND_OFFSET, handY, HAND_RADIUS - 4, 0, Math.PI * 2);
  ctx.fill();

  // Head.
  ctx.fillStyle = '#e2e8f0';
  ctx.beginPath();
  ctx.arc(jx, headY, 10, 0, Math.PI * 2);
  ctx.fill();
  // Tiny hat brim.
  ctx.fillStyle = '#a78bfa';
  ctx.fillRect(jx - 12, headY - 11, 24, 3);
  ctx.fillRect(jx - 8, headY - 18, 16, 8);
}

function withAlpha(hex: string, a: number): string {
  // Accept #rrggbb only — short form not used in palette.
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
}

const cssCache = new Map<string, string>();
function getCss(name: string, fallback: string): string {
  const cached = cssCache.get(name);
  if (cached !== undefined) return cached;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const out = v.length > 0 ? v : fallback;
  cssCache.set(name, out);
  return out;
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
  }
  if (state !== 'playing') return;
  if (k === 'ArrowLeft' || low === 'a') {
    movingLeft = true;
    e.preventDefault();
  } else if (k === 'ArrowRight' || low === 'd') {
    movingRight = true;
    e.preventDefault();
  }
}

function onKeyUp(e: KeyboardEvent): void {
  const k = e.key;
  const low = k.toLowerCase();
  if (k === 'ArrowLeft' || low === 'a') movingLeft = false;
  else if (k === 'ArrowRight' || low === 'd') movingRight = false;
}

function canvasXFromEvent(clientX: number): number {
  const rect = canvas.getBoundingClientRect();
  const scale = CANVAS_W / rect.width;
  return (clientX - rect.left) * scale;
}

function onPointerMove(e: PointerEvent): void {
  if (state !== 'playing') return;
  pointerActive = true;
  pointerX = canvasXFromEvent(e.clientX);
}

function onPointerLeave(): void {
  pointerActive = false;
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  livesEl = document.querySelector<HTMLElement>('#lives')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerdown', onPointerMove);
  canvas.addEventListener('pointerleave', onPointerLeave);

  restartBtn.addEventListener('click', () => {
    reset();
  });

  overlayBtn.addEventListener('click', () => {
    if (state === 'gameover') reset();
    startGame();
  });

  reset();
}

export const game = defineGame({ init, reset });
