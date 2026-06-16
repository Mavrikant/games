import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';

type State = 'ready' | 'playing' | 'forging' | 'gameover';

const STORAGE_BEST = 'demirci.best';
const CELLS = 8;
const MAX_HEIGHT = 8;
const HEAT_MAX = 100;
const HEAT_DECAY_PER_SEC = 4;
const HEAT_PER_STRIKE = 8;
const HOT_THRESHOLD = 66;
const FORGE_DURATION_MS = 1400;
const PIECE_TIME_START_MS = 25_000;
const PIECE_TIME_MIN_MS = 12_000;
const PIECE_TIME_DROP_MS = 1_500;

interface Piece {
  name: string;
  target: number[];
}

const PIECES: Piece[] = [
  { name: 'Balta', target: [6, 5, 4, 3, 3, 4, 5, 6] },
  { name: 'Nal', target: [7, 5, 3, 2, 2, 3, 5, 7] },
  { name: 'Çubuk', target: [4, 4, 4, 4, 4, 4, 4, 4] },
  { name: 'Mızrak', target: [7, 5, 3, 1, 1, 3, 5, 7] },
  { name: 'Çekiç', target: [3, 3, 5, 7, 7, 5, 3, 3] },
  { name: 'Keser', target: [5, 4, 3, 2, 2, 3, 4, 5] },
  { name: 'Orak', target: [6, 4, 3, 2, 2, 3, 4, 6] },
  { name: 'Kalkan', target: [2, 4, 6, 7, 7, 6, 4, 2] },
  { name: 'Anahtar', target: [5, 5, 3, 1, 4, 4, 6, 6] },
  { name: 'Çapa', target: [7, 4, 2, 4, 4, 2, 4, 7] },
];

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let heatEl!: HTMLElement;
let timeEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let forgeBtn!: HTMLButtonElement;
let startBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;

let state: State = 'ready';
let cells: number[] = new Array(CELLS).fill(MAX_HEIGHT);
let piece: Piece = PIECES[0]!;
let heat = HEAT_MAX;
let score = 0;
let best = 0;
let lastFrame = 0;
let pieceDeadlineAt = 0;
let forgeStartAt = 0;
let forgeStartHeat = 0;
let rafId = 0;
let hoverCell = -1;
let strikeFlash: { cell: number; until: number; force: number } | null = null;
let sparks: { x: number; y: number; vx: number; vy: number; life: number }[] = [];

function pickPiece(): Piece {
  return PIECES[Math.floor(Math.random() * PIECES.length)]!;
}

function pieceTimeMs(): number {
  return Math.max(PIECE_TIME_MIN_MS, PIECE_TIME_START_MS - score * PIECE_TIME_DROP_MS);
}

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  startBtn.textContent = state === 'gameover' ? 'Tekrar dene' : 'Başla';
  showOverlayEl(overlay);
}

function hideOverlay(): void {
  hideOverlayEl(overlay);
}

function newPiece(): void {
  cells = new Array(CELLS).fill(MAX_HEIGHT);
  piece = pickPiece();
  pieceDeadlineAt = performance.now() + pieceTimeMs();
}

function reset(): void {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
  state = 'ready';
  cells = new Array(CELLS).fill(MAX_HEIGHT);
  piece = pickPiece();
  heat = HEAT_MAX;
  score = 0;
  sparks = [];
  strikeFlash = null;
  scoreEl.textContent = '0';
  bestEl.textContent = String(best);
  heatEl.textContent = String(HEAT_MAX);
  timeEl.textContent = (PIECE_TIME_START_MS / 1000).toFixed(1);
  draw();
  showOverlay('Demirci', `Hedef: ${piece.name}. Hücreye tıkla, sıcak iken 2 birim, ılık iken 1 birim ezer. Soğursa F ile ısıt.`);
}

function start(): void {
  if (state === 'playing' || state === 'forging') return;
  state = 'playing';
  score = 0;
  cells = new Array(CELLS).fill(MAX_HEIGHT);
  piece = pickPiece();
  heat = HEAT_MAX;
  sparks = [];
  strikeFlash = null;
  scoreEl.textContent = '0';
  heatEl.textContent = String(HEAT_MAX);
  pieceDeadlineAt = performance.now() + pieceTimeMs();
  lastFrame = performance.now();
  hideOverlay();
  rafId = requestAnimationFrame(loop);
}

function gameOver(reason: string): void {
  if (state !== 'playing' && state !== 'forging') return;
  state = 'gameover';
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
  if (score > best) {
    best = score;
    bestEl.textContent = String(best);
    safeWrite(STORAGE_BEST, best);
  }
  draw();
  showOverlay('Demir ezildi', `${reason}\nDövdüğün parça: ${score} · Rekor: ${best}`);
}

function spawnSparks(cx: number, cy: number, count: number): void {
  for (let i = 0; i < count; i++) {
    const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.6;
    const speed = 90 + Math.random() * 140;
    sparks.push({
      x: cx,
      y: cy,
      vx: Math.cos(a) * speed,
      vy: Math.sin(a) * speed,
      life: 0.5 + Math.random() * 0.4,
    });
  }
}

function strike(idx: number): void {
  if (state !== 'playing') return;
  if (idx < 0 || idx >= CELLS) return;
  if (heat <= 0) {
    strikeFlash = { cell: idx, until: performance.now() + 220, force: 0 };
    return;
  }
  const force = heat >= HOT_THRESHOLD ? 2 : 1;
  const h = cells[idx]!;
  const t = piece.target[idx]!;
  const newH = h - force;
  if (newH < t) {
    cells[idx] = Math.max(0, newH);
    strikeFlash = { cell: idx, until: performance.now() + 320, force };
    gameOver(`${idx + 1}. hücre fazla ezildi (hedef ${t}, ${force} birim vurdun).`);
    return;
  }
  cells[idx] = newH;
  heat = Math.max(0, heat - HEAT_PER_STRIKE);
  heatEl.textContent = String(Math.round(heat));
  strikeFlash = { cell: idx, until: performance.now() + 220, force };
  const { x, y } = cellAnvilXY(idx, newH);
  spawnSparks(x, y, force === 2 ? 16 : 9);

  let done = true;
  for (let i = 0; i < CELLS; i++) {
    if (cells[i] !== piece.target[i]) {
      done = false;
      break;
    }
  }
  if (done) {
    score++;
    scoreEl.textContent = String(score);
    newPiece();
    heatEl.textContent = String(Math.round(heat));
  }
}

function startForge(): void {
  if (state !== 'playing') return;
  if (heat >= HEAT_MAX) return;
  state = 'forging';
  forgeStartAt = performance.now();
  forgeStartHeat = heat;
}

function loop(now: number): void {
  if (state !== 'playing' && state !== 'forging') return;
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;

  if (state === 'forging') {
    const elapsed = now - forgeStartAt;
    const progress = Math.min(1, elapsed / FORGE_DURATION_MS);
    heat = forgeStartHeat + (HEAT_MAX - forgeStartHeat) * progress;
    if (progress >= 1) {
      heat = HEAT_MAX;
      state = 'playing';
    }
  } else {
    heat = Math.max(0, heat - HEAT_DECAY_PER_SEC * dt);
  }
  heatEl.textContent = String(Math.round(heat));

  const remaining = Math.max(0, pieceDeadlineAt - now);
  timeEl.textContent = (remaining / 1000).toFixed(1);

  for (const s of sparks) {
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    s.vy += 600 * dt;
    s.life -= dt;
  }
  sparks = sparks.filter((s) => s.life > 0);

  if (remaining <= 0 && state === 'playing') {
    gameOver('Demir soğudu — süre doldu.');
    return;
  }

  draw();
  rafId = requestAnimationFrame(loop);
}

const cssCache = new Map<string, string>();
function getCss(varName: string, fallback: string): string {
  const cached = cssCache.get(varName);
  if (cached !== undefined) return cached || fallback;
  const val = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  cssCache.set(varName, val);
  return val || fallback;
}

const CELL_W = 64;
const BAR_GAP = 4;
const TOTAL_W = CELLS * CELL_W + (CELLS - 1) * BAR_GAP;
const UNIT_H = 22;
const ANVIL_TOP_Y = 360;
const TOP_PADDING = 40;

function barLeft(): number {
  return Math.floor((canvas.width - TOTAL_W) / 2);
}

function cellX(idx: number): number {
  return barLeft() + idx * (CELL_W + BAR_GAP);
}

function cellAnvilXY(idx: number, height: number): { x: number; y: number } {
  return {
    x: cellX(idx) + CELL_W / 2,
    y: ANVIL_TOP_Y - height * UNIT_H,
  };
}

function heatColor(): { fill: string; glow: string } {
  const t = Math.max(0, Math.min(1, heat / HEAT_MAX));
  if (t > 0.66) return { fill: '#fff1c2', glow: '#ffb347' };
  if (t > 0.4) return { fill: '#ffb347', glow: '#ff7a1a' };
  if (t > 0.18) return { fill: '#ff5a1f', glow: '#c2310a' };
  return { fill: '#7a3520', glow: '#3a1a10' };
}

function draw(): void {
  const w = canvas.width;
  const h = canvas.height;

  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, getCss('--surface', '#1b1d22'));
  bg.addColorStop(1, '#0b0c10');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  drawForge();

  drawAnvil();

  drawIron();

  drawTargetSilhouette();

  drawSparks();

  if (state === 'forging') {
    ctx.fillStyle = 'rgba(255,150,40,0.10)';
    ctx.fillRect(0, 0, w, h);
    const elapsed = performance.now() - forgeStartAt;
    const p = Math.min(1, elapsed / FORGE_DURATION_MS);
    const barW = 240;
    const barH = 8;
    const bx = (w - barW) / 2;
    const by = 16;
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(bx, by, barW, barH);
    ctx.fillStyle = '#ffb347';
    ctx.fillRect(bx, by, barW * p, barH);
    ctx.fillStyle = '#ffd58a';
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Körük çalışıyor…', w / 2, by + barH + 14);
  }

  ctx.fillStyle = getCss('--text-dim', '#7a8190');
  ctx.font = '600 13px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(`Hedef: ${piece.name}`, 14, 22);

  ctx.textAlign = 'right';
  const force = heat >= HOT_THRESHOLD ? '×2' : heat > 0 ? '×1' : '×0';
  const label = heat >= HOT_THRESHOLD ? 'sıcak' : heat > 0 ? 'ılık' : 'soğuk';
  ctx.fillText(`Vuruş: ${force} (${label})`, w - 14, 22);
}

function drawForge(): void {
  const fx = 30;
  const fy = ANVIL_TOP_Y + 10;
  ctx.fillStyle = '#2b1d18';
  ctx.fillRect(fx, fy - 56, 110, 70);
  ctx.fillStyle = '#3a2620';
  ctx.fillRect(fx - 4, fy + 14, 118, 14);

  const glow = state === 'forging' ? 1 : 0.55 + Math.sin(performance.now() / 220) * 0.1;
  const flameY = fy - 56;
  const g = ctx.createRadialGradient(fx + 55, flameY + 28, 8, fx + 55, flameY + 28, 50);
  g.addColorStop(0, `rgba(255,220,140,${0.85 * glow})`);
  g.addColorStop(0.4, `rgba(255,140,40,${0.6 * glow})`);
  g.addColorStop(1, 'rgba(40,10,5,0)');
  ctx.fillStyle = g;
  ctx.fillRect(fx - 10, flameY - 10, 130, 80);

  ctx.fillStyle = '#ff8533';
  for (let i = 0; i < 4; i++) {
    const fxx = fx + 18 + i * 22 + Math.sin(performance.now() / 180 + i) * 4;
    const fyy = flameY + 30 - Math.abs(Math.sin(performance.now() / 200 + i)) * 22 * glow;
    ctx.beginPath();
    ctx.ellipse(fxx, fyy, 8, 16, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawAnvil(): void {
  const left = barLeft() - 30;
  const right = barLeft() + TOTAL_W + 30;
  const top = ANVIL_TOP_Y;
  ctx.fillStyle = '#2a2d36';
  ctx.fillRect(left, top, right - left, 8);
  ctx.beginPath();
  ctx.moveTo(left + 50, top + 8);
  ctx.lineTo(right - 50, top + 8);
  ctx.lineTo(right - 80, top + 28);
  ctx.lineTo(left + 80, top + 28);
  ctx.closePath();
  ctx.fillStyle = '#1f2128';
  ctx.fill();
  ctx.fillStyle = '#15171c';
  ctx.fillRect(left + 100, top + 28, right - left - 200, 26);
}

function drawTargetSilhouette(): void {
  const baseY = ANVIL_TOP_Y;
  ctx.save();
  for (let i = 0; i < CELLS; i++) {
    const t = piece.target[i]!;
    const x = cellX(i);
    const top = baseY - t * UNIT_H;
    ctx.strokeStyle = 'rgba(190,210,240,0.85)';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(x - 2, top);
    ctx.lineTo(x + CELL_W + 2, top);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(190,210,240,0.85)';
    ctx.beginPath();
    ctx.moveTo(x - 2, top);
    ctx.lineTo(x - 8, top - 4);
    ctx.lineTo(x - 8, top + 4);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function drawIron(): void {
  const baseY = ANVIL_TOP_Y;
  const { fill, glow } = heatColor();
  const now = performance.now();
  for (let i = 0; i < CELLS; i++) {
    const h = cells[i]!;
    const t = piece.target[i]!;
    const x = cellX(i);
    if (h <= 0) continue;
    const cellTop = baseY - h * UNIT_H;

    if (heat > 8) {
      const gg = ctx.createRadialGradient(x + CELL_W / 2, cellTop + 4, 2, x + CELL_W / 2, cellTop + 4, CELL_W);
      const a = Math.min(0.7, heat / HEAT_MAX);
      gg.addColorStop(0, `rgba(255,220,140,${a})`);
      gg.addColorStop(1, 'rgba(255,120,40,0)');
      ctx.fillStyle = gg;
      ctx.fillRect(x - 20, cellTop - 20, CELL_W + 40, (baseY - cellTop) + 30);
    }

    ctx.fillStyle = fill;
    ctx.fillRect(x, cellTop, CELL_W, h * UNIT_H);

    ctx.fillStyle = `rgba(0,0,0,${Math.max(0.15, 1 - heat / HEAT_MAX)})`;
    ctx.fillRect(x, cellTop, CELL_W, 4);

    ctx.strokeStyle = glow;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x + 0.5, cellTop + 0.5, CELL_W - 1, h * UNIT_H - 1);

    if (h === t) {
      ctx.fillStyle = 'rgba(80,200,120,0.20)';
      ctx.fillRect(x, cellTop, CELL_W, h * UNIT_H);
      ctx.strokeStyle = '#5ac88a';
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 1, cellTop + 1, CELL_W - 2, h * UNIT_H - 2);
    }

    if (i === hoverCell && state === 'playing' && heat > 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.fillRect(x, cellTop, CELL_W, h * UNIT_H);
    }

    if (strikeFlash && strikeFlash.cell === i && now < strikeFlash.until) {
      const f = (strikeFlash.until - now) / 220;
      ctx.fillStyle = `rgba(255,255,255,${Math.min(0.7, f)})`;
      ctx.fillRect(x, cellTop, CELL_W, Math.max(8, UNIT_H));
    }

    ctx.fillStyle = '#dfe3ea';
    ctx.font = '700 13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(String(i + 1), x + CELL_W / 2, baseY + 22);
    ctx.fillStyle = h === t ? '#5ac88a' : '#aab1bf';
    ctx.font = '500 11px system-ui, sans-serif';
    ctx.fillText(`${h}/${t}`, x + CELL_W / 2, baseY + 38);
  }
}

function drawSparks(): void {
  for (const s of sparks) {
    const a = Math.max(0, Math.min(1, s.life));
    ctx.fillStyle = `rgba(255,${180 + Math.floor(Math.random() * 60)},80,${a})`;
    ctx.fillRect(s.x, s.y, 2, 2);
  }
}

function cellFromX(px: number, py: number): number {
  const left = barLeft();
  if (py < TOP_PADDING || py > ANVIL_TOP_Y + 8) return -1;
  if (px < left || px > left + TOTAL_W) return -1;
  const rel = px - left;
  const stride = CELL_W + BAR_GAP;
  const idx = Math.floor(rel / stride);
  if (idx < 0 || idx >= CELLS) return -1;
  const within = rel - idx * stride;
  if (within > CELL_W) return -1;
  return idx;
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
  heatEl = document.querySelector<HTMLElement>('#heat')!;
  timeEl = document.querySelector<HTMLElement>('#time')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  forgeBtn = document.querySelector<HTMLButtonElement>('#forge')!;
  startBtn = document.querySelector<HTMLButtonElement>('#start')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  canvas.addEventListener('pointerdown', (e) => {
    if (state === 'ready') {
      start();
      return;
    }
    if (state === 'gameover') {
      reset();
      start();
      return;
    }
    if (state !== 'playing') return;
    const { x, y } = canvasCoords(e);
    const idx = cellFromX(x, y);
    if (idx >= 0) strike(idx);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (state !== 'playing') {
      if (hoverCell !== -1) {
        hoverCell = -1;
      }
      return;
    }
    const { x, y } = canvasCoords(e);
    const idx = cellFromX(x, y);
    if (idx !== hoverCell) {
      hoverCell = idx;
    }
  });

  canvas.addEventListener('pointerleave', () => {
    hoverCell = -1;
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'r' || e.key === 'R') {
      reset();
      e.preventDefault();
      return;
    }
    if (state === 'ready' || state === 'gameover') {
      if (e.key === ' ' || e.key === 'Enter') {
        if (state === 'gameover') reset();
        start();
        e.preventDefault();
      }
      return;
    }
    if (e.key === 'f' || e.key === 'F') {
      startForge();
      e.preventDefault();
      return;
    }
    if (state !== 'playing') return;
    if (e.key >= '1' && e.key <= '8') {
      const idx = parseInt(e.key, 10) - 1;
      strike(idx);
      e.preventDefault();
    }
  });

  startBtn.addEventListener('click', () => {
    if (state === 'gameover') reset();
    start();
  });
  restartBtn.addEventListener('click', () => {
    reset();
  });
  forgeBtn.addEventListener('click', () => {
    startForge();
  });

  reset();
}

export const game = defineGame({ init, reset });
