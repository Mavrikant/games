# Per-game smoke scenarios

`scripts/smoke-test.mjs` runs default checks (init crash, console
errors, blank render, screenshot) for every game.  When a game has a
specific invariant worth asserting in CI — usually because a regression
already happened once — you can add a per-game scenario here.

## File contract

- Name: `<slug>.mjs` exactly matching the JSON in `src/content/games/`
- Module: ES module
- Default export: `async function (page) { /* assertions */ }`
- Throw on failure (use `node:assert/strict`); the harness reports the
  message in the smoke output

The harness:

1. Navigates the mobile-viewport page to `/games/<slug>/`
2. Waits `SETTLE_MS` (≈600 ms) so `defineGame()`'s queueMicrotask init runs
3. Runs default checks
4. **Then** loads `<slug>.mjs` if present and invokes its default export
5. Takes a screenshot

The scenario sees the game in its first-frame post-init state.  No user
input has happened yet (no clicks, no key presses).

## When to write one

Yes:

- A specific regression class is hard to catch by "no console errors"
  alone — e.g. a geometric off-by-one that produces a wonky render but
  no exception (`vardiya.mjs` was added because PR #62 was exactly
  that).
- An invariant that's cheap to assert and signals "core init is healthy"
  (e.g. `2048.mjs` asserts the fresh-board 2-tile spawn).

No:

- Anything that needs user input or async simulation — that belongs in
  `docs/PLAYTEST.md` (manual) or a dedicated headless harness later.
- Pixel-perfect visual regression — the screenshots are debugging
  artifacts, not diffed.

## Pattern

```js
import { strict as assert } from 'node:assert';

export default async function myGame(page) {
  // Page state is the first paint after init().  Query DOM,
  // computed styles, or window globals; assert structural invariants.
  const got = await page.locator('#some-id').evaluate((el) => ({
    childCount: el.children.length,
    cssVar: getComputedStyle(el).getPropertyValue('--my-var').trim(),
  }));

  assert.equal(got.childCount, 7, 'expected 7 children');
  assert.equal(got.cssVar, '5', '--my-var should be 5');
}
```

Use `page.locator(sel).evaluate(...)` (or `page.evaluate(...)`) to run
code in the page context — Node-side `assert` then validates the
returned value.  Don't `import` browser-side modules; serialise the
state and assert in Node.

## Examples

- `vardiya.mjs` — grid track count + total cell count (catches the
  `--vd-cols = days + 1` off-by-one class).
- `2048.mjs` — fresh-board invariant: exactly 2 tiles, score `0`.
