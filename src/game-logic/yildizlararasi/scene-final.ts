// Earth reunion cutscene. The 3D scene shows the bright meadow, the waiting
// partner, the player and the collected memories orbiting overhead. A DOM overlay
// adds blooming flowers, rising hearts and the closing message. Music switches to
// the warm "earth" theme. All timers are gen-guarded so a restart aborts cleanly.

import { setTheme } from './audio';
import { gen, S } from './state';
import * as three from './three-scene';
import type { Scene } from './types';

const FLOWER_GLYPHS = ['🌸', '🌷', '🌼', '🌹', '🌻'];
const HEART_GLYPHS = ['💗', '❤️', '💖'];

let timers: number[] = [];
let heartInterval: number | null = null;

function host(): HTMLElement | null {
  return document.getElementById('yi-final');
}

function reduced(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function later(fn: () => void, ms: number): void {
  const myGen = gen.current();
  timers.push(
    window.setTimeout(() => {
      if (gen.isCurrent(myGen)) fn();
    }, ms),
  );
}

function collectedGlyphs(): string[] {
  return S.data.memories.filter((m) => S.collected.has(m.planetId)).map((m) => m.item);
}

function bloomFlowers(): void {
  const field = host()?.querySelector('.yi-flowers');
  if (!field) return;
  const count = reduced() ? 22 : 70;
  let html = '';
  for (let i = 0; i < count; i++) {
    const x = Math.random() * 100;
    const y = 64 + Math.random() * 32;
    const g = FLOWER_GLYPHS[Math.floor(Math.random() * FLOWER_GLYPHS.length)]!;
    const delay = (Math.random() * 1.6).toFixed(2);
    const scale = (0.6 + Math.random() * 0.8).toFixed(2);
    html += `<span class="yi-flower" style="left:${x}%;top:${y}%;animation-delay:${delay}s;font-size:${scale}rem">${g}</span>`;
  }
  field.innerHTML = html;
}

function spawnHearts(): void {
  const field = host()?.querySelector('.yi-hearts');
  if (!field) return;
  for (let i = 0; i < 3; i++) {
    const h = document.createElement('span');
    h.className = 'yi-heart';
    h.textContent = HEART_GLYPHS[Math.floor(Math.random() * HEART_GLYPHS.length)]!;
    h.style.left = `${5 + Math.random() * 90}%`;
    h.style.fontSize = `${(0.9 + Math.random() * 0.9).toFixed(2)}rem`;
    h.style.animationDuration = `${(2.2 + Math.random() * 1.4).toFixed(2)}s`;
    h.addEventListener('animationend', () => h.remove());
    field.appendChild(h);
  }
}

function startHearts(): void {
  if (reduced()) return;
  const myGen = gen.current();
  heartInterval = window.setInterval(() => {
    if (!gen.isCurrent(myGen)) return;
    spawnHearts();
  }, 360);
  later(() => {
    if (heartInterval !== null) {
      clearInterval(heartInterval);
      heartInterval = null;
    }
  }, 7000);
}

function enter(): void {
  const h = host();
  if (!h) return;
  setTheme('earth');
  three.setPlayer(S.data.characters[S.data.playerIndex]!);
  three.setPartner(S.data.characters[S.data.playerIndex === 0 ? 1 : 0]!);
  three.setMode('final');
  three.buildFinal(collectedGlyphs());
  h.innerHTML =
    `<div class="yi-flowers" aria-hidden="true"></div>` +
    `<div class="yi-hearts" aria-hidden="true"></div>` +
    `<div class="yi-panel yi-final-msg">Tüm evreni gezdim ama en güzel durak sendin.<br><b>Seni Çok Seviyorum!</b></div>`;
  later(() => {
    bloomFlowers();
    startHearts();
  }, 1300);
  later(() => h.querySelector('.yi-final-msg')?.classList.add('yi-final-msg--show'), 2300);
}

function leave(): void {
  timers.forEach((id) => clearTimeout(id));
  timers = [];
  if (heartInterval !== null) {
    clearInterval(heartInterval);
    heartInterval = null;
  }
  const h = host();
  if (h) h.innerHTML = '';
}

export const scene: Scene = { enter, leave };
