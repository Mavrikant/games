// Kabarcık — pop rising bubbles in rainbow order (R O Y G B I V, repeat).
// Tap a bubble of the current required color to advance the rainbow index.
// Wrong-color tap costs a life; missed bubbles (escaping the top) are
// ignored. Game over when lives reach zero.
//
// PITFALLS guarded:
// - module-level-dom-access: all DOM lookups + listeners live in init().
// - unguarded-storage: safeRead/safeWrite wrap localStorage.
// - stale-async-callback: gen.bump() in reset() cancels the running RAF loop.
// - overlay-input-leak: pointer/keyboard handlers gate on `state`.
// - missing-overlay-css: per-game CSS defines .overlay--hidden visuals.
// - unreachable-start-state: overlay exposes Start button + Space/Enter +
//   tap-anywhere; restart works from gameover.
// - hud-counter-synced-only-at-lifecycle-edges: score / lives / target chip
//   are rewritten the moment they mutate (popBubble, loseLife).

import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay, hideOverlay } from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';

const STORAGE_BEST = 'kabarcik.best';
const MAX_LIVES = 3;

const COLORS = [
  { name: 'Kırmızı', fill: '#ef4444', glow: '#fca5a5' },
  { name: 'Turuncu', fill: '#f97316', glow: '#fdba74' },
  { name: 'Sarı', fill: '#facc15', glow: '#fde68a' },
  { name: 'Yeşil', fill: '#22c55e', glow: '#86efac' },
  { name: 'Mavi', fill: '#3b82f6', glow: '#93c5fd' },
  { name: 'Lacivert', fill: '#6366f1', glow: '#a5b4fc' },
  { name: 'Mor', fill: '#a855f7', glow: '#d8b4fe' },
];

type State = 'ready' | 'playing' | 'gameover';

interface Bubble {
  x: number;
  y: number;
  r: number;
  vx: number;
  vy: number;
  colorIdx: number;
  popping: boolean;
  popAge: number;
}

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
let targetChip!: HTMLElement;
let targetName!: HTMLElement;

const gen = createGenToken();

let state: State = 'ready';
let score = 0;
let best = 0;
let lives = MAX_LIVES;
let requiredIdx = 0;
let bubbles: Bubble[] = [];
let spawnTimer = 0;
let lastFrameMs = 0;
let flashUntil = 0;
let flashColor = '';

function updateScoreHud(): void {
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
  livesEl.textContent = String(lives);
}

function updateTargetHud(): void {
  const c = COLORS[requiredIdx]!;
  targetChip.style.background = c.fill;
  targetChip.style.boxShadow = `0 0 14px ${c.glow}, 0 0 4px ${c.glow}`;
  targetName.textContent = c.name;
}

function showStartOverlay(): void {
  overlayTitle.textContent = 'Kabarcık';
  overlayMsg.textContent =
    'Yükselen kabarcıkları gökkuşağı sırasıyla patlat.\nKırmızı → Turuncu → Sarı → Yeşil → Mavi → Lacivert → Mor — sonra başa dön.\nYanlış renge dokunma! 3 hata = bitti.';
  overlayBtn.textContent = 'Başla';
  showOverlay(overlay);
}

function showGameOverOverlay(): void {
  overlayTitle.textContent = 'Bitti';
  overlayMsg.textContent = `Skor: ${score}\nEn iyi: ${best}\nYeniden denemek için tıkla.`;
  overlayBtn.textContent = 'Yeniden başla';
  showOverlay(overlay);
}

function difficulty(): { riseSpeed: number; spawnEvery: number; maxOnScreen: number; minR: number; maxR: number } {
  const round = Math.floor(score / 7);
  return {
    riseSpeed: 42 + round * 6,
    spawnEvery: Math.max(0.55, 1.25 - round * 0.07),
    maxOnScreen: Math.min(16, 8 + round),
    minR: Math.max(18, 26 - round * 0.6),
    maxR: Math.max(26, 34 - round * 0.6),
  };
}

function spawnBubble(opts: { entry?: 'below' | 'inside' } = {}): void {
  const d = difficulty();
  if (bubbles.filter((b) => !b.popping).length >= d.maxOnScreen) return;
  const r = d.minR + Math.random() * (d.maxR - d.minR);
  const padding = r + 4;
  const x = padding + Math.random() * (canvas.width - 2 * padding);
  // Bias spawn so that the required color appears more often when scarce
  // among on-screen bubbles — keeps the game playable instead of starving.
  const requiredOnScreen = bubbles.some(
    (b) => !b.popping && b.colorIdx === requiredIdx,
  );
  let colorIdx: number;
  if (!requiredOnScreen && Math.random() < 0.55) {
    colorIdx = requiredIdx;
  } else {
    colorIdx = Math.floor(Math.random() * COLORS.length);
  }
  const vy = -(d.riseSpeed + Math.random() * 10);
  const vx = (Math.random() - 0.5) * 18;
  // PITFALLS#invisible-boot: 'inside' spawns appear instantly within the
  // canvas (used at startGame), 'below' spawns slide up from the bottom.
  const y =
    opts.entry === 'inside'
      ? canvas.height - r - Math.random() * 80
      : canvas.height + r + 2;
  bubbles.push({
    x,
    y,
    r,
    vx,
    vy,
    colorIdx,
    popping: false,
    popAge: 0,
  });
}

function popBubble(b: Bubble, success: boolean): void {
  b.popping = true;
  b.popAge = 0;
  if (success) {
    flashColor = COLORS[b.colorIdx]!.glow;
    flashUntil = performance.now() + 140;
  }
}

function advanceRequired(): void {
  requiredIdx = (requiredIdx + 1) % COLORS.length;
  updateTargetHud();
}

function loseLife(): void {
  lives--;
  flashColor = '#dc2626';
  flashUntil = performance.now() + 220;
  updateScoreHud();
  if (lives <= 0) {
    endGame();
  }
}

function endGame(): void {
  state = 'gameover';
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
  updateScoreHud();
  showGameOverOverlay();
}

function startGame(): void {
  if (state === 'playing') return;
  gen.bump();
  state = 'playing';
  score = 0;
  lives = MAX_LIVES;
  requiredIdx = 0;
  bubbles = [];
  spawnTimer = 0;
  lastFrameMs = 0;
  // Pre-spawn a small cluster inside the playfield so the first frame
  // already has something to tap — PITFALLS#invisible-boot.
  for (let i = 0; i < 4; i++) spawnBubble({ entry: 'inside' });
  updateScoreHud();
  updateTargetHud();
  hideOverlay(overlay);
  startLoop();
}

function reset(): void {
  gen.bump();
  state = 'ready';
  score = 0;
  lives = MAX_LIVES;
  requiredIdx = 0;
  bubbles = [];
  spawnTimer = 0;
  lastFrameMs = 0;
  updateScoreHud();
  updateTargetHud();
  draw();
  showStartOverlay();
}

function startLoop(): void {
  const myGen = gen.current();
  lastFrameMs = performance.now();
  const loop = (now: number): void => {
    if (!gen.isCurrent(myGen)) return;
    const dt = Math.min(0.05, (now - lastFrameMs) / 1000);
    lastFrameMs = now;
    if (state === 'playing') tick(dt);
    draw();
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

function tick(dt: number): void {
  spawnTimer -= dt;
  const d = difficulty();
  if (spawnTimer <= 0) {
    spawnBubble();
    spawnTimer = d.spawnEvery * (0.85 + Math.random() * 0.3);
  }
  for (const b of bubbles) {
    if (b.popping) {
      b.popAge += dt;
      continue;
    }
    b.y += b.vy * dt;
    b.x += b.vx * dt;
    if (b.x - b.r < 0) {
      b.x = b.r;
      b.vx = Math.abs(b.vx);
    } else if (b.x + b.r > canvas.width) {
      b.x = canvas.width - b.r;
      b.vx = -Math.abs(b.vx);
    }
  }
  bubbles = bubbles.filter((b) => {
    if (b.popping) return b.popAge < 0.32;
    if (b.y + b.r < -4) return false;
    return true;
  });
}

function draw(): void {
  // Background gradient — water tube.
  const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
  grad.addColorStop(0, '#0b1220');
  grad.addColorStop(1, '#152033');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Top "exit" line — visual hint where bubbles escape.
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  ctx.setLineDash([6, 6]);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, 6);
  ctx.lineTo(canvas.width, 6);
  ctx.stroke();
  ctx.setLineDash([]);

  for (const b of bubbles) {
    drawBubble(b);
  }

  // Flash overlay for feedback (correct = soft glow, wrong = red flash).
  const now = performance.now();
  if (now < flashUntil) {
    const remain = (flashUntil - now) / 220;
    ctx.fillStyle = flashColor;
    ctx.globalAlpha = 0.18 * remain;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.globalAlpha = 1;
  }
}

function drawBubble(b: Bubble): void {
  const c = COLORS[b.colorIdx]!;
  if (b.popping) {
    const t = b.popAge / 0.32;
    const r = b.r * (1 + t * 0.8);
    ctx.strokeStyle = c.fill;
    ctx.globalAlpha = Math.max(0, 1 - t);
    ctx.lineWidth = 2 + 2 * (1 - t);
    ctx.beginPath();
    ctx.arc(b.x, b.y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
    return;
  }
  // Soft outer halo so the color reads even at small sizes.
  const halo = ctx.createRadialGradient(
    b.x - b.r * 0.3,
    b.y - b.r * 0.3,
    b.r * 0.2,
    b.x,
    b.y,
    b.r,
  );
  halo.addColorStop(0, c.glow);
  halo.addColorStop(0.55, c.fill);
  halo.addColorStop(1, c.fill);
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
  ctx.fill();
  // Rim.
  ctx.strokeStyle = 'rgba(0,0,0,0.25)';
  ctx.lineWidth = 1;
  ctx.stroke();
  // Highlight.
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.beginPath();
  ctx.arc(b.x - b.r * 0.35, b.y - b.r * 0.35, b.r * 0.22, 0, Math.PI * 2);
  ctx.fill();
}

function hitTest(px: number, py: number): Bubble | null {
  // Topmost (latest-spawned, lowest y) hit wins — pick smallest distance.
  let best: Bubble | null = null;
  let bestDist = Infinity;
  for (const b of bubbles) {
    if (b.popping) continue;
    const dx = b.x - px;
    const dy = b.y - py;
    const d2 = dx * dx + dy * dy;
    if (d2 <= b.r * b.r && d2 < bestDist) {
      bestDist = d2;
      best = b;
    }
  }
  return best;
}

function canvasCoordsFromEvent(e: PointerEvent | MouseEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const sx = canvas.width / rect.width;
  const sy = canvas.height / rect.height;
  return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy };
}

function handleTap(px: number, py: number): void {
  if (state !== 'playing') return;
  const b = hitTest(px, py);
  if (!b) return;
  if (b.colorIdx === requiredIdx) {
    popBubble(b, true);
    score++;
    advanceRequired();
    updateScoreHud();
  } else {
    popBubble(b, false);
    loseLife();
  }
}

function onPointerDown(e: PointerEvent): void {
  if (state === 'ready') {
    startGame();
    e.preventDefault();
    return;
  }
  if (state === 'gameover') return; // overlay button handles restart
  const { x, y } = canvasCoordsFromEvent(e);
  handleTap(x, y);
  e.preventDefault();
}

function onKey(e: KeyboardEvent): void {
  const k = e.key.toLowerCase();
  if (k === 'r') {
    reset();
    e.preventDefault();
    return;
  }
  if (k === ' ' || k === 'enter') {
    if (state === 'ready' || state === 'gameover') {
      if (state === 'gameover') reset();
      startGame();
      e.preventDefault();
    }
  }
}

function onOverlayBtn(): void {
  if (state === 'gameover') reset();
  startGame();
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
  targetChip = document.querySelector<HTMLElement>('#target-chip')!;
  targetName = document.querySelector<HTMLElement>('#target-name')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  canvas.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('keydown', onKey);
  restartBtn.addEventListener('click', reset);
  overlayBtn.addEventListener('click', onOverlayBtn);

  reset();
  // Kick the render loop immediately so the playfield is visible before
  // the first tap — addresses PITFALLS#invisible-boot.
  startLoop();
}

export const game = defineGame({ init, reset });
