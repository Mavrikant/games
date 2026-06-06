import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { reportGameOver } from '@shared/leaderboard';

type State = 'ready' | 'showing' | 'input' | 'gameover';
type Feedback = 'correct' | 'wrong' | null;

const STORAGE_KEY = 'echo-grid.best';
const SCORE_DESC = { gameId: 'echo-grid', storageKey: STORAGE_KEY, direction: 'higher' as const };

let cellEls: HTMLButtonElement[] = [];
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let statusEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let actionBtn!: HTMLButtonElement;

let state: State = 'ready';
let sequence: number[] = [];
let score = 0;
let best = 0;
let inputIndex = 0;
let activeCell: number | null = null;
let feedbackCell: number | null = null;
let feedbackKind: Feedback = null;
let statusText = '';
const gen = createGenToken();
let timers: number[] = [];

function loadBest(): number {
  const v = safeRead<number>(STORAGE_KEY, 0);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

function saveBest(): void {
  safeWrite(STORAGE_KEY, best);
}

function clearTimers(): void {
  for (const handle of timers) {
    clearTimeout(handle);
  }
  timers = [];
}

function nextGeneration(): number {
  gen.bump();
  clearTimers();
  return gen.current();
}

function schedule(callback: () => void, delay: number): void {
  const handle = window.setTimeout(callback, delay);
  timers.push(handle);
}

function pickNextCell(): number {
  const prev = sequence[sequence.length - 1];
  let next = Math.floor(Math.random() * cellEls.length);
  while (cellEls.length > 1 && next === prev) {
    next = Math.floor(Math.random() * cellEls.length);
  }
  return next;
}

function render(): void {
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
  statusEl.textContent = statusText;

  actionBtn.hidden = !(state === 'ready' || state === 'gameover');
  actionBtn.textContent = state === 'gameover' ? 'Tekrar başla' : 'Başlat';

  cellEls.forEach((el, index) => {
    const isActive = index === activeCell;
    const isFeedback = index === feedbackCell;

    el.disabled = state !== 'input';
    el.classList.toggle('cell--active', isActive);
    el.classList.toggle('cell--correct', isFeedback && feedbackKind === 'correct');
    el.classList.toggle('cell--wrong', isFeedback && feedbackKind === 'wrong');
    el.setAttribute('aria-pressed', String(isActive));
  });
}

function reset(): void {
  nextGeneration();
  state = 'ready';
  sequence = [];
  score = 0;
  inputIndex = 0;
  activeCell = null;
  feedbackCell = null;
  feedbackKind = null;
  statusText = 'Deseni izle, sonra aynı kareleri ters sırayla seç.';
  render();
}

function beginInput(): void {
  state = 'input';
  inputIndex = 0;
  activeCell = null;
  feedbackCell = null;
  feedbackKind = null;
  statusText = `Şimdi ters sırayla seç (${sequence.length} kare).`;
  render();
}

function showSequence(): void {
  const token = nextGeneration();
  state = 'showing';
  activeCell = null;
  feedbackCell = null;
  feedbackKind = null;
  statusText = `Tur ${score + 1}: deseni izle.`;
  render();

  const introDelay = 240;
  const stepDelay = 520;
  const activeDelay = 250;

  sequence.forEach((cell, index) => {
    const offset = introDelay + index * stepDelay;

    schedule(() => {
      if (!gen.isCurrent(token)) return;
      activeCell = cell;
      render();
    }, offset);

    schedule(() => {
      if (!gen.isCurrent(token)) return;
      activeCell = null;
      render();
    }, offset + activeDelay);
  });

  schedule(() => {
    if (!gen.isCurrent(token)) return;
    beginInput();
  }, introDelay + sequence.length * stepDelay);
}

function startRun(): void {
  sequence = [];
  score = 0;
  inputIndex = 0;
  activeCell = null;
  feedbackCell = null;
  feedbackKind = null;
  sequence.push(pickNextCell());
  showSequence();
}

function finishRound(): void {
  score = sequence.length;
  if (score > best) {
    best = score;
    saveBest();
  }

  state = 'showing';
  feedbackCell = null;
  feedbackKind = null;
  activeCell = null;
  statusText = 'Harika! Yeni desen geliyor…';
  render();

  const token = gen.current();
  schedule(() => {
    if (!gen.isCurrent(token)) return;
    sequence.push(pickNextCell());
    showSequence();
  }, 460);
}

function loseRound(): void {
  state = 'gameover';
  statusText =
    score === 0
      ? 'İlk turda hata yaptın. Başlat ile yeniden dene.'
      : `${score} tur tamamladın. Başlat ile yeniden dene.`;
  reportGameOver(SCORE_DESC, score);
  render();
}

function handleCellInput(index: number): void {
  if (state !== 'input') return;

  const expected = sequence[sequence.length - 1 - inputIndex];
  const token = gen.current();

  activeCell = index;
  feedbackCell = index;

  if (index !== expected) {
    feedbackKind = 'wrong';
    loseRound();
    return;
  }

  feedbackKind = 'correct';
  inputIndex += 1;

  if (inputIndex === sequence.length) {
    finishRound();
    return;
  }

  statusText = `Güzel! ${sequence.length - inputIndex} kare kaldı.`;
  render();

  schedule(() => {
    if (!gen.isCurrent(token)) return;
    activeCell = null;
    feedbackCell = null;
    feedbackKind = null;
    render();
  }, 180);
}

function maybeStartFromKeyboard(): void {
  if (state === 'ready' || state === 'gameover') {
    startRun();
  }
}

function init(): void {
  cellEls = Array.from(document.querySelectorAll<HTMLButtonElement>('.cell'));
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  statusEl = document.querySelector<HTMLElement>('#status')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  actionBtn = document.querySelector<HTMLButtonElement>('#action')!;

  best = loadBest();

  cellEls.forEach((el, index) => {
    el.addEventListener('click', () => handleCellInput(index));
  });

  actionBtn.addEventListener('click', () => {
    maybeStartFromKeyboard();
  });

  restartBtn.addEventListener('click', reset);

  window.addEventListener('keydown', (event) => {
    const key = event.key.toLowerCase();

    if (key === ' ' || key === 'enter') {
      maybeStartFromKeyboard();
      event.preventDefault();
      return;
    }

    if (key === 'r') {
      reset();
      event.preventDefault();
      return;
    }

    const match = event.code.match(/^(?:Digit|Numpad)([1-9])$/);
    if (!match) return;

    handleCellInput(Number(match[1]) - 1);
    event.preventDefault();
  });

  reset();
}

export const game = defineGame({ init, reset });
