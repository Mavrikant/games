import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import {
  showOverlay as showOverlayEl,
  hideOverlay as hideOverlayEl,
} from '@shared/overlay';

// PITFALLS guarded:
// - unguarded-storage: safeRead/safeWrite wrap localStorage.
// - module-level-dom-access: all DOM queries inside init().
// - overlay-input-leak: state enum gated at top of input handlers.
// - stale-async-callback: a single RAF id is cancelled on reset, and the
//   loop bails on state !== 'playing'.
// - visual-vs-hitbox: arm tip position is computed from the same length
//   value used for drawing; hit detection uses that tip plus a single
//   TIP_R radius. Food/shark sizes have one constant pair.
// - hud-counter-synced-only-at-lifecycle-edges: score / time / stuns HUD
//   nodes are written inside the same code paths that mutate the value.
// - invisible-boot: an idle render is drawn immediately on init/reset so
//   the canvas is never blank before the player presses a key.

const STORAGE_BEST = 'ahtapot.best';

const CANVAS_W = 480;
const CANVAS_H = 480;
const CENTER_X = CANVAS_W / 2;
const CENTER_Y = CANVAS_H / 2;
const BODY_R = 28;
const ARM_BASE_R = 22;
const ARM_TIP_R = 9;
const ARM_MAX_LEN = 150;
const ARM_EXTEND_SPEED = 320;
const ARM_RETRACT_SPEED = 420;
const STUN_DURATION = 1.6;
const STUN_LIMIT = 3;

const ROUND_SECONDS = 90;

const FISH_R = 11;
const SHRIMP_R = 10;
const SHARK_W = 64;
const SHARK_H = 20;

const FISH_SPAWN_BASE = 1.05;
const FISH_SPAWN_MIN = 0.42;
const SHRIMP_CHANCE_BASE = 0.08;
const SHRIMP_CHANCE_MAX = 0.22;
const SHARK_SPAWN_BASE = 6.5;
const SHARK_SPAWN_MIN = 2.6;
const RAMP_SECONDS = 60;

const FISH_SPEED_BASE = 38;
const FISH_SPEED_RAMP = 36;
const SHARK_SPEED_BASE = 70;
const SHARK_SPEED_RAMP = 65;

type ArmDir = 'up' | 'left' | 'down' | 'right';
type State = 'ready' | 'playing' | 'paused' | 'gameover';

interface Arm {
  dir: ArmDir;
  dx: number;
  dy: number;
  len: number;
  pressed: boolean;
  stunTimer: number;
}

interface Fish {
  x: number;
  y: number;
  vx: number;
  vy: number;
  kind: 'fish' | 'shrimp';
  flip: number;
}

interface Shark {
  x: number;
  y: number;
  vx: number;
}

const ARM_DIRS: readonly ArmDir[] = ['up', 'left', 'down', 'right'];
const ARM_VECTOR: Record<ArmDir, { dx: number; dy: number }> = {
  up: { dx: 0, dy: -1 },
  left: { dx: -1, dy: 0 },
  down: { dx: 0, dy: 1 },
  right: { dx: 1, dy: 0 },
};
const KEY_TO_ARM: Record<string, ArmDir> = {
  w: 'up',
  arrowup: 'up',
  a: 'left',
  arrowleft: 'left',
  s: 'down',
  arrowdown: 'down',
  d: 'right',
  arrowright: 'right',
};

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let timeEl!: HTMLElement;
let stunsEl!: HTMLElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let restartBtn!: HTMLButtonElement;

let state: State = 'ready';
let arms: Arm[] = [];
let fishes: Fish[] = [];
let sharks: Shark[] = [];
let score = 0;
let best = 0;
let stuns = 0;
let timeLeft = ROUND_SECONDS;
let elapsed = 0;
let nextFishIn = FISH_SPAWN_BASE;
let nextSharkIn = SHARK_SPAWN_BASE;
let rafId: number | null = null;
let lastFrame = 0;
let waveOffset = 0;

function makeArms(): Arm[] {
  return ARM_DIRS.map((dir) => ({
    dir,
    dx: ARM_VECTOR[dir].dx,
    dy: ARM_VECTOR[dir].dy,
    len: 0,
    pressed: false,
    stunTimer: 0,
  }));
}

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlay);
}

function hideOverlay(): void {
  hideOverlayEl(overlay);
}

function updateScore(): void {
  scoreEl.textContent = String(score);
}

function updateBest(): void {
  bestEl.textContent = String(best);
}

function updateTime(): void {
  timeEl.textContent = String(Math.max(0, Math.ceil(timeLeft)));
}

function updateStuns(): void {
  stunsEl.textContent = `${stuns}/${STUN_LIMIT}`;
}

function reset(): void {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  state = 'ready';
  arms = makeArms();
  fishes = [];
  sharks = [];
  score = 0;
  stuns = 0;
  timeLeft = ROUND_SECONDS;
  elapsed = 0;
  nextFishIn = FISH_SPAWN_BASE;
  nextSharkIn = SHARK_SPAWN_BASE;
  waveOffset = 0;
  updateScore();
  updateBest();
  updateTime();
  updateStuns();
  showOverlay('Ahtapot', 'W/A/S/D ile dört kolu bağımsız uzat.\nBoşluk ile başla.');
  draw();
}

function start(): void {
  if (state !== 'ready' && state !== 'paused') return;
  state = 'playing';
  hideOverlay();
  lastFrame = performance.now();
  if (rafId === null) {
    rafId = requestAnimationFrame(loop);
  }
}

function pause(): void {
  if (state !== 'playing') return;
  state = 'paused';
  showOverlay('Duraklatıldı', 'Devam etmek için Boşluk.');
}

function commitBest(): void {
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
    updateBest();
  }
}

function gameOver(reason: 'time' | 'stuns'): void {
  state = 'gameover';
  commitBest();
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  for (const a of arms) a.pressed = false;
  draw();
  const msg =
    reason === 'time'
      ? `Süre doldu — Skor: ${score}\nR: yeniden başla`
      : `Köpekbalıkları yendi — Skor: ${score}\nR: yeniden başla`;
  showOverlay(reason === 'time' ? 'Süre bitti' : 'Sersemleme!', msg);
}

function difficulty(): number {
  return Math.min(1, elapsed / RAMP_SECONDS);
}

function spawnFish(): void {
  const d = difficulty();
  const shrimpChance = SHRIMP_CHANCE_BASE + (SHRIMP_CHANCE_MAX - SHRIMP_CHANCE_BASE) * d;
  const kind: 'fish' | 'shrimp' = Math.random() < shrimpChance ? 'shrimp' : 'fish';
  const speed = FISH_SPEED_BASE + FISH_SPEED_RAMP * d;
  const edge = Math.floor(Math.random() * 4);
  let x = 0;
  let y = 0;
  let vx = 0;
  let vy = 0;
  const margin = 20;
  if (edge === 0) {
    x = -margin;
    y = 60 + Math.random() * (CANVAS_H - 120);
    vx = speed * (0.7 + Math.random() * 0.6);
    vy = (Math.random() - 0.5) * speed * 0.3;
  } else if (edge === 1) {
    x = CANVAS_W + margin;
    y = 60 + Math.random() * (CANVAS_H - 120);
    vx = -speed * (0.7 + Math.random() * 0.6);
    vy = (Math.random() - 0.5) * speed * 0.3;
  } else if (edge === 2) {
    x = 60 + Math.random() * (CANVAS_W - 120);
    y = -margin;
    vy = speed * (0.7 + Math.random() * 0.6);
    vx = (Math.random() - 0.5) * speed * 0.3;
  } else {
    x = 60 + Math.random() * (CANVAS_W - 120);
    y = CANVAS_H + margin;
    vy = -speed * (0.7 + Math.random() * 0.6);
    vx = (Math.random() - 0.5) * speed * 0.3;
  }
  fishes.push({ x, y, vx, vy, kind, flip: vx >= 0 ? 1 : -1 });
}

function spawnShark(): void {
  const d = difficulty();
  const speed = SHARK_SPEED_BASE + SHARK_SPEED_RAMP * d;
  const lane = 130 + Math.random() * (CANVAS_H - 260);
  const fromLeft = Math.random() < 0.5;
  sharks.push({
    x: fromLeft ? -SHARK_W : CANVAS_W + SHARK_W,
    y: lane,
    vx: fromLeft ? speed : -speed,
  });
}

function currentFishInterval(): number {
  const d = difficulty();
  return FISH_SPAWN_BASE + (FISH_SPAWN_MIN - FISH_SPAWN_BASE) * d;
}

function currentSharkInterval(): number {
  const d = difficulty();
  return SHARK_SPAWN_BASE + (SHARK_SPAWN_MIN - SHARK_SPAWN_BASE) * d;
}

function armTip(arm: Arm): { x: number; y: number } {
  return {
    x: CENTER_X + arm.dx * (BODY_R + arm.len),
    y: CENTER_Y + arm.dy * (BODY_R + arm.len),
  };
}

function step(dt: number): void {
  elapsed += dt;
  waveOffset += dt;

  timeLeft -= dt;
  updateTime();
  if (timeLeft <= 0) {
    timeLeft = 0;
    gameOver('time');
    return;
  }

  for (const a of arms) {
    if (a.stunTimer > 0) {
      a.stunTimer -= dt;
      a.len -= ARM_RETRACT_SPEED * dt;
      if (a.len < 0) a.len = 0;
    } else if (a.pressed) {
      a.len += ARM_EXTEND_SPEED * dt;
      if (a.len > ARM_MAX_LEN) a.len = ARM_MAX_LEN;
    } else {
      a.len -= ARM_RETRACT_SPEED * dt;
      if (a.len < 0) a.len = 0;
    }
  }

  for (let i = fishes.length - 1; i >= 0; i--) {
    const f = fishes[i]!;
    f.x += f.vx * dt;
    f.y += f.vy * dt;
    if (
      f.x < -40 ||
      f.x > CANVAS_W + 40 ||
      f.y < -40 ||
      f.y > CANVAS_H + 40
    ) {
      fishes.splice(i, 1);
    }
  }

  for (let i = sharks.length - 1; i >= 0; i--) {
    const s = sharks[i]!;
    s.x += s.vx * dt;
    if (
      (s.vx > 0 && s.x - SHARK_W / 2 > CANVAS_W + 20) ||
      (s.vx < 0 && s.x + SHARK_W / 2 < -20)
    ) {
      sharks.splice(i, 1);
    }
  }

  nextFishIn -= dt;
  while (nextFishIn <= 0) {
    spawnFish();
    nextFishIn += currentFishInterval();
  }
  nextSharkIn -= dt;
  if (nextSharkIn <= 0) {
    spawnShark();
    nextSharkIn = currentSharkInterval();
  }

  for (const a of arms) {
    if (a.len <= 0 && a.stunTimer <= 0) continue;
    const tip = armTip(a);

    for (let i = fishes.length - 1; i >= 0; i--) {
      const f = fishes[i]!;
      const r = f.kind === 'shrimp' ? SHRIMP_R : FISH_R;
      const dx = tip.x - f.x;
      const dy = tip.y - f.y;
      if (dx * dx + dy * dy <= (ARM_TIP_R + r) * (ARM_TIP_R + r)) {
        score += f.kind === 'shrimp' ? 3 : 1;
        updateScore();
        if (score > best) commitBest();
        fishes.splice(i, 1);
      }
    }

    if (a.stunTimer > 0) continue;

    for (const s of sharks) {
      const dx = Math.max(0, Math.abs(tip.x - s.x) - SHARK_W / 2);
      const dy = Math.max(0, Math.abs(tip.y - s.y) - SHARK_H / 2);
      if (dx * dx + dy * dy <= ARM_TIP_R * ARM_TIP_R) {
        a.stunTimer = STUN_DURATION;
        stuns += 1;
        updateStuns();
        if (stuns >= STUN_LIMIT) {
          gameOver('stuns');
          return;
        }
        break;
      }
    }
  }
}

function loop(now: number): void {
  rafId = null;
  if (state !== 'playing') return;
  const dt = Math.min(0.04, (now - lastFrame) / 1000);
  lastFrame = now;
  step(dt);
  draw();
  if (state === 'playing') {
    rafId = requestAnimationFrame(loop);
  }
}

function drawBackground(): void {
  const grd = ctx.createLinearGradient(0, 0, 0, CANVAS_H);
  grd.addColorStop(0, '#0b1530');
  grd.addColorStop(1, '#04101f');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  ctx.strokeStyle = 'rgba(120, 180, 220, 0.07)';
  ctx.lineWidth = 1;
  for (let y = 30; y < CANVAS_H; y += 36) {
    ctx.beginPath();
    const phase = waveOffset * 0.7 + y * 0.04;
    for (let x = 0; x <= CANVAS_W; x += 12) {
      const yy = y + Math.sin(phase + x * 0.025) * 2.5;
      if (x === 0) ctx.moveTo(x, yy);
      else ctx.lineTo(x, yy);
    }
    ctx.stroke();
  }
}

function drawArm(arm: Arm): void {
  if (arm.len <= 0) return;
  const tip = armTip(arm);
  const baseX = CENTER_X + arm.dx * BODY_R;
  const baseY = CENTER_Y + arm.dy * BODY_R;

  const px = -arm.dy;
  const py = arm.dx;
  const wave = Math.sin(waveOffset * 6 + arm.len * 0.04) * 3;
  const wx = px * wave;
  const wy = py * wave;
  const midX = (baseX + tip.x) / 2 + wx;
  const midY = (baseY + tip.y) / 2 + wy;

  const baseHalf = ARM_BASE_R;
  const tipHalf = ARM_TIP_R;
  const stunColor = arm.stunTimer > 0;

  ctx.fillStyle = stunColor ? '#7a4250' : '#5a2a8a';
  ctx.beginPath();
  ctx.moveTo(baseX + px * baseHalf, baseY + py * baseHalf);
  ctx.quadraticCurveTo(
    midX + px * (tipHalf + 4),
    midY + py * (tipHalf + 4),
    tip.x + px * tipHalf,
    tip.y + py * tipHalf,
  );
  ctx.lineTo(tip.x - px * tipHalf, tip.y - py * tipHalf);
  ctx.quadraticCurveTo(
    midX - px * (tipHalf + 4),
    midY - py * (tipHalf + 4),
    baseX - px * baseHalf,
    baseY - py * baseHalf,
  );
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = stunColor ? '#3a1f29' : '#3a1860';
  const dots = Math.max(2, Math.floor(arm.len / 22));
  for (let i = 1; i <= dots; i++) {
    const t = i / (dots + 1);
    const x = baseX + (tip.x - baseX) * t + wx * Math.sin(t * Math.PI);
    const y = baseY + (tip.y - baseY) * t + wy * Math.sin(t * Math.PI);
    const r = 2.8 + (1 - t) * 1.6;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.fillStyle = stunColor ? '#c97a8c' : '#9b6cd0';
  ctx.beginPath();
  ctx.arc(tip.x, tip.y, ARM_TIP_R - 1, 0, Math.PI * 2);
  ctx.fill();
}

function drawBody(): void {
  ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
  ctx.beginPath();
  ctx.ellipse(CENTER_X, CENTER_Y + 6, BODY_R + 4, BODY_R, 0, 0, Math.PI * 2);
  ctx.fill();

  const grad = ctx.createRadialGradient(
    CENTER_X - 6,
    CENTER_Y - 8,
    4,
    CENTER_X,
    CENTER_Y,
    BODY_R + 6,
  );
  grad.addColorStop(0, '#a76cd9');
  grad.addColorStop(1, '#5b2a8a');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(CENTER_X, CENTER_Y, BODY_R, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(CENTER_X - 9, CENTER_Y - 4, 5, 0, Math.PI * 2);
  ctx.arc(CENTER_X + 9, CENTER_Y - 4, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#0a0b14';
  ctx.beginPath();
  ctx.arc(CENTER_X - 8, CENTER_Y - 3, 2.4, 0, Math.PI * 2);
  ctx.arc(CENTER_X + 10, CENTER_Y - 3, 2.4, 0, Math.PI * 2);
  ctx.fill();
}

function drawFish(f: Fish): void {
  ctx.save();
  ctx.translate(f.x, f.y);
  ctx.scale(f.flip, 1);
  if (f.kind === 'shrimp') {
    ctx.fillStyle = '#ff8b6b';
    ctx.beginPath();
    ctx.ellipse(0, 0, SHRIMP_R, SHRIMP_R * 0.55, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(SHRIMP_R - 1, 0);
    ctx.lineTo(SHRIMP_R + 6, -5);
    ctx.lineTo(SHRIMP_R + 6, 5);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#1a0a08';
    ctx.beginPath();
    ctx.arc(-SHRIMP_R + 3, -1, 1.6, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.fillStyle = '#6fc5e9';
    ctx.beginPath();
    ctx.ellipse(0, 0, FISH_R, FISH_R * 0.55, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-FISH_R + 1, 0);
    ctx.lineTo(-FISH_R - 7, -5);
    ctx.lineTo(-FISH_R - 7, 5);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#0e1e2a';
    ctx.beginPath();
    ctx.arc(FISH_R - 3, -1, 1.6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawShark(s: Shark): void {
  const facing = s.vx >= 0 ? 1 : -1;
  ctx.save();
  ctx.translate(s.x, s.y);
  ctx.scale(facing, 1);
  ctx.fillStyle = '#5a6c7c';
  ctx.beginPath();
  ctx.moveTo(-SHARK_W / 2, 0);
  ctx.quadraticCurveTo(-SHARK_W / 6, -SHARK_H, SHARK_W / 2 - 6, -4);
  ctx.lineTo(SHARK_W / 2, 0);
  ctx.lineTo(SHARK_W / 2 - 6, 4);
  ctx.quadraticCurveTo(-SHARK_W / 6, SHARK_H, -SHARK_W / 2, 0);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#8a9aa7';
  ctx.beginPath();
  ctx.moveTo(-SHARK_W / 2 + 8, 2);
  ctx.quadraticCurveTo(0, SHARK_H * 0.7, SHARK_W / 2 - 10, 2);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#4a5b6a';
  ctx.beginPath();
  ctx.moveTo(-2, -SHARK_H * 0.45);
  ctx.lineTo(10, -SHARK_H * 0.45);
  ctx.lineTo(2, -SHARK_H);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(-SHARK_W / 2 + 2, 0);
  ctx.lineTo(-SHARK_W / 2 - 9, -SHARK_H * 0.8);
  ctx.lineTo(-SHARK_W / 2 - 9, SHARK_H * 0.8);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#0a0b14';
  ctx.beginPath();
  ctx.arc(SHARK_W / 4, -1, 1.8, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function draw(): void {
  drawBackground();
  for (const s of sharks) drawShark(s);
  for (const f of fishes) drawFish(f);
  for (const a of arms) drawArm(a);
  drawBody();
}

function setArmPressed(dir: ArmDir, pressed: boolean): void {
  const arm = arms.find((a) => a.dir === dir);
  if (!arm) return;
  arm.pressed = pressed;
}

function onKeyDown(e: KeyboardEvent): void {
  const k = e.key.toLowerCase();
  if (k === ' ' || k === 'spacebar') {
    e.preventDefault();
    if (state === 'ready' || state === 'paused') start();
    else if (state === 'playing') pause();
    else if (state === 'gameover') reset();
    return;
  }
  if (k === 'r') {
    e.preventDefault();
    reset();
    return;
  }
  const dir = KEY_TO_ARM[k];
  if (!dir) return;
  e.preventDefault();
  if (state === 'ready') {
    start();
  }
  if (state !== 'playing') return;
  setArmPressed(dir, true);
}

function onKeyUp(e: KeyboardEvent): void {
  const k = e.key.toLowerCase();
  const dir = KEY_TO_ARM[k];
  if (!dir) return;
  e.preventDefault();
  setArmPressed(dir, false);
}

function clearAllPressed(): void {
  for (const a of arms) a.pressed = false;
}

function bindTouchButtons(): void {
  document.querySelectorAll<HTMLButtonElement>('.touch__btn').forEach((btn) => {
    const dir = btn.dataset.arm as ArmDir | undefined;
    if (!dir) return;
    const press = (e: Event): void => {
      e.preventDefault();
      if (state === 'ready') start();
      if (state !== 'playing') return;
      setArmPressed(dir, true);
    };
    const release = (): void => {
      setArmPressed(dir, false);
    };
    btn.addEventListener('pointerdown', press);
    btn.addEventListener('pointerup', release);
    btn.addEventListener('pointerleave', release);
    btn.addEventListener('pointercancel', release);
  });
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  timeEl = document.querySelector<HTMLElement>('#time')!;
  stunsEl = document.querySelector<HTMLElement>('#stuns')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', () => {
    clearAllPressed();
    if (state === 'playing') pause();
  });

  restartBtn.addEventListener('click', () => {
    reset();
  });

  overlay.addEventListener('click', () => {
    if (state === 'ready' || state === 'paused') start();
    else if (state === 'gameover') reset();
  });

  bindTouchButtons();

  reset();
}

export const game = defineGame({ init, reset });
