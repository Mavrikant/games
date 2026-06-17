import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay, hideOverlay } from '@shared/overlay';

const STORAGE_BEST = 'tutsu.best';

const CANVAS_W = 560;
const CANVAS_H = 400;
const BAR_W = 30;
const BAR_GAP = 28;
const BASE_Y = 330;
const MAX_LEN_PX = 250;
const MAX_UNITS = 14;
const PASS_THRESHOLD = 60;

type State = 'ready' | 'playing' | 'finished' | 'gameover';

interface Stick {
  x: number;
  lenInit: number;
  lenLeft: number;
  rate: number;
  lit: boolean;
  ignitedAt: number;
  finishedAt: number | null;
}

const gen = createGenToken();
let state: State = 'ready';
let level = 1;
let total = 0;
let best = 0;
let sticks: Stick[] = [];
let startTimeMs = 0;
let lastFrameMs = 0;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let levelEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlayEl!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayText!: HTMLElement;

function loadBest(): number {
  const v = safeRead<number>(STORAGE_BEST, 0);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

function commitBest(): void {
  if (total > best) {
    best = total;
    safeWrite(STORAGE_BEST, best);
  }
}

function toleranceForLevel(lv: number): number {
  return Math.max(1.0, 4.0 - (lv - 1) * 0.5);
}

function makeLevel(lv: number): Stick[] {
  const count = Math.min(6, 2 + lv);
  const rates = [0.6, 0.85, 1.1, 1.4];
  const result: Stick[] = [];
  const totalWidth = count * BAR_W + (count - 1) * BAR_GAP;
  const x0 = (CANVAS_W - totalWidth) / 2;
  for (let i = 0; i < count; i++) {
    const r = rates[Math.floor(Math.random() * rates.length)]!;
    const burnSeconds = 4 + Math.random() * 6;
    const len = Math.min(MAX_UNITS, burnSeconds * r);
    result.push({
      x: x0 + i * (BAR_W + BAR_GAP),
      lenInit: len,
      lenLeft: len,
      rate: r,
      lit: false,
      ignitedAt: 0,
      finishedAt: null,
    });
  }
  return result;
}

function setOverlay(title: string, text: string): void {
  overlayTitle.textContent = title;
  overlayText.textContent = text;
  showOverlay(overlayEl);
}

function syncHud(): void {
  scoreEl.textContent = String(total);
  bestEl.textContent = String(best);
  levelEl.textContent = String(level);
}

function startLevel(lv: number, intro: boolean): void {
  state = 'ready';
  sticks = makeLevel(lv);
  startTimeMs = 0;
  lastFrameMs = performance.now();
  const tol = toleranceForLevel(lv);
  if (intro) {
    setOverlay(
      'Tütsü',
      `Hedef: hepsi aynı anda sönsün.\nTolerans: ${tol.toFixed(1)} sn · ${sticks.length} çubuk\nBaşlamak için bir çubuğa dokun.`,
    );
  } else {
    setOverlay(
      `Seviye ${lv}`,
      `${sticks.length} çubuk · tolerans ${tol.toFixed(1)} sn\nBaşlamak için bir çubuğa dokun.`,
    );
  }
  syncHud();
}

function reset(): void {
  gen.bump();
  level = 1;
  total = 0;
  startLevel(level, true);
}

function nextLevel(): void {
  level += 1;
  startLevel(level, false);
}

function gameOver(roundScore: number, spreadSec: number): void {
  state = 'gameover';
  commitBest();
  setOverlay(
    'Tur kaçtı',
    `Yayılım: ${spreadSec.toFixed(2)} sn · Tur puanı: ${roundScore} (eşik ${PASS_THRESHOLD}).\nUlaştığın seviye: ${level} · Toplam: ${total}\nRekor: ${best}\nYeniden için R veya düğme.`,
  );
  syncHud();
}

function roundResolved(spreadSec: number, roundScore: number): void {
  state = 'finished';
  const passed = roundScore >= PASS_THRESHOLD;
  setOverlay(
    passed ? 'Güzel zamanlama!' : 'Yayılım fazla',
    `Yayılım: ${spreadSec.toFixed(2)} sn\nTur puanı: ${roundScore}\nToplam: ${total + roundScore}`,
  );
  syncHud();
  const myToken = gen.current();
  setTimeout(() => {
    if (myToken !== gen.current()) return;
    total += roundScore;
    syncHud();
    if (passed) nextLevel();
    else gameOver(roundScore, spreadSec);
  }, 1700);
}

function evaluateRound(): void {
  let minT = Infinity;
  let maxT = -Infinity;
  for (const s of sticks) {
    const t = s.finishedAt!;
    if (t < minT) minT = t;
    if (t > maxT) maxT = t;
  }
  const spreadSec = (maxT - minT) / 1000;
  const tol = toleranceForLevel(level);
  const ratio = Math.max(0, 1 - spreadSec / tol);
  const roundScore = Math.round(100 * ratio);
  roundResolved(spreadSec, roundScore);
}

function tick(now: number): void {
  const dt = Math.min(now - lastFrameMs, 100);
  lastFrameMs = now;

  if (state === 'playing') {
    let allBurned = true;
    let anyLit = false;
    for (const s of sticks) {
      if (!s.lit) {
        allBurned = false;
        continue;
      }
      anyLit = true;
      if (s.finishedAt !== null) continue;
      s.lenLeft = Math.max(0, s.lenLeft - s.rate * (dt / 1000));
      if (s.lenLeft <= 0) {
        s.lenLeft = 0;
        s.finishedAt = now;
      } else {
        allBurned = false;
      }
    }
    if (anyLit && allBurned) evaluateRound();
  }

  draw(now);
  requestAnimationFrame(tick);
}

const cssCache = new Map<string, string>();
function getCss(varName: string, fb: string): string {
  const cached = cssCache.get(varName);
  if (cached !== undefined) return cached;
  const v = getComputedStyle(document.documentElement).getPropertyValue(varName).trim() || fb;
  cssCache.set(varName, v);
  return v;
}

function colorForRate(r: number): string {
  if (r <= 0.7) return '#c1502d';
  if (r <= 1.0) return '#e07a3a';
  if (r <= 1.25) return '#f0a44a';
  return '#f6cf63';
}

function drawBackground(): void {
  const bg = getCss('--surface', '#11151b');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  const grad = ctx.createLinearGradient(0, 0, 0, CANVAS_H);
  grad.addColorStop(0, 'rgba(255,180,90,0.04)');
  grad.addColorStop(1, 'rgba(255,180,90,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
}

function drawHolder(s: Stick): void {
  ctx.fillStyle = '#2a1b14';
  ctx.fillRect(s.x - 6, BASE_Y, BAR_W + 12, 14);
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  ctx.fillRect(s.x - 6, BASE_Y, BAR_W + 12, 3);
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(s.x - 6, BASE_Y + 11, BAR_W + 12, 3);
}

function drawStick(s: Stick, idx: number, now: number): void {
  const scale = MAX_LEN_PX / MAX_UNITS;
  const heightInit = s.lenInit * scale;
  const heightPx = s.lenLeft * scale;
  const cx = s.x + BAR_W / 2;
  const topInit = BASE_Y - heightInit;
  const topY = BASE_Y - heightPx;

  // Burnt remnant (ash trace) above current top
  if (s.lit && heightPx < heightInit) {
    ctx.fillStyle = 'rgba(120,110,100,0.18)';
    ctx.fillRect(s.x + 6, topInit, BAR_W - 12, heightInit - heightPx);
    // small ash flakes
    ctx.fillStyle = 'rgba(180,170,160,0.5)';
    ctx.fillRect(s.x + 8, topY - 2, BAR_W - 16, 2);
  }

  // Stick body (gradient highlight on left edge)
  ctx.fillStyle = colorForRate(s.rate);
  ctx.globalAlpha = s.finishedAt !== null ? 0.45 : 1;
  ctx.fillRect(s.x, topY, BAR_W, heightPx);
  ctx.globalAlpha = 1;

  // Side shadow
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.fillRect(s.x + BAR_W - 5, topY, 5, heightPx);
  ctx.fillStyle = 'rgba(255,255,255,0.10)';
  ctx.fillRect(s.x, topY, 4, heightPx);

  // Outline
  ctx.strokeStyle = 'rgba(0,0,0,0.45)';
  ctx.lineWidth = 1;
  if (heightPx > 0) ctx.strokeRect(s.x + 0.5, topY + 0.5, BAR_W - 1, heightPx - 1);

  drawHolder(s);

  // Number label above (1..N) — useful for keyboard players
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(String(idx + 1), cx, 24);

  // Flame + smoke when actively burning
  if (s.lit && s.finishedAt === null) {
    const flick = 1 + 0.08 * Math.sin(now * 0.018 + idx);
    const fy = topY;
    const grad = ctx.createRadialGradient(cx, fy, 1, cx, fy, 22 * flick);
    grad.addColorStop(0, 'rgba(255,235,180,0.95)');
    grad.addColorStop(0.45, 'rgba(255,165,70,0.55)');
    grad.addColorStop(1, 'rgba(255,80,0,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, fy, 22 * flick, 0, Math.PI * 2);
    ctx.fill();

    // Small inner flame
    ctx.fillStyle = 'rgba(255,210,120,0.95)';
    ctx.beginPath();
    ctx.ellipse(cx, fy - 4, 3 * flick, 6 * flick, 0, 0, Math.PI * 2);
    ctx.fill();

    // Smoke wisp
    ctx.strokeStyle = 'rgba(220,220,220,0.22)';
    ctx.lineWidth = 1.5;
    const w = 6 + 3 * Math.sin(now * 0.004 + idx);
    ctx.beginPath();
    ctx.moveTo(cx, fy - 8);
    ctx.bezierCurveTo(cx + w, fy - 22, cx - w, fy - 36, cx + w * 0.5, fy - 52);
    ctx.stroke();
  }

  // Label below
  ctx.textAlign = 'center';
  ctx.font = '12px system-ui, sans-serif';
  if (s.finishedAt !== null && startTimeMs > 0) {
    const elapsed = (s.finishedAt - startTimeMs) / 1000;
    ctx.fillStyle = getCss('--text', '#f5f3e6');
    ctx.fillText(`${elapsed.toFixed(2)}s`, cx, BASE_Y + 32);
  } else if (s.lit) {
    const remaining = s.lenLeft / s.rate;
    ctx.fillStyle = getCss('--text-dim', 'rgba(255,255,255,0.55)');
    ctx.fillText(`${remaining.toFixed(1)}s`, cx, BASE_Y + 32);
  } else {
    const tBurn = s.lenInit / s.rate;
    ctx.fillStyle = getCss('--text-dim', 'rgba(255,255,255,0.55)');
    ctx.fillText(`${tBurn.toFixed(1)}s`, cx, BASE_Y + 32);
  }
}

function draw(now: number): void {
  drawBackground();

  // Hint line: target zone
  if (state === 'playing' || state === 'finished') {
    ctx.strokeStyle = 'rgba(255,200,120,0.18)';
    ctx.setLineDash([4, 6]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(20, BASE_Y - MAX_LEN_PX - 8);
    ctx.lineTo(CANVAS_W - 20, BASE_Y - MAX_LEN_PX - 8);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  for (let i = 0; i < sticks.length; i++) drawStick(sticks[i]!, i, now);

  // Footer hint
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Renk = hız (koyu=yavaş, açık=hızlı) · Etiket = yanma süresi', CANVAS_W / 2, CANVAS_H - 8);
}

function lightStick(s: Stick): void {
  const now = performance.now();
  if (s.lit) return;
  s.lit = true;
  s.ignitedAt = now;
  if (state === 'ready') {
    state = 'playing';
    startTimeMs = now;
    hideOverlay(overlayEl);
  }
}

function pickStickAt(px: number, py: number): Stick | null {
  if (py < 20 || py > BASE_Y + 36) return null;
  for (const s of sticks) {
    if (px >= s.x - 8 && px <= s.x + BAR_W + 8) return s;
  }
  return null;
}

function handlePointer(e: PointerEvent): void {
  if (state !== 'ready' && state !== 'playing') return;
  const rect = canvas.getBoundingClientRect();
  const px = ((e.clientX - rect.left) / rect.width) * CANVAS_W;
  const py = ((e.clientY - rect.top) / rect.height) * CANVAS_H;
  const s = pickStickAt(px, py);
  if (!s) return;
  lightStick(s);
  e.preventDefault();
}

function handleKey(e: KeyboardEvent): void {
  const k = e.key;
  if (k === 'r' || k === 'R') {
    reset();
    e.preventDefault();
    return;
  }
  if (state === 'gameover' && (k === 'Enter' || k === ' ')) {
    reset();
    e.preventDefault();
    return;
  }
  if (state !== 'ready' && state !== 'playing') return;
  const n = parseInt(k, 10);
  if (!Number.isNaN(n) && n >= 1 && n <= sticks.length) {
    lightStick(sticks[n - 1]!);
    e.preventDefault();
  }
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  levelEl = document.querySelector<HTMLElement>('#level')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlayEl = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayText = document.querySelector<HTMLElement>('#overlay-text')!;

  best = loadBest();

  restartBtn.addEventListener('click', reset);
  canvas.addEventListener('pointerdown', handlePointer);
  window.addEventListener('keydown', handleKey);
  overlayEl.addEventListener('pointerdown', (e) => {
    // Overlay sits on top of canvas; without its own input path the
    // ready/gameover screens are unreachable on touch. pitfalls#unreachable-start-state.
    if (state === 'gameover') {
      reset();
      e.preventDefault();
      return;
    }
    if (state === 'ready') {
      hideOverlay(overlayEl);
      e.preventDefault();
    }
  });

  reset();
  requestAnimationFrame(tick);
}

export const game = defineGame({ init, reset });
