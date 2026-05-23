// Settings adapter: pushes user-facing toggles into the audio engine and
// particle engine, keeping the rest of the codebase ignorant of which
// subsystems care about which flags.

import { state } from './state';
import { setEnabled as setAudioEnabled } from './audio';
import { setIntensity } from './particles';

export function applySettings(): void {
  setAudioEnabled(state.profile.settings.sound);
  setIntensity(state.profile.settings.reducedMotion ? 0.25 : 1);
  const root = document.querySelector<HTMLElement>('.seker-esle-stage');
  if (root) {
    root.dataset['reducedMotion'] = state.profile.settings.reducedMotion ? 'true' : 'false';
  }
}

export function bindSettingsListener(): void {
  document.addEventListener('seker-settings-changed', () => applySettings());
}
