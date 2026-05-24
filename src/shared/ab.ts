// Tiny client-side A/B testing primitive. Stable per visitor across
// pages and reloads (localStorage uid), deterministic per (uid, test)
// pair, and fires a Plausible custom event so variant performance can
// be measured in the analytics dashboard.
//
// Usage from any inline <script> (after Plausible has loaded):
//   import { getVariant, trackVariant } from '@shared/ab';
//   const v = getVariant('hero-copy', ['A', 'B'] as const);
//   trackVariant('hero-copy', v);
//   if (v === 'B') document.querySelector('.hero__title').textContent = '...';
//
// Keep variants short ('A', 'B', 'C') — they become the Plausible prop
// value. Variants are bucketed evenly; for a 90/10 split, list the
// majority variant nine times: ['A','A','A','A','A','A','A','A','A','B'].

import { safeRead, safeWrite } from './storage';

const UID_KEY = 'ab.uid';

function getUid(): string {
  const existing = safeRead<string | null>(UID_KEY, null);
  if (existing) return existing;
  // 8 chars from base36 is enough for stable bucketing — we only need a
  // unique value per device, not a cryptographic id.
  const uid = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  safeWrite(UID_KEY, uid);
  return uid;
}

// fnv1a-ish hash — small and stable across browsers without a crypto dep.
function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h;
}

export function getVariant<T extends string>(testKey: string, variants: readonly T[]): T {
  if (variants.length === 0) {
    throw new Error('getVariant: variants must not be empty');
  }
  const uid = getUid();
  const idx = hash(uid + ':' + testKey) % variants.length;
  return variants[idx] as T;
}

// Fire a Plausible custom event the first time a visitor lands on a
// test variant. Subsequent calls in the same page load are deduped so
// we don't spam events when the helper is called from multiple places.
const reportedThisPage = new Set<string>();

interface PlausibleFn {
  (event: string, opts?: { props?: Record<string, string> }): void;
}

export function trackVariant(testKey: string, variant: string): void {
  const dedupeKey = testKey + ':' + variant;
  if (reportedThisPage.has(dedupeKey)) return;
  reportedThisPage.add(dedupeKey);
  const w = window as unknown as { plausible?: PlausibleFn };
  if (typeof w.plausible === 'function') {
    w.plausible('AB Variant', { props: { test: testKey, variant } });
  }
}
