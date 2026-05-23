// HUD: level/score/moves/best + mission progress bar + booster chips +
// star rating display. Re-renders on 'seker-hud-update' custom events.

import { state } from './state';
import { getMissionProgress } from './missions';
import type { BoosterId } from './types';

interface HudRefs {
  level: HTMLElement;
  score: HTMLElement;
  moves: HTMLElement;
  best: HTMLElement;
  totalStars: HTMLElement;
  missionLabel: HTMLElement;
  missionFill: HTMLElement;
  missionCount: HTMLElement;
  missionIcon: HTMLElement;
  starsDisplay: HTMLElement;
  boosterBar: HTMLElement;
  levelTitle: HTMLElement;
}

const BOOSTER_LABELS: Record<BoosterId, string> = {
  hammer: 'Çekiç',
  swap: 'Yer değiş',
  colorBombStart: 'Bomba',
  plus5Moves: '+5 Hamle',
};

const BOOSTER_ICONS: Record<BoosterId, string> = {
  hammer: '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M14.2 2.3 22 10l-3 3-1.5-1.5-9.7 9.7-3.3-3.3 9.7-9.7L12.6 7l1.6-4.7Z"/></svg>',
  swap: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h13l-3-3"/><path d="M20 17H7l3 3"/></svg>',
  colorBombStart: '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><circle cx="12" cy="13" r="7"/><path d="M14 4l1 2 2 .5-1.5 1.5.5 2-2-1-2 1 .5-2L11 6.5l2-.5z"/></svg>',
  plus5Moves: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg>',
};

const MISSION_ICONS: Record<string, string> = {
  score: '⭐',
  ingredient: '🍒',
  jelly: '🟪',
  color: '🎨',
};

let refs: HudRefs | null = null;
let boosterClickListener: ((id: BoosterId) => void) | null = null;

export function bindHud(r: HudRefs): void {
  refs = r;
  document.addEventListener('seker-hud-update', renderHud);
}

export function setBoosterClickListener(fn: (id: BoosterId) => void): void {
  boosterClickListener = fn;
}

export function renderHud(): void {
  if (!refs) return;
  refs.level.textContent = String(state.isDailyChallenge ? 'D' : state.level);
  refs.score.textContent = String(state.score);
  refs.moves.textContent = String(state.movesLeft);
  refs.best.textContent = String(state.profile.bestLevel);
  refs.totalStars.textContent = String(state.profile.totalStars);

  const mp = getMissionProgress();
  refs.missionLabel.textContent = mp.label;
  refs.missionIcon.textContent = MISSION_ICONS[mp.type] ?? '⭐';
  refs.missionCount.textContent = `${mp.current}/${mp.target}`;
  const ratio = mp.target > 0 ? Math.min(1, mp.current / mp.target) : 0;
  refs.missionFill.style.width = `${Math.round(ratio * 100)}%`;
  refs.missionFill.classList.toggle('mission-bar__fill--full', mp.done);

  refs.boosterBar.innerHTML = '';
  for (const id of ['hammer', 'swap', 'colorBombStart', 'plus5Moves'] as BoosterId[]) {
    const count = state.profile.boosters[id] ?? 0;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'booster-chip';
    chip.dataset['booster'] = id;
    chip.disabled = count <= 0;
    chip.innerHTML = `
      <span class="booster-chip__icon" aria-hidden="true">${BOOSTER_ICONS[id]}</span>
      <span class="booster-chip__count">${count}</span>
      <span class="booster-chip__label">${BOOSTER_LABELS[id]}</span>
    `;
    chip.addEventListener('click', (e) => {
      e.preventDefault();
      if (count <= 0) return;
      boosterClickListener?.(id);
    });
    refs.boosterBar.appendChild(chip);
  }

  if (refs.levelTitle) {
    const title = state.isDailyChallenge
      ? 'Günün Meydan Okuması'
      : `Seviye ${state.level}`;
    refs.levelTitle.textContent = title;
  }
}

export function renderStars(target: HTMLElement, stars: 0 | 1 | 2 | 3): void {
  target.innerHTML = '';
  for (let i = 0; i < 3; i++) {
    const s = document.createElement('span');
    s.className = `star ${i < stars ? 'star--filled' : 'star--empty'}`;
    s.textContent = i < stars ? '★' : '☆';
    target.appendChild(s);
  }
}
