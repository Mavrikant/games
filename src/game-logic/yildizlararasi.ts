// Yıldızlararası — entry point. The page loader imports this file by slug; it
// wires the modules in src/game-logic/yildizlararasi/ together. All DOM/storage
// access is inside init() (invoked by defineGame after the DOM is parsed).

import { defineGame } from '@shared/game-module';
import { hideOverlay } from '@shared/overlay';
import { ensureAudio, setMusicEnabled, setSfxEnabled, setTheme } from './yildizlararasi/audio';
import { goto } from './yildizlararasi/router';
import { freshData, gen, maybeLoadCloud, resetRun, S } from './yildizlararasi/state';
import * as three from './yildizlararasi/three-scene';

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

function setupFullscreen(): void {
  const stage = document.getElementById('yi-stage');
  const btn = document.getElementById('yi-fullscreen');
  if (!stage || !btn) return;
  const active = (): boolean =>
    document.fullscreenElement === stage || stage.classList.contains('yi-stage--max');
  const sync = (): void => {
    btn.textContent = active() ? '🗗' : '⛶';
    three.resize();
  };
  const toggle = (): void => {
    if (document.fullscreenElement === stage) {
      void document.exitFullscreen?.();
      return;
    }
    if (stage.classList.contains('yi-stage--max')) {
      stage.classList.remove('yi-stage--max');
      sync();
      return;
    }
    const req = stage.requestFullscreen?.();
    if (req && typeof req.then === 'function') {
      req.then(sync).catch(() => {
        stage.classList.add('yi-stage--max'); // iOS Safari fallback
        sync();
      });
    } else if (!stage.requestFullscreen) {
      stage.classList.add('yi-stage--max');
      sync();
    } else {
      sync();
    }
  };
  btn.addEventListener('click', () => {
    ensureAudio();
    toggle();
  });
  document.addEventListener('fullscreenchange', sync);
}

function reset(): void {
  gen.bump(); // cancel in-flight portal/cutscene/mini-game callbacks + old loops
  resetRun();
  setTheme('space');
  const popup = document.getElementById('yi-popup');
  if (popup) hideOverlay(popup);
  const mg = document.getElementById('yi-minigame');
  if (mg) hideOverlay(mg);
  document.getElementById('yi-fade')?.classList.remove('yi-fade--on');
  three.restartLoop();
  goto('intro');
}

function init(): void {
  const canvas = document.querySelector<HTMLCanvasElement>('#yi-gl');
  S.data = freshData();
  resetRun();

  if (canvas) {
    three.init(canvas);
    three.startLoop();
  }

  // Pull a cloud-stored setup (#c=…) when Supabase is configured. Adopt fully
  // while still on the intro; later, only refresh the memories so an in-progress
  // customization isn't clobbered.
  maybeLoadCloud((data) => {
    if (S.scene === 'intro') S.data = data;
    else S.data.memories = data.memories;
  });

  document.getElementById('restart')?.addEventListener('click', () => {
    ensureAudio();
    reset();
  });

  bindToggle('yi-music', () => musicOn, (v) => { musicOn = v; setMusicEnabled(v); }, '🎵', '🔇');
  bindToggle('yi-sfx', () => sfxOn, (v) => { sfxOn = v; setSfxEnabled(v); }, '🔊', '🔈');
  setupFullscreen();

  window.addEventListener('resize', () => three.resize());
  window.addEventListener('orientationchange', () => three.resize());

  const firstGesture = (): void => ensureAudio();
  window.addEventListener('pointerdown', firstGesture, { once: true });
  window.addEventListener('keydown', firstGesture, { once: true });

  goto('intro');
}

export const game = defineGame({ init, reset });
