// Intro. Two flavors:
//  - Founder (no share link): "Başla" → customize the two characters.
//  - Recipient (opened a share link): a personalized prompt → straight into the
//    journey (play), skipping customization/mode. While a #c= cloud setup is
//    still loading the start button waits.
// Static markup gives a visible element <250ms before JS runs (invisible-boot).

import { ensureAudio, sfxClick } from './audio';
import { goto } from './router';
import { S } from './state';
import * as three from './three-scene';
import type { Scene } from './types';

function applyButton(): void {
  const btn = document.getElementById('yi-start') as HTMLButtonElement | null;
  const tag = document.querySelector<HTMLElement>('#yi-intro .yi-intro__tag');
  if (!btn) return;
  if (S.fromLink) {
    if (tag) tag.textContent = 'Sevgilin senin için yıldızlararası bir yolculuk hazırladı 💌';
    btn.disabled = S.cloudLoading;
    btn.textContent = S.cloudLoading ? 'Yükleniyor…' : 'Yolculuğa Başla';
    btn.onclick = () => {
      if (S.cloudLoading) return;
      ensureAudio();
      sfxClick();
      goto('play');
    };
  } else {
    if (tag) tag.textContent = 'Uzayın derinliklerinden başlayan bir aşk yolculuğu. 3B.';
    btn.disabled = false;
    btn.textContent = 'Başla';
    btn.onclick = () => {
      ensureAudio();
      sfxClick();
      goto('customize');
    };
  }
}

function enter(): void {
  three.setMode('space');
  applyButton();
}

function leave(): void {
  const btn = document.getElementById('yi-start') as HTMLButtonElement | null;
  if (btn) btn.onclick = null;
}

export const scene: Scene = { enter, leave };

// Called by the entry when the async cloud fetch settles, to flip the recipient
// start button from "Yükleniyor…" to ready.
export function refreshStart(): void {
  if (S.scene === 'intro') applyButton();
}
