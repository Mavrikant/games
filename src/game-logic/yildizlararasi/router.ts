// Scene state machine. goto() leaves the current scene (cleanup), swaps the
// visible container, then enters the next. Declared as a function (hoisted) so
// scene modules can import it despite the circular reference.

import { S } from './state';
import { scene as customize } from './scene-customize';
import { scene as final } from './scene-final';
import { scene as intro } from './scene-intro';
import { scene as mode } from './scene-mode';
import { scene as play } from './scene-play';
import { scene as setup } from './scene-setup';
import type { Scene, SceneId } from './types';

const SCENES: Record<SceneId, Scene> = { intro, customize, mode, setup, play, final };
const CONTAINER_ID: Record<SceneId, string> = {
  intro: 'yi-intro',
  customize: 'yi-customize',
  mode: 'yi-mode',
  setup: 'yi-setup',
  play: 'yi-play',
  final: 'yi-final',
};

let current: SceneId | null = null;

function show(id: SceneId, visible: boolean): void {
  const el = document.getElementById(CONTAINER_ID[id]);
  if (!el) return;
  el.hidden = !visible;
  el.classList.toggle('yi-scene--active', visible);
}

export function goto(next: SceneId): void {
  // Order matters (pitfall: stale-dom-from-prev-state): update state, tear down
  // old DOM, then build the new scene.
  if (current) {
    SCENES[current].leave();
    show(current, false);
  }
  S.scene = next;
  current = next;
  show(next, true);
  SCENES[next].enter();
}
