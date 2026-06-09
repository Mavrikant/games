// The journey, now in 3D. The player moves on the planet surface (mouse/touch
// raycast + WASD/arrows); reaching the glowing memory launches a random
// mini-game that must be won to open the memory; then the galaxy portal carries
// the player to the next planet. Earth ends in the reunion cutscene. Guards:
// overlay-input-leak, stale-async-callback, deadzone-blocks-keyboard-steering.

import { hideOverlay, showOverlay } from '@shared/overlay';
import { ensureAudio, sfxClick, sfxPortal } from './audio';
import { PLANETS } from './data';
import { cancelMiniGame, playRandomMiniGame } from './minigames';
import { goto } from './router';
import { gen, S } from './state';
import * as three from './three-scene';
import type { Memory, Scene } from './types';

const KEY_SPEED = 4.6; // world units / second
const LERP = 6.0;
const ITEM_R = 1.7;
const PORTAL_R = 1.6;
const X_MIN = -6;
const X_MAX = 6;
const Z_MIN = -5;
const Z_MAX = 6;

let portalTimer: number | null = null;
let nextTryAt = 0;

function host(): HTMLElement | null {
  return document.getElementById('yi-play');
}

function memoryFor(planetId: string): Memory | undefined {
  return S.data.memories.find((m) => m.planetId === planetId);
}

function clampX(v: number): number {
  return Math.max(X_MIN, Math.min(X_MAX, v));
}
function clampZ(v: number): number {
  return Math.max(Z_MIN, Math.min(Z_MAX, v));
}
function dist(ax: number, az: number, bx: number, bz: number): number {
  return Math.hypot(ax - bx, az - bz);
}

function setHint(text: string): void {
  const h = host()?.querySelector('.yi-play__hint');
  if (h) h.textContent = text;
}
function updateBag(): void {
  const c = host()?.querySelector('.yi-bag-count');
  if (c) c.textContent = String(S.collected.size);
}

function loadPlanet(idx: number): void {
  const h = host();
  if (!h) return;
  S.planetIndex = idx;
  three.setPlanet(idx);
  const planet = PLANETS[idx]!;
  const mem = memoryFor(planet.id);
  S.p3 = { ...three.START3D };
  S.t3 = { ...three.START3D };
  S.keys.clear();
  nextTryAt = 0;
  const collected = !mem || S.collected.has(planet.id);
  if (!mem) S.collected.add(planet.id);
  three.placePlayerStart();
  if (mem && !collected) three.spawnItem(mem.item);
  else three.clearItem();
  three.setPortalReady(collected);
  h.innerHTML =
    `<div class="yi-hud-top"><span class="yi-planet-name">${planet.name}</span>` +
    `<span class="yi-backpack">🎒 <b class="yi-bag-count">${S.collected.size}</b></span></div>` +
    `<div class="yi-play__hint">${collected ? 'Portala gir →' : 'Parlayan anıya yürü'}</div>`;
}

function flyToBag(glyph: string): void {
  const h = host();
  if (!h) return;
  const fly = document.createElement('div');
  fly.className = 'yi-fly';
  fly.textContent = glyph;
  fly.style.left = '50%';
  fly.style.top = '55%';
  h.appendChild(fly);
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
}

function closePopup(): void {
  if (!S.popupOpen) return;
  const popup = document.getElementById('yi-popup');
  if (popup) hideOverlay(popup);
  S.popupOpen = false;
  S.inputLocked = false;
  const planet = PLANETS[S.planetIndex]!;
  const mem = memoryFor(planet.id);
  S.collected.add(planet.id);
  updateBag();
  sfxClick();
  if (mem) flyToBag(mem.item);
  three.clearItem();
  three.setPortalReady(true);
  setHint('Portala gir →');
}

async function startMiniGame(mem: Memory): Promise<void> {
  S.minigameActive = true;
  S.inputLocked = true;
  S.keys.clear();
  const mg = document.getElementById('yi-minigame');
  const slot = mg?.querySelector<HTMLElement>('.yi-minigame__host');
  if (mg) showOverlay(mg);
  const myGen = gen.current();
  const win = slot ? await playRandomMiniGame(slot) : false;
  if (!gen.isCurrent(myGen)) return; // a restart happened mid mini-game
  if (mg) hideOverlay(mg);
  if (slot) slot.innerHTML = '';
  S.minigameActive = false;
  if (win) {
    openPopup(mem); // keeps inputLocked until the player closes the memory
  } else {
    S.inputLocked = false;
    nextTryAt = performance.now() + 1400;
    setHint('Olmadı! Anıya tekrar yürü');
  }
}

function startPortal(): void {
  S.portalActive = true;
  S.inputLocked = true;
  S.keys.clear();
  sfxPortal();
  document.getElementById('yi-fade')?.classList.add('yi-fade--on');
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
    document.getElementById('yi-fade')?.classList.remove('yi-fade--on');
    S.portalActive = false;
    S.inputLocked = false;
  }, 950);
}

function frameCb(dt: number): void {
  if (S.inputLocked) return;
  const prevX = S.p3.x;
  const prevZ = S.p3.z;
  let dx = 0;
  let dz = 0;
  if (S.keys.has('left')) dx -= 1;
  if (S.keys.has('right')) dx += 1;
  if (S.keys.has('up')) dz -= 1;
  if (S.keys.has('down')) dz += 1;
  if (dx !== 0 || dz !== 0) {
    const len = Math.hypot(dx, dz) || 1;
    S.p3.x = clampX(S.p3.x + (dx / len) * KEY_SPEED * dt);
    S.p3.z = clampZ(S.p3.z + (dz / len) * KEY_SPEED * dt);
    S.t3 = { ...S.p3 };
  } else if (dist(S.p3.x, S.p3.z, S.t3.x, S.t3.z) > 0.05) {
    const k = Math.min(1, LERP * dt);
    S.p3.x += (S.t3.x - S.p3.x) * k;
    S.p3.z += (S.t3.z - S.p3.z) * k;
  }
  three.setPlayerPos(S.p3.x, S.p3.z, S.p3.x - prevX, S.p3.z - prevZ);

  const planet = PLANETS[S.planetIndex]!;
  const mem = memoryFor(planet.id);
  const collected = S.collected.has(planet.id);
  if (mem && !collected) {
    if (dist(S.p3.x, S.p3.z, three.ITEM3D.x, three.ITEM3D.z) < ITEM_R && performance.now() >= nextTryAt) {
      void startMiniGame(mem);
    }
  } else if (collected && !S.portalActive && dist(S.p3.x, S.p3.z, three.PORTAL3D.x, three.PORTAL3D.z) < PORTAL_R) {
    startPortal();
  }
}

function onPointerDown(e: PointerEvent): void {
  if (S.inputLocked) return;
  const g = three.pointerToGround(e.clientX, e.clientY);
  if (g) S.t3 = { x: clampX(g.x), z: clampZ(g.z) };
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
  if (S.keys.size === 0) S.t3 = { ...S.p3 };
}

function onPopupClose(): void {
  ensureAudio();
  closePopup();
}

function enter(): void {
  const h = host();
  if (!h) return;
  S.popupOpen = false;
  S.portalActive = false;
  S.minigameActive = false;
  S.inputLocked = false;
  three.setPlayer(S.data.characters[S.data.playerIndex]!);
  three.setPartner(S.data.characters[S.data.playerIndex === 0 ? 1 : 0]!);
  three.setMode('space');
  loadPlanet(S.planetIndex);
  three.setFrameCallback(frameCb);
  document.getElementById('yi-gl')?.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  document.getElementById('yi-popup-close')?.addEventListener('click', onPopupClose);
}

function leave(): void {
  if (portalTimer !== null) {
    clearTimeout(portalTimer);
    portalTimer = null;
  }
  cancelMiniGame();
  three.setFrameCallback(null);
  document.getElementById('yi-gl')?.removeEventListener('pointerdown', onPointerDown);
  window.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('keyup', onKeyUp);
  document.getElementById('yi-popup-close')?.removeEventListener('click', onPopupClose);
  const popup = document.getElementById('yi-popup');
  if (popup) hideOverlay(popup);
  const mg = document.getElementById('yi-minigame');
  if (mg) hideOverlay(mg);
  document.getElementById('yi-fade')?.classList.remove('yi-fade--on');
  const h = host();
  if (h) h.innerHTML = '';
}

export const scene: Scene = { enter, leave };
