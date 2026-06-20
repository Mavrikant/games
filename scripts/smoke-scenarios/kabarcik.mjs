// Kabarcık custom scenario.
//
// Verifies:
//   1. Intro overlay is visible at cold boot.
//   2. Pressing Space starts the game (overlay hides; target chip set).
//   3. Bubbles spawn (#board has rendered something) within a few seconds.
//   4. Required-color advancement loop works end-to-end: tapping inside the
//      canvas eventually pops a bubble — score grows OR a life drops — so
//      neither the pointer handler nor the state machine is dead.
//
// Guards: unreachable-start-state, overlay-input-leak, designed-lose-
// condition-not-wired, hud-counter-synced-only-at-lifecycle-edges,
// smoke-scenario-races-module-boot.

import { strict as assert } from 'node:assert';
import { waitForBoot, pressUntil } from './_boot.mjs';

export default async function kabarcik(page) {
  // Boot signal: init() writes the target chip's background colour to
  // something other than the CSS default (#aaa).
  await waitForBoot(page, () => {
    const chip = document.querySelector('#target-chip');
    if (!chip) return false;
    const bg = getComputedStyle(chip).backgroundColor;
    return bg && bg !== 'rgb(170, 170, 170)' && bg !== 'rgba(0, 0, 0, 0)';
  });

  const overlayHiddenAtBoot = await page
    .locator('#overlay')
    .evaluate((el) => el.classList.contains('overlay--hidden'));
  assert.equal(overlayHiddenAtBoot, false, 'cold boot overlay should be visible');

  await page.locator('body').focus();
  const started = await pressUntil(
    page,
    'Space',
    () => document.querySelector('#overlay')?.classList.contains('overlay--hidden') ?? false,
  );
  assert.equal(started, true, 'overlay should hide after Space');

  // Give the loop a moment to settle, then sweep clicks across the lower
  // half of the canvas (bubbles spawn near the bottom and rise) — any
  // correct-colour bubble will advance the score; any incorrect one
  // decrements lives. Either reaction proves the state machine is alive.
  await page.waitForTimeout(600);

  const box = await page.locator('#board').boundingBox();
  assert.ok(box, '#board should be laid out');
  // Tap a dense grid in the lower 75% of the canvas to maximise the chance
  // of intersecting at least one bubble's hit-circle.
  for (let row = 0; row < 6; row++) {
    for (let col = 0; col < 6; col++) {
      const x = box.x + (box.width * (col + 1)) / 7;
      const y = box.y + box.height * (0.25 + row * 0.13);
      await page.mouse.click(x, y);
      await page.waitForTimeout(70);
    }
  }

  const after = await page.evaluate(() => ({
    score: Number(document.querySelector('#score')?.textContent ?? '0'),
    lives: Number(document.querySelector('#lives')?.textContent ?? '3'),
  }));

  const scored = after.score > 0;
  const lostLife = after.lives < 3;
  assert.ok(
    scored || lostLife,
    `expected score or lives to react to taps, got score=${after.score} lives=${after.lives}`,
  );
}
