// Character customization with a live 3D preview. The roles are fixed: the 1st
// character is the founder (who sets the journey up and waits at Earth) and the
// 2nd is the recipient (who travels and collects). Options: hair type (incl.
// curly / bald), hair color, skin tone, eye color, clothing color, accessory.

import { ensureAudio, sfxClick } from './audio';
import { ACCESSORIES, CLOTHING_COLORS, EYE_COLORS, HAIR_COLORS, HAIR_TYPES, SKIN_COLORS } from './data';
import { goto } from './router';
import { S } from './state';
import * as three from './three-scene';
import type { Character, Scene } from './types';

const ROLE = ['1. Karakter · Sen (kuran)', '2. Karakter · Sevgilin (yolcu)'];

function el(): HTMLElement | null {
  return document.getElementById('yi-customize');
}

function swatches(set: string, colors: string[], current: string): string {
  return colors
    .map(
      (c) =>
        `<button class="yi-swatch${c === current ? ' yi-swatch--on' : ''}" type="button" ` +
        `data-set="${set}" data-val="${c}" style="background:${c}" aria-label="renk"></button>`,
    )
    .join('');
}

function chips(set: string, opts: { val: string; label: string }[], current: string): string {
  return opts
    .map(
      (o) =>
        `<button class="yi-chip${o.val === current ? ' yi-chip--on' : ''}" type="button" ` +
        `data-set="${set}" data-val="${o.val}">${o.label}</button>`,
    )
    .join('');
}

function preview(): void {
  three.setAvatarPreview(S.data.characters[S.customizeIndex]!);
}

function renderEdit(): void {
  const host = el();
  if (!host) return;
  const idx = S.customizeIndex;
  const c = S.data.characters[idx]!;
  host.innerHTML =
    `<div class="yi-sheet yi-panel">` +
    `<h3 class="yi-edit__title">${ROLE[idx]}</h3>` +
    `<div class="yi-edit__row"><span class="yi-edit__lbl">Saç</span><div class="yi-chips">${chips('hairType', HAIR_TYPES, c.hairType)}</div></div>` +
    `<div class="yi-edit__row"><span class="yi-edit__lbl">Saç rengi</span><div class="yi-swatches">${swatches('hairColor', HAIR_COLORS, c.hairColor)}</div></div>` +
    `<div class="yi-edit__row"><span class="yi-edit__lbl">Ten</span><div class="yi-swatches">${swatches('skinColor', SKIN_COLORS, c.skinColor)}</div></div>` +
    `<div class="yi-edit__row"><span class="yi-edit__lbl">Göz</span><div class="yi-swatches">${swatches('eyeColor', EYE_COLORS, c.eyeColor)}</div></div>` +
    `<div class="yi-edit__row"><span class="yi-edit__lbl">Kıyafet</span><div class="yi-swatches">${swatches('clothingColor', CLOTHING_COLORS, c.clothingColor)}</div></div>` +
    `<div class="yi-edit__row"><span class="yi-edit__lbl">Aksesuar</span><div class="yi-chips">${chips('accessory', ACCESSORIES, c.accessory)}</div></div>` +
    `<button class="yi-btn yi-btn--pink" type="button" data-action="continue">${idx === 0 ? 'Sonraki karakter →' : 'Devam'}</button>` +
    `</div>`;
}

function setField(c: Character, set: string, val: string): void {
  if (set === 'hairType') c.hairType = val as Character['hairType'];
  else if (set === 'hairColor') c.hairColor = val;
  else if (set === 'skinColor') c.skinColor = val;
  else if (set === 'eyeColor') c.eyeColor = val;
  else if (set === 'clothingColor') c.clothingColor = val;
  else if (set === 'accessory') c.accessory = val as Character['accessory'];
}

function onClick(e: MouseEvent): void {
  const t = (e.target as HTMLElement).closest<HTMLElement>('[data-set],[data-action]');
  if (!t) return;
  ensureAudio();
  sfxClick();
  const set = t.dataset.set;
  if (set) {
    setField(S.data.characters[S.customizeIndex]!, set, t.dataset.val!);
    preview();
    renderEdit();
    return;
  }
  if (t.dataset.action === 'continue') {
    if (S.customizeIndex === 0) {
      S.customizeIndex = 1;
      preview();
      renderEdit();
    } else {
      goto('mode');
    }
  }
}

function enter(): void {
  const host = el();
  if (!host) return;
  S.customizeIndex = 0;
  three.setMode('avatar');
  preview();
  host.addEventListener('click', onClick);
  renderEdit();
}

function leave(): void {
  const host = el();
  if (!host) return;
  host.removeEventListener('click', onClick);
  host.innerHTML = '';
}

export const scene: Scene = { enter, leave };
