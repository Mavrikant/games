// Daily-rotation utilities. Both the day picker and the completion
// tracker run on a deterministic UTC day boundary so a build done at
// 23:59 and a build done at 00:01 don't pick different "today" games
// for visitors in different timezones.
//
// State lives in localStorage and goes through the safe wrappers so
// Safari private mode / sandboxed iframes can't crash imports.

import { safeRead, safeWrite } from './storage';

// 0-based day-of-year × year — a single monotonically increasing integer
// that's stable for the whole calendar day. Use as a seed/index.
export function dayIndex(now: Date = new Date()): number {
  const startOfYear = Date.UTC(now.getUTCFullYear(), 0, 0);
  return Math.floor((now.getTime() - startOfYear) / 86_400_000);
}

// 'YYYY-MM-DD' (UTC) — stable per-day key for completion tracking.
export function dayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

const COMPLETION_KEY = 'daily.completed';
type CompletionMap = Record<string, true>;

export function markDailyDone(): void {
  const map = safeRead<CompletionMap>(COMPLETION_KEY, {});
  map[dayKey()] = true;
  safeWrite(COMPLETION_KEY, map);
}

export function isDailyDone(): boolean {
  const map = safeRead<CompletionMap>(COMPLETION_KEY, {});
  return !!map[dayKey()];
}

// --- Visit streak (used by Nav) ---

const STREAK_KEY = 'streak';
interface StreakState {
  lastVisit: string;
  days: number;
}

// Call once per page load. Returns the current streak after the update.
export function updateStreak(): number {
  const today = dayKey();
  const yesterday = (() => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 1);
    return dayKey(d);
  })();
  const prev = safeRead<StreakState | null>(STREAK_KEY, null);
  let next: StreakState;
  if (!prev) {
    next = { lastVisit: today, days: 1 };
  } else if (prev.lastVisit === today) {
    next = prev;
  } else if (prev.lastVisit === yesterday) {
    next = { lastVisit: today, days: prev.days + 1 };
  } else {
    next = { lastVisit: today, days: 1 };
  }
  safeWrite(STREAK_KEY, next);
  return next.days;
}
