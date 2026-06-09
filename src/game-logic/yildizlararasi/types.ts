// Pure types for Yıldızlararası. No imports, no side effects.

export type HairType = 'kisa' | 'uzun' | 'toplu' | 'kivircik' | 'kel';
export type SceneId = 'intro' | 'customize' | 'mode' | 'setup' | 'play' | 'final';
export type MiniGameId = 'refleks' | 'hedef' | 'hafiza' | 'zamanlama';

export interface Character {
  hairType: HairType;
  hairColor: string; // hex
  eyeColor: string; // hex
  skinColor: string; // hex
  clothingColor: string; // hex
  accessory: 'yok' | 'gozluk' | 'sapka' | 'tac'; // none / glasses / hat / crown
}

export interface Memory {
  planetId: string; // matches PlanetDef.id
  item: string; // emoji glyph, e.g. '📸'
  itemLabel: string; // 'Fotoğraf'
  message: string; // founder's love note
}

export interface GameData {
  version: 1;
  characters: [Character, Character];
  playerIndex: 0 | 1; // chosen player; the other is "Bekleyen Sevgili"
  memories: Memory[]; // one per non-Earth planet, in Pluto→Earth order
}

export interface PlanetDef {
  id: string;
  name: string;
  gradTop: string; // scene bg gradient top
  gradBot: string; // scene bg gradient bottom
  ground: string; // surface band color
  planetColor: string; // 3D planet sphere color
  brightness: number; // 0 (Pluto) .. 1 (Earth)
  collectible: boolean; // false only for Earth (the reunion finale)
}

export interface ItemChoice {
  glyph: string;
  label: string;
}

// A scene module exposes enter() (build + bind) and leave() (cleanup).
export interface Scene {
  enter: () => void;
  leave: () => void;
}
