import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';

const STORAGE_BEST = 'sihirli-kutu.best';
const MAX_TESTS = 4;
const PREDICTIONS_REQUIRED = 2;
const LEVEL_TRANSITION_MS = 1100;

type FunctionDef = { label: string; fn: (x: number) => number };

const TIERS: FunctionDef[][] = [
  [
    { label: 'x + 1', fn: (x) => x + 1 },
    { label: 'x + 2', fn: (x) => x + 2 },
    { label: 'x + 3', fn: (x) => x + 3 },
    { label: 'x + 4', fn: (x) => x + 4 },
    { label: 'x + 5', fn: (x) => x + 5 },
    { label: '9 − x', fn: (x) => 9 - x },
    { label: '10 − x', fn: (x) => 10 - x },
  ],
  [
    { label: '2x', fn: (x) => 2 * x },
    { label: '3x', fn: (x) => 3 * x },
    { label: '2x + 1', fn: (x) => 2 * x + 1 },
    { label: '2x − 1', fn: (x) => 2 * x - 1 },
    { label: '2x + 3', fn: (x) => 2 * x + 3 },
    { label: '3x − 2', fn: (x) => 3 * x - 2 },
    { label: '12 − 2x', fn: (x) => 12 - 2 * x },
  ],
  [
    { label: 'x²', fn: (x) => x * x },
    { label: 'x² + 1', fn: (x) => x * x + 1 },
    { label: '|x − 5|', fn: (x) => Math.abs(x - 5) },
    { label: '⌊x/2⌋', fn: (x) => Math.floor(x / 2) },
    { label: 'x mod 4', fn: (x) => x % 4 },
    { label: 'x mod 3', fn: (x) => x % 3 },
    { label: '5x − 10', fn: (x) => 5 * x - 10 },
  ],
  [
    { label: 'x² − x', fn: (x) => x * x - x },
    { label: '(x+1)²', fn: (x) => (x + 1) * (x + 1) },
    { label: 'x · (x − 2)', fn: (x) => x * (x - 2) },
    { label: 'x² mod 7', fn: (x) => (x * x) % 7 },
    { label: '|x − 3| · 2', fn: (x) => Math.abs(x - 3) * 2 },
    { label: '2x² + 1', fn: (x) => 2 * x * x + 1 },
    { label: '⌊x/2⌋ + x', fn: (x) => Math.floor(x / 2) + x },
  ],
];

type Phase = 'ready' | 'testing' | 'predicting' | 'levelwon' | 'gameover';

const gen = createGenToken();
let phase: Phase = 'ready';
let level = 1;
let levelsCompleted = 0;
let best = 0;
let currentFunc: FunctionDef = TIERS[0]![0]!;
let recentFuncLabels: string[] = [];
let testsRemaining = MAX_TESTS;
let testHistory: Array<{ x: number; y: number }> = [];
let predictionsAsked: number[] = [];
let predictionsCorrect = 0;
let currentPredictionX = 0;
let entryValue = '';
let lastTestY: number | null = null;
let lastTestX: number | null = null;

let levelEl!: HTMLElement;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let boxIn!: HTMLElement;
let boxOut!: HTMLElement;
let statusMsg!: HTMLElement;
let testsLeftEl!: HTMLElement;
let historyList!: HTMLElement;
let entryLabel!: HTMLElement;
let entryValueEl!: HTMLElement;
let actionPrimary!: HTMLButtonElement;
let actionSecondary!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayBtn!: HTMLButtonElement;

function pickFunction(forLevel: number): FunctionDef {
  const tierIndex = Math.min(Math.floor((forLevel - 1) / 2), TIERS.length - 1);
  const tier = TIERS[tierIndex]!;
  const pool = tier.filter((f) => !recentFuncLabels.includes(f.label));
  const candidates = pool.length > 0 ? pool : tier;
  const pick = candidates[Math.floor(Math.random() * candidates.length)]!;
  recentFuncLabels.push(pick.label);
  if (recentFuncLabels.length > 4) recentFuncLabels.shift();
  return pick;
}

function startLevel(): void {
  currentFunc = pickFunction(level);
  testsRemaining = MAX_TESTS;
  testHistory = [];
  predictionsAsked = [];
  predictionsCorrect = 0;
  entryValue = '';
  lastTestY = null;
  lastTestX = null;
  phase = 'testing';
  render();
}

function performTest(x: number): void {
  if (phase !== 'testing') return;
  if (testsRemaining <= 0) return;
  if (testHistory.some((h) => h.x === x)) {
    statusMsg.textContent = `${x} zaten denendi — başka bir giriş seç.`;
    return;
  }
  const y = currentFunc.fn(x);
  testHistory.push({ x, y });
  testsRemaining--;
  lastTestX = x;
  lastTestY = y;
  entryValue = '';
  render();
}

function startPredictPhase(): void {
  if (phase !== 'testing') return;
  if (testHistory.length === 0) {
    statusMsg.textContent = 'Önce en az bir deneme yap.';
    return;
  }
  phase = 'predicting';
  entryValue = '';
  pickPrediction();
  render();
}

function pickPrediction(): void {
  const used = new Set<number>();
  for (const h of testHistory) used.add(h.x);
  for (const x of predictionsAsked) used.add(x);
  const candidates: number[] = [];
  for (let x = 0; x <= 9; x++) if (!used.has(x)) candidates.push(x);
  if (candidates.length === 0) {
    for (let x = 0; x <= 9; x++) if (!predictionsAsked.includes(x)) candidates.push(x);
  }
  currentPredictionX = candidates[Math.floor(Math.random() * candidates.length)] ?? 0;
}

function submitGuess(): void {
  if (phase === 'testing') {
    if (entryValue === '') return;
    const x = parseInt(entryValue, 10);
    if (!Number.isFinite(x) || x < 0 || x > 9) return;
    performTest(x);
    return;
  }
  if (phase === 'predicting') {
    if (entryValue === '') return;
    const guess = parseInt(entryValue, 10);
    if (!Number.isFinite(guess)) return;
    const correct = currentFunc.fn(currentPredictionX);
    predictionsAsked.push(currentPredictionX);
    if (guess !== correct) {
      phase = 'gameover';
      commitBest();
      render();
      return;
    }
    predictionsCorrect++;
    if (predictionsCorrect >= PREDICTIONS_REQUIRED) {
      levelsCompleted++;
      level++;
      phase = 'levelwon';
      commitBest();
      const myGen = gen.current();
      window.setTimeout(() => {
        if (!gen.isCurrent(myGen)) return;
        if (phase !== 'levelwon') return;
        startLevel();
      }, LEVEL_TRANSITION_MS);
      render();
      return;
    }
    entryValue = '';
    pickPrediction();
    render();
  }
}

function appendDigit(d: string): void {
  if (phase === 'ready' || phase === 'gameover' || phase === 'levelwon') return;
  if (phase === 'testing') {
    entryValue = d;
  } else {
    if (entryValue.length >= 3) return;
    entryValue = (entryValue + d).replace(/^0+(\d)/, '$1');
    if (entryValue === '') entryValue = '0';
  }
  render();
}

function deleteDigit(): void {
  if (phase === 'ready' || phase === 'gameover' || phase === 'levelwon') return;
  entryValue = entryValue.slice(0, -1);
  render();
}

function commitBest(): void {
  if (levelsCompleted > best) {
    best = levelsCompleted;
    safeWrite(STORAGE_BEST, best);
  }
}

function startGame(): void {
  gen.bump();
  level = 1;
  levelsCompleted = 0;
  recentFuncLabels = [];
  startLevel();
}

function reset(): void {
  gen.bump();
  commitBest();
  phase = 'ready';
  level = 1;
  levelsCompleted = 0;
  testsRemaining = MAX_TESTS;
  testHistory = [];
  predictionsAsked = [];
  predictionsCorrect = 0;
  entryValue = '';
  lastTestX = null;
  lastTestY = null;
  recentFuncLabels = [];
  render();
}

function render(): void {
  levelEl.textContent = String(level);
  scoreEl.textContent = String(levelsCompleted);
  bestEl.textContent = String(best);
  testsLeftEl.textContent = String(testsRemaining);

  historyList.innerHTML = '';
  for (const h of testHistory) {
    const chip = document.createElement('span');
    chip.className = 'sk-history__chip';
    chip.textContent = `ƒ(${h.x}) = ${h.y}`;
    historyList.appendChild(chip);
  }

  if (phase === 'testing') {
    if (lastTestX !== null && lastTestY !== null) {
      boxIn.textContent = String(lastTestX);
      boxOut.textContent = String(lastTestY);
    } else {
      boxIn.textContent = entryValue === '' ? '—' : entryValue;
      boxOut.textContent = '?';
    }
    entryLabel.textContent = 'Giriş:';
    entryValueEl.textContent = entryValue === '' ? '—' : entryValue;
    actionPrimary.textContent = 'DENE';
    actionPrimary.disabled = entryValue === '' || testsRemaining === 0;
    actionSecondary.textContent = 'TAHMİNE GEÇ';
    actionSecondary.disabled = testHistory.length === 0;
    statusMsg.innerHTML =
      testsRemaining === 0
        ? 'Deneme hakkın bitti. <strong>TAHMİNE GEÇ</strong>.'
        : `Bir giriş seç (0–9) ve <strong>DENE</strong> de. Kalan tahminden önce ${testsRemaining} deneme.`;
    hideOverlayEl(overlay);
  } else if (phase === 'predicting') {
    boxIn.textContent = String(currentPredictionX);
    boxOut.textContent = '?';
    entryLabel.textContent = `ƒ(${currentPredictionX}) = `;
    entryValueEl.textContent = entryValue === '' ? '?' : entryValue;
    actionPrimary.textContent = 'ONAYLA';
    actionPrimary.disabled = entryValue === '';
    actionSecondary.textContent = 'TAHMİNE GEÇ';
    actionSecondary.disabled = true;
    const left = PREDICTIONS_REQUIRED - predictionsCorrect;
    statusMsg.innerHTML = `Tahmin ${predictionsCorrect + 1} / ${PREDICTIONS_REQUIRED}. ${left} doğru kaldı.`;
    hideOverlayEl(overlay);
  } else if (phase === 'ready') {
    boxIn.textContent = '—';
    boxOut.textContent = '—';
    entryLabel.textContent = 'Seçim:';
    entryValueEl.textContent = '—';
    actionPrimary.textContent = 'DENE';
    actionPrimary.disabled = true;
    actionSecondary.textContent = 'TAHMİNE GEÇ';
    actionSecondary.disabled = true;
    overlayTitle.textContent = 'Sihirli Kutu';
    overlayMsg.innerHTML =
      'Kutu gizli bir matematik kuralı uyguluyor. <strong>4 deneme</strong> hakkın var, sonra <strong>2 ardışık doğru tahmin</strong> seviyeyi geçirir. Bir yanlış cevap oyunu bitirir.';
    overlayBtn.textContent = 'BAŞLA';
    showOverlayEl(overlay);
  } else if (phase === 'levelwon') {
    boxIn.textContent = '✓';
    boxOut.textContent = '✓';
    entryLabel.textContent = 'Doğru!';
    entryValueEl.textContent = currentFunc.label;
    actionPrimary.disabled = true;
    actionSecondary.disabled = true;
    statusMsg.innerHTML = `Seviye ${level - 1} tamam — ƒ(x) = <strong>${currentFunc.label}</strong>`;
    hideOverlayEl(overlay);
  } else if (phase === 'gameover') {
    boxIn.textContent = '✕';
    boxOut.textContent = '✕';
    actionPrimary.disabled = true;
    actionSecondary.disabled = true;
    entryLabel.textContent = 'Kural:';
    entryValueEl.textContent = currentFunc.label;
    overlayTitle.textContent = 'Bitti';
    overlayMsg.innerHTML = `Kural <strong>ƒ(x) = ${currentFunc.label}</strong>'di. Skor: <strong>${levelsCompleted}</strong>. Rekor: <strong>${best}</strong>.`;
    overlayBtn.textContent = 'TEKRAR';
    statusMsg.textContent = 'Oyun bitti.';
    showOverlayEl(overlay);
  }
}

function onKey(e: KeyboardEvent): void {
  const k = e.key;
  if (k === 'r' || k === 'R') {
    reset();
    e.preventDefault();
    return;
  }
  if (phase === 'ready' || phase === 'gameover') {
    if (k === 'Enter' || k === ' ') {
      startGame();
      e.preventDefault();
    }
    return;
  }
  if (phase === 'levelwon') return;
  if (k >= '0' && k <= '9') {
    appendDigit(k);
    e.preventDefault();
  } else if (k === 'Backspace' || k === 'Delete') {
    deleteDigit();
    e.preventDefault();
  } else if (k === 'Enter') {
    submitGuess();
    e.preventDefault();
  }
}

function init(): void {
  levelEl = document.querySelector<HTMLElement>('#level')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  boxIn = document.querySelector<HTMLElement>('#box-in')!;
  boxOut = document.querySelector<HTMLElement>('#box-out')!;
  statusMsg = document.querySelector<HTMLElement>('#status-msg')!;
  testsLeftEl = document.querySelector<HTMLElement>('#tests-left')!;
  historyList = document.querySelector<HTMLElement>('#history-list')!;
  entryLabel = document.querySelector<HTMLElement>('#entry-label')!;
  entryValueEl = document.querySelector<HTMLElement>('#entry-value')!;
  actionPrimary = document.querySelector<HTMLButtonElement>('#action-primary')!;
  actionSecondary = document.querySelector<HTMLButtonElement>('#action-secondary')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  restartBtn.addEventListener('click', reset);
  overlayBtn.addEventListener('click', () => {
    if (phase === 'ready' || phase === 'gameover') startGame();
  });
  actionPrimary.addEventListener('click', submitGuess);
  actionSecondary.addEventListener('click', startPredictPhase);

  document.querySelectorAll<HTMLButtonElement>('.sk-numpad__btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const k = btn.dataset.key;
      if (k === undefined) return;
      if (k === 'del') deleteDigit();
      else if (k === 'enter') submitGuess();
      else appendDigit(k);
    });
  });

  window.addEventListener('keydown', onKey);

  render();
}

export const game = defineGame({ init, reset });
