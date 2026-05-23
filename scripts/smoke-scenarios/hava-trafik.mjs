// Hava Trafik smoke scenario — guards two runtime fixes that build/curl miss:
//
//  1. live-landed-count: the "İnen" counter (#score) must increment WHILE
//     playing, the instant a plane lands — not only on the game-over screen.
//     Regression: score was mutated in update() but #score.textContent was
//     only written in startGame/endGame/reset, so the HUD sat at 0 all game.
//
//  2. lost-plane-ends-game: a plane that flies off the screen must END the
//     run ("Uçak kayboldu!"). Regression: off-screen planes were filtered out
//     "silently, no penalty", so the only way to lose was a mid-air collision.
//
// Determinism: we install a manual requestAnimationFrame pump + Math.random=0
// via addInitScript and reload, so the sim advances only when we pump and
// spawns are reproducible. With random=0 exactly ONE plane spawns at logical
// (86.4, 0) as colour 0, whose matching gate is the TOP gate at (240, 0).

import { strict as assert } from 'node:assert';

const INIT = `(() => {
  let t = 0;
  const cbs = [];
  window.requestAnimationFrame = (cb) => { cbs.push(cb); return cbs.length; };
  window.cancelAnimationFrame = () => {};
  window.__pump = (frames, dtMs) => {
    for (let i = 0; i < frames; i++) {
      t += dtMs;
      for (const cb of cbs.splice(0)) cb(t);
    }
  };
  Math.random = () => 0;
  // Synthetic PointerEvents have no real captured pointer id.
  Element.prototype.setPointerCapture = function () {};
  Element.prototype.releasePointerCapture = function () {};
  Element.prototype.hasPointerCapture = function () { return false; };
})();`;

// Reload under the deterministic harness and wait until init()->reset()->draw()
// has painted the radar background — the game module loads via a code-split
// import that can resolve after `load`, so listeners may not be attached yet.
// rAF is manual here, so poll on a timer rather than the default 'raf'.
async function bootDeterministic(page) {
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(
    () => {
      const c = document.querySelector('#board');
      if (!c) return false;
      const d = c.getContext('2d').getImageData(2, 2, 1, 1).data;
      return d[3] > 0 && d[0] + d[1] + d[2] > 0;
    },
    null,
    { polling: 50, timeout: 8000 },
  );
}

export default async function havaTrafik(page) {
  await page.addInitScript(INIT);

  // --- Fix 1: landed count updates live while still playing ---
  await bootDeterministic(page);
  const landed = await page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const canvas = q('#board');
    const rect = canvas.getBoundingClientRect();
    const fire = (type, lx, ly) =>
      canvas.dispatchEvent(
        new PointerEvent(type, {
          clientX: rect.left + (lx / 480) * rect.width,
          clientY: rect.top + (ly / 480) * rect.height,
          pointerId: 1,
          bubbles: true,
          cancelable: true,
        }),
      );
    q('#restart').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const startScore = q('#score').textContent;
    // Route the lone plane (at ~86,0) to its matching gate at (240,0).
    fire('pointerdown', 86.4, 6);
    fire('pointermove', 140, 0);
    fire('pointermove', 190, 0);
    fire('pointermove', 240, 0);
    fire('pointerup', 240, 0);
    window.__pump(55, 50); // 2.75s < 3.4s spawn cadence => still one plane
    return {
      startScore,
      score: q('#score').textContent,
      // While playing, the overlay carries the .overlay--hidden class.
      playing: q('#overlay').classList.contains('overlay--hidden'),
    };
  });
  assert.equal(landed.startScore, '0', `score should boot at 0, got "${landed.startScore}"`);
  assert.equal(landed.playing, true, 'a landing must NOT end the game (overlay stays hidden)');
  assert.equal(
    landed.score,
    '1',
    `landed count must update live to "1" on landing, got "${landed.score}"`,
  );

  // --- Fix 2: a plane leaving the airspace ends the game ---
  await bootDeterministic(page);
  const lost = await page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    q('#restart').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    // Do NOT route it: the lone plane flies straight across and exits ~9.2s.
    window.__pump(220, 50); // 11s
    return {
      overlayShown: !q('#overlay').classList.contains('overlay--hidden'),
      title: q('#overlay-title').textContent,
    };
  });
  assert.equal(lost.overlayShown, true, 'an off-screen plane must end the game (overlay shown)');
  assert.equal(
    lost.title,
    'Uçak kayboldu!',
    `lost screen title should be "Uçak kayboldu!", got "${lost.title}"`,
  );
}
