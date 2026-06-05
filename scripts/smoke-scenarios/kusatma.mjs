// Kuşatma custom scenario — asserts the new boot/flow wiring deterministically
// (no dependence on where a boulder lands):
//   1. Intro overlay is reachable on cold boot and dismissable (pitfall:
//      unreachable-start-state / missing-overlay-css).
//   2. Firing consumes exactly one round of the active ammo type — the HUD
//      chip updates instantly (pitfall: hud-counter-synced-only-at-lifecycle-edges).
//   3. The level-select map renders all 60 cells with level 1 unlocked.

import { strict as assert } from 'node:assert';

export default async function kusatma(page) {
  const intro = page.locator('#intro');
  assert.equal(await intro.getAttribute('aria-hidden'), 'false', 'intro overlay should show on boot');

  await page.locator('#intro-start').click();
  assert.equal(await intro.getAttribute('aria-hidden'), 'true', 'intro should hide after start');

  // Move focus to the canvas without firing (a tap doesn't launch).
  await page.locator('#board').click({ position: { x: 60, y: 60 } });

  const chip = page.locator('.ammo-chip__count').first();
  const before = Number((await chip.textContent())?.trim());
  assert.ok(Number.isFinite(before) && before > 0, `level 1 should start with ammo, got ${before}`);

  await page.keyboard.press('Space');
  await page.waitForTimeout(140);
  const after = Number((await chip.textContent())?.trim());
  assert.equal(after, before - 1, `firing should consume one round (${before} to ${after})`);

  // Map renders all 60 levels, level 1 unlocked.
  await page.locator('#map-btn').click();
  assert.equal(await page.locator('#map').getAttribute('aria-hidden'), 'false', 'map should open');
  const cards = await page.locator('#map-grid .level-card').count();
  assert.equal(cards, 60, `map should render 60 levels, got ${cards}`);
  const firstLocked = await page.locator('#map-grid .level-card').first().getAttribute('class');
  assert.ok(!/level-card--locked/.test(firstLocked ?? ''), 'level 1 should be unlocked');
}
