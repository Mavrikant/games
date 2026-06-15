import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay, hideOverlay } from '@shared/overlay';

// PITFALLS guarded here (see docs/PITFALLS.md):
// - unguarded-storage: best score via safeRead/safeWrite.
// - stale-async-callback: reveal -> nextRound setTimeout is bound to gen token;
//   restart bumps it so the pending advance never lands on a fresh round.
// - overlay-input-leak: explicit State enum; slider + Enter are gated by state.
// - invisible-boot: reset() draws the ready frame and shows the start overlay
//   synchronously so the page shows content within one frame of init().
// - module-level-dom-access: all DOM/storage access lives in init().

const STORAGE_BEST = 'aci-gozu.best';
const ROUNDS = 10;
const MAX_PTS = 100;
const PT_PER_DEG = 5;
const REVEAL_MS = 1700;
const MIN_ANGLE = 10;
const MAX_ANGLE = 170;

type State = 'ready' | 'guessing' | 'reveal' | 'gameover';

const gen = createGenToken();
let state: State = 'ready';
let roundIdx = 0;
let actual = 0; // target angle in degrees, [MIN_ANGLE, MAX_ANGLE]
let baseAngle = 0; // orientation of first ray in radians
let guess = 90;
let lastErr = 0;
let lastPts = 0;
let totalScore = 0;
let best = 0;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let roundEl!: HTMLElement;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let guessValEl!: HTMLElement;
let guessRange!: HTMLInputElement;
let submitBtn!: HTMLButtonElement;
let restartBtn!: HTMLButtonElement;
let feedbackEl!: HTMLElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayBtn!: HTMLButtonElement;

const cssCache = new Map<string, string>();
function css(name: string): string {
  const cached = cssCache.get(name);
  if (cached !== undefined) return cached;
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  cssCache.set(name, v);
  return v;
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pickRound(): void {
  // Avoid trivially round numbers (multiples of 15) half the time so we
  // don't reward people who only remember the cardinal landmarks.
  let a = randInt(MIN_ANGLE, MAX_ANGLE);
  if (a % 15 === 0 && Math.random() < 0.5) {
    a = a + (Math.random() < 0.5 ? -1 : 1) * randInt(2, 5);
    a = Math.max(MIN_ANGLE, Math.min(MAX_ANGLE, a));
  }
  actual = a;
  baseAngle = Math.random() * Math.PI * 2;
  guess = 90;
}

function clearCanvas(): void {
  ctx.fillStyle = css('--surface') || '#13151a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

function drawRays(reveal: boolean): void {
  const w = canvas.width;
  const h = canvas.height;
  clearCanvas();

  const cx = w / 2;
  const cy = h / 2 + 10;
  const r = Math.min(w, h) * 0.42;

  const ref = css('--accent') || '#fbbf24';
  const guessColor = '#34d399';
  const labelColor = css('--text') || '#e5e7eb';
  const dimColor = css('--text-dim') || '#8b8e98';

  const r1 = baseAngle;
  const r2 = baseAngle + (actual * Math.PI) / 180;

  ctx.strokeStyle = ref;
  ctx.lineCap = 'round';
  ctx.lineWidth = 5;
  for (const a of [r1, r2]) {
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    ctx.stroke();
  }

  ctx.fillStyle = ref;
  for (const a of [r1, r2]) {
    ctx.beginPath();
    ctx.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 5, 0, Math.PI * 2);
    ctx.fill();
  }

  if (reveal) {
    ctx.strokeStyle = ref;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.32, r1, r2);
    ctx.stroke();

    const gEnd = r1 + (guess * Math.PI) / 180;
    ctx.save();
    ctx.strokeStyle = guessColor;
    ctx.lineWidth = 3;
    ctx.setLineDash([10, 6]);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(gEnd) * r * 0.95, cy + Math.sin(gEnd) * r * 0.95);
    ctx.stroke();
    ctx.restore();

    const bisect = r1 + (actual * Math.PI) / 360;
    const labelR = r * 0.5;
    const lx = cx + Math.cos(bisect) * labelR;
    const ly = cy + Math.sin(bisect) * labelR;
    ctx.fillStyle = labelColor;
    ctx.font = '700 22px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${actual}°`, lx, ly);

    ctx.fillStyle = dimColor;
    ctx.font = '600 13px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(`Senin: ${guess}°`, 14, h - 14);
    ctx.textAlign = 'right';
    ctx.fillText(`Sapma: ${lastErr}°`, w - 14, h - 14);
  }

  ctx.fillStyle = ref;
  ctx.beginPath();
  ctx.arc(cx, cy, 7, 0, Math.PI * 2);
  ctx.fill();
}

function drawReady(): void {
  clearCanvas();
  const w = canvas.width;
  const h = canvas.height;
  ctx.fillStyle = css('--text-dim') || '#8b8e98';
  ctx.font = '500 16px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('Başla\'ya bas', w / 2, h / 2);
}

function renderHud(): void {
  roundEl.textContent = `${Math.min(roundIdx + 1, ROUNDS)}/${ROUNDS}`;
  scoreEl.textContent = String(totalScore);
  bestEl.textContent = String(best);
  guessValEl.textContent = String(guess);
  guessRange.value = String(guess);
}

function renderControlState(): void {
  const interactive = state === 'guessing';
  submitBtn.disabled = !interactive;
  guessRange.disabled = !interactive;
}

function setFeedback(msg: string): void {
  feedbackEl.textContent = msg;
}

function startGame(): void {
  gen.bump();
  state = 'guessing';
  roundIdx = 0;
  totalScore = 0;
  pickRound();
  hideOverlay(overlay);
  renderHud();
  renderControlState();
  drawRays(false);
  setFeedback('Tahmin et ve Enter\'a bas.');
}

function nextRound(): void {
  state = 'guessing';
  pickRound();
  renderHud();
  renderControlState();
  drawRays(false);
  setFeedback('Tahmin et ve Enter\'a bas.');
}

function submit(): void {
  if (state !== 'guessing') return;
  lastErr = Math.abs(actual - guess);
  lastPts = Math.max(0, MAX_PTS - PT_PER_DEG * lastErr);
  totalScore += lastPts;
  state = 'reveal';
  renderHud();
  renderControlState();
  drawRays(true);
  setFeedback(`Doğru: ${actual}° · Sapma: ${lastErr}° · Puan: +${lastPts}`);

  const myGen = gen.current();
  setTimeout(() => {
    if (!gen.isCurrent(myGen)) return;
    roundIdx++;
    if (roundIdx >= ROUNDS) {
      endGame();
    } else {
      nextRound();
    }
  }, REVEAL_MS);
}

function endGame(): void {
  state = 'gameover';
  if (totalScore > best) {
    best = totalScore;
    safeWrite(STORAGE_BEST, best);
  }
  renderHud();
  renderControlState();
  setFeedback('');
  const max = ROUNDS * MAX_PTS;
  overlayTitle.textContent = 'Oyun bitti';
  overlayMsg.textContent = `Toplam: ${totalScore} / ${max}\nRekor: ${best} / ${max}`;
  overlayBtn.textContent = 'Tekrar oyna';
  showOverlay(overlay);
}

function reset(): void {
  gen.bump();
  state = 'ready';
  roundIdx = 0;
  totalScore = 0;
  guess = 90;
  lastErr = 0;
  lastPts = 0;
  renderHud();
  renderControlState();
  drawReady();
  setFeedback('');
  overlayTitle.textContent = 'Açı Gözü';
  overlayMsg.textContent =
    'İki ışının arasındaki açıyı tahmin et. 10 tur boyunca biriken toplam skorun rekorun olur.';
  overlayBtn.textContent = 'Başla';
  showOverlay(overlay);
}

function onSlider(): void {
  if (state !== 'guessing') return;
  const v = Number(guessRange.value);
  if (Number.isFinite(v)) {
    guess = Math.max(1, Math.min(179, Math.round(v)));
    guessValEl.textContent = String(guess);
  }
}

function nudgeGuess(delta: number): void {
  if (state !== 'guessing') return;
  guess = Math.max(1, Math.min(179, guess + delta));
  guessValEl.textContent = String(guess);
  guessRange.value = String(guess);
}

function onKey(e: KeyboardEvent): void {
  if (e.key.toLowerCase() === 'r') {
    e.preventDefault();
    reset();
    return;
  }

  if (state === 'ready' || state === 'gameover') {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      startGame();
    }
    return;
  }

  if (state === 'reveal') {
    return;
  }

  if (e.key === 'Enter') {
    e.preventDefault();
    submit();
    return;
  }
  const step = e.shiftKey ? 5 : 1;
  if (e.key === 'ArrowLeft' || e.key.toLowerCase() === 'a') {
    e.preventDefault();
    nudgeGuess(-step);
  } else if (e.key === 'ArrowRight' || e.key.toLowerCase() === 'd') {
    e.preventDefault();
    nudgeGuess(step);
  }
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  roundEl = document.querySelector<HTMLElement>('#round')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  guessValEl = document.querySelector<HTMLElement>('#guess-val')!;
  guessRange = document.querySelector<HTMLInputElement>('#guess-range')!;
  submitBtn = document.querySelector<HTMLButtonElement>('#submit-btn')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  feedbackEl = document.querySelector<HTMLElement>('#feedback')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  guessRange.addEventListener('input', onSlider);
  submitBtn.addEventListener('click', submit);
  overlayBtn.addEventListener('click', startGame);
  restartBtn.addEventListener('click', reset);
  window.addEventListener('keydown', onKey);

  reset();
}

export const game = defineGame({ init, reset });
