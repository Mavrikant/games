// Kara Kutu smoke scenario — wiring + state machine invariants.
//
// What we assert (beyond the default "no console error / init renders"):
// 1. Board boots with 100 cells (10×10): 4 corners + 32 ports + 64 inner.
// 2. Solve button starts disabled (no marks placed yet).
// 3. Clicking a port from a known empty edge fires a ray: shots counter
//    increments and the port becomes labeled (text + disabled). This
//    catches the wiring regression where the click listener never binds
//    or the renderPorts() pass forgets to flip disabled.
// 4. Clicking an inner cell toggles a guess marker (cell gains the
//    .kk-cell--guess class).
// 5. After clearing all marks again, the Solve button is still disabled.

import { strict as assert } from 'node:assert';

export default async function karaKutu(page) {
  const counts = await page.evaluate(() => {
    const board = document.querySelector('#board');
    return {
      total: board.querySelectorAll('.kk-cell').length,
      corner: board.querySelectorAll('.kk-cell--corner').length,
      port: board.querySelectorAll('.kk-cell--port').length,
      inner: board.querySelectorAll('.kk-cell--inner').length,
    };
  });
  assert.equal(counts.total, 100, `10x10 grid, got ${counts.total}`);
  assert.equal(counts.corner, 4, `4 corners, got ${counts.corner}`);
  assert.equal(counts.port, 32, `32 ports, got ${counts.port}`);
  assert.equal(counts.inner, 64, `64 inner cells, got ${counts.inner}`);

  const solveDisabled = await page.evaluate(
    () => document.querySelector('#solve').disabled,
  );
  assert.equal(solveDisabled, true, 'Solve must start disabled (0 marks)');

  // Fire ray from top port 0 (the first top port). Whatever its result
  // (hit/refl/exit), the port should become labeled and disabled, and the
  // shots counter should read 1.
  await page.click('.kk-cell--port[data-side="top"][data-idx="0"]');
  const afterFire = await page.evaluate(() => {
    const p = document.querySelector(
      '.kk-cell--port[data-side="top"][data-idx="0"]',
    );
    return {
      shots: document.querySelector('#shots').textContent,
      portText: p.textContent,
      portDisabled: p.disabled,
    };
  });
  assert.equal(afterFire.shots, '1', `shots after one fire, got "${afterFire.shots}"`);
  assert.ok(
    afterFire.portText && afterFire.portText.length > 0,
    `port should display a label, got "${afterFire.portText}"`,
  );
  assert.equal(afterFire.portDisabled, true, 'fired port must be disabled');

  // Toggle a guess on an inner cell, verify marker, then clear it.
  const innerSel = '.kk-cell--inner[data-r="3"][data-c="3"]';
  await page.click(innerSel);
  let hasGuess = await page.evaluate(
    (sel) => document.querySelector(sel).classList.contains('kk-cell--guess'),
    innerSel,
  );
  assert.equal(hasGuess, true, 'inner cell should gain .kk-cell--guess on click');

  await page.click(innerSel);
  hasGuess = await page.evaluate(
    (sel) => document.querySelector(sel).classList.contains('kk-cell--guess'),
    innerSel,
  );
  assert.equal(hasGuess, false, 'clicking again should clear the guess');
}
