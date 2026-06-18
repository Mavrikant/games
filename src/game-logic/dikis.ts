import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay, hideOverlay } from '@shared/overlay';

const STORAGE_BEST = 'dikis.best';
const W = 480;
const H = 520;
const MAX_MISSES = 4;
const FIRST_PIERCE_DELAY = 700;

type State = 'ready' | 'playing' | 'gameover' | 'won';
type Quality = 'perfect' | 'good' | 'ok' | 'miss';

interface Pt {
  x: number;
  y: number;
}
interface LevelDef {
  kind: 'line' | 'wave' | 'zigzag' | 'spiral' | 'heart';
  label: string;
  pierceMs: number;
  hitRadius: number;
  segments: number;
}

const LEVELS: ReadonlyArray<LevelDef> = [
  { kind: 'line', label: 'Düz', pierceMs: 520, hitRadius: 34, segments: 16 },
  { kind: 'wave', label: 'Dalga', pierceMs: 470, hitRadius: 30, segments: 20 },
  { kind: 'zigzag', label: 'Zikzak', pierceMs: 430, hitRadius: 28, segments: 22 },
  { kind: 'spiral', label: 'Spiral', pierceMs: 400, hitRadius: 26, segments: 26 },
  { kind: 'heart', label: 'Kalp', pierceMs: 370, hitRadius: 24, segments: 28 },
];

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let levelEl!: HTMLElement;
let missesEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlayEl!: HTMLElement;
let overlayTitleEl!: HTMLElement;
let overlayMsgEl!: HTMLElement;
let startBtn!: HTMLButtonElement;

let state: State = 'ready';
let level = 0;
let score = 0;
let best = 0;
let misses = 0;
let path: Pt[] = [];
let waypointIdx = 0;
let stitches: Array<{ x: number; y: number; q: Quality }> = [];
let mouseX = W / 2;
let mouseY = H / 2;
let nextPierceTime = 0;
let lastTime = 0;
let pierceFlash = 0;
let rafId = 0;

function buildPath(kind: LevelDef['kind'], segs: number): Pt[] {
  const pts: Pt[] = [];
  const cx = W / 2;
  const cy = H / 2;
  const padY = 70;
  switch (kind) {
    case 'line': {
      const xJitter = (Math.random() - 0.5) * 80;
      for (let i = 0; i < segs; i++) {
        const t = i / (segs - 1);
        pts.push({ x: cx + xJitter, y: padY + t * (H - 2 * padY) });
      }
      break;
    }
    case 'wave': {
      const amp = 90;
      const phase = Math.random() * Math.PI * 2;
      for (let i = 0; i < segs; i++) {
        const t = i / (segs - 1);
        pts.push({
          x: cx + amp * Math.sin(t * Math.PI * 3 + phase),
          y: padY + t * (H - 2 * padY),
        });
      }
      break;
    }
    case 'zigzag': {
      const amp = 120;
      for (let i = 0; i < segs; i++) {
        const t = i / (segs - 1);
        const phase = t * 4;
        const tri = 2 * Math.abs(phase - Math.floor(phase + 0.5));
        pts.push({
          x: cx - amp + amp * 2 * tri,
          y: padY + t * (H - 2 * padY),
        });
      }
      break;
    }
    case 'spiral': {
      for (let i = 0; i < segs; i++) {
        const t = i / (segs - 1);
        const r = 30 + t * 140;
        const a = t * Math.PI * 4.5 + Math.random() * Math.PI;
        pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
      }
      break;
    }
    case 'heart': {
      const scale = 9;
      for (let i = 0; i < segs; i++) {
        const t = (i / (segs - 1)) * 2 * Math.PI - Math.PI / 2;
        const hx = 16 * Math.pow(Math.sin(t), 3);
        const hy = -(
          13 * Math.cos(t) -
          5 * Math.cos(2 * t) -
          2 * Math.cos(3 * t) -
          Math.cos(4 * t)
        );
        pts.push({ x: cx + hx * scale, y: cy + hy * scale });
      }
      break;
    }
  }
  return pts;
}

function commitBest(): void {
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
}

function renderHud(): void {
  scoreEl.textContent = String(score);
  levelEl.textContent = `${Math.min(level + 1, LEVELS.length)}/${LEVELS.length}`;
  missesEl.textContent = `${misses}/${MAX_MISSES}`;
  bestEl.textContent = String(best);
}

function showReady(): void {
  overlayTitleEl.textContent = 'Dikiş';
  overlayMsgEl.textContent =
    'İğne sabit ritimde aşağı iner. İmleci sırayla bir sonraki vurgulanmış noktaya getir — 4 ıska oyunu bitirir.';
  startBtn.textContent = 'Başla';
  showOverlay(overlayEl);
}

function showLevelDone(): void {
  const def = LEVELS[level]!;
  overlayTitleEl.textContent = `Bölüm ${level + 1}/${LEVELS.length}: ${def.label} ✓`;
  overlayMsgEl.textContent =
    level + 1 < LEVELS.length
      ? `Sıradaki bölüm: ${LEVELS[level + 1]!.label}. İğne biraz daha hızlanır.`
      : 'Son bölüm.';
  startBtn.textContent = 'Devam et';
  showOverlay(overlayEl);
}

function showGameOver(): void {
  overlayTitleEl.textContent = 'Iska doldu';
  overlayMsgEl.textContent = `${MAX_MISSES} ıska — dikiş söküldü. Skor: ${score}${score > 0 && score === best ? ' (yeni rekor!)' : ''}`;
  startBtn.textContent = 'Tekrar dene';
  showOverlay(overlayEl);
}

function showWon(): void {
  overlayTitleEl.textContent = 'Tüm desen tamam';
  overlayMsgEl.textContent = `Beş bölümü de bitirdin. Skor: ${score}${score > 0 && score === best ? ' (yeni rekor!)' : ''}`;
  startBtn.textContent = 'Yeniden başla';
  showOverlay(overlayEl);
}

function startLevel(): void {
  const def = LEVELS[level]!;
  path = buildPath(def.kind, def.segments);
  waypointIdx = 0;
  stitches = [];
}

function reset(): void {
  state = 'ready';
  level = 0;
  score = 0;
  misses = 0;
  startLevel();
  renderHud();
  showReady();
  draw();
}

function startPlay(): void {
  if (state === 'gameover' || state === 'won') {
    reset();
  }
  state = 'playing';
  hideOverlay(overlayEl);
  const now = performance.now();
  lastTime = now;
  nextPierceTime = now + FIRST_PIERCE_DELAY;
  pierceFlash = 0;
  if (!rafId) {
    rafId = requestAnimationFrame(loop);
  }
}

function pierce(): void {
  const def = LEVELS[level]!;
  const target = path[waypointIdx];
  if (!target) return;
  const d = Math.hypot(mouseX - target.x, mouseY - target.y);
  let q: Quality;
  let pts = 0;
  if (d < def.hitRadius * 0.33) {
    q = 'perfect';
    pts = 15;
  } else if (d < def.hitRadius * 0.66) {
    q = 'good';
    pts = 8;
  } else if (d < def.hitRadius) {
    q = 'ok';
    pts = 3;
  } else {
    q = 'miss';
    pts = 0;
  }

  stitches.push({ x: mouseX, y: mouseY, q });
  pierceFlash = 140;

  if (q === 'miss') {
    misses++;
    renderHud();
    if (misses >= MAX_MISSES) {
      state = 'gameover';
      commitBest();
      renderHud();
      showGameOver();
    }
    return;
  }

  score += pts;
  waypointIdx++;
  renderHud();

  if (waypointIdx >= path.length) {
    score += 50;
    renderHud();
    if (level + 1 >= LEVELS.length) {
      state = 'won';
      commitBest();
      renderHud();
      showWon();
    } else {
      level++;
      startLevel();
      renderHud();
      state = 'ready';
      showLevelDone();
    }
  }
}

function drawFabric(): void {
  ctx.fillStyle = '#1c2533';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= W; x += 16) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
  }
  for (let y = 0; y <= H; y += 16) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }
}

function drawPath(): void {
  if (path.length < 2) return;
  ctx.strokeStyle = 'rgba(180, 200, 240, 0.45)';
  ctx.lineWidth = 2;
  ctx.setLineDash([7, 5]);
  ctx.beginPath();
  ctx.moveTo(path[0]!.x, path[0]!.y);
  for (let i = 1; i < path.length; i++) {
    ctx.lineTo(path[i]!.x, path[i]!.y);
  }
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawWaypoints(now: number): void {
  const def = LEVELS[level]!;
  for (let i = 0; i < path.length; i++) {
    const p = path[i]!;
    if (i < waypointIdx) {
      ctx.fillStyle = 'rgba(132, 220, 175, 0.55)';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.fill();
    } else if (i === waypointIdx) {
      const pulse = 0.7 + 0.3 * Math.sin(now / 180);
      ctx.strokeStyle = `rgba(140, 240, 200, ${pulse})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, def.hitRadius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = '#8cf0c8';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 5.5, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillStyle = 'rgba(200, 220, 255, 0.32)';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

const STITCH_COLOR: Record<Quality, string> = {
  perfect: '#4ee59a',
  good: '#cae54e',
  ok: '#e5a44e',
  miss: '#e54e6c',
};

function drawStitches(): void {
  if (stitches.length === 0) return;
  ctx.strokeStyle = 'rgba(230, 235, 245, 0.5)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < stitches.length; i++) {
    const s = stitches[i]!;
    if (i === 0) ctx.moveTo(s.x, s.y);
    else ctx.lineTo(s.x, s.y);
  }
  ctx.stroke();

  for (const s of stitches) {
    ctx.fillStyle = STITCH_COLOR[s.q];
    ctx.beginPath();
    ctx.arc(s.x, s.y, 3.4, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawCursor(now: number): void {
  if (state !== 'playing') return;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(mouseX - 11, mouseY);
  ctx.lineTo(mouseX + 11, mouseY);
  ctx.moveTo(mouseX, mouseY - 11);
  ctx.lineTo(mouseX, mouseY + 11);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.arc(mouseX, mouseY, 5, 0, Math.PI * 2);
  ctx.stroke();
  if (pierceFlash > 0) {
    const alpha = pierceFlash / 140;
    ctx.strokeStyle = `rgba(255, 255, 255, ${alpha})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(mouseX, mouseY, 16, 0, Math.PI * 2);
    ctx.stroke();
  }
  void now;
}

function drawPierceBar(now: number): void {
  if (state !== 'playing') return;
  const def = LEVELS[level]!;
  const remaining = Math.max(0, Math.min(1, (nextPierceTime - now) / def.pierceMs));
  const barX = 16;
  const barY = H - 22;
  const barW = W - 32;
  const barH = 10;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
  ctx.fillRect(barX, barY, barW, barH);
  const progress = 1 - remaining;
  ctx.fillStyle = progress > 0.85 ? '#e5a44e' : '#8cf0c8';
  ctx.fillRect(barX, barY, barW * progress, barH);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
  ctx.lineWidth = 1;
  ctx.strokeRect(barX + 0.5, barY + 0.5, barW - 1, barH - 1);
}

function drawLevelLabel(): void {
  const def = LEVELS[level] ?? LEVELS[LEVELS.length - 1]!;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
  ctx.font = '600 12px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(`Desen: ${def.label}`, 16, 22);
  ctx.textAlign = 'right';
  ctx.fillText(`İğne: ${def.pierceMs} ms`, W - 16, 22);
  ctx.textAlign = 'left';
}

function draw(): void {
  const now = performance.now();
  drawFabric();
  drawPath();
  drawStitches();
  drawWaypoints(now);
  drawCursor(now);
  drawPierceBar(now);
  drawLevelLabel();
}

function loop(t: number): void {
  rafId = 0;
  pierceFlash = Math.max(0, pierceFlash - (t - lastTime));
  lastTime = t;

  if (state !== 'playing') {
    draw();
    return;
  }

  if (t >= nextPierceTime) {
    pierce();
    if (state === 'playing') {
      nextPierceTime = t + LEVELS[level]!.pierceMs;
    }
  }

  draw();
  rafId = requestAnimationFrame(loop);
}

function handleStartInput(): void {
  if (state === 'playing') return;
  startPlay();
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  levelEl = document.querySelector<HTMLElement>('#level')!;
  missesEl = document.querySelector<HTMLElement>('#misses')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlayEl = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitleEl = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsgEl = document.querySelector<HTMLElement>('#overlay-msg')!;
  startBtn = document.querySelector<HTMLButtonElement>('#start-btn')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  canvas.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    mouseX = ((e.clientX - r.left) * W) / r.width;
    mouseY = ((e.clientY - r.top) * H) / r.height;
  });
  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    mouseX = ((e.clientX - r.left) * W) / r.width;
    mouseY = ((e.clientY - r.top) * H) / r.height;
    if (state !== 'playing') handleStartInput();
  });
  startBtn.addEventListener('click', (e) => {
    e.preventDefault();
    handleStartInput();
  });
  restartBtn.addEventListener('click', reset);
  window.addEventListener('keydown', (e) => {
    const key = e.key;
    if (key === ' ' || key === 'Enter') {
      if (state !== 'playing') {
        e.preventDefault();
        handleStartInput();
      }
      return;
    }
    if (key.toLowerCase() === 'r') {
      e.preventDefault();
      reset();
    }
  });

  reset();
}

export const game = defineGame({ init, reset });
