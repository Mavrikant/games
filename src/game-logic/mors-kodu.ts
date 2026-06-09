import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay, hideOverlay } from '@shared/overlay';
import { reportGameOver } from '@shared/leaderboard';

// Mors Kodu — bir harf morse koduyla yayınlanır, oyuncu 4 seçenekten doğru harfi seçer.
//
// Pitfall önlemleri (docs/PITFALLS.md):
//  - module-level-dom-access: tüm DOM erişimi init() içinde, defineGame() ile bind.
//  - unguarded-storage: safeRead/safeWrite ile try/catch sarmalı.
//  - stale-async-callback: signal playback ve timer setTimeout chain'leri gen
//    token ile iptal. reset() ve replay() gen.bump() çağırır; her async callback
//    başında gen.isCurrent(token) ile kontrol eder.
//  - overlay-input-leak: state enum ('ready' | 'transmitting' | 'waiting' |
//    'feedback' | 'gameover'). Her input handler en başta state guard yapar.
//  - missing-overlay-css: CSS'te .overlay--hidden tanımlı.
//  - invisible-boot: init() içinde resetGame() çağrılır, ilk sinyal microtask
//    sonrasında 120ms içinde başlar; HUD ve seçenekler hemen render edilir.
//  - hud-counter-synced-only-at-lifecycle-edges: her score/level/lives mutasyonu
//    ardından renderHud() çağrılır.
//  - visual-vs-hitbox: DOM buttonları kullanılır, görsel = hitbox.

// ---- Sabitler ----

const STARTING_LIVES = 3;
const ANSWER_TIMEOUT_MS = 10_000;
const TICK_MS = 100;
const FEEDBACK_MS = 700;
const LEVEL_UP_EVERY = 5;
const OPTION_COUNT = 4;
const STORAGE_BEST = 'mors-kodu.best';
const STORAGE_CHART = 'mors-kodu.chart-open';
const SCORE_DESC = {
  gameId: 'mors-kodu',
  storageKey: STORAGE_BEST,
  direction: 'higher' as const,
};

// Uluslararası mors alfabesi (A-Z).
const MORSE: Readonly<Record<string, string>> = {
  A: '.-',
  B: '-...',
  C: '-.-.',
  D: '-..',
  E: '.',
  F: '..-.',
  G: '--.',
  H: '....',
  I: '..',
  J: '.---',
  K: '-.-',
  L: '.-..',
  M: '--',
  N: '-.',
  O: '---',
  P: '.--.',
  Q: '--.-',
  R: '.-.',
  S: '...',
  T: '-',
  U: '..-',
  V: '...-',
  W: '.--',
  X: '-..-',
  Y: '-.--',
  Z: '--..',
};

// Seviyeye göre kullanılabilir harf havuzu.
const LEVEL_POOLS: ReadonlyArray<readonly string[]> = [
  // L1 — tek/iki sembol.
  ['E', 'T', 'A', 'N', 'I', 'M'],
  // L2 — üç sembollü harfler eklenir.
  ['E', 'T', 'A', 'N', 'I', 'M', 'S', 'U', 'R', 'W', 'D', 'K', 'G', 'O'],
  // L3 — dört sembollü harflerin yarısı eklenir.
  [
    'E', 'T', 'A', 'N', 'I', 'M', 'S', 'U', 'R', 'W', 'D', 'K', 'G', 'O',
    'H', 'V', 'F', 'L', 'P', 'J', 'B', 'X',
  ],
  // L4+ — tüm 26 harf.
  Object.keys(MORSE),
];

// Seviyeye göre timing (ms).
interface Timing {
  dot: number;
  dash: number;
  gap: number;
}
const TIMINGS: ReadonlyArray<Timing> = [
  { dot: 340, dash: 900, gap: 340 }, // L1
  { dot: 280, dash: 760, gap: 280 }, // L2
  { dot: 230, dash: 620, gap: 230 }, // L3
  { dot: 190, dash: 500, gap: 190 }, // L4
  { dot: 160, dash: 420, gap: 160 }, // L5+
];

// ---- DOM refs ----

let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let livesEl!: HTMLElement;
let levelEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let chartToggleBtn!: HTMLButtonElement;
let promptEl!: HTMLElement;
let timerBarEl!: HTMLElement;
let lampEl!: HTMLElement;
let signalTrailEl!: HTMLElement;
let optionButtons: HTMLButtonElement[] = [];
let replayBtn!: HTMLButtonElement;
let chartEl!: HTMLElement;
let chartGridEl!: HTMLElement;
let overlayEl!: HTMLElement;
let overlayTitleEl!: HTMLElement;
let overlayMsgEl!: HTMLElement;
let overlayRestartBtn!: HTMLButtonElement;

// ---- State ----

type GameState = 'ready' | 'transmitting' | 'waiting' | 'feedback' | 'gameover';

let state: GameState = 'ready';
let score = 0;
let best = 0;
let lives = STARTING_LIVES;
let level = 1;
let correctStreak = 0;
let currentAnswer = 'E';
let currentOptions: string[] = ['E', 'T', 'A', 'N'];
let correctIndex = 0;
let feedbackIdx: number | null = null;
let feedbackKind: 'correct' | 'wrong' | null = null;

const gen = createGenToken();
let tickHandle: number | null = null;
let waitStart = 0;

// ---- Helpers ----

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)] as T;
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = a[i] as T;
    a[i] = a[j] as T;
    a[j] = tmp;
  }
  return a;
}

function getPool(): readonly string[] {
  const idx = Math.max(0, Math.min(LEVEL_POOLS.length - 1, level - 1));
  return LEVEL_POOLS[idx] as readonly string[];
}

function getTiming(): Timing {
  const idx = Math.max(0, Math.min(TIMINGS.length - 1, level - 1));
  return TIMINGS[idx] as Timing;
}

// ---- Render ----

function renderHud(): void {
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
  levelEl.textContent = String(level);
  const filled = '●'.repeat(Math.max(0, lives));
  const empty = '○'.repeat(Math.max(0, STARTING_LIVES - lives));
  livesEl.textContent = filled + empty;
}

function renderOptions(): void {
  for (let i = 0; i < OPTION_COUNT; i++) {
    const btn = optionButtons[i];
    const letter = currentOptions[i];
    if (!btn || letter === undefined) continue;
    const letterSpan = btn.querySelector<HTMLElement>('.mk-option__letter');
    if (letterSpan) letterSpan.textContent = letter;
    btn.disabled = state !== 'waiting';
    btn.classList.toggle(
      'mk-option--correct',
      feedbackIdx === i && feedbackKind === 'correct',
    );
    btn.classList.toggle(
      'mk-option--wrong',
      feedbackIdx === i && feedbackKind === 'wrong',
    );
    btn.classList.toggle(
      'mk-option--reveal',
      feedbackKind === 'wrong' && i === correctIndex,
    );
  }
}

function renderPrompt(): void {
  switch (state) {
    case 'transmitting':
      promptEl.textContent = 'Sinyali izle…';
      break;
    case 'waiting':
      promptEl.textContent = 'Hangi harf yayınlandı?';
      break;
    case 'feedback':
      promptEl.textContent =
        feedbackKind === 'correct'
          ? 'Doğru! Sıradaki sinyal…'
          : `Yanlış. Doğru cevap: ${currentAnswer}`;
      break;
    case 'gameover':
      promptEl.textContent = 'Oyun bitti';
      break;
    default:
      promptEl.textContent = 'Hazırlanılıyor…';
  }
}

function renderTimer(elapsedMs: number): void {
  const ratio = Math.max(0, 1 - elapsedMs / ANSWER_TIMEOUT_MS);
  timerBarEl.style.transform = `scaleX(${ratio.toFixed(4)})`;
  timerBarEl.classList.toggle('timer__bar--warn', ratio < 0.34);
}

function setTimerFull(): void {
  timerBarEl.style.transform = 'scaleX(1)';
  timerBarEl.classList.remove('timer__bar--warn');
}

function setTimerEmpty(): void {
  timerBarEl.style.transform = 'scaleX(0)';
  timerBarEl.classList.remove('timer__bar--warn');
}

function setLamp(on: boolean): void {
  lampEl.classList.toggle('lamp--on', on);
}

function setSignalTrail(symbols: string): void {
  signalTrailEl.textContent = symbols
    .replaceAll('.', '•')
    .replaceAll('-', '—');
}

function renderAll(): void {
  renderHud();
  renderOptions();
  renderPrompt();
}

// ---- Round flow ----

function nextRound(): void {
  gen.bump();
  stopTimer();
  feedbackIdx = null;
  feedbackKind = null;
  setLamp(false);
  setSignalTrail('');
  setTimerEmpty();

  const pool = getPool();
  currentAnswer = pick(pool);

  // 3 distractor + 1 doğru cevap.
  const poolWithoutAnswer = pool.filter((l) => l !== currentAnswer);
  const distractors = shuffle([...poolWithoutAnswer]).slice(0, OPTION_COUNT - 1);
  while (distractors.length < OPTION_COUNT - 1) {
    const cand = pick(Object.keys(MORSE));
    if (cand !== currentAnswer && !distractors.includes(cand)) {
      distractors.push(cand);
    }
  }
  currentOptions = shuffle([currentAnswer, ...distractors]);
  correctIndex = currentOptions.indexOf(currentAnswer);

  state = 'transmitting';
  renderAll();

  // Kısa bir gap, sonra sinyali yayınla. invisible-boot guard'ı: HUD ve butonlar
  // hemen renderlanıyor; 120ms sonra lamba çakmaya başlıyor.
  const token = gen.current();
  window.setTimeout(() => {
    if (!gen.isCurrent(token)) return;
    if (state !== 'transmitting') return;
    transmit(currentAnswer, token);
  }, 120);
}

function transmit(letter: string, token: number): void {
  const code = MORSE[letter];
  if (!code) return;
  const timing = getTiming();
  let i = 0;
  let revealed = '';

  function playNext(): void {
    if (!gen.isCurrent(token)) return;
    if (state !== 'transmitting') return;
    if (i >= code.length) {
      finishTransmission(token);
      return;
    }
    const sym = code[i] as string;
    const onDur = sym === '.' ? timing.dot : timing.dash;
    revealed += sym;
    setLamp(true);
    setSignalTrail(revealed);
    window.setTimeout(() => {
      if (!gen.isCurrent(token)) return;
      if (state !== 'transmitting') return;
      setLamp(false);
      i++;
      if (i >= code.length) {
        // Son sembolden sonra biraz nefes ver, sonra bekleme moduna geç.
        window.setTimeout(() => {
          if (!gen.isCurrent(token)) return;
          if (state !== 'transmitting') return;
          finishTransmission(token);
        }, 250);
        return;
      }
      window.setTimeout(playNext, timing.gap);
    }, onDur);
  }

  playNext();
}

function finishTransmission(token: number): void {
  if (!gen.isCurrent(token)) return;
  if (state !== 'transmitting') return;
  setLamp(false);
  state = 'waiting';
  renderAll();
  startAnswerTimer();
}

function startAnswerTimer(): void {
  waitStart = performance.now();
  setTimerFull();
  renderTimer(0);
  replayBtn.disabled = false;
  const token = gen.current();
  const tick = (): void => {
    if (!gen.isCurrent(token) || state !== 'waiting') return;
    const elapsed = performance.now() - waitStart;
    if (elapsed >= ANSWER_TIMEOUT_MS) {
      renderTimer(ANSWER_TIMEOUT_MS);
      timeout();
      return;
    }
    renderTimer(elapsed);
    tickHandle = window.setTimeout(tick, TICK_MS);
  };
  tickHandle = window.setTimeout(tick, TICK_MS);
}

function stopTimer(): void {
  if (tickHandle !== null) {
    clearTimeout(tickHandle);
    tickHandle = null;
  }
  replayBtn.disabled = true;
}

function timeout(): void {
  if (state !== 'waiting') return;
  applyWrong(null);
}

function pickOption(idx: number): void {
  if (state !== 'waiting') return;
  if (idx < 0 || idx >= OPTION_COUNT) return;
  const chosen = currentOptions[idx];
  if (chosen === undefined) return;
  stopTimer();
  if (chosen === currentAnswer) {
    applyCorrect(idx);
  } else {
    applyWrong(idx);
  }
}

function applyCorrect(idx: number): void {
  score++;
  correctStreak++;
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
  feedbackIdx = idx;
  feedbackKind = 'correct';
  state = 'feedback';
  if (correctStreak >= LEVEL_UP_EVERY) {
    level++;
    correctStreak = 0;
  }
  renderAll();
  const token = gen.current();
  window.setTimeout(() => {
    if (!gen.isCurrent(token)) return;
    if (state !== 'feedback') return;
    nextRound();
  }, FEEDBACK_MS);
}

function applyWrong(idx: number | null): void {
  lives--;
  feedbackIdx = idx;
  feedbackKind = 'wrong';
  state = 'feedback';
  correctStreak = 0;
  renderAll();
  if (lives <= 0) {
    const token = gen.current();
    window.setTimeout(() => {
      if (!gen.isCurrent(token)) return;
      gameOver();
    }, FEEDBACK_MS);
    return;
  }
  const token = gen.current();
  window.setTimeout(() => {
    if (!gen.isCurrent(token)) return;
    if (state !== 'feedback') return;
    nextRound();
  }, FEEDBACK_MS);
}

function gameOver(): void {
  state = 'gameover';
  stopTimer();
  setLamp(false);
  reportGameOver(SCORE_DESC, score);
  renderAll();
  overlayTitleEl.textContent =
    score > 0 && score === best ? 'Yeni rekor!' : 'Oyun bitti';
  overlayMsgEl.textContent =
    score === 0
      ? 'Hiç doğru cevap veremedin. Tekrar dene!'
      : `${score} doğru. En iyi: ${best}.`;
  showOverlay(overlayEl);
  try {
    overlayRestartBtn.focus({ preventScroll: true });
  } catch {
    /* ignore */
  }
}

function replaySignal(): void {
  if (state !== 'waiting') return;
  stopTimer();
  setLamp(false);
  setSignalTrail('');
  state = 'transmitting';
  renderAll();
  gen.bump();
  const token = gen.current();
  window.setTimeout(() => {
    if (!gen.isCurrent(token)) return;
    if (state !== 'transmitting') return;
    transmit(currentAnswer, token);
  }, 100);
}

function resetGame(): void {
  gen.bump();
  stopTimer();
  hideOverlay(overlayEl);
  state = 'ready';
  score = 0;
  lives = STARTING_LIVES;
  level = 1;
  correctStreak = 0;
  feedbackIdx = null;
  feedbackKind = null;
  setLamp(false);
  setSignalTrail('');
  setTimerEmpty();
  renderAll();
  nextRound();
}

// ---- Cheat sheet ----

function renderChart(): void {
  chartGridEl.innerHTML = '';
  const letters = Object.keys(MORSE);
  for (const letter of letters) {
    const row = document.createElement('div');
    row.className = 'mk-chart__row';
    const l = document.createElement('span');
    l.className = 'mk-chart__letter';
    l.textContent = letter;
    const c = document.createElement('span');
    c.className = 'mk-chart__code';
    c.textContent = (MORSE[letter] as string)
      .replaceAll('.', '•')
      .replaceAll('-', '—');
    row.appendChild(l);
    row.appendChild(c);
    chartGridEl.appendChild(row);
  }
}

function setChartOpen(open: boolean): void {
  chartEl.classList.toggle('mk-chart--hidden', !open);
  chartEl.setAttribute('aria-hidden', open ? 'false' : 'true');
  chartToggleBtn.setAttribute('aria-pressed', open ? 'true' : 'false');
  chartToggleBtn.classList.toggle('hud__btn--active', open);
  safeWrite(STORAGE_CHART, open);
}

function toggleChart(): void {
  const isOpen = !chartEl.classList.contains('mk-chart--hidden');
  setChartOpen(!isOpen);
}

// ---- Init ----

function init(): void {
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  livesEl = document.querySelector<HTMLElement>('#lives')!;
  levelEl = document.querySelector<HTMLElement>('#level')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  chartToggleBtn = document.querySelector<HTMLButtonElement>('#chart-toggle')!;
  promptEl = document.querySelector<HTMLElement>('#prompt')!;
  timerBarEl = document.querySelector<HTMLElement>('#timer-bar')!;
  lampEl = document.querySelector<HTMLElement>('#lamp')!;
  signalTrailEl = document.querySelector<HTMLElement>('#signal-trail')!;
  optionButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>('.mk-option'),
  );
  replayBtn = document.querySelector<HTMLButtonElement>('#replay')!;
  chartEl = document.querySelector<HTMLElement>('#chart')!;
  chartGridEl = document.querySelector<HTMLElement>('#chart-grid')!;
  overlayEl = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitleEl = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsgEl = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayRestartBtn = document.querySelector<HTMLButtonElement>('#overlay-restart')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  restartBtn.addEventListener('click', resetGame);
  overlayRestartBtn.addEventListener('click', resetGame);
  chartToggleBtn.addEventListener('click', toggleChart);
  replayBtn.addEventListener('click', replaySignal);

  optionButtons.forEach((btn, i) => {
    btn.addEventListener('click', () => pickOption(i));
  });

  window.addEventListener('keydown', (event) => {
    const k = event.key;
    if (k === 'r' || k === 'R') {
      resetGame();
      event.preventDefault();
      return;
    }
    if (k === ' ' || k === 'Spacebar') {
      replaySignal();
      event.preventDefault();
      return;
    }
    if (k >= '1' && k <= '4') {
      pickOption(Number(k) - 1);
      event.preventDefault();
      return;
    }
  });

  renderChart();
  const chartOpen = safeRead<boolean>(STORAGE_CHART, false);
  setChartOpen(chartOpen);

  resetGame();
}

export const game = defineGame({ init, reset: resetGame });
