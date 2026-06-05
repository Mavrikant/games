// Erime Arena: verify the start flow and guard the "typing starts the game"
// regression. Deterministic checks only (no exact mass/eat assertions — the
// sim is stochastic).
export default async function (page) {
  // Regression guard: typing WASD letters into the name field must NOT start
  // the game (the keydown handler must ignore keys while an input is focused).
  await page.click('#name');
  await page.type('#name', 'wasd', { delay: 10 });
  const startedWhileTyping = await page.evaluate(() => {
    const o = document.querySelector('#overlay');
    return o ? o.classList.contains('overlay--hidden') : true;
  });
  if (startedWhileTyping) {
    throw new Error('typing in the name field should not start the game');
  }

  // Pressing Start enters the playing state (overlay hides).
  await page.click('#start');
  await page.waitForTimeout(300);
  const hidden = await page.evaluate(() => {
    const o = document.querySelector('#overlay');
    return o ? o.classList.contains('overlay--hidden') : false;
  });
  if (!hidden) throw new Error('overlay should hide after pressing Start');

  // HUD mass should be a finite positive number that keeps rendering.
  const mass = await page.evaluate(() => {
    const el = document.querySelector('#mass');
    return el ? Number(el.textContent) : NaN;
  });
  if (!Number.isFinite(mass) || mass <= 0) {
    throw new Error(`mass HUD should be a positive number, got ${mass}`);
  }
}
