// Character customization: edit "1. Karakter", then "2. Karakter", then choose
// which one is you. Live avatar preview updates on every change.

import { ensureAudio, sfxClick } from './audio';
import { buildAvatarSvg } from './avatar';
import { CLOTHING_COLORS, EYE_COLORS, HAIR_COLORS } from './data';
import { goto } from './router';
import { S } from './state';
import type { HairType, Scene } from './types';

const HAIR_TYPES: { val: HairType; label: string }[] = [
  { val: 'kisa', label: 'Kısa' },
  { val: 'uzun', label: 'Uzun' },
  { val: 'toplu', label: 'Toplu' },
];

function swatches(set: string, colors: string[], current: string): string {
  return colors
    .map(
      (c) =>
        `<button class="yi-swatch${c === current ? ' yi-swatch--on' : ''}" type="button" ` +
        `data-set="${set}" data-val="${c}" style="background:${c}" aria-label="renk"></button>`,
    )
    .join('');
}

function el(): HTMLElement | null {
  return document.getElementById('yi-customize');
}

function renderEdit(): void {
  const host = el();
  if (!host) return;
  const idx = S.customizeIndex;
  const c = S.data.characters[idx]!;
  const hairBtns = HAIR_TYPES.map(
    (h) =>
      `<button class="yi-chip${h.val === c.hairType ? ' yi-chip--on' : ''}" type="button" ` +
      `data-set="hairType" data-val="${h.val}">${h.label}</button>`,
  ).join('');
  host.innerHTML =
    `<div class="yi-panel yi-edit">` +
    `<h3 class="yi-edit__title">${idx + 1}. Karakter</h3>` +
    `<div class="yi-edit__preview">${buildAvatarSvg(c, 120)}</div>` +
    `<div class="yi-edit__row"><span class="yi-edit__lbl">Saç</span><div class="yi-chips">${hairBtns}</div></div>` +
    `<div class="yi-edit__row"><span class="yi-edit__lbl">Saç rengi</span><div class="yi-swatches">${swatches('hairColor', HAIR_COLORS, c.hairColor)}</div></div>` +
    `<div class="yi-edit__row"><span class="yi-edit__lbl">Göz</span><div class="yi-swatches">${swatches('eyeColor', EYE_COLORS, c.eyeColor)}</div></div>` +
    `<div class="yi-edit__row"><span class="yi-edit__lbl">Kıyafet</span><div class="yi-swatches">${swatches('clothingColor', CLOTHING_COLORS, c.clothingColor)}</div></div>` +
    `<button class="yi-btn yi-btn--pink" type="button" data-action="continue">${idx === 0 ? 'Sonraki karakter' : 'Devam'}</button>` +
    `</div>`;
}

function renderChoose(): void {
  const host = el();
  if (!host) return;
  const [a, b] = S.data.characters;
  host.innerHTML =
    `<div class="yi-panel yi-choose">` +
    `<h3 class="yi-edit__title">Hangi karakter sensin?</h3>` +
    `<div class="yi-choose__row">` +
    `<button class="yi-choose__card" type="button" data-action="choose" data-val="0">${buildAvatarSvg(a!, 96)}<span>1. Karakter</span></button>` +
    `<button class="yi-choose__card" type="button" data-action="choose" data-val="1">${buildAvatarSvg(b!, 96)}<span>2. Karakter</span></button>` +
    `</div>` +
    `<p class="yi-hint-line">Seçtiğin karakter oyuncu, diğeri seni bekleyen sevgili olur.</p>` +
    `</div>`;
}

function onClick(e: MouseEvent): void {
  const t = (e.target as HTMLElement).closest<HTMLElement>('[data-set],[data-action]');
  if (!t) return;
  ensureAudio();
  sfxClick();
  const set = t.dataset.set;
  if (set) {
    const c = S.data.characters[S.customizeIndex]!;
    const val = t.dataset.val!;
    if (set === 'hairType') c.hairType = val as HairType;
    else if (set === 'hairColor') c.hairColor = val;
    else if (set === 'eyeColor') c.eyeColor = val;
    else if (set === 'clothingColor') c.clothingColor = val;
    renderEdit();
    return;
  }
  const action = t.dataset.action;
  if (action === 'continue') {
    if (S.customizeIndex === 0) {
      S.customizeIndex = 1;
      renderEdit();
    } else {
      renderChoose();
    }
  } else if (action === 'choose') {
    S.data.playerIndex = (t.dataset.val === '1' ? 1 : 0) as 0 | 1;
    goto('mode');
  }
}

function enter(): void {
  const host = el();
  if (!host) return;
  S.customizeIndex = 0;
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
