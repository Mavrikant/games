// Intro: static markup in the body (so there is a visible element <250ms before
// JS runs — pitfall: invisible-boot). We just bind the "Başla" CTA.

import { ensureAudio, sfxClick } from './audio';
import { goto } from './router';
import * as three from './three-scene';
import type { Scene } from './types';

function enter(): void {
  three.setMode('space');
  const btn = document.getElementById('yi-start');
  if (!btn) return;
  // onclick assignment (not addEventListener) so re-entering intro after a
  // restart never stacks duplicate handlers on the persistent element.
  btn.onclick = () => {
    ensureAudio();
    sfxClick();
    goto('customize');
  };
}

function leave(): void {
  const btn = document.getElementById('yi-start');
  if (btn) btn.onclick = null;
}

export const scene: Scene = { enter, leave };
