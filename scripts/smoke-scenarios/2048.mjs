// 2048 custom scenario — catches the cold-boot tile-count regression.
//
// Classic 2048 starts with exactly 2 tiles on a fresh board. If init()
// crashes mid-setup or spawnRandom() is mis-ordered, you can boot with
// 0 or 1 tile. The smoke harness gives us 600ms of settle; by then
// reset() has spawned the initial pair.
//
// We also assert that the score HUD is 0 (board didn't fast-forward).
// The game does keep state in localStorage; loadState fires when a
// saved game exists. In CI the storage is empty by default so we
// always hit reset() and the 2-tile invariant holds.

import { strict as assert } from 'node:assert';
import { waitForBoot } from './_boot.mjs';

export default async function twentyFortyEight(page) {
  // The game module is a code-split import; #tiles stays empty until init()
  // has run. Poll for the first spawned tile before asserting the pair.
  await waitForBoot(page, () => (document.querySelector('#tiles')?.children.length ?? 0) > 0);

  const state = await page.locator('#tiles').evaluate((el) => ({
    tileCount: el.children.length,
    scoreText: document.querySelector('#score')?.textContent ?? '',
  }));

  assert.equal(
    state.tileCount,
    2,
    `fresh 2048 boot should have exactly 2 tiles, got ${state.tileCount}`,
  );
  assert.equal(
    state.scoreText,
    '0',
    `fresh 2048 boot score should be 0, got "${state.scoreText}"`,
  );
}
