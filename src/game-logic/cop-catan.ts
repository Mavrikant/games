import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';

const STORAGE_BEST = 'cop-catan.best';
const MAX_STRIKES = 3;
const STICK_WIDTH = 11;
const HIT_PAD = 4;

type State = 'ready' | 'playing' | 'gameover' | 'won';

interface Stick {
  id: number;
  cx: number;
  cy: number;
  angle: number;
  length: number;
  color: string;
  points: number;
  blockers: Set<number>;
  blocking: Set<number>;
  removed: boolean;
  removingAt: number;
}

const STICK_PALETTE: Array<{ color: string; points: number; count: number }> = [
  { color: '#f5f5f5', points: 10, count: 1 },
  { color: '#ef4444', points: 5, count: 2 },
  { color: '#60a5fa', points: 3, count: 4 },
  { color: '#34d399', points: 2, count: 5 },
  { color: '#fbbf24', points: 1, count: 6 },
];

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let strikesEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let startBtn!: HTMLButtonElement;

let state: State = 'ready';
let sticks: Stick[] = [];
let score = 0;
let best = 0;
let strikes = 0;
let hovered: number | null = null;
let shakeStick: number | null = null;
let shakeUntil = 0;
let popups: Array<{ x: number; y: number; text: string; color: string; t0: number }> = [];

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
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

function endpointsOf(s: Stick): { a: { x: number; y: number }; b: { x: number; y: number } } {
  const dx = (Math.cos(s.angle) * s.length) / 2;
  const dy = (Math.sin(s.angle) * s.length) / 2;
  return {
    a: { x: s.cx - dx, y: s.cy - dy },
    b: { x: s.cx + dx, y: s.cy + dy },
  };
}

function segmentsIntersect(
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  p3: { x: number; y: number },
  p4: { x: number; y: number },
): boolean {
  const d1x = p2.x - p1.x;
  const d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x;
  const d2y = p4.y - p3.y;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-9) return false;
  const sx = p3.x - p1.x;
  const sy = p3.y - p1.y;
  const t = (sx * d2y - sy * d2x) / denom;
  const u = (sx * d1y - sy * d1x) / denom;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

function segDistSq(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const apx = p.x - a.x;
  const apy = p.y - a.y;
  const len2 = abx * abx + aby * aby;
  let t = len2 === 0 ? 0 : (apx * abx + apy * aby) / len2;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const projx = a.x + abx * t;
  const projy = a.y + aby * t;
  const dx = p.x - projx;
  const dy = p.y - projy;
  return dx * dx + dy * dy;
}

function sticksTouch(s1: Stick, s2: Stick): boolean {
  const e1 = endpointsOf(s1);
  const e2 = endpointsOf(s2);
  if (segmentsIntersect(e1.a, e1.b, e2.a, e2.b)) return true;
  const reach = (STICK_WIDTH + HIT_PAD) * (STICK_WIDTH + HIT_PAD);
  if (segDistSq(e1.a, e2.a, e2.b) < reach) return true;
  if (segDistSq(e1.b, e2.a, e2.b) < reach) return true;
  if (segDistSq(e2.a, e1.a, e1.b) < reach) return true;
  if (segDistSq(e2.b, e1.a, e1.b) < reach) return true;
  return false;
}

function buildPile(): void {
  sticks = [];
  const orderedSpecs: Array<{ color: string; points: number }> = [];
  for (const p of STICK_PALETTE) {
    for (let i = 0; i < p.count; i++) {
      orderedSpecs.push({ color: p.color, points: p.points });
    }
  }
  shuffle(orderedSpecs);

  const W = canvas.width;
  const H = canvas.height;
  const margin = 70;
  const centerX = W / 2;
  const centerY = H / 2;

  let id = 0;
  for (const spec of orderedSpecs) {
    const length = rand(280, 320);
    const offsetR = rand(0, 90);
    const offsetA = rand(0, Math.PI * 2);
    const cx = centerX + Math.cos(offsetA) * offsetR;
    const cy = centerY + Math.sin(offsetA) * offsetR;
    const angle = rand(0, Math.PI);

    const halfDX = (Math.cos(angle) * length) / 2;
    const halfDY = (Math.sin(angle) * length) / 2;
    const minX = Math.min(cx - halfDX, cx + halfDX);
    const maxX = Math.max(cx - halfDX, cx + halfDX);
    const minY = Math.min(cy - halfDY, cy + halfDY);
    const maxY = Math.max(cy - halfDY, cy + halfDY);
    if (minX < margin / 2 || maxX > W - margin / 2 || minY < margin / 2 || maxY > H - margin / 2) {
      continue;
    }

    sticks.push({
      id: id++,
      cx,
      cy,
      angle,
      length,
      color: spec.color,
      points: spec.points,
      blockers: new Set<number>(),
      blocking: new Set<number>(),
      removed: false,
      removingAt: 0,
    });
  }

  if (sticks.length < 14) {
    buildPile();
    return;
  }

  for (let i = 0; i < sticks.length; i++) {
    for (let j = i + 1; j < sticks.length; j++) {
      if (sticksTouch(sticks[i]!, sticks[j]!)) {
        sticks[i]!.blockers.add(sticks[j]!.id);
        sticks[j]!.blocking.add(sticks[i]!.id);
      }
    }
  }
}

function isFree(s: Stick): boolean {
  return s.blockers.size === 0 && !s.removed;
}

function updateHud(): void {
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
  strikesEl.textContent = `${strikes}/${MAX_STRIKES}`;
}

function commitBest(): void {
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
}

function showInfo(title: string, msg: string, btnLabel: string | null): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  if (btnLabel === null) {
    startBtn.hidden = true;
  } else {
    startBtn.hidden = false;
    startBtn.textContent = btnLabel;
  }
  showOverlayEl(overlay);
}

function hideInfo(): void {
  hideOverlayEl(overlay);
}

function reset(): void {
  state = 'ready';
  score = 0;
  strikes = 0;
  hovered = null;
  shakeStick = null;
  shakeUntil = 0;
  popups = [];
  buildPile();
  updateHud();
  showInfo(
    'Çöp Çatan',
    'Yalnız üstteki çubuğu çek. 3 hatada tur biter.',
    'Başla',
  );
  draw();
}

function startRound(): void {
  state = 'playing';
  hideInfo();
  draw();
}

function clickAtCanvas(cx: number, cy: number): void {
  if (state !== 'playing') return;
  const hit = pickTopAt(cx, cy);
  if (hit === null) return;
  const s = sticks[hit]!;
  if (isFree(s)) {
    removeStick(hit);
  } else {
    wrongPick(hit);
  }
}

function pickTopAt(x: number, y: number): number | null {
  let bestIdx: number | null = null;
  let bestPriority = -1;
  for (let i = 0; i < sticks.length; i++) {
    const s = sticks[i]!;
    if (s.removed) continue;
    const { a, b } = endpointsOf(s);
    const d2 = segDistSq({ x, y }, a, b);
    const r = STICK_WIDTH / 2 + HIT_PAD;
    if (d2 <= r * r) {
      const priority = s.blockers.size === 0 ? i + 10000 : i;
      if (priority > bestPriority) {
        bestPriority = priority;
        bestIdx = i;
      }
    }
  }
  return bestIdx;
}

function removeStick(idx: number): void {
  const s = sticks[idx]!;
  s.removed = true;
  s.removingAt = performance.now();
  score += s.points;
  popups.push({
    x: s.cx,
    y: s.cy,
    text: `+${s.points}`,
    color: s.color,
    t0: performance.now(),
  });
  for (const otherId of s.blocking) {
    const idx2 = sticks.findIndex((st) => st.id === otherId);
    if (idx2 < 0) continue;
    sticks[idx2]!.blockers.delete(s.id);
  }
  commitBest();
  updateHud();
  if (sticks.every((st) => st.removed)) {
    state = 'won';
    showInfo(
      'Yığını çözdün!',
      `Tüm çubukları topladın. Skor: ${score}. R ile yeni tur.`,
      'Yeni tur',
    );
  }
}

function wrongPick(idx: number): void {
  strikes += 1;
  shakeStick = idx;
  shakeUntil = performance.now() + 380;
  updateHud();
  if (strikes >= MAX_STRIKES) {
    state = 'gameover';
    commitBest();
    showInfo(
      'Yığın çöktü',
      `Skor: ${score}. R ile yeniden başla.`,
      'Yeni tur',
    );
  }
}

function draw(): void {
  ctx.fillStyle = getCss('--surface', '#0f1217');
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.018)';
  for (let y = 24; y < canvas.height; y += 48) {
    for (let x = 24; x < canvas.width; x += 48) {
      ctx.beginPath();
      ctx.arc(x, y, 1.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();

  const now = performance.now();
  for (let i = 0; i < sticks.length; i++) {
    const s = sticks[i]!;
    if (s.removed) {
      const t = (now - s.removingAt) / 280;
      if (t >= 1) continue;
      drawStick(s, 1 - t, false, i === hovered, false);
    } else {
      const isShaking = shakeStick === i && now < shakeUntil;
      drawStick(s, 1, isShaking, i === hovered, isFree(s));
    }
  }

  for (let k = popups.length - 1; k >= 0; k--) {
    const p = popups[k]!;
    const t = (now - p.t0) / 700;
    if (t >= 1) {
      popups.splice(k, 1);
      continue;
    }
    ctx.save();
    ctx.globalAlpha = 1 - t;
    ctx.fillStyle = p.color;
    ctx.font = 'bold 18px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(p.text, p.x, p.y - 28 * t);
    ctx.restore();
  }
}

function drawStick(
  s: Stick,
  alpha: number,
  shaking: boolean,
  isHover: boolean,
  isFreeNow: boolean,
): void {
  const { a, b } = endpointsOf(s);
  const ax = a.x;
  const ay = a.y;
  const bx = b.x;
  const by = b.y;

  let shakeX = 0;
  let shakeY = 0;
  if (shaking) {
    const phase = (performance.now() / 18) % (Math.PI * 2);
    shakeX = Math.sin(phase) * 3.2;
    shakeY = Math.cos(phase * 1.4) * 1.8;
  }

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(shakeX, shakeY);
  ctx.lineCap = 'round';
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = 5;
  ctx.shadowOffsetX = 1.5;
  ctx.shadowOffsetY = 2.5;
  ctx.strokeStyle = s.color;
  ctx.lineWidth = STICK_WIDTH;
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(bx, by);
  ctx.stroke();
  ctx.shadowColor = 'transparent';

  ctx.lineWidth = STICK_WIDTH - 5;
  ctx.strokeStyle = lighten(s.color, 0.45);
  ctx.beginPath();
  const t1 = 0.18;
  const t2 = 0.36;
  ctx.moveTo(ax + (bx - ax) * t1, ay + (by - ay) * t1);
  ctx.lineTo(ax + (bx - ax) * t2, ay + (by - ay) * t2);
  ctx.stroke();

  if (isHover && state === 'playing') {
    ctx.lineWidth = STICK_WIDTH + 4;
    ctx.strokeStyle = isFreeNow ? 'rgba(110,231,183,0.45)' : 'rgba(248,113,113,0.45)';
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
  }
  ctx.restore();
}

function lighten(hex: string, amount: number): string {
  const m = hex.match(/^#([0-9a-f]{6})$/i);
  if (!m) return hex;
  const num = parseInt(m[1]!, 16);
  let r = (num >> 16) & 0xff;
  let g = (num >> 8) & 0xff;
  let b = num & 0xff;
  r = Math.round(r + (255 - r) * amount);
  g = Math.round(g + (255 - g) * amount);
  b = Math.round(b + (255 - b) * amount);
  return `rgb(${r},${g},${b})`;
}

const cssCache = new Map<string, string>();
function getCss(varName: string, fallback: string): string {
  const cached = cssCache.get(varName);
  if (cached !== undefined) return cached;
  const val = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  const out = val || fallback;
  cssCache.set(varName, out);
  return out;
}

function loop(): void {
  draw();
  requestAnimationFrame(loop);
}

function getCanvasPoint(e: PointerEvent | MouseEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * canvas.width;
  const y = ((e.clientY - rect.top) / rect.height) * canvas.height;
  return { x, y };
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  strikesEl = document.querySelector<HTMLElement>('#strikes')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  startBtn = document.querySelector<HTMLButtonElement>('#start')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  canvas.addEventListener('pointerdown', (e) => {
    const p = getCanvasPoint(e);
    clickAtCanvas(p.x, p.y);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (state !== 'playing') {
      if (hovered !== null) hovered = null;
      return;
    }
    const p = getCanvasPoint(e);
    hovered = pickTopAt(p.x, p.y);
  });

  canvas.addEventListener('pointerleave', () => {
    hovered = null;
  });

  startBtn.addEventListener('click', () => {
    if (state === 'ready') {
      startRound();
    } else if (state === 'gameover' || state === 'won') {
      reset();
      startRound();
    }
  });

  overlay.addEventListener('pointerdown', (e) => {
    if (e.target === startBtn) return;
    if (state === 'ready') {
      startRound();
      e.preventDefault();
    } else if (state === 'gameover' || state === 'won') {
      reset();
      startRound();
      e.preventDefault();
    }
  });

  restartBtn.addEventListener('click', () => {
    reset();
    startRound();
  });

  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'r') {
      reset();
      startRound();
      e.preventDefault();
    } else if ((k === ' ' || k === 'enter') && (state === 'ready' || state === 'gameover' || state === 'won')) {
      if (state === 'ready') startRound();
      else {
        reset();
        startRound();
      }
      e.preventDefault();
    }
  });

  reset();
  loop();
}

export const game = defineGame({ init, reset });
