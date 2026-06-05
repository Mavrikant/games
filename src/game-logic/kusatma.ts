// Kuşatma — entry point. The page loader imports this file by slug; it wires
// the modules in src/game-logic/kusatma/ together. All DOM/storage access is
// inside init() (invoked by defineGame after the DOM is parsed).

import { defineGame } from '@shared/game-module';
import { S, loadProfile, progressFor } from './kusatma/state';
import { bindCanvas, resizeCanvas, draw } from './kusatma/render';
import { bindUi, showIntro, type UiHandlers } from './kusatma/ui';
import { bindInput } from './kusatma/input';
import { startLoop } from './kusatma/loop';
import {
  applySettings,
  fire,
  nextLevel,
  retryLevel,
  selectFromMap,
  setSetting,
  startLevel,
  toMap,
} from './kusatma/flow';
import { validateAll } from './kusatma/levels';
import { ENGINES } from './kusatma/engines';
import { AMMO } from './kusatma/ammo';
import * as audio from './kusatma/audio';

function init(): void {
  const board = document.querySelector<HTMLCanvasElement>('#board')!;

  S.profile = loadProfile();
  applySettings();

  bindCanvas(board);

  const handlers: UiHandlers = {
    onMapSelect: (id) => selectFromMap(id),
    onIntroStart: () => selectFromMap(S.profile.currentLevel),
    onNext: () => nextLevel(),
    onRetry: () => retryLevel(),
    onToMap: () => toMap(),
    onPrelevelStart: (engineId) => startLevel(S.levelIndex, engineId),
    onSetting: (key, value) => setSetting(key, value),
  };
  bindUi(handlers);
  bindInput();

  const mapBtn = document.querySelector<HTMLButtonElement>('#map-btn');
  mapBtn?.addEventListener('click', () => {
    audio.ensureAudio();
    toMap();
  });
  const restartBtn = document.querySelector<HTMLButtonElement>('#restart');
  restartBtn?.addEventListener('click', () => {
    audio.ensureAudio();
    retryLevel();
  });

  window.addEventListener('resize', resizeCanvas);
  window.addEventListener('orientationchange', resizeCanvas);

  // Build a live board behind the boot overlay so the scene shows instantly.
  startLevel(S.profile.currentLevel);

  const firstRun = S.profile.currentLevel === 1 && !progressFor(1).cleared;
  if (firstRun) {
    S.state = 'intro';
    showIntro();
  } else {
    toMap();
  }

  draw();
  startLoop();

  // Read-only test hook (used by scripts/kusatma-playthrough.mjs). Harmless in
  // normal play; lets the headless harness drive the real game + run static
  // solvability checks.
  (window as unknown as Record<string, unknown>).__KUSATMA__ = {
    S,
    validateAll,
    ENGINES,
    AMMO,
    fire,
    startLevel,
    selectFromMap,
    toMap,
  };
}

function reset(): void {
  retryLevel();
}

export const game = defineGame({ init, reset });
