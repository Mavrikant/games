// Yörünge smoke scenario — first-frame init invariants.
//
// What we assert:
// 1. HUD boots with level 1 / 0 wells / launch disabled (PITFALL#invisible-boot:
//    placement-phase satellite preview must render on the first frame, and the
//    counters must agree with the configured level — a mid-init crash would
//    leave score="" or wells="".)
// 2. Overlay is visible on first paint (PITFALL#unreachable-start-state:
//    the placing-phase overlay tells the user what to do; if it's hidden,
//    the first click goes nowhere because canvas placement only triggers
//    inside the canvas hit-rect — overlay forwards the first tap).
// 3. Overlay carries the level-specific intro copy referencing wells.

import { strict as assert } from 'node:assert';

export default async function yorunge(page) {
  const state = await page.evaluate(() => ({
    score: document.querySelector('#score')?.textContent ?? '',
    best: document.querySelector('#best')?.textContent ?? '',
    wells: document.querySelector('#wells')?.textContent ?? '',
    launchDisabled: document.querySelector('#launch')?.disabled,
    overlayVisible: !document.querySelector('#overlay')?.classList.contains('overlay--hidden'),
    overlayTitle: document.querySelector('#overlay-title')?.textContent ?? '',
    overlayMsg: document.querySelector('#overlay-msg')?.textContent ?? '',
    canvasW: document.querySelector('#board')?.width,
    canvasH: document.querySelector('#board')?.height,
  }));

  assert.equal(state.score, '1', `fresh yorunge boots on level 1, got "${state.score}"`);
  assert.equal(state.wells, '0/1', `level 1 has 1 well slot, wells="${state.wells}"`);
  assert.equal(state.launchDisabled, true, 'launch must be disabled before placing a well');
  assert.equal(state.overlayVisible, true, 'placing overlay must be visible on first paint');
  assert.equal(state.overlayTitle, 'Bölüm 1', `overlay title "Bölüm 1", got "${state.overlayTitle}"`);
  assert.match(
    state.overlayMsg,
    /kuyu/i,
    `overlay message should mention wells, got "${state.overlayMsg}"`,
  );
  assert.equal(state.canvasW, 360, 'canvas logical width');
  assert.equal(state.canvasH, 540, 'canvas logical height');
}
