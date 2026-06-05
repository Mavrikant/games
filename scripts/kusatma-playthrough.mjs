// Kuşatma headless playthrough / solvability harness (mirrors
// scripts/seker-esle-playthrough.mjs as precedent). Drives the REAL game via
// the read-only window.__KUSATMA__ hook against a running preview server.
//
//   1. validateAll() static invariants across all 60 levels.
//   2. Auto-plays a stratified sample (all 6 bosses + a spread) with a
//      ballistic auto-aimer; asserts each clears within its ammo budget.
//   3. Deep-branch checks: cluster split, fireball explosion + TNT chain,
//      forced game-over, map navigation.
//   4. Zero console.error / pageerror throughout.
//
// Usage: node scripts/kusatma-playthrough.mjs [all]   (default: sample)

import { chromium } from 'playwright';

const BASE = process.env.KS_URL ?? 'http://127.0.0.1:4321/games/kusatma/';
const P0X = 80, P0Y = 274, CASTLE_X = 372, BLOCK = 32, GROUND_Y = 340, G = 1000;

function grav(a) {
  return a === 'boulder' ? 1.12 : a === 'bolt' ? 0.62 : a === 'keg' ? 1.05 : 1;
}

function solve(dx, dy, g, sMin, sMax, aMin, aMax) {
  for (let a = aMin; a <= aMax; a += 0.04) {
    const c = Math.cos(a);
    const t = Math.tan(a);
    const rhs = dy - dx * t; // need >0 (projectile descends to point)
    if (rhs <= 0) continue;
    const v2 = (0.5 * g * dx * dx) / (c * c * rhs);
    if (v2 <= 0) continue;
    const v = Math.sqrt(v2);
    if (v >= sMin && v <= sMax) return { angle: a, power: (v - sMin) / (sMax - sMin) };
  }
  return { angle: Math.max(aMin, Math.min(aMax, -0.9)), power: 0.95 };
}

const getState = (page) =>
  page.evaluate(() => {
    const k = window.__KUSATMA__;
    const S = k.S;
    const e = k.ENGINES[S.engineId];
    const blocks = S.blocks.filter((b) => b.alive).map((b) => ({ col: b.col, row: b.row, kind: b.kind }));
    return {
      state: S.state,
      level: S.levelIndex,
      engineId: S.engineId,
      eng: { speedMin: e.speedMin, speedMax: e.speedMax, angleMin: e.angleMin, angleMax: e.angleMax },
      loadout: S.loadout.slice(),
      ammo: { ...S.ammoCounts },
      active: S.activeAmmo,
      targets: blocks.filter((b) => b.kind === 'target'),
      alive: blocks.length,
      blocks,
      hasIron: blocks.some((b) => b.kind === 'iron'),
      hasTnt: blocks.some((b) => b.kind === 'tnt'),
      proj: S.projectiles.length,
    };
  });

const startLevel = (page, id, engine) =>
  page.evaluate(([id, engine]) => window.__KUSATMA__.startLevel(id, engine || undefined), [id, engine]);

const applyShot = (page, a, p, am) =>
  page.evaluate(([a, p, am]) => {
    const k = window.__KUSATMA__;
    const S = k.S;
    S.aimAngle = a;
    S.power = p;
    if ((S.ammoCounts[am] || 0) > 0) S.activeAmmo = am;
    k.fire();
  }, [a, p, am]);

async function waitShot(page) {
  for (let i = 0; i < 60; i++) {
    const st = await getState(page);
    if (st.state !== 'firing' && st.state !== 'settling') return st;
    await page.waitForTimeout(80);
  }
  return getState(page);
}

function chooseShot(st) {
  const targets = [...st.targets].sort((a, b) => a.col - b.col || b.row - a.row);
  const t = targets[0] ?? { col: 5, row: 1 };
  const tx = CASTLE_X + t.col * BLOCK + BLOCK / 2;
  const ty = GROUND_Y - (t.row + 1) * BLOCK + BLOCK / 2;
  let am = st.ammo.stone > 0 ? 'stone' : st.loadout.find((a) => st.ammo[a] > 0) || 'stone';
  if (st.hasIron && st.ammo.boulder > 0) am = 'boulder';
  else if (st.hasTnt && st.ammo.fire > 0) am = 'fire';
  if ((st.ammo[am] || 0) <= 0) am = st.loadout.find((a) => st.ammo[a] > 0) || 'stone';
  const g = G * grav(am);
  const s = solve(tx - P0X, ty - P0Y, g, st.eng.speedMin, st.eng.speedMax, st.eng.angleMin, st.eng.angleMax);
  return { ...s, ammo: am };
}

async function playLevel(page, id) {
  await startLevel(page, id);
  let st = await getState(page);
  const budget = Object.values(st.ammo).reduce((a, b) => a + b, 0) + 1;
  for (let i = 0; i < budget; i++) {
    st = await getState(page);
    if (st.state === 'levelclear' || st.targets.length === 0) return { ok: true, shots: i };
    if (st.state === 'gameover') return { ok: false, shots: i, reason: 'gameover' };
    const shot = chooseShot(st);
    await applyShot(page, shot.angle, shot.power, shot.ammo);
    st = await waitShot(page);
    if (st.state === 'levelclear') return { ok: true, shots: i + 1 };
    if (st.state === 'gameover') return { ok: false, shots: i + 1, reason: 'gameover' };
  }
  st = await getState(page);
  return { ok: st.state === 'levelclear', shots: budget, reason: st.state };
}

async function main() {
  const all = process.argv.includes('all');
  const sample = all
    ? Array.from({ length: 60 }, (_, i) => i + 1)
    : [1, 2, 5, 10, 11, 15, 20, 21, 25, 30, 31, 35, 40, 41, 45, 50, 51, 55, 60];

  const errors = [];
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|net::ERR_/.test(m.text())) errors.push(`console.error: ${m.text()}`);
  });

  await page.goto(BASE, { waitUntil: 'load', timeout: 20000 });
  await page.waitForFunction(() => !!window.__KUSATMA__, { timeout: 10000 });

  // 1) static invariants
  const problems = await page.evaluate(() => window.__KUSATMA__.validateAll());
  if (problems.length) console.log('VALIDATE PROBLEMS:\n' + problems.join('\n'));
  else console.log('validateAll: OK (60 levels, invariants pass)');

  // 2) solvability sample
  const failures = [];
  for (const id of sample) {
    const r = await playLevel(page, id);
    console.log(`L${id}: ${r.ok ? 'CLEAR' : 'FAIL'} in ${r.shots} shots${r.reason ? ' (' + r.reason + ')' : ''}`);
    if (!r.ok) failures.push(id);
  }

  // 3) deep-branch checks
  const deep = [];
  // cluster split: level 14 (TwinTowers, world 1) carries cluster ammo
  await startLevel(page, 14);
  {
    const st = await getState(page);
    const shot = chooseShot(st);
    await applyShot(page, shot.angle, shot.power, 'cluster');
  }
  let sawSplit = false;
  for (let i = 0; i < 40; i++) {
    const n = await page.evaluate(() => window.__KUSATMA__.S.projectiles.filter((p) => p.active).length);
    if (n > 1) { sawSplit = true; break; }
    await page.waitForTimeout(40);
  }
  deep.push(`cluster split: ${sawSplit ? 'OK' : 'NOT SEEN'}`);
  if (!sawSplit) failures.push('cluster');

  // fireball explosion + TNT chain: find a Volcano-world level with a tnt
  // cluster and aim a fireball straight at it.
  let before = 0;
  let after = 0;
  let chainTested = false;
  for (const id of [44, 46, 48, 42, 45, 47, 49, 43, 50, 41]) {
    await startLevel(page, id);
    const st = await getState(page);
    const tnts = st.blocks.filter((b) => b.kind === 'tnt');
    if (tnts.length < 3) continue;
    before = st.alive;
    const t = tnts.sort((a, b) => a.col - b.col || b.row - a.row)[0];
    const tx = CASTLE_X + t.col * BLOCK + BLOCK / 2;
    const ty = GROUND_Y - (t.row + 1) * BLOCK + BLOCK / 2;
    const s = solve(tx - P0X, ty - P0Y, G * grav('fire'), st.eng.speedMin, st.eng.speedMax, st.eng.angleMin, st.eng.angleMax);
    await applyShot(page, s.angle, s.power, 'fire');
    await waitShot(page);
    after = (await getState(page)).alive;
    chainTested = true;
    break;
  }
  deep.push(`fire/chain removed ${before - after} blocks in one shot`);
  if (!chainTested || before - after < 3) failures.push('fire-chain');

  // forced game-over: weak flat shots that fall short, never clearing
  await startLevel(page, 2);
  let go = false;
  for (let i = 0; i < 30; i++) {
    const st = await getState(page);
    if (st.state === 'gameover') { go = true; break; }
    if (st.state !== 'aiming') { await page.waitForTimeout(60); continue; }
    await applyShot(page, st.eng.angleMax, 0.05, 'stone');
    await waitShot(page);
  }
  deep.push(`forced game-over: ${go ? 'OK' : 'NOT REACHED'}`);
  if (!go) failures.push('gameover');

  // map navigation
  await page.evaluate(() => window.__KUSATMA__.toMap());
  await page.waitForTimeout(120);
  const cards = await page.locator('#map-grid .level-card').count();
  deep.push(`map cards: ${cards}`);
  if (cards !== 60) failures.push('map');

  console.log('\nDeep checks:\n  ' + deep.join('\n  '));
  console.log('\nConsole errors: ' + (errors.length ? errors.length + '\n' + errors.join('\n') : 'NONE'));
  console.log('Failures: ' + (failures.length ? failures.join(', ') : 'NONE'));

  await page.screenshot({ path: 'test-results/kusatma-playthrough.png' });
  await browser.close();
  process.exit(failures.length || errors.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
