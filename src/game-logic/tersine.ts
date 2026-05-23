import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay, hideOverlay } from '@shared/overlay';

// PITFALLS guarded here (see docs/PITFALLS.md):
// - unguarded-storage: best score via safeRead/safeWrite.
// - stale-async-callback: every setTimeout in the flash/show chain is bound to
//   a generation token; reset()/startGame() bump it so old callbacks no-op.
// - overlay-input-leak: explicit State enum; pad taps only act in 'input'.
// - invisible-boot: first pad lights within ~220ms of pressing Başla, and the
//   status line updates synchronously on every transition.
// - module-level-dom-access: all DOM/storage access lives in init().

const STORAGE_BEST = 'tersine.best';
const START_LEN = 2;
const PAD_COUNT = 9;

// Timing (ms). Shared by show sequence + feedback flashes.
const FIRST_DELAY = 220;
const FLASH_ON = 360;
const FLASH_OFF = 170;
const GOOD_FLASH = 150;
const BAD_FLASH = 650;
const SUCCESS_PAUSE = 650;

type State = 'ready' | 'showing' | 'input' | 'gameover';

const gen = createGenToken();
let state: State = 'ready';
let sequence: number[] = [];
let inputCount = 0;
let round = 1;
let best = 0;

let pads: HTMLButtonElement[] = [];
let roundEl!: HTMLElement;
let bestEl!: HTMLElement;
let statusEl!: HTMLElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let startBtn!: HTMLButtonElement;
let restartBtn!: HTMLButtonElement;

function setStatus(msg: string): void {
  statusEl.textContent = msg;
}

function randomPad(): number {
  return Math.floor(Math.random() * PAD_COUNT);
}

function clearPadClasses(): void {
  for (const pad of pads) {
    pad.classList.remove('ters-pad--lit', 'ters-pad--good', 'ters-pad--bad');
  }
}

function flashClass(i: number, cls: string, dur: number, myGen: number): void {
  const pad = pads[i];
  if (!pad) return;
  pad.classList.add(cls);
  setTimeout(() => {
    if (!gen.isCurrent(myGen)) return;
    pad.classList.remove(cls);
  }, dur);
}

function showSequence(): void {
  state = 'showing';
  setStatus('İzle…');
  const myGen = gen.current();
  let step = 0;
  const playStep = (): void => {
    if (!gen.isCurrent(myGen)) return;
    if (step >= sequence.length) {
      state = 'input';
      inputCount = 0;
      setStatus('Şimdi TERSTEN gir! (sondan başa)');
      return;
    }
    const idx = sequence[step]!;
    const pad = pads[idx]!;
    pad.classList.add('ters-pad--lit');
    setTimeout(() => {
      if (!gen.isCurrent(myGen)) return;
      pad.classList.remove('ters-pad--lit');
      step++;
      setTimeout(playStep, FLASH_OFF);
    }, FLASH_ON);
  };
  setTimeout(playStep, FIRST_DELAY);
}

function roundComplete(): void {
  if (round > best) {
    best = round;
    safeWrite(STORAGE_BEST, best);
    bestEl.textContent = String(best);
  }
  round += 1;
  roundEl.textContent = String(round);
  sequence.push(randomPad());
  state = 'showing'; // lock input during the pause before next sequence
  setStatus('Doğru! Sıradaki tur…');
  const myGen = gen.current();
  setTimeout(() => {
    if (!gen.isCurrent(myGen)) return;
    showSequence();
  }, SUCCESS_PAUSE);
}

function failRound(wrong: number, expected: number): void {
  state = 'gameover';
  const myGen = gen.current();
  flashClass(wrong, 'ters-pad--bad', BAD_FLASH, myGen);
  flashClass(expected, 'ters-pad--lit', BAD_FLASH, myGen);
  const completed = round - 1;
  overlayTitle.textContent = 'Bitti!';
  overlayMsg.textContent = `Tamamlanan tur: ${completed}\nRekor: ${best}`;
  startBtn.textContent = 'Tekrar oyna';
  setStatus('Yanlış pad — tekrar dene.');
  setTimeout(() => {
    if (!gen.isCurrent(myGen)) return;
    showOverlay(overlay);
  }, 350);
}

function onPad(i: number): void {
  if (state !== 'input') return;
  const expected = sequence[sequence.length - 1 - inputCount]!;
  if (i === expected) {
    flashClass(i, 'ters-pad--good', GOOD_FLASH, gen.current());
    inputCount += 1;
    if (inputCount === sequence.length) roundComplete();
  } else {
    failRound(i, expected);
  }
}

function startGame(): void {
  gen.bump();
  clearPadClasses();
  hideOverlay(overlay);
  round = 1;
  inputCount = 0;
  sequence = [];
  for (let k = 0; k < START_LEN; k++) sequence.push(randomPad());
  roundEl.textContent = String(round);
  bestEl.textContent = String(best);
  showSequence();
}

function reset(): void {
  gen.bump();
  state = 'ready';
  round = 1;
  inputCount = 0;
  sequence = [];
  clearPadClasses();
  roundEl.textContent = '1';
  bestEl.textContent = String(best);
  overlayTitle.textContent = 'Tersine';
  overlayMsg.textContent =
    'Padlerin yanış sırasını izle, sonra TERSTEN gir. Her turda dizi bir adım uzar.';
  startBtn.textContent = 'Başla';
  setStatus("Başlamak için Başla'ya bas");
  showOverlay(overlay);
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'r' || e.key === 'R') {
    e.preventDefault();
    reset();
    return;
  }
  if (state === 'ready' || state === 'gameover') {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      startGame();
    }
    return;
  }
  if (state === 'input') {
    const n = Number(e.key);
    if (Number.isInteger(n) && n >= 1 && n <= PAD_COUNT) {
      e.preventDefault();
      onPad(n - 1);
    }
  }
}

function init(): void {
  pads = Array.from(
    document.querySelectorAll<HTMLButtonElement>('.ters-pad'),
  );
  roundEl = document.querySelector<HTMLElement>('#round')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  statusEl = document.querySelector<HTMLElement>('#status')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  startBtn = document.querySelector<HTMLButtonElement>('#start')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  pads.forEach((pad, i) => pad.addEventListener('click', () => onPad(i)));
  startBtn.addEventListener('click', startGame);
  restartBtn.addEventListener('click', reset);
  document.addEventListener('keydown', onKey);

  reset();
}

export const game = defineGame({ init, reset });
