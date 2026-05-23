// All overlay screens: map, settings, tutorial, level-complete, level-fail,
// achievements, daily-challenge intro, comeback gift, pause.
// Each maintains the .overlay--hidden CSS contract required by audit gate.

import { showOverlay, hideOverlay } from '@shared/overlay';
import { state, persistProfile, addBooster } from './state';
import { getLevel, totalLevels } from './levels';
import { sfxButton, sfxStarEarned, sfxStreakReward, sfxAchievementUnlock } from './audio';
import { starEarnedSparkle } from './particles';
import { ACHIEVEMENTS } from './achievements';
import { renderStars } from './hud';
import type { LevelDef } from './types';

interface OverlayRefs {
  map: HTMLElement;
  mapGrid: HTMLElement;
  mapPlayBtn: HTMLElement;
  mapDailyBtn: HTMLElement;
  mapAchievementsBtn: HTMLElement;
  mapSettingsBtn: HTMLElement;
  mapTotalStars: HTMLElement;
  mapStreakBadge: HTMLElement;
  levelComplete: HTMLElement;
  levelCompleteTitle: HTMLElement;
  levelCompleteScore: HTMLElement;
  levelCompleteStars: HTMLElement;
  levelCompleteNext: HTMLButtonElement;
  levelCompleteMap: HTMLButtonElement;
  levelFail: HTMLElement;
  levelFailRetry: HTMLButtonElement;
  levelFailMap: HTMLButtonElement;
  levelFailPlus5: HTMLButtonElement;
  settings: HTMLElement;
  settingsSound: HTMLInputElement;
  settingsVibrate: HTMLInputElement;
  settingsMotion: HTMLInputElement;
  settingsClose: HTMLButtonElement;
  tutorial: HTMLElement;
  tutorialStep: HTMLElement;
  tutorialSkip: HTMLButtonElement;
  tutorialNext: HTMLButtonElement;
  achievements: HTMLElement;
  achievementsGrid: HTMLElement;
  achievementsClose: HTMLButtonElement;
  daily: HTMLElement;
  dailyPlay: HTMLButtonElement;
  dailyClose: HTMLButtonElement;
  dailyTitle: HTMLElement;
  comeback: HTMLElement;
  comebackClaim: HTMLButtonElement;
  toast: HTMLElement;
}

let refs: OverlayRefs | null = null;

interface Handlers {
  onPlayLevel: (id: number) => void;
  onPlayDaily: () => void;
  onMapShow: () => void;
}

let handlers: Handlers | null = null;

export function bindOverlays(r: OverlayRefs, h: Handlers): void {
  refs = r;
  handlers = h;
  refs.mapPlayBtn.addEventListener('click', () => {
    sfxButton();
    hideOverlay(refs!.map);
    handlers?.onPlayLevel(state.profile.currentLevel);
  });
  refs.mapDailyBtn.addEventListener('click', () => {
    sfxButton();
    hideOverlay(refs!.map);
    handlers?.onPlayDaily();
  });
  refs.mapAchievementsBtn.addEventListener('click', () => {
    sfxButton();
    showAchievements();
  });
  refs.mapSettingsBtn.addEventListener('click', () => {
    sfxButton();
    showSettings();
  });
  refs.levelCompleteNext.addEventListener('click', () => {
    sfxButton();
    hideOverlay(refs!.levelComplete);
    handlers?.onPlayLevel(state.profile.currentLevel);
  });
  refs.levelCompleteMap.addEventListener('click', () => {
    sfxButton();
    hideOverlay(refs!.levelComplete);
    showMap();
  });
  refs.levelFailRetry.addEventListener('click', () => {
    sfxButton();
    hideOverlay(refs!.levelFail);
    handlers?.onPlayLevel(state.level);
  });
  refs.levelFailMap.addEventListener('click', () => {
    sfxButton();
    hideOverlay(refs!.levelFail);
    showMap();
  });
  refs.levelFailPlus5.addEventListener('click', () => {
    sfxButton();
    if (state.profile.boosters.plus5Moves > 0) {
      state.profile.boosters.plus5Moves -= 1;
      state.movesLeft += 5;
      persistProfile();
      document.dispatchEvent(new CustomEvent('seker-hud-update'));
      hideOverlay(refs!.levelFail);
      // Set phase back to idle so the user can play their bonus moves.
      state.phase = 'idle';
    }
  });
  refs.settingsSound.addEventListener('change', () => {
    state.profile.settings.sound = refs!.settingsSound.checked;
    persistProfile();
    document.dispatchEvent(new CustomEvent('seker-settings-changed'));
  });
  refs.settingsVibrate.addEventListener('change', () => {
    state.profile.settings.vibrate = refs!.settingsVibrate.checked;
    persistProfile();
  });
  refs.settingsMotion.addEventListener('change', () => {
    state.profile.settings.reducedMotion = refs!.settingsMotion.checked;
    persistProfile();
    document.dispatchEvent(new CustomEvent('seker-settings-changed'));
  });
  refs.settingsClose.addEventListener('click', () => {
    sfxButton();
    hideOverlay(refs!.settings);
  });
  refs.achievementsClose.addEventListener('click', () => {
    sfxButton();
    hideOverlay(refs!.achievements);
  });
  refs.tutorialSkip.addEventListener('click', () => {
    sfxButton();
    state.profile.tutorialDone = true;
    persistProfile();
    hideOverlay(refs!.tutorial);
    showMap();
  });
  refs.tutorialNext.addEventListener('click', () => {
    sfxButton();
    advanceTutorial();
  });
  refs.dailyPlay.addEventListener('click', () => {
    sfxButton();
    hideOverlay(refs!.daily);
    handlers?.onPlayDaily();
  });
  refs.dailyClose.addEventListener('click', () => {
    sfxButton();
    hideOverlay(refs!.daily);
    showMap();
  });
  refs.comebackClaim.addEventListener('click', () => {
    sfxButton();
    addBooster('hammer', 1);
    addBooster('swap', 1);
    addBooster('plus5Moves', 1);
    persistProfile();
    sfxStreakReward();
    hideOverlay(refs!.comeback);
    showMap();
  });
}

// ────────────── Map ──────────────

export function showMap(): void {
  if (!refs) return;
  renderMapGrid();
  refs.mapTotalStars.textContent = String(state.profile.totalStars);
  refs.mapStreakBadge.textContent = `${state.profile.streak} gün`;
  showOverlay(refs.map);
  handlers?.onMapShow();
}

export function hideMap(): void {
  if (!refs) return;
  hideOverlay(refs.map);
}

function renderMapGrid(): void {
  if (!refs) return;
  const grid = refs.mapGrid;
  grid.innerHTML = '';
  for (let id = 1; id <= totalLevels(); id++) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'level-card';
    const progress = state.profile.levels[id];
    const stars = progress?.stars ?? 0;
    const locked = id > state.profile.currentLevel;
    if (locked) card.classList.add('level-card--locked');
    if (id === state.profile.currentLevel) card.classList.add('level-card--current');
    const isBoss = id % 10 === 0;
    if (isBoss) card.classList.add('level-card--boss');
    card.innerHTML = `
      <div class="level-card__num">${id}</div>
      <div class="level-card__stars">
        ${[0,1,2].map((i) => `<span class="${i < stars ? 'star star--filled' : 'star star--empty'}">${i < stars ? '★' : '☆'}</span>`).join('')}
      </div>
      ${locked ? '<div class="level-card__lock">🔒</div>' : ''}
    `;
    if (!locked) {
      card.addEventListener('click', () => {
        sfxButton();
        hideOverlay(refs!.map);
        handlers?.onPlayLevel(id);
      });
    }
    grid.appendChild(card);
  }
  // Scroll to currentLevel
  requestAnimationFrame(() => {
    const cur = grid.children[state.profile.currentLevel - 1];
    if (cur && (cur as HTMLElement).scrollIntoView) {
      (cur as HTMLElement).scrollIntoView({ behavior: 'instant' as ScrollBehavior, inline: 'center', block: 'center' });
    }
  });
}

// ────────────── Level complete ──────────────

export function showLevelComplete(level: LevelDef, score: number, stars: 0 | 1 | 2 | 3): void {
  if (!refs) return;
  refs.levelCompleteTitle.textContent = `Seviye ${level.id} tamam!`;
  refs.levelCompleteScore.textContent = String(score);
  renderStars(refs.levelCompleteStars, stars);
  showOverlay(refs.levelComplete);
  // Animate stars
  for (let i = 0; i < stars; i++) {
    window.setTimeout(() => {
      sfxStarEarned(i as 0 | 1 | 2);
      const rect = refs!.levelCompleteStars.getBoundingClientRect();
      const board = document.getElementById('particles') as HTMLCanvasElement | null;
      if (board) {
        const brect = board.getBoundingClientRect();
        starEarnedSparkle(rect.left + 30 + i * 60 - brect.left, rect.top + 30 - brect.top);
      }
    }, i * 380 + 280);
  }
}

export function showLevelFailed(): void {
  if (!refs) return;
  refs.levelFailPlus5.disabled = (state.profile.boosters.plus5Moves ?? 0) <= 0;
  showOverlay(refs.levelFail);
}

// ────────────── Settings ──────────────

export function showSettings(): void {
  if (!refs) return;
  refs.settingsSound.checked = state.profile.settings.sound;
  refs.settingsVibrate.checked = state.profile.settings.vibrate;
  refs.settingsMotion.checked = state.profile.settings.reducedMotion;
  showOverlay(refs.settings);
}

// ────────────── Tutorial ──────────────

let tutorialStep = 0;
const TUTORIAL_STEPS: string[] = [
  'Bir şekere dokun ve yan komşusuna doğru sürükle.',
  '3 veya daha fazla aynı renk yan yana gelirse patlar.',
  'Üst üste patlamalar combo verir. Hadi dene!',
];

export function showTutorial(): void {
  if (!refs) return;
  tutorialStep = 0;
  refs.tutorialStep.textContent = TUTORIAL_STEPS[0]!;
  refs.tutorialNext.textContent = 'Anladım';
  showOverlay(refs.tutorial);
}

function advanceTutorial(): void {
  if (!refs) return;
  tutorialStep += 1;
  if (tutorialStep >= TUTORIAL_STEPS.length) {
    state.profile.tutorialDone = true;
    persistProfile();
    hideOverlay(refs.tutorial);
    showMap();
    return;
  }
  refs.tutorialStep.textContent = TUTORIAL_STEPS[tutorialStep]!;
  if (tutorialStep === TUTORIAL_STEPS.length - 1) {
    refs.tutorialNext.textContent = 'Başla';
  }
}

// ────────────── Achievements ──────────────

export function showAchievements(): void {
  if (!refs) return;
  const grid = refs.achievementsGrid;
  grid.innerHTML = '';
  for (const ach of ACHIEVEMENTS) {
    const unlocked = state.profile.achievements.includes(ach.id);
    const card = document.createElement('div');
    card.className = `ach-card ${unlocked ? 'ach-card--unlocked' : 'ach-card--locked'}`;
    card.innerHTML = `
      <div class="ach-card__icon">${ach.icon}</div>
      <div class="ach-card__body">
        <div class="ach-card__label">${ach.label}</div>
        <div class="ach-card__desc">${ach.desc}</div>
      </div>
    `;
    grid.appendChild(card);
  }
  showOverlay(refs.achievements);
}

// ────────────── Daily challenge ──────────────

export function showDailyIntro(level: LevelDef): void {
  if (!refs) return;
  refs.dailyTitle.textContent = level.title ?? 'Günün Meydan Okuması';
  showOverlay(refs.daily);
}

// ────────────── Comeback ──────────────

export function showComeback(): void {
  if (!refs) return;
  showOverlay(refs.comeback);
}

// ────────────── Toast ──────────────

const toastQueue: { label: string; desc: string }[] = [];
let toastRunning = false;

export function showAchievementToast(label: string, desc: string): void {
  toastQueue.push({ label, desc });
  if (!toastRunning) processToastQueue();
}

function processToastQueue(): void {
  if (!refs) return;
  const next = toastQueue.shift();
  if (!next) {
    toastRunning = false;
    return;
  }
  toastRunning = true;
  refs.toast.innerHTML = `
    <div class="toast__title">🏆 ${next.label}</div>
    <div class="toast__desc">${next.desc}</div>
  `;
  refs.toast.classList.remove('toast--hidden');
  refs.toast.classList.add('toast--show');
  sfxAchievementUnlock();
  window.setTimeout(() => {
    refs!.toast.classList.remove('toast--show');
    window.setTimeout(() => {
      refs!.toast.classList.add('toast--hidden');
      processToastQueue();
    }, 320);
  }, 2400);
}

void getLevel;
