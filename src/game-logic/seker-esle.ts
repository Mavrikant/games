import { defineGame } from '@shared/game-module';
import { reportGameOver } from '@shared/leaderboard';

import { state, loadProfile, setPhase, bumpGeneration, persistProfile, recordLevelResult } from './seker-esle/state';
import {
  bindBoard,
  buildLevelBoard,
  repositionAll,
  getBoardEl,
} from './seker-esle/board';
import { bindCanvas, resize as resizeParticles } from './seker-esle/particles';
import { setLevel as setCascadeLevel, bindCascadeUi } from './seker-esle/cascade';
import { bindInput } from './seker-esle/input';
import { startMission } from './seker-esle/missions';
import { renderHud, bindHud, setBoosterClickListener } from './seker-esle/hud';
import { bindOverlays, showMap, showLevelComplete, showLevelFailed, showTutorial, showComeback, showDailyIntro } from './seker-esle/overlays';
import { bindBoosters, activateBooster, setBoosterLevel } from './seker-esle/boosters';
import { tickDailyState, getTodayDailyLevel, recordDailySolve, applyComebackBonus, isDailyCompletedToday } from './seker-esle/daily';
import { applySettings, bindSettingsListener } from './seker-esle/settings';
import { ensureAudio } from './seker-esle/audio';
import { getLevel } from './seker-esle/levels';
import type { LevelDef } from './seker-esle/types';

let currentLevel: LevelDef | null = null;
let dailyMode = false;

// Global leaderboard: highest level reached (higher is better). The game's own
// best level is persisted under the legacy key seker-esle.best by state.ts.
const SCORE_DESC = { gameId: 'seker-esle', storageKey: 'seker-esle.best', direction: 'higher' as const };

function startLevel(id: number, opts: { daily?: boolean } = {}): void {
  bumpGeneration();
  ensureAudio();
  dailyMode = !!opts.daily;
  state.isDailyChallenge = dailyMode;
  const level = dailyMode ? getTodayDailyLevel() : getLevel(id);
  currentLevel = level;
  state.level = level.id;
  state.score = 0;
  state.movesLeft = level.moves;
  state.cascadeDepth = 0;
  state.comboStreak = 0;
  startMission(level.mission);
  setCascadeLevel(level);
  setBoosterLevel(level);
  buildLevelBoard(level);
  setPhase('idle');
  renderHud();
  resizeParticles();
}

function init(): void {
  state.profile = loadProfile();
  applySettings();
  bindSettingsListener();

  const board = document.querySelector<HTMLDivElement>('#board')!;
  const tiles = document.querySelector<HTMLDivElement>('#tiles')!;
  const canvas = document.querySelector<HTMLCanvasElement>('#particles')!;
  bindBoard(board, tiles);
  bindCanvas(canvas);

  bindCascadeUi({
    banner: document.querySelector<HTMLElement>('#combo-banner')!,
    comboBanner: document.querySelector<HTMLElement>('#combo-streak')!,
    popups: document.querySelector<HTMLElement>('#score-popups')!,
  });

  bindHud({
    level: document.querySelector('#hud-level')!,
    score: document.querySelector('#hud-score')!,
    moves: document.querySelector('#hud-moves')!,
    best: document.querySelector('#hud-best')!,
    totalStars: document.querySelector('#hud-stars')!,
    missionLabel: document.querySelector('#mission-label')!,
    missionFill: document.querySelector('#mission-fill')!,
    missionCount: document.querySelector('#mission-count')!,
    missionIcon: document.querySelector('#mission-icon')!,
    starsDisplay: document.querySelector('#hud-stars-row')!,
    boosterBar: document.querySelector('#booster-bar')!,
    levelTitle: document.querySelector('#level-title')!,
  });
  setBoosterClickListener((id) => activateBooster(id));

  bindBoosters({ onChange: renderHud });
  bindInput();

  bindOverlays({
    map: document.querySelector('#map')!,
    mapGrid: document.querySelector('#map-grid')!,
    mapPlayBtn: document.querySelector('#map-play')!,
    mapDailyBtn: document.querySelector('#map-daily')!,
    mapAchievementsBtn: document.querySelector('#map-achievements')!,
    mapSettingsBtn: document.querySelector('#map-settings')!,
    mapTotalStars: document.querySelector('#map-total-stars')!,
    mapStreakBadge: document.querySelector('#map-streak')!,
    levelComplete: document.querySelector('#level-complete')!,
    levelCompleteTitle: document.querySelector('#level-complete-title')!,
    levelCompleteScore: document.querySelector('#level-complete-score')!,
    levelCompleteStars: document.querySelector('#level-complete-stars')!,
    levelCompleteNext: document.querySelector('#level-complete-next')!,
    levelCompleteMap: document.querySelector('#level-complete-map')!,
    levelFail: document.querySelector('#level-fail')!,
    levelFailRetry: document.querySelector('#level-fail-retry')!,
    levelFailMap: document.querySelector('#level-fail-map')!,
    levelFailPlus5: document.querySelector('#level-fail-plus5')!,
    settings: document.querySelector('#settings')!,
    settingsSound: document.querySelector('#setting-sound')!,
    settingsVibrate: document.querySelector('#setting-vibrate')!,
    settingsMotion: document.querySelector('#setting-motion')!,
    settingsClose: document.querySelector('#setting-close')!,
    tutorial: document.querySelector('#tutorial')!,
    tutorialStep: document.querySelector('#tutorial-step')!,
    tutorialSkip: document.querySelector('#tutorial-skip')!,
    tutorialNext: document.querySelector('#tutorial-next')!,
    achievements: document.querySelector('#achievements')!,
    achievementsGrid: document.querySelector('#achievements-grid')!,
    achievementsClose: document.querySelector('#achievements-close')!,
    daily: document.querySelector('#daily-intro')!,
    dailyPlay: document.querySelector('#daily-play')!,
    dailyClose: document.querySelector('#daily-close')!,
    dailyTitle: document.querySelector('#daily-title')!,
    comeback: document.querySelector('#comeback')!,
    comebackClaim: document.querySelector('#comeback-claim')!,
    toast: document.querySelector('#toast')!,
  }, {
    onPlayLevel: (id: number) => startLevel(id),
    onPlayDaily: () => startLevel(0, { daily: true }),
    onMapShow: () => {/* no-op; map handles its own */},
  });

  // Restart button at HUD level
  const restartBtn = document.querySelector<HTMLButtonElement>('#restart');
  restartBtn?.addEventListener('click', () => {
    if (currentLevel) startLevel(currentLevel.id, { daily: dailyMode });
  });
  const mapBtn = document.querySelector<HTMLButtonElement>('#map-btn');
  mapBtn?.addEventListener('click', () => {
    setPhase('map');
    showMap();
  });

  // Level complete + fail listeners
  document.addEventListener('seker-level-complete', (e) => {
    const detail = (e as CustomEvent<{ stars: 0 | 1 | 2 | 3; score: number }>).detail;
    if (!currentLevel) return;
    if (dailyMode) {
      recordDailySolve(detail.stars, detail.score);
    }
    // Highest level reached — recordLevelResult() already bumped bestLevel
    // before this event fired.
    reportGameOver(SCORE_DESC, state.profile.bestLevel, { label: 'Seviye' });
    showLevelComplete(currentLevel, detail.score, detail.stars);
  });
  document.addEventListener('seker-level-failed', () => {
    showLevelFailed();
  });

  // Resize handling
  let resizeRaf = 0;
  const onResize = (): void => {
    if (resizeRaf) cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = 0;
      repositionAll();
      resizeParticles();
    });
  };
  window.addEventListener('resize', onResize);
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(onResize).observe(getBoardEl());
  }

  // Boot routing
  const { isComeback, dailyAvailable } = tickDailyState();
  state.phase = 'map';
  // Render a default board behind overlays so resize math has a valid grid
  startLevel(state.profile.currentLevel);
  renderHud();
  // Then overlay flow
  if (!state.profile.tutorialDone) {
    showTutorial();
  } else if (isComeback) {
    applyComebackBonus();
    showComeback();
  } else if (dailyAvailable && !isDailyCompletedToday()) {
    const lvl = getTodayDailyLevel();
    showDailyIntro(lvl);
  } else {
    showMap();
  }
  persistProfile();
}

function reset(): void {
  if (currentLevel) startLevel(currentLevel.id, { daily: dailyMode });
}

void recordLevelResult;

export const game = defineGame({ init, reset });
