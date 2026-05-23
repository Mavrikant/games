// Tutorial trigger: shown on first boot, controls handed to overlays.ts.
// State persisted in profile.tutorialDone.

import { state } from './state';

export function shouldShowTutorial(): boolean {
  return !state.profile.tutorialDone;
}

export function markTutorialDone(): void {
  state.profile.tutorialDone = true;
}
