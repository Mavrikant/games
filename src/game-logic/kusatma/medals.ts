// Achievement / medal registry. Pure data; awarding logic lives in flow.ts.

import type { MedalDef } from './types';

export const MEDALS: MedalDef[] = [
  { id: 'first-clear', name: 'İlk Zafer', desc: 'İlk kaleyi düşür.', glyph: '🏳️' },
  { id: 'world-0', name: 'Sınır Fatihi', desc: 'Sınır Boyu’nu bitir.', glyph: '🛡️' },
  { id: 'world-1', name: 'Çöl Fatihi', desc: 'Çöl Kaleleri’ni bitir.', glyph: '🏜️' },
  { id: 'world-2', name: 'Dağ Fatihi', desc: 'Dağ Geçidi’ni bitir.', glyph: '⛰️' },
  { id: 'world-3', name: 'Nehir Fatihi', desc: 'Nehir Kalesi’ni bitir.', glyph: '🌊' },
  { id: 'world-4', name: 'Volkan Fatihi', desc: 'Volkan Surları’nı bitir.', glyph: '🌋' },
  { id: 'world-5', name: 'Cihan Fatihi', desc: 'Başkent Kuşatması’nı bitir.', glyph: '👑' },
  { id: 'stars-30', name: 'Yıldız Avcısı', desc: '30 yıldız topla.', glyph: '⭐' },
  { id: 'stars-90', name: 'Yıldız Ustası', desc: '90 yıldız topla.', glyph: '🌟' },
  { id: 'stars-150', name: 'Yıldız Efsanesi', desc: '150 yıldız topla.', glyph: '✨' },
  { id: 'big-chain', name: 'Domino', desc: 'Tek atışta 6+ blok yık.', glyph: '💥' },
  { id: 'one-shot', name: 'Tek Atış', desc: 'Bir seviyeyi tek atışta geç.', glyph: '🎯' },
  { id: 'demolition', name: 'Tam Yıkım', desc: 'Bir seviyede tüm blokları yık.', glyph: '🧨' },
  { id: 'perfect-world', name: 'Kusursuz Kuşatma', desc: 'Bir dünyayı tam 3 yıldızla bitir.', glyph: '🏆' },
];

export const MEDAL_BY_ID: Record<string, MedalDef> = Object.fromEntries(
  MEDALS.map((m) => [m.id, m]),
);
