// Parameterized inline-SVG avatar. Pure: Character in → SVG string out, so it is
// cheap to re-render live on every customization change.

import type { Character } from './types';

const SKIN = '#f3c9a6';

function hairBack(c: Character): string {
  // Long hair flows behind the shoulders.
  if (c.hairType !== 'uzun') return '';
  return `<path d="M22 40 Q18 95 30 110 L70 110 Q82 95 78 40 Z" fill="${c.hairColor}"/>`;
}

function hairFront(c: Character): string {
  const col = c.hairColor;
  if (c.hairType === 'kisa') {
    return `<path d="M26 40 Q26 18 50 18 Q74 18 74 40 Q74 30 50 30 Q26 30 26 40 Z" fill="${col}"/>`;
  }
  if (c.hairType === 'uzun') {
    return `<path d="M24 42 Q24 16 50 16 Q76 16 76 42 Q70 30 50 30 Q30 30 24 42 Z" fill="${col}"/>`;
  }
  // toplu: cap + top bun
  return (
    `<circle cx="50" cy="16" r="11" fill="${col}"/>` +
    `<path d="M27 40 Q27 20 50 20 Q73 20 73 40 Q73 30 50 30 Q27 30 27 40 Z" fill="${col}"/>`
  );
}

export function buildAvatarSvg(c: Character, size = 120): string {
  const eye = c.eyeColor;
  return (
    `<svg class="yi-avatar" viewBox="0 0 100 140" width="${size}" height="${size * 1.4}" role="img" aria-label="Karakter">` +
    hairBack(c) +
    // body / torso
    `<path d="M28 132 Q28 86 50 86 Q72 86 72 132 Z" fill="${c.clothingColor}"/>` +
    // neck
    `<rect x="45" y="74" width="10" height="12" fill="${SKIN}"/>` +
    // head
    `<circle cx="50" cy="50" r="26" fill="${SKIN}"/>` +
    hairFront(c) +
    // eyes
    `<circle cx="40" cy="52" r="3.4" fill="${eye}"/>` +
    `<circle cx="60" cy="52" r="3.4" fill="${eye}"/>` +
    // smile
    `<path d="M42 62 Q50 70 58 62" stroke="#9a5a4a" stroke-width="2.4" fill="none" stroke-linecap="round"/>` +
    `</svg>`
  );
}
