// Standardized score-recording contract. Game logic calls recordScore() when a
// run ends. It:
//   1. updates the personal best in localStorage exactly as games do today
//      (via @shared/storage), so nothing regresses when the backend is off, and
//   2. hands the value to the pluggable online client for global-leaderboard
//      submission (a silent no-op when the backend is disabled or the player is
//      signed out).
//
// Game logic runs inside the per-game iframe and has NO access to the Astro
// content collection, so the descriptor (backend id, storage key, direction) is
// passed at the call site — mirroring how each game already owns its own keys.
// The matching metadata also lives in the game's JSON `scoring` block, which the
// /siralama page reads at build time to render and rank each board.

import { safeRead, safeWrite } from './storage';
import { submitScore, leaderboardEnabled } from './leaderboard-client';
import { showScoreboard } from './score-overlay';

export interface ScoreDescriptor {
  /** Backend board id. Matches `scoring.id` in the game's JSON (defaults to slug). */
  gameId: string;
  /** Existing local-best localStorage key, e.g. "2048.best". */
  storageKey: string;
  /** Ranking direction: higher points vs. lower time. */
  direction: 'higher' | 'lower';
}

function isNewBest(
  value: number,
  prev: number | null,
  direction: 'higher' | 'lower',
): boolean {
  if (prev === null) return true;
  return direction === 'higher' ? value > prev : value < prev;
}

function writeLocalBest(desc: ScoreDescriptor, value: number): void {
  const prev = safeRead<number | null>(desc.storageKey, null);
  if (isNewBest(value, prev, desc.direction)) {
    safeWrite(desc.storageKey, value);
  }
}

// Silent variant: update the local best and fire-and-forget submit. No UI.
export function recordScore(desc: ScoreDescriptor, value: number): void {
  if (!Number.isFinite(value)) return;
  writeLocalBest(desc, value);
  void submitScore({ gameId: desc.gameId, value, direction: desc.direction });
}

/**
 * Call at game-over. Updates the local best, and — when the online leaderboard
 * is enabled — pops the shared scoreboard overlay (global top-N + your score,
 * with a sign-in prompt when signed out, which also submits the score). When
 * the backend is disabled it behaves exactly like recordScore (no UI), so dev
 * and the smoke test are unaffected.
 */
export function reportGameOver(
  desc: ScoreDescriptor,
  value: number,
  opts: { label?: string; unit?: string } = {},
): void {
  if (!Number.isFinite(value)) return;
  writeLocalBest(desc, value);
  if (!leaderboardEnabled()) {
    void submitScore({ gameId: desc.gameId, value, direction: desc.direction });
    return;
  }
  void showScoreboard({
    gameId: desc.gameId,
    direction: desc.direction,
    value,
    label: opts.label,
    unit: opts.unit,
  });
}
