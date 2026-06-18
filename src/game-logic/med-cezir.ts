import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';

// Med Cezir — gel-git ritmi ile kabuk toplama.
// Dalga sinüs olarak iner çıkar (CENTER ± AMP). Her kabuk sabit bir y'ye
// yerleştirilmiştir; "aktif" yalnız tide line kabuğun y'sinden ±WINDOW içinde
// olduğunda — o pencerede tıkla. Su altı ya da kuruda görsel olarak vardır ama
// tıklanamaz.
//
// PITFALLS guarded:
// - module-level-dom-access: tüm DOM erişimi init() içinde.
// - unguarded-storage: safeRead/safeWrite.
// - stale-async-callback: RAF loop generation token ile kapatılıyor.
// - overlay-input-leak: state enum; her handler başında guard.
// - invisible-boot: init sonunda ilk draw(0) — tide line, kum, kabuklar görünür.
// - missing-overlay-css: per-game CSS'te .overlay--hidden { opacity:0; pointer-events:none }.
// - visual-vs-hitbox: tideY(timeMs) ve shell çizimi aynı sabitleri kullanır;
//   tryCollect aynı y'lerle hit-test eder.
// - hud-counter-synced-only-at-lifecycle-edges: score her artışta DOM'a yazılır.

type State = 'ready' | 'playing' | 'gameover';
type Shell = { x: number; y: number; collected: boolean };

const STORAGE_KEY = 'med-cezir.best';

const CANVAS_W = 480;
const CANVAS_H = 320;

const TIDE_CENTER_Y = 165;
const TIDE_AMP = 95;
const TIDE_PERIOD_MS = 5400;
const SHELL_WINDOW = 24;
const SHELL_RADIUS = 12;
const NUM_SHELLS = 14;
const GAME_TIME_MS = 60_000;
const CLICK_FORGIVENESS = 14;

const gen = createGenToken();

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let timeEl!: HTMLElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let restartBtn!: HTMLButtonElement;

let state: State = 'ready';
let shells: Shell[] = [];
let score = 0;
let best = 0;
let runStartMs = 0;
let elapsedMs = 0;

function tideY(timeMs: number): number {
  const phase = (timeMs / TIDE_PERIOD_MS) * Math.PI * 2;
  return TIDE_CENTER_Y + TIDE_AMP * Math.sin(phase);
}

function placeShells(): void {
  shells = [];
  const yMin = TIDE_CENTER_Y - TIDE_AMP * 0.82;
  const yMax = TIDE_CENTER_Y + TIDE_AMP * 0.82;
  const cols = 7;
  const xMargin = 40;
  const xStep = (CANVAS_W - xMargin * 2) / (cols - 1);
  for (let i = 0; i < NUM_SHELLS; i++) {
    const col = i % cols;
    const x = xMargin + col * xStep + (Math.random() - 0.5) * 16;
    const t = i / (NUM_SHELLS - 1);
    const y = yMin + t * (yMax - yMin) + (Math.random() - 0.5) * 14;
    shells.push({ x, y, collected: false });
  }
}

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlay);
}

function hideOverlay(): void {
  hideOverlayEl(overlay);
}

function reset(): void {
  gen.bump();
  state = 'ready';
  score = 0;
  elapsedMs = 0;
  placeShells();
  scoreEl.textContent = '0';
  bestEl.textContent = String(best);
  timeEl.textContent = String(Math.ceil(GAME_TIME_MS / 1000));
  draw(0);
  showOverlay(
    'Med Cezir',
    'Dalga gelir gider. Bir kabuk yalnızca su tam o yükseklikten geçerken parlar — o anda tıkla.\n\nBaşlamak için tıkla veya Boşluk.',
  );
}

function startPlaying(): void {
  if (state !== 'ready') return;
  hideOverlay();
  state = 'playing';
  runStartMs = performance.now();
  elapsedMs = 0;
  const myGen = gen.current();
  requestAnimationFrame(() => loop(myGen));
}

function loop(myGen: number): void {
  if (!gen.isCurrent(myGen)) return;
  if (state !== 'playing') return;

  elapsedMs = performance.now() - runStartMs;
  const remainingSec = Math.max(0, Math.ceil((GAME_TIME_MS - elapsedMs) / 1000));
  timeEl.textContent = String(remainingSec);
  draw(elapsedMs);

  if (elapsedMs >= GAME_TIME_MS) {
    endGame(false);
    return;
  }
  if (shells.every((s) => s.collected)) {
    endGame(true);
    return;
  }
  requestAnimationFrame(() => loop(myGen));
}

function endGame(won: boolean): void {
  state = 'gameover';
  if (score > best) {
    best = score;
    safeWrite(STORAGE_KEY, best);
    bestEl.textContent = String(best);
  }
  draw(elapsedMs);
  if (won) {
    const usedSec = Math.ceil(elapsedMs / 1000);
    showOverlay(
      'Sahil temiz!',
      `${score}/${NUM_SHELLS} kabuk · ${usedSec} sn\n\nYeniden için tıkla ya da R.`,
    );
  } else {
    showOverlay(
      'Dalga geçti',
      `Süre doldu. Toplanan: ${score}/${NUM_SHELLS}\n\nYeniden için tıkla ya da R.`,
    );
  }
}

const cssCache = new Map<string, string>();
function getCss(name: string, fallback: string): string {
  const c = cssCache.get(name);
  if (c !== undefined) return c;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const out = v || fallback;
  cssCache.set(name, out);
  return out;
}

function draw(timeMs: number): void {
  const ty = tideY(timeMs);
  const sky = getCss('--mc-sky', '#0f1822');
  const sand = getCss('--mc-sand', '#caa468');
  const wave = getCss('--mc-wave', '#e6f4ff');
  const accent = getCss('--accent', '#ffd34a');

  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  ctx.fillStyle = sand;
  ctx.fillRect(0, ty, CANVAS_W, CANVAS_H - ty);

  // Water gradient over sand
  const wg = ctx.createLinearGradient(0, ty, 0, CANVAS_H);
  wg.addColorStop(0, 'rgba(58, 122, 168, 0.7)');
  wg.addColorStop(1, 'rgba(20, 60, 100, 0.85)');
  ctx.fillStyle = wg;
  ctx.fillRect(0, ty, CANVAS_W, CANVAS_H - ty);

  // Shoreline wave line
  ctx.strokeStyle = wave;
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let x = 0; x <= CANVAS_W; x += 3) {
    const ripple = Math.sin(timeMs / 240 + x * 0.045) * 2.4;
    const y = ty + ripple;
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Foamy band just above water
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  ctx.fillRect(0, ty - 3, CANVAS_W, 3);

  // Shells
  for (const s of shells) {
    if (s.collected) continue;
    const dist = Math.abs(s.y - ty);
    const inWindow = dist < SHELL_WINDOW;
    const underwater = s.y > ty;
    if (inWindow) {
      const pulse = 1 + 0.18 * Math.sin(timeMs * 0.014);
      const r = SHELL_RADIUS * pulse;
      const glow = ctx.createRadialGradient(s.x, s.y, r * 0.3, s.x, s.y, r * 2.2);
      glow.addColorStop(0, 'rgba(255,220,120,0.55)');
      glow.addColorStop(1, 'rgba(255,220,120,0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(s.x, s.y, r * 2.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#fff7d0';
      ctx.lineWidth = 2;
      ctx.stroke();
      drawShellLines(s.x, s.y, r, '#7a4a14');
    } else if (underwater) {
      ctx.fillStyle = 'rgba(245,235,200,0.25)';
      ctx.beginPath();
      ctx.arc(s.x, s.y, SHELL_RADIUS * 0.85, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillStyle = '#ede0b8';
      ctx.beginPath();
      ctx.arc(s.x, s.y, SHELL_RADIUS * 0.9, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(80,60,30,0.5)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      drawShellLines(s.x, s.y, SHELL_RADIUS * 0.9, 'rgba(80,60,30,0.55)');
    }
  }
}

function drawShellLines(cx: number, cy: number, r: number, color: string): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  for (let k = -2; k <= 2; k++) {
    ctx.beginPath();
    ctx.moveTo(cx, cy + r * 0.85);
    ctx.lineTo(cx + (k * r) / 3, cy - r * 0.6);
    ctx.stroke();
  }
}

function eventPos(e: PointerEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const sx = CANVAS_W / rect.width;
  const sy = CANVAS_H / rect.height;
  return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy };
}

function tryCollect(x: number, y: number): boolean {
  const ty = tideY(elapsedMs);
  let bestPick: { i: number; d: number } | null = null;
  for (let i = 0; i < shells.length; i++) {
    const s = shells[i]!;
    if (s.collected) continue;
    if (Math.abs(s.y - ty) >= SHELL_WINDOW) continue;
    const d = Math.hypot(s.x - x, s.y - y);
    if (d <= SHELL_RADIUS + CLICK_FORGIVENESS && (bestPick === null || d < bestPick.d)) {
      bestPick = { i, d };
    }
  }
  if (bestPick === null) return false;
  shells[bestPick.i]!.collected = true;
  score++;
  scoreEl.textContent = String(score);
  return true;
}

function onPointerDown(e: PointerEvent): void {
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
  // playing
  e.preventDefault();
  const { x, y } = eventPos(e);
  tryCollect(x, y);
}

function onKey(e: KeyboardEvent): void {
  const k = e.key.toLowerCase();
  if (k === 'r') {
    reset();
    e.preventDefault();
    return;
  }
  if (state === 'ready' && (k === ' ' || k === 'enter' || k === 'spacebar')) {
    startPlaying();
    e.preventDefault();
    return;
  }
  if (state === 'gameover' && (k === ' ' || k === 'enter' || k === 'spacebar')) {
    reset();
    e.preventDefault();
    return;
  }
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  timeEl = document.querySelector<HTMLElement>('#time')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;

  best = safeRead<number>(STORAGE_KEY, 0);

  canvas.addEventListener('pointerdown', onPointerDown);
  overlay.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('keydown', onKey);
  restartBtn.addEventListener('click', reset);

  reset();
}

export const game = defineGame({ init, reset });
