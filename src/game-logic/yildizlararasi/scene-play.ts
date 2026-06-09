// The journey: move the player (mouse/touch + keyboard), collect the glowing
// memory (popup), then enter the galaxy portal to the next planet. Earth ends in
// the reunion cutscene. Guards: overlay-input-leak, stale-async-callback,
// invisible-boot, deadzone-blocks-keyboard-steering.

import { hideOverlay, showOverlay } from '@shared/overlay';
import { ensureAudio, sfxClick, sfxPickup, sfxPortal } from './audio';
import { buildAvatarSvg } from './avatar';
import { PLANETS } from './data';
import { goto } from './router';
import { gen, S, type Vec } from './state';
import type { Memory, Scene } from './types';

const START: Vec = { x: 50, y: 80 };
const ITEM_POS: Vec = { x: 24, y: 46 };
const PORTAL_POS: Vec = { x: 76, y: 34 };
const ITEM_R = 12;
const PORTAL_R = 11;
const KEY_SPEED = 1.15;
const LERP = 0.12;

let running = false;
let portalTimer: number | null = null;
let playerEl: HTMLElement | null = null;
let itemEl: HTMLElement | null = null;
let portalEl: HTMLElement | null = null;

function host(): HTMLElement | null {
  return document.getElementById('yi-play');
}

function memoryFor(planetId: string): Memory | undefined {
  return S.data.memories.find((m) => m.planetId === planetId);
}

function setPos(el: HTMLElement | null, p: Vec): void {
  if (!el) return;
  el.style.left = `${p.x}%`;
  el.style.top = `${p.y}%`;
}

function dist(a: Vec, b: Vec): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function updateBag(): void {
  const c = document.getElementById('yi-bag-count');
  if (c) c.textContent = String(S.collected.size);
}

function loadPlanet(idx: number): void {
  const h = host();
  if (!h) return;
  S.planetIndex = idx;
  const planet = PLANETS[idx]!;
  const mem = memoryFor(planet.id);
  S.pos = { ...START };
  S.target = { ...START };
  S.keys.clear();
  const collected = !mem || S.collected.has(planet.id);
  if (!mem) S.collected.add(planet.id);
  h.innerHTML =
    `<div class="yi-play__top"><span class="yi-planet-name">${planet.name}</span>` +
    `<span class="yi-backpack">🎒 <b id="yi-bag-count">${S.collected.size}</b></span></div>` +
    `<div id="yi-portal" class="yi-portal${collected ? ' yi-portal--ready' : ''}" aria-hidden="true"></div>` +
    (mem && !collected ? `<div id="yi-item" class="yi-item-glow">${mem.item}</div>` : '') +
    `<div id="yi-player" class="yi-player"></div>` +
    `<div class="yi-play__hint">${collected ? 'Portala gir →' : 'Parlayan anıya ulaş'}</div>`;
  playerEl = document.getElementById('yi-player');
  itemEl = document.getElementById('yi-item');
  portalEl = document.getElementById('yi-portal');
  if (playerEl) playerEl.innerHTML = buildAvatarSvg(S.data.characters[S.data.playerIndex]!, 64);
  setPos(playerEl, S.pos);
  setPos(itemEl, ITEM_POS);
  setPos(portalEl, PORTAL_POS);
}

function openPopup(mem: Memory): void {
  S.popupOpen = true;
  S.inputLocked = true;
  S.keys.clear();
  const icon = document.getElementById('yi-popup-icon');
  const msg = document.getElementById('yi-popup-msg');
  const popup = document.getElementById('yi-popup');
  if (icon) icon.textContent = mem.item;
  if (msg) msg.textContent = mem.message || '...';
  if (popup) showOverlay(popup);
  sfxClick();
}

function flyToBag(): void {
  const h = host();
  if (!h || !itemEl) return;
  const fly = document.createElement('div');
  fly.className = 'yi-fly';
  fly.textContent = itemEl.textContent;
  fly.style.left = itemEl.style.left;
  fly.style.top = itemEl.style.top;
  h.appendChild(fly);
  itemEl.remove();
  itemEl = null;
  // Trigger transition to the backpack (top-right) on the next frame.
  requestAnimationFrame(() => {
    fly.style.left = '88%';
    fly.style.top = '8%';
    fly.style.opacity = '0';
    fly.style.transform = 'translate(-50%, -50%) scale(0.4)';
  });
  const myGen = gen.current();
  window.setTimeout(() => {
    if (gen.isCurrent(myGen)) fly.remove();
  }, 700);
}

function closePopup(): void {
  if (!S.popupOpen) return;
  const popup = document.getElementById('yi-popup');
  if (popup) hideOverlay(popup);
  S.popupOpen = false;
  S.inputLocked = false;
  const planet = PLANETS[S.planetIndex]!;
  S.collected.add(planet.id);
  updateBag();
  sfxPickup();
  flyToBag();
  portalEl?.classList.add('yi-portal--ready');
  const hint = host()?.querySelector('.yi-play__hint');
  if (hint) hint.textContent = 'Portala gir →';
}

function startPortal(): void {
  S.portalActive = true;
  S.inputLocked = true;
  S.keys.clear();
  sfxPortal();
  const fade = document.getElementById('yi-fade');
  fade?.classList.add('yi-fade--on');
  const myGen = gen.current();
  portalTimer = window.setTimeout(() => {
    if (!gen.isCurrent(myGen)) return;
    const next = S.planetIndex + 1;
    const nextPlanet = PLANETS[next];
    if (!nextPlanet || !nextPlanet.collectible) {
      if (nextPlanet) S.planetIndex = next; // Earth → full brightness
      goto('final');
      return;
    }
    loadPlanet(next);
    fade?.classList.remove('yi-fade--on');
    S.portalActive = false;
    S.inputLocked = false;
  }, 950);
}

function step(): void {
  if (S.inputLocked) return;
  if (S.keys.size > 0) {
    let dx = 0;
    let dy = 0;
    if (S.keys.has('left')) dx -= 1;
    if (S.keys.has('right')) dx += 1;
    if (S.keys.has('up')) dy -= 1;
    if (S.keys.has('down')) dy += 1;
    const len = Math.hypot(dx, dy) || 1;
    S.pos.x = clamp(S.pos.x + (dx / len) * KEY_SPEED);
    S.pos.y = clamp(S.pos.y + (dy / len) * KEY_SPEED);
  } else if (dist(S.pos, S.target) > 0.6) {
    S.pos.x += (S.target.x - S.pos.x) * LERP;
    S.pos.y += (S.target.y - S.pos.y) * LERP;
  }
  setPos(playerEl, S.pos);

  const planet = PLANETS[S.planetIndex]!;
  const mem = memoryFor(planet.id);
  const collected = S.collected.has(planet.id);
  if (mem && !collected && !S.popupOpen && dist(S.pos, ITEM_POS) < ITEM_R) {
    openPopup(mem);
  } else if (collected && !S.portalActive && dist(S.pos, PORTAL_POS) < PORTAL_R) {
    startPortal();
  }
}

function clamp(v: number): number {
  return Math.max(4, Math.min(96, v));
}

function loop(myGen: number): void {
  if (!running || !gen.isCurrent(myGen)) return;
  step();
  requestAnimationFrame(() => loop(myGen));
}

function onPointerDown(e: PointerEvent): void {
  if (S.inputLocked) return;
  const h = host();
  if (!h) return;
  const r = h.getBoundingClientRect();
  S.target = {
    x: clamp(((e.clientX - r.left) / r.width) * 100),
    y: clamp(((e.clientY - r.top) / r.height) * 100),
  };
}

function dirFor(key: string): 'left' | 'right' | 'up' | 'down' | null {
  if (key === 'arrowleft' || key === 'a') return 'left';
  if (key === 'arrowright' || key === 'd') return 'right';
  if (key === 'arrowup' || key === 'w') return 'up';
  if (key === 'arrowdown' || key === 's') return 'down';
  return null;
}

function onKeyDown(e: KeyboardEvent): void {
  if (S.popupOpen && (e.key === 'Enter' || e.key === 'Escape')) {
    closePopup();
    return;
  }
  const d = dirFor(e.key.toLowerCase());
  if (!d) return;
  e.preventDefault();
  if (S.inputLocked) return;
  S.keys.add(d);
}

function onKeyUp(e: KeyboardEvent): void {
  const d = dirFor(e.key.toLowerCase());
  if (!d) return;
  S.keys.delete(d);
  if (S.keys.size === 0) S.target = { ...S.pos };
}

function onPopupClose(): void {
  ensureAudio();
  closePopup();
}

function enter(): void {
  const h = host();
  if (!h) return;
  running = true;
  S.popupOpen = false;
  S.portalActive = false;
  S.inputLocked = false;
  loadPlanet(S.planetIndex);
  h.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  document.getElementById('yi-popup-close')?.addEventListener('click', onPopupClose);
  const myGen = gen.current();
  requestAnimationFrame(() => loop(myGen));
}

function leave(): void {
  running = false;
  if (portalTimer !== null) {
    clearTimeout(portalTimer);
    portalTimer = null;
  }
  const h = host();
  h?.removeEventListener('pointerdown', onPointerDown);
  window.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('keyup', onKeyUp);
  document.getElementById('yi-popup-close')?.removeEventListener('click', onPopupClose);
  const popup = document.getElementById('yi-popup');
  if (popup) hideOverlay(popup);
  document.getElementById('yi-fade')?.classList.remove('yi-fade--on');
  if (h) h.innerHTML = '';
}

export const scene: Scene = { enter, leave };
