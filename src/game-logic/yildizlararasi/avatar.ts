// Parameterized inline-SVG avatar (lightweight 2D thumbnail used in the choose
// step and setup rows; the immersive scenes use the 3D avatar). Pure: Character
// in → SVG string out, cheap to re-render on every customization change.

import type { Character } from './types';

function hairBack(c: Character): string {
  if (c.hairType !== 'uzun') return '';
  return `<path d="M22 40 Q18 95 30 110 L70 110 Q82 95 78 40 Z" fill="${c.hairColor}"/>`;
}

function hairFront(c: Character): string {
  const col = c.hairColor;
  if (c.hairType === 'kel') return '';
  if (c.hairType === 'kisa') {
    return `<path d="M26 40 Q26 18 50 18 Q74 18 74 40 Q74 30 50 30 Q26 30 26 40 Z" fill="${col}"/>`;
  }
  if (c.hairType === 'uzun') {
    return `<path d="M24 42 Q24 16 50 16 Q76 16 76 42 Q70 30 50 30 Q30 30 24 42 Z" fill="${col}"/>`;
  }
  if (c.hairType === 'kivircik') {
    let s = '';
    for (let i = 0; i < 7; i++) {
      const x = 28 + i * 7.3;
      s += `<circle cx="${x.toFixed(0)}" cy="26" r="9" fill="${col}"/>`;
    }
    return s + `<circle cx="50" cy="20" r="10" fill="${col}"/>`;
  }
  // toplu: cap + top bun
  return (
    `<circle cx="50" cy="16" r="11" fill="${col}"/>` +
    `<path d="M27 40 Q27 20 50 20 Q73 20 73 40 Q73 30 50 30 Q27 30 27 40 Z" fill="${col}"/>`
  );
}

function accessory(c: Character): string {
  if (c.accessory === 'gozluk') {
    return (
      `<circle cx="40" cy="52" r="7" fill="none" stroke="#1c1c22" stroke-width="2"/>` +
      `<circle cx="60" cy="52" r="7" fill="none" stroke="#1c1c22" stroke-width="2"/>` +
      `<line x1="47" y1="52" x2="53" y2="52" stroke="#1c1c22" stroke-width="2"/>`
    );
  }
  if (c.accessory === 'sapka') {
    return `<rect x="24" y="20" width="52" height="6" rx="3" fill="#4527A0"/><rect x="34" y="8" width="32" height="16" rx="4" fill="#4527A0"/>`;
  }
  if (c.accessory === 'tac') {
    return `<path d="M34 22 L40 12 L50 20 L60 12 L66 22 Z" fill="#FFEB3B" stroke="#e0b400" stroke-width="1"/>`;
  }
  return '';
}

export function buildAvatarSvg(c: Character, size = 120): string {
  const skin = c.skinColor || '#f3c9a6';
  return (
    `<svg class="yi-avatar" viewBox="0 0 100 140" width="${size}" height="${size * 1.4}" role="img" aria-label="Karakter">` +
    hairBack(c) +
    `<path d="M28 132 Q28 86 50 86 Q72 86 72 132 Z" fill="${c.clothingColor}"/>` +
    `<rect x="45" y="74" width="10" height="12" fill="${skin}"/>` +
    `<circle cx="50" cy="50" r="26" fill="${skin}"/>` +
    hairFront(c) +
    `<circle cx="40" cy="52" r="3.4" fill="${c.eyeColor}"/>` +
    `<circle cx="60" cy="52" r="3.4" fill="${c.eyeColor}"/>` +
    `<path d="M42 62 Q50 70 58 62" stroke="#9a5a4a" stroke-width="2.4" fill="none" stroke-linecap="round"/>` +
    accessory(c) +
    `</svg>`
  );
}
