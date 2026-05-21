import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';

// PITFALLS guarded by this scaffold (read docs/PITFALLS.md before editing):
// - unguarded-storage: safeRead/safeWrite wrap localStorage in try/catch.
// - stale-async-callback: gen.bump() in reset() cancels in-flight callbacks.
// - overlay-input-leak: explicit `state` enum; guard at top of each handler.
// - module-level side effects: all DOM access lives in init(), invoked by
//   defineGame() after the page DOM is parsed.

const STORAGE_BEST = '__SLUG__.best';

type State = 'ready' | 'playing' | 'gameover';

const gen = createGenToken();
let state: State = 'ready';
let score = 0;
let best = 0;

let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let rootEl!: HTMLElement;

function render(): void {
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
  rootEl.textContent =
    state === 'ready'
      ? '__TITLE__ — burayı oyun mantığıyla doldur.'
      : state === 'playing'
        ? 'Oyna!'
        : 'Bitti.';
}

function commitBest(): void {
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
}

function reset(): void {
  gen.bump();
  state = 'ready';
  score = 0;
  commitBest();
  render();
}

function init(): void {
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  rootEl = document.querySelector<HTMLElement>('#root')!;

  best = safeRead(STORAGE_BEST, 0);

  restartBtn.addEventListener('click', reset);

  // TODO: implement __TITLE__ — input handlers, game loop, win/lose logic.
  // Use the state enum to guard handlers (PITFALLS#overlay-input-leak):
  //   function onKey(e: KeyboardEvent) {
  //     if (state !== 'playing') return;
  //     // ...
  //   }
  render();
}

export const game = defineGame({ init, reset });
