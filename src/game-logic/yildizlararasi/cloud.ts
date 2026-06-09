// Optional Supabase backend for the personalized setup. When PUBLIC_SUPABASE_URL
// + PUBLIC_SUPABASE_ANON_KEY are configured at build time, the founder's setup is
// stored server-side and shared as a short code (#c=…). When not configured
// (default / dev / smoke), every function no-ops and returns null — the caller
// falls back to the base64 URL hash. Mirrors the lazy-import + swallow-errors
// pattern of @shared/leaderboard-client so the smoke gate (which blocks the
// network and fails on console.error) stays green.
//
// Requires this table in the Supabase project (anon insert + select via RLS):
//
//   create table public.yildizlararasi_memories (
//     code text primary key,
//     data jsonb not null,
//     created_at timestamptz not null default now()
//   );
//   alter table public.yildizlararasi_memories enable row level security;
//   create policy "yi anon insert" on public.yildizlararasi_memories
//     for insert to anon with check (true);
//   create policy "yi anon select" on public.yildizlararasi_memories
//     for select to anon using (true);

import type { SupabaseClient } from '@supabase/supabase-js';
import { coerceData } from './share';
import type { GameData } from './types';

const URL = import.meta.env.PUBLIC_SUPABASE_URL ?? '';
const KEY = import.meta.env.PUBLIC_SUPABASE_ANON_KEY ?? '';
const TABLE = 'yildizlararasi_memories';

export function cloudEnabled(): boolean {
  return URL !== '' && KEY !== '';
}

let clientPromise: Promise<SupabaseClient | null> | null = null;

function getClient(): Promise<SupabaseClient | null> {
  if (!cloudEnabled()) return Promise.resolve(null);
  if (!clientPromise) {
    clientPromise = import('@supabase/supabase-js')
      .then((mod) => mod.createClient(URL, KEY, { auth: { persistSession: false } }))
      .catch(() => null);
  }
  return clientPromise;
}

function randomCode(): string {
  let s = '';
  for (let i = 0; i < 8; i++) s += Math.floor(Math.random() * 36).toString(36);
  return s;
}

// Insert the setup and return a short code, or null on any failure.
export async function saveMemories(data: GameData): Promise<string | null> {
  try {
    const client = await getClient();
    if (!client) return null;
    const code = randomCode();
    const { error } = await client.from(TABLE).insert({ code, data });
    return error ? null : code;
  } catch {
    return null;
  }
}

export async function loadMemories(code: string): Promise<GameData | null> {
  try {
    const client = await getClient();
    if (!client) return null;
    const { data, error } = await client.from(TABLE).select('data').eq('code', code).maybeSingle();
    if (error || !data) return null;
    return coerceData((data as { data: unknown }).data);
  } catch {
    return null;
  }
}
