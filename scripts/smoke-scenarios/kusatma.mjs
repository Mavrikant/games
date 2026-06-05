// Kuşatma custom scenario — asserts the start gate and the ammo economy wire
// up, the two things a headless init check can't see:
//   1. The intro overlay is reachable AND dismissable (pitfall:
//      unreachable-start-state / missing-overlay-css). Başla must move the
//      game from `intro` to `aiming` and actually hide the overlay.
//   2. Firing consumes exactly one boulder (pitfall:
//      hud-counter-synced-only-at-lifecycle-edges). The HUD ammo counter must
//      update the instant a shot is launched, not only at level boundaries.
//
// Everything asserted here is deterministic (no dependence on where the
// boulder lands), so the test stays stable across runs.

import { strict as assert } from 'node:assert';

export default async function kusatma(page) {
  const overlay = page.locator('#overlay');

  // Intro overlay is shown on cold boot.
  const introAria = await overlay.getAttribute('aria-hidden');
  assert.equal(introAria, 'false', `intro overlay should be visible, aria-hidden=${introAria}`);

  const ammoStart = (await page.locator('#ammo').textContent())?.trim();
  assert.equal(ammoStart, '4', `level 1 should start with 4 ammo, got ${ammoStart}`);

  // Başla dismisses the overlay and enters the aiming state.
  await page.locator('#overlay-btn').click();
  const dismissedAria = await overlay.getAttribute('aria-hidden');
  assert.equal(dismissedAria, 'true', `overlay should hide after Başla, aria-hidden=${dismissedAria}`);

  // Wait out the 0.18s opacity transition, then confirm it's visually gone.
  await page.waitForTimeout(280);
  const dismissedOpacity = await overlay.evaluate((el) => getComputedStyle(el).opacity);
  assert.equal(dismissedOpacity, '0', `overlay opacity should reach 0 after hide, got ${dismissedOpacity}`);

  // Firing (Space) launches a boulder and spends exactly one ammo.
  await page.keyboard.press('Space');
  await page.waitForTimeout(120);
  const ammoAfter = (await page.locator('#ammo').textContent())?.trim();
  assert.equal(ammoAfter, '3', `firing should consume one ammo (4 to 3), got ${ammoAfter}`);
}
