// DOM layer: HUD sync (score/best/stars/level + ammo chips), the level-select
// map (60 cells in 6 world sections), and every overlay. Mirrors seker-esle's
// bind(refs)+handlers pattern. Uses @shared/overlay for show/hide.

import { showOverlay, hideOverlay } from '@shared/overlay';
import { S, progressFor } from './state';
import type { EngineId } from './types';
import { TOTAL_LEVELS, LEVELS_PER_WORLD } from './constants';
import { AMMO } from './ammo';
import { ENGINES, ENGINE_ORDER } from './engines';
import { WORLDS, getLevel } from './levels';
import { MEDALS } from './medals';
import * as audio from './audio';

export interface UiHandlers {
  onMapSelect(id: number): void;
  onIntroStart(): void;
  onNext(): void;
  onRetry(): void;
  onToMap(): void;
  onPrelevelStart(engineId: EngineId): void;
  onSetting(key: 'sfx' | 'music' | 'reducedMotion', value: boolean): void;
}

interface Refs {
  score: HTMLElement;
  best: HTMLElement;
  stars: HTMLElement;
  levelName: HTMLElement;
  ammoBar: HTMLElement;
  soundToggle: HTMLButtonElement;
  // overlays
  intro: HTMLElement;
  introStart: HTMLButtonElement;
  map: HTMLElement;
  mapGrid: HTMLElement;
  mapStars: HTMLElement;
  mapPlay: HTMLButtonElement;
  mapSettings: HTMLButtonElement;
  mapAch: HTMLButtonElement;
  prelevel: HTMLElement;
  prelevelTitle: HTMLElement;
  prelevelEngines: HTMLElement;
  prelevelBack: HTMLButtonElement;
  levelComplete: HTMLElement;
  lcTitle: HTMLElement;
  lcStars: HTMLElement;
  lcScore: HTMLElement;
  lcNext: HTMLButtonElement;
  lcRetry: HTMLButtonElement;
  lcMap: HTMLButtonElement;
  gameover: HTMLElement;
  goRetry: HTMLButtonElement;
  goMap: HTMLButtonElement;
  settings: HTMLElement;
  setSfx: HTMLInputElement;
  setMusic: HTMLInputElement;
  setMotion: HTMLInputElement;
  setClose: HTMLButtonElement;
  achievements: HTMLElement;
  achGrid: HTMLElement;
  achClose: HTMLButtonElement;
  toast: HTMLElement;
}

let R!: Refs;
let H!: UiHandlers;
let toastTimer: number | null = null;

function q<T extends HTMLElement>(id: string): T {
  return document.querySelector<T>(`#${id}`)!;
}

const ALL_OVERLAYS = (): HTMLElement[] => [
  R.intro,
  R.map,
  R.prelevel,
  R.levelComplete,
  R.gameover,
  R.settings,
  R.achievements,
];

function only(el: HTMLElement | null): void {
  for (const o of ALL_OVERLAYS()) {
    if (o === el) showOverlay(o);
    else hideOverlay(o);
  }
}

export function hideAllOverlays(): void {
  only(null);
}

function starsRow(n: number): string {
  let s = '';
  for (let i = 0; i < 3; i++) s += `<span class="star ${i < n ? 'star--on' : 'star--off'}">${i < n ? '★' : '☆'}</span>`;
  return s;
}

export function renderHud(): void {
  if (!R) return;
  R.score.textContent = String(S.score);
  R.best.textContent = String(progressFor(S.levelIndex).bestScore);
  R.stars.textContent = String(S.profile.totalStars);
  const lv = getLevel(S.levelIndex);
  R.levelName.textContent = `Seviye ${S.levelIndex} · ${lv.name}`;
  renderAmmoBar();
  updateSoundButton();
}

function renderAmmoBar(): void {
  R.ammoBar.innerHTML = '';
  for (const id of S.loadout) {
    const def = AMMO[id];
    const count = S.ammoCounts[id] ?? 0;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'ammo-chip';
    if (id === S.activeAmmo) chip.classList.add('ammo-chip--active');
    if (count <= 0) chip.classList.add('ammo-chip--empty');
    chip.innerHTML = `<span class="ammo-chip__glyph">${def.glyph}</span><span class="ammo-chip__count">${count}</span>`;
    chip.setAttribute('aria-label', `${def.name}: ${count}`);
    chip.title = `${def.name} — ${def.desc}`;
    chip.addEventListener('click', () => selectAmmo(id));
    R.ammoBar.appendChild(chip);
  }
}

export function selectAmmo(id: typeof S.activeAmmo): void {
  if ((S.ammoCounts[id] ?? 0) <= 0) return;
  if (S.state !== 'aiming') return;
  S.activeAmmo = id;
  audio.ensureAudio();
  audio.sfxUi();
  renderHud();
}

function updateSoundButton(): void {
  const on = S.profile.settings.sfx || S.profile.settings.music;
  R.soundToggle.textContent = on ? '🔊' : '🔇';
  R.soundToggle.setAttribute('aria-label', on ? 'Sesi kapat' : 'Sesi aç');
}

export function showIntro(): void {
  only(R.intro);
}

export function showMap(): void {
  renderMapGrid();
  R.mapStars.textContent = `${S.profile.totalStars} / ${TOTAL_LEVELS * 3}`;
  only(R.map);
  const cur = R.mapGrid.querySelector('.level-card--current');
  if (cur) requestAnimationFrame(() => cur.scrollIntoView({ block: 'nearest' }));
}

function renderMapGrid(): void {
  R.mapGrid.innerHTML = '';
  for (let wi = 0; wi < WORLDS.length; wi++) {
    const sec = document.createElement('section');
    sec.className = 'map-world';
    const label = document.createElement('div');
    label.className = 'map-world__label';
    label.textContent = `${wi + 1}. ${WORLDS[wi]!.name}`;
    sec.appendChild(label);
    const grid = document.createElement('div');
    grid.className = 'map-world__grid';
    for (let t = 0; t < LEVELS_PER_WORLD; t++) {
      const id = wi * LEVELS_PER_WORLD + t + 1;
      const prog = progressFor(id);
      const locked = id > S.profile.currentLevel;
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'level-card';
      if (locked) card.classList.add('level-card--locked');
      if (id === S.profile.currentLevel && !locked) card.classList.add('level-card--current');
      if (prog.cleared) card.classList.add('level-card--cleared');
      if (id % LEVELS_PER_WORLD === 0) card.classList.add('level-card--boss');
      card.innerHTML = `<span class="level-card__num">${id}</span><span class="level-card__stars">${starsRow(prog.stars)}</span>`;
      if (locked) {
        card.disabled = true;
        card.innerHTML += '<span class="level-card__lock">🔒</span>';
      } else {
        card.addEventListener('click', () => {
          audio.ensureAudio();
          audio.sfxUi();
          H.onMapSelect(id);
        });
      }
      grid.appendChild(card);
    }
    sec.appendChild(grid);
    R.mapGrid.appendChild(sec);
  }
}

function unlockedWorld(): number {
  return Math.floor((S.profile.currentLevel - 1) / LEVELS_PER_WORLD);
}

export function showPrelevel(id: number): void {
  const lv = getLevel(id);
  R.prelevelTitle.textContent = `Seviye ${id} · ${lv.name}`;
  R.prelevelEngines.innerHTML = '';
  const uw = unlockedWorld();
  for (const eid of ENGINE_ORDER) {
    const e = ENGINES[eid];
    const unlocked = e.unlockWorld <= uw || eid === lv.engine;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'engine-card';
    if (eid === lv.engine) btn.classList.add('engine-card--default');
    if (!unlocked) {
      btn.classList.add('engine-card--locked');
      btn.disabled = true;
    }
    btn.innerHTML = `<span class="engine-card__name">${e.name}${eid === lv.engine ? ' ✓' : ''}</span><span class="engine-card__desc">${unlocked ? e.desc : '🔒 İlerle'}</span>`;
    if (unlocked) {
      btn.addEventListener('click', () => {
        audio.ensureAudio();
        audio.sfxUi();
        H.onPrelevelStart(eid);
      });
    }
    R.prelevelEngines.appendChild(btn);
  }
  only(R.prelevel);
}

export function showLevelComplete(stars: 0 | 1 | 2 | 3, score: number): void {
  R.lcTitle.textContent = S.level?.isBoss ? 'Kale düştü!' : 'Sur düştü!';
  R.lcScore.textContent = String(score);
  R.lcStars.innerHTML = starsRow(stars);
  R.lcNext.style.display = S.levelIndex >= TOTAL_LEVELS ? 'none' : '';
  only(R.levelComplete);
}

export function showGameOver(): void {
  only(R.gameover);
}

export function showSettings(): void {
  R.setSfx.checked = S.profile.settings.sfx;
  R.setMusic.checked = S.profile.settings.music;
  R.setMotion.checked = S.profile.settings.reducedMotion;
  only(R.settings);
}

export function showAchievements(): void {
  R.achGrid.innerHTML = '';
  for (const m of MEDALS) {
    const got = S.profile.medals.includes(m.id);
    const cell = document.createElement('div');
    cell.className = `ach-cell ${got ? 'ach-cell--got' : 'ach-cell--locked'}`;
    cell.innerHTML = `<span class="ach-cell__glyph">${got ? m.glyph : '🔒'}</span><span class="ach-cell__name">${m.name}</span><span class="ach-cell__desc">${m.desc}</span>`;
    R.achGrid.appendChild(cell);
  }
  only(R.achievements);
}

export function toast(msg: string): void {
  R.toast.textContent = msg;
  R.toast.classList.add('toast--show');
  if (toastTimer !== null) clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => R.toast.classList.remove('toast--show'), 2200);
}

export function bindUi(handlers: UiHandlers): void {
  H = handlers;
  R = {
    score: q('score'),
    best: q('best'),
    stars: q('total-stars'),
    levelName: q('level-name'),
    ammoBar: q('ammo-bar'),
    soundToggle: q('sound-toggle'),
    intro: q('intro'),
    introStart: q('intro-start'),
    map: q('map'),
    mapGrid: q('map-grid'),
    mapStars: q('map-total-stars'),
    mapPlay: q('map-play'),
    mapSettings: q('map-settings'),
    mapAch: q('map-ach'),
    prelevel: q('prelevel'),
    prelevelTitle: q('prelevel-title'),
    prelevelEngines: q('prelevel-engines'),
    prelevelBack: q('prelevel-back'),
    levelComplete: q('level-complete'),
    lcTitle: q('lc-title'),
    lcStars: q('lc-stars'),
    lcScore: q('lc-score'),
    lcNext: q('lc-next'),
    lcRetry: q('lc-retry'),
    lcMap: q('lc-map'),
    gameover: q('gameover'),
    goRetry: q('go-retry'),
    goMap: q('go-map'),
    settings: q('settings'),
    setSfx: q('set-sfx'),
    setMusic: q('set-music'),
    setMotion: q('set-motion'),
    setClose: q('set-close'),
    achievements: q('achievements'),
    achGrid: q('ach-grid'),
    achClose: q('ach-close'),
    toast: q('toast'),
  };

  R.introStart.addEventListener('click', () => {
    audio.ensureAudio();
    audio.sfxUi();
    H.onIntroStart();
  });
  R.mapPlay.addEventListener('click', () => {
    audio.ensureAudio();
    H.onMapSelect(S.profile.currentLevel);
  });
  R.mapSettings.addEventListener('click', () => {
    audio.ensureAudio();
    showSettings();
  });
  R.mapAch.addEventListener('click', () => {
    audio.ensureAudio();
    showAchievements();
  });
  R.prelevelBack.addEventListener('click', () => H.onToMap());
  R.lcNext.addEventListener('click', () => H.onNext());
  R.lcRetry.addEventListener('click', () => H.onRetry());
  R.lcMap.addEventListener('click', () => H.onToMap());
  R.goRetry.addEventListener('click', () => H.onRetry());
  R.goMap.addEventListener('click', () => H.onToMap());
  R.setClose.addEventListener('click', () => showMap());
  R.achClose.addEventListener('click', () => showMap());
  R.setSfx.addEventListener('change', () => H.onSetting('sfx', R.setSfx.checked));
  R.setMusic.addEventListener('change', () => H.onSetting('music', R.setMusic.checked));
  R.setMotion.addEventListener('change', () => H.onSetting('reducedMotion', R.setMotion.checked));
  R.soundToggle.addEventListener('click', () => {
    audio.ensureAudio();
    const on = !(S.profile.settings.sfx || S.profile.settings.music);
    H.onSetting('sfx', on);
    H.onSetting('music', on);
  });
}
