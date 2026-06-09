// Earth reunion cutscene: the player approaches the waiting partner; collected
// items orbit, flowers bloom, hearts rise, and the closing message appears.
// Music switches to the warm "earth" theme. All timers are gen-guarded so a
// restart mid-cutscene aborts cleanly.

import { setTheme } from './audio';
import { buildAvatarSvg } from './avatar';
import { gen, S } from './state';
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
  const id = window.setTimeout(() => {
    if (gen.isCurrent(myGen)) fn();
  }, ms);
  timers.push(id);
}

function collectedItems(): string[] {
  return S.data.memories.filter((m) => S.collected.has(m.planetId)).map((m) => m.item);
}

function addOrbit(): void {
  const wrap = host()?.querySelector('.yi-orbit');
  if (!wrap) return;
  const items = collectedItems();
  const n = Math.max(items.length, 1);
  wrap.innerHTML = items
    .map((glyph, i) => {
      const r = 56 + (i % 2) * 26;
      const delay = (-6 * (i / n)).toFixed(2);
      return (
        `<div class="yi-orbit__wrap" style="animation-delay:${delay}s">` +
        `<div class="yi-orbit__arm" style="--r:${r}px">` +
        `<span class="yi-orbit__glyph" style="animation-delay:${delay}s">${glyph}</span></div></div>`
      );
    })
    .join('');
}

function bloomFlowers(): void {
  const field = host()?.querySelector('.yi-flowers');
  if (!field) return;
  const count = reduced() ? 24 : 80;
  let html = '';
  for (let i = 0; i < count; i++) {
    const x = Math.random() * 100;
    const y = 58 + Math.random() * 38;
    const g = FLOWER_GLYPHS[Math.floor(Math.random() * FLOWER_GLYPHS.length)]!;
    const delay = (Math.random() * 1.6).toFixed(2);
    const scale = (0.6 + Math.random() * 0.8).toFixed(2);
    html +=
      `<span class="yi-flower" style="left:${x}%;top:${y}%;` +
      `animation-delay:${delay}s;font-size:${scale}rem">${g}</span>`;
  }
  field.innerHTML = html;
}

function spawnHearts(): void {
  const field = host()?.querySelector('.yi-hearts');
  if (!field) return;
  const burst = 3;
  for (let i = 0; i < burst; i++) {
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
  const partner = S.data.characters[S.data.playerIndex === 0 ? 1 : 0]!;
  const player = S.data.characters[S.data.playerIndex]!;
  h.innerHTML =
    `<div class="yi-earth">` +
    `<div class="yi-flowers" aria-hidden="true"></div>` +
    `<div class="yi-hearts" aria-hidden="true"></div>` +
    `<div class="yi-reunion">` +
    `<div class="yi-orbit" aria-hidden="true"></div>` +
    `<div class="yi-partner">${buildAvatarSvg(partner, 92)}</div>` +
    `</div>` +
    `<div class="yi-final-player">${buildAvatarSvg(player, 72)}</div>` +
    `<div class="yi-panel yi-final-msg">Tüm evreni gezdim ama en güzel durak sendin.<br><b>Seni Çok Seviyorum!</b></div>` +
    `</div>`;
  // Player approaches the partner.
  requestAnimationFrame(() => h.querySelector('.yi-final-player')?.classList.add('yi-final-player--in'));
  later(() => {
    addOrbit();
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
