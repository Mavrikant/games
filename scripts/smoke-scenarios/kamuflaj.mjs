// Kamuflaj is online-only multiplayer, so whether a match can start here depends
// on the realtime backend being configured at build time (the smoke env usually
// has none). We therefore assert only the universally-true facts: the module
// boots, and the menu overlay renders and stays up (no match auto-starts). The
// full match loop is validated by the deterministic world.ts simulation.
import { waitForBoot } from './_boot.mjs';

export default async function (page) {
  // Boot signal: init() rewrites #status from the static "Çevrimdışı" to a
  // "·"-containing variant once the module is live.
  await waitForBoot(
    page,
    () => (document.querySelector('#status')?.textContent ?? '').includes('·'),
  );

  // The menu overlay must be visible on boot (nothing should auto-start).
  const overlayVisible = await page.evaluate(
    () => !(document.querySelector('#overlay')?.classList.contains('overlay--hidden') ?? true),
  );
  if (!overlayVisible) throw new Error('menu overlay should be visible on boot');

  const title = await page.evaluate(
    () => document.querySelector('#overlay-title')?.textContent ?? '',
  );
  if (title.trim() === '') throw new Error('menu overlay should show a title');
}
