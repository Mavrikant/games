import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';

// Marangoz — cutting-stock puzzle. A plank of integer length must be split
// at integer cm positions to produce a target list of piece lengths. The saw
// kerf is 1 cm: each cut destroys 1 cm of wood. Score: +10 per matched piece,
// -4 per unmet need, -1 per cm of leftover waste. Endless rounds in 75 s.
//
// PITFALLS guarded:
// - unguarded-storage: safeRead/safeWrite wrap localStorage in try/catch.
// - stale-async-callback: gen.bump() in reset() invalidates RAF chain.
// - overlay-input-leak: explicit state enum; first input from `ready` only
//   starts the round, never lands a cut at the click position.
// - missing-overlay-css: per-game CSS defines .overlay positioning + hidden.
// - module-level side effects: all DOM access lives in init().

const STORAGE_BEST = 'marangoz.best';
const GAME_DURATION_MS = 75_000;
const KERF_CM = 1;
const TOLERANCE_CM = 0;
const MATCH_BONUS = 10;
const MISS_PENALTY = 4;
const WASTE_PENALTY = 1;
const PLANK_PX_INSET = 60;
const PLANK_Y = 280;
const PLANK_H = 80;
const PIECE_Y = 110;
const PIECE_H = 56;
const RESOLVED_HOLD_MS = 900;

type State = 'ready' | 'playing' | 'gameover';

interface ResolvedSegment {
  start: number;
  length: number;
  matchedNeedIndex: number | null;
  kind: 'piece' | 'kerf';
}

interface Round {
  plankCm: number;
  needs: number[];
  cuts: number[];
  resolved: ResolvedSegment[] | null;
}

const gen = createGenToken();
let state: State = 'ready';
let score = 0;
let best = 0;
let endTimeMs = 0;
let remainingMs = GAME_DURATION_MS;
let round: Round = { plankCm: 1, needs: [], cuts: [], resolved: null };
let resolvedUntilMs = 0;
let lastFlashMsg = '';
let lastFlashUntil = 0;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let timeEl!: HTMLElement;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let submitBtn!: HTMLButtonElement;
let clearBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;

const READY_TITLE = 'Marangoz';
const READY_MSG =
  "Tahtayı kes — istenen parçaları üret, atık en az olsun. Tahtaya tıkla → kesim ekle, kesim çizgisine tıkla → sil. Boşluk veya Kes butonu testereyi çalıştırır. Testere 1 cm yer kaplar.\n\nBaşlamak için tıkla.";

function nowMs(): number {
  return performance.now();
}

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlay);
}

function hideOverlay(): void {
  hideOverlayEl(overlay);
}

function getRemainingMs(): number {
  if (state === 'playing') return Math.max(0, endTimeMs - nowMs());
  return remainingMs;
}

function updateHud(): void {
  const ms = getRemainingMs();
  timeEl.textContent = (ms / 1000).toFixed(1);
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
}

function commitBest(): void {
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
}

// --- Round generation -------------------------------------------------------

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateRound(): Round {
  const needCount = randInt(2, 4);
  const needs: number[] = [];
  for (let i = 0; i < needCount; i++) {
    needs.push(randInt(5, 22));
  }
  const slack = randInt(0, 3);
  const plankCm = needs.reduce((a, b) => a + b, 0) + KERF_CM * (needCount - 1) + slack;
  return { plankCm, needs, cuts: [], resolved: null };
}

// --- Cut handling -----------------------------------------------------------

function plankPxStart(): number {
  return PLANK_PX_INSET;
}
function plankPxWidth(): number {
  return canvas.width - PLANK_PX_INSET * 2;
}
function cmPerPx(): number {
  return round.plankCm / plankPxWidth();
}
function pxPerCm(): number {
  return plankPxWidth() / round.plankCm;
}
function cmFromPx(px: number): number {
  return (px - plankPxStart()) * cmPerPx();
}
function pxFromCm(cm: number): number {
  return plankPxStart() + cm * pxPerCm();
}

function nearestCutAt(cm: number): number | null {
  let bestIdx = -1;
  let bestDist = Infinity;
  for (let i = 0; i < round.cuts.length; i++) {
    const d = Math.abs(round.cuts[i]! - cm);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  if (bestIdx >= 0 && bestDist <= 0.6) return bestIdx;
  return null;
}

function flash(msg: string, ms: number): void {
  lastFlashMsg = msg;
  lastFlashUntil = nowMs() + ms;
}

function addCut(cm: number): void {
  const snapped = Math.round(cm);
  if (snapped <= 0 || snapped >= round.plankCm) {
    flash('Tahta sınırlarının dışı', 600);
    return;
  }
  for (const c of round.cuts) {
    if (Math.abs(snapped - c) < KERF_CM + 0.5) {
      flash('Bu noktada zaten kesim var', 600);
      return;
    }
  }
  round.cuts.push(snapped);
  round.cuts.sort((a, b) => a - b);
}

function removeCutAt(idx: number): void {
  round.cuts.splice(idx, 1);
}

// --- Submit / scoring -------------------------------------------------------

function resolveCuts(): ResolvedSegment[] {
  const segments: ResolvedSegment[] = [];
  let prev = 0;
  for (const c of round.cuts) {
    segments.push({ start: prev, length: c - prev, matchedNeedIndex: null, kind: 'piece' });
    segments.push({ start: c, length: KERF_CM, matchedNeedIndex: null, kind: 'kerf' });
    prev = c + KERF_CM;
  }
  segments.push({ start: prev, length: round.plankCm - prev, matchedNeedIndex: null, kind: 'piece' });

  const needs = round.needs.slice();
  const taken = new Array(needs.length).fill(false);
  // Sort piece indexes by length DESC so duplicates resolve deterministically.
  const pieceIndexes = segments
    .map((s, i) => ({ s, i }))
    .filter((x) => x.s.kind === 'piece')
    .sort((a, b) => b.s.length - a.s.length);
  for (const { s, i } of pieceIndexes) {
    for (let n = 0; n < needs.length; n++) {
      if (taken[n]) continue;
      if (Math.abs(s.length - needs[n]!) <= TOLERANCE_CM) {
        taken[n] = true;
        segments[i] = { ...s, matchedNeedIndex: n };
        break;
      }
    }
  }
  return segments;
}

function scoreSegments(segments: ResolvedSegment[]): {
  delta: number;
  matched: number;
  missed: number;
  wasteCm: number;
} {
  let matched = 0;
  let wasteCm = 0;
  for (const s of segments) {
    if (s.kind === 'kerf') {
      wasteCm += s.length;
      continue;
    }
    if (s.matchedNeedIndex !== null) matched += 1;
    else wasteCm += s.length;
  }
  const missed = round.needs.length - matched;
  const delta =
    matched * MATCH_BONUS - missed * MISS_PENALTY - wasteCm * WASTE_PENALTY;
  return { delta, matched, missed, wasteCm };
}

function submitRound(): void {
  if (state !== 'playing') return;
  if (round.resolved !== null) return;
  const segments = resolveCuts();
  const { delta, matched, missed, wasteCm } = scoreSegments(segments);
  score += delta;
  round.resolved = segments;
  resolvedUntilMs = nowMs() + RESOLVED_HOLD_MS;
  const parts: string[] = [];
  if (matched > 0) parts.push(`+${matched * MATCH_BONUS}`);
  if (missed > 0) parts.push(`-${missed * MISS_PENALTY} eksik`);
  if (wasteCm > 0) parts.push(`-${wasteCm} cm atık`);
  flash(parts.length > 0 ? parts.join(' · ') : 'Boş tahta', RESOLVED_HOLD_MS);
  commitBest();
}

function nextRound(): void {
  round = generateRound();
}

// --- State transitions ------------------------------------------------------

function reset(): void {
  const token = gen.bump();
  commitBest();
  state = 'ready';
  score = 0;
  remainingMs = GAME_DURATION_MS;
  endTimeMs = 0;
  resolvedUntilMs = 0;
  lastFlashUntil = 0;
  round = generateRound();
  showOverlay(READY_TITLE, READY_MSG);
  updateHud();
  draw();
  requestAnimationFrame(() => loop(token));
}

function startPlaying(): void {
  state = 'playing';
  endTimeMs = nowMs() + remainingMs;
  hideOverlay();
}

function endGame(): void {
  remainingMs = 0;
  state = 'gameover';
  commitBest();
  updateHud();
  showOverlay(
    'Süre doldu!',
    `Toplam ${score} puan topladın.\nRekor: ${best}\n\nYeniden başlamak için R, Enter ya da düğmeye bas.`,
  );
  draw();
}

// --- Input ------------------------------------------------------------------

function onBoardPointerDown(e: PointerEvent): void {
  if (state === 'ready') {
    e.preventDefault();
    startPlaying();
    return;
  }
  if (state === 'gameover') {
    e.preventDefault();
    reset();
    return;
  }
  if (round.resolved !== null) return;
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const internalX = ((e.clientX - rect.left) / rect.width) * canvas.width;
  const internalY = ((e.clientY - rect.top) / rect.height) * canvas.height;
  if (internalY < PLANK_Y - 24 || internalY > PLANK_Y + PLANK_H + 24) return;
  const cm = cmFromPx(internalX);
  const idx = nearestCutAt(cm);
  if (idx !== null) {
    removeCutAt(idx);
  } else {
    addCut(cm);
  }
}

function onKeyDown(e: KeyboardEvent): void {
  const key = e.key.toLowerCase();
  if (key === 'r') {
    e.preventDefault();
    reset();
    return;
  }
  if (key === 'enter') {
    e.preventDefault();
    if (state === 'gameover') {
      reset();
      return;
    }
    if (state === 'playing' && round.resolved === null) submitRound();
    return;
  }
  if (key === ' ') {
    e.preventDefault();
    if (state === 'ready') {
      startPlaying();
      return;
    }
    if (state === 'playing' && round.resolved === null) submitRound();
  }
}

function onSubmitClick(): void {
  if (state === 'ready') {
    startPlaying();
    return;
  }
  if (state === 'gameover') {
    reset();
    return;
  }
  if (state === 'playing' && round.resolved === null) submitRound();
}

function onClearClick(): void {
  if (state !== 'playing') return;
  if (round.resolved !== null) return;
  round.cuts = [];
}

// --- Drawing ----------------------------------------------------------------

const cssCache = new Map<string, string>();
function getCss(varName: string): string {
  const cached = cssCache.get(varName);
  if (cached !== undefined) return cached;
  const val = getComputedStyle(document.documentElement)
    .getPropertyValue(varName)
    .trim();
  cssCache.set(varName, val);
  return val;
}

function drawNeedsRow(): void {
  const totalCm = round.needs.reduce((a, b) => a + b, 0);
  const rowX0 = 60;
  const rowX1 = canvas.width - 60;
  const rowW = rowX1 - rowX0;
  const gap = 10;
  const totalGap = gap * Math.max(0, round.needs.length - 1);
  const drawableW = rowW - totalGap;
  const scale = totalCm > 0 ? drawableW / totalCm : 0;

  ctx.fillStyle = getCss('--text-dim') || '#8a8f9c';
  ctx.font = 'bold 13px sans-serif';
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillText('İSTENEN PARÇALAR', rowX0, PIECE_Y - 14);

  const matchedSet = new Set<number>();
  if (round.resolved !== null) {
    for (const s of round.resolved) {
      if (s.matchedNeedIndex !== null) matchedSet.add(s.matchedNeedIndex);
    }
  }

  let x = rowX0;
  for (let i = 0; i < round.needs.length; i++) {
    const need = round.needs[i]!;
    const w = Math.max(38, need * scale);
    const isMatched = matchedSet.has(i);
    const isMissed = round.resolved !== null && !isMatched;
    if (isMatched) {
      ctx.fillStyle = 'rgba(95, 185, 107, 0.9)';
    } else if (isMissed) {
      ctx.fillStyle = 'rgba(226, 58, 58, 0.85)';
    } else {
      ctx.fillStyle = '#c19a6b';
    }
    roundRect(ctx, x, PIECE_Y, w, PIECE_H, 8);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.fillRect(x + 6, PIECE_Y + 6, w - 12, 4);
    ctx.fillStyle = '#1a1a1a';
    ctx.font = 'bold 20px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${need}`, x + w / 2, PIECE_Y + PIECE_H / 2 - 4);
    ctx.font = 'bold 10px sans-serif';
    ctx.fillText('cm', x + w / 2, PIECE_Y + PIECE_H / 2 + 14);
    x += w + gap;
  }
}

function drawPlank(): void {
  const x0 = plankPxStart();
  const x1 = x0 + plankPxWidth();
  const y0 = PLANK_Y;
  const y1 = y0 + PLANK_H;
  const ppc = pxPerCm();

  if (round.resolved !== null) {
    for (const s of round.resolved) {
      const sx = pxFromCm(s.start);
      const sw = s.length * ppc;
      if (s.kind === 'kerf') {
        ctx.fillStyle = '#1c1310';
        ctx.fillRect(sx, y0, sw, PLANK_H);
      } else if (s.matchedNeedIndex !== null) {
        ctx.fillStyle = '#5fb96b';
        roundRect(ctx, sx + 1, y0 + 4, Math.max(2, sw - 2), PLANK_H - 8, 4);
        ctx.fill();
        ctx.fillStyle = '#0a2a0e';
        ctx.font = 'bold 14px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        if (sw > 18) {
          ctx.fillText(`${Math.round(s.length)}`, sx + sw / 2, y0 + PLANK_H / 2);
        }
      } else {
        ctx.fillStyle = '#7a4a2a';
        roundRect(ctx, sx + 1, y0 + 4, Math.max(2, sw - 2), PLANK_H - 8, 4);
        ctx.fill();
        ctx.fillStyle = '#1a1a1a';
        ctx.font = 'bold 13px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        if (sw > 18) {
          ctx.fillText(`${Math.round(s.length)}`, sx + sw / 2, y0 + PLANK_H / 2);
        }
      }
    }
  } else {
    ctx.fillStyle = '#c19a6b';
    roundRect(ctx, x0, y0, x1 - x0, PLANK_H, 6);
    ctx.fill();
    ctx.strokeStyle = 'rgba(120, 80, 40, 0.35)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 5; i++) {
      const yy = y0 + (PLANK_H * i) / 5;
      ctx.beginPath();
      ctx.moveTo(x0 + 6, yy);
      ctx.lineTo(x1 - 6, yy);
      ctx.stroke();
    }

    // Live highlight: segments whose length matches an unmatched need.
    let prev = 0;
    const segs: { start: number; length: number }[] = [];
    for (const c of round.cuts) {
      segs.push({ start: prev, length: c - prev });
      prev = c + KERF_CM;
    }
    segs.push({ start: prev, length: round.plankCm - prev });

    const needsAvail = round.needs.slice();
    for (const seg of segs.slice().sort((a, b) => b.length - a.length)) {
      for (let n = 0; n < needsAvail.length; n++) {
        if (needsAvail[n] === seg.length) {
          const sx = pxFromCm(seg.start);
          const sw = seg.length * ppc;
          ctx.fillStyle = 'rgba(95, 185, 107, 0.55)';
          ctx.fillRect(sx + 1, y0 + 4, Math.max(2, sw - 2), PLANK_H - 8);
          needsAvail[n] = -1;
          break;
        }
      }
    }

    for (const c of round.cuts) {
      const sx = pxFromCm(c);
      const sw = KERF_CM * ppc;
      ctx.fillStyle = '#15171b';
      ctx.fillRect(sx, y0, Math.max(2, sw), PLANK_H);
      ctx.fillStyle = '#cfd6dc';
      ctx.beginPath();
      const cx = sx + Math.max(2, sw) / 2;
      ctx.moveTo(cx - 6, y0 - 14);
      ctx.lineTo(cx + 6, y0 - 14);
      ctx.lineTo(cx, y0);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#a47b4a';
      ctx.fillRect(sx - 3, y1, Math.max(2, sw) + 6, 3);
    }

    ctx.fillStyle = '#1a1a1a';
    ctx.font = 'bold 14px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const seg of segs) {
      const sx = pxFromCm(seg.start);
      const sw = seg.length * ppc;
      if (sw < 18) continue;
      ctx.fillText(`${Math.round(seg.length)}`, sx + sw / 2, y0 + PLANK_H / 2);
    }
  }

  ctx.strokeStyle = '#3a2a1a';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.rect(x0, y0, x1 - x0, PLANK_H);
  ctx.stroke();

  ctx.strokeStyle = getCss('--text-dim') || '#8a8f9c';
  ctx.lineWidth = 1;
  ctx.fillStyle = getCss('--text-dim') || '#8a8f9c';
  ctx.font = '11px sans-serif';
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'center';
  const rulerY = y0 - 30;
  for (let cm = 0; cm <= round.plankCm; cm++) {
    const px = pxFromCm(cm);
    const big = cm % 5 === 0;
    ctx.beginPath();
    ctx.moveTo(px, rulerY);
    ctx.lineTo(px, rulerY + (big ? 10 : 5));
    ctx.stroke();
    if (big) {
      ctx.fillText(`${cm}`, px, rulerY - 3);
    }
  }

  ctx.fillStyle = getCss('--text') || '#f0f1f5';
  ctx.font = 'bold 12px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(`Tahta: ${round.plankCm} cm`, x0, y1 + 28);
  ctx.textAlign = 'right';
  ctx.fillStyle = getCss('--text-dim') || '#8a8f9c';
  ctx.fillText(`Testere kerfi: ${KERF_CM} cm`, x1, y1 + 28);
}

function drawHint(): void {
  ctx.fillStyle = getCss('--text-dim') || '#8a8f9c';
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const y = canvas.height - 32;
  let msg = 'Tahtaya tıkla → kesim. Kesim çizgisine tıkla → sil. Boşluk: Kes.';
  const now = nowMs();
  if (now < lastFlashUntil && lastFlashMsg) {
    ctx.fillStyle = '#e6cf94';
    ctx.font = 'bold 13px sans-serif';
    msg = lastFlashMsg;
  }
  ctx.fillText(msg, canvas.width / 2, y);
}

function roundRect(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  c.beginPath();
  c.moveTo(x + r, y);
  c.lineTo(x + w - r, y);
  c.quadraticCurveTo(x + w, y, x + w, y + r);
  c.lineTo(x + w, y + h - r);
  c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  c.lineTo(x + r, y + h);
  c.quadraticCurveTo(x, y + h, x, y + h - r);
  c.lineTo(x, y + r);
  c.quadraticCurveTo(x, y, x + r, y);
  c.closePath();
}

function draw(): void {
  ctx.fillStyle = getCss('--surface') || '#15171b';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#1c1f25';
  ctx.fillRect(0, PLANK_Y - 50, canvas.width, PLANK_H + 100);

  drawNeedsRow();
  drawPlank();
  drawHint();
}

// --- Loop -------------------------------------------------------------------

function loop(token: number): void {
  if (token !== gen.current()) return;
  if (state === 'playing') {
    if (nowMs() >= endTimeMs) {
      endGame();
    } else if (round.resolved !== null && nowMs() >= resolvedUntilMs) {
      nextRound();
    }
  }
  updateHud();
  draw();
  requestAnimationFrame(() => loop(token));
}

// --- Boot -------------------------------------------------------------------

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  timeEl = document.querySelector<HTMLElement>('#time')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  submitBtn = document.querySelector<HTMLButtonElement>('#submit')!;
  clearBtn = document.querySelector<HTMLButtonElement>('#clear')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  canvas.addEventListener('pointerdown', onBoardPointerDown);
  overlay.addEventListener('pointerdown', (e) => {
    if (state === 'ready') {
      e.preventDefault();
      startPlaying();
    } else if (state === 'gameover') {
      e.preventDefault();
      reset();
    }
  });
  window.addEventListener('keydown', onKeyDown);
  restartBtn.addEventListener('click', reset);
  submitBtn.addEventListener('click', onSubmitClick);
  clearBtn.addEventListener('click', onClearClick);

  reset();
}

export const game = defineGame({ init, reset });
