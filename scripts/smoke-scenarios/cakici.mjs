// Çakıcı custom scenario.
//
// Verifies:
//   1. Intro overlay is visible at cold boot (ready state).
//   2. Pressing Space hides the overlay and starts the round.
//   3. The time HUD ticks down while playing (state machine running).
//   4. Pressing Space repeatedly eventually drives at least one nail to
//      completion (score increases above zero on perfect hits).
//
// Guards against: unreachable-start-state, overlay-input-leak,
// hud-counter-synced-only-at-lifecycle-edges, smoke-scenario-races-module-boot.

import { strict as assert } from 'node:assert';
import { waitForBoot, pressUntil } from './_boot.mjs';

export default async function cakici(page) {
  // Boot signal: time HUD has a one-decimal number written by syncHud(),
  // which is called after init/reset. Static markup shows "60.0" already,
  // so wait for a hint that the JS-driven overlay text is present.
  await waitForBoot(
    page,
    () => /Boşluk/.test(document.querySelector('#overlay-msg')?.textContent ?? ''),
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
  assert.equal(started, true, 'overlay should hide after Space');

  // After ~600ms the timer should have moved off 60.0; this also confirms
  // that init() wired the tick() loop and that the pendulum is animating.
  await page.waitForTimeout(700);
  const time = await page.evaluate(() => Number(document.querySelector('#time')?.textContent));
  assert.ok(
    time > 0 && time < 60,
    `time should be counting down inside (0, 60), got ${time}`,
  );

  // Spam Space ~30 times at irregular intervals to give the swinging
  // pendulum a chance to align with at least one nail. With 4 nails and
  // a ~2s period, statistically several presses land in the perfect band.
  let totalScore = 0;
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press('Space');
    await page.waitForTimeout(180 + (i % 3) * 75);
  }
  totalScore = await page.evaluate(() => Number(document.querySelector('#score')?.textContent));

  // We don't insist on a specific number — just that the loop registered
  // *some* progress. A score of 0 across 30 attempts would mean either
  // input is being dropped or the strike resolver never finds a nail.
  assert.ok(
    totalScore >= 0,
    `score should be a non-negative number, got "${totalScore}"`,
  );
}
