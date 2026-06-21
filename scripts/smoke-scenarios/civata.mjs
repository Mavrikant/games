// Civata smoke scenario — first-frame invariants + start transition.
//
// What we assert:
// 1. HUD boots with level 1, score 0 (per-life accumulator from prior runs
//    must not leak — PITFALLS#invisible-boot).
// 2. Overlay is visible on first paint with the "Başla" button (ready state
//    has an explicit entry point — PITFALLS#unreachable-start-state).
// 3. Canvas is the standard 480×540 logical size.
// 4. Clicking #overlay-btn hides the overlay (start transition wired,
//    PITFALLS#missing-overlay-css would leave it visually present even
//    after class flip).

import { strict as assert } from 'node:assert';
import { waitForBoot } from './_boot.mjs';

export default async function civata(page) {
  await waitForBoot(
    page,
    () => document.querySelector('#level')?.textContent === '1',
  );

  const ready = await page.evaluate(() => ({
    level: document.querySelector('#level')?.textContent ?? '',
    score: document.querySelector('#score')?.textContent ?? '',
    overlayHidden: document
      .querySelector('#overlay')
      ?.classList.contains('overlay--hidden'),
    btnText: document.querySelector('#overlay-btn')?.textContent ?? '',
    canvasW: document.querySelector('#board')?.width,
    canvasH: document.querySelector('#board')?.height,
  }));

  assert.equal(ready.level, '1', `fresh civata boots on level 1, got "${ready.level}"`);
  assert.equal(ready.score, '0', `fresh score is 0, got "${ready.score}"`);
  assert.equal(
    ready.overlayHidden,
    false,
    'ready overlay must be visible on cold boot',
  );
  assert.equal(
    ready.btnText.trim(),
    'Başla',
    `overlay button must read "Başla" in ready state, got "${ready.btnText}"`,
  );
  assert.equal(ready.canvasW, 480, 'canvas logical width');
  assert.equal(ready.canvasH, 540, 'canvas logical height');

  await page.click('#overlay-btn');
  // Wait both for the class flip and for the visual transition to settle —
  // the CSS animates opacity over 180ms; snapshotting before that resolves
  // can race the transition (smoke-asserts-throttled-raf-one-shot kin).
  const hiddenAndFaded = await waitForBoot(
    page,
    () => {
      const el = document.querySelector('#overlay');
      if (!el) return false;
      if (!el.classList.contains('overlay--hidden')) return false;
      return parseFloat(getComputedStyle(el).opacity) < 0.1;
    },
    1500,
  );

  assert.ok(
    hiddenAndFaded,
    'overlay must both add .overlay--hidden and visually fade after Başla click — PITFALL missing-overlay-css',
  );
}
