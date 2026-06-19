import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import {
  showOverlay as showOverlayEl,
  hideOverlay as hideOverlayEl,
  isOverlayHidden,
} from '@shared/overlay';

const STORAGE_BEST = 'torna.best';
const N = 84;
const MAX_R = 92;
const MIN_R = 22;
const BASE_TOL = 9;
const MIN_TOL = 4;
const CUT_PER_SEC = 36;
const CHISEL_HALF = 4;

type State = 'ready' | 'playing' | 'won' | 'lost';

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let roundEl!: HTMLElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let restartBtn!: HTMLButtonElement;

let state: State = 'ready';
const cylinder = new Float32Array(N);
const target = new Float32Array(N);
let chiselIdx = Math.floor(N / 2);
let cutting = false;
let cuttingByKey = false;
let cuttingByPointer = false;
let score = 0;
let best = 0;
let round = 1;
let lastTs = 0;
let grainPhase = 0;
let pulse = 0;

function tolerance(): number {
  return Math.max(MIN_TOL, BASE_TOL - (round - 1) * 0.5);
}

function generateTarget(roundNum: number): void {
  const shape = (roundNum - 1) % 6;
  for (let i = 0; i < N; i++) {
    const x = i / (N - 1);
    let r: number;
    if (shape === 0) {
      // Klasik vazo: geniş alt, dar boyun, hafif üst flare
      const neck = Math.exp(-((x - 0.72) ** 2) / 0.015);
      const topFlare = x > 0.88 ? (x - 0.88) * 80 : 0;
      const baseFlare = x < 0.12 ? (0.12 - x) * 30 : 0;
      r = MAX_R - 16 - 36 * neck + topFlare + baseFlare;
    } else if (shape === 1) {
      // İğ: uçları ince, ortası dolgun
      r = MIN_R + 6 + (MAX_R - MIN_R - 18) * Math.sin(Math.PI * x);
    } else if (shape === 2) {
      // Çoklu bilezik: sinüs dalgaları
      r = MAX_R - 30 + 18 * Math.sin(Math.PI * (x * 2.5 - 0.25));
    } else if (shape === 3) {
      // Konik: hafif daralan
      r = MIN_R + 8 + (MAX_R - MIN_R - 18) * Math.pow(1 - x, 0.7);
    } else if (shape === 4) {
      // Kum saati: uçlar dolgun, orta ince
      const mid = Math.sin(Math.PI * x);
      r = MIN_R + 10 + (MAX_R - MIN_R - 20) * (1 - mid * 0.85);
    } else {
      // Şamdan: dar tabandan iki bilezikli boyun
      const a = Math.exp(-((x - 0.3) ** 2) / 0.012);
      const b = Math.exp(-((x - 0.6) ** 2) / 0.012);
      r = MAX_R - 28 - 18 * (a + b) + (x < 0.1 ? 14 : 0) + (x > 0.92 ? 16 : 0);
    }
    target[i] = Math.max(MIN_R, Math.min(MAX_R - 4, r));
  }
  // Hafif yumuşatma (smooth)
  const smoothed = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const a = target[i - 1] ?? target[i]!;
    const b = target[i]!;
    const c = target[i + 1] ?? target[i]!;
    smoothed[i] = (a + 2 * b + c) / 4;
  }
  for (let i = 0; i < N; i++) target[i] = smoothed[i]!;
}

function classify(i: number): -1 | 0 | 1 {
  const tol = tolerance();
  const diff = cylinder[i]! - target[i]!;
  if (diff > tol) return 0;
  if (diff < -tol) return -1;
  return 1;
}

function checkProgress(): void {
  let allGreen = true;
  for (let i = 0; i < N; i++) {
    const c = classify(i);
    if (c === -1) {
      state = 'lost';
      showOverlayText(
        'Çatladı!',
        `Aşırı oydun, parça hurda oldu.\nSkor: ${score}\nTekrar için tıkla / boşluk / R.`,
      );
      cutting = false;
      cuttingByKey = false;
      cuttingByPointer = false;
      return;
    }
    if (c !== 1) allGreen = false;
  }
  if (allGreen) {
    score += 1;
    if (score > best) {
      best = score;
      safeWrite(STORAGE_BEST, best);
    }
    scoreEl.textContent = String(score);
    bestEl.textContent = String(best);
    state = 'won';
    cutting = false;
    cuttingByKey = false;
    cuttingByPointer = false;
    showOverlayText(
      'Mükemmel!',
      `Tur ${round} tamamlandı.\nToplam skor: ${score}\nSıradaki tur için tıkla / boşluk.`,
    );
  }
}

function showOverlayText(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlay);
}

function hideOverlayText(): void {
  hideOverlayEl(overlay);
}

function reset(): void {
  state = 'ready';
  round = 1;
  score = 0;
  cutting = false;
  cuttingByKey = false;
  cuttingByPointer = false;
  chiselIdx = Math.floor(N / 2);
  for (let i = 0; i < N; i++) cylinder[i] = MAX_R;
  generateTarget(round);
  scoreEl.textContent = '0';
  roundEl.textContent = '1';
  bestEl.textContent = String(best);
  showOverlayText(
    'Torna',
    'Dönen ahşap silindiri keski ile hedef silüete getir.\nMavi çizginin altına inme — aşırı oyma çatlatır.\n\nBaşlamak için tıkla veya boşluğa bas.',
  );
}

function nextRound(): void {
  round += 1;
  cutting = false;
  cuttingByKey = false;
  cuttingByPointer = false;
  chiselIdx = Math.floor(N / 2);
  for (let i = 0; i < N; i++) cylinder[i] = MAX_R;
  generateTarget(round);
  roundEl.textContent = String(round);
  state = 'playing';
  hideOverlayText();
}

function startGame(): void {
  state = 'playing';
  hideOverlayText();
}

function advance(): void {
  if (state === 'ready') startGame();
  else if (state === 'won') nextRound();
  else if (state === 'lost') {
    reset();
    startGame();
  }
}

function loop(ts: number): void {
  requestAnimationFrame(loop);
  if (lastTs === 0) lastTs = ts;
  const dt = Math.min(0.05, (ts - lastTs) / 1000);
  lastTs = ts;

  grainPhase = (grainPhase + dt * 1.2) % 1;
  pulse = (pulse + dt * 2.2) % (Math.PI * 2);

  cutting = state === 'playing' && (cuttingByKey || cuttingByPointer);

  if (cutting) {
    const cutThisFrame = CUT_PER_SEC * dt;
    let changed = false;
    for (let dx = -CHISEL_HALF; dx <= CHISEL_HALF; dx++) {
      const i = chiselIdx + dx;
      if (i < 0 || i >= N) continue;
      const falloff = 1 - Math.abs(dx) / (CHISEL_HALF + 1);
      const before = cylinder[i]!;
      const next = Math.max(0, before - cutThisFrame * falloff);
      if (next !== before) {
        cylinder[i] = next;
        changed = true;
      }
    }
    if (changed) checkProgress();
  }

  draw();
}

function getCss(varName: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(varName)
    .trim();
  return v || fallback;
}

let cssBg = '#0e1116';
let cssDim = '#5a5f6b';
let cssText = '#e8ecf2';

function cacheCss(): void {
  cssBg = getCss('--surface', cssBg);
  cssDim = getCss('--border', cssDim);
  cssText = getCss('--text', cssText);
}

function draw(): void {
  const W = canvas.width;
  const H = canvas.height;
  const margin = 26;
  const usable = W - 2 * margin;
  const cellW = usable / N;
  const cy = H * 0.42;
  const tol = tolerance();

  // Background
  ctx.fillStyle = cssBg;
  ctx.fillRect(0, 0, W, H);

  // Spindle axis line
  ctx.strokeStyle = '#3a4250';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(8, cy);
  ctx.lineTo(W - 8, cy);
  ctx.stroke();

  // Headstock / tailstock
  ctx.fillStyle = '#2b313c';
  ctx.fillRect(8, cy - 60, 14, 120);
  ctx.fillRect(W - 22, cy - 60, 14, 120);
  ctx.fillStyle = '#1a1f28';
  ctx.fillRect(8, cy - 6, 14, 12);
  ctx.fillRect(W - 22, cy - 6, 14, 12);

  // Target safe band (tolerance halo)
  ctx.fillStyle = 'rgba(64, 200, 255, 0.07)';
  ctx.beginPath();
  ctx.moveTo(margin, cy - (target[0]! + tol));
  for (let i = 0; i < N; i++) {
    const x = margin + i * cellW + cellW * 0.5;
    ctx.lineTo(x, cy - (target[i]! + tol));
  }
  for (let i = N - 1; i >= 0; i--) {
    const x = margin + i * cellW + cellW * 0.5;
    ctx.lineTo(x, cy - Math.max(0, target[i]! - tol));
  }
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(margin, cy + (target[0]! + tol));
  for (let i = 0; i < N; i++) {
    const x = margin + i * cellW + cellW * 0.5;
    ctx.lineTo(x, cy + (target[i]! + tol));
  }
  for (let i = N - 1; i >= 0; i--) {
    const x = margin + i * cellW + cellW * 0.5;
    ctx.lineTo(x, cy + Math.max(0, target[i]! - tol));
  }
  ctx.closePath();
  ctx.fill();

  // Cylinder per-cell drawing (color by state)
  for (let i = 0; i < N; i++) {
    const x = margin + i * cellW;
    const r = cylinder[i]!;
    const cls = classify(i);

    let color: string;
    if (cls === 1) {
      color = '#5cc16a';
    } else if (cls === -1) {
      color = '#c34242';
    } else {
      // Wood with subtle grain animation
      const grain =
        0.84 +
        0.16 *
          Math.sin((i * 0.4 + grainPhase * Math.PI * 2) * 1.3) *
          Math.cos(i * 0.11);
      const rC = Math.floor(178 * grain);
      const gC = Math.floor(116 * grain);
      const bC = Math.floor(64 * grain);
      color = `rgb(${rC}, ${gC}, ${bC})`;
    }

    ctx.fillStyle = color;
    ctx.fillRect(x, cy - r, cellW + 0.6, r * 2);
  }

  // Wood edge highlight
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i < N; i++) {
    const x = margin + i * cellW + cellW * 0.5;
    if (i === 0) ctx.moveTo(x, cy - cylinder[i]!);
    else ctx.lineTo(x, cy - cylinder[i]!);
  }
  ctx.stroke();
  ctx.strokeStyle = 'rgba(0,0,0,0.32)';
  ctx.beginPath();
  for (let i = 0; i < N; i++) {
    const x = margin + i * cellW + cellW * 0.5;
    if (i === 0) ctx.moveTo(x, cy + cylinder[i]!);
    else ctx.lineTo(x, cy + cylinder[i]!);
  }
  ctx.stroke();

  // Target outline (dashed cyan, top + bottom)
  ctx.strokeStyle = '#5fd0ff';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  for (let i = 0; i < N; i++) {
    const x = margin + i * cellW + cellW * 0.5;
    if (i === 0) ctx.moveTo(x, cy - target[i]!);
    else ctx.lineTo(x, cy - target[i]!);
  }
  ctx.stroke();
  ctx.beginPath();
  for (let i = 0; i < N; i++) {
    const x = margin + i * cellW + cellW * 0.5;
    if (i === 0) ctx.moveTo(x, cy + target[i]!);
    else ctx.lineTo(x, cy + target[i]!);
  }
  ctx.stroke();
  ctx.setLineDash([]);

  // Spinning grain marker (gives the "lathe spinning" feel)
  const lineX = margin + ((grainPhase * usable) % usable);
  for (let i = 0; i < N; i++) {
    const x = margin + i * cellW + cellW * 0.5;
    if (Math.abs(x - lineX) > cellW * 0.5) continue;
    const cls = classify(i);
    if (cls !== 0) continue;
    const r = cylinder[i]!;
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.beginPath();
    ctx.moveTo(x, cy - r + 2);
    ctx.lineTo(x, cy + r - 2);
    ctx.stroke();
  }

  // Chisel
  const chx = margin + chiselIdx * cellW + cellW * 0.5;
  const chTop = cy + MAX_R + 14;
  ctx.fillStyle = cutting ? '#f1f5fb' : '#9aa3b2';
  ctx.beginPath();
  ctx.moveTo(chx, chTop);
  ctx.lineTo(chx - 9, chTop + 16);
  ctx.lineTo(chx + 9, chTop + 16);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#7a5a32';
  ctx.fillRect(chx - 5, chTop + 16, 10, 28);
  ctx.strokeStyle = 'rgba(0,0,0,0.4)';
  ctx.lineWidth = 1;
  ctx.strokeRect(chx - 5, chTop + 16, 10, 28);

  // Chisel position vertical guide line
  if (state === 'playing') {
    ctx.strokeStyle = cutting
      ? 'rgba(255,240,200,0.55)'
      : 'rgba(255,255,255,0.18)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(chx, 8);
    ctx.lineTo(chx, chTop);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Cut hint sparks while cutting
  if (cutting) {
    const cylR = cylinder[chiselIdx]!;
    const spark = 0.5 + 0.5 * Math.sin(pulse * 4);
    ctx.fillStyle = `rgba(255, 210, 120, ${0.45 + spark * 0.35})`;
    for (let k = 0; k < 4; k++) {
      const ang = (k / 4) * Math.PI * 2 + pulse;
      const px = chx + Math.cos(ang) * (cellW + 4);
      const py = cy + cylR + 2 + Math.sin(ang) * 4;
      ctx.beginPath();
      ctx.arc(px, py, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Footer info (round + tolerance)
  ctx.fillStyle = cssText;
  ctx.font =
    '500 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  ctx.textBaseline = 'top';
  ctx.fillText(`Tur ${round}  ·  Tolerans ${tol.toFixed(1)}px`, 28, 8);
}

function pointerToCell(clientX: number): number {
  const rect = canvas.getBoundingClientRect();
  const x = ((clientX - rect.left) / rect.width) * canvas.width;
  const margin = 26;
  const usable = canvas.width - 2 * margin;
  const idx = Math.round(((x - margin) / usable) * (N - 1));
  return Math.max(0, Math.min(N - 1, idx));
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  roundEl = document.querySelector<HTMLElement>('#round')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;

  best = safeRead<number>(STORAGE_BEST, 0);
  cacheCss();

  // Canvas pointer (cutting + position)
  canvas.addEventListener('pointermove', (e) => {
    chiselIdx = pointerToCell(e.clientX);
  });

  canvas.addEventListener('pointerdown', (e) => {
    if (state !== 'playing') return;
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    chiselIdx = pointerToCell(e.clientX);
    cuttingByPointer = true;
    e.preventDefault();
  });

  const endPointer = (e: PointerEvent): void => {
    cuttingByPointer = false;
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('pointerleave', endPointer);

  // Overlay click -> advance state machine
  overlay.addEventListener('pointerdown', (e) => {
    if (isOverlayHidden(overlay)) return;
    advance();
    e.preventDefault();
    e.stopPropagation();
  });

  // Keyboard
  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'r') {
      reset();
      e.preventDefault();
      return;
    }
    if (k === ' ' || k === 'enter') {
      if (state === 'playing') {
        cuttingByKey = true;
      } else {
        advance();
      }
      e.preventDefault();
      return;
    }
    if (state !== 'playing') return;
    if (k === 'arrowleft' || k === 'a') {
      chiselIdx = Math.max(0, chiselIdx - 1);
      e.preventDefault();
    } else if (k === 'arrowright' || k === 'd') {
      chiselIdx = Math.min(N - 1, chiselIdx + 1);
      e.preventDefault();
    } else if (k === 'arrowdown' || k === 's') {
      cuttingByKey = true;
      e.preventDefault();
    }
  });

  window.addEventListener('keyup', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'arrowdown' || k === 's' || k === ' ' || k === 'enter') {
      cuttingByKey = false;
    }
  });

  restartBtn.addEventListener('click', () => {
    reset();
  });

  reset();
  requestAnimationFrame(loop);
}

export const game = defineGame({ init, reset });
