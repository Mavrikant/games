// State-machine transitions: start/load levels, fire, resolve shots, clear /
// game-over, stars + medals, settings. The "brain" the loop and UI call into.

import {
  S,
  gen,
  progressFor,
  recordLevelResult,
  awardMedal,
  persistProfile,
} from './state';
import {
  AMMO_BONUS,
  LEVELS_PER_WORLD,
  P0X,
  P0Y,
  TOTAL_LEVELS,
  clamp,
} from './constants';
import type { AmmoId, EngineId, LevelDef } from './types';
import { AMMO_ORDER, makeProjectile } from './ammo';
import { ENGINES } from './engines';
import { getLevel } from './levels';
import { buildLevel, settle, aliveBlocks } from './blocks';
import { addShake } from './fx';
import * as audio from './audio';
import { launchSpeed, draw } from './render';
import {
  hideAllOverlays,
  renderHud,
  showGameOver,
  showLevelComplete,
  showMap,
  showPrelevel,
  toast,
} from './ui';
import { MEDAL_BY_ID } from './medals';

export function applySettings(): void {
  audio.setSfxEnabled(S.profile.settings.sfx);
  audio.setMusicEnabled(S.profile.settings.music);
}

export function setSetting(key: 'sfx' | 'music' | 'reducedMotion', value: boolean): void {
  S.profile.settings[key] = value;
  persistProfile();
  applySettings();
  renderHud();
}

function totalAmmo(): number {
  let t = 0;
  for (const id of S.loadout) t += S.ammoCounts[id] ?? 0;
  return t;
}

function pickNextAmmo(): void {
  if ((S.ammoCounts[S.activeAmmo] ?? 0) > 0) return;
  for (const id of S.loadout) {
    if ((S.ammoCounts[id] ?? 0) > 0) {
      S.activeAmmo = id;
      return;
    }
  }
}

function resetAim(): void {
  const e = ENGINES[S.engineId];
  S.aimAngle = clamp(-0.78, e.angleMin, e.angleMax);
  S.power = 0.6;
}

export function startLevel(id: number, engine?: EngineId): void {
  gen.bump();
  const lv = getLevel(id);
  S.levelIndex = id;
  S.level = lv;
  S.engineId = engine ?? lv.engine;
  S.cleared = progressFor(id).cleared;

  S.ammoCounts = { stone: 0, boulder: 0, fire: 0, cluster: 0, keg: 0, bolt: 0 };
  const loadout: AmmoId[] = [];
  for (const aid of AMMO_ORDER) {
    const n = lv.ammo[aid] ?? 0;
    if (n > 0) {
      S.ammoCounts[aid] = n;
      loadout.push(aid);
    }
  }
  S.loadout = loadout.length ? loadout : ['stone'];
  S.activeAmmo = S.loadout[0]!;

  buildLevel(lv);
  S.projectiles = [];
  S.particles = [];
  S.popups = [];
  S.shake = 0;
  S.score = 0;
  S.shotsUsed = 0;
  S.shotDestroyed = 0;
  S.bestChainThisLevel = 0;
  resetAim();
  S.state = 'aiming';
  hideAllOverlays();
  renderHud();
  draw();
}

export function selectFromMap(id: number): void {
  S.levelIndex = id;
  if (progressFor(id).cleared) {
    S.state = 'prelevel';
    showPrelevel(id);
  } else {
    startLevel(id);
  }
}

export function toMap(): void {
  S.state = 'map';
  showMap();
}

export function nextLevel(): void {
  const n = Math.min(TOTAL_LEVELS, S.levelIndex + 1);
  startLevel(n);
}

export function retryLevel(): void {
  startLevel(S.levelIndex, S.engineId);
}

export function fire(): void {
  if (S.state !== 'aiming') return;
  const id = S.activeAmmo;
  if ((S.ammoCounts[id] ?? 0) <= 0) {
    pickNextAmmo();
    if ((S.ammoCounts[S.activeAmmo] ?? 0) <= 0) return;
  }
  const active = S.activeAmmo;
  S.ammoCounts[active] -= 1;
  S.shotsUsed += 1;
  S.shotDestroyed = 0;
  S.shotId += 1;
  const speed = launchSpeed();
  const vx = Math.cos(S.aimAngle) * speed;
  const vy = Math.sin(S.aimAngle) * speed;
  S.projectiles.push(makeProjectile(active, P0X, P0Y, vx, vy, S.shotId));
  audio.sfxLaunch(S.power);
  addShake(2);
  S.state = 'firing';
  renderHud();
}

export function onShotEnd(): void {
  S.projectiles = [];
  settle();
  S.state = 'settling';
}

export function resolveAfterSettle(): void {
  S.targetsLeft = S.blocks.filter((b) => b.kind === 'target' && b.alive).length;
  if (S.targetsLeft === 0) {
    onLevelClear();
    return;
  }
  if (totalAmmo() <= 0) {
    onGameOver();
    return;
  }
  pickNextAmmo();
  S.state = 'aiming';
  renderHud();
}

function computeStars(lv: LevelDef, leftover: number): 0 | 1 | 2 | 3 {
  const [, t2, t3] = lv.starThresholds;
  if (leftover >= t3) return 3;
  if (leftover >= t2) return 2;
  return 1;
}

function worldCleared(w: number): boolean {
  for (let t = 0; t < LEVELS_PER_WORLD; t++) {
    const id = w * LEVELS_PER_WORLD + t + 1;
    if (!progressFor(id).cleared) return false;
  }
  return true;
}

function worldPerfect(w: number): boolean {
  for (let t = 0; t < LEVELS_PER_WORLD; t++) {
    const id = w * LEVELS_PER_WORLD + t + 1;
    if (progressFor(id).stars < 3) return false;
  }
  return true;
}

function checkMedals(stars: 0 | 1 | 2 | 3, firstClear: boolean): void {
  const got: string[] = [];
  if (firstClear && awardMedal('first-clear')) got.push('first-clear');
  if (S.bestChainThisLevel >= 6 && awardMedal('big-chain')) got.push('big-chain');
  if (S.shotsUsed <= 1 && awardMedal('one-shot')) got.push('one-shot');
  if (aliveBlocks() === 0 && awardMedal('demolition')) got.push('demolition');
  const w = S.level?.world ?? 0;
  if (worldCleared(w) && awardMedal(`world-${w}`)) got.push(`world-${w}`);
  if (worldPerfect(w) && awardMedal('perfect-world')) got.push('perfect-world');
  const ts = S.profile.totalStars;
  if (ts >= 30 && awardMedal('stars-30')) got.push('stars-30');
  if (ts >= 90 && awardMedal('stars-90')) got.push('stars-90');
  if (ts >= 150 && awardMedal('stars-150')) got.push('stars-150');
  void stars;
  if (got.length) {
    const first = MEDAL_BY_ID[got[0]!];
    if (first) toast(`🏅 ${first.name}`);
  }
}

function onLevelClear(): void {
  gen.bump();
  const leftover = totalAmmo();
  S.score += leftover * AMMO_BONUS;
  const stars = computeStars(S.level!, leftover);
  const res = recordLevelResult(S.levelIndex, S.score, stars);
  checkMedals(stars, res.firstClear);
  S.state = 'levelclear';
  audio.sfxWin();
  const myGen = gen.current();
  for (let i = 0; i < stars; i++) {
    window.setTimeout(
      () => {
        if (!gen.isCurrent(myGen)) return;
        audio.sfxStar(i);
      },
      320 + i * 220,
    );
  }
  renderHud();
  showLevelComplete(stars, S.score);
}

function onGameOver(): void {
  gen.bump();
  S.state = 'gameover';
  audio.sfxFail();
  showGameOver();
}
