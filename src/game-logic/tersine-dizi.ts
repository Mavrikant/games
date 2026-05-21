import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import {
  showOverlay as showOverlayEl,
  hideOverlay as hideOverlayEl,
} from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';

const STORAGE_BEST = 'tersine-dizi.best';
const GRID_COLS = 3;
const GRID_ROWS = 3;
const CELL_COUNT = GRID_COLS * GRID_ROWS;
const SHOW_MS = 520;
const GAP_MS = 200;
const PRE_PLAY_DELAY = 380;
const FEEDBACK_MS = 320;
const START_LIVES = 3;
const START_LEN = 2;

type Phase = 'ready' | 'showing' | 'input' | 'feedback' | 'gameover';

const gen = createGenToken();

let phase: Phase = 'ready';
let round = 0;
let lives = START_LIVES;
let best = 0;
let sequence: number[] = [];
let expected: number[] = [];

let roundEl!: HTMLElement;
let livesEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let phaseEl!: HTMLElement;
let boardEl!: HTMLElement;
let overlayEl!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayBtn!: HTMLButtonElement;
let cellEls: HTMLButtonElement[] = [];

function renderHud(): void {
  roundEl.textContent = String(round);
  livesEl.textContent = String(lives);
  bestEl.textContent = String(best);
}

function setPhaseText(text: string, mod: string): void {
  phaseEl.textContent = text;
  phaseEl.className = `phase phase--${mod}`;
}

function buildBoard(): void {
  boardEl.style.setProperty('--cols', String(GRID_COLS));
  boardEl.innerHTML = '';
  cellEls = [];
  for (let i = 0; i < CELL_COUNT; i++) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cell';
    btn.dataset.i = String(i);
    btn.setAttribute('aria-label', `Hücre ${i + 1}`);
    btn.addEventListener('click', () => onCellClick(i));
    boardEl.appendChild(btn);
    cellEls.push(btn);
  }
}

function clearCellStates(): void {
  for (const el of cellEls) {
    el.classList.remove('cell--lit', 'cell--correct', 'cell--wrong');
  }
}

function randomSequence(len: number): number[] {
  const out: number[] = [];
  let last = -1;
  for (let i = 0; i < len; i++) {
    let n = Math.floor(Math.random() * CELL_COUNT);
    if (n === last) n = (n + 1) % CELL_COUNT;
    out.push(n);
    last = n;
  }
  return out;
}

function reverse(arr: number[]): number[] {
  return [...arr].reverse();
}

function flashCell(idx: number, ms: number, token: number): Promise<void> {
  return new Promise((resolve) => {
    if (!gen.isCurrent(token)) {
      resolve();
      return;
    }
    const el = cellEls[idx];
    if (!el) {
      resolve();
      return;
    }
    el.classList.add('cell--lit');
    window.setTimeout(() => {
      if (!gen.isCurrent(token)) {
        resolve();
        return;
      }
      el.classList.remove('cell--lit');
      window.setTimeout(() => {
        resolve();
      }, GAP_MS);
    }, ms);
  });
}

function wait(ms: number, token: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(() => {
      if (!gen.isCurrent(token)) {
        resolve();
        return;
      }
      resolve();
    }, ms);
  });
}

function setCellsInteractive(on: boolean): void {
  for (const el of cellEls) {
    el.classList.toggle('cell--active', on);
    if (on) el.removeAttribute('disabled');
    else el.setAttribute('disabled', 'true');
  }
}

async function playSequence(): Promise<void> {
  phase = 'showing';
  setPhaseText('İzle...', 'showing');
  setCellsInteractive(false);
  clearCellStates();
  const myToken = gen.current();
  await wait(PRE_PLAY_DELAY, myToken);
  if (!gen.isCurrent(myToken)) return;
  for (const idx of sequence) {
    if (!gen.isCurrent(myToken)) return;
    await flashCell(idx, SHOW_MS, myToken);
  }
  if (!gen.isCurrent(myToken)) return;
  startInputPhase();
}

function startInputPhase(): void {
  phase = 'input';
  expected = reverse(sequence);
  setPhaseText('Ters sırada tıkla', 'input');
  setCellsInteractive(true);
}

function commitBest(): void {
  if (round > best) {
    best = round;
    safeWrite(STORAGE_BEST, best);
  }
  renderHud();
}

function startRound(): void {
  gen.bump();
  clearCellStates();
  const len = START_LEN + (round - 1);
  sequence = randomSequence(len);
  renderHud();
  void playSequence();
}

function startGame(): void {
  hideOverlayEl(overlayEl);
  lives = START_LIVES;
  round = 1;
  renderHud();
  startRound();
}

function nextRound(): void {
  round += 1;
  startRound();
}

function showOverlayInfo(title: string, msg: string, btnText: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  overlayBtn.textContent = btnText;
  showOverlayEl(overlayEl);
}

function gameOver(): void {
  phase = 'gameover';
  setCellsInteractive(false);
  commitBest();
  setPhaseText('Bitti', 'gameover');
  const beatenRecord = round - 1 >= best && round - 1 > 0;
  const reached = Math.max(round - 1, 0);
  showOverlayInfo(
    beatenRecord && reached > 0 ? 'Yeni rekor!' : 'Oyun bitti',
    `${reached} tur tamamladın. Rekor: ${best}.`,
    'Tekrar oyna',
  );
}

function onCellClick(i: number): void {
  if (phase !== 'input') return;
  const want = expected.shift();
  if (want === undefined) return;
  const cellEl = cellEls[i];
  if (!cellEl) return;
  if (i === want) {
    phase = 'feedback';
    cellEl.classList.add('cell--correct');
    const myToken = gen.current();
    window.setTimeout(() => {
      if (!gen.isCurrent(myToken)) return;
      cellEl.classList.remove('cell--correct');
      if (expected.length === 0) {
        nextRound();
      } else {
        phase = 'input';
      }
    }, FEEDBACK_MS);
  } else {
    phase = 'feedback';
    cellEl.classList.add('cell--wrong');
    lives -= 1;
    renderHud();
    const myToken = gen.current();
    window.setTimeout(() => {
      if (!gen.isCurrent(myToken)) return;
      cellEl.classList.remove('cell--wrong');
      if (lives <= 0) {
        gameOver();
      } else {
        startRound();
      }
    }, FEEDBACK_MS);
  }
}

function reset(): void {
  gen.bump();
  phase = 'ready';
  lives = START_LIVES;
  round = 0;
  sequence = [];
  expected = [];
  setCellsInteractive(false);
  clearCellStates();
  renderHud();
  setPhaseText('Hazır', 'ready');
  showOverlayInfo(
    'Tersine Dizi',
    'Dizi yanıp söner. Sen ters sırada tıklarsın. Her turda dizi uzar; üç hata canına mal olur.',
    'Başla',
  );
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.key === ' ' || e.code === 'Space') {
    if (phase === 'ready' || phase === 'gameover') {
      e.preventDefault();
      startGame();
    }
  } else if (e.key === 'r' || e.key === 'R') {
    e.preventDefault();
    reset();
  }
}

function init(): void {
  roundEl = document.querySelector<HTMLElement>('#round')!;
  livesEl = document.querySelector<HTMLElement>('#lives')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  phaseEl = document.querySelector<HTMLElement>('#phase')!;
  boardEl = document.querySelector<HTMLElement>('#board')!;
  overlayEl = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-action')!;

  best = safeRead<number>(STORAGE_BEST, 0);
  if (typeof best !== 'number' || !Number.isFinite(best) || best < 0) best = 0;

  buildBoard();
  setCellsInteractive(false);

  restartBtn.addEventListener('click', reset);
  overlayBtn.addEventListener('click', startGame);
  window.addEventListener('keydown', onKeyDown);

  reset();
}

export const game = defineGame({ init, reset });
