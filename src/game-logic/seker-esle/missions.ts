// Mission strategies: score / ingredient / jelly / color-collect.
// Score is tracked centrally via state.score; the mission tracks the
// "primary" objective and decides isComplete().

import type { Tile, MissionDef, MissionProgress, ColorTarget } from './types';
import { state } from './state';

interface MissionRuntime {
  ingredientsCollected: number;
  jelliesCleared: number;
  colorCounts: Map<number, number>;
}

const runtime: MissionRuntime = {
  ingredientsCollected: 0,
  jelliesCleared: 0,
  colorCounts: new Map(),
};

let active: MissionDef | null = null;

export function startMission(m: MissionDef): void {
  active = m;
  runtime.ingredientsCollected = 0;
  runtime.jelliesCleared = 0;
  runtime.colorCounts.clear();
}

export function bumpMission(matched: Iterable<Tile>, _meta: unknown[]): void {
  if (!active) return;
  if (active.type === 'color' && active.colorTargets) {
    for (const t of matched) {
      if (t.color < 0) continue;
      const target = active.colorTargets.find((ct: ColorTarget) => ct.color === t.color);
      if (target) {
        const cur = runtime.colorCounts.get(t.color) ?? 0;
        if (cur < target.count) runtime.colorCounts.set(t.color, cur + 1);
      }
    }
  }
}

export function consumeMatchedForMission(matched: Iterable<Tile>): void {
  void matched;
  // jelly + ingredient handled via separate events from gravity.ts
}

document.addEventListener('seker-jelly-clear', (e) => {
  if (!active || active.type !== 'jelly') return;
  const detail = (e as CustomEvent<number>).detail;
  runtime.jelliesCleared += detail;
});
document.addEventListener('seker-ingredient-clear', (e) => {
  if (!active || active.type !== 'ingredient') return;
  const detail = (e as CustomEvent<number>).detail;
  runtime.ingredientsCollected += detail;
});

export function getMissionProgress(): MissionProgress {
  if (!active) {
    return { type: 'score', current: 0, target: 0, label: '', done: false };
  }
  if (active.type === 'score') {
    return {
      type: 'score',
      current: state.score,
      target: active.scoreTarget,
      label: 'Hedef skor',
      done: state.score >= active.scoreTarget,
    };
  }
  if (active.type === 'ingredient') {
    const target = active.ingredientTarget ?? 0;
    return {
      type: 'ingredient',
      current: runtime.ingredientsCollected,
      target,
      label: 'Kiraz indir',
      done: runtime.ingredientsCollected >= target,
    };
  }
  if (active.type === 'jelly') {
    const target = active.jellyTarget ?? 0;
    return {
      type: 'jelly',
      current: runtime.jelliesCleared,
      target,
      label: 'Jöleyi temizle',
      done: runtime.jelliesCleared >= target,
    };
  }
  // color collect
  const targets = active.colorTargets ?? [];
  let cur = 0; let tot = 0; let done = true;
  for (const t of targets) {
    const have = runtime.colorCounts.get(t.color) ?? 0;
    cur += Math.min(have, t.count);
    tot += t.count;
    if (have < t.count) done = false;
  }
  return {
    type: 'color',
    current: cur,
    target: tot,
    label: 'Renkleri topla',
    done,
    detail: targets.map((t) => ({
      color: t.color,
      current: Math.min(runtime.colorCounts.get(t.color) ?? 0, t.count),
      target: t.count,
    })),
  };
}

export function isMissionComplete(): boolean {
  return getMissionProgress().done && state.score >= (active?.scoreTarget ?? 0);
}
