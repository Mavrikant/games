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
  await page.click('#bots');
  const hidden = await waitForBoot(
    page,
    () => document.querySelector('#overlay')?.classList.contains('overlay--hidden') ?? false,
    8000,
  );
  if (!hidden) throw new Error('overlay should hide after the countdown');

  // The match clock must tick down from 2:00 (proves the sim advances).
  await page.waitForTimeout(1500);
  const time = await page.evaluate(() => document.querySelector('#time')?.textContent ?? '');
  if (!time || time === '2:00') {
    throw new Error(`match timer should be counting down, got "${time}"`);
  }
}
