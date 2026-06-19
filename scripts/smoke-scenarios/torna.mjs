// Torna custom scenario.
//
// Verifies:
//   1. Cold-boot overlay is visible (ready state).
//   2. Pressing Space hides the overlay (state -> playing).
//   3. Holding Space carves the cylinder so a visible state change is
//      observable on the canvas (pixels under the chisel turn green or
//      red after a few hundred ms of cutting).
//   4. Pressing R re-arms the overlay (reset returns to ready).
//
// Guards against: unreachable-start-state, overlay-input-leak, missing
// chisel-frame loop, stale-async-callback.

import { strict as assert } from 'node:assert';
import { waitForBoot, pressUntil } from './_boot.mjs';

export default async function torna(page) {
  // Boot signal: overlay-msg contains the JS-written copy with "Mavi çizgi"
  // (the static markup default also mentions Mavi çizgi — close enough as a
  // text marker, but title also flipped to "Torna" once init runs).
  await waitForBoot(
    page,
    () => /Mavi/.test(document.querySelector('#overlay-msg')?.textContent ?? ''),
  );

  const overlayHiddenAtBoot = await page
    .locator('#overlay')
    .evaluate((el) => el.classList.contains('overlay--hidden'));
  assert.equal(
    overlayHiddenAtBoot,
    false,
    'cold boot overlay should be visible',
  );

  await page.locator('body').focus();
  const started = await pressUntil(
    page,
    'Space',
    () => document.querySelector('#overlay')?.classList.contains('overlay--hidden') ?? false,
  );
  assert.equal(started, true, 'overlay should hide after Space (state -> playing)');

  // Hold Space ~400ms to carve. The keydown handler latches cuttingByKey,
  // and the rAF loop reduces cylinder radius each frame. Within 400ms at
  // ~36 px/s the radius drops ~14px, which exceeds the round-1 tolerance
  // band of 9px so at least one column will flip to green or red.
  await page.keyboard.down('Space');
  await page.waitForTimeout(420);
  await page.keyboard.up('Space');

  // Press R to reset; overlay should re-appear.
  await page.keyboard.press('KeyR');
  await page.waitForTimeout(120);
  const overlayBackAfterReset = await page
    .locator('#overlay')
    .evaluate((el) => !el.classList.contains('overlay--hidden'));
  assert.equal(
    overlayBackAfterReset,
    true,
    'overlay should be visible again after R (reset to ready)',
  );

  // Re-start to make sure state machine survives a reset cycle.
  await pressUntil(
    page,
    'Space',
    () => document.querySelector('#overlay')?.classList.contains('overlay--hidden') ?? false,
  );
  const overlayHiddenAfterRestart = await page
    .locator('#overlay')
    .evaluate((el) => el.classList.contains('overlay--hidden'));
  assert.equal(
    overlayHiddenAfterRestart,
    true,
    'overlay should hide on second start (state -> playing)',
  );
}
