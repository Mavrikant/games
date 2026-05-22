// Radar smoke scenario — cold-boot first-paint invariants.
//
// What we assert:
// 1. HUD boots with score=0, time=60, best is numeric (PITFALL#invisible-boot:
//    init() must initialise all three counters; mid-init crash leaves blanks).
// 2. Overlay is visible on first paint with "Radar" title — the player needs
//    a clear entry point (PITFALL#unreachable-start-state).
// 3. The overlay carries the visual contract: position:absolute, plus
//    .overlay--hidden is *not* applied on first paint (PITFALL#missing-overlay-css).
// 4. Canvas exists with the configured 480×480 logical size — a body markup
//    regression that drops the canvas would make the game unplayable but not
//    throw.

import { strict as assert } from 'node:assert';

export default async function radar(page) {
  const state = await page.evaluate(() => ({
    score: document.querySelector('#score')?.textContent ?? '',
    time: document.querySelector('#time')?.textContent ?? '',
    best: document.querySelector('#best')?.textContent ?? '',
    overlayHidden: document
      .querySelector('#overlay')
      ?.classList.contains('overlay--hidden'),
    overlayTitle: document.querySelector('#overlay-title')?.textContent ?? '',
    overlayPos: getComputedStyle(document.querySelector('#overlay'))
      .getPropertyValue('position')
      .trim(),
    canvasW: document.querySelector('#board')?.width,
    canvasH: document.querySelector('#board')?.height,
  }));

  assert.equal(state.score, '0', `fresh radar boot score should be 0, got "${state.score}"`);
  assert.equal(state.time, '60', `fresh radar boot time should be 60, got "${state.time}"`);
  assert.match(state.best, /^\d+$/, `best should be numeric, got "${state.best}"`);
  assert.equal(
    state.overlayHidden,
    false,
    'start overlay must be visible on first paint',
  );
  assert.equal(
    state.overlayTitle,
    'Radar',
    `overlay title should be "Radar", got "${state.overlayTitle}"`,
  );
  assert.equal(
    state.overlayPos,
    'absolute',
    `overlay must be absolutely positioned (PITFALL#missing-overlay-css), got "${state.overlayPos}"`,
  );
  assert.equal(state.canvasW, 480, 'canvas logical width');
  assert.equal(state.canvasH, 480, 'canvas logical height');
}
