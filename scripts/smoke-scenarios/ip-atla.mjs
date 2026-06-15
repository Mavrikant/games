// İp Atla scenario — verify the ready overlay is visible on boot and that
// clicking Start hides it and begins gameplay. Catches the class of
// "overlay never hides" / "click handler not bound" regressions.

import { strict as assert } from 'node:assert';
import { waitForBoot } from './_boot.mjs';

export default async function ipAtla(page) {
  await waitForBoot(page, () => {
    const ov = document.querySelector('#overlay');
    return ov !== null && !ov.classList.contains('overlay--hidden');
  });

  const before = await page.evaluate(() => ({
    overlayHidden: document.querySelector('#overlay')?.classList.contains('overlay--hidden'),
    score: document.querySelector('#score')?.textContent ?? '',
  }));
  assert.equal(before.overlayHidden, false, 'ready overlay should be visible on boot');
  assert.equal(before.score, '0', `fresh score should be "0", got "${before.score}"`);

  await page.click('#overlay-btn');
  await page.waitForFunction(
    () => document.querySelector('#overlay')?.classList.contains('overlay--hidden'),
    null,
    { timeout: 2000 },
  );

  const after = await page.evaluate(() => ({
    overlayHidden: document.querySelector('#overlay')?.classList.contains('overlay--hidden'),
  }));
  assert.equal(after.overlayHidden, true, 'overlay should hide after pressing Start');
}
