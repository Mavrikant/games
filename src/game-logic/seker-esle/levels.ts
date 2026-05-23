// 100 levels: first 20 hand-tuned (tutorial-friendly progression),
// 21..100 generated via a difficulty curve, with boss overrides every 10.

import { SIZE, type LevelDef, type LayoutPlacement, type MissionDef } from './types';

const TOTAL_LEVELS = 100;

function emptyLayout(): LayoutPlacement {
  return { blocked: [], jelly: [], ingredients: [], preSpecials: [] };
}

function scoreThresholds(base: number): [number, number, number] {
  return [base, Math.round(base * 1.5), Math.round(base * 2)];
}

function scoreMission(target: number): MissionDef {
  return { type: 'score', scoreTarget: target };
}

function ingredientMission(scoreTarget: number, ingredients: number): MissionDef {
  return { type: 'ingredient', scoreTarget, ingredientTarget: ingredients };
}

function jellyMission(scoreTarget: number, jellies: number): MissionDef {
  return { type: 'jelly', scoreTarget, jellyTarget: jellies };
}

function colorMission(scoreTarget: number, colors: [number, number][]): MissionDef {
  return {
    type: 'color',
    scoreTarget,
    colorTargets: colors.map(([color, count]) => ({ color, count })),
  };
}

function bossLayout(): LayoutPlacement {
  // Boss: a few jelly tiles in a cross pattern at center.
  const center = Math.floor(SIZE / 2);
  return {
    blocked: [],
    jelly: [
      [center - 1, center, 2],
      [center, center - 1, 2],
      [center, center, 2],
      [center, center + 1, 2],
      [center + 1, center, 2],
    ],
    ingredients: [],
    preSpecials: [],
  };
}

function ingredientLayout(count: number): LayoutPlacement {
  // Ingredients drop down via gravity to the bottom row. Starting them at
  // row 6 keeps the mission solvable within a normal move budget (1-2 drops).
  const cols = [1, 6, 3, 4, 0, 7];
  const placements: [number, number][] = [];
  for (let i = 0; i < count; i++) placements.push([6, cols[i % cols.length]!]);
  return { blocked: [], jelly: [], ingredients: placements, preSpecials: [] };
}

function jellyLayout(count: number): LayoutPlacement {
  const placements: [number, number, number][] = [];
  // Distribute jelly tiles in a ring near edges
  const positions: [number, number][] = [
    [0, 0], [0, 7], [7, 0], [7, 7],
    [3, 3], [3, 4], [4, 3], [4, 4],
    [1, 3], [6, 4], [3, 1], [4, 6],
    [0, 3], [0, 4], [7, 3], [7, 4],
  ];
  for (let i = 0; i < count && i < positions.length; i++) {
    const [r, c] = positions[i]!;
    placements.push([r, c, 1]);
  }
  return { blocked: [], jelly: placements, ingredients: [], preSpecials: [] };
}

// Hand-tuned first 20 levels: gentle curve, tutorial-friendly.
const HAND_TUNED: LevelDef[] = [
  { id: 1, mission: scoreMission(250), colors: 4, moves: 22, layout: emptyLayout(), starThresholds: scoreThresholds(250) },
  { id: 2, mission: scoreMission(350), colors: 4, moves: 22, layout: emptyLayout(), starThresholds: scoreThresholds(350) },
  { id: 3, mission: scoreMission(500), colors: 4, moves: 22, layout: emptyLayout(), starThresholds: scoreThresholds(500) },
  { id: 4, mission: scoreMission(700), colors: 5, moves: 22, layout: emptyLayout(), starThresholds: scoreThresholds(700) },
  { id: 5, mission: scoreMission(900), colors: 5, moves: 22, layout: emptyLayout(), starThresholds: scoreThresholds(900) },
  { id: 6, mission: ingredientMission(600, 1), colors: 4, moves: 25, layout: ingredientLayout(1), starThresholds: scoreThresholds(600), title: 'Kiraz indir' },
  { id: 7, mission: ingredientMission(700, 2), colors: 4, moves: 28, layout: ingredientLayout(2), starThresholds: scoreThresholds(700) },
  { id: 8, mission: scoreMission(1000), colors: 5, moves: 24, layout: emptyLayout(), starThresholds: scoreThresholds(1000) },
  { id: 9, mission: scoreMission(1200), colors: 5, moves: 24, layout: emptyLayout(), starThresholds: scoreThresholds(1200) },
  { id: 10, mission: scoreMission(1500), colors: 5, moves: 24, layout: bossLayout(), starThresholds: scoreThresholds(1500), isBoss: true, title: 'Boss: jöle çapraz' },
  { id: 11, mission: jellyMission(900, 4), colors: 5, moves: 26, layout: jellyLayout(4), starThresholds: scoreThresholds(900), title: 'Jöleyi temizle' },
  { id: 12, mission: jellyMission(1100, 6), colors: 5, moves: 28, layout: jellyLayout(6), starThresholds: scoreThresholds(1100) },
  { id: 13, mission: scoreMission(1300), colors: 5, moves: 22, layout: emptyLayout(), starThresholds: scoreThresholds(1300) },
  { id: 14, mission: colorMission(800, [[0, 10]]), colors: 5, moves: 22, layout: emptyLayout(), starThresholds: scoreThresholds(800), title: 'Pembe topla' },
  { id: 15, mission: colorMission(900, [[0, 6], [3, 6]]), colors: 5, moves: 22, layout: emptyLayout(), starThresholds: scoreThresholds(900) },
  { id: 16, mission: scoreMission(1400), colors: 6, moves: 24, layout: emptyLayout(), starThresholds: scoreThresholds(1400) },
  { id: 17, mission: ingredientMission(900, 2), colors: 5, moves: 24, layout: ingredientLayout(2), starThresholds: scoreThresholds(900) },
  { id: 18, mission: jellyMission(1200, 6), colors: 5, moves: 24, layout: jellyLayout(6), starThresholds: scoreThresholds(1200) },
  { id: 19, mission: colorMission(1200, [[1, 8], [2, 8]]), colors: 6, moves: 24, layout: emptyLayout(), starThresholds: scoreThresholds(1200) },
  { id: 20, mission: scoreMission(2000), colors: 6, moves: 24, layout: bossLayout(), starThresholds: scoreThresholds(2000), isBoss: true, title: 'Boss: hızlı skor' },
];

function generatedLevel(id: number): LevelDef {
  const tier = Math.floor((id - 1) / 10);
  const isBoss = id % 10 === 0;
  const colors = Math.min(7, 4 + Math.floor(tier / 2));
  const moves = Math.max(18, 26 - Math.floor(tier / 2) - (isBoss ? 2 : 0));
  const scoreBase = 600 + tier * 220 + (isBoss ? 600 : 0);
  const variant = id % 4;
  let mission: MissionDef;
  let layout: LayoutPlacement = emptyLayout();
  let title: string | undefined;
  if (variant === 0 || isBoss) {
    mission = scoreMission(scoreBase);
    if (isBoss) {
      layout = bossLayout();
      title = `Boss seviye ${id}`;
    }
  } else if (variant === 1) {
    const n = Math.min(4, 1 + Math.floor(tier / 3));
    mission = ingredientMission(scoreBase, n);
    layout = ingredientLayout(n);
    title = `Kiraz ${n}`;
  } else if (variant === 2) {
    const n = Math.min(10, 3 + tier);
    mission = jellyMission(scoreBase, n);
    layout = jellyLayout(n);
    title = `Jöle ${n}`;
  } else {
    const totalCount = Math.min(16, 8 + tier);
    const colorA = id % colors;
    const colorB = (id + 2) % colors;
    mission = colorMission(scoreBase, [
      [colorA, Math.floor(totalCount / 2)],
      [colorB, Math.floor(totalCount / 2)],
    ]);
    title = 'Renk topla';
  }
  return {
    id,
    mission,
    colors,
    moves,
    layout,
    starThresholds: scoreThresholds(mission.scoreTarget),
    isBoss,
    title,
  };
}

const CACHE: Map<number, LevelDef> = new Map();
for (const lv of HAND_TUNED) CACHE.set(lv.id, lv);

export function getLevel(id: number): LevelDef {
  const cap = Math.min(TOTAL_LEVELS, Math.max(1, id));
  const cached = CACHE.get(cap);
  if (cached) return cached;
  const gen = generatedLevel(cap);
  CACHE.set(cap, gen);
  return gen;
}

export function totalLevels(): number {
  return TOTAL_LEVELS;
}

// Daily challenge: generated from today's seed, harder than current level.
export function generateDailyLevel(seed: number, baseLevel: number): LevelDef {
  const rand = (n: number): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed % n;
  };
  const baseId = Math.max(5, baseLevel);
  const colors = Math.min(7, 5 + (rand(3)));
  const moves = 18 + rand(6);
  const scoreTarget = 1500 + rand(2000);
  const variant = rand(4);
  let mission: MissionDef;
  let layout: LayoutPlacement = emptyLayout();
  if (variant === 0) {
    mission = scoreMission(scoreTarget);
  } else if (variant === 1) {
    const n = 2 + rand(3);
    mission = ingredientMission(scoreTarget, n);
    layout = ingredientLayout(n);
  } else if (variant === 2) {
    const n = 6 + rand(6);
    mission = jellyMission(scoreTarget, n);
    layout = jellyLayout(n);
  } else {
    const c1 = rand(colors);
    let c2 = rand(colors);
    if (c2 === c1) c2 = (c2 + 1) % colors;
    mission = colorMission(scoreTarget, [[c1, 8], [c2, 8]]);
  }
  return {
    id: 1000 + baseId,
    mission,
    colors,
    moves,
    layout,
    starThresholds: scoreThresholds(mission.scoreTarget),
    title: 'Günün Meydan Okuması',
  };
}
