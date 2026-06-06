// Kuşatma — entry point. The page loader imports this file by slug; it wires
// the modules in src/game-logic/kusatma/ together. All DOM/storage access is
// inside init() (invoked by defineGame after the DOM is parsed).

import { defineGame } from '@shared/game-module';
import { reportGameOver } from '@shared/leaderboard';
import { S, loadProfile, progressFor } from './kusatma/state';
import { bindCanvas, resizeCanvas, draw, applyFullscreenLayout } from './kusatma/render';
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

// Leaderboard: this run's score (higher is better). Reported on the transition
// into the 'gameover' state. The submodule flow owns that transition, so we
// watch S.state from the entry file rather than editing it.
const SCORE_DESC = { gameId: 'kusatma', storageKey: 'kusatma.lb', direction: 'higher' as const };

// Poll S.state for the gameover transition and report the run score once per
// game-over. Reads only existing runtime state; no new persistent tracking.
function watchGameOver(): void {
  let prevState = S.state;
  const tick = (): void => {
    if (S.state === 'gameover' && prevState !== 'gameover') {
      reportGameOver(SCORE_DESC, S.score, { label: 'Skor' });
    }
    prevState = S.state;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

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

  // Fullscreen: native Fullscreen API on the game root, with a CSS-maximize
  // fallback for contexts that block it (e.g. iOS Safari, which has no
  // element.requestFullscreen).
  const ksRoot = document.querySelector<HTMLElement>('#ks-root');
  const fsBtn = document.querySelector<HTMLButtonElement>('#fullscreen-toggle');
  function fsActive(): boolean {
    return document.fullscreenElement === ksRoot || !!ksRoot?.classList.contains('ks-root--max');
  }
  function syncFs(): void {
    const active = fsActive();
    applyFullscreenLayout(active);
    if (fsBtn) {
      fsBtn.textContent = active ? '🗗' : '⛶';
      fsBtn.setAttribute('aria-label', active ? 'Tam ekrandan çık' : 'Tam ekran');
    }
    resizeCanvas();
  }
  function toggleFs(): void {
    if (!ksRoot) return;
    if (document.fullscreenElement === ksRoot) {
      void document.exitFullscreen?.();
      return;
    }
    if (ksRoot.classList.contains('ks-root--max')) {
      ksRoot.classList.remove('ks-root--max');
      syncFs();
      return;
    }
    const req = ksRoot.requestFullscreen?.();
    if (req && typeof req.then === 'function') {
      req.then(syncFs).catch(() => {
        ksRoot.classList.add('ks-root--max');
        syncFs();
      });
    } else if (!ksRoot.requestFullscreen) {
      ksRoot.classList.add('ks-root--max');
      syncFs();
    } else {
      syncFs();
    }
  }
  fsBtn?.addEventListener('click', () => {
    audio.ensureAudio();
    toggleFs();
  });
  document.addEventListener('fullscreenchange', syncFs);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'f' || e.key === 'F') {
      audio.ensureAudio();
      toggleFs();
      e.preventDefault();
    }
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
  watchGameOver();

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
