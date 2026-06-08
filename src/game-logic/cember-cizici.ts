import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';

const STORAGE_BEST = 'cember-cizici.best';

type State = 'ready' | 'drawing' | 'scored';
type Pt = { x: number; y: number };

let state: State = 'ready';
let score = -1;
let best = 0;
let points: Pt[] = [];

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;

let fit: { cx: number; cy: number; r: number } | null = null;

const cssCache = new Map<string, string>();
function css(varName: string): string {
  const cached = cssCache.get(varName);
  if (cached !== undefined) return cached;
  const val = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  cssCache.set(varName, val);
  return val;
}

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlay);
}

function hideOverlay(): void {
  hideOverlayEl(overlay);
}

function setScoreDisplay(): void {
  scoreEl.textContent = score < 0 ? '—' : `%${score}`;
  bestEl.textContent = best > 0 ? `%${best}` : '0';
}

function reset(): void {
  state = 'ready';
  score = -1;
  points = [];
  fit = null;
  setScoreDisplay();
  draw();
  showOverlay('Çember Çizici', 'Basılı tut, tek hareketle bir tam daire çiz, bırak.\nAlgoritma yuvarlaklığını ölçer.');
}

// ---------- Geometry ----------

// Least-squares circle fit via the linear form x^2+y^2 + Dx + Ey + F = 0.
function fitCircle(pts: Pt[]): { cx: number; cy: number; r: number } | null {
  const n = pts.length;
  if (n < 8) return null;

  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  let sxxx = 0, syyy = 0, sxyy = 0, sxxy = 0;
  for (const p of pts) {
    const x = p.x, y = p.y;
    sx += x; sy += y;
    sxx += x * x; syy += y * y; sxy += x * y;
    sxxx += x * x * x; syyy += y * y * y;
    sxyy += x * y * y; sxxy += x * x * y;
  }

  const a: number[][] = [
    [sxx, sxy, sx],
    [sxy, syy, sy],
    [sx, sy, n],
  ];
  const b: number[] = [
    -(sxxx + sxyy),
    -(syyy + sxxy),
    -(sxx + syy),
  ];

  const sol = solve3(a, b);
  if (!sol) return null;
  const [D, E, F] = sol;
  const cx = -D / 2;
  const cy = -E / 2;
  const r2 = cx * cx + cy * cy - F;
  if (r2 <= 0) return null;
  return { cx, cy, r: Math.sqrt(r2) };
}

function solve3(a: number[][], b: number[]): [number, number, number] | null {
  const m: number[][] = [
    [a[0]![0]!, a[0]![1]!, a[0]![2]!, b[0]!],
    [a[1]![0]!, a[1]![1]!, a[1]![2]!, b[1]!],
    [a[2]![0]!, a[2]![1]!, a[2]![2]!, b[2]!],
  ];
  for (let i = 0; i < 3; i++) {
    let piv = i;
    for (let k = i + 1; k < 3; k++) {
      if (Math.abs(m[k]![i]!) > Math.abs(m[piv]![i]!)) piv = k;
    }
    if (Math.abs(m[piv]![i]!) < 1e-9) return null;
    if (piv !== i) {
      const tmp = m[i]!;
      m[i] = m[piv]!;
      m[piv] = tmp;
    }
    const pivVal = m[i]![i]!;
    for (let j = i; j < 4; j++) m[i]![j] = m[i]![j]! / pivVal;
    for (let k = 0; k < 3; k++) {
      if (k === i) continue;
      const f = m[k]![i]!;
      for (let j = i; j < 4; j++) m[k]![j] = m[k]![j]! - f * m[i]![j]!;
    }
  }
  return [m[0]![3]!, m[1]![3]!, m[2]![3]!];
}

function scoreRoundness(pts: Pt[]): { score: number; fit: { cx: number; cy: number; r: number } | null } {
  if (pts.length < 12) return { score: 0, fit: null };

  const f = fitCircle(pts);
  if (!f) return { score: 0, fit: null };

  // Radial deviation: RMS of (|p - c| - r) / r.
  let sumSq = 0;
  for (const p of pts) {
    const d = Math.hypot(p.x - f.cx, p.y - f.cy) - f.r;
    sumSq += d * d;
  }
  const rms = Math.sqrt(sumSq / pts.length) / f.r;
  const radial = Math.max(0, 1 - rms / 0.15);

  // Angular sweep: total signed rotation; should reach 2π.
  const angles = pts.map((p) => Math.atan2(p.y - f.cy, p.x - f.cx));
  let totalRot = 0;
  for (let i = 1; i < angles.length; i++) {
    let d = angles[i]! - angles[i - 1]!;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    totalRot += d;
  }
  const sweep = Math.min(1, Math.abs(totalRot) / (2 * Math.PI));

  // Closure: gap between first and last point, relative to radius.
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  const closeGap = Math.hypot(first.x - last.x, first.y - last.y) / f.r;
  const closure = Math.max(0, 1 - closeGap / 0.5);

  // Tiny "circles" shouldn't dominate the leaderboard.
  const minRadius = Math.min(canvas.width, canvas.height) * 0.08;
  const sizePenalty = f.r < minRadius ? f.r / minRadius : 1;

  const raw = radial * 0.7 + sweep * 0.2 + closure * 0.1;
  const final = Math.round(raw * sizePenalty * 100);
  return { score: Math.max(0, Math.min(100, final)), fit: f };
}

// ---------- Rendering ----------

function draw(): void {
  const w = canvas.width;
  const h = canvas.height;

  ctx.fillStyle = css('--surface') || '#13151a';
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = css('--border') || '#2a2d36';
  ctx.lineWidth = 1;
  const step = w / 8;
  for (let i = 1; i < 8; i++) {
    ctx.beginPath();
    ctx.moveTo(i * step, 0);
    ctx.lineTo(i * step, h);
    ctx.moveTo(0, i * step);
    ctx.lineTo(w, i * step);
    ctx.stroke();
  }

  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  ctx.beginPath();
  ctx.moveTo(w / 2 - 8, h / 2);
  ctx.lineTo(w / 2 + 8, h / 2);
  ctx.moveTo(w / 2, h / 2 - 8);
  ctx.lineTo(w / 2, h / 2 + 8);
  ctx.stroke();

  if (fit && state === 'scored') {
    ctx.strokeStyle = scoreColor(score);
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.arc(fit.cx, fit.cy, fit.r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (points.length >= 2) {
    ctx.strokeStyle = state === 'scored' ? (css('--text') || '#e5e7eb') : (css('--accent') || '#7c93ff');
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(points[0]!.x, points[0]!.y);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i]!.x, points[i]!.y);
    }
    ctx.stroke();
  }

  if (state === 'scored' && score >= 0) {
    ctx.fillStyle = scoreColor(score);
    ctx.font = 'bold 72px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`%${score}`, w / 2, h / 2);
    ctx.font = '500 14px system-ui, -apple-system, sans-serif';
    ctx.fillStyle = css('--text-dim') || '#8b8e98';
    ctx.fillText(verdict(score), w / 2, h / 2 + 50);
  }
}

function scoreColor(s: number): string {
  if (s >= 90) return '#34d399';
  if (s >= 75) return '#a3e635';
  if (s >= 55) return '#fbbf24';
  if (s >= 30) return '#fb923c';
  return '#f87171';
}

function verdict(s: number): string {
  if (s >= 95) return 'Tanrı sınıfı!';
  if (s >= 85) return 'Olağanüstü';
  if (s >= 70) return 'İyi iş';
  if (s >= 50) return 'Fena değil';
  if (s >= 25) return 'Yumurta';
  return 'Patates';
}

// ---------- Input ----------

function toCanvasPt(e: PointerEvent): Pt {
  const rect = canvas.getBoundingClientRect();
  const sx = canvas.width / rect.width;
  const sy = canvas.height / rect.height;
  return {
    x: (e.clientX - rect.left) * sx,
    y: (e.clientY - rect.top) * sy,
  };
}

function onDown(e: PointerEvent): void {
  if (state === 'drawing') return;
  e.preventDefault();
  canvas.setPointerCapture(e.pointerId);
  state = 'drawing';
  points = [toCanvasPt(e)];
  fit = null;
  score = -1;
  setScoreDisplay();
  hideOverlay();
  draw();
}

function onMove(e: PointerEvent): void {
  if (state !== 'drawing') return;
  e.preventDefault();
  const p = toCanvasPt(e);
  const last = points[points.length - 1]!;
  if (Math.hypot(p.x - last.x, p.y - last.y) >= 2) {
    points.push(p);
    draw();
  }
}

function onUp(e: PointerEvent): void {
  if (state !== 'drawing') return;
  e.preventDefault();
  if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  const result = scoreRoundness(points);
  score = result.score;
  fit = result.fit;
  state = 'scored';

  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
  setScoreDisplay();
  draw();
}

function onCancel(e: PointerEvent): void {
  if (state !== 'drawing') return;
  if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  state = 'ready';
  points = [];
  draw();
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

  best = safeRead<number>(STORAGE_BEST, 0);

  restartBtn.addEventListener('click', reset);
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onCancel);

  reset();
}

export const game = defineGame({ init, reset });
