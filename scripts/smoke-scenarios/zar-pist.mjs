// Zar Pist — verify the die tumble + target match + level advance loop.
//
// Level 1 is a 1×3 corridor: start at (0,0) top=1, target at (2,0) value=6.
// Two right-arrow presses tumble the die through (1,0)→top=4, (2,0)→top=6,
// matching the target and winning the level. This validates:
//   - keydown listener attached after async module import
//   - tumble math (east-roll: newTop = 7 - oldEast) for two consecutive rolls
//   - target match closes the level and shows the overlay
//   - HUD shows level "1/8" before the first move (boot wrote it)
//
// Without this, a regression in the tumble rules (e.g. swapping east/north
// math) or the overlay would still pass the default "page renders" smoke,
// because the canvas keeps painting either way.

import { strict as assert } from 'node:assert';
import { waitForBoot, pressUntil } from './_boot.mjs';

export default async function zarPist(page) {
  // Boot signal: init() writes "1/8" into #zp-level on level load.
  await waitForBoot(page, () => document.querySelector('#zp-level')?.textContent === '1/8');

  const before = await page.evaluate(() => ({
    level: document.querySelector('#zp-level')?.textContent ?? '',
    moves: document.querySelector('#zp-moves')?.textContent ?? '',
    overlayHidden: document
      .querySelector('#overlay')
      ?.classList.contains('overlay--hidden') ?? null,
  }));
  assert.equal(before.level, '1/8', `boot level should be 1/8, got "${before.level}"`);
  assert.equal(before.moves, '0', `boot moves should be 0, got "${before.moves}"`);
  assert.equal(before.overlayHidden, true, 'overlay should start hidden after init');

  // pressUntil guards against the listener-not-yet-attached race
  // (PITFALLS#smoke-scenario-races-module-boot variant).
  const advanced = await pressUntil(
    page,
    'ArrowRight',
    () => document.querySelector('#zp-moves')?.textContent !== '0',
    { attempts: 12, interval: 100 },
  );
  assert.ok(advanced, 'right arrow should register and move the die');

  // One more right roll → lands on target with top=6, level completes,
  // overlay opens.
  await page.keyboard.press('ArrowRight');
  await waitForBoot(
    page,
    () =>
      document.querySelector('#overlay')?.classList.contains('overlay--hidden') === false,
    3000,
  );

  const afterWin = await page.evaluate(() => ({
    overlayHidden: document
      .querySelector('#overlay')
      ?.classList.contains('overlay--hidden') ?? null,
    title: document.querySelector('#overlay-title')?.textContent ?? '',
  }));
  assert.equal(afterWin.overlayHidden, false, 'overlay should be visible after level 1 win');
  assert.match(
    afterWin.title,
    /Bölüm 1 tamam/,
    `overlay title should announce level 1 done, got "${afterWin.title}"`,
  );

  // Enter advances to level 2.
  await page.keyboard.press('Enter');
  await waitForBoot(page, () => document.querySelector('#zp-level')?.textContent === '2/8');

  const lv2 = await page.evaluate(() => ({
    level: document.querySelector('#zp-level')?.textContent ?? '',
    moves: document.querySelector('#zp-moves')?.textContent ?? '',
    overlayHidden: document
      .querySelector('#overlay')
      ?.classList.contains('overlay--hidden') ?? null,
  }));
  assert.equal(lv2.level, '2/8', `should advance to level 2/8, got "${lv2.level}"`);
  assert.equal(lv2.moves, '0', `moves should reset on level 2, got "${lv2.moves}"`);
  assert.equal(lv2.overlayHidden, true, 'overlay should hide on level 2 load');
}
