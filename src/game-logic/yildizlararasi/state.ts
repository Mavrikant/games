// Mutable runtime singleton + persistence. All DOM/storage access here is only
// called from init()/scene handlers, never at module load.

import { createGenToken } from '@shared/gen-token';
import { safeRead, safeWrite } from '@shared/storage';
import { cloudEnabled, loadMemories } from './cloud';
import { DEFAULT_DATA } from './data';
import { coerceData, decodeData, readCloudCode, readHashPayload } from './share';
import type { GameData, SceneId } from './types';

const STORAGE_KEY = 'yildizlararasi.data';

export const gen = createGenToken();

export interface Vec2 {
  x: number;
  z: number;
}

export interface RuntimeState {
  scene: SceneId;
  data: GameData;
  planetIndex: number; // index into PLANETS
  collected: Set<string>; // memory planetIds collected this run
  p3: Vec2; // player world position (x,z)
  t3: Vec2; // click-to-move target (x,z)
  keys: Set<string>; // held movement keys
  popupOpen: boolean;
  portalActive: boolean;
  minigameActive: boolean;
  inputLocked: boolean; // blocks movement (popup/portal/minigame/transition)
  customizeIndex: 0 | 1; // which character is being edited
  setupIndex: number; // which planet is being edited in setup
  fromLink: boolean; // opened via a share link → recipient goes straight to play
  cloudLoading: boolean; // awaiting a #c= cloud fetch before the journey can start
}

// True when the page was opened from a share link (#c= cloud code or #d= hash).
export function hasLink(): boolean {
  return readCloudCode() !== null || readHashPayload() !== null;
}

// The traveler is always the 2nd character (the recipient who plays); the 1st
// character (the founder who set the journey up) waits at Earth.
export function travelerChar() {
  return S.data.characters[1];
}
export function waitingChar() {
  return S.data.characters[0];
}

function clone(data: GameData): GameData {
  return JSON.parse(JSON.stringify(data)) as GameData;
}

// Synchronous best-effort load: hash (#d) → localStorage → default. The async
// cloud code (#c) is resolved separately via maybeLoadCloud().
export function freshData(): GameData {
  const hash = readHashPayload();
  if (hash) {
    const decoded = decodeData(hash);
    if (decoded) return decoded;
  }
  const stored = coerceData(safeRead<unknown>(STORAGE_KEY, null));
  if (stored) return stored;
  return clone(DEFAULT_DATA);
}

// If the URL carries a cloud code and Supabase is configured, fetch the setup.
// Returns true if a fetch was started; onDone fires with the data (or null on
// miss/failure) when it settles. Returns false (no fetch) otherwise.
export function maybeLoadCloud(onDone: (data: GameData | null) => void): boolean {
  const code = readCloudCode();
  if (!code || !cloudEnabled()) return false;
  void loadMemories(code).then((data) => onDone(data));
  return true;
}

export function persistData(): void {
  safeWrite(STORAGE_KEY, S.data);
}

export const S: RuntimeState = {
  scene: 'intro',
  data: clone(DEFAULT_DATA),
  planetIndex: 0,
  collected: new Set<string>(),
  p3: { x: 0, z: 4.6 },
  t3: { x: 0, z: 4.6 },
  keys: new Set<string>(),
  popupOpen: false,
  portalActive: false,
  minigameActive: false,
  inputLocked: false,
  customizeIndex: 0,
  setupIndex: 0,
  fromLink: false,
  cloudLoading: false,
};

// Reset per-run play state (not the configured data).
export function resetRun(): void {
  S.planetIndex = 0;
  S.collected = new Set<string>();
  S.p3 = { x: 0, z: 4.6 };
  S.t3 = { x: 0, z: 4.6 };
  S.keys.clear();
  S.popupOpen = false;
  S.portalActive = false;
  S.minigameActive = false;
  S.inputLocked = false;
  S.customizeIndex = 0;
  S.setupIndex = 0;
}
