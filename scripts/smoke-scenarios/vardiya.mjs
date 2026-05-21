// Vardiya custom scenario — catches the grid-shift regression class (PR #62).
//
// The bug was: --vd-cols set to `days + 1`, which combined with the CSS
// `grid-template-columns: 68px repeat(var(--vd-cols), 1fr)` produced
// `days + 2` columns. Auto-flow then placed shift labels into wrong rows.
//
// To detect this without coupling to internal classes, we assert structural
// invariants: header row should be exactly (days + 1) elements (corner +
// day headers), and each shift-label cell should appear on its own row.

import { strict as assert } from 'node:assert';

export default async function vardiya(page) {
  // Grid renders synchronously inside init() — already painted after the
  // 600ms settle the smoke harness gives us.
  const grid = await page.locator('#grid').evaluate((el) => {
    const cols = getComputedStyle(el).getPropertyValue('--vd-cols').trim();
    const children = el.children.length;
    // gridTemplateColumns resolves to the computed pixel string; we use it
    // only to count how many columns the layout actually has.
    const tracks = getComputedStyle(el).gridTemplateColumns.trim().split(/\s+/);
    return { cols, children, trackCount: tracks.length };
  });

  // Default level 1 = 3 days. Grid = (1 corner + 3 day headers + 2 shifts × (1 label + 3 cells))
  //                              = 4 + 2 × 4 = 12 elements
  // Track count should be 4 (corner + 3 day columns).
  assert.equal(grid.cols, '3', `--vd-cols should be 3 (level 1 days), got ${grid.cols}`);
  assert.equal(
    grid.trackCount,
    4,
    `grid should have 4 columns (corner + 3 days), got ${grid.trackCount}`,
  );
  // 4 header + 2 shifts × 4 cells = 12 grid children
  assert.equal(
    grid.children,
    12,
    `level 1 grid should have 12 elements (1 corner + 3 day headers + 8 shift cells), got ${grid.children}`,
  );
}
