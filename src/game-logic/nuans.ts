import { defineGame } from '@shared/game-module';
import { safeRead } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay, hideOverlay } from '@shared/overlay';
import { recordScore } from '@shared/leaderboard';

// PITFALLS guarded here (docs/PITFALLS.md):
// - unguarded-storage: best score via safeRead; recordScore writes via safeWrite.
// - stale-async-callback: every peek/reveal timeout binds to a generation token
//   that startSeries()/reset() bump, so old timers no-op after restart.
// - overlay-input-leak: explicit Phase enum; sliders only respond in 'cover',
//   keyboard restart/start guarded per state.
// - missing-overlay-css: per-game CSS defines .overlay--hidden and
//   .nu-swatch__cover--hidden visual rules.
// - module-level-dom-access: every querySelector + listener lives in init().

const STORAGE_BEST = 'nuans.best';
const SCORE_DESC = {
  gameId: 'nuans',
  storageKey: STORAGE_BEST,
  direction: 'higher' as const,
};

const HAND_COUNT = 8;
const PEEK_MS: readonly number[] = [1600, 1500, 1300, 1100, 950, 800, 700, 600];
const REVEAL_MS = 1700;
const MAX_DIST = Math.sqrt(255 * 255 * 3); // ≈441.67

type Phase = 'ready' | 'peek' | 'cover' | 'reveal' | 'done';
type RGB = { r: number; g: number; b: number };

const gen = createGenToken();
let phase: Phase = 'ready';
let hand = 0; // 0-based; HUD shows hand+1
let totalScore = 0;
let best = 0;
let target: RGB = { r: 128, g: 128, b: 128 };
let guess: RGB = { r: 128, g: 128, b: 128 };

let handEl!: HTMLElement;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let handScoreEl!: HTMLElement;
let statusEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let lockBtn!: HTMLButtonElement;
let startBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let targetSwatch!: HTMLElement;
let guessSwatch!: HTMLElement;
let targetCover!: HTMLElement;
let sliderR!: HTMLInputElement;
let sliderG!: HTMLInputElement;
let sliderB!: HTMLInputElement;
let valueR!: HTMLElement;
let valueG!: HTMLElement;
let valueB!: HTMLElement;

function rgbToCss({ r, g, b }: RGB): string {
  return `rgb(${r}, ${g}, ${b})`;
}

function randomTarget(): RGB {
  // Bias away from low-contrast greys: at least one channel must differ from
  // the rest by ≥35, and avoid pitch black/white. After 32 rejections fall
  // back to a known-good color.
  for (let i = 0; i < 32; i++) {
    const r = Math.floor(Math.random() * 256);
    const g = Math.floor(Math.random() * 256);
    const b = Math.floor(Math.random() * 256);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max - min < 35) continue;
    if (max < 40 || min > 215) continue;
    return { r, g, b };
  }
  return { r: 200, g: 80, b: 40 };
}

function computeScore(t: RGB, g_: RGB): number {
  const dr = t.r - g_.r;
  const dg = t.g - g_.g;
  const db = t.b - g_.b;
  const dist = Math.sqrt(dr * dr + dg * dg + db * db);
  const raw = 100 * (1 - dist / MAX_DIST);
  return Math.max(0, Math.round(raw));
}

function setStatus(msg: string): void {
  statusEl.textContent = msg;
}

function setSlidersDisabled(disabled: boolean): void {
  sliderR.disabled = disabled;
  sliderG.disabled = disabled;
  sliderB.disabled = disabled;
  lockBtn.disabled = disabled;
}

function syncSlidersFromGuess(): void {
  sliderR.value = String(guess.r);
  sliderG.value = String(guess.g);
  sliderB.value = String(guess.b);
  valueR.textContent = String(guess.r);
  valueG.textContent = String(guess.g);
  valueB.textContent = String(guess.b);
}

function renderGuessSwatch(): void {
  guessSwatch.style.background = rgbToCss(guess);
}

function renderTargetSwatch(): void {
  targetSwatch.style.background = rgbToCss(target);
}

function setCover(covered: boolean): void {
  targetCover.classList.toggle('nu-swatch__cover--hidden', !covered);
  targetSwatch.classList.toggle('nu-swatch--covered', covered);
}

function updateHud(): void {
  handEl.textContent = `${Math.min(hand + 1, HAND_COUNT)}/${HAND_COUNT}`;
  scoreEl.textContent = String(totalScore);
  bestEl.textContent = String(best);
}

function startHand(): void {
  const myGen = gen.current();
  phase = 'peek';
  guess = { r: 128, g: 128, b: 128 };
  syncSlidersFromGuess();
  renderGuessSwatch();
  target = randomTarget();
  renderTargetSwatch();
  setCover(false);
  setSlidersDisabled(true);
  handScoreEl.textContent = '—';
  updateHud();
  const peekDur = PEEK_MS[hand] ?? 600;
  setStatus(`Bak ve ezberle… (${(peekDur / 1000).toFixed(1)}s)`);

  setTimeout(() => {
    if (!gen.isCurrent(myGen)) return;
    if (phase !== 'peek') return;
    enterCover();
  }, peekDur);
}

function enterCover(): void {
  phase = 'cover';
  setCover(true);
  setSlidersDisabled(false);
  setStatus('Sürgülerle rengi yeniden inşa et, KİLİTLE bas.');
}

function lockIn(): void {
  if (phase !== 'cover') return;
  phase = 'reveal';
  setSlidersDisabled(true);
  setCover(false);
  const handScore = computeScore(target, guess);
  totalScore += handScore;
  handScoreEl.textContent = String(handScore);
  const dr = guess.r - target.r;
  const dg = guess.g - target.g;
  const db = guess.b - target.b;
  setStatus(
    `Bu el: ${handScore} puan · ΔR ${dr >= 0 ? '+' : ''}${dr} · ΔG ${
      dg >= 0 ? '+' : ''
    }${dg} · ΔB ${db >= 0 ? '+' : ''}${db}`,
  );
  updateHud();

  const myGen = gen.current();
  setTimeout(() => {
    if (!gen.isCurrent(myGen)) return;
    if (phase !== 'reveal') return;
    hand += 1;
    if (hand >= HAND_COUNT) {
      finishSeries();
    } else {
      startHand();
    }
  }, REVEAL_MS);
}

function finishSeries(): void {
  phase = 'done';
  setSlidersDisabled(true);
  recordScore(SCORE_DESC, totalScore);
  if (totalScore > best) best = totalScore;
  updateHud();
  overlayTitle.textContent = 'Seri bitti';
  overlayMsg.textContent = `Toplam puan: ${totalScore}/${HAND_COUNT * 100}\nRekor: ${best}\nYeni seri için BAŞLA'ya bas.`;
  startBtn.textContent = 'TEKRAR OYNA';
  showOverlay(overlay);
  setStatus(`Seri bitti — ${totalScore} puan.`);
}

function startSeries(): void {
  gen.bump();
  hand = 0;
  totalScore = 0;
  handScoreEl.textContent = '—';
  hideOverlay(overlay);
  updateHud();
  startHand();
}

function reset(): void {
  gen.bump();
  phase = 'ready';
  hand = 0;
  totalScore = 0;
  guess = { r: 128, g: 128, b: 128 };
  target = { r: 128, g: 128, b: 128 };
  syncSlidersFromGuess();
  renderGuessSwatch();
  renderTargetSwatch();
  setCover(true);
  setSlidersDisabled(true);
  handScoreEl.textContent = '—';
  updateHud();
  overlayTitle.textContent = 'Nüans';
  overlayMsg.textContent =
    "8 elde hedef renkleri kısa süre gör, sonra R/G/B sürgüleriyle ezberden yeniden üret. Sapman ne kadar azsa puan o kadar yüksek.";
  startBtn.textContent = 'BAŞLA';
  showOverlay(overlay);
  setStatus("Başlamak için BAŞLA'ya bas.");
}

function onSliderInput(channel: 'r' | 'g' | 'b', value: number): void {
  if (phase !== 'cover') return;
  const v = Math.max(0, Math.min(255, Math.round(value)));
  guess[channel] = v;
  if (channel === 'r') valueR.textContent = String(v);
  else if (channel === 'g') valueG.textContent = String(v);
  else valueB.textContent = String(v);
  renderGuessSwatch();
}

function onKey(e: KeyboardEvent): void {
  const key = e.key;
  if (key === 'r' || key === 'R') {
    e.preventDefault();
    reset();
    return;
  }
  if (key === 'n' || key === 'N') {
    e.preventDefault();
    startSeries();
    return;
  }
  if (phase === 'ready' || phase === 'done') {
    if (key === ' ' || key === 'Enter') {
      e.preventDefault();
      startSeries();
    }
    return;
  }
  if (phase === 'cover') {
    if (key === 'Enter') {
      e.preventDefault();
      lockIn();
      return;
    }
  }
}

function init(): void {
  handEl = document.querySelector<HTMLElement>('#hand')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  handScoreEl = document.querySelector<HTMLElement>('#hand-score')!;
  statusEl = document.querySelector<HTMLElement>('#status-msg')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  lockBtn = document.querySelector<HTMLButtonElement>('#lock-btn')!;
  startBtn = document.querySelector<HTMLButtonElement>('#start-btn')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  targetSwatch = document.querySelector<HTMLElement>('#target-swatch')!;
  guessSwatch = document.querySelector<HTMLElement>('#guess-swatch')!;
  targetCover = document.querySelector<HTMLElement>('#target-cover')!;
  sliderR = document.querySelector<HTMLInputElement>('#slider-r')!;
  sliderG = document.querySelector<HTMLInputElement>('#slider-g')!;
  sliderB = document.querySelector<HTMLInputElement>('#slider-b')!;
  valueR = document.querySelector<HTMLElement>('#value-r')!;
  valueG = document.querySelector<HTMLElement>('#value-g')!;
  valueB = document.querySelector<HTMLElement>('#value-b')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  restartBtn.addEventListener('click', reset);
  lockBtn.addEventListener('click', lockIn);
  startBtn.addEventListener('click', startSeries);
  sliderR.addEventListener('input', () =>
    onSliderInput('r', Number(sliderR.value)),
  );
  sliderG.addEventListener('input', () =>
    onSliderInput('g', Number(sliderG.value)),
  );
  sliderB.addEventListener('input', () =>
    onSliderInput('b', Number(sliderB.value)),
  );
  document.addEventListener('keydown', onKey);

  reset();
}

export const game = defineGame({ init, reset });
