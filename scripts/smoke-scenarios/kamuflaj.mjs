// Kamuflaj: verify boot, the typing guard, and that a bot match actually
// starts and advances through its phases. DOM-signal assertions only — the
// simulation runs even when headless chromium has no usable WebGL (the 3D
// scene degrades silently).
import { waitForBoot } from './_boot.mjs';

export default async function (page) {
  // Boot signal: init() rewrites #status from the static "Çevrimdışı" to a
  // "·"-containing variant once the module is live.
  await waitForBoot(
    page,
    () => (document.querySelector('#status')?.textContent ?? '').includes('·'),
  );

  // Regression guard: typing WASD into the name field must NOT start a match.
  await page.click('#name');
  await page.type('#name', 'wasd', { delay: 10 });
  const startedWhileTyping = await page.evaluate(() => {
    const o = document.querySelector('#overlay');
    return o ? o.classList.contains('overlay--hidden') : true;
  });
  if (startedWhileTyping) {
    throw new Error('typing in the name field should not start the game');
  }

  // Start a bot match; the countdown begins immediately and hides the overlay.
  await page.click('#bots');
  const hidden = await waitForBoot(
    page,
    () => document.querySelector('#overlay')?.classList.contains('overlay--hidden') ?? false,
    8000,
  );
  if (!hidden) throw new Error('overlay should hide once the match starts');

  // The phase must advance off the 3 s countdown into "Hazırlık" (prep), which
  // proves the fixed-step simulation is actually running and the phase clock
  // transitions. rAF can be throttled under CI load, so poll rather than
  // sampling once.
  const reachedPrep = await waitForBoot(
    page,
    () => {
      const p = document.querySelector('#phase')?.textContent ?? '';
      return p === 'Hazırlık' || p === 'Avlanma';
    },
    9000,
  );
  if (!reachedPrep) {
    const phase = await page.evaluate(() => document.querySelector('#phase')?.textContent ?? '');
    throw new Error(`match should advance into the prep phase, got "${phase}"`);
  }
}
