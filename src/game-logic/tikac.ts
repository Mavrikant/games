import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';

const STORAGE_BEST = 'tikac.best';

type State = 'ready' | 'playing' | 'gameover';
type Wall = 'left' | 'right' | 'bottom';

interface Hole {
  wall: Wall;
  pos: number;
  size: number;
  flow: number;
}

const BUCKET = { x: 80, y: 110, w: 320, h: 420 };
const LOW = 0.12;
const HIGH = 0.97;
const FILL_RATE = 0.22;
const SPAWN_BASE_MS = 1800;
const SPAWN_MIN_MS = 480;
const SPAWN_DECAY = 24;
const HOLE_RADIUS = 14;
const START_LEVEL = 0.5;

const gen = createGenToken();
let state: State = 'ready';
let level = 0.55;
let elapsed = 0;
let lastFrame = 0;
let nextSpawnAt = 0;
let bestSeconds = 0;
let score = 0;

const holes: Hole[] = [];

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let touchTapBtn!: HTMLButtonElement;

let tapHeld = false;
let touchTapHeld = false;
let rafId = 0;

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlay);
}

function hideOverlay(): void {
  hideOverlayEl(overlay);
}

function getCss(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function syncBest(): void {
  if (score > bestSeconds) {
    bestSeconds = score;
    safeWrite(STORAGE_BEST, bestSeconds);
    bestEl.textContent = String(bestSeconds);
  }
}

function reset(): void {
  gen.bump();
  state = 'ready';
  level = START_LEVEL;
  elapsed = 0;
  score = 0;
  holes.length = 0;
  lastFrame = 0;
  nextSpawnAt = 0;
  scoreEl.textContent = '0';
  bestEl.textContent = String(bestSeconds);
  tapHeld = false;
  touchTapHeld = false;
  cancelLoop();
  draw();
  showOverlay('Tıkaç', 'Musluğu Boşluk ile aç, delikleri tıklayarak tıkaçla.\nSu seviyesini taşma ile boşalma arasında tut.');
}

function startPlay(): void {
  if (state !== 'ready') return;
  state = 'playing';
  hideOverlay();
  lastFrame = performance.now();
  spawnHole();
  nextSpawnAt = lastFrame + SPAWN_BASE_MS;
  scheduleLoop();
}

function endGame(reason: string): void {
  if (state !== 'playing') return;
  state = 'gameover';
  syncBest();
  cancelLoop();
  draw();
  showOverlay('Bitti!', `${reason}\nSüre: ${score} sn · R ile yeniden başla`);
}

function scheduleLoop(): void {
  const myGen = gen.current();
  cancelLoop();
  const step = (now: number): void => {
    if (!gen.isCurrent(myGen)) return;
    if (state !== 'playing') return;
    const dt = Math.min(50, now - lastFrame);
    lastFrame = now;
    update(dt, now);
    draw();
    if (state === 'playing') {
      rafId = requestAnimationFrame(step);
    }
  };
  rafId = requestAnimationFrame(step);
}

function cancelLoop(): void {
  if (rafId !== 0) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
}

function update(dt: number, now: number): void {
  elapsed += dt;
  const seconds = Math.floor(elapsed / 1000);
  if (seconds !== score) {
    score = seconds;
    scoreEl.textContent = String(score);
    syncBest();
  }

  const stepFactor = dt / 1000;
  const flowing = tapHeld || touchTapHeld;
  if (flowing) {
    level += FILL_RATE * stepFactor;
  }
  let drain = 0;
  for (const h of holes) drain += h.flow;
  level -= drain * stepFactor;

  if (level <= LOW) {
    level = LOW;
    endGame('Depo boşaldı.');
    return;
  }
  if (level >= HIGH) {
    level = HIGH;
    endGame('Depo taştı.');
    return;
  }

  if (now >= nextSpawnAt) {
    spawnHole();
    const interval = Math.max(SPAWN_MIN_MS, SPAWN_BASE_MS - elapsed / SPAWN_DECAY);
    nextSpawnAt = now + interval + Math.random() * 220;
  }
}

function spawnHole(): void {
  if (holes.length >= 14) return;
  const wallRoll = Math.random();
  const wall: Wall = wallRoll < 0.42 ? 'left' : wallRoll < 0.84 ? 'right' : 'bottom';
  const sizeRoll = Math.random();
  const size = sizeRoll < 0.55 ? 1 : sizeRoll < 0.88 ? 2 : 3;
  const flowMap = [0, 0.07, 0.13, 0.22];
  const flow = flowMap[size]!;
  let attempts = 0;
  while (attempts < 12) {
    const pos = 0.1 + Math.random() * 0.8;
    if (!holes.some((h) => h.wall === wall && Math.abs(h.pos - pos) < 0.13)) {
      holes.push({ wall, pos, size, flow });
      return;
    }
    attempts++;
  }
}

function holeWorldXY(h: Hole): { x: number; y: number } {
  if (h.wall === 'left') return { x: BUCKET.x, y: BUCKET.y + h.pos * BUCKET.h };
  if (h.wall === 'right') return { x: BUCKET.x + BUCKET.w, y: BUCKET.y + h.pos * BUCKET.h };
  return { x: BUCKET.x + h.pos * BUCKET.w, y: BUCKET.y + BUCKET.h };
}

function pickHoleAt(cx: number, cy: number): number {
  let bestIdx = -1;
  let bestDist = HOLE_RADIUS + 8;
  for (let i = 0; i < holes.length; i++) {
    const p = holeWorldXY(holes[i]!);
    const d = Math.hypot(p.x - cx, p.y - cy);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}

function plugHole(idx: number): void {
  holes.splice(idx, 1);
}

function draw(): void {
  const accent = getCss('--accent') || '#5cf';
  const text = getCss('--text') || '#e7e7ec';
  const surface = getCss('--surface') || '#15171c';
  const bg = getCss('--bg') || '#0a0b0e';

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = '#3a2a1c';
  ctx.fillRect(BUCKET.x - 18, BUCKET.y - 8, 36, 14);
  ctx.fillStyle = '#5d4030';
  ctx.fillRect(BUCKET.x - 10, BUCKET.y - 38, 20, 32);
  ctx.fillRect(BUCKET.x - 16, 40, 32, 10);

  const tapOn = tapHeld || touchTapHeld;
  if (tapOn && state === 'playing') {
    ctx.fillStyle = '#5eb3ff';
    ctx.fillRect(BUCKET.x - 3, BUCKET.y + 6, 6, Math.max(0, BUCKET.y - 20));
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(BUCKET.x, BUCKET.y, BUCKET.w, BUCKET.h);
  ctx.clip();

  ctx.fillStyle = surface;
  ctx.fillRect(BUCKET.x, BUCKET.y, BUCKET.w, BUCKET.h);

  const fillY = BUCKET.y + (1 - level) * BUCKET.h;
  const grad = ctx.createLinearGradient(0, fillY, 0, BUCKET.y + BUCKET.h);
  grad.addColorStop(0, 'rgba(94,179,255,0.92)');
  grad.addColorStop(1, 'rgba(56,118,200,0.85)');
  ctx.fillStyle = grad;
  ctx.fillRect(BUCKET.x, fillY, BUCKET.w, BUCKET.h - (fillY - BUCKET.y));

  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(BUCKET.x, fillY);
  ctx.lineTo(BUCKET.x + BUCKET.w, fillY);
  ctx.stroke();

  for (const h of holes) {
    const wpt = holeWorldXY(h);
    if (wpt.y < fillY) continue;
    drawJet(h, wpt);
  }

  ctx.restore();

  ctx.lineWidth = 3;
  ctx.strokeStyle = text;
  ctx.strokeRect(BUCKET.x, BUCKET.y, BUCKET.w, BUCKET.h);

  ctx.strokeStyle = 'rgba(255,90,90,0.55)';
  ctx.setLineDash([6, 4]);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(BUCKET.x - 8, BUCKET.y + (1 - LOW) * BUCKET.h);
  ctx.lineTo(BUCKET.x + BUCKET.w + 8, BUCKET.y + (1 - LOW) * BUCKET.h);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,180,90,0.55)';
  ctx.beginPath();
  ctx.moveTo(BUCKET.x - 8, BUCKET.y + (1 - HIGH) * BUCKET.h);
  ctx.lineTo(BUCKET.x + BUCKET.w + 8, BUCKET.y + (1 - HIGH) * BUCKET.h);
  ctx.stroke();
  ctx.setLineDash([]);

  for (const h of holes) {
    drawHole(h);
  }

  ctx.fillStyle = text;
  ctx.font = '13px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('Taşma', BUCKET.x + BUCKET.w + 12, BUCKET.y + (1 - HIGH) * BUCKET.h + 4);
  ctx.fillText('Boşalma', BUCKET.x + BUCKET.w + 12, BUCKET.y + (1 - LOW) * BUCKET.h + 4);

  ctx.fillStyle = accent;
  ctx.font = 'bold 13px system-ui, sans-serif';
  ctx.textAlign = 'left';
  const tapLabel = tapOn ? '◆ MUSLUK AÇIK' : '◇ Boşluk: musluk';
  ctx.fillText(tapLabel, BUCKET.x, BUCKET.y - 50);
  ctx.fillStyle = text;
  ctx.font = '12px system-ui, sans-serif';
  ctx.fillText(`Delik: ${holes.length}`, BUCKET.x + 140, BUCKET.y - 50);
}

function drawJet(h: Hole, wpt: { x: number; y: number }): void {
  ctx.fillStyle = 'rgba(180,210,255,0.55)';
  const intensity = h.flow * 4;
  if (h.wall === 'left') {
    const len = 18 + intensity * 30;
    ctx.fillRect(wpt.x - len, wpt.y - 2, len, 4);
  } else if (h.wall === 'right') {
    const len = 18 + intensity * 30;
    ctx.fillRect(wpt.x, wpt.y - 2, len, 4);
  } else {
    const len = 14 + intensity * 22;
    ctx.fillRect(wpt.x - 2, wpt.y, 4, len);
  }
}

function drawHole(h: Hole): void {
  const p = holeWorldXY(h);
  const r = 6 + h.size * 3;
  ctx.beginPath();
  ctx.arc(p.x, p.y, r + 2, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.85)';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.fillStyle = '#1a0b0b';
  ctx.fill();
  ctx.strokeStyle = h.size === 3 ? '#ff7766' : h.size === 2 ? '#ffaa66' : '#ffcc88';
  ctx.lineWidth = 2;
  ctx.stroke();
}

function clientToCanvas(e: MouseEvent | Touch): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const sx = canvas.width / rect.width;
  const sy = canvas.height / rect.height;
  return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy };
}

function handlePointerDown(cx: number, cy: number): void {
  if (state === 'ready') {
    startPlay();
    return;
  }
  if (state !== 'playing') return;
  const idx = pickHoleAt(cx, cy);
  if (idx >= 0) plugHole(idx);
}

function onKeyDown(e: KeyboardEvent): void {
  const k = e.key.toLowerCase();
  if (k === ' ' || k === 'spacebar') {
    if (state === 'ready') {
      startPlay();
    }
    if (!tapHeld) tapHeld = true;
    e.preventDefault();
    return;
  }
  if (k === 'r') {
    reset();
    e.preventDefault();
  }
}

function onKeyUp(e: KeyboardEvent): void {
  const k = e.key.toLowerCase();
  if (k === ' ' || k === 'spacebar') {
    tapHeld = false;
    e.preventDefault();
  }
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  touchTapBtn = document.querySelector<HTMLButtonElement>('#touch-tap')!;

  bestSeconds = safeRead<number>(STORAGE_BEST, 0);

  canvas.addEventListener('mousedown', (e) => {
    const p = clientToCanvas(e);
    handlePointerDown(p.x, p.y);
    e.preventDefault();
  });
  canvas.addEventListener('touchstart', (e) => {
    const t = e.changedTouches[0];
    if (!t) return;
    const p = clientToCanvas(t);
    handlePointerDown(p.x, p.y);
    e.preventDefault();
  }, { passive: false });

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', () => {
    tapHeld = false;
    touchTapHeld = false;
  });

  const tapDown = (e: Event): void => {
    touchTapHeld = true;
    if (state === 'ready') startPlay();
    e.preventDefault();
  };
  const tapUp = (e: Event): void => {
    touchTapHeld = false;
    e.preventDefault();
  };
  touchTapBtn.addEventListener('mousedown', tapDown);
  touchTapBtn.addEventListener('mouseup', tapUp);
  touchTapBtn.addEventListener('mouseleave', tapUp);
  touchTapBtn.addEventListener('touchstart', tapDown, { passive: false });
  touchTapBtn.addEventListener('touchend', tapUp, { passive: false });
  touchTapBtn.addEventListener('touchcancel', tapUp, { passive: false });

  restartBtn.addEventListener('click', reset);

  reset();
}

export const game = defineGame({ init, reset });
