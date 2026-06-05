// Pluggable realtime multiplayer room. ALL Supabase specifics live in this one
// file, exactly like @shared/leaderboard-client, so the backend provider stays
// a single swappable layer — game logic never imports Supabase directly
// (GAME_CONTRACT.md forbids fetch/networking in game-logic; this shared module
// is the sanctioned boundary).
//
// Transport: Supabase Realtime Broadcast + Presence. These need only the
// project URL + anon key — NO database tables, RLS, or SQL (unlike the
// leaderboard, which uses Postgres). Broadcast carries each player's blob
// state; Presence tracks the live roster (join/leave).
//
// The SDK is lazy-imported only when the backend is configured
// (PUBLIC_SUPABASE_URL + PUBLIC_SUPABASE_ANON_KEY set at build time). The
// default/disabled build never loads it, so:
//   - the main bundle stays small,
//   - the smoke test (which blocks the network and FAILS on any console.error)
//     stays green — joinRoom() resolves to null and every method no-ops when
//     the backend is off, the network is blocked, or the channel errors.
//
// Trust model: this is client-authoritative ("community" play). Positions and
// masses are self-reported, so they are inherently forgeable — there is no game
// server to arbitrate. Eat resolution is computed identically on every client
// from the broadcast state. See docs/LEADERBOARD.md "Anti-cheat" for the same
// stance applied to scores.

import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env.PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = import.meta.env.PUBLIC_SUPABASE_ANON_KEY ?? '';

export function realtimeEnabled(): boolean {
  return SUPABASE_URL !== '' && SUPABASE_ANON_KEY !== '';
}

let clientPromise: Promise<SupabaseClient | null> | null = null;

function getClient(): Promise<SupabaseClient | null> {
  if (!realtimeEnabled()) return Promise.resolve(null);
  if (!clientPromise) {
    clientPromise = import('@supabase/supabase-js')
      .then((mod) =>
        mod.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
          // No auth needed for broadcast/presence; keep it stateless so the
          // realtime session never collides with the leaderboard auth session.
          auth: { persistSession: false, autoRefreshToken: false },
          realtime: { params: { eventsPerSecond: 24 } },
        }),
      )
      .catch(() => null);
  }
  return clientPromise;
}

// One player's broadcast snapshot. Plain JSON so it travels over broadcast.
export interface PeerState {
  id: string;
  name: string;
  hue: number;
  x: number;
  y: number;
  mass: number;
  alive: boolean;
  t: number;
}

export interface RoomCallbacks {
  /** A peer (not self) broadcast a fresh state. */
  onState?: (peer: PeerState) => void;
  /** A peer left (presence leave). */
  onLeave?: (id: string) => void;
}

export interface RoomHandle {
  /** This client's stable id for the session. */
  readonly id: string;
  /** Queue the local blob state; flushed to peers on a fixed throttle. */
  send(state: Omit<PeerState, 'id' | 't'>): void;
  /** Live peer count (excludes self). */
  peerCount(): number;
  /** Leave the room and tear down the channel. */
  leave(): void;
}

// Flush cadence for outgoing broadcasts (~16/s). Decoupled from the render
// loop so a 60fps game does not blow past Realtime's per-second message cap.
const FLUSH_MS = 60;
const SUBSCRIBE_TIMEOUT_MS = 8000;

function randomId(): string {
  return (
    Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)
  );
}

function isPeerState(v: unknown): v is PeerState {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    typeof o.name === 'string' &&
    typeof o.hue === 'number' &&
    typeof o.x === 'number' &&
    typeof o.y === 'number' &&
    typeof o.mass === 'number' &&
    typeof o.alive === 'boolean'
  );
}

// Never throws, never console.errors. Returns null when the backend is off,
// the network is blocked, or the channel fails to subscribe — callers treat
// null as "offline, run single-player".
export async function joinRoom(
  roomName: string,
  callbacks: RoomCallbacks,
): Promise<RoomHandle | null> {
  try {
    const client = await getClient();
    if (!client) return null;

    const id = randomId();
    const channel: RealtimeChannel = client.channel(`erime:${roomName}`, {
      config: {
        broadcast: { self: false, ack: false },
        presence: { key: id },
      },
    });

    const present = new Set<string>();

    channel.on('broadcast', { event: 'state' }, (msg) => {
      const payload = (msg as { payload?: unknown }).payload;
      if (isPeerState(payload) && payload.id !== id) callbacks.onState?.(payload);
    });
    channel.on('presence', { event: 'sync' }, () => {
      present.clear();
      const state = channel.presenceState();
      for (const key of Object.keys(state)) present.add(key);
    });
    channel.on('presence', { event: 'leave' }, (msg) => {
      const key = (msg as { key?: unknown }).key;
      if (typeof key === 'string') {
        present.delete(key);
        callbacks.onLeave?.(key);
      }
    });

    const subscribed = await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), SUBSCRIBE_TIMEOUT_MS);
      channel.subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          clearTimeout(timer);
          Promise.resolve(channel.track({ id })).catch(() => {});
          finish(true);
        } else if (
          status === 'CHANNEL_ERROR' ||
          status === 'TIMED_OUT' ||
          status === 'CLOSED'
        ) {
          clearTimeout(timer);
          finish(false);
        }
      });
    });

    if (!subscribed) {
      Promise.resolve(client.removeChannel(channel)).catch(() => {});
      return null;
    }

    let pending: PeerState | null = null;
    const flush = window.setInterval(() => {
      if (!pending) return;
      const payload = pending;
      pending = null;
      Promise.resolve(
        channel.send({ type: 'broadcast', event: 'state', payload }),
      ).catch(() => {});
    }, FLUSH_MS);

    return {
      id,
      send(state) {
        pending = { ...state, id, t: Date.now() };
      },
      peerCount() {
        return Math.max(0, present.size - 1);
      },
      leave() {
        clearInterval(flush);
        Promise.resolve(channel.unsubscribe()).catch(() => {});
        Promise.resolve(client.removeChannel(channel)).catch(() => {});
      },
    };
  } catch {
    return null;
  }
}
