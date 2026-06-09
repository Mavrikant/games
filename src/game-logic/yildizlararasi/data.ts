// Static config: planets (Pluto→Earth), item choices, palette, and the demo
// data used when no setup exists (so the public page + smoke test are playable).

import type { Character, GameData, ItemChoice, PlanetDef } from './types';

// Six bodies, Pluto→Earth, with monotonically rising brightness and gradients
// that visibly warm/brighten toward Earth. Only the first five carry a memory;
// Earth is the reunion cutscene.
export const PLANETS: PlanetDef[] = [
  { id: 'pluto', name: 'Plüton', gradTop: '#0B0C10', gradBot: '#1F2833', ground: '#2b3340', planetColor: '#8d8a99', brightness: 0.0, collectible: true },
  { id: 'neptun', name: 'Neptün', gradTop: '#101437', gradBot: '#1f2a55', ground: '#2a3a66', planetColor: '#3b6dd8', brightness: 0.2, collectible: true },
  { id: 'mars', name: 'Mars', gradTop: '#2a1518', gradBot: '#5a2a22', ground: '#7a3a2c', planetColor: '#c1502e', brightness: 0.45, collectible: true },
  { id: 'venus', name: 'Venüs', gradTop: '#3a2a55', gradBot: '#7a5a3a', ground: '#9a6a44', planetColor: '#d8a25a', brightness: 0.66, collectible: true },
  { id: 'merkur', name: 'Merkür', gradTop: '#4a3a5a', gradBot: '#b08a5a', ground: '#c2a070', planetColor: '#b59a78', brightness: 0.85, collectible: true },
  { id: 'earth', name: 'Dünya', gradTop: '#29B6F6', gradBot: '#66BB6A', ground: '#4ca85a', planetColor: '#3aa0e0', brightness: 1.0, collectible: false },
];

export const COLLECTIBLE_PLANETS = PLANETS.filter((p) => p.collectible);

export const ITEM_CHOICES: ItemChoice[] = [
  { glyph: '📸', label: 'Fotoğraf' },
  { glyph: '☕', label: 'Kahve' },
  { glyph: '🎬', label: 'Bilet' },
  { glyph: '🧸', label: 'Oyuncak Ayı' },
  { glyph: '🌹', label: 'Gül' },
  { glyph: '💌', label: 'Mektup' },
  { glyph: '🎵', label: 'Şarkı' },
  { glyph: '🍫', label: 'Çikolata' },
  { glyph: '💍', label: 'Yüzük' },
  { glyph: '🗝️', label: 'Anahtar' },
];

export const HAIR_TYPES: { val: Character['hairType']; label: string }[] = [
  { val: 'kisa', label: 'Kısa' },
  { val: 'uzun', label: 'Uzun' },
  { val: 'toplu', label: 'Toplu' },
  { val: 'kivircik', label: 'Kıvırcık' },
  { val: 'kel', label: 'Kel' },
];

export const ACCESSORIES: { val: Character['accessory']; label: string }[] = [
  { val: 'yok', label: 'Yok' },
  { val: 'gozluk', label: 'Gözlük' },
  { val: 'sapka', label: 'Şapka' },
  { val: 'tac', label: 'Taç' },
];

export const HAIR_COLORS = ['#3b2417', '#6b4423', '#caa45d', '#e8c07d', '#1c1c22', '#b5651d', '#d94f70', '#9b59b6', '#e0e0e0'];
export const EYE_COLORS = ['#5b3a22', '#2e6f4f', '#2a6f97', '#6b7280', '#7a4fa3', '#1c1c22'];
export const SKIN_COLORS = ['#f3c9a6', '#e8b48c', '#c68642', '#8d5524', '#ffdbac', '#5c3a21'];
export const CLOTHING_COLORS = ['#FF4081', '#00BCD4', '#4527A0', '#66BB6A', '#FFEB3B', '#E91E63', '#29B6F6', '#ffffff', '#1c1c22'];

function char(
  hairType: Character['hairType'],
  hairColor: string,
  eyeColor: string,
  skinColor: string,
  clothingColor: string,
  accessory: Character['accessory'] = 'yok',
): Character {
  return { hairType, hairColor, eyeColor, skinColor, clothingColor, accessory };
}

// Charming placeholder memories — one per collectible planet.
export const DEFAULT_DATA: GameData = {
  version: 1,
  characters: [
    char('uzun', '#6b4423', '#2a6f97', '#f3c9a6', '#FF4081'),
    char('kisa', '#1c1c22', '#5b3a22', '#e8b48c', '#00BCD4', 'gozluk'),
  ],
  playerIndex: 0,
  memories: [
    { planetId: 'pluto', item: '📸', itemLabel: 'Fotoğraf', message: 'İlk tanıştığımız o gün... Seni gördüğümde evren bir an durmuştu.' },
    { planetId: 'neptun', item: '☕', itemLabel: 'Kahve', message: 'Saatlerce konuştuğumuz o kahveyi hatırlıyor musun? Zaman su gibi akmıştı.' },
    { planetId: 'mars', item: '🎬', itemLabel: 'Bilet', message: 'O film hiç bitmesin istemiştim, çünkü yanımdaydın.' },
    { planetId: 'venus', item: '🌹', itemLabel: 'Gül', message: 'Bir gül verdiğimde gülüşün bütün gezegeni aydınlatmıştı.' },
    { planetId: 'merkur', item: '💌', itemLabel: 'Mektup', message: 'Bu yolculuğun sonunda söyleyeceğim şeyi sen zaten biliyorsun.' },
  ],
};
