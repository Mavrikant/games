import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';

const STORAGE_BEST = 'tam-pay.best';
const TOTAL_ROUNDS = 10;
const MAX_ERROR = 0.10;
const MIN_DRAG_PX = 14;
const W = 480;
const H = 480;
const CX = W / 2;
const CY = H / 2;

type Pt = { x: number; y: number };
type Phase = 'intro' | 'aiming' | 'drawing' | 'scored' | 'finished';

interface RoundDef {
  poly: () => Pt[];
  target: number;
  label: string;
}

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let roundEl!: HTMLElement;
let targetEl!: HTMLElement;
let totalEl!: HTMLElement;
let bestEl!: HTMLElement;
let nextBtn!: HTMLButtonElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayBtn!: HTMLButtonElement;

let phase: Phase = 'intro';
let roundIndex = 0;
let totalScore = 0;
let bestScore = 0;

let polygon: Pt[] = [];
let target = 0.5;
let targetLabel = '1:1';
let line: { p1: Pt; p2: Pt } | null = null;
let split: { a: Pt[]; b: Pt[] } | null = null;
let roundScore = 0;
let lastError = 0;

const cssCache = new Map<string, string>();
function css(name: string, fallback: string): string {
  const cached = cssCache.get(name);
  if (cached !== undefined) return cached || fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  cssCache.set(name, v);
  return v || fallback;
}

// ---------- Geometry ----------

function polyArea(p: Pt[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const cur = p[i]!;
    const nxt = p[(i + 1) % p.length]!;
    a += cur.x * nxt.y - nxt.x * cur.y;
  }
  return Math.abs(a) / 2;
}

function polyMean(p: Pt[]): Pt {
  let cx = 0;
  let cy = 0;
  for (const q of p) {
    cx += q.x;
    cy += q.y;
  }
  return { x: cx / p.length, y: cy / p.length };
}

function sideOf(p: Pt, l1: Pt, l2: Pt): number {
  return (p.x - l1.x) * (l2.y - l1.y) - (p.y - l1.y) * (l2.x - l1.x);
}

// Intersection between the infinite line through (l1,l2) and the segment (e1,e2).
function lineEdgeIntersect(l1: Pt, l2: Pt, e1: Pt, e2: Pt): Pt | null {
  const dxL = l2.x - l1.x;
  const dyL = l2.y - l1.y;
  const dxE = e2.x - e1.x;
  const dyE = e2.y - e1.y;
  const denom = dxE * dyL - dyE * dxL;
  if (Math.abs(denom) < 1e-9) return null;
  const num = (l1.x - e1.x) * dyL - (l1.y - e1.y) * dxL;
  const t = num / denom;
  if (t < -1e-6 || t > 1 + 1e-6) return null;
  return { x: e1.x + t * dxE, y: e1.y + t * dyE };
}

function splitConvex(poly: Pt[], l1: Pt, l2: Pt): { a: Pt[]; b: Pt[] } | null {
  const n = poly.length;
  if (n < 3) return null;
  const sides = poly.map((p) => sideOf(p, l1, l2));
  const crossings: { edge: number; pt: Pt }[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const sI = sides[i]!;
    const sJ = sides[j]!;
    if (sI * sJ < -1e-9) {
      const pt = lineEdgeIntersect(l1, l2, poly[i]!, poly[j]!);
      if (pt) crossings.push({ edge: i, pt });
    }
  }
  if (crossings.length !== 2) return null;
  const c1 = crossings[0]!;
  const c2 = crossings[1]!;

  const polyA: Pt[] = [c1.pt];
  for (let k = 1; k <= n; k++) {
    const i = (c1.edge + k) % n;
    polyA.push(poly[i]!);
    if (i === c2.edge) break;
  }
  polyA.push(c2.pt);

  const polyB: Pt[] = [c2.pt];
  for (let k = 1; k <= n; k++) {
    const i = (c2.edge + k) % n;
    polyB.push(poly[i]!);
    if (i === c1.edge) break;
  }
  polyB.push(c1.pt);

  if (polyA.length < 3 || polyB.length < 3) return null;
  return { a: polyA, b: polyB };
}

// ---------- Polygon templates ----------

function rect(w: number, h: number): Pt[] {
  return [
    { x: CX - w / 2, y: CY - h / 2 },
    { x: CX + w / 2, y: CY - h / 2 },
    { x: CX + w / 2, y: CY + h / 2 },
    { x: CX - w / 2, y: CY + h / 2 },
  ];
}

function rightTri(w: number, h: number): Pt[] {
  return [
    { x: CX - w / 2, y: CY + h / 2 },
    { x: CX + w / 2, y: CY + h / 2 },
    { x: CX - w / 2, y: CY - h / 2 },
  ];
}

function regular(n: number, r: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    out.push({ x: CX + r * Math.cos(a), y: CY + r * Math.sin(a) });
  }
  return out;
}

function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function convexJitter(n: number, baseR: number, jitter: number, seed: number): Pt[] {
  const rng = mulberry32(seed);
  const step = (2 * Math.PI) / n;
  const angles: number[] = [];
  for (let i = 0; i < n; i++) {
    angles.push(-Math.PI / 2 + i * step + (rng() - 0.5) * step * 0.5);
  }
  angles.sort((x, y) => x - y);
  const pts: Pt[] = [];
  for (const a of angles) {
    const r = baseR * (1 + (rng() - 0.5) * jitter);
    pts.push({ x: CX + r * Math.cos(a), y: CY + r * Math.sin(a) });
  }
  return pts;
}

const ROUNDS: RoundDef[] = [
  { poly: () => rect(280, 280), target: 0.5, label: '1:1' },
  { poly: () => rect(360, 200), target: 0.5, label: '1:1' },
  { poly: () => regular(3, 200), target: 0.5, label: '1:1' },
  { poly: () => rightTri(320, 240), target: 1 / 3, label: '1:2' },
  { poly: () => regular(5, 190), target: 0.5, label: '1:1' },
  { poly: () => regular(6, 190), target: 0.4, label: '2:3' },
  { poly: () => convexJitter(5, 180, 0.25, 91237), target: 1 / 3, label: '1:2' },
  { poly: () => convexJitter(6, 180, 0.30, 21893), target: 0.4, label: '2:3' },
  { poly: () => convexJitter(7, 180, 0.32, 71823), target: 0.25, label: '1:3' },
  { poly: () => convexJitter(8, 180, 0.35, 31278), target: 0.375, label: '3:5' },
];

// ---------- Drawing ----------

function fillPoly(pts: Pt[], style: string): void {
  if (pts.length < 3) return;
  ctx.beginPath();
  ctx.moveTo(pts[0]!.x, pts[0]!.y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y);
  ctx.closePath();
  ctx.fillStyle = style;
  ctx.fill();
}

function strokePoly(pts: Pt[], style: string, w: number): void {
  if (pts.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(pts[0]!.x, pts[0]!.y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y);
  ctx.closePath();
  ctx.strokeStyle = style;
  ctx.lineWidth = w;
  ctx.lineJoin = 'round';
  ctx.stroke();
}

function extendLineToCanvas(p1: Pt, p2: Pt): [Pt, Pt] | null {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return null;
  const candidates: { t: number; pt: Pt }[] = [];
  if (Math.abs(dx) > 1e-9) {
    candidates.push({ t: (0 - p1.x) / dx, pt: { x: 0, y: 0 } });
    candidates.push({ t: (W - p1.x) / dx, pt: { x: 0, y: 0 } });
  }
  if (Math.abs(dy) > 1e-9) {
    candidates.push({ t: (0 - p1.y) / dy, pt: { x: 0, y: 0 } });
    candidates.push({ t: (H - p1.y) / dy, pt: { x: 0, y: 0 } });
  }
  const inside: { t: number; pt: Pt }[] = [];
  for (const c of candidates) {
    const x = p1.x + c.t * dx;
    const y = p1.y + c.t * dy;
    if (x >= -1e-3 && x <= W + 1e-3 && y >= -1e-3 && y <= H + 1e-3) {
      inside.push({ t: c.t, pt: { x, y } });
    }
  }
  if (inside.length < 2) return null;
  inside.sort((a, b) => a.t - b.t);
  return [inside[0]!.pt, inside[inside.length - 1]!.pt];
}

function hexAlpha(hex: string, a: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function scoreColor(s: number): string {
  if (s >= 90) return '#34d399';
  if (s >= 70) return '#a3e635';
  if (s >= 40) return '#fbbf24';
  if (s >= 20) return '#fb923c';
  return '#f87171';
}

function drawLabel(p: Pt, text: string, color: string): void {
  ctx.font = 'bold 18px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const padding = 8;
  const m = ctx.measureText(text);
  const bw = m.width + padding * 2;
  const bh = 26;
  ctx.fillStyle = 'rgba(10,11,14,0.75)';
  ctx.beginPath();
  const rr = (ctx as unknown as { roundRect?: (x: number, y: number, w: number, h: number, r: number) => void }).roundRect;
  if (typeof rr === 'function') {
    rr.call(ctx, p.x - bw / 2, p.y - bh / 2, bw, bh, 8);
  } else {
    ctx.rect(p.x - bw / 2, p.y - bh / 2, bw, bh);
  }
  ctx.fill();
  ctx.fillStyle = color;
  ctx.fillText(text, p.x, p.y);
}

function draw(): void {
  const bg = css('--surface', '#13151a');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = css('--border', '#2a2d36');
  ctx.lineWidth = 1;
  const step = 60;
  ctx.beginPath();
  for (let i = step; i < W; i += step) {
    ctx.moveTo(i, 0);
    ctx.lineTo(i, H);
    ctx.moveTo(0, i);
    ctx.lineTo(W, i);
  }
  ctx.stroke();

  if (phase === 'intro' || polygon.length === 0) return;

  const accent = css('--accent', '#7c93ff');
  const polyFill = 'rgba(124, 147, 255, 0.18)';
  const colorA = '#34d399';
  const colorB = '#fb923c';

  if (split) {
    fillPoly(split.a, hexAlpha(colorA, 0.32));
    fillPoly(split.b, hexAlpha(colorB, 0.32));
  } else {
    fillPoly(polygon, polyFill);
  }
  strokePoly(polygon, accent, 2);

  if (line) {
    const ext = extendLineToCanvas(line.p1, line.p2);
    if (ext) {
      ctx.strokeStyle = phase === 'scored' ? '#ffffff' : 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 2;
      ctx.setLineDash(phase === 'scored' ? [] : [8, 6]);
      ctx.beginPath();
      ctx.moveTo(ext[0]!.x, ext[0]!.y);
      ctx.lineTo(ext[1]!.x, ext[1]!.y);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(line.p1.x, line.p1.y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(line.p2.x, line.p2.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  if (split) {
    const aArea = polyArea(split.a);
    const bArea = polyArea(split.b);
    const total = aArea + bArea;
    if (total > 0) {
      const pctA = Math.round((aArea / total) * 100);
      const pctB = 100 - pctA;
      drawLabel(polyMean(split.a), `%${pctA}`, colorA);
      drawLabel(polyMean(split.b), `%${pctB}`, colorB);
    }
  }

  if (phase === 'scored') {
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, H - 88, W, 88);
    ctx.fillStyle = scoreColor(roundScore);
    ctx.font = 'bold 36px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`+${roundScore}`, W / 2, H - 60);
    ctx.font = '500 13px system-ui, -apple-system, sans-serif';
    ctx.fillStyle = '#cbd0db';
    const pctOff = (lastError * 100).toFixed(1);
    const isLast = roundIndex + 1 >= TOTAL_ROUNDS;
    ctx.fillText(
      isLast
        ? `Sapma %${pctOff} · Tüm turlar tamam — Boşluk: tekrar`
        : `Sapma %${pctOff} · Boşluk veya Sonraki ▶ ile devam et`,
      W / 2,
      H - 26,
    );
  }
}

// ---------- HUD update ----------

function updateHud(): void {
  const shown = Math.min(roundIndex + 1, TOTAL_ROUNDS);
  roundEl.textContent = `${shown}/${TOTAL_ROUNDS}`;
  targetEl.textContent = polygon.length ? targetLabel : '—';
  totalEl.textContent = String(totalScore);
  bestEl.textContent = String(bestScore);
  nextBtn.disabled = phase !== 'scored';
}

// ---------- State ----------

function loadRound(): void {
  const def = ROUNDS[roundIndex]!;
  polygon = def.poly();
  target = def.target;
  targetLabel = def.label;
  line = null;
  split = null;
  roundScore = 0;
  lastError = 0;
  phase = 'aiming';
  updateHud();
  draw();
}

function startGame(): void {
  totalScore = 0;
  roundIndex = 0;
  loadRound();
  hideOverlay();
}

function advanceRound(): void {
  if (phase !== 'scored') return;
  roundIndex++;
  if (roundIndex >= TOTAL_ROUNDS) {
    finishGame();
    return;
  }
  loadRound();
}

function finishGame(): void {
  phase = 'finished';
  const newRecord = totalScore > bestScore;
  if (newRecord) {
    bestScore = totalScore;
    safeWrite(STORAGE_BEST, bestScore);
  }
  updateHud();
  draw();
  showOverlay(
    `Skor: ${totalScore} / ${TOTAL_ROUNDS * 100}`,
    newRecord && totalScore > 0
      ? `Yeni rekor! 10 turun bitti.`
      : `Rekorun: ${bestScore}. Tekrar dene.`,
    'Tekrar oyna',
  );
}

function reset(): void {
  phase = 'intro';
  polygon = [];
  line = null;
  split = null;
  totalScore = 0;
  roundIndex = 0;
  roundScore = 0;
  lastError = 0;
  updateHud();
  draw();
  showOverlay(
    'Tam Pay',
    'Çokgeni tek bir düz çizgiyle istenen orana göre kes.\n10 tur · maks. 1000 puan.',
    'Başla',
  );
}

// ---------- Overlay ----------

function showOverlay(title: string, msg: string, btn: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  overlayBtn.textContent = btn;
  showOverlayEl(overlay);
}

function hideOverlay(): void {
  hideOverlayEl(overlay);
}

function onOverlayBtn(): void {
  if (phase === 'intro') startGame();
  else if (phase === 'finished') {
    reset();
    startGame();
  }
}

// ---------- Input ----------

function toCanvasPt(e: PointerEvent): Pt {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((e.clientX - rect.left) * canvas.width) / rect.width,
    y: ((e.clientY - rect.top) * canvas.height) / rect.height,
  };
}

function onDown(e: PointerEvent): void {
  if (phase !== 'aiming' && phase !== 'drawing') return;
  e.preventDefault();
  canvas.setPointerCapture(e.pointerId);
  const p = toCanvasPt(e);
  line = { p1: p, p2: p };
  split = null;
  phase = 'drawing';
  draw();
}

function onMove(e: PointerEvent): void {
  if (phase !== 'drawing' || !line) return;
  e.preventDefault();
  const p = toCanvasPt(e);
  line.p2 = p;
  const d = Math.hypot(p.x - line.p1.x, p.y - line.p1.y);
  split = d >= MIN_DRAG_PX ? splitConvex(polygon, line.p1, line.p2) : null;
  draw();
}

function onUp(e: PointerEvent): void {
  if (phase !== 'drawing' || !line) return;
  e.preventDefault();
  if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  const d = Math.hypot(line.p2.x - line.p1.x, line.p2.y - line.p1.y);
  if (d < MIN_DRAG_PX) {
    line = null;
    split = null;
    phase = 'aiming';
    draw();
    return;
  }
  const s = splitConvex(polygon, line.p1, line.p2);
  if (!s) {
    line = null;
    split = null;
    phase = 'aiming';
    draw();
    return;
  }
  split = s;
  commitRound();
}

function commitRound(): void {
  if (!split) return;
  const aArea = polyArea(split.a);
  const bArea = polyArea(split.b);
  const total = aArea + bArea;
  if (total <= 0) return;
  const smaller = Math.min(aArea, bArea) / total;
  lastError = Math.abs(smaller - target);
  roundScore = Math.max(0, Math.round(100 * (1 - lastError / MAX_ERROR)));
  totalScore += roundScore;
  phase = 'scored';
  updateHud();
  draw();
}

function onCancel(e: PointerEvent): void {
  if (phase !== 'drawing') return;
  if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  line = null;
  split = null;
  phase = 'aiming';
  draw();
}

function onKey(e: KeyboardEvent): void {
  if (e.key === ' ' || e.key === 'Enter') {
    if (phase === 'intro') {
      e.preventDefault();
      startGame();
    } else if (phase === 'scored') {
      e.preventDefault();
      advanceRound();
    } else if (phase === 'finished') {
      e.preventDefault();
      reset();
      startGame();
    }
    return;
  }
  if (e.key === 'r' || e.key === 'R') {
    e.preventDefault();
    reset();
  }
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  roundEl = document.querySelector<HTMLElement>('#round')!;
  targetEl = document.querySelector<HTMLElement>('#target')!;
  totalEl = document.querySelector<HTMLElement>('#total')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  nextBtn = document.querySelector<HTMLButtonElement>('#next')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;

  bestScore = safeRead<number>(STORAGE_BEST, 0);

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onCancel);
  nextBtn.addEventListener('click', advanceRound);
  restartBtn.addEventListener('click', () => {
    reset();
  });
  overlayBtn.addEventListener('click', onOverlayBtn);
  window.addEventListener('keydown', onKey);

  reset();
}

export const game = defineGame({ init, reset });
