// Generic realtime room over Supabase Realtime (Broadcast + Presence).
//
// Sibling of @shared/realtime-room, but transport-agnostic about the payload:
// realtime-room hard-codes one fixed scalar PeerState (x/y/mass) tuned for the
// agar-style arena, so it can't carry richer game state (e.g. a snake's body
// segment array). This module instead relays *arbitrary named JSON events* in
// both directions, which is what a host-authoritative game (one peer simulates
// and broadcasts the whole world, the other sends inputs) needs.
//
// ALL Supabase specifics live in this one file — game-logic never imports
// Supabase directly (GAME_CONTRACT.md forbids fetch/networking in game-logic;
// this shared module is the sanctioned boundary). Only the project URL + anon
// key are needed; NO database tables, RLS, or SQL (Broadcast/Presence are
// transient and need none of that, unlike the leaderboard which uses Postgres).
//
// The SDK is lazy-imported only when the backend is configured
// (PUBLIC_SUPABASE_URL + PUBLIC_SUPABASE_ANON_KEY set at build time). The
// default/disabled build never loads it, so:
//   - the main bundle stays small,
//   - the smoke test (which blocks the network and FAILS on any console.error)
//     stays green — joinChannel() resolves to null and the caller runs offline.
//
// Trust model: client-authoritative ("community" play). There is no game server
// to arbitrate; in a host-authoritative game the host peer is trusted by the
// guest. See docs/PITFALLS.md "realtime-must-degrade-silently".

import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env.PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = import.meta.env.PUBLIC_SUPABASE_ANON_KEY ?? '';

/** True when both Supabase env vars are present at build time. */
export function channelEnabled(): boolean {
  return SUPABASE_URL !== '' && SUPABASE_ANON_KEY !== '';
}

let clientPromise: Promise<SupabaseClient | null> | null = null;

function getClient(): Promise<SupabaseClient | null> {
  if (!channelEnabled()) return Promise.resolve(null);
  if (!clientPromise) {
    clientPromise = import('@supabase/supabase-js')
      .then((mod) =>
        mod.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
          // No auth needed for broadcast/presence; keep it stateless so the
          // realtime session never collides with the leaderboard auth session.
          auth: { persistSession: false, autoRefreshToken: false },
          realtime: { params: { eventsPerSecond: 20 } },
        }),
      )
      .catch(() => null);
  }
  return clientPromise;
}

export interface ChannelCallbacks {
  /** A peer broadcast an event (never fires for our own messages). */
  onEvent?: (event: string, data: unknown, from: string) => void;
  /** The live member list changed (presence sync) — keys include self. */
  onPresence?: (memberIds: string[]) => void;
  /** A specific peer left (presence leave). */
  onLeave?: (id: string) => void;
}

export interface ChannelHandle {
  /** This client's stable id for the session (also its presence key). */
  readonly id: string;
  /** Broadcast a named event to every other peer. Fire-and-forget. */
  send(event: string, data: unknown): void;
  /** Current presence member ids (includes self). */
  members(): string[];
  /** Peer count excluding self. */
  peerCount(): number;
  /** Leave the room and tear down the channel. */
  leave(): void;
}

const SUBSCRIBE_TIMEOUT_MS = 8000;

function randomId(): string {
  return (
    Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)
  );
}

// Never throws, never console.errors. Returns null when the backend is off,
// the network is blocked, or the channel fails to subscribe — callers treat
// null as "offline, run locally".
export async function joinChannel(
  roomName: string,
  presenceMeta: Record<string, unknown>,
  callbacks: ChannelCallbacks,
): Promise<ChannelHandle | null> {
  try {
    const client = await getClient();
    if (!client) return null;

    const id = randomId();
    const channel: RealtimeChannel = client.channel(roomName, {
      config: {
        broadcast: { self: false, ack: false },
        presence: { key: id },
      },
    });

    const present = new Set<string>([id]);

    channel.on('broadcast', { event: 'msg' }, (msg) => {
      const payload = (msg as { payload?: unknown }).payload;
      if (
        typeof payload === 'object' &&
        payload !== null &&
        typeof (payload as { from?: unknown }).from === 'string' &&
        typeof (payload as { event?: unknown }).event === 'string'
      ) {
        const p = payload as { from: string; event: string; data: unknown };
        if (p.from !== id) callbacks.onEvent?.(p.event, p.data, p.from);
      }
    });
    channel.on('presence', { event: 'sync' }, () => {
      present.clear();
      const state = channel.presenceState();
      for (const key of Object.keys(state)) present.add(key);
      callbacks.onPresence?.([...present]);
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
          Promise.resolve(channel.track({ id, ...presenceMeta })).catch(() => {});
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

    return {
      id,
      send(event, data) {
        Promise.resolve(
          channel.send({
            type: 'broadcast',
            event: 'msg',
            payload: { from: id, event, data },
          }),
        ).catch(() => {});
      },
      members() {
        return [...present];
      },
      peerCount() {
        return Math.max(0, present.size - 1);
      },
      leave() {
        Promise.resolve(channel.unsubscribe()).catch(() => {});
        Promise.resolve(client.removeChannel(channel)).catch(() => {});
      },
    };
  } catch {
    return null;
  }
}
