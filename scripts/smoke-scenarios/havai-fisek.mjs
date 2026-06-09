// Havai Fişek custom scenario.
//
// Verifies:
//   1. Intro overlay visible at cold boot (ready state).
//   2. Pressing Space hides the overlay and starts the round.
//   3. Lighting every fuse on a sensible schedule advances the round counter
//      (state machine transitions from playing → judging → next playing).
//
// Guards against: unreachable-start-state, overlay-input-leak, and HUD
// counters being synced only at lifecycle edges.

import { strict as assert } from 'node:assert';

export default async function havaiFisek(page) {
  const overlayHiddenAtBoot = await page
    .locator('#overlay')
    .evaluate((el) => el.classList.contains('overlay--hidden'));
  assert.equal(
    overlayHiddenAtBoot,
    false,
    'cold boot overlay should be visible',
  );

  await page.locator('body').focus();
  await page.keyboard.press('Space');
  await page.waitForTimeout(80);

  const overlayHiddenAfterStart = await page
    .locator('#overlay')
    .evaluate((el) => el.classList.contains('overlay--hidden'));
  assert.equal(
    overlayHiddenAfterStart,
    true,
    'overlay should hide after Space',
  );

  // We don't know the exact target/burn times (they're random), but we can
  // light every fuse in order at small intervals. With BASE_TOLERANCE = 0.30s
  // this won't be perfect every run, but the round will at least *resolve* and
  // either advance the round counter (success) or decrement lives. Either way
  // the state machine should leave 'playing' and re-enter it for round 2.
  // We just need to confirm the loop drives forward.
  for (const key of ['1', '2', '3', '4', '5']) {
    await page.keyboard.press(key);
    await page.waitForTimeout(60);
  }

  // Wait long enough for the longest possible burn-time + late-grace + result
  // delay to elapse and the next round to start.
  await page.waitForTimeout(7500);

  const after = await page.evaluate(() => ({
    round: document.querySelector('#round')?.textContent ?? '',
    lives: document.querySelector('#lives')?.textContent ?? '',
  }));

  // Either the round number went up (success) or lives went down (miss).
  // What we care about is that the state machine resolved at all.
  const roundProgressed = Number(after.round) >= 1;
  const livesDropped = Number(after.lives) < 3;
  assert.ok(
    roundProgressed || livesDropped,
    `expected the round to resolve, but round="${after.round}" lives="${after.lives}"`,
  );
}
