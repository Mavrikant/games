// Yıldızlararası — entry point. The page loader imports this file by slug; it
// wires the modules in src/game-logic/yildizlararasi/ together. All DOM/storage
// access is inside init() (invoked by defineGame after the DOM is parsed).

import { defineGame } from '@shared/game-module';
import { hideOverlay } from '@shared/overlay';
import { ensureAudio, setMusicEnabled, setSfxEnabled, setTheme } from './yildizlararasi/audio';
import { goto } from './yildizlararasi/router';
import { freshData, gen, resetRun, S } from './yildizlararasi/state';
import { initStarfield, restartStarfield } from './yildizlararasi/starfield';

let musicOn = true;
let sfxOn = true;

function bindToggle(id: string, get: () => boolean, set: (v: boolean) => void, on: string, off: string): void {
  const btn = document.getElementById(id);
  if (!btn) return;
  btn.addEventListener('click', () => {
    ensureAudio();
    const next = !get();
    set(next);
    btn.setAttribute('aria-pressed', String(next));
    btn.textContent = next ? on : off;
    btn.classList.toggle('yi-icon-btn--off', !next);
  });
}

function reset(): void {
  gen.bump(); // cancel in-flight portal/cutscene/fly callbacks + old RAF loops
  resetRun();
  setTheme('space');
  const popup = document.getElementById('yi-popup');
  if (popup) hideOverlay(popup);
  document.getElementById('yi-fade')?.classList.remove('yi-fade--on');
  restartStarfield();
  goto('intro');
}

function init(): void {
  const canvas = document.querySelector<HTMLCanvasElement>('#yi-stars');
  S.data = freshData();
  resetRun();

  if (canvas) initStarfield(canvas);

  document.getElementById('restart')?.addEventListener('click', () => {
    ensureAudio();
    reset();
  });

  bindToggle('yi-music', () => musicOn, (v) => { musicOn = v; setMusicEnabled(v); }, '🎵', '🔇');
  bindToggle('yi-sfx', () => sfxOn, (v) => { sfxOn = v; setSfxEnabled(v); }, '🔊', '🔈');

  // Lazy-init audio on the first user gesture (autoplay policy + smoke never
  // gestures, so audio never inits during the headless test).
  const firstGesture = (): void => ensureAudio();
  window.addEventListener('pointerdown', firstGesture, { once: true });
  window.addEventListener('keydown', firstGesture, { once: true });

  goto('intro');
}

export const game = defineGame({ init, reset });
