import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import {
  showOverlay as showOverlayEl,
  hideOverlay as hideOverlayEl,
} from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';

type State = 'ready' | 'playing' | 'gameover';

const STORAGE_BEST = 'telsiz.best';

const W = 480;
const H = 480;
const CX = 240;
const CY = 240;

const DISH_R = 40;
const SWEEP_R = 200;
const PERIMETER_R = 220;
const TWO_PI = Math.PI * 2;
const GAME_TIME = 60;

const BASE_TOLERANCE = (10 * Math.PI) / 180;
const MIN_TOLERANCE = (3.5 * Math.PI) / 180;
const WIDE_NOISE = (28 * Math.PI) / 180;
const WRONG_LOCK_PENALTY = 3.5;

const SIGNAL_PALETTE = ['#22d3ee', '#a78bfa', '#f59e0b', '#34d399', '#f472b6'];

interface Signal {
  angle: number;
  found: boolean;
  pulse: number;
  colorIdx: number;
}

interface Ping {
  angle: number;
  t: number;
  hit: boolean;
}

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let timeEl!: HTMLElement;
let bestEl!: HTMLElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let restartBtn!: HTMLButtonElement;

const gen = createGenToken();
let state: State = 'ready';
let score = 0;
let best = 0;
let timeLeft = GAME_TIME;
let aimAngle = -Math.PI / 2;

let signals: Signal[] = [];
let pings: Ping[] = [];
let round = 0;
let waveformPhase = 0;
let lastFrame = 0;
let rafId: number | null = null;
let canLockUntil = 0;

function setScore(v: number): void {
  score = v;
  scoreEl.textContent = String(score);
}

function setBest(v: number): void {
  best = v;
  bestEl.textContent = String(best);
}

function setTime(v: number): void {
  timeLeft = v;
  timeEl.textContent = String(Math.max(0, Math.ceil(timeLeft)));
}

function setOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlay);
}

function clearOverlay(): void {
  hideOverlayEl(overlay);
}

function normalizeAngle(a: number): number {
  let n = a % TWO_PI;
  if (n < 0) n += TWO_PI;
  return n;
}

function angularDistance(a: number, b: number): number {
  const d = Math.abs(normalizeAngle(a) - normalizeAngle(b));
  return Math.min(d, TWO_PI - d);
}

function toleranceForRound(r: number): number {
  const t = BASE_TOLERANCE - r * ((0.9 * Math.PI) / 180);
  return Math.max(MIN_TOLERANCE, t);
}

function signalsForRound(r: number): number {
  return Math.min(7, 3 + r);
}

function spawnSignals(): void {
  const n = signalsForRound(round);
  const angles: number[] = [];
  const minGap = toleranceForRound(round) * 2.4;
  let guard = 0;
  while (angles.length < n && guard < 400) {
    guard++;
    const a = Math.random() * TWO_PI;
    let ok = true;
    for (const ex of angles) {
      if (angularDistance(a, ex) < minGap) {
        ok = false;
        break;
      }
    }
    if (ok) angles.push(a);
  }
  signals = angles.map((a, i) => ({
    angle: a,
    found: false,
    pulse: 0,
    colorIdx: i % SIGNAL_PALETTE.length,
  }));
}

function strengthAt(angle: number): { value: number; nearest: Signal | null } {
  let result: { value: number; nearest: Signal | null } = {
    value: 0,
    nearest: null,
  };
  const tol = toleranceForRound(round);
  for (const s of signals) {
    if (s.found) continue;
    const d = angularDistance(angle, s.angle);
    if (d > WIDE_NOISE) continue;
    const k = Math.max(0, 1 - d / WIDE_NOISE);
    const peak =
      d <= tol ? 0.85 + 0.15 * (1 - d / tol) : 0.85 * Math.pow(k, 1.7);
    if (peak > result.value) result = { value: peak, nearest: s };
  }
  return result;
}

function reset(): void {
  gen.bump();
  stopLoop();
  state = 'ready';
  setScore(0);
  setTime(GAME_TIME);
  round = 0;
  pings = [];
  spawnSignals();
  draw();
  setOverlay(
    'Telsiz',
    'Anteni fareyle çevir; sinyale yaklaştıkça üst şerit yeşillenir.\nBOŞLUK veya tıkla → kilitle. Yanlış kilit süre yer.',
  );
}

function startGame(): void {
  if (state === 'playing') return;
  state = 'playing';
  setScore(0);
  setTime(GAME_TIME);
  round = 0;
  pings = [];
  spawnSignals();
  clearOverlay();
  lastFrame = performance.now();
  startLoop();
}

function endGame(): void {
  state = 'gameover';
  stopLoop();
  if (score > best) {
    setBest(score);
    safeWrite(STORAGE_BEST, best);
  }
  setOverlay(
    'Süre bitti',
    `Sinyal: ${score} · Rekor: ${best}\nTekrar için tıkla veya BOŞLUK.`,
  );
  draw();
}

function startLoop(): void {
  if (rafId !== null) return;
  const myGen = gen.current();
  const step = (now: number): void => {
    if (!gen.isCurrent(myGen) || state !== 'playing') {
      rafId = null;
      return;
    }
    const dt = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;
    update(dt);
    draw();
    rafId = requestAnimationFrame(step);
  };
  rafId = requestAnimationFrame(step);
}

function stopLoop(): void {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

function update(dt: number): void {
  setTime(timeLeft - dt);
  if (timeLeft <= 0) {
    setTime(0);
    endGame();
    return;
  }
  waveformPhase += dt * 6;
  for (const s of signals) {
    if (s.pulse > 0) s.pulse = Math.max(0, s.pulse - dt * 1.6);
  }
  for (const p of pings) p.t -= dt;
  pings = pings.filter((p) => p.t > 0);
}

function lockBearing(): void {
  if (state !== 'playing') return;
  const now = performance.now();
  if (now < canLockUntil) return;
  canLockUntil = now + 200;
  const tol = toleranceForRound(round);
  let hit: Signal | null = null;
  for (const s of signals) {
    if (s.found) continue;
    if (angularDistance(aimAngle, s.angle) <= tol) {
      hit = s;
      break;
    }
  }
  if (hit) {
    hit.found = true;
    hit.pulse = 1;
    setScore(score + 1);
    pings.push({ angle: hit.angle, t: 0.7, hit: true });
    if (signals.every((s) => s.found)) {
      round++;
      spawnSignals();
    }
  } else {
    pings.push({ angle: aimAngle, t: 0.45, hit: false });
    setTime(Math.max(0, timeLeft - WRONG_LOCK_PENALTY));
  }
}

function onPointerMove(e: PointerEvent): void {
  const rect = canvas.getBoundingClientRect();
  const sx = canvas.width / rect.width;
  const sy = canvas.height / rect.height;
  const px = (e.clientX - rect.left) * sx;
  const py = (e.clientY - rect.top) * sy;
  const dx = px - CX;
  const dy = py - CY;
  if (dx * dx + dy * dy < 36) return;
  aimAngle = Math.atan2(dy, dx);
  if (state !== 'playing') draw();
}

function onPointerDown(e: PointerEvent): void {
  e.preventDefault();
  if (state === 'ready') {
    startGame();
    return;
  }
  if (state === 'gameover') {
    reset();
    startGame();
    return;
  }
  if (state === 'playing') {
    onPointerMove(e);
    lockBearing();
  }
}

function onKey(e: KeyboardEvent): void {
  const k = e.key.toLowerCase();
  if (k === 'r') {
    reset();
    e.preventDefault();
    return;
  }
  if (k === ' ' || k === 'enter') {
    if (state === 'ready') {
      startGame();
      e.preventDefault();
      return;
    }
    if (state === 'gameover') {
      reset();
      startGame();
      e.preventDefault();
      return;
    }
    if (state === 'playing') {
      lockBearing();
      e.preventDefault();
      return;
    }
  }
  if (state === 'playing') {
    const step = (2.5 * Math.PI) / 180;
    if (k === 'a' || k === 'arrowleft') {
      aimAngle -= step;
      e.preventDefault();
    } else if (k === 'd' || k === 'arrowright') {
      aimAngle += step;
      e.preventDefault();
    }
  }
}

const cssCache = new Map<string, string>();
function getCss(varName: string, fallback: string): string {
  const cached = cssCache.get(varName);
  if (cached !== undefined) return cached || fallback;
  const val = getComputedStyle(document.documentElement)
    .getPropertyValue(varName)
    .trim();
  cssCache.set(varName, val);
  return val || fallback;
}

function drawPerimeter(): void {
  const grid = getCss('--telsiz-grid', '#16213a');
  ctx.strokeStyle = grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(CX, CY, PERIMETER_R, 0, TWO_PI);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(CX, CY, SWEEP_R - 40, 0, TWO_PI);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(CX, CY, SWEEP_R - 90, 0, TWO_PI);
  ctx.stroke();

  ctx.fillStyle = 'rgba(245,246,248,0.55)';
  ctx.font = '11px ui-monospace, monospace';
  ctx.textAlign = 'center';
  const labels = [
    { a: -Math.PI / 2, t: 'K' },
    { a: 0, t: 'D' },
    { a: Math.PI / 2, t: 'G' },
    { a: Math.PI, t: 'B' },
  ];
  for (const l of labels) {
    const r = PERIMETER_R + 14;
    const x = CX + Math.cos(l.a) * r;
    const y = CY + Math.sin(l.a) * r + 4;
    ctx.fillText(l.t, x, y);
  }
  ctx.textAlign = 'left';

  ctx.strokeStyle = grid;
  ctx.lineWidth = 1;
  for (let i = 0; i < 24; i++) {
    const a = (i * Math.PI) / 12;
    const inner = PERIMETER_R - 4;
    const outer = PERIMETER_R + (i % 6 === 0 ? 6 : 3);
    ctx.beginPath();
    ctx.moveTo(CX + Math.cos(a) * inner, CY + Math.sin(a) * inner);
    ctx.lineTo(CX + Math.cos(a) * outer, CY + Math.sin(a) * outer);
    ctx.stroke();
  }
}

function drawSweepArc(): void {
  const tol = toleranceForRound(round);

  ctx.beginPath();
  ctx.moveTo(CX, CY);
  ctx.arc(CX, CY, SWEEP_R, aimAngle - WIDE_NOISE, aimAngle + WIDE_NOISE);
  ctx.closePath();
  ctx.fillStyle = 'rgba(34, 211, 238, 0.04)';
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(CX, CY);
  ctx.arc(CX, CY, SWEEP_R, aimAngle - tol, aimAngle + tol);
  ctx.closePath();
  ctx.fillStyle = 'rgba(34, 211, 238, 0.12)';
  ctx.fill();
}

function drawDish(): void {
  const accent = getCss('--telsiz-accent', '#e2e8f0');
  ctx.fillStyle = '#0b1424';
  ctx.strokeStyle = accent;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(CX, CY, DISH_R - 6, 0, TWO_PI);
  ctx.fill();
  ctx.stroke();

  ctx.save();
  ctx.translate(CX, CY);
  ctx.rotate(aimAngle);
  ctx.strokeStyle = accent;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(8, 0, 14, -Math.PI / 2, Math.PI / 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(20, 0);
  ctx.stroke();
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.arc(22, 0, 2.5, 0, TWO_PI);
  ctx.fill();
  ctx.restore();
}

function drawSignals(): void {
  for (const s of signals) {
    if (!s.found) continue;
    const x = CX + Math.cos(s.angle) * PERIMETER_R;
    const y = CY + Math.sin(s.angle) * PERIMETER_R;
    const color = SIGNAL_PALETTE[s.colorIdx] ?? '#22d3ee';

    ctx.strokeStyle = `${color}33`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(
      CX + Math.cos(s.angle) * (DISH_R + 4),
      CY + Math.sin(s.angle) * (DISH_R + 4),
    );
    ctx.lineTo(x, y);
    ctx.stroke();

    ctx.fillStyle = color;
    ctx.shadowBlur = 10;
    ctx.shadowColor = color;
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, TWO_PI);
    ctx.fill();
    ctx.shadowBlur = 0;

    if (s.pulse > 0) {
      const alpha = s.pulse;
      const radius = 6 + (1 - s.pulse) * 28;
      ctx.strokeStyle = `rgba(167, 243, 208, ${(alpha * 0.7).toFixed(3)})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, TWO_PI);
      ctx.stroke();
    }
  }
}

function drawPings(): void {
  for (const p of pings) {
    const x = CX + Math.cos(p.angle) * PERIMETER_R;
    const y = CY + Math.sin(p.angle) * PERIMETER_R;
    if (p.hit) {
      const alpha = Math.max(0, Math.min(1, p.t / 0.7));
      ctx.strokeStyle = `rgba(167, 243, 208, ${(alpha * 0.9).toFixed(3)})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, 10 + (1 - alpha) * 24, 0, TWO_PI);
      ctx.stroke();
    } else {
      const alpha = Math.max(0, Math.min(1, p.t / 0.45));
      ctx.strokeStyle = `rgba(248, 113, 113, ${(alpha * 0.95).toFixed(3)})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, 6 + (1 - alpha) * 18, 0, TWO_PI);
      ctx.stroke();
    }
  }
}

function drawStrengthMeter(): void {
  const { value, nearest } = strengthAt(aimAngle);
  const padX = 36;
  const padY = 16;
  const barW = W - padX * 2;
  const barH = 12;

  ctx.fillStyle = 'rgba(13, 22, 42, 0.85)';
  ctx.fillRect(padX, padY, barW, barH);
  ctx.strokeStyle = getCss('--telsiz-grid', '#16213a');
  ctx.lineWidth = 1;
  ctx.strokeRect(padX, padY, barW, barH);

  const fillW = barW * value;
  let color = '#475569';
  if (value > 0.85) color = '#34d399';
  else if (value > 0.5) color = '#22d3ee';
  else if (value > 0.2) color = '#94a3b8';
  ctx.fillStyle = color;
  ctx.fillRect(padX, padY, fillW, barH);

  const thrX = padX + barW * 0.85;
  ctx.strokeStyle = 'rgba(245,246,248,0.55)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(thrX, padY - 3);
  ctx.lineTo(thrX, padY + barH + 3);
  ctx.stroke();

  ctx.fillStyle = 'rgba(226,232,240,0.75)';
  ctx.font = '11px ui-monospace, monospace';
  ctx.textAlign = 'left';
  ctx.fillText('SİNYAL ŞİDDETİ', padX, padY + barH + 14);
  ctx.textAlign = 'right';
  const remaining = signals.filter((s) => !s.found).length;
  ctx.fillText(`Tur ${round + 1} · Kalan ${remaining}`, W - padX, padY + barH + 14);
  ctx.textAlign = 'left';

  if (value > 0.2 && nearest) {
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const amp = barH * 0.35 * value;
    const span = fillW;
    const segments = 32;
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const x = padX + t * span;
      const y = padY + barH / 2 + Math.sin(t * 24 + waveformPhase) * amp;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}

function drawHints(): void {
  const deg = Math.round(((normalizeAngle(aimAngle) * 180) / Math.PI + 90) % 360);
  ctx.fillStyle = 'rgba(226,232,240,0.55)';
  ctx.font = '11px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.fillText(`yön ${deg.toString().padStart(3, '0')}°`, CX, H - 14);
  ctx.textAlign = 'left';
}

function draw(): void {
  const bg = getCss('--telsiz-bg', '#070b18');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  drawPerimeter();
  drawSweepArc();
  drawSignals();
  drawPings();
  drawDish();
  drawStrengthMeter();
  drawHints();
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  timeEl = document.querySelector<HTMLElement>('#time')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;

  setBest(safeRead<number>(STORAGE_BEST, 0));

  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerdown', onPointerDown);
  overlay.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (state === 'ready') startGame();
    else if (state === 'gameover') {
      reset();
      startGame();
    }
  });
  restartBtn.addEventListener('click', () => {
    reset();
  });
  window.addEventListener('keydown', onKey);

  reset();
}

export const game = defineGame({ init, reset });
