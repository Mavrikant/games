import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';
import { reportGameOver } from '@shared/leaderboard';

const STORAGE_KEY = 'vinc.best';
const SCORE_DESC = {
  gameId: 'vinc',
  storageKey: STORAGE_KEY,
  direction: 'higher' as const,
};

const W = 480;
const H = 540;
const RAIL_Y = 60;
const RAIL_LEFT = 56;
const RAIL_RIGHT = 424;
const TOWER_X = 26;
const FLOOR_Y = 480;

const CRATE_W = 38;
const CRATE_H = 32;
const SLOT_H = 18;

const ROPE_MIN = 60;
const ROPE_MAX = 384;
const ROPE_SPEED = 170;

const TROLLEY_ACCEL = 1050;
const TROLLEY_FRICTION = 700;
const TROLLEY_MAX_V = 240;

const G = 1200;
const PEND_DAMPING = 0.95;

const GRAB_DX = 22;
const SLOT_X_TOL = 22;
const LAND_VX_SAFE = 90;
const MAX_MISSES = 3;

const COLORS = ['#fb923c', '#60a5fa', '#34d399', '#c084fc', '#f87171', '#facc15'];

type Status = 'waiting' | 'held' | 'falling' | 'placed' | 'broken';

interface Crate {
  id: number;
  color: string;
  homeX: number;
  status: Status;
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  rotV: number;
}

interface Slot {
  idx: number;
  color: string;
  x: number;
  filled: boolean;
}

type State = 'ready' | 'playing' | 'gameover';

const gen = createGenToken();
let state: State = 'ready';
let level = 1;
let score = 0;
let best = 0;
let misses = 0;

let trolleyX = 240;
let trolleyV = 0;

let ropeLen = 110;
let theta = 0;
let omega = 0;

let held: Crate | null = null;
let crates: Crate[] = [];
let slots: Slot[] = [];
let nextId = 1;

let windPhase = 0;

const keys = { left: false, right: false, up: false, down: false };

let lastTs = 0;
let rafId: number | null = null;

let flash: { text: string; until: number; color: string } | null = null;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let levelEl!: HTMLElement;
let missesEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlay);
}

function hide(): void {
  hideOverlayEl(overlay);
}

function updateHud(): void {
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
  levelEl.textContent = String(level);
  missesEl.textContent = `${misses}/${MAX_MISSES}`;
}

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
  return arr;
}

function spawnLevel(lvl: number): void {
  crates = [];
  slots = [];
  held = null;
  trolleyX = 240;
  trolleyV = 0;
  ropeLen = 110;
  theta = 0;
  omega = 0;
  windPhase = 0;

  const n = Math.min(2 + (lvl - 1), 5);
  const palette = COLORS.slice(0, n);

  const slotLeft = 252;
  const slotRight = 422;
  const slotStep = n > 1 ? (slotRight - slotLeft) / (n - 1) : 0;
  const slotColors = shuffle(palette.slice());
  for (let i = 0; i < n; i++) {
    const sx = n === 1 ? (slotLeft + slotRight) / 2 : slotLeft + slotStep * i;
    slots.push({ idx: i, color: slotColors[i]!, x: sx, filled: false });
  }

  const loadLeft = 64;
  const loadRight = 220;
  const loadStep = n > 1 ? (loadRight - loadLeft) / (n - 1) : 0;
  const crateOrder = shuffle(palette.slice());
  for (let i = 0; i < n; i++) {
    const color = crateOrder[i]!;
    const homeX = n === 1 ? (loadLeft + loadRight) / 2 : loadLeft + loadStep * i;
    crates.push({
      id: nextId++,
      color,
      homeX,
      status: 'waiting',
      x: homeX,
      y: FLOOR_Y - CRATE_H / 2,
      vx: 0,
      vy: 0,
      rot: 0,
      rotV: 0,
    });
  }
}

function reset(): void {
  gen.bump();
  state = 'ready';
  level = 1;
  score = 0;
  misses = 0;
  flash = null;
  spawnLevel(1);
  updateHud();
  showOverlay(
    'Vinç',
    '← → troley · ↑ ↓ ip · Boşluk: tut/bırak\nRengi eşleşen yuvaya bırak. Çok salınım kasayı kırar.\nBoşluk ile başla.',
  );
  ensureLoop();
}

function ensureLoop(): void {
  if (rafId !== null) return;
  lastTs = performance.now();
  rafId = window.requestAnimationFrame(loop);
}

function loop(ts: number): void {
  rafId = window.requestAnimationFrame(loop);
  const dt = Math.min(0.033, Math.max(0, (ts - lastTs) / 1000));
  lastTs = ts;
  if (state === 'playing') step(dt);
  draw();
}

function step(dt: number): void {
  const prevV = trolleyV;

  const want = (keys.left ? -1 : 0) + (keys.right ? 1 : 0);
  const targetV = want * TROLLEY_MAX_V;
  if (want !== 0) {
    const dir = Math.sign(targetV - trolleyV);
    trolleyV += dir * TROLLEY_ACCEL * dt;
    if ((dir > 0 && trolleyV > targetV) || (dir < 0 && trolleyV < targetV)) {
      trolleyV = targetV;
    }
  } else if (trolleyV !== 0) {
    const drop = TROLLEY_FRICTION * dt;
    if (Math.abs(trolleyV) <= drop) trolleyV = 0;
    else trolleyV -= Math.sign(trolleyV) * drop;
  }
  trolleyX += trolleyV * dt;
  if (trolleyX < RAIL_LEFT + 20) {
    trolleyX = RAIL_LEFT + 20;
    trolleyV = 0;
  } else if (trolleyX > RAIL_RIGHT - 20) {
    trolleyX = RAIL_RIGHT - 20;
    trolleyV = 0;
  }

  const ropeChange = (keys.down ? 1 : 0) - (keys.up ? 1 : 0);
  ropeLen += ropeChange * ROPE_SPEED * dt;
  if (ropeLen < ROPE_MIN) ropeLen = ROPE_MIN;
  if (ropeLen > ROPE_MAX) ropeLen = ROPE_MAX;

  const trolleyA = (trolleyV - prevV) / Math.max(dt, 0.001);

  let windAccel = 0;
  if (level >= 3) {
    windPhase += dt * 0.9;
    const strength = level >= 4 ? 480 : 280;
    windAccel =
      Math.sin(windPhase * 1.4) * strength +
      Math.sin(windPhase * 0.55) * strength * 0.3;
  }

  const ax = trolleyA + windAccel;
  const alpha =
    -(G / ropeLen) * Math.sin(theta) -
    (ax / ropeLen) * Math.cos(theta) -
    PEND_DAMPING * omega;
  omega += alpha * dt;
  theta += omega * dt;

  if (theta > Math.PI / 2) {
    theta = Math.PI / 2;
    if (omega > 0) omega = 0;
  }
  if (theta < -Math.PI / 2) {
    theta = -Math.PI / 2;
    if (omega < 0) omega = 0;
  }

  if (held !== null) {
    const hookX = trolleyX + ropeLen * Math.sin(theta);
    const hookY = RAIL_Y + ropeLen * Math.cos(theta);
    held.x = hookX;
    held.y = hookY + CRATE_H / 2;
  }

  for (const c of crates) {
    if (c.status === 'falling') {
      c.vy += G * dt;
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      c.rot += c.rotV * dt;
      if (c.y >= FLOOR_Y - CRATE_H / 2) {
        c.y = FLOOR_Y - CRATE_H / 2;
        onLand(c);
      }
    }
  }

  if (flash !== null && performance.now() > flash.until) flash = null;
}

function attemptGrab(): void {
  if (state !== 'playing') return;
  const hookX = trolleyX + ropeLen * Math.sin(theta);
  const hookY = RAIL_Y + ropeLen * Math.cos(theta);
  if (held === null) {
    if (hookY < FLOOR_Y - 70) {
      flashSet('Daha aşağı in', '#facc15', 600);
      return;
    }
    let nearest: Crate | null = null;
    let bestDx = GRAB_DX;
    for (const c of crates) {
      if (c.status !== 'waiting') continue;
      const dx = Math.abs(c.x - hookX);
      if (dx < bestDx) {
        bestDx = dx;
        nearest = c;
      }
    }
    if (nearest !== null) {
      nearest.status = 'held';
      held = nearest;
    } else {
      flashSet('Kasaya yaklaş', '#facc15', 500);
    }
  } else {
    const vx = trolleyV + ropeLen * Math.cos(theta) * omega;
    const vy = -ropeLen * Math.sin(theta) * omega;
    held.status = 'falling';
    held.vx = vx;
    held.vy = vy;
    held.rotV = (Math.random() - 0.5) * 3;
    held = null;
  }
}

function onLand(c: Crate): void {
  const landingVx = c.vx;
  let slot: Slot | null = null;
  for (const s of slots) {
    if (s.filled) continue;
    if (Math.abs(s.x - c.x) <= SLOT_X_TOL) {
      slot = s;
      break;
    }
  }
  if (
    slot !== null &&
    slot.color === c.color &&
    Math.abs(landingVx) < LAND_VX_SAFE
  ) {
    c.status = 'placed';
    c.x = slot.x;
    c.vx = 0;
    c.vy = 0;
    c.rot = 0;
    slot.filled = true;
    score += 100;
    if (score > best) {
      best = score;
      safeWrite(STORAGE_KEY, best);
    }
    flashSet('+100', '#34d399', 700);
    updateHud();
    checkLevelComplete();
  } else {
    c.status = 'broken';
    c.vx = 0;
    c.vy = 0;
    c.rotV = 0;
    misses++;
    score = Math.max(0, score - 40);
    updateHud();
    let reason = 'Iska';
    if (slot !== null && slot.color !== c.color) reason = 'Yanlış renk';
    else if (Math.abs(landingVx) >= LAND_VX_SAFE) reason = 'Çok salınım';
    else if (slot === null) reason = 'Yuvayı kaçırdı';
    flashSet(`-40 ${reason}`, '#fca5a5', 900);
    if (misses >= MAX_MISSES) gameOver();
    else scheduleRespawn(c);
  }
}

function scheduleRespawn(c: Crate): void {
  const myGen = gen.current();
  window.setTimeout(() => {
    if (!gen.isCurrent(myGen)) return;
    if (state !== 'playing') return;
    crates = crates.filter((x) => x.id !== c.id);
    crates.push({
      id: nextId++,
      color: c.color,
      homeX: c.homeX,
      status: 'waiting',
      x: c.homeX,
      y: FLOOR_Y - CRATE_H / 2,
      vx: 0,
      vy: 0,
      rot: 0,
      rotV: 0,
    });
  }, 900);
}

function checkLevelComplete(): void {
  if (!slots.every((s) => s.filled)) return;
  const myGen = gen.current();
  state = 'ready';
  showOverlay(`Seviye ${level} tamam!`, 'Bir sonraki seviye yükleniyor...');
  window.setTimeout(() => {
    if (!gen.isCurrent(myGen)) return;
    level++;
    spawnLevel(level);
    updateHud();
    hide();
    state = 'playing';
  }, 1200);
}

function gameOver(): void {
  state = 'gameover';
  if (score > best) {
    best = score;
    safeWrite(STORAGE_KEY, best);
    updateHud();
  }
  reportGameOver(SCORE_DESC, score);
  showOverlay(
    'Oyun bitti',
    `3 kasa kırıldı.\nSkor: ${score} · Seviye: ${level}\nR ile yeniden başla`,
  );
}

function flashSet(text: string, color: string, ms: number): void {
  flash = { text, color, until: performance.now() + ms };
}

function draw(): void {
  ctx.clearRect(0, 0, W, H);
  drawBackdrop();
  for (const s of slots) drawSlot(s);
  for (const c of crates) {
    if (c.status !== 'held') drawCrate(c);
  }
  drawCrane();
  if (held !== null) drawCrate(held);
  drawFlash();
}

function drawBackdrop(): void {
  ctx.save();
  ctx.fillStyle = '#3b2f1c';
  ctx.fillRect(0, FLOOR_Y, W, H - FLOOR_Y);
  ctx.fillStyle = '#6a5224';
  ctx.fillRect(0, FLOOR_Y, W, 4);
  ctx.fillStyle = 'rgba(250, 204, 21, 0.18)';
  ctx.fillRect(54, FLOOR_Y - 2, 178, 2);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
  ctx.fillRect(244, FLOOR_Y - 2, 186, 2);
  // wind indicator (only when wind active)
  if (level >= 3) {
    ctx.fillStyle = 'rgba(165, 220, 255, 0.5)';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('Rüzgâr aktif', 8, 18);
  }
  ctx.restore();
}

function drawCrane(): void {
  ctx.save();
  ctx.fillStyle = '#1f2937';
  ctx.fillRect(TOWER_X - 8, RAIL_Y, 16, FLOOR_Y - RAIL_Y);
  ctx.strokeStyle = '#374151';
  ctx.lineWidth = 1.5;
  for (let y = RAIL_Y; y < FLOOR_Y - 4; y += 24) {
    ctx.beginPath();
    ctx.moveTo(TOWER_X - 8, y);
    ctx.lineTo(TOWER_X + 8, Math.min(y + 24, FLOOR_Y));
    ctx.moveTo(TOWER_X + 8, y);
    ctx.lineTo(TOWER_X - 8, Math.min(y + 24, FLOOR_Y));
    ctx.stroke();
  }
  ctx.fillStyle = '#facc15';
  ctx.fillRect(TOWER_X - 14, RAIL_Y - 10, 28, 8);

  ctx.fillStyle = '#475569';
  ctx.fillRect(RAIL_LEFT, RAIL_Y - 4, RAIL_RIGHT - RAIL_LEFT, 8);
  ctx.strokeStyle = '#0f172a';
  ctx.lineWidth = 1;
  ctx.strokeRect(RAIL_LEFT, RAIL_Y - 4, RAIL_RIGHT - RAIL_LEFT, 8);

  ctx.fillStyle = '#facc15';
  ctx.fillRect(trolleyX - 20, RAIL_Y - 12, 40, 16);
  ctx.fillStyle = '#a16207';
  ctx.fillRect(trolleyX - 20, RAIL_Y + 2, 40, 4);

  const hookX = trolleyX + ropeLen * Math.sin(theta);
  const hookY = RAIL_Y + ropeLen * Math.cos(theta);
  ctx.strokeStyle = '#cbd5e1';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(trolleyX, RAIL_Y + 6);
  ctx.lineTo(hookX, hookY);
  ctx.stroke();

  ctx.fillStyle = '#e5e7eb';
  ctx.beginPath();
  ctx.arc(hookX, hookY, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#0f172a';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(hookX, hookY + 5, 4, 0, Math.PI);
  ctx.stroke();

  ctx.restore();
}

function drawCrate(c: Crate): void {
  ctx.save();
  ctx.translate(c.x, c.y);
  if (c.rot !== 0) ctx.rotate(c.rot);
  if (c.status === 'broken') ctx.globalAlpha = 0.6;
  ctx.fillStyle = c.status === 'broken' ? '#525252' : darken(c.color, 0.45);
  ctx.fillRect(-CRATE_W / 2, -CRATE_H / 2, CRATE_W, CRATE_H);
  ctx.fillStyle = c.color;
  ctx.fillRect(-CRATE_W / 2, -CRATE_H / 2, CRATE_W, 9);
  ctx.strokeStyle = '#0f172a';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(-CRATE_W / 2, -CRATE_H / 2, CRATE_W, CRATE_H);
  ctx.strokeStyle = 'rgba(15, 23, 42, 0.55)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(-CRATE_W / 2 + 3, -CRATE_H / 2 + 11);
  ctx.lineTo(CRATE_W / 2 - 3, CRATE_H / 2 - 3);
  ctx.moveTo(CRATE_W / 2 - 3, -CRATE_H / 2 + 11);
  ctx.lineTo(-CRATE_W / 2 + 3, CRATE_H / 2 - 3);
  ctx.stroke();
  ctx.restore();
}

function drawSlot(s: Slot): void {
  ctx.save();
  const bx = s.x - 22;
  const by = FLOOR_Y - SLOT_H;
  ctx.fillStyle = 'rgba(15, 23, 42, 0.55)';
  ctx.fillRect(bx, by, 44, SLOT_H);
  ctx.fillStyle = s.color;
  ctx.globalAlpha = 0.35;
  ctx.fillRect(bx + 2, by + 2, 40, 4);
  ctx.globalAlpha = 1;
  ctx.fillStyle = s.color;
  ctx.beginPath();
  ctx.moveTo(s.x, by - 7);
  ctx.lineTo(s.x - 4, by - 0.5);
  ctx.lineTo(s.x + 4, by - 0.5);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = s.color;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(bx, by, 44, SLOT_H);
  if (s.filled) {
    ctx.strokeStyle = '#34d399';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(s.x - 9, by + SLOT_H / 2);
    ctx.lineTo(s.x - 2, by + SLOT_H - 4);
    ctx.lineTo(s.x + 11, by + 3);
    ctx.stroke();
  }
  ctx.restore();
}

function drawFlash(): void {
  if (flash === null) return;
  ctx.save();
  ctx.fillStyle = flash.color;
  ctx.font = 'bold 22px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(flash.text, W / 2, 120);
  ctx.restore();
}

function darken(hex: string, k: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const f = (v: number): string =>
    Math.max(0, Math.min(255, Math.round(v * (1 - k))))
      .toString(16)
      .padStart(2, '0');
  return `#${f(r)}${f(g)}${f(b)}`;
}

function startFromReady(): void {
  if (state !== 'ready') return;
  state = 'playing';
  hide();
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  levelEl = document.querySelector<HTMLElement>('#level')!;
  missesEl = document.querySelector<HTMLElement>('#misses')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;

  best = safeRead<number>(STORAGE_KEY, 0);

  window.addEventListener('keydown', (e) => {
    const k = e.key;
    if (k === 'ArrowLeft' || k === 'a' || k === 'A') {
      keys.left = true;
      e.preventDefault();
    } else if (k === 'ArrowRight' || k === 'd' || k === 'D') {
      keys.right = true;
      e.preventDefault();
    } else if (k === 'ArrowUp' || k === 'w' || k === 'W') {
      keys.up = true;
      e.preventDefault();
    } else if (k === 'ArrowDown' || k === 's' || k === 'S') {
      keys.down = true;
      e.preventDefault();
    } else if (k === ' ' || k === 'Enter') {
      if (e.repeat) return;
      e.preventDefault();
      if (state === 'ready') startFromReady();
      else if (state === 'playing') attemptGrab();
      else if (state === 'gameover') reset();
    } else if (k === 'r' || k === 'R') {
      reset();
      e.preventDefault();
    }
  });

  window.addEventListener('keyup', (e) => {
    const k = e.key;
    if (k === 'ArrowLeft' || k === 'a' || k === 'A') keys.left = false;
    else if (k === 'ArrowRight' || k === 'd' || k === 'D') keys.right = false;
    else if (k === 'ArrowUp' || k === 'w' || k === 'W') keys.up = false;
    else if (k === 'ArrowDown' || k === 's' || k === 'S') keys.down = false;
  });

  const touchButtons = document.querySelectorAll<HTMLButtonElement>(
    '.vinc-touch__btn',
  );
  touchButtons.forEach((btn) => {
    const act = btn.dataset.act;
    if (act === 'grab') {
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        if (state === 'ready') startFromReady();
        else if (state === 'playing') attemptGrab();
        else if (state === 'gameover') reset();
      });
    } else if (
      act === 'left' ||
      act === 'right' ||
      act === 'up' ||
      act === 'down'
    ) {
      const a = act;
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        keys[a] = true;
      });
      btn.addEventListener('pointerup', (e) => {
        e.preventDefault();
        keys[a] = false;
      });
      btn.addEventListener('pointercancel', () => {
        keys[a] = false;
      });
      btn.addEventListener('pointerleave', () => {
        keys[a] = false;
      });
    }
  });

  restartBtn.addEventListener('click', reset);

  reset();
}

export const game = defineGame({ init, reset });
