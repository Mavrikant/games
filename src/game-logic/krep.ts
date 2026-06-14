import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay, hideOverlay } from '@shared/overlay';

const STORAGE_BEST = 'krep.best';
const PAN_COUNT = 4;
const PAN_COLS = 2;

const RAW_DURATION = 3000;
const READY_WINDOW_BASE = 1700;
const READY_WINDOW_MIN = 800;
const READY_WINDOW_STEP = 25;
const BURN_HOLD = 1200;
const SPAWN_BASE = 2400;
const SPAWN_MIN = 900;
const SPAWN_STEP = 60;
const START_LIVES = 3;

type PanState = 'empty' | 'cookA' | 'cookB' | 'burnt';
type GameState = 'ready' | 'playing' | 'gameover';

interface Pan {
  state: PanState;
  elapsed: number;
  burntElapsed: number;
}

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let livesEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;

let pans: Pan[] = [];
let gameState: GameState = 'ready';
let score = 0;
let best = 0;
let lives = START_LIVES;
let spawnTimer = 0;
let lastFrame = 0;

function readyWindowMs(): number {
  return Math.max(READY_WINDOW_MIN, READY_WINDOW_BASE - score * READY_WINDOW_STEP);
}

function spawnIntervalMs(): number {
  return Math.max(SPAWN_MIN, SPAWN_BASE - score * SPAWN_STEP);
}

function panBounds(i: number): { cx: number; cy: number; r: number } {
  const col = i % PAN_COLS;
  const row = Math.floor(i / PAN_COLS);
  const cellW = canvas.width / PAN_COLS;
  const cellH = canvas.height / PAN_COLS;
  return {
    cx: col * cellW + cellW / 2,
    cy: row * cellH + cellH / 2,
    r: Math.min(cellW, cellH) * 0.4,
  };
}

function pickPanAt(clientX: number, clientY: number): number {
  const rect = canvas.getBoundingClientRect();
  const px = ((clientX - rect.left) / rect.width) * canvas.width;
  const py = ((clientY - rect.top) / rect.height) * canvas.height;
  for (let i = 0; i < PAN_COUNT; i++) {
    const { cx, cy, r } = panBounds(i);
    const dx = px - cx;
    const dy = py - cy;
    const hit = r + 18;
    if (dx * dx + dy * dy <= hit * hit) return i;
  }
  return -1;
}

function findEmptyPan(): number {
  const empties: number[] = [];
  for (let i = 0; i < PAN_COUNT; i++) {
    if (pans[i]!.state === 'empty') empties.push(i);
  }
  if (empties.length === 0) return -1;
  return empties[Math.floor(Math.random() * empties.length)]!;
}

function spawnPancake(): void {
  const i = findEmptyPan();
  if (i < 0) return;
  pans[i] = { state: 'cookA', elapsed: 0, burntElapsed: 0 };
}

function updateBest(): void {
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
    bestEl.textContent = String(best);
  }
}

function loseLife(): void {
  lives--;
  livesEl.textContent = String(lives);
  if (lives <= 0) endGame();
}

function endGame(): void {
  gameState = 'gameover';
  updateBest();
  overlayTitle.textContent = 'Mutfak Kapandı';
  overlayMsg.textContent =
    `${score} krep servis ettin.\nRekor: ${best}\nDevam için tıkla veya R'ye bas.`;
  showOverlay(overlay);
}

function showReadyOverlay(): void {
  overlayTitle.textContent = 'Krep Tavası';
  overlayMsg.textContent =
    'Yeşil halka çıkınca tıkla:\nİlk tık = çevir · İkinci tık = servis et.\nBekletirsen yanar — 3 canın var.\nBaşlamak için tıkla / Boşluk / Enter.';
  showOverlay(overlay);
}

function reset(): void {
  pans = [];
  for (let i = 0; i < PAN_COUNT; i++) {
    pans.push({ state: 'empty', elapsed: 0, burntElapsed: 0 });
  }
  score = 0;
  lives = START_LIVES;
  spawnTimer = 0;
  scoreEl.textContent = '0';
  livesEl.textContent = String(lives);
  bestEl.textContent = String(best);
  gameState = 'ready';
  showReadyOverlay();
  draw();
}

function startGame(): void {
  if (gameState !== 'ready') return;
  gameState = 'playing';
  hideOverlay(overlay);
  spawnPancake();
  spawnTimer = 0;
}

function onPanClick(panIndex: number): void {
  if (gameState !== 'playing') return;
  const p = pans[panIndex]!;
  if (p.state === 'empty') return;
  if (p.state === 'burnt') {
    pans[panIndex] = { state: 'empty', elapsed: 0, burntElapsed: 0 };
    return;
  }
  if (p.state === 'cookA') {
    if (p.elapsed >= RAW_DURATION) {
      p.state = 'cookB';
      p.elapsed = 0;
    } else {
      pans[panIndex] = { state: 'burnt', elapsed: 0, burntElapsed: 0 };
      loseLife();
    }
    return;
  }
  if (p.elapsed >= RAW_DURATION) {
    score++;
    scoreEl.textContent = String(score);
    updateBest();
    pans[panIndex] = { state: 'empty', elapsed: 0, burntElapsed: 0 };
  } else {
    pans[panIndex] = { state: 'burnt', elapsed: 0, burntElapsed: 0 };
    loseLife();
  }
}

function update(dt: number): void {
  spawnTimer += dt;
  if (spawnTimer >= spawnIntervalMs()) {
    spawnTimer = 0;
    spawnPancake();
  }

  for (let i = 0; i < PAN_COUNT; i++) {
    const p = pans[i]!;
    if (p.state === 'cookA' || p.state === 'cookB') {
      p.elapsed += dt;
      if (p.elapsed >= RAW_DURATION + readyWindowMs()) {
        p.state = 'burnt';
        p.burntElapsed = 0;
        loseLife();
      }
    } else if (p.state === 'burnt') {
      p.burntElapsed += dt;
      if (p.burntElapsed >= BURN_HOLD) {
        pans[i] = { state: 'empty', elapsed: 0, burntElapsed: 0 };
      }
    }
  }
}

function loop(now: number): void {
  requestAnimationFrame(loop);
  const dt = Math.min(64, now - lastFrame);
  lastFrame = now;
  if (gameState === 'playing') update(dt);
  draw();
}

function draw(): void {
  ctx.fillStyle = '#15100c';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = '#352720';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(canvas.width / 2, 12);
  ctx.lineTo(canvas.width / 2, canvas.height - 12);
  ctx.moveTo(12, canvas.height / 2);
  ctx.lineTo(canvas.width - 12, canvas.height / 2);
  ctx.stroke();

  for (let i = 0; i < PAN_COUNT; i++) drawPan(i);
}

function drawPan(i: number): void {
  const p = pans[i]!;
  const { cx, cy, r } = panBounds(i);

  // Pan body
  ctx.fillStyle = '#0c0a09';
  ctx.beginPath();
  ctx.arc(cx, cy, r + 6, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#262019';
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = '#3a302a';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, r - 4, 0, Math.PI * 2);
  ctx.stroke();

  if (p.state === 'empty') return;
  if (p.state === 'burnt') {
    drawBurnt(cx, cy, r);
    return;
  }

  const isReady = p.elapsed >= RAW_DURATION;
  const cookT = Math.min(1, p.elapsed / RAW_DURATION);
  const overT = isReady
    ? Math.min(1, (p.elapsed - RAW_DURATION) / readyWindowMs())
    : 0;

  const pancakeR = r * 0.78;
  const palette =
    p.state === 'cookA'
      ? ['#f4d97a', '#e9aa3d', '#b46d22']
      : ['#caa05a', '#8a5523', '#3a1d0b'];
  const color = mixPalette(palette, cookT * 0.85 + overT * 0.15);

  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  ctx.beginPath();
  ctx.ellipse(cx, cy + 3, pancakeR, pancakeR * 0.6, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(cx, cy, pancakeR, 0, Math.PI * 2);
  ctx.fill();

  // Cooking bubbles (side A only)
  if (p.state === 'cookA' && cookT > 0.35) {
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    for (let k = 0; k < 5; k++) {
      const ang = (k / 5) * Math.PI * 2 + i * 0.7;
      const rd = pancakeR * 0.55;
      const bx = cx + Math.cos(ang) * rd * cookT;
      const by = cy + Math.sin(ang) * rd * cookT;
      ctx.beginPath();
      ctx.arc(bx, by, 2 + cookT * 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  if (p.state === 'cookB') {
    // Tiny "flipped" highlight to communicate side change
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    ctx.beginPath();
    ctx.arc(cx - pancakeR * 0.45, cy - pancakeR * 0.45, pancakeR * 0.18, 0, Math.PI * 2);
    ctx.fill();
  }

  if (isReady) {
    const remaining = 1 - overT;
    const pulse = 0.6 + 0.4 * Math.sin(performance.now() / 120);
    const ringColor = remaining > 0.35
      ? `rgba(120, 220, 130, ${0.55 + 0.4 * pulse})`
      : `rgba(245, 90, 70, ${0.55 + 0.4 * pulse})`;
    ctx.strokeStyle = ringColor;
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(cx, cy, r + 2, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(255,255,255,0.78)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(cx, cy, r - 10, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * remaining);
    ctx.stroke();

    ctx.fillStyle = 'rgba(15,10,8,0.75)';
    ctx.beginPath();
    roundRect(cx - 44, cy - 13, 88, 26, 13);
    ctx.fill();

    ctx.fillStyle = '#fff';
    ctx.font = 'bold 14px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(p.state === 'cookA' ? 'ÇEVİR' : 'SERVİS', cx, cy);
  }
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

function drawBurnt(cx: number, cy: number, r: number): void {
  const pancakeR = r * 0.78;
  ctx.fillStyle = '#1a0d05';
  ctx.beginPath();
  ctx.arc(cx, cy, pancakeR, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = 'rgba(120,40,20,0.55)';
  for (let k = 0; k < 6; k++) {
    const ang = (k / 6) * Math.PI * 2;
    const dx = Math.cos(ang) * pancakeR * 0.45;
    const dy = Math.sin(ang) * pancakeR * 0.45;
    ctx.beginPath();
    ctx.arc(cx + dx, cy + dy, 5, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.strokeStyle = 'rgba(220,210,200,0.45)';
  ctx.lineWidth = 2;
  for (let s = -1; s <= 1; s++) {
    ctx.beginPath();
    ctx.moveTo(cx + s * 8, cy - pancakeR);
    ctx.bezierCurveTo(
      cx + s * 8 + 12, cy - pancakeR - 14,
      cx + s * 8 - 12, cy - pancakeR - 28,
      cx + s * 8 + 4, cy - pancakeR - 44,
    );
    ctx.stroke();
  }

  ctx.strokeStyle = 'rgba(245,80,80,0.85)';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(cx - 12, cy - 12);
  ctx.lineTo(cx + 12, cy + 12);
  ctx.moveTo(cx + 12, cy - 12);
  ctx.lineTo(cx - 12, cy + 12);
  ctx.stroke();
}

function mixPalette(colors: string[], tRaw: number): string {
  const t = Math.max(0, Math.min(1, tRaw));
  const segs = colors.length - 1;
  const idx = Math.min(segs - 1, Math.floor(t * segs));
  const local = t * segs - idx;
  const a = parseHex(colors[idx]!);
  const b = parseHex(colors[idx + 1]!);
  const r = Math.round(a.r + (b.r - a.r) * local);
  const g = Math.round(a.g + (b.g - a.g) * local);
  const bl = Math.round(a.b + (b.b - a.b) * local);
  return `rgb(${r},${g},${bl})`;
}

function parseHex(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  livesEl = document.querySelector<HTMLElement>('#lives')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (gameState === 'ready') {
      startGame();
      return;
    }
    if (gameState === 'gameover') {
      reset();
      return;
    }
    const i = pickPanAt(e.clientX, e.clientY);
    if (i >= 0) onPanClick(i);
  });

  overlay.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (gameState === 'ready') startGame();
    else if (gameState === 'gameover') reset();
  });

  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'r') {
      reset();
      e.preventDefault();
      return;
    }
    if (k === ' ' || k === 'enter') {
      if (gameState === 'ready') startGame();
      else if (gameState === 'gameover') reset();
      e.preventDefault();
      return;
    }
    if (k >= '1' && k <= '4') {
      if (gameState === 'ready') startGame();
      else if (gameState === 'playing') onPanClick(parseInt(k, 10) - 1);
      e.preventDefault();
    }
  });

  restartBtn.addEventListener('click', () => reset());

  reset();
  lastFrame = performance.now();
  requestAnimationFrame(loop);
}

export const game = defineGame({ init, reset });
