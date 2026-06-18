// AeroKanca: verify boot, the typing guard, and that a bot match actually
// starts and simulates. DOM-signal assertions only — the sim runs even when
// headless chromium has no usable WebGL (scene degrades silently).
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

  // Start a bot match; the 3 s countdown must end with the overlay hidden.
  // Under CI load headless Chromium throttles rAF, and the entry's
  // FRAME_DT_CLAMP makes the countdown advance in (sim) slow motion when
  // frames are starved — so the wall-clock wait must be generous (the 8 s
  // budget reliably timed out on the mobile viewport).
  await page.click('#bots');
  const hidden = await waitForBoot(
    page,
    () => document.querySelector('#overlay')?.classList.contains('overlay--hidden') ?? false,
    16000,
  );
  if (!hidden) throw new Error('overlay should hide after the countdown');

  // The match clock must tick down from 2:00 (proves the sim advances).
  // Under CI load (many concurrent pages) headless Chromium throttles rAF, so
  // the clock may not have moved off "2:00" at any single fixed instant — a
  // one-shot sample after a fixed wait races the throttle and flakes. Poll for
  // the tick instead; a frame firing any time within the window proves the sim.
  const ticked = await waitForBoot(
    page,
    () => {
      const t = document.querySelector('#time')?.textContent ?? '';
      return t !== '' && t !== '2:00';
    },
    16000,
  );
  if (!ticked) {
    const time = await page.evaluate(() => document.querySelector('#time')?.textContent ?? '');
    throw new Error(`match timer should be counting down, got "${time}"`);
  }
}
