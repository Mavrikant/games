type State = 'ready' | 'showing' | 'input' | 'gameover';
type Feedback = 'correct' | 'wrong' | null;

const STORAGE_KEY = 'echo-grid.best';

const cellEls = Array.from(document.querySelectorAll<HTMLButtonElement>('.cell'));
const scoreEl = document.querySelector<HTMLElement>('#score')!;
const bestEl = document.querySelector<HTMLElement>('#best')!;
const statusEl = document.querySelector<HTMLElement>('#status')!;
const restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
const actionBtn = document.querySelector<HTMLButtonElement>('#action')!;

let state: State = 'ready';
let sequence: number[] = [];
let score = 0;
let best = loadBest();
let inputIndex = 0;
let activeCell: number | null = null;
let feedbackCell: number | null = null;
let feedbackKind: Feedback = null;
let statusText = '';
let generation = 0;
let timers: number[] = [];

function loadBest(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? Math.max(0, Number(raw) || 0) : 0;
  } catch {
    return 0;
  }
}

function saveBest(): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(best));
  } catch {
    /* ignore */
  }
}

function clearTimers(): void {
  for (const handle of timers) {
    clearTimeout(handle);
  }
  timers = [];
}

function nextGeneration(): number {
  generation += 1;
  clearTimers();
  return generation;
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
      if (token !== generation) return;
      activeCell = cell;
      render();
    }, offset);

    schedule(() => {
      if (token !== generation) return;
      activeCell = null;
      render();
    }, offset + activeDelay);
  });

  schedule(() => {
    if (token !== generation) return;
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

  const token = generation;
  schedule(() => {
    if (token !== generation) return;
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
  render();
}

function handleCellInput(index: number): void {
  if (state !== 'input') return;

  const expected = sequence[sequence.length - 1 - inputIndex];
  const token = generation;

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
    if (token !== generation) return;
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
