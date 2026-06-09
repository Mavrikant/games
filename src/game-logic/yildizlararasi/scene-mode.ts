// Mode select: hide memories (setup) vs start the journey (play).

import { ensureAudio, sfxClick } from './audio';
import { goto } from './router';
import * as three from './three-scene';
import type { Scene } from './types';

function el(): HTMLElement | null {
  return document.getElementById('yi-mode');
}

function onClick(e: MouseEvent): void {
  const t = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
  if (!t) return;
  ensureAudio();
  sfxClick();
  goto(t.dataset.action === 'setup' ? 'setup' : 'play');
}

function enter(): void {
  const host = el();
  if (!host) return;
  three.setMode('space');
  host.innerHTML =
    `<div class="yi-panel yi-mode">` +
    `<h3 class="yi-edit__title">Ne yapmak istersin?</h3>` +
    `<button class="yi-bigbtn yi-bigbtn--pink" type="button" data-action="setup">` +
    `<span class="yi-bigbtn__icon">🎁</span><span class="yi-bigbtn__t">Anıları Gizle</span><span class="yi-bigbtn__s">Oyunu kur</span></button>` +
    `<button class="yi-bigbtn yi-bigbtn--turq" type="button" data-action="play">` +
    `<span class="yi-bigbtn__icon">🚀</span><span class="yi-bigbtn__t">Yolculuğa Çık</span><span class="yi-bigbtn__s">Önizle</span></button>` +
    `</div>`;
  host.addEventListener('click', onClick);
}

function leave(): void {
  const host = el();
  if (!host) return;
  host.removeEventListener('click', onClick);
  host.innerHTML = '';
}

export const scene: Scene = { enter, leave };
