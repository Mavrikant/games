import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay, hideOverlay } from '@shared/overlay';
import { reportGameOver } from '@shared/leaderboard';

// Akşam Çiçeği — Evening primrose timing/observation.
// Mekanik: 4×3 ızgaradaki 12 çiçek farklı periyotlarda
// bud → opening → OPEN → closing → bud döngüsü yaşıyor.
// Sadece "OPEN" penceresinde tıklamak +3 puan; opening/closing tıklaması −1,
// bud tıklaması −2 ceza (skor 0'ın altına inmez). Süre 60 sn.
//
// Pitfall önlemleri:
//   - module-level-dom-access: tüm DOM/storage erişimi init()'te (defineGame).
//   - unguarded-storage: safeRead/safeWrite kullanılır.
//   - stale-async-callback: RAF zinciri gen-token ile bağlıdır; reset/startRun
//     gen'i bump eder, eski callback'ler isCurrent'ı kaybedip biter.
//   - overlay-input-leak: state enum (`ready | playing | gameover`); canvas
//     click handler ve klavye state guard'lı.
//   - invisible-boot: reset() ilk frame'de bahçeyi çizer; ready ekranı
//     hareketli çiçekleri arkaplanda gösterir (overlay üzerinde "Başla").
//   - missing-overlay-css: CSS'te `.overlay--hidden { opacity:0 }` mevcut.
//   - visual-vs-hitbox: çiçek merkezi (cellCenter) hem çizimde hem hit-test'te
//     aynı; faz eşikleri (PH_*) tek const bloğunda — petalScale ve phaseState
//     ortak constants kullanır.
//   - hud-counter-synced-only-at-lifecycle-edges: setScore her mutasyonda DOM'u
//     anında günceller.
//   - designed-lose-condition-not-wired: süre 0 → endRun → reportGameOver.

const GRID_COLS = 4;
const GRID_ROWS = 3;
const FLOWER_COUNT = GRID_COLS * GRID_ROWS;
const GAME_DURATION_MS = 60_000;
const CYCLE_MIN_MS = 1800;
const CYCLE_MAX_MS = 3600;
const HIT_RADIUS_PX = 62;
const STORAGE_BEST = 'aksam-cicegi.best';

const SCORE_HIT = 3;
const SCORE_NEAR = -1;
const SCORE_FAR = -2;
const FEEDBACK_MS = 520;

// Phase boundaries — shared between draw (petalScaleOf) and click (phaseStateOf)
// so görsel ve hitbox eşik konumları asla ayrı sayılardan beslenmez.
const PH_OPEN_START = 0.30; // bud → opening
const PH_OPEN_FULL = 0.42; // opening → open
const PH_CLOSE_START = 0.58; // open → closing
const PH_CLOSE_END = 0.70; // closing → bud
const PETAL_MIN_SCALE = 0.18;

const CANVAS_CSS_W = 640;
const CANVAS_CSS_H = 480;

const SCORE_DESC = {
  gameId: 'aksam-cicegi',
  storageKey: STORAGE_BEST,
  direction: 'higher' as const,
};

// Fixed palette per cell so visuals are stable & distinguishable.
const FLOWER_HUES = [320, 280, 50, 0, 290, 18, 330, 200, 270, 35, 310, 295];

type GameState = 'ready' | 'playing' | 'gameover';
type FlowerPhase = 'bud' | 'opening' | 'open' | 'closing';

interface Flower {
  cycleMs: number;
  startMs: number;
}

interface Feedback {
  idx: number;
  kind: 'hit' | 'near' | 'far';
  startMs: number;
}

const gen = createGenToken();

// --- DOM refs ---
let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let timeBarEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlayEl!: HTMLElement;
let overlayTitleEl!: HTMLElement;
let overlayMsgEl!: HTMLElement;
let overlayBtn!: HTMLButtonElement;

// --- State ---
let state: GameState = 'ready';
let score = 0;
let best = 0;
let runEndMs = 0;
let cssWidth = CANVAS_CSS_W;
let cssHeight = CANVAS_CSS_H;
let dpr = 1;
const flowers: Flower[] = [];
let feedbacks: Feedback[] = [];

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function makeFlower(now: number, fresh = false): Flower {
  const cycleMs = rand(CYCLE_MIN_MS, CYCLE_MAX_MS);
  // Fresh (just harvested) → bud'dan başla; ilk doluşta fazları stagger et ki
  // bahçe ünison açmasın.
  const phaseOffsetMs = fresh ? 0 : rand(0, cycleMs);
  return {
    cycleMs,
    startMs: now - phaseOffsetMs,
  };
}

function buildFlowers(now: number): void {
  flowers.length = 0;
  for (let i = 0; i < FLOWER_COUNT; i++) flowers.push(makeFlower(now));
}

function phaseOf(f: Flower, now: number): number {
  let t = (now - f.startMs) % f.cycleMs;
  if (t < 0) t += f.cycleMs;
  return t / f.cycleMs;
}

function phaseStateOf(p: number): FlowerPhase {
  if (p < PH_OPEN_START) return 'bud';
  if (p < PH_OPEN_FULL) return 'opening';
  if (p < PH_CLOSE_START) return 'open';
  if (p < PH_CLOSE_END) return 'closing';
  return 'bud';
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}
function easeInCubic(t: number): number {
  return t * t * t;
}

function petalScaleOf(p: number): number {
  if (p < PH_OPEN_START) return PETAL_MIN_SCALE;
  if (p < PH_OPEN_FULL) {
    const t = (p - PH_OPEN_START) / (PH_OPEN_FULL - PH_OPEN_START);
    return PETAL_MIN_SCALE + (1 - PETAL_MIN_SCALE) * easeOutCubic(t);
  }
  if (p < PH_CLOSE_START) return 1.0;
  if (p < PH_CLOSE_END) {
    const t = (p - PH_CLOSE_START) / (PH_CLOSE_END - PH_CLOSE_START);
    return 1.0 - (1 - PETAL_MIN_SCALE) * easeInCubic(t);
  }
  return PETAL_MIN_SCALE;
}

interface CellGeom {
  x: number;
  y: number;
  cellW: number;
  cellH: number;
}

function cellCenter(idx: number): CellGeom {
  const col = idx % GRID_COLS;
  const row = Math.floor(idx / GRID_COLS);
  const cellW = cssWidth / GRID_COLS;
  const cellH = cssHeight / GRID_ROWS;
  return {
    x: col * cellW + cellW / 2,
    y: row * cellH + cellH * 0.42, // sap yer bırakmak için merkezi yukarı kaydır
    cellW,
    cellH,
  };
}

function pickFlowerAt(x: number, y: number): number {
  let bestIdx = -1;
  let bestDist = HIT_RADIUS_PX;
  for (let i = 0; i < FLOWER_COUNT; i++) {
    const c = cellCenter(i);
    const d = Math.hypot(x - c.x, y - c.y);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}

function setScore(n: number): void {
  score = Math.max(0, n);
  scoreEl.textContent = String(score);
}

function setBest(n: number): void {
  best = Math.max(0, Math.floor(n));
  bestEl.textContent = String(best);
}

function loadBest(): void {
  const raw = safeRead<number>(STORAGE_BEST, 0);
  setBest(Number.isFinite(raw) && raw >= 0 ? raw : 0);
}

function startRun(): void {
  gen.bump();
  state = 'playing';
  setScore(0);
  const now = performance.now();
  runEndMs = now + GAME_DURATION_MS;
  buildFlowers(now);
  feedbacks = [];
  hideOverlay(overlayEl);
  scheduleFrame();
}

function endRun(): void {
  if (state !== 'playing') return;
  state = 'gameover';
  const newBest = score > best;
  if (newBest) {
    setBest(score);
    safeWrite(STORAGE_BEST, best);
  }
  reportGameOver(SCORE_DESC, score, { label: 'Skor' });
  showGameOverOverlay(newBest);
  // Keep the ambient render running while the overlay is up so the garden
  // continues to breathe behind the modal.
  scheduleFrame();
}

function showGameOverOverlay(newBest: boolean): void {
  overlayTitleEl.textContent = 'Bahçe kapandı';
  overlayMsgEl.innerHTML =
    `Topladığın çiçek: <strong>${score}</strong>` +
    (newBest && score > 0 ? ' · <em>yeni rekor!</em>' : '') +
    '<br><span class="muted">Tekrar dene — her bahçe farklı ritimde açar.</span>';
  overlayBtn.textContent = 'Tekrar oyna';
  showOverlay(overlayEl);
}

function showReadyOverlay(): void {
  overlayTitleEl.textContent = 'Akşam Çiçeği';
  overlayMsgEl.innerHTML =
    'Çiçekler kendi ritimlerinde açıp kapanıyor. Sadece ' +
    '<strong>tam açıkken</strong> tıkla.<br>' +
    '<span class="muted">+3 tam açık · −1 yarı açık · −2 tomurcuk · 60 saniye</span>';
  overlayBtn.textContent = 'Başla';
  showOverlay(overlayEl);
}

function reset(): void {
  gen.bump();
  state = 'ready';
  setScore(0);
  const now = performance.now();
  buildFlowers(now);
  feedbacks = [];
  if (timeBarEl) timeBarEl.style.width = '100%';
  showReadyOverlay();
  scheduleFrame();
}

function handleClick(ev: MouseEvent | TouchEvent): void {
  if (state !== 'playing') return;
  const rect = canvas.getBoundingClientRect();
  let clientX: number;
  let clientY: number;
  if ('touches' in ev) {
    if (ev.changedTouches.length === 0) return;
    clientX = ev.changedTouches[0]!.clientX;
    clientY = ev.changedTouches[0]!.clientY;
    ev.preventDefault();
  } else {
    clientX = ev.clientX;
    clientY = ev.clientY;
  }
  const x = (clientX - rect.left) * (cssWidth / rect.width);
  const y = (clientY - rect.top) * (cssHeight / rect.height);
  const idx = pickFlowerAt(x, y);
  if (idx < 0) return;
  const now = performance.now();
  const f = flowers[idx]!;
  const ps = phaseStateOf(phaseOf(f, now));
  if (ps === 'open') {
    setScore(score + SCORE_HIT);
    feedbacks.push({ idx, kind: 'hit', startMs: now });
    flowers[idx] = makeFlower(now, true);
  } else if (ps === 'opening' || ps === 'closing') {
    setScore(score + SCORE_NEAR);
    feedbacks.push({ idx, kind: 'near', startMs: now });
  } else {
    setScore(score + SCORE_FAR);
    feedbacks.push({ idx, kind: 'far', startMs: now });
  }
}

// --- Render ---

function resizeCanvas(): void {
  const rect = canvas.getBoundingClientRect();
  cssWidth = rect.width > 0 ? rect.width : CANVAS_CSS_W;
  cssHeight = rect.height > 0 ? rect.height : CANVAS_CSS_H;
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(cssHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function drawBackground(): void {
  const g = ctx.createLinearGradient(0, 0, 0, cssHeight);
  g.addColorStop(0, '#0a0e1d');
  g.addColorStop(0.55, '#1c1239');
  g.addColorStop(1, '#2b1740');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, cssWidth, cssHeight);
  // Soft moon glow top-right
  const mg = ctx.createRadialGradient(
    cssWidth * 0.82,
    cssHeight * 0.18,
    4,
    cssWidth * 0.82,
    cssHeight * 0.18,
    cssWidth * 0.45,
  );
  mg.addColorStop(0, 'rgba(255, 240, 210, 0.32)');
  mg.addColorStop(1, 'rgba(255, 240, 210, 0)');
  ctx.fillStyle = mg;
  ctx.fillRect(0, 0, cssWidth, cssHeight);
  // Stars (deterministic, low density)
  ctx.fillStyle = 'rgba(255,240,200,0.45)';
  for (let i = 0; i < 28; i++) {
    const x = (((i * 91 + 17) % 1000) / 1000) * cssWidth;
    const y = (((i * 37 + 5) % 1000) / 1000) * (cssHeight * 0.45);
    const r = 0.5 + ((i * 13) % 7) / 12;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawFlower(idx: number, now: number): void {
  const f = flowers[idx]!;
  const p = phaseOf(f, now);
  const scale = petalScaleOf(p);
  const ps = phaseStateOf(p);
  const c = cellCenter(idx);
  const hue = FLOWER_HUES[idx % FLOWER_HUES.length]!;
  const baseR = Math.min(c.cellW, c.cellH) * 0.30;
  const headR = baseR * scale;

  // Stem + leaves
  const stemTopY = c.y + headR * 0.35;
  const stemBaseY = c.y + c.cellH * 0.42;
  if (stemBaseY > stemTopY) {
    ctx.strokeStyle = 'rgba(60, 120, 80, 0.85)';
    ctx.lineWidth = 2.6;
    ctx.beginPath();
    ctx.moveTo(c.x, stemTopY);
    ctx.lineTo(c.x, stemBaseY);
    ctx.stroke();
    ctx.fillStyle = 'rgba(70, 140, 90, 0.85)';
    const leafY = c.y + c.cellH * 0.22;
    for (const dir of [-1, 1] as const) {
      ctx.save();
      ctx.translate(c.x, leafY);
      ctx.rotate(dir * 0.5);
      ctx.beginPath();
      ctx.ellipse(dir * 8, 0, 9, 4, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  // Halo when open
  if (ps === 'open') {
    const halo = ctx.createRadialGradient(c.x, c.y, headR * 0.35, c.x, c.y, headR * 2.4);
    halo.addColorStop(0, `hsla(${hue}, 80%, 75%, 0.32)`);
    halo.addColorStop(1, `hsla(${hue}, 80%, 60%, 0)`);
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(c.x, c.y, headR * 2.4, 0, Math.PI * 2);
    ctx.fill();
  }

  // Petals — 5 around center
  const petalCount = 5;
  const petalLen = headR;
  const petalWid = headR * 0.62;
  for (let i = 0; i < petalCount; i++) {
    const ang = (Math.PI * 2 * i) / petalCount - Math.PI / 2;
    const ox = c.x + Math.cos(ang) * headR * 0.32;
    const oy = c.y + Math.sin(ang) * headR * 0.32;
    ctx.save();
    ctx.translate(ox, oy);
    ctx.rotate(ang);
    const grad = ctx.createRadialGradient(0, 0, petalLen * 0.1, 0, 0, petalLen * 0.6);
    grad.addColorStop(0, `hsla(${hue}, 75%, 82%, 0.96)`);
    grad.addColorStop(1, `hsla(${hue}, 70%, 50%, 0.92)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.ellipse(petalLen * 0.42, 0, petalLen * 0.55, petalWid * 0.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Bud center vs stamen
  if (ps === 'bud') {
    ctx.fillStyle = `hsla(110, 30%, 35%, 1)`;
    ctx.beginPath();
    ctx.arc(c.x, c.y, Math.max(4, headR * 0.85), 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `hsla(110, 35%, 50%, 0.9)`;
    ctx.beginPath();
    ctx.ellipse(
      c.x,
      c.y - 1,
      Math.max(2.4, headR * 0.45),
      Math.max(1.5, headR * 0.25),
      0,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  } else {
    ctx.fillStyle = ps === 'open' ? `hsla(48, 95%, 70%, 1)` : `hsla(${hue}, 60%, 55%, 1)`;
    ctx.beginPath();
    ctx.arc(c.x, c.y, headR * 0.34, 0, Math.PI * 2);
    ctx.fill();
    if (ps === 'open') {
      ctx.fillStyle = 'rgba(255,240,180,0.7)';
      ctx.beginPath();
      ctx.arc(c.x, c.y - headR * 0.06, headR * 0.16, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawFeedbacks(now: number): void {
  feedbacks = feedbacks.filter((fb) => now - fb.startMs < FEEDBACK_MS);
  for (const fb of feedbacks) {
    const t = (now - fb.startMs) / FEEDBACK_MS;
    const c = cellCenter(fb.idx);
    const alpha = 1 - t;
    ctx.textAlign = 'center';
    ctx.font = '700 16px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    if (fb.kind === 'hit') {
      ctx.strokeStyle = `rgba(120, 230, 140, ${alpha})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(c.x, c.y, 24 + t * 36, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = `rgba(150, 240, 160, ${alpha})`;
      ctx.fillText('+3', c.x, c.y - 44 - t * 22);
    } else if (fb.kind === 'near') {
      ctx.fillStyle = `rgba(245, 220, 110, ${alpha})`;
      ctx.fillText('−1', c.x, c.y - 40 - t * 20);
    } else {
      ctx.fillStyle = `rgba(240, 130, 140, ${alpha})`;
      ctx.fillText('−2', c.x, c.y - 40 - t * 20);
    }
  }
}

function renderFrame(): void {
  const now = performance.now();
  drawBackground();
  for (let i = 0; i < FLOWER_COUNT; i++) drawFlower(i, now);
  drawFeedbacks(now);
}

function updateTimer(): void {
  if (state !== 'playing') return;
  const now = performance.now();
  const remaining = Math.max(0, runEndMs - now);
  const pct = (remaining / GAME_DURATION_MS) * 100;
  timeBarEl.style.width = `${pct}%`;
  if (remaining <= 0) endRun();
}

function scheduleFrame(): void {
  const myGen = gen.current();
  const loop = (): void => {
    if (!gen.isCurrent(myGen)) return;
    updateTimer();
    renderFrame();
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'r' || e.key === 'R') {
    if (state === 'playing') startRun();
    else reset();
  } else if (e.key === ' ' || e.key === 'Enter') {
    if (state === 'ready' || state === 'gameover') {
      e.preventDefault();
      startRun();
    }
  }
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  timeBarEl = document.querySelector<HTMLElement>('#timebar-fill')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlayEl = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitleEl = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsgEl = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;

  loadBest();
  resizeCanvas();

  canvas.addEventListener('click', handleClick);
  canvas.addEventListener('touchend', handleClick, { passive: false });
  overlayBtn.addEventListener('click', startRun);
  restartBtn.addEventListener('click', () => {
    if (state === 'playing') startRun();
    else reset();
  });
  window.addEventListener('keydown', onKey);
  window.addEventListener('resize', () => {
    resizeCanvas();
  });

  reset();
}

export const game = defineGame({ init, reset });
