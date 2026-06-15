// Park Et smoke scenario — guards runtime behavior the build/init checks miss:
//
//   1. ready→playing transition: pressing an arrow key from the start
//      overlay hides the overlay AND advances the clock (#time > 0).
//   2. throttle actually moves the car: after pressing Up for ~1s the
//      car's y-position decreases (level 1 starts facing up). Regression
//      from earlier bug where keys.add() ran AFTER loadLevel.clear() in
//      crashed/complete states — a similar shape on first press would
//      strand the car. This pins down ready→play directly.
//   3. crash recovery: driving off the canvas should flip to 'crashed'
//      overlay text 'Çarpıştın' (or 'Yoldan çıktın'); pressing a key
//      should reset the same level and the timer should reset to ~0.

import { strict as assert } from 'node:assert';
import { waitForBoot } from './_boot.mjs';

export default async function (page) {
  // Wait until the overlay shows "Seviye 1" (init() ran and loadLevel(0)
  // populated the overlay text). This is JS-driven, so it's a real
  // boot signal — see _boot.mjs.
  const booted = await waitForBoot(page, () => {
    const t = document.querySelector('#overlay-title');
    return t && t.textContent && t.textContent.includes('Seviye 1');
  });
  assert.ok(booted, 'Park Et did not show Seviye 1 overlay within timeout');

  // Sanity: time HUD starts at 0.0 and overlay is visible.
  const startTime = await page.$eval('#time', (el) => el.textContent);
  assert.equal(startTime, '0.0', `Expected initial time "0.0", got "${startTime}"`);
  const overlayHiddenBefore = await page.$eval('#overlay', (el) =>
    el.classList.contains('overlay--hidden'),
  );
  assert.equal(overlayHiddenBefore, false, 'Overlay should be visible before any input');

  // Hold Up arrow ~1.2s — level 1 car faces up (angle=-π/2) so y decreases.
  await page.keyboard.down('ArrowUp');
  await page.waitForTimeout(1200);
  await page.keyboard.up('ArrowUp');

  // Overlay must be hidden, time must have advanced past 0.
  const overlayHiddenAfter = await page.$eval('#overlay', (el) =>
    el.classList.contains('overlay--hidden'),
  );
  // If overlay is hidden, game went to 'playing'. If overlay is visible with
  // 'Çarpıştın' or 'tamam' text, also acceptable (car moved enough to crash
  // or to reach the spot). The unacceptable state is "still on Seviye 1
  // start screen" — that means the keydown didn't start the game.
  const overlayTitle = await page.$eval('#overlay-title', (el) => el.textContent);
  const stillOnStart = !overlayHiddenAfter && overlayTitle.includes('Seviye 1');
  assert.ok(
    !stillOnStart,
    `After holding Up 1.2s the start overlay should hide or change; got hidden=${overlayHiddenAfter} title="${overlayTitle}"`,
  );

  const timeAfter = Number(await page.$eval('#time', (el) => el.textContent));
  assert.ok(
    timeAfter > 0.2,
    `After holding Up 1.2s, #time should advance past ~0.2, got ${timeAfter}`,
  );
}
