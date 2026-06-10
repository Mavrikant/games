// Tek Çizgi smoke scenario — first-frame init invariants.
//
// What we assert:
// 1. HUD boots on level 1 (Üçgen, 3 edges) with kalan=3 (PITFALL#invisible-boot:
//    if reset/loadLevel forgets to refresh #remaining, the counter shows the
//    template default 0 instead of the level's edge count).
// 2. Overlay is hidden on first paint — game starts in 'ready' state and the
//    user can directly tap a node, no start overlay between them and play.
// 3. Canvas is the standard 480 logical size.

import { strict as assert } from 'node:assert';
import { waitForBoot } from './_boot.mjs';

export default async function tekCizgi(page) {
  // #remaining is "0" in the template markup; loadLevel() writes the level's
  // edge count on boot. Poll for that write before snapshotting.
  await waitForBoot(
    page,
    () => document.querySelector('#remaining')?.textContent !== '0',
  );

  const state = await page.evaluate(() => ({
    score: document.querySelector('#score')?.textContent ?? '',
    best: document.querySelector('#best')?.textContent ?? '',
    remaining: document.querySelector('#remaining')?.textContent ?? '',
    overlayHidden: document.querySelector('#overlay')?.classList.contains('overlay--hidden'),
    canvasW: document.querySelector('#board')?.width,
    canvasH: document.querySelector('#board')?.height,
  }));

  assert.equal(state.score, '1', `fresh tek-cizgi boots on level 1, got "${state.score}"`);
  assert.equal(state.remaining, '3', `level 1 (triangle) has 3 edges, kalan="${state.remaining}"`);
  assert.equal(state.overlayHidden, true, 'overlay must be hidden on first paint (ready state)');
  assert.equal(state.canvasW, 480, 'canvas logical width');
  assert.equal(state.canvasH, 480, 'canvas logical height');
}
