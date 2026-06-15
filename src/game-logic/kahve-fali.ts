import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOv, hideOverlay as hideOv } from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';

type State = 'ready' | 'playing' | 'reveal' | 'gameover';
type SymbolKey = 'kus' | 'balik' | 'yilan' | 'kalp' | 'anahtar' | 'ay';

const STORAGE_BEST = 'kahve-fali.best';
const ROUND_MS = 90_000;
const STAINS_PER_CUP = 4;
const REVEAL_MS = 1500;
const HIT_RADIUS = 40;

const W = 360;
const H = 360;
const CUP_CX = W / 2;
const CUP_CY = H / 2 - 4;
const CUP_R = 150;

const SYMBOL_KEYS: SymbolKey[] = ['kus', 'balik', 'yilan', 'kalp', 'anahtar', 'ay'];
const SYMBOL_LABELS: Record<SymbolKey, string> = {
  kus: 'Kuş',
  balik: 'Balık',
  yilan: 'Yılan',
  kalp: 'Kalp',
  anahtar: 'Anahtar',
  ay: 'Ay',
};

interface Stain {
  symbol: SymbolKey;
  cx: number;
  cy: number;
  scale: number;
  rotation: number;
  guess: SymbolKey | null;
}

const gen = createGenToken();
let state: State = 'ready';
let score = 0;
let best = 0;
let cupNum = 0;
let timeLeftMs = ROUND_MS;
let lastTick = 0;
let timerId: ReturnType<typeof setInterval> | null = null;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let timeEl!: HTMLElement;
let cupEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayBtn!: HTMLButtonElement;
const symbolBtns: Partial<Record<SymbolKey, HTMLButtonElement>> = {};

let stains: Stain[] = [];
let selectedIdx = -1;

const cssCache = new Map<string, string>();
function getCss(name: string, fallback: string): string {
  const v = cssCache.get(name);
  if (v !== undefined) return v || fallback;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  cssCache.set(name, raw);
  return raw || fallback;
}

function setScore(v: number): void {
  score = v;
  scoreEl.textContent = String(score);
}

function setBest(v: number): void {
  best = v;
  bestEl.textContent = String(best);
}

function setTime(ms: number): void {
  timeLeftMs = Math.max(0, ms);
  timeEl.textContent = String(Math.ceil(timeLeftMs / 1000));
}

function setCupNum(n: number): void {
  cupNum = n;
  cupEl.textContent = String(n);
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

function makeStains(): Stain[] {
  const slots = [
    { x: -62, y: -54 },
    { x: 60, y: -54 },
    { x: -62, y: 58 },
    { x: 60, y: 58 },
  ];
  shuffle(slots);
  const pool = shuffle([...SYMBOL_KEYS]).slice(0, STAINS_PER_CUP);
  const out: Stain[] = [];
  for (let i = 0; i < STAINS_PER_CUP; i++) {
    const slot = slots[i]!;
    const sym = pool[i]!;
    const jx = (Math.random() - 0.5) * 14;
    const jy = (Math.random() - 0.5) * 14;
    out.push({
      symbol: sym,
      cx: CUP_CX + slot.x + jx,
      cy: CUP_CY + slot.y + jy,
      scale: 0.95 + Math.random() * 0.25,
      rotation: (Math.random() - 0.5) * 0.45,
      guess: null,
    });
  }
  return out;
}

function drawCup(): void {
  ctx.clearRect(0, 0, W, H);

  ctx.beginPath();
  ctx.arc(CUP_CX, CUP_CY + 4, CUP_R + 20, 0, Math.PI * 2);
  ctx.fillStyle = '#1a0e07';
  ctx.fill();

  ctx.beginPath();
  ctx.arc(CUP_CX, CUP_CY, CUP_R + 8, 0, Math.PI * 2);
  ctx.fillStyle = '#2a160c';
  ctx.fill();

  const grad = ctx.createRadialGradient(
    CUP_CX - 35,
    CUP_CY - 40,
    8,
    CUP_CX,
    CUP_CY,
    CUP_R + 6,
  );
  grad.addColorStop(0, '#f7e7cc');
  grad.addColorStop(0.7, '#e3c79a');
  grad.addColorStop(1, '#c9a777');
  ctx.beginPath();
  ctx.arc(CUP_CX, CUP_CY, CUP_R, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(CUP_CX, CUP_CY, CUP_R - 2, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(120, 80, 40, 0.35)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function drawSymbolPath(sym: SymbolKey): void {
  switch (sym) {
    case 'kus':
      ctx.beginPath();
      ctx.moveTo(-26, 4);
      ctx.quadraticCurveTo(-18, -14, -6, -4);
      ctx.quadraticCurveTo(-4, 2, 0, 2);
      ctx.quadraticCurveTo(4, 2, 6, -4);
      ctx.quadraticCurveTo(18, -14, 26, 4);
      ctx.quadraticCurveTo(20, -4, 12, -2);
      ctx.quadraticCurveTo(6, 0, 0, 8);
      ctx.quadraticCurveTo(-6, 0, -12, -2);
      ctx.quadraticCurveTo(-20, -4, -26, 4);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.arc(0, 6, 4, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'balik':
      ctx.beginPath();
      ctx.ellipse(-4, 0, 18, 11, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(12, 0);
      ctx.lineTo(28, -10);
      ctx.lineTo(28, 10);
      ctx.closePath();
      ctx.fill();
      break;
    case 'yilan':
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth = 7;
      ctx.beginPath();
      ctx.moveTo(-24, 10);
      ctx.bezierCurveTo(-14, -16, -4, 18, 4, -8);
      ctx.bezierCurveTo(10, -24, 22, -2, 26, 6);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(26, 6, 4.5, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'kalp':
      ctx.beginPath();
      ctx.moveTo(0, 18);
      ctx.bezierCurveTo(-26, 4, -22, -16, -10, -16);
      ctx.bezierCurveTo(-2, -16, 0, -8, 0, -6);
      ctx.bezierCurveTo(0, -8, 2, -16, 10, -16);
      ctx.bezierCurveTo(22, -16, 26, 4, 0, 18);
      ctx.closePath();
      ctx.fill();
      break;
    case 'anahtar':
      ctx.beginPath();
      ctx.arc(-14, 0, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath();
      ctx.arc(-14, 0, 3.8, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      ctx.fillRect(-4, -3, 24, 6);
      ctx.fillRect(14, 3, 4, 7);
      ctx.fillRect(20, 3, 3, 5);
      break;
    case 'ay':
      ctx.beginPath();
      ctx.arc(-2, 0, 18, 0, Math.PI * 2);
      ctx.fill();
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath();
      ctx.arc(4, -3, 15, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      break;
  }
}

function drawStain(stain: Stain, isSelected: boolean, reveal: 'none' | 'ok' | 'no'): void {
  let fill = '#2c1408';
  if (reveal === 'ok') fill = '#0f5132';
  else if (reveal === 'no') fill = '#7c1d1d';

  ctx.save();
  ctx.translate(stain.cx, stain.cy);
  ctx.rotate(stain.rotation);
  ctx.scale(stain.scale, stain.scale);
  ctx.fillStyle = fill;
  ctx.strokeStyle = fill;
  ctx.shadowColor = 'rgba(40, 18, 8, 0.5)';
  ctx.shadowBlur = 6;
  drawSymbolPath(stain.symbol);
  ctx.restore();

  if (isSelected) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(stain.cx, stain.cy, HIT_RADIUS, 0, Math.PI * 2);
    ctx.strokeStyle = getCss('--kf-select', '#f59e0b');
    ctx.lineWidth = 3;
    ctx.setLineDash([6, 4]);
    ctx.stroke();
    ctx.restore();
  }

  if (stain.guess !== null && reveal === 'none') {
    drawLabel(stain.cx, stain.cy + 32, SYMBOL_LABELS[stain.guess], '#fde68a', 'rgba(20, 12, 6, 0.78)');
  }
}

function drawLabel(cx: number, top: number, text: string, color: string, bg: string): void {
  ctx.save();
  ctx.font = '600 12px Inter, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const w = ctx.measureText(text).width + 14;
  const x = cx - w / 2;
  const y = top;
  const r = 8;
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + 20, r);
  ctx.arcTo(x + w, y + 20, x, y + 20, r);
  ctx.arcTo(x, y + 20, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = color;
  ctx.fillText(text, cx, y + 4);
  ctx.restore();
}

function draw(): void {
  drawCup();
  const isRevealing = state === 'reveal';
  for (let i = 0; i < stains.length; i++) {
    const s = stains[i]!;
    let reveal: 'none' | 'ok' | 'no' = 'none';
    if (isRevealing) {
      reveal = s.guess === s.symbol ? 'ok' : 'no';
    }
    drawStain(s, !isRevealing && i === selectedIdx, reveal);
  }
  if (isRevealing) {
    for (const s of stains) {
      const ok = s.guess === s.symbol;
      const text = (ok ? '✓ ' : '✗ ') + SYMBOL_LABELS[s.symbol];
      drawLabel(
        s.cx,
        s.cy + 32,
        text,
        '#ffffff',
        ok ? 'rgba(16, 122, 84, 0.94)' : 'rgba(160, 30, 30, 0.94)',
      );
    }
  }
}

function selectStain(idx: number): void {
  if (state !== 'playing') return;
  if (idx < 0 || idx >= stains.length) return;
  selectedIdx = idx;
  draw();
}

function assignSymbol(sym: SymbolKey): void {
  if (state !== 'playing') return;
  if (selectedIdx < 0 || selectedIdx >= stains.length) {
    const fresh = stains.findIndex((s) => s.guess === null);
    if (fresh < 0) return;
    selectedIdx = fresh;
  }
  const s = stains[selectedIdx]!;
  s.guess = sym;
  const next = stains.findIndex((s2) => s2.guess === null);
  if (next < 0) {
    revealResults();
    return;
  }
  selectedIdx = next;
  draw();
}

function revealResults(): void {
  state = 'reveal';
  selectedIdx = -1;
  let correctCount = 0;
  for (const s of stains) {
    if (s.guess === s.symbol) correctCount++;
  }
  const points = correctCount * 10 + (correctCount === STAINS_PER_CUP ? 20 : 0);
  setScore(score + points);
  draw();

  const tok = gen.current();
  setTimeout(() => {
    if (!gen.isCurrent(tok)) return;
    if (state !== 'reveal') return;
    nextCup();
  }, REVEAL_MS);
}

function nextCup(): void {
  if (state === 'gameover') return;
  setCupNum(cupNum + 1);
  stains = makeStains();
  selectedIdx = 0;
  state = 'playing';
  draw();
}

function startPlaying(): void {
  gen.bump();
  if (timerId !== null) clearInterval(timerId);
  state = 'playing';
  setScore(0);
  setCupNum(1);
  setTime(ROUND_MS);
  stains = makeStains();
  selectedIdx = 0;
  hideOv(overlay);
  draw();
  lastTick = performance.now();
  timerId = setInterval(tick, 100);
}

function tick(): void {
  if (state !== 'playing' && state !== 'reveal') return;
  const now = performance.now();
  const dt = now - lastTick;
  lastTick = now;
  setTime(timeLeftMs - dt);
  if (timeLeftMs <= 0) endGame();
}

function endGame(): void {
  if (state === 'gameover') return;
  state = 'gameover';
  if (timerId !== null) {
    clearInterval(timerId);
    timerId = null;
  }
  gen.bump();
  if (score > best) {
    setBest(score);
    safeWrite(STORAGE_BEST, score);
  }
  overlayTitle.textContent = 'Süre doldu';
  overlayMsg.textContent = `${score} fal puanı, ${cupNum} fincan. Rekor: ${best}. Tekrar için Boşluk veya R.`;
  overlayBtn.textContent = 'Tekrar oyna';
  showOv(overlay);
}

function reset(): void {
  gen.bump();
  if (timerId !== null) {
    clearInterval(timerId);
    timerId = null;
  }
  state = 'ready';
  setScore(0);
  setCupNum(0);
  setTime(ROUND_MS);
  stains = [];
  selectedIdx = -1;
  overlayTitle.textContent = 'Kahve Falı';
  overlayMsg.textContent =
    'Fincanın dibindeki şekilleri tanı. Bir şekle dokun, sonra alttaki sembollerden hangisine benziyorsa seç (1-6 tuşları da çalışır). 90 saniyede en çok fincan oku.';
  overlayBtn.textContent = 'Falı Aç';
  showOv(overlay);
  draw();
}

function canvasPosFromEvent(clientX: number, clientY: number): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((clientX - rect.left) / rect.width) * W,
    y: ((clientY - rect.top) / rect.height) * H,
  };
}

function findStainAt(x: number, y: number): number {
  for (let i = 0; i < stains.length; i++) {
    const s = stains[i]!;
    const dx = x - s.cx;
    const dy = y - s.cy;
    if (dx * dx + dy * dy <= HIT_RADIUS * HIT_RADIUS) return i;
  }
  return -1;
}

function onCanvasPointer(e: PointerEvent): void {
  if (state !== 'playing') return;
  const p = canvasPosFromEvent(e.clientX, e.clientY);
  const idx = findStainAt(p.x, p.y);
  if (idx >= 0) {
    selectStain(idx);
    e.preventDefault();
  }
}

function handleStartIntent(): void {
  if (state === 'ready' || state === 'gameover') startPlaying();
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  timeEl = document.querySelector<HTMLElement>('#time')!;
  cupEl = document.querySelector<HTMLElement>('#cup-num')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-start')!;

  for (const k of SYMBOL_KEYS) {
    const btn = document.querySelector<HTMLButtonElement>(`#sym-${k}`)!;
    symbolBtns[k] = btn;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      assignSymbol(k);
    });
  }

  best = safeRead<number>(STORAGE_BEST, 0);
  setBest(best);

  canvas.addEventListener('pointerdown', onCanvasPointer);

  overlayBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    handleStartIntent();
  });

  restartBtn.addEventListener('click', () => reset());

  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    const k = e.key;
    if (k === ' ' || k === 'Enter') {
      if (state !== 'playing') {
        handleStartIntent();
        e.preventDefault();
      }
      return;
    }
    if (k === 'r' || k === 'R') {
      reset();
      e.preventDefault();
      return;
    }
    if (state !== 'playing') return;
    const n = Number(k);
    if (Number.isInteger(n) && n >= 1 && n <= SYMBOL_KEYS.length) {
      const sym = SYMBOL_KEYS[n - 1]!;
      assignSymbol(sym);
      e.preventDefault();
    }
  });

  reset();
}

export const game = defineGame({ init, reset });
