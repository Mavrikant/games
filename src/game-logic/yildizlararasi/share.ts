// Share-link helpers. The personalized setup travels to the partner's device
// either as a short cloud code (#c=…, when Supabase is configured) or, as a
// dependency-free fallback, base64-encoded into the URL hash (#d=…). No fetch
// happens here; the cloud path lives in cloud.ts.

import type { Character, GameData, HairType } from './types';

const HASH_PREFIX = '#d=';
const CODE_PREFIX = '#c=';

export function encodeData(data: GameData): string {
  // encodeURIComponent BEFORE btoa keeps Turkish chars / emoji safe (btoa is Latin1).
  return btoa(encodeURIComponent(JSON.stringify(data)));
}

export function buildHashUrl(data: GameData): string {
  try {
    return location.origin + location.pathname + HASH_PREFIX + encodeData(data);
  } catch {
    return '';
  }
}

export function buildCodeUrl(code: string): string {
  try {
    return location.origin + location.pathname + CODE_PREFIX + encodeURIComponent(code);
  } catch {
    return '';
  }
}

export function readHashPayload(): string | null {
  try {
    return location.hash.startsWith(HASH_PREFIX) ? location.hash.slice(HASH_PREFIX.length) : null;
  } catch {
    return null;
  }
}

export function readCloudCode(): string | null {
  try {
    return location.hash.startsWith(CODE_PREFIX) ? decodeURIComponent(location.hash.slice(CODE_PREFIX.length)) : null;
  } catch {
    return null;
  }
}

const HAIR_TYPES: HairType[] = ['kisa', 'uzun', 'toplu', 'kivircik', 'kel'];
const ACCESSORIES = ['yok', 'gozluk', 'sapka', 'tac'] as const;

function isHex(v: unknown): v is string {
  return typeof v === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v);
}

// Normalize a character, filling defaults for fields added after v1 so older
// share links keep working. Returns null only when core fields are unusable.
function coerceChar(c: unknown): Character | null {
  if (!c || typeof c !== 'object') return null;
  const o = c as Record<string, unknown>;
  if (!isHex(o.hairColor) || !isHex(o.eyeColor) || !isHex(o.clothingColor)) return null;
  const hairType = HAIR_TYPES.includes(o.hairType as HairType) ? (o.hairType as HairType) : 'kisa';
  const accessory = (ACCESSORIES as readonly string[]).includes(o.accessory as string)
    ? (o.accessory as Character['accessory'])
    : 'yok';
  const skinColor = isHex(o.skinColor) ? (o.skinColor as string) : '#f3c9a6';
  return { hairType, hairColor: o.hairColor, eyeColor: o.eyeColor, skinColor, clothingColor: o.clothingColor, accessory };
}

export function coerceData(parsed: unknown): GameData | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  if (o.version !== 1) return null;
  if (!Array.isArray(o.characters) || o.characters.length !== 2) return null;
  const c0 = coerceChar(o.characters[0]);
  const c1 = coerceChar(o.characters[1]);
  if (!c0 || !c1) return null;
  if (o.playerIndex !== 0 && o.playerIndex !== 1) return null;
  if (!Array.isArray(o.memories) || o.memories.length === 0) return null;
  const ok = o.memories.every((m) => {
    if (!m || typeof m !== 'object') return false;
    const mm = m as Record<string, unknown>;
    return (
      typeof mm.planetId === 'string' &&
      typeof mm.item === 'string' &&
      typeof mm.itemLabel === 'string' &&
      typeof mm.message === 'string'
    );
  });
  if (!ok) return null;
  return { version: 1, characters: [c0, c1], playerIndex: o.playerIndex, memories: o.memories as GameData['memories'] };
}

export function decodeData(payload: string): GameData | null {
  try {
    return coerceData(JSON.parse(decodeURIComponent(atob(payload))));
  } catch {
    return null;
  }
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to legacy path */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
