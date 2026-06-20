// Sığırcık custom scenario — verifies the boids loop actually advances.
//
// The game shows a "Başla" overlay on cold boot. Clicking it (or pressing
// Space) transitions ready→playing and starts the RAF loop, which ticks
// the per-second score counter. Smoke catches the regression where init()
// boots without crashing but the RAF / state-transition wiring is broken
// — exactly the "page loaded ≠ game runs" pitfall we keep relearning.

import { strict as assert } from 'node:assert';
import { waitForBoot } from './_boot.mjs';

export default async function sigircik(page) {
  await waitForBoot(page, () => document.querySelector('#start-btn') !== null);

  await page.locator('#start-btn').click();

  const overlayHiddenAfterStart = await waitForBoot(
    page,
    () => document.querySelector('#overlay')?.classList.contains('overlay--hidden') ?? false,
    3000,
  );
  assert.ok(overlayHiddenAfterStart, 'overlay should hide after pressing Başla');

  const scoreAdvanced = await waitForBoot(
    page,
    () => Number(document.querySelector('#score')?.textContent ?? '0') >= 1,
    4000,
  );
  assert.ok(scoreAdvanced, 'score should advance past 0 within a few seconds of play');

  const flockText = (await page.locator('#flock-count').textContent()) ?? '0';
  const flockCount = Number(flockText);
  assert.ok(
    flockCount >= 1 && flockCount <= 20,
    `flock count should be a small positive number, got "${flockText}"`,
  );
}
