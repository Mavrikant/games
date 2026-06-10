// Shared boot helpers for smoke scenarios.
//
// Game modules load via a code-split dynamic import that can resolve AFTER
// the page 'load' event, so the harness's fixed settle delay is not a boot
// guarantee — under CI load (many concurrent pages) init() can run hundreds
// of milliseconds later. Scenarios that snapshot first-frame state must
// poll for a JS-driven boot signal first, or their asserts race init() and
// fail flakily (seen with 2048 / kusatma / tek-cizgi on dual-viewport runs).
//
// The underscore prefix keeps this file out of the harness's per-slug
// scenario lookup (it only imports `<slug>.mjs` for existing games).

/**
 * Poll `predicate` inside the page until truthy. On timeout it returns
 * false instead of throwing, so the scenario's own asserts still run and
 * produce their descriptive diagnostics.
 */
export async function waitForBoot(page, predicate, timeout = 8000) {
  try {
    await page.waitForFunction(predicate, null, { timeout, polling: 100 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Press `key` repeatedly until `predicate` is truthy in the page. Used when
 * the boot signal itself is "the key listener responds" — the keydown
 * listener may not be attached yet while the module is still loading, so a
 * single early press would be silently lost.
 */
export async function pressUntil(page, key, predicate, { attempts = 30, interval = 150 } = {}) {
  for (let i = 0; i < attempts; i++) {
    await page.keyboard.press(key);
    await page.waitForTimeout(interval);
    if (await page.evaluate(predicate)) return true;
  }
  return false;
}
