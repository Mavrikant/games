import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import {
  showOverlay as showOverlayEl,
  hideOverlay as hideOverlayEl,
} from '@shared/overlay';
import { reportGameOver } from '@shared/leaderboard';

const STORAGE_BEST = 'ag-or.best';
const SCORE_DESC = {
  gameId: 'ag-or',
  storageKey: STORAGE_BEST,
  direction: 'higher' as const,
};

type State = 'ready' | 'playing' | 'gameover';

const ANCHORS = 8;
const RINGS = 4;
const ROUND_MS = 60_000;
const MAX_SILK = 12;
const SILK_REGEN_MS = 1800;
const SPAWN_MIN_MS = 700;
const SPAWN_MAX_MS = 1500;
const STUCK_MS = 1500;
const RING_RATIOS = [0.32, 0.52, 0.72, 0.92];

interface Insect {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  value: number;
  color: string;
  strong: boolean;
  stuck: { threadKey: string; t: number; jiggle: number } | null;
  life: number;
  dead: boolean;
}

interface ThreadSegment {
  key: string;
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let silkEl!: HTMLElement;
let timeEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;

let state: State = 'ready';
let score = 0;
let best = 0;
let silk = 10;
let silkAccumMs = 0;
let timeRemainingMs = ROUND_MS;
let radials: boolean[] = new Array(ANCHORS).fill(false);
let chords: boolean[][] = [];
let insects: Insect[] = [];
let nextSpawnMs = 0;
let lastFrameTime = 0;
let frameScheduled = false;

let centerX = 240;
let centerY = 240;
let outerR = 200;

const gen = createGenToken();

function initWebArrays(): void {
  radials = new Array(ANCHORS).fill(false);
  chords = [];
  for (let i = 0; i < ANCHORS; i++) {
    chords.push(new Array<boolean>(RINGS).fill(false));
  }
}

function anchorPos(i: number): { x: number; y: number } {
  const a = (i / ANCHORS) * Math.PI * 2 - Math.PI / 2;
  return {
    x: centerX + Math.cos(a) * outerR,
    y: centerY + Math.sin(a) * outerR,
  };
}

function radialPoint(i: number, r: number): { x: number; y: number } {
  const a = (i / ANCHORS) * Math.PI * 2 - Math.PI / 2;
  const rad = outerR * RING_RATIOS[r]!;
  return { x: centerX + Math.cos(a) * rad, y: centerY + Math.sin(a) * rad };
}

function chordMidpoint(i: number, r: number): { x: number; y: number } {
  const a = radialPoint(i, r);
  const b = radialPoint((i + 1) % ANCHORS, r);
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function getActiveThreads(): ThreadSegment[] {
  const out: ThreadSegment[] = [];
  for (let i = 0; i < ANCHORS; i++) {
    if (radials[i]) {
      const a = anchorPos(i);
      out.push({ key: `r${i}`, ax: centerX, ay: centerY, bx: a.x, by: a.y });
    }
  }
  for (let i = 0; i < ANCHORS; i++) {
    for (let r = 0; r < RINGS; r++) {
      if (chords[i]?.[r]) {
        const a = radialPoint(i, r);
        const b = radialPoint((i + 1) % ANCHORS, r);
        out.push({ key: `c${i}_${r}`, ax: a.x, ay: a.y, bx: b.x, by: b.y });
      }
    }
  }
  return out;
}

function distToSeg(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): { dist: number; cx: number; cy: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 0.0001) {
    return { dist: Math.hypot(px - ax, py - ay), cx: ax, cy: ay };
  }
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return { dist: Math.hypot(px - cx, py - cy), cx, cy };
}

function isThreadActive(key: string): boolean {
  if (key.length < 2) return false;
  if (key[0] === 'r') {
    const idx = Number(key.slice(1));
    return Number.isFinite(idx) && !!radials[idx];
  }
  if (key[0] === 'c') {
    const m = /^c(\d+)_(\d+)$/.exec(key);
    if (!m) return false;
    const i = Number(m[1]);
    const r = Number(m[2]);
    return !!chords[i]?.[r];
  }
  return false;
}

function spawnInsect(): void {
  const t = Math.random();
  let size: number;
  let value: number;
  let color: string;
  let speed: number;
  let strong: boolean;
  if (t < 0.6) {
    size = 3.5;
    value = 1;
    color = '#9be6c5';
    speed = 90;
    strong = false;
  } else if (t < 0.88) {
    size = 5.5;
    value = 2;
    color = '#e8d57a';
    speed = 65;
    strong = false;
  } else {
    size = 7.5;
    value = 5;
    color = '#e07c5a';
    speed = 110;
    strong = true;
  }
  const startAngle = Math.random() * Math.PI * 2;
  const x = centerX + Math.cos(startAngle) * (outerR + 30);
  const y = centerY + Math.sin(startAngle) * (outerR + 30);
  const targetR = Math.random() * outerR * 0.65;
  const targetA = Math.random() * Math.PI * 2;
  const tx = centerX + Math.cos(targetA) * targetR;
  const ty = centerY + Math.sin(targetA) * targetR;
  const dx = tx - x;
  const dy = ty - y;
  const len = Math.hypot(dx, dy) || 1;
  insects.push({
    x,
    y,
    vx: (dx / len) * speed,
    vy: (dy / len) * speed,
    size,
    value,
    color,
    strong,
    stuck: null,
    life: 0,
    dead: false,
  });
}

function tryBuild(px: number, py: number): boolean {
  if (state !== 'playing') return false;
  if (silk <= 0) return false;

  let bestChord: { i: number; r: number; d: number } | null = null;
  for (let i = 0; i < ANCHORS; i++) {
    if (!radials[i] || !radials[(i + 1) % ANCHORS]) continue;
    for (let r = 0; r < RINGS; r++) {
      if (chords[i]?.[r]) continue;
      const mp = chordMidpoint(i, r);
      const d = Math.hypot(px - mp.x, py - mp.y);
      if (d < 22 && (bestChord === null || d < bestChord.d)) {
        bestChord = { i, r, d };
      }
    }
  }
  let bestAnchor: { i: number; d: number } | null = null;
  for (let i = 0; i < ANCHORS; i++) {
    if (radials[i]) continue;
    const a = anchorPos(i);
    const d = Math.hypot(px - a.x, py - a.y);
    if (d < 30 && (bestAnchor === null || d < bestAnchor.d)) {
      bestAnchor = { i, d };
    }
  }
  if (bestChord && (!bestAnchor || bestChord.d < bestAnchor.d)) {
    chords[bestChord.i]![bestChord.r] = true;
    silk--;
    updateHud();
    return true;
  }
  if (bestAnchor) {
    radials[bestAnchor.i] = true;
    silk--;
    updateHud();
    return true;
  }
  return false;
}

function breakThread(key: string): void {
  if (key[0] === 'r') {
    const idx = Number(key.slice(1));
    if (!Number.isFinite(idx)) return;
    radials[idx] = false;
    const prev = (idx - 1 + ANCHORS) % ANCHORS;
    for (let r = 0; r < RINGS; r++) {
      if (chords[idx]) chords[idx][r] = false;
      if (chords[prev]) chords[prev][r] = false;
    }
  } else if (key[0] === 'c') {
    const m = /^c(\d+)_(\d+)$/.exec(key);
    if (!m) return;
    const i = Number(m[1]);
    const r = Number(m[2]);
    if (chords[i]) chords[i][r] = false;
  }
  for (const ins of insects) {
    if (ins.stuck && !isThreadActive(ins.stuck.threadKey)) {
      ins.stuck = null;
      ins.vx = (Math.random() - 0.5) * 50;
      ins.vy = (Math.random() - 0.5) * 50;
    }
  }
}

function updateHud(): void {
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
  silkEl.textContent = String(silk);
  timeEl.textContent = String(Math.max(0, Math.ceil(timeRemainingMs / 1000)));
}

function showOverlayWith(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlay);
}

function reset(): void {
  gen.bump();
  state = 'ready';
  score = 0;
  silk = 10;
  silkAccumMs = 0;
  timeRemainingMs = ROUND_MS;
  insects = [];
  nextSpawnMs = 900;
  initWebArrays();
  updateHud();
  showOverlayWith(
    'Ağ Ör',
    '8 tutamağa tıkla → radyal ip. İki dolu radyal arasındaki halka noktasına tıkla → çapraz. İpek azdır, regenere olur. 60 saniyede en çok böceği yakala. Başlamak için tıkla veya Boşluk.',
  );
  draw();
}

function start(): void {
  if (state === 'playing') return;
  state = 'playing';
  hideOverlayEl(overlay);
  lastFrameTime = performance.now();
  scheduleFrame();
}

function endRound(): void {
  state = 'gameover';
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
  updateHud();
  reportGameOver(SCORE_DESC, score);
  showOverlayWith(
    'Süre doldu',
    `Skor: ${score} · Tıkla veya Boşluk: yeniden başla`,
  );
}

function scheduleFrame(): void {
  if (frameScheduled) return;
  frameScheduled = true;
  const myGen = gen.current();
  requestAnimationFrame((now) => {
    frameScheduled = false;
    if (!gen.isCurrent(myGen)) return;
    update(now);
  });
}

function update(now: number): void {
  if (state !== 'playing') return;
  const dt = Math.min(50, now - lastFrameTime);
  lastFrameTime = now;

  timeRemainingMs -= dt;
  if (timeRemainingMs <= 0) {
    timeRemainingMs = 0;
    updateHud();
    draw();
    endRound();
    return;
  }

  silkAccumMs += dt;
  while (silkAccumMs >= SILK_REGEN_MS) {
    silkAccumMs -= SILK_REGEN_MS;
    if (silk < MAX_SILK) silk++;
  }

  nextSpawnMs -= dt;
  while (nextSpawnMs <= 0) {
    spawnInsect();
    nextSpawnMs += SPAWN_MIN_MS + Math.random() * (SPAWN_MAX_MS - SPAWN_MIN_MS);
  }

  const threads = getActiveThreads();
  const dts = dt / 1000;
  for (const ins of insects) {
    if (ins.dead) continue;
    if (ins.stuck) {
      ins.stuck.t += dt;
      ins.stuck.jiggle += dt;
      if (ins.stuck.t >= STUCK_MS) {
        score += ins.value;
        if (ins.strong && Math.random() < 0.45) {
          breakThread(ins.stuck.threadKey);
        }
        ins.dead = true;
      }
      continue;
    }
    ins.x += ins.vx * dts;
    ins.y += ins.vy * dts;
    ins.life += dt;
    const dFromCenter = Math.hypot(ins.x - centerX, ins.y - centerY);
    if (dFromCenter > outerR + 50 || ins.life > 8000) {
      ins.dead = true;
      continue;
    }
    for (const t of threads) {
      const r = distToSeg(ins.x, ins.y, t.ax, t.ay, t.bx, t.by);
      if (r.dist < ins.size + 1.5) {
        ins.stuck = { threadKey: t.key, t: 0, jiggle: 0 };
        ins.x = r.cx;
        ins.y = r.cy;
        ins.vx = 0;
        ins.vy = 0;
        break;
      }
    }
  }
  insects = insects.filter((i) => !i.dead);

  updateHud();
  draw();
  scheduleFrame();
}

function draw(): void {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(centerX, centerY, outerR + 6, 0, Math.PI * 2);
  ctx.stroke();

  if (state !== 'gameover') {
    ctx.fillStyle = 'rgba(220,225,240,0.16)';
    for (let i = 0; i < ANCHORS; i++) {
      if (radials[i]) continue;
      const a = anchorPos(i);
      ctx.beginPath();
      ctx.arc(a.x, a.y, 6, 0, Math.PI * 2);
      ctx.fill();
    }
    for (let i = 0; i < ANCHORS; i++) {
      if (!radials[i] || !radials[(i + 1) % ANCHORS]) continue;
      for (let r = 0; r < RINGS; r++) {
        if (chords[i]?.[r]) continue;
        const mp = chordMidpoint(i, r);
        ctx.beginPath();
        ctx.arc(mp.x, mp.y, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  ctx.strokeStyle = 'rgba(232,236,242,0.92)';
  ctx.lineWidth = 1.4;
  ctx.lineCap = 'round';
  for (let i = 0; i < ANCHORS; i++) {
    if (!radials[i]) continue;
    const a = anchorPos(i);
    ctx.beginPath();
    ctx.moveTo(centerX, centerY);
    ctx.lineTo(a.x, a.y);
    ctx.stroke();
  }
  for (let i = 0; i < ANCHORS; i++) {
    for (let r = 0; r < RINGS; r++) {
      if (!chords[i]?.[r]) continue;
      const a = radialPoint(i, r);
      const b = radialPoint((i + 1) % ANCHORS, r);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }

  ctx.fillStyle = '#cdd6e0';
  for (let i = 0; i < ANCHORS; i++) {
    const a = anchorPos(i);
    ctx.beginPath();
    ctx.arc(a.x, a.y, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }

  for (const ins of insects) {
    let drawX = ins.x;
    let drawY = ins.y;
    if (ins.stuck) {
      const wob = Math.sin(ins.stuck.jiggle / 60) * 1.4;
      drawX += wob;
      drawY += Math.cos(ins.stuck.jiggle / 80) * 1.2;
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(drawX, drawY, ins.size + 2.5, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = ins.color;
    ctx.beginPath();
    ctx.arc(drawX, drawY, ins.size, 0, Math.PI * 2);
    ctx.fill();
    if (!ins.stuck) {
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      const wx = Math.cos(performance.now() / 40 + ins.life) * (ins.size + 1);
      const wy = Math.sin(performance.now() / 40 + ins.life) * (ins.size + 1);
      ctx.beginPath();
      ctx.arc(drawX - wx, drawY - wy, 1.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(drawX + wx, drawY + wy, 1.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  drawSpider(centerX, centerY);
}

function drawSpider(cx: number, cy: number): void {
  ctx.strokeStyle = '#1a1622';
  ctx.lineWidth = 1.3;
  ctx.lineCap = 'round';
  const legAngles = [-1.0, -1.5, -2.0, -2.5];
  for (const baseA of legAngles) {
    for (const side of [-1, 1]) {
      const a = baseA;
      const x1 = cx + side * Math.cos(a) * 7;
      const y1 = cy + Math.sin(a) * 7;
      const x2 = x1 + side * Math.cos(a + 0.6) * 7;
      const y2 = y1 + Math.sin(a + 0.6) * 7;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
  }
  ctx.fillStyle = '#2c1f33';
  ctx.beginPath();
  ctx.ellipse(cx, cy + 2, 6, 8, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#3a2940';
  ctx.beginPath();
  ctx.arc(cx, cy - 4, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#e8b85a';
  ctx.beginPath();
  ctx.arc(cx - 1.4, cy - 5, 0.9, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx + 1.4, cy - 5, 0.9, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(200,130,90,0.4)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx - 4, cy + 3);
  ctx.lineTo(cx + 4, cy + 3);
  ctx.stroke();
}

function canvasCoords(e: PointerEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const sx = canvas.width / rect.width;
  const sy = canvas.height / rect.height;
  return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy };
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  silkEl = document.querySelector<HTMLElement>('#silk')!;
  timeEl = document.querySelector<HTMLElement>('#time')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;

  centerX = canvas.width / 2;
  centerY = canvas.height / 2;
  outerR = Math.min(canvas.width, canvas.height) * 0.42;

  best = safeRead<number>(STORAGE_BEST, 0);
  if (!Number.isFinite(best) || best < 0) best = 0;

  canvas.addEventListener('pointerdown', (e) => {
    if (state === 'gameover') return;
    if (state === 'ready') {
      start();
      return;
    }
    const c = canvasCoords(e);
    tryBuild(c.x, c.y);
  });

  overlay.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (state === 'ready') {
      start();
    } else if (state === 'gameover') {
      reset();
      start();
    }
  });

  restartBtn.addEventListener('click', () => {
    reset();
  });

  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'r') {
      reset();
      e.preventDefault();
    } else if (k === ' ' || k === 'enter') {
      if (state === 'ready') {
        start();
        e.preventDefault();
      } else if (state === 'gameover') {
        reset();
        start();
        e.preventDefault();
      }
    }
  });

  initWebArrays();
  reset();
}

export const game = defineGame({ init, reset });
