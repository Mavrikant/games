// Mutable runtime singleton + persistence. All DOM/storage access here is only
// called from init()/scene handlers, never at module load.

import { createGenToken } from '@shared/gen-token';
import { safeRead, safeWrite } from '@shared/storage';
import { DEFAULT_DATA } from './data';
import { decodeData, readHashPayload } from './share';
import type { GameData, SceneId } from './types';

const STORAGE_KEY = 'yildizlararasi.data';

export const gen = createGenToken();

export interface Vec {
  x: number;
  y: number;
}

export interface RuntimeState {
  scene: SceneId;
  data: GameData;
  planetIndex: number; // index into PLANETS
  collected: Set<string>; // memory planetIds collected this run
  pos: Vec; // player position, 0..100 (%)
  target: Vec; // click-to-move target, 0..100 (%)
  keys: Set<string>; // held movement keys
  popupOpen: boolean;
  portalActive: boolean;
  inputLocked: boolean; // blocks movement (popup/portal/transition)
  customizeIndex: 0 | 1; // which character is being edited
  setupIndex: number; // which planet is being edited in setup
}

function clone(data: GameData): GameData {
  return JSON.parse(JSON.stringify(data)) as GameData;
}

export function freshData(): GameData {
  const hash = readHashPayload();
  if (hash) {
    const decoded = decodeData(hash);
    if (decoded) return decoded;
  }
  const stored = safeRead<GameData | null>(STORAGE_KEY, null);
  if (stored && stored.version === 1 && Array.isArray(stored.memories) && stored.memories.length > 0) {
    return stored;
  }
  return clone(DEFAULT_DATA);
}

export function persistData(): void {
  safeWrite(STORAGE_KEY, S.data);
}

export const S: RuntimeState = {
  scene: 'intro',
  data: clone(DEFAULT_DATA),
  planetIndex: 0,
  collected: new Set<string>(),
  pos: { x: 50, y: 70 },
  target: { x: 50, y: 70 },
  keys: new Set<string>(),
  popupOpen: false,
  portalActive: false,
  inputLocked: false,
  customizeIndex: 0,
  setupIndex: 0,
};

// Reset per-run play state (not the configured data).
export function resetRun(): void {
  S.planetIndex = 0;
  S.collected = new Set<string>();
  S.pos = { x: 50, y: 72 };
  S.target = { x: 50, y: 72 };
  S.keys.clear();
  S.popupOpen = false;
  S.portalActive = false;
  S.inputLocked = false;
  S.customizeIndex = 0;
  S.setupIndex = 0;
}
