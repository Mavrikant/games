// Erime Arena: verify the start flow works and the run is interactive.
// Deterministic checks only (no exact mass/eat assertions — the sim is
// stochastic): pressing Start hides the overlay and enters the playing state.
export default async function (page) {
  await page.click('#start');
  await page.waitForTimeout(300);
  const hidden = await page.evaluate(() => {
    const o = document.querySelector('#overlay');
    return o ? o.classList.contains('overlay--hidden') : false;
  });
  if (!hidden) throw new Error('overlay should hide after pressing Start');

  // HUD mass should be a finite number that keeps rendering each frame.
  const mass = await page.evaluate(() => {
    const el = document.querySelector('#mass');
    return el ? Number(el.textContent) : NaN;
  });
  if (!Number.isFinite(mass) || mass <= 0) {
    throw new Error(`mass HUD should be a positive number, got ${mass}`);
  }
}
