import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';

// PITFALLS guarded:
// - unguarded-storage: safeRead/safeWrite wrap localStorage.
// - module-level-dom-access: all queries + listeners inside init().
// - overlay-input-leak: state enum guards every pointer/key handler.
// - stale-async-callback: gen.bump() in resetRound() cancels pending animation
//   callbacks; finishStroke also uses a gen token to drop late settle calls.
// - visual-vs-hitbox: the corridor band drawn by drawCorridor() is sampled from
//   the same `centerline` array that judgeProgress() reads, with the same
//   corridorWidth — single source of truth.

const STORAGE_BEST = 'hattat.best';
const C_W = 480;
const C_H = 560;
const STROKES_PER_ROUND = 7;

type State = 'ready' | 'tracing' | 'judging' | 'gameover';

interface Pt { x: number; y: number }

interface Stroke {
  name: string;
  centerline: Pt[];        // dense sample
  corridorWidth: number;   // px (full width; half-width on each side)
}

interface TraceSample {
  x: number;
  y: number;
  closestIdx: number;
  closestDist: number;
  inCorridor: boolean;
  width: number;           // ink width at this sample (0 when out)
}

const gen = createGenToken();
let state: State = 'ready';
let totalScore = 0;
let best = 0;
let strokeIdx = 0;
let lastStrokeScore = -1;

let stroke!: Stroke;
let trace: TraceSample[] = [];
let drawing = false;
let drawStartedAtCanvas = false;  // whether pointerdown started near startDot
let maxReachedIdx = 0;
let inFrames = 0;
let totalFrames = 0;

// Settle-display data — preserved between strokes to render previous result.
let lastStrokeBreakdown: { coverage: number; adherence: number; complete: number; total: number } | null = null;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let roundEl!: HTMLElement;
let lastEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;

// ---------- Bezier helpers ----------

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function bezier3(p0: Pt, p1: Pt, p2: Pt, t: number): Pt {
  const u = 1 - t;
  return {
    x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
    y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y,
  };
}

function bezier4(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
}

// Sample a cubic Bezier into N points.
function sampleCubic(p0: Pt, p1: Pt, p2: Pt, p3: Pt, n: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    out.push(bezier4(p0, p1, p2, p3, i / (n - 1)));
  }
  return out;
}

// Concatenate multiple Bezier segment sample arrays; deduplicate joins.
function concatSegments(segs: Pt[][]): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!;
    const start = i === 0 ? 0 : 1; // skip duplicate join point
    for (let j = start; j < seg.length; j++) {
      out.push(seg[j]!);
    }
  }
  return out;
}

// Re-sample by uniform arc length so coverage progress feels even regardless of
// where Bezier control points cluster.
function resampleByArcLength(pts: Pt[], n: number): Pt[] {
  if (pts.length === 0) return pts;
  const cum: number[] = [0];
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i]!.x - pts[i - 1]!.x;
    const dy = pts[i]!.y - pts[i - 1]!.y;
    cum.push(cum[i - 1]! + Math.hypot(dx, dy));
  }
  const total = cum[cum.length - 1]!;
  if (total === 0) return pts.slice(0, 1);
  const out: Pt[] = [];
  let j = 0;
  for (let i = 0; i < n; i++) {
    const target = (i / (n - 1)) * total;
    while (j < cum.length - 1 && cum[j + 1]! < target) j++;
    const a = cum[j]!;
    const b = cum[Math.min(j + 1, cum.length - 1)]!;
    const t = b === a ? 0 : (target - a) / (b - a);
    const p0 = pts[j]!;
    const p1 = pts[Math.min(j + 1, pts.length - 1)]!;
    out.push({ x: lerp(p0.x, p1.x, t), y: lerp(p0.y, p1.y, t) });
  }
  return out;
}

// ---------- Stroke library (7 hand-tuned curves) ----------

function makeStrokes(): Stroke[] {
  // Each curve aims to feel like a calligraphic gesture. Corridor narrows by index.
  const widths = [34, 30, 26, 22, 20, 16, 14];
  const samples = 200;

  // 1. Tek-eğri (single arc) — gentle left-to-right rise then fall.
  const arc = resampleByArcLength(
    sampleCubic(
      { x: 60, y: 380 },
      { x: 180, y: 120 },
      { x: 300, y: 120 },
      { x: 420, y: 380 },
      samples,
    ),
    samples,
  );

  // 2. S-yayı (S-curve) — top-left to bottom-right with inflection.
  const sCurve = resampleByArcLength(
    sampleCubic(
      { x: 80, y: 100 },
      { x: 420, y: 200 },
      { x: 60, y: 360 },
      { x: 400, y: 460 },
      samples,
    ),
    samples,
  );

  // 3. Halka (loop) — clockwise loop using two cubic segments.
  const loopSeg1 = sampleCubic(
    { x: 110, y: 380 },
    { x: 80, y: 120 },
    { x: 360, y: 80 },
    { x: 410, y: 280 },
    100,
  );
  const loopSeg2 = sampleCubic(
    { x: 410, y: 280 },
    { x: 360, y: 480 },
    { x: 140, y: 470 },
    { x: 160, y: 260 },
    100,
  );
  const loop = resampleByArcLength(concatSegments([loopSeg1, loopSeg2]), samples);

  // 4. Çift-bumbar (double bump) — two arches like an "m".
  const bumpSeg1 = sampleCubic(
    { x: 50, y: 400 },
    { x: 90, y: 150 },
    { x: 200, y: 150 },
    { x: 240, y: 400 },
    100,
  );
  const bumpSeg2 = sampleCubic(
    { x: 240, y: 400 },
    { x: 280, y: 150 },
    { x: 390, y: 150 },
    { x: 430, y: 400 },
    100,
  );
  const bumps = resampleByArcLength(concatSegments([bumpSeg1, bumpSeg2]), samples);

  // 5. Taç eğrisi (crown curve) — up, dip, up, then down. Quadratic chain.
  const q = (p0: Pt, p1: Pt, p2: Pt) => {
    const out: Pt[] = [];
    for (let i = 0; i <= 60; i++) out.push(bezier3(p0, p1, p2, i / 60));
    return out;
  };
  const crown = resampleByArcLength(
    concatSegments([
      q({ x: 60, y: 440 }, { x: 110, y: 200 }, { x: 170, y: 240 }),
      q({ x: 170, y: 240 }, { x: 220, y: 320 }, { x: 260, y: 260 }),
      q({ x: 260, y: 260 }, { x: 310, y: 180 }, { x: 360, y: 220 }),
      q({ x: 360, y: 220 }, { x: 410, y: 280 }, { x: 430, y: 440 }),
    ]),
    samples,
  );

  // 6. Sülüs sweep — long flowing diagonal with a return curl.
  const sulSeg1 = sampleCubic(
    { x: 70, y: 480 },
    { x: 180, y: 60 },
    { x: 420, y: 80 },
    { x: 420, y: 280 },
    120,
  );
  const sulSeg2 = sampleCubic(
    { x: 420, y: 280 },
    { x: 360, y: 460 },
    { x: 180, y: 480 },
    { x: 90, y: 320 },
    100,
  );
  const sul = resampleByArcLength(concatSegments([sulSeg1, sulSeg2]), samples);

  // 7. Tuğra-style hat — three sweeping arches across the canvas.
  const tugSeg1 = sampleCubic(
    { x: 60, y: 460 },
    { x: 90, y: 100 },
    { x: 200, y: 120 },
    { x: 220, y: 380 },
    80,
  );
  const tugSeg2 = sampleCubic(
    { x: 220, y: 380 },
    { x: 240, y: 120 },
    { x: 330, y: 100 },
    { x: 340, y: 380 },
    80,
  );
  const tugSeg3 = sampleCubic(
    { x: 340, y: 380 },
    { x: 360, y: 120 },
    { x: 440, y: 140 },
    { x: 420, y: 460 },
    80,
  );
  const tug = resampleByArcLength(concatSegments([tugSeg1, tugSeg2, tugSeg3]), samples);

  return [
    { name: 'Tek-eğri', centerline: arc, corridorWidth: widths[0]! },
    { name: 'S-yayı', centerline: sCurve, corridorWidth: widths[1]! },
    { name: 'Halka', centerline: loop, corridorWidth: widths[2]! },
    { name: 'Çift-bumbar', centerline: bumps, corridorWidth: widths[3]! },
    { name: 'Taç', centerline: crown, corridorWidth: widths[4]! },
    { name: 'Sülüs', centerline: sul, corridorWidth: widths[5]! },
    { name: 'Tuğra', centerline: tug, corridorWidth: widths[6]! },
  ];
}

let strokes: Stroke[] = [];

// ---------- DOM/canvas helpers ----------

function getCanvasPoint(e: PointerEvent): Pt {
  const rect = canvas.getBoundingClientRect();
  const sx = canvas.width / rect.width;
  const sy = canvas.height / rect.height;
  return {
    x: (e.clientX - rect.left) * sx,
    y: (e.clientY - rect.top) * sy,
  };
}

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlay);
}

function hideOverlay(): void {
  hideOverlayEl(overlay);
}

function updateHUD(): void {
  scoreEl.textContent = String(totalScore);
  roundEl.textContent = state === 'ready' ? `0/${STROKES_PER_ROUND}` : `${Math.min(strokeIdx + 1, STROKES_PER_ROUND)}/${STROKES_PER_ROUND}`;
  lastEl.textContent = lastStrokeScore < 0 ? '—' : String(lastStrokeScore);
  bestEl.textContent = String(best);
}

// ---------- Judging ----------

function closestSampleIndex(p: Pt, line: Pt[]): { idx: number; dist: number } {
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < line.length; i++) {
    const dx = line[i]!.x - p.x;
    const dy = line[i]!.y - p.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestDist) {
      bestDist = d2;
      bestIdx = i;
    }
  }
  return { idx: bestIdx, dist: Math.sqrt(bestDist) };
}

function judgeStroke(): { coverage: number; adherence: number; complete: number; total: number } {
  const total = stroke.centerline.length;
  const cov = Math.min(1, maxReachedIdx / (total - 1));
  const coveragePts = Math.round(cov * 60);
  const adh = totalFrames === 0 ? 0 : inFrames / totalFrames;
  // Require minimum coverage before adherence pays — otherwise tapping the
  // green dot once gives 30 free points (adh=1.0 over a single sample).
  const adherencePts = cov < 0.1 ? 0 : Math.round(adh * 30);
  // Completion: reached at least 92% AND last sample is near the end dot.
  let completePts = 0;
  if (cov >= 0.92 && trace.length > 0) {
    const last = trace[trace.length - 1]!;
    const end = stroke.centerline[stroke.centerline.length - 1]!;
    const d = Math.hypot(last.x - end.x, last.y - end.y);
    if (d < stroke.corridorWidth * 0.9) {
      completePts = 10;
    } else if (d < stroke.corridorWidth * 1.4) {
      completePts = 5;
    }
  }
  // Sub-40% coverage = stroke considered failed (no completion bonus).
  if (cov < 0.4) completePts = 0;
  const totalPts = coveragePts + adherencePts + completePts;
  return {
    coverage: coveragePts,
    adherence: adherencePts,
    complete: completePts,
    total: totalPts,
  };
}

// ---------- Game flow ----------

function loadStroke(idx: number): void {
  stroke = strokes[idx]!;
  trace = [];
  drawing = false;
  drawStartedAtCanvas = false;
  maxReachedIdx = 0;
  inFrames = 0;
  totalFrames = 0;
  state = 'tracing';
  hideOverlay();
  updateHUD();
  draw();
}

function startRound(): void {
  totalScore = 0;
  strokeIdx = 0;
  lastStrokeScore = -1;
  lastStrokeBreakdown = null;
  state = 'tracing';
  updateHUD();
  loadStroke(0);
}

function finishStroke(): void {
  if (state !== 'tracing') return;
  state = 'judging';
  drawing = false;
  const result = judgeStroke();
  lastStrokeScore = result.total;
  lastStrokeBreakdown = result;
  totalScore += result.total;
  updateHUD();
  draw();
  // Settle screen: show the judged stroke then move on. Use gen token so a
  // mid-settle reset() drops these callbacks.
  const myGen = gen.current();
  window.setTimeout(() => {
    if (!gen.isCurrent(myGen)) return;
    afterStrokeSettle();
  }, 1200);
}

function afterStrokeSettle(): void {
  if (state !== 'judging') return;
  strokeIdx += 1;
  if (strokeIdx >= STROKES_PER_ROUND) {
    state = 'gameover';
    commitBest();
    updateHUD();
    const msg = `Toplam: ${totalScore} / ${STROKES_PER_ROUND * 100}\n\nBoşluk veya tıkla: yeni meşk turu`;
    showOverlay('Bitti!', msg);
    draw();
    return;
  }
  loadStroke(strokeIdx);
}

function commitBest(): void {
  if (totalScore > best) {
    best = totalScore;
    safeWrite(STORAGE_BEST, best);
    bestEl.textContent = String(best);
  }
}

function resetRound(): void {
  gen.bump();
  state = 'ready';
  totalScore = 0;
  strokeIdx = 0;
  lastStrokeScore = -1;
  lastStrokeBreakdown = null;
  drawing = false;
  trace = [];
  maxReachedIdx = 0;
  inFrames = 0;
  totalFrames = 0;
  // Show first stroke faded behind the overlay so the player previews it.
  stroke = strokes[0]!;
  updateHUD();
  showOverlay(
    'Hattat',
    'Yeşil noktadan başla, koridordan çıkmadan altın noktaya kadar sürükle.\n\nBoşluk veya tıkla: başla',
  );
  draw();
}

// ---------- Rendering ----------

function drawPaperGrain(): void {
  ctx.fillStyle = '#f4e9cf';
  ctx.fillRect(0, 0, C_W, C_H);
  // Aged paper specks for warmth (deterministic).
  ctx.fillStyle = 'rgba(120, 90, 40, 0.06)';
  for (let i = 0; i < 60; i++) {
    const x = ((i * 73) % C_W);
    const y = ((i * 137) % C_H);
    ctx.fillRect(x, y, 2, 2);
  }
  // Soft outer vignette.
  const grad = ctx.createRadialGradient(C_W / 2, C_H / 2, 100, C_W / 2, C_H / 2, 320);
  grad.addColorStop(0, 'rgba(244, 233, 207, 0)');
  grad.addColorStop(1, 'rgba(120, 90, 40, 0.18)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, C_W, C_H);
}

function drawCorridor(): void {
  const line = stroke.centerline;
  const w = stroke.corridorWidth;
  // Soft outer band.
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(138, 111, 60, 0.18)';
  ctx.lineWidth = w + 6;
  ctx.beginPath();
  ctx.moveTo(line[0]!.x, line[0]!.y);
  for (let i = 1; i < line.length; i++) ctx.lineTo(line[i]!.x, line[i]!.y);
  ctx.stroke();
  // Inner highlight band — the actual tolerance corridor.
  ctx.strokeStyle = 'rgba(196, 168, 106, 0.42)';
  ctx.lineWidth = w;
  ctx.beginPath();
  ctx.moveTo(line[0]!.x, line[0]!.y);
  for (let i = 1; i < line.length; i++) ctx.lineTo(line[i]!.x, line[i]!.y);
  ctx.stroke();
  // Centerline guide — dashed, very subtle.
  ctx.strokeStyle = 'rgba(60, 45, 20, 0.18)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 6]);
  ctx.beginPath();
  ctx.moveTo(line[0]!.x, line[0]!.y);
  for (let i = 1; i < line.length; i++) ctx.lineTo(line[i]!.x, line[i]!.y);
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawDots(): void {
  const line = stroke.centerline;
  const start = line[0]!;
  const end = line[line.length - 1]!;
  // Start dot — green pulse.
  const pulse = (Math.sin(performance.now() / 280) + 1) * 0.5;
  ctx.fillStyle = `rgba(52, 211, 153, ${0.65 + pulse * 0.35})`;
  ctx.beginPath();
  ctx.arc(start.x, start.y, 12 + pulse * 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#0f3823';
  ctx.font = '700 14px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('B', start.x, start.y);
  // End dot — gold.
  ctx.fillStyle = '#d4af37';
  ctx.beginPath();
  ctx.arc(end.x, end.y, 12, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#2c1f06';
  ctx.fillText('S', end.x, end.y);
}

function drawTrace(): void {
  if (trace.length < 2) return;
  // Draw ink segments: black inside corridor, faded red outside.
  for (let i = 1; i < trace.length; i++) {
    const a = trace[i - 1]!;
    const b = trace[i]!;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (b.inCorridor && a.inCorridor) {
      ctx.strokeStyle = 'rgba(26, 20, 16, 0.92)';
      ctx.lineWidth = Math.max(2.2, b.width);
    } else {
      ctx.strokeStyle = 'rgba(192, 60, 50, 0.78)';
      ctx.lineWidth = Math.max(1.6, b.width * 0.7);
    }
    ctx.stroke();
  }
}

function drawProgressGlow(): void {
  // Highlight the part of the centerline that has been reached.
  if (state !== 'tracing' && state !== 'judging') return;
  const line = stroke.centerline;
  if (maxReachedIdx <= 0) return;
  ctx.strokeStyle = 'rgba(52, 211, 153, 0.25)';
  ctx.lineWidth = stroke.corridorWidth + 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(line[0]!.x, line[0]!.y);
  for (let i = 1; i <= maxReachedIdx; i++) {
    ctx.lineTo(line[i]!.x, line[i]!.y);
  }
  ctx.stroke();
}

function drawStrokeLabel(): void {
  ctx.fillStyle = 'rgba(60, 45, 20, 0.55)';
  ctx.font = '600 12px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(`Meşk ${strokeIdx + 1} / ${STROKES_PER_ROUND}: ${stroke.name}`, 14, 14);
  ctx.textAlign = 'right';
  ctx.fillText(`Koridor: ${stroke.corridorWidth}px`, C_W - 14, 14);
}

function drawSettleOverlay(): void {
  if (state !== 'judging' || !lastStrokeBreakdown) return;
  const b = lastStrokeBreakdown;
  const cardW = 240;
  const cardH = 110;
  const x = (C_W - cardW) / 2;
  const y = C_H - cardH - 20;
  ctx.fillStyle = 'rgba(20, 12, 6, 0.88)';
  ctx.beginPath();
  const r = 14;
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + cardW - r, y);
  ctx.arcTo(x + cardW, y, x + cardW, y + r, r);
  ctx.lineTo(x + cardW, y + cardH - r);
  ctx.arcTo(x + cardW, y + cardH, x + cardW - r, y + cardH, r);
  ctx.lineTo(x + r, y + cardH);
  ctx.arcTo(x, y + cardH, x, y + cardH - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#d4af37';
  ctx.font = '700 22px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${b.total} puan`, C_W / 2, y + 26);
  ctx.fillStyle = '#e5d6a8';
  ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
  ctx.fillText(`Kapsama ${b.coverage}  ·  Sadakat ${b.adherence}  ·  Bitiş ${b.complete}`, C_W / 2, y + 55);
  ctx.fillStyle = 'rgba(229, 214, 168, 0.6)';
  ctx.font = '500 11px ui-sans-serif, system-ui, sans-serif';
  ctx.fillText(strokeIdx + 1 < STROKES_PER_ROUND ? 'Sıradaki meşk geliyor…' : 'Tur tamam…', C_W / 2, y + 80);
}

function draw(): void {
  drawPaperGrain();
  if (state === 'ready' || state === 'tracing' || state === 'judging' || state === 'gameover') {
    if (stroke) {
      drawCorridor();
      drawProgressGlow();
      drawDots();
      drawStrokeLabel();
      drawTrace();
    }
  }
  drawSettleOverlay();
}

function rafLoop(): void {
  const myGen = gen.current();
  function tick(): void {
    if (!gen.isCurrent(myGen)) return;
    draw();
    if (state === 'tracing' || state === 'judging' || state === 'ready') {
      requestAnimationFrame(tick);
    }
  }
  requestAnimationFrame(tick);
}

// ---------- Input ----------

function tracePoint(p: Pt): void {
  if (state !== 'tracing' || !drawing) return;
  const { idx, dist } = closestSampleIndex(p, stroke.centerline);
  const inside = dist <= stroke.corridorWidth / 2;
  // Per-frame counters (frames here means pointer samples — they correlate with
  // the player's gesture duration, which is what we want to score).
  totalFrames += 1;
  if (inside) {
    inFrames += 1;
    // Order matters — only advance progress if the new index is ahead of the
    // current max and reasonably close to it (no skipping backwards loops).
    if (idx > maxReachedIdx && idx <= maxReachedIdx + 14) {
      maxReachedIdx = idx;
    } else if (idx > maxReachedIdx + 14) {
      // Big jump means user skipped a long way — only credit advancing by 14
      // so they cannot teleport-cheese the coverage score.
      maxReachedIdx = maxReachedIdx + 14;
    }
  }
  const width = inside ? 4.5 + (1 - dist / (stroke.corridorWidth / 2)) * 3.5 : 2.0;
  trace.push({ x: p.x, y: p.y, closestIdx: idx, closestDist: dist, inCorridor: inside, width });
}

function onPointerDown(e: PointerEvent): void {
  if (state === 'ready' || state === 'gameover') {
    startRound();
    return;
  }
  if (state !== 'tracing') return;
  const p = getCanvasPoint(e);
  // Must start near the green dot.
  const start = stroke.centerline[0]!;
  const d = Math.hypot(p.x - start.x, p.y - start.y);
  if (d > Math.max(28, stroke.corridorWidth * 0.9)) {
    // Brief visual cue: flash trace empty so user knows they missed.
    return;
  }
  drawing = true;
  drawStartedAtCanvas = true;
  trace = [];
  maxReachedIdx = 0;
  inFrames = 0;
  totalFrames = 0;
  try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  tracePoint(p);
}

function onPointerMove(e: PointerEvent): void {
  if (state !== 'tracing' || !drawing) return;
  const p = getCanvasPoint(e);
  tracePoint(p);
}

function onPointerUp(e: PointerEvent): void {
  if (!drawing) return;
  const p = getCanvasPoint(e);
  tracePoint(p);
  drawing = false;
  try { canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  if (drawStartedAtCanvas) {
    finishStroke();
  }
}

function onPointerCancel(): void {
  if (!drawing) return;
  drawing = false;
  if (drawStartedAtCanvas) {
    finishStroke();
  }
}

function onKey(e: KeyboardEvent): void {
  const k = e.key.toLowerCase();
  if (k === 'r') {
    resetRound();
    e.preventDefault();
    return;
  }
  if (k === ' ' || k === 'enter') {
    if (state === 'ready' || state === 'gameover') {
      startRound();
      e.preventDefault();
    }
    // Mid-round: Space does nothing — tracing is pointer-only by design.
  }
}

function onOverlayClick(): void {
  if (state === 'ready' || state === 'gameover') {
    startRound();
  }
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  roundEl = document.querySelector<HTMLElement>('#round')!;
  lastEl = document.querySelector<HTMLElement>('#last')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;

  best = safeRead<number>(STORAGE_BEST, 0);
  strokes = makeStrokes();

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);
  overlay.addEventListener('click', onOverlayClick);
  window.addEventListener('keydown', onKey);
  restartBtn.addEventListener('click', resetRound);

  resetRound();
  rafLoop();
}

export const game = defineGame({ init, reset: resetRound });
