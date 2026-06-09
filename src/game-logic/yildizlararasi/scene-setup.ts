// Setup mode: the founder hides an item + love message on each planet, then
// copies a share link (the data is base64-encoded into the URL hash).

import { ensureAudio, sfxClick, sfxPickup } from './audio';
import { COLLECTIBLE_PLANETS, ITEM_CHOICES } from './data';
import { goto } from './router';
import { persistData, S } from './state';
import { buildShareUrl, copyToClipboard } from './share';
import type { Memory, Scene } from './types';

let editing: string | null = null; // planetId being edited

function el(): HTMLElement | null {
  return document.getElementById('yi-setup');
}

function memoryFor(planetId: string): Memory {
  let m = S.data.memories.find((x) => x.planetId === planetId);
  if (!m) {
    const first = ITEM_CHOICES[0]!;
    m = { planetId, item: first.glyph, itemLabel: first.label, message: '' };
    S.data.memories.push(m);
  }
  return m;
}

function syncTextarea(): void {
  if (!editing) return;
  const ta = document.getElementById('yi-msg') as HTMLTextAreaElement | null;
  if (ta) memoryFor(editing).message = ta.value;
}

function renderList(): void {
  const host = el();
  if (!host) return;
  const rows = COLLECTIBLE_PLANETS.map((p) => {
    const m = memoryFor(p.id);
    const preview = m.message.trim() ? m.message.trim().slice(0, 40) : 'anı ekle';
    return (
      `<button class="yi-plrow" type="button" data-action="open" data-planet="${p.id}">` +
      `<span class="yi-plrow__icon">${m.item}</span>` +
      `<span class="yi-plrow__txt"><b>${p.name}</b><small>${preview}</small></span></button>`
    );
  }).join('');
  host.innerHTML =
    `<div class="yi-panel yi-setup">` +
    `<h3 class="yi-edit__title">Anıları Gizle</h3>` +
    `<div class="yi-pllist">${rows}</div>` +
    `<div class="yi-setup__actions">` +
    `<button class="yi-btn yi-btn--turq" type="button" data-action="copy">🔗 Linki Kopyala</button>` +
    `<span id="yi-copy-note" class="yi-copy-note" aria-live="polite"></span>` +
    `</div>` +
    `<div class="yi-setup__actions">` +
    `<button class="yi-btn yi-btn--ghost" type="button" data-action="done">Geri</button>` +
    `<button class="yi-btn yi-btn--pink" type="button" data-action="play">Hemen Oyna</button>` +
    `</div></div>`;
}

function renderEdit(): void {
  const host = el();
  if (!host || !editing) return;
  const planet = COLLECTIBLE_PLANETS.find((p) => p.id === editing)!;
  const m = memoryFor(editing);
  const items = ITEM_CHOICES.map(
    (it) =>
      `<button class="yi-item${it.glyph === m.item ? ' yi-item--on' : ''}" type="button" ` +
      `data-item="${it.glyph}" data-label="${it.label}" title="${it.label}">${it.glyph}</button>`,
  ).join('');
  host.innerHTML =
    `<div class="yi-panel yi-setup-edit">` +
    `<h3 class="yi-edit__title">${planet.name}</h3>` +
    `<div class="yi-items">${items}</div>` +
    `<textarea id="yi-msg" class="yi-msg" maxlength="240" placeholder="Bu anıya özel güzel sözlerini yaz...">${m.message}</textarea>` +
    `<div class="yi-setup__actions">` +
    `<button class="yi-btn yi-btn--ghost" type="button" data-action="cancel">İptal</button>` +
    `<button class="yi-btn yi-btn--turq" type="button" data-action="save">Kaydet</button>` +
    `</div></div>`;
}

async function doCopy(): Promise<void> {
  const note = document.getElementById('yi-copy-note');
  const ok = await copyToClipboard(buildShareUrl(S.data));
  if (note) note.textContent = ok ? 'Kopyalandı! 💌' : 'Kopyalanamadı';
}

function onClick(e: MouseEvent): void {
  const t = (e.target as HTMLElement).closest<HTMLElement>('[data-action],[data-item]');
  if (!t) return;
  ensureAudio();
  if (t.dataset.item) {
    syncTextarea();
    const m = memoryFor(editing!);
    m.item = t.dataset.item;
    m.itemLabel = t.dataset.label ?? m.itemLabel;
    sfxClick();
    renderEdit();
    return;
  }
  const action = t.dataset.action!;
  if (action === 'open') {
    editing = t.dataset.planet ?? null;
    sfxClick();
    renderEdit();
  } else if (action === 'save') {
    syncTextarea();
    persistData();
    editing = null;
    sfxPickup();
    renderList();
  } else if (action === 'cancel') {
    editing = null;
    sfxClick();
    renderList();
  } else if (action === 'copy') {
    sfxClick();
    void doCopy();
  } else if (action === 'done') {
    sfxClick();
    persistData();
    goto('mode');
  } else if (action === 'play') {
    sfxClick();
    persistData();
    goto('play');
  }
}

function enter(): void {
  const host = el();
  if (!host) return;
  editing = null;
  COLLECTIBLE_PLANETS.forEach((p) => memoryFor(p.id)); // ensure entries exist
  host.addEventListener('click', onClick);
  renderList();
}

function leave(): void {
  const host = el();
  if (!host) return;
  host.removeEventListener('click', onClick);
  host.innerHTML = '';
}

export const scene: Scene = { enter, leave };
