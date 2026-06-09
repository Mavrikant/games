// Share-link: encode the whole GameData into the URL hash so a partner can play
// the personalized journey on their own device. No fetch, no external service.

import type { Character, GameData, HairType } from './types';

const HASH_PREFIX = '#d=';

export function encodeData(data: GameData): string {
  // encodeURIComponent BEFORE btoa keeps Turkish chars / emoji safe (btoa is Latin1).
  return btoa(encodeURIComponent(JSON.stringify(data)));
}

export function buildShareUrl(data: GameData): string {
  try {
    return location.origin + location.pathname + HASH_PREFIX + encodeData(data);
  } catch {
    return '';
  }
}

export function readHashPayload(): string | null {
  try {
    const h = location.hash;
    if (!h.startsWith(HASH_PREFIX)) return null;
    return h.slice(HASH_PREFIX.length);
  } catch {
    return null;
  }
}

const HAIR_TYPES: HairType[] = ['kisa', 'uzun', 'toplu'];

function isHex(v: unknown): v is string {
  return typeof v === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v);
}

function validChar(c: unknown): c is Character {
  if (!c || typeof c !== 'object') return false;
  const o = c as Record<string, unknown>;
  return (
    HAIR_TYPES.includes(o.hairType as HairType) &&
    isHex(o.hairColor) &&
    isHex(o.eyeColor) &&
    isHex(o.clothingColor)
  );
}

function validData(d: unknown): d is GameData {
  if (!d || typeof d !== 'object') return false;
  const o = d as Record<string, unknown>;
  if (o.version !== 1) return false;
  if (!Array.isArray(o.characters) || o.characters.length !== 2) return false;
  if (!validChar(o.characters[0]) || !validChar(o.characters[1])) return false;
  if (o.playerIndex !== 0 && o.playerIndex !== 1) return false;
  if (!Array.isArray(o.memories) || o.memories.length === 0) return false;
  return o.memories.every((m) => {
    if (!m || typeof m !== 'object') return false;
    const mm = m as Record<string, unknown>;
    return (
      typeof mm.planetId === 'string' &&
      typeof mm.item === 'string' &&
      typeof mm.itemLabel === 'string' &&
      typeof mm.message === 'string'
    );
  });
}

export function decodeData(payload: string): GameData | null {
  try {
    const json = decodeURIComponent(atob(payload));
    const parsed: unknown = JSON.parse(json);
    return validData(parsed) ? parsed : null;
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
