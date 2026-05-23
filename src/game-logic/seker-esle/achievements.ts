// 14 milestone badges. Each has an unlock condition (event + state check)
// and a booster reward granted at unlock. Drives meta progression.

import type { AchievementDef, AchievementEvent } from './types';
import { state, unlockAchievement, addBooster, persistProfile } from './state';
import { showAchievementToast } from './overlays';

export const ACHIEVEMENTS: AchievementDef[] = [
  { id: 'first-match', label: 'İlk Eşleşme', desc: 'Bir eşleşme yarat', icon: '🍬', reward: {} },
  { id: 'first-combo', label: 'İlk Combo', desc: 'Cascade x2', icon: '✨', reward: { plus5Moves: 1 } },
  { id: 'cascade-5', label: '5 Cascade', desc: 'Cascade derinliği 5', icon: '🌪️', reward: { hammer: 1 } },
  { id: 'first-special', label: 'İlk Özel Şeker', desc: 'Bir özel şeker yarat', icon: '⭐', reward: { swap: 1 } },
  { id: 'color-bomb', label: 'Renk Bombası', desc: 'Renk bombası yarat', icon: '💣', reward: { colorBombStart: 1 } },
  { id: 'combo-streak-5', label: 'Üst Üste Patlama', desc: '5 ardışık hamle combo', icon: '🔥', reward: { hammer: 1 } },
  { id: 'perfect-level', label: 'Mükemmel Seviye', desc: '3 yıldız topla', icon: '🌟', reward: { swap: 1 } },
  { id: 'level-10', label: '10 Seviye', desc: '10. seviyeye ulaş', icon: '🎯', reward: { plus5Moves: 2 } },
  { id: 'level-25', label: '25 Seviye', desc: '25. seviyeye ulaş', icon: '🏅', reward: { hammer: 1, swap: 1 } },
  { id: 'level-50', label: '50 Seviye', desc: '50. seviyeye ulaş', icon: '🏆', reward: { colorBombStart: 1 } },
  { id: 'level-100', label: '100 Seviye', desc: '100. seviyeyi tamamla', icon: '👑', reward: { hammer: 2, swap: 2, colorBombStart: 1 } },
  { id: 'stars-50', label: '50 Yıldız', desc: 'Toplam 50 yıldız', icon: '⭐', reward: { plus5Moves: 2 } },
  { id: 'stars-100', label: '100 Yıldız', desc: 'Toplam 100 yıldız', icon: '🌠', reward: { colorBombStart: 1 } },
  { id: 'streak-7', label: '7 Günlük Seri', desc: '7 gün üst üste oyna', icon: '📅', reward: { hammer: 1, swap: 1, plus5Moves: 1 } },
];

const ACH_BY_ID = new Map(ACHIEVEMENTS.map((a) => [a.id, a]));

export function recordAchievementEvent(ev: AchievementEvent): void {
  const toUnlock: string[] = [];

  if (ev.kind === 'match') {
    toUnlock.push('first-match');
  }
  if (ev.kind === 'cascade') {
    if (ev.depth >= 2) toUnlock.push('first-combo');
    if (ev.depth >= 5) toUnlock.push('cascade-5');
  }
  if (ev.kind === 'combo-streak') {
    if (ev.streak >= 5) toUnlock.push('combo-streak-5');
  }
  if (ev.kind === 'special-created') {
    toUnlock.push('first-special');
    if (ev.type === 'color-bomb') toUnlock.push('color-bomb');
  }
  if (ev.kind === 'level-complete') {
    if (ev.stars === 3) toUnlock.push('perfect-level');
    if (ev.level >= 10) toUnlock.push('level-10');
    if (ev.level >= 25) toUnlock.push('level-25');
    if (ev.level >= 50) toUnlock.push('level-50');
    if (ev.level >= 100) toUnlock.push('level-100');
  }
  if (ev.kind === 'star-earned') {
    if (ev.total >= 50) toUnlock.push('stars-50');
    if (ev.total >= 100) toUnlock.push('stars-100');
  }
  if (ev.kind === 'streak-day') {
    if (ev.day >= 7) toUnlock.push('streak-7');
  }

  let anyUnlocked = false;
  for (const id of toUnlock) {
    if (unlockAchievement(id)) {
      anyUnlocked = true;
      const def = ACH_BY_ID.get(id);
      if (!def) continue;
      for (const [boosterId, count] of Object.entries(def.reward)) {
        addBooster(boosterId as keyof typeof def.reward extends never ? never : 'hammer' | 'swap' | 'colorBombStart' | 'plus5Moves', count as number);
      }
      showAchievementToast(def.label, def.desc);
    }
  }
  if (anyUnlocked) {
    persistProfile();
    document.dispatchEvent(new CustomEvent('seker-hud-update'));
  }
}

export function unlockedCount(): number {
  return state.profile.achievements.length;
}

export function totalAchievements(): number {
  return ACHIEVEMENTS.length;
}
