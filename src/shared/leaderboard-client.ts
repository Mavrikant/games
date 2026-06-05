// Pluggable online-leaderboard client. ALL Supabase specifics live in this one
// file, so the backend provider is a single swappable layer — game logic, the
// score contract (@shared/leaderboard) and the UI never import Supabase.
//
// The SDK is lazy-imported only when the backend is configured
// (PUBLIC_SUPABASE_URL + PUBLIC_SUPABASE_ANON_KEY set at build time). The
// default/disabled build never loads it, so:
//   - the main bundle stays small,
//   - the smoke test (which blocks the network and FAILS on any console.error)
//     stays green — every function below no-ops and swallows errors when the
//     backend is off, the player is signed out, or the network is unavailable.
//
// Trust model: scores are submitted via the `submit_score` Postgres RPC, which
// stamps auth.uid(), clamps against a per-game cap and rate-limits server-side.
// Client-side games are inherently forgeable; the server is the only authority.

import type { SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env.PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = import.meta.env.PUBLIC_SUPABASE_ANON_KEY ?? '';

export function leaderboardEnabled(): boolean {
  return SUPABASE_URL !== '' && SUPABASE_ANON_KEY !== '';
}

let clientPromise: Promise<SupabaseClient | null> | null = null;

function getClient(): Promise<SupabaseClient | null> {
  if (!leaderboardEnabled()) return Promise.resolve(null);
  if (!clientPromise) {
    clientPromise = import('@supabase/supabase-js')
      .then((mod) =>
        mod.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
          auth: {
            persistSession: true,
            detectSessionInUrl: true,
            autoRefreshToken: true,
          },
        }),
      )
      .catch(() => null);
  }
  return clientPromise;
}

export type OAuthProvider = 'google' | 'github';

export interface PlayerIdentity {
  id: string;
  displayName: string;
}

export interface LeaderboardRow {
  rank: number;
  displayName: string;
  value: number;
  isSelf: boolean;
}

export interface SubmitArgs {
  gameId: string;
  value: number;
  direction: 'higher' | 'lower';
}

// Derive a human display name from the OAuth profile without exposing the email.
function deriveName(meta: Record<string, unknown>, email: string | undefined): string {
  const candidate =
    (meta.user_name as string | undefined) ??
    (meta.preferred_username as string | undefined) ??
    (meta.full_name as string | undefined) ??
    (meta.name as string | undefined) ??
    (email ? email.split('@')[0] : undefined);
  return candidate && candidate.trim() ? candidate.trim() : 'Oyuncu';
}

export async function getPlayer(): Promise<PlayerIdentity | null> {
  try {
    const client = await getClient();
    if (!client) return null;
    const { data } = await client.auth.getUser();
    const user = data.user;
    if (!user) return null;
    const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
    return { id: user.id, displayName: deriveName(meta, user.email) };
  } catch {
    return null;
  }
}

export async function signIn(provider: OAuthProvider): Promise<void> {
  try {
    const client = await getClient();
    if (!client) return;
    await client.auth.signInWithOAuth({
      provider,
      options: { redirectTo: window.location.href },
    });
  } catch {
    /* ignore */
  }
}

export async function signOut(): Promise<void> {
  try {
    const client = await getClient();
    await client?.auth.signOut();
  } catch {
    /* ignore */
  }
}

// Fire-and-forget. Never throws, never console.errors. No-op when the backend
// is disabled or the player is signed out. We submit every finished run (not
// just local bests) so a player's global best is correct even on a fresh device
// with no local history — the server keeps only their best per game.
export async function submitScore(args: SubmitArgs): Promise<void> {
  try {
    const client = await getClient();
    if (!client) return;
    const { data } = await client.auth.getUser();
    if (!data.user) return;
    await client.rpc('submit_score', {
      p_game_id: args.gameId,
      p_value: args.value,
      p_direction: args.direction,
    });
  } catch {
    /* offline / blocked / backend down → ignore */
  }
}

// The nested `profiles(display_name)` embed can come back as an object or a
// single-element array depending on how the FK is resolved; handle both.
interface ScoreQueryRow {
  user_id: string;
  value: number;
  profiles:
    | { display_name: string | null }
    | { display_name: string | null }[]
    | null;
}

function readDisplayName(profiles: ScoreQueryRow['profiles']): string {
  if (!profiles) return 'Oyuncu';
  const p = Array.isArray(profiles) ? profiles[0] : profiles;
  return p?.display_name ?? 'Oyuncu';
}

export async function fetchLeaderboard(
  gameId: string,
  direction: 'higher' | 'lower',
  limit = 10,
): Promise<LeaderboardRow[]> {
  try {
    const client = await getClient();
    if (!client) return [];
    const [scores, auth] = await Promise.all([
      client
        .from('scores')
        .select('user_id, value, profiles(display_name)')
        .eq('game_id', gameId)
        .order('value', { ascending: direction === 'lower' })
        .limit(limit),
      client.auth.getUser(),
    ]);
    const rows = scores.data as ScoreQueryRow[] | null;
    if (!rows) return [];
    const selfId = auth.data.user?.id ?? null;
    return rows.map((row, index) => ({
      rank: index + 1,
      displayName: readDisplayName(row.profiles),
      value: row.value,
      isSelf: selfId !== null && row.user_id === selfId,
    }));
  } catch {
    return [];
  }
}
