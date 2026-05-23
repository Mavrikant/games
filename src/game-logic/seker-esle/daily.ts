// Daily challenge, streak counter, comeback bonus, date helpers.

import { state, persistProfile, addBooster, writeDaily } from './state';
import { todayKeyUtc, hashDateKey } from './rng';
import { generateDailyLevel } from './levels';
import { recordAchievementEvent } from './achievements';
import type { LevelDef } from './types';

function diffDays(aKey: string, bKey: string): number {
  if (!aKey || !bKey) return 9999;
  const a = Date.UTC(+aKey.slice(0, 4), +aKey.slice(5, 7) - 1, +aKey.slice(8, 10));
  const b = Date.UTC(+bKey.slice(0, 4), +bKey.slice(5, 7) - 1, +bKey.slice(8, 10));
  return Math.round((b - a) / 86400000);
}

export function tickDailyState(): { isComeback: boolean; streakDay: number; dailyAvailable: boolean } {
  const today = todayKeyUtc();
  const last = state.profile.lastPlayDate;
  let isComeback = false;
  if (last && diffDays(last, today) >= 2) isComeback = true;
  if (last !== today) {
    const days = last ? diffDays(last, today) : 0;
    if (days === 1) {
      state.profile.streak += 1;
    } else if (days >= 2 || !last) {
      state.profile.streak = 1;
    }
    if (state.profile.streak > state.profile.longestStreak) {
      state.profile.longestStreak = state.profile.streak;
    }
    state.profile.lastPlayDate = today;
    grantStreakReward(state.profile.streak);
    persistProfile();
    recordAchievementEvent({ kind: 'streak-day', day: state.profile.streak });
  }
  const dailyAvailable = !state.profile.dailyCompleted[today];
  state.dailyKey = today;
  return { isComeback, streakDay: state.profile.streak, dailyAvailable };
}

function grantStreakReward(day: number): void {
  // Cycle days 1..7
  const slot = ((day - 1) % 7) + 1;
  switch (slot) {
    case 1: break; // silent welcome
    case 2: addBooster('hammer', 1); break;
    case 3: addBooster('swap', 1); break;
    case 4: addBooster('colorBombStart', 1); break;
    case 5: addBooster('plus5Moves', 1); break;
    case 6: addBooster('hammer', 1); addBooster('plus5Moves', 1); break;
    case 7:
      addBooster('hammer', 1);
      addBooster('swap', 1);
      addBooster('plus5Moves', 1);
      addBooster('colorBombStart', 1);
      break;
  }
}

export function getTodayDailyLevel(): LevelDef {
  const key = state.dailyKey || todayKeyUtc();
  const seed = hashDateKey(key);
  return generateDailyLevel(seed, state.profile.currentLevel);
}

export function isDailyCompletedToday(): boolean {
  const key = state.dailyKey || todayKeyUtc();
  return !!state.profile.dailyCompleted[key];
}

export function recordDailySolve(stars: 0 | 1 | 2 | 3, score: number): void {
  const key = state.dailyKey || todayKeyUtc();
  writeDaily(key, { stars, score, completed: true });
  if (stars > 0) {
    addBooster('plus5Moves', 1);
    if (stars === 3) addBooster('colorBombStart', 1);
  }
  persistProfile();
  recordAchievementEvent({ kind: 'daily-complete' });
}

export function applyComebackBonus(): void {
  addBooster('hammer', 1);
  addBooster('swap', 1);
  addBooster('plus5Moves', 1);
  persistProfile();
}
