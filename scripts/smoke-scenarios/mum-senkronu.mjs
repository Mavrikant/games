// Mum Senkronu custom scenario.
//
// Verifies:
//   1. Intro overlay is visible at cold boot (ready state).
//   2. Pressing Space starts the round (overlay hides).
//   3. Hammering the number keys 1..N rapidly lights every candle and pushes
//      the sync bar to 100, which advances level → score increments by 1.
//
// This catches the "ready unreachable" pitfall (PITFALLS#unreachable-start-state)
// and the "wired-but-no-effect" failure where input handlers don't actually
// mutate gameplay state.

import { strict as assert } from 'node:assert';
import { pressUntil } from './_boot.mjs';

export default async function mumSenkronu(page) {
  const overlayHiddenAtBoot = await page
    .locator('#overlay')
    .evaluate((el) => el.classList.contains('overlay--hidden'));
  assert.equal(overlayHiddenAtBoot, false, 'cold boot overlay should be visible');

  await page.locator('body').focus();
  // The keydown listener attaches only after the code-split module import
  // resolves, which can be after the harness settle — a single early Space
  // would be lost. Space is a no-op while state==='playing', so retrying is
  // safe; the loop exits as soon as the overlay hides.
  const started = await pressUntil(
    page,
    'Space',
    () => document.querySelector('#overlay')?.classList.contains('overlay--hidden') ?? false,
  );
  assert.equal(started, true, 'overlay should hide after Space');

  // Spam-light all candles quickly so they all clear the threshold simultaneously,
  // then wait long enough (>800ms hold) for the sync bar to fill.
  for (let burst = 0; burst < 4; burst++) {
    for (const key of ['1', '2', '3', '4']) {
      await page.keyboard.press(key);
    }
    await page.waitForTimeout(150);
  }
  // One more burst right before the wait window so all candles are near 1.0.
  for (const key of ['1', '2', '3', '4']) {
    await page.keyboard.press(key);
  }
  await page.waitForTimeout(950);

  const after = await page.evaluate(() => ({
    score: document.querySelector('#score')?.textContent ?? '',
    level: document.querySelector('#level')?.textContent ?? '',
  }));
  // We don't require an exact score — RAF timing is jittery in CI — but the
  // sync window is ~800ms and we held ~950ms, so the player should have
  // scored at least once.
  assert.ok(
    Number(after.score) >= 1,
    `expected score >= 1 after sync hold, got "${after.score}" (level ${after.level})`,
  );
  assert.ok(
    Number(after.level) >= 2,
    `expected level >= 2 after first sync, got "${after.level}"`,
  );
}
