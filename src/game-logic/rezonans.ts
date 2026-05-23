import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';

// Rezonans — additive-synthesis tuning puzzle. A hidden target waveform is the
// sum of K sine harmonics with integer amplitudes; the player rebuilds it by
// setting each harmonic's amplitude on an equalizer until both curves overlap.
// No timers / no physics → no stale-async or visual-vs-hitbox class bugs.

const STORAGE_BEST = 'rezonans.best';
const W = 480;
const H = 240;
const SAMPLES = 240;

type State = 'tuning' | 'solved';

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let levelEl!: HTMLElement;
let bestEl!: HTMLElement;
let movesEl!: HTMLElement;
let matchFillEl!: HTMLElement;
let matchPctEl!: HTMLElement;
let eqEl!: HTMLElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let nextBtn!: HTMLButtonElement;
let restartBtn!: HTMLButtonElement;

let state: State = 'tuning';
let level = 1;
let best = 0;
let moves = 0;
let maxAmp = 4;
let target: number[] = [];
let bars: number[] = [];
let selected = 0;

const cssCache = new Map<string, string>();
function getCss(name: string): string {
  const cached = cssCache.get(name);
  if (cached !== undefined) return cached;
  const val = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  cssCache.set(name, val);
  return val;
}

function bandCount(lv: number): number {
  return Math.min(3 + Math.floor((lv - 1) / 2), 6);
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

function genTarget(k: number): number[] {
  const minNonzero = Math.min(2, k);
  for (let attempt = 0; attempt < 64; attempt++) {
    const t: number[] = [];
    let nonzero = 0;
    for (let i = 0; i < k; i++) {
      const a = Math.floor(Math.random() * (maxAmp + 1));
      if (a > 0) nonzero++;
      t.push(a);
    }
    if (nonzero >= minNonzero) return t;
  }
  // Fallback: guarantee a solvable, non-trivial target.
  const t = new Array<number>(k).fill(0);
  t[0] = 1;
  t[k - 1] = 2;
  return t;
}

// Sum of sine harmonics; x in [0, 1).
function waveAt(amps: number[], x: number): number {
  let sum = 0;
  for (let i = 0; i < amps.length; i++) {
    sum += amps[i]! * Math.sin(2 * Math.PI * (i + 1) * x);
  }
  return sum;
}

function ampScale(): number {
  const maxSum = bars.length * maxAmp;
  return maxSum > 0 ? (H / 2 - 14) / maxSum : 1;
}

function drawWave(amps: number[], color: string, width: number): void {
  const scale = ampScale();
  ctx.lineWidth = width;
  ctx.strokeStyle = color;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  for (let s = 0; s <= SAMPLES; s++) {
    const x = s / SAMPLES;
    const px = x * W;
    const py = H / 2 - waveAt(amps, x) * scale;
    if (s === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.stroke();
}

function draw(): void {
  ctx.fillStyle = getCss('--surface');
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = getCss('--border-strong');
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, H / 2);
  ctx.lineTo(W, H / 2);
  ctx.stroke();

  // Target (indigo, thick) under the player's curve (green); they overlap on win.
  drawWave(target, getCss('--accent'), 5);
  drawWave(bars, getCss('--success'), 2.5);
}

function l1Distance(): number {
  let d = 0;
  for (let i = 0; i < target.length; i++) d += Math.abs(bars[i]! - target[i]!);
  return d;
}

function matchPct(): number {
  const worst = bars.length * maxAmp;
  if (worst === 0) return 100;
  return Math.round(100 * (1 - l1Distance() / worst));
}

function isSolved(): boolean {
  return l1Distance() === 0;
}

function updateMatchUi(): void {
  const pct = matchPct();
  matchFillEl.style.width = `${pct}%`;
  matchPctEl.textContent = `${pct}%`;
  matchFillEl.style.background = pct === 100 ? getCss('--success') : getCss('--accent');
}

function buildEq(): void {
  eqEl.innerHTML = '';
  const k = bars.length;
  for (let i = 0; i < k; i++) {
    const band = document.createElement('div');
    band.className = 'rz-band';
    band.dataset.band = String(i);

    const track = document.createElement('div');
    track.className = 'rz-band__track';
    for (let v = maxAmp; v >= 0; v--) {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'rz-cell';
      cell.dataset.band = String(i);
      cell.dataset.val = String(v);
      cell.setAttribute('aria-label', `Harmonik ${i + 1} genlik ${v}`);
      track.appendChild(cell);
    }
    band.appendChild(track);

    const label = document.createElement('div');
    label.className = 'rz-band__label';
    label.textContent = String(i + 1);
    band.appendChild(label);

    eqEl.appendChild(band);
  }
  renderEq();
}

function renderEq(): void {
  const bandEls = eqEl.querySelectorAll<HTMLElement>('.rz-band');
  bandEls.forEach((bandEl, i) => {
    bandEl.classList.toggle('rz-band--selected', i === selected);
    const cells = bandEl.querySelectorAll<HTMLElement>('.rz-cell');
    cells.forEach((cell) => {
      const v = Number(cell.dataset.val);
      cell.classList.toggle('rz-cell--on', v >= 1 && v <= bars[i]!);
      cell.classList.toggle('rz-cell--mute', v === 0 && bars[i] === 0);
    });
  });
}

function setBand(i: number, v: number): void {
  if (state !== 'tuning') return;
  if (i < 0 || i >= bars.length) return;
  const nv = clamp(v, 0, maxAmp);
  selected = i;
  if (bars[i] === nv) {
    renderEq();
    return;
  }
  bars[i] = nv;
  moves++;
  movesEl.textContent = String(moves);
  renderEq();
  draw();
  updateMatchUi();
  if (isSolved()) solve();
}

function solve(): void {
  state = 'solved';
  if (level > best) {
    best = level;
    bestEl.textContent = String(best);
    safeWrite(STORAGE_BEST, best);
  }
  overlayTitle.textContent = 'Rezonans! ✓';
  overlayMsg.textContent = `Seviye ${level} · ${moves} hamle\nSonraki seviye için Enter'a bas.`;
  showOverlayEl(overlay);
}

function setupLevel(): void {
  const k = bandCount(level);
  target = genTarget(k);
  bars = new Array<number>(k).fill(0);
  selected = 0;
  moves = 0;
  state = 'tuning';
  levelEl.textContent = String(level);
  bestEl.textContent = String(best);
  movesEl.textContent = '0';
  hideOverlayEl(overlay);
  buildEq();
  draw();
  updateMatchUi();
}

function nextLevel(): void {
  level++;
  setupLevel();
}

function restartGame(): void {
  level = 1;
  setupLevel();
}

function onKey(e: KeyboardEvent): void {
  const k = e.key.toLowerCase();
  if (k === 'r') {
    restartGame();
    e.preventDefault();
    return;
  }
  if (state === 'solved') {
    if (k === 'enter' || k === ' ') {
      nextLevel();
      e.preventDefault();
    }
    return;
  }
  if (k === 'arrowleft') {
    selected = clamp(selected - 1, 0, bars.length - 1);
    renderEq();
    e.preventDefault();
  } else if (k === 'arrowright') {
    selected = clamp(selected + 1, 0, bars.length - 1);
    renderEq();
    e.preventDefault();
  } else if (k === 'arrowup') {
    setBand(selected, bars[selected]! + 1);
    e.preventDefault();
  } else if (k === 'arrowdown') {
    setBand(selected, bars[selected]! - 1);
    e.preventDefault();
  }
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  levelEl = document.querySelector<HTMLElement>('#level')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  movesEl = document.querySelector<HTMLElement>('#moves')!;
  matchFillEl = document.querySelector<HTMLElement>('#match-fill')!;
  matchPctEl = document.querySelector<HTMLElement>('#match-pct')!;
  eqEl = document.querySelector<HTMLElement>('#eq')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  nextBtn = document.querySelector<HTMLButtonElement>('#next')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  eqEl.addEventListener('click', (e) => {
    const cell = (e.target as HTMLElement).closest<HTMLElement>('.rz-cell');
    if (!cell) return;
    setBand(Number(cell.dataset.band), Number(cell.dataset.val));
  });

  nextBtn.addEventListener('click', () => {
    if (state === 'solved') nextLevel();
  });
  restartBtn.addEventListener('click', restartGame);
  window.addEventListener('keydown', onKey);

  setupLevel();
}

export const game = defineGame({ init, reset: restartGame });
