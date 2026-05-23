#!/usr/bin/env node
// Şeker Eşle full-playthrough automation.
// Launches the game in headless chromium and plays every level
// from 1 to N via simulated pointer swaps. Reports which levels
// could not be completed within their move budget.

import { chromium } from 'playwright';
import process from 'node:process';

const PORT = Number(process.env.PORT ?? 4321);
const BASE = `http://127.0.0.1:${PORT}`;
const MAX_LEVEL = Number(process.argv[2] ?? 100);
const MAX_SWAPS_PER_LEVEL = Number(process.env.MAX_SWAPS ?? 80);
const SWAP_SETTLE_MS = Number(process.env.SWAP_SETTLE_MS ?? 700);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 800, height: 1000 } });
await ctx.route('**/*', (route) => {
  const url = route.request().url();
  if (url.startsWith(BASE) || url.startsWith('data:') || url.startsWith('about:')) return route.continue();
  return route.abort();
});
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(`console.error: ${m.text()}`);
});

await page.goto(`${BASE}/games/seker-esle/`, { waitUntil: 'load' });

// Wipe profile so we start fresh, then unlock all levels.
await page.evaluate((max) => {
  localStorage.clear();
  // Build a profile with currentLevel = max so every card is unlocked.
  const profile = {
    schemaVersion: 2,
    currentLevel: max,
    bestLevel: 1,
    totalStars: 0,
    levels: {},
    boosters: { hammer: 0, swap: 0, colorBombStart: 0, plus5Moves: 0 },
    achievements: [],
    lastPlayDate: new Date().toISOString().slice(0, 10),
    streak: 1,
    longestStreak: 1,
    dailyCompleted: {},
    tutorialDone: true,
    settings: { sound: false, vibrate: false, reducedMotion: true },
    stats: { totalMatches: 0, totalCascades: 0, bestCascade: 0, specialsCreated: 0, bestLevelStars: 0, longestComboStreak: 0 },
  };
  localStorage.setItem('seker-esle.profile.v2', JSON.stringify(profile));
}, MAX_LEVEL);

await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(400);

// Dismiss any boot overlay (daily intro etc.)
await page.evaluate(() => {
  const fire = (id) => {
    const el = document.getElementById(id);
    if (el) el.click();
  };
  fire('daily-close');
  fire('comeback-claim');
});
await page.waitForTimeout(200);

const results = [];

function summarize(r) {
  const icon = r.status === 'won' ? '✓' : r.status === 'lost' ? '✗' : r.status === 'stuck' ? '⊘' : '·';
  return `${icon} L${String(r.level).padStart(3, ' ')}  ${r.status.padEnd(7)}  swaps=${r.swaps}  score=${r.score}  movesLeft=${r.movesLeft}  mission=${r.mission}  stars=${r.stars ?? '-'}`;
}

async function gotoLevel(level) {
  // Make sure we are on the map.
  await page.evaluate(() => {
    const ov = document.getElementById('map');
    if (ov && ov.classList.contains('overlay--hidden')) {
      // Force show map via #map-btn (always visible in HUD)
      document.getElementById('map-btn')?.click();
    }
  });
  await page.waitForTimeout(150);
  await page.evaluate((lv) => {
    const cards = document.querySelectorAll('.level-card');
    const card = cards[lv - 1];
    if (card) card.click();
  }, level);
  await page.waitForTimeout(450);
}

async function readStatus() {
  return await page.evaluate(() => {
    const lc = document.getElementById('level-complete');
    const lf = document.getElementById('level-fail');
    const completeVisible = !!(lc && !lc.classList.contains('overlay--hidden'));
    const failVisible = !!(lf && !lf.classList.contains('overlay--hidden'));
    const score = document.getElementById('hud-score')?.textContent ?? '?';
    const movesLeft = document.getElementById('hud-moves')?.textContent ?? '?';
    const mission = document.getElementById('mission-count')?.textContent ?? '?';
    const stars = lc ? lc.querySelectorAll('.star--filled').length : 0;
    return { completeVisible, failVisible, score, movesLeft, mission, stars };
  });
}

async function findSwap() {
  return await page.evaluate(() => {
    const SIZE = 8;
    const tiles = [...document.querySelectorAll('#tiles .tile')];
    if (tiles.length === 0) return null;
    const grid = Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
    const ingredientCols = new Set();
    const ingredientRowByCol = new Map();
    const jellyCells = [];
    for (const t of tiles) {
      const r = +t.dataset.row;
      const c = +t.dataset.col;
      if (Number.isNaN(r) || Number.isNaN(c)) continue;
      const isBomb = t.className.includes('tile--color-bomb');
      const isCherry = t.classList.contains('tile--cherry');
      const isJelly = t.classList.contains('tile--jelly-1') || t.classList.contains('tile--jelly-2');
      const m = t.className.match(/tile--c(\d)/);
      grid[r][c] = isBomb ? -1 : isCherry ? -3 : (m ? +m[1] : -2);
      if (isCherry) {
        ingredientCols.add(c);
        ingredientRowByCol.set(c, r);
      }
      if (isJelly) jellyCells.push([r, c]);
    }
    function hasMatch(g) {
      for (let r = 0; r < SIZE; r++) {
        for (let c = 0; c + 2 < SIZE; c++) {
          if (g[r][c] >= 0 && g[r][c] === g[r][c + 1] && g[r][c + 1] === g[r][c + 2]) return true;
        }
      }
      for (let c = 0; c < SIZE; c++) {
        for (let r = 0; r + 2 < SIZE; r++) {
          if (g[r][c] >= 0 && g[r][c] === g[r + 1][c] && g[r + 1][c] === g[r + 2][c]) return true;
        }
      }
      return false;
    }
    function matchTouchesColBelow(g, col, minRow) {
      for (let cc = Math.max(0, col - 2); cc <= col && cc + 2 < SIZE; cc++) {
        for (let rr = minRow; rr < SIZE; rr++) {
          if (g[rr][cc] >= 0 && g[rr][cc] === g[rr][cc + 1] && g[rr][cc + 1] === g[rr][cc + 2]) return true;
        }
      }
      for (let rr = minRow; rr + 2 < SIZE; rr++) {
        if (g[rr][col] >= 0 && g[rr][col] === g[rr + 1][col] && g[rr + 1][col] === g[rr + 2][col]) return true;
      }
      return false;
    }
    function swapColors(r1, c1, r2, c2) {
      const a = grid[r1][c1], b = grid[r2][c2];
      grid[r1][c1] = b; grid[r2][c2] = a;
      return () => { grid[r1][c1] = a; grid[r2][c2] = b; };
    }
    function swapMatchesAtCell(r1, c1, r2, c2, tr, tc) {
      const undo = swapColors(r1, c1, r2, c2);
      let hits = false;
      // horizontal through (tr,tc)
      for (let cc = Math.max(0, tc - 2); cc + 2 < SIZE && cc <= tc; cc++) {
        if (grid[tr][cc] >= 0 && grid[tr][cc] === grid[tr][cc + 1] && grid[tr][cc + 1] === grid[tr][cc + 2]) { hits = true; break; }
      }
      if (!hits) {
        for (let rr = Math.max(0, tr - 2); rr + 2 < SIZE && rr <= tr; rr++) {
          if (grid[rr][tc] >= 0 && grid[rr][tc] === grid[rr + 1][tc] && grid[rr + 1][tc] === grid[rr + 2][tc]) { hits = true; break; }
        }
      }
      undo();
      return hits;
    }
    // Pass 1a: jelly targeting — prefer swaps whose match lands on a jelly cell.
    if (jellyCells.length > 0) {
      for (const [jr, jc] of jellyCells) {
        for (let r = 0; r < SIZE; r++) {
          for (let c = 0; c < SIZE; c++) {
            if (grid[r][c] === null || grid[r][c] < 0) continue;
            for (const [dr, dc] of [[0, 1], [1, 0]]) {
              const r2 = r + dr, c2 = c + dc;
              if (r2 >= SIZE || c2 >= SIZE) continue;
              const there = grid[r2][c2];
              if (there === null || there < 0) continue;
              if (swapMatchesAtCell(r, c, r2, c2, jr, jc)) return { r1: r, c1: c, r2, c2 };
            }
          }
        }
      }
    }
    // Pass 1b: ingredient targeting — try to create a match in the cell DIRECTLY
    // below each ingredient so gravity pulls it down. Walk through every possible
    // swap and check if it matches at the target cell.
    if (ingredientCols.size > 0) {
      for (const col of ingredientCols) {
        const ingRow = ingredientRowByCol.get(col);
        const tr = ingRow + 1;
        if (tr >= SIZE) continue;
        for (let r = 0; r < SIZE; r++) {
          for (let c = 0; c < SIZE; c++) {
            if (grid[r][c] === null || grid[r][c] < 0) continue;
            for (const [dr, dc] of [[0, 1], [1, 0]]) {
              const r2 = r + dr, c2 = c + dc;
              if (r2 >= SIZE || c2 >= SIZE) continue;
              const there = grid[r2][c2];
              if (there === null || there < 0) continue;
              if (swapMatchesAtCell(r, c, r2, c2, tr, col)) {
                return { r1: r, c1: c, r2, c2 };
              }
            }
          }
        }
      }
    }
    // Pass 2: any swap that produces any match
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const here = grid[r][c];
        if (here === null) continue;
        if (here === -1) {
          if (c + 1 < SIZE && grid[r][c + 1] !== null && grid[r][c + 1] >= -1) return { r1: r, c1: c, r2: r, c2: c + 1 };
          if (r + 1 < SIZE && grid[r + 1][c] !== null && grid[r + 1][c] >= -1) return { r1: r, c1: c, r2: r + 1, c2: c };
        }
        if (here < 0) continue;
        if (c + 1 < SIZE) {
          const there = grid[r][c + 1];
          if (there !== null && there >= -1) {
            const undo = swapColors(r, c, r, c + 1);
            const ok = (here === -1 || there === -1) || hasMatch(grid);
            undo();
            if (ok) return { r1: r, c1: c, r2: r, c2: c + 1 };
          }
        }
        if (r + 1 < SIZE) {
          const there = grid[r + 1][c];
          if (there !== null && there >= -1) {
            const undo = swapColors(r, c, r + 1, c);
            const ok = (here === -1 || there === -1) || hasMatch(grid);
            undo();
            if (ok) return { r1: r, c1: c, r2: r + 1, c2: c };
          }
        }
      }
    }
    return null;
  });
}

async function dispatchSwap(swap) {
  await page.evaluate(({ r1, c1, r2, c2 }) => {
    const findTile = (r, c) => [...document.querySelectorAll('#tiles .tile')].find((el) => +el.dataset.row === r && +el.dataset.col === c);
    const t1 = findTile(r1, c1);
    const t2 = findTile(r2, c2);
    if (!t1 || !t2) return;
    const a = t1.getBoundingClientRect();
    const b = t2.getBoundingClientRect();
    const board = document.querySelector('#board');
    const x1 = a.x + a.width / 2;
    const y1 = a.y + a.height / 2;
    const x2 = b.x + b.width / 2;
    const y2 = b.y + b.height / 2;
    const pe = (type, x, y) => new PointerEvent(type, { clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', bubbles: true, button: 0, isPrimary: true });
    board.dispatchEvent(pe('pointerdown', x1, y1));
    board.dispatchEvent(pe('pointermove', x2, y2));
    board.dispatchEvent(pe('pointerup', x2, y2));
  }, swap);
}

async function dismissEndOverlay() {
  await page.evaluate(() => {
    const lc = document.getElementById('level-complete');
    if (lc && !lc.classList.contains('overlay--hidden')) {
      document.getElementById('level-complete-map')?.click();
      return;
    }
    const lf = document.getElementById('level-fail');
    if (lf && !lf.classList.contains('overlay--hidden')) {
      document.getElementById('level-fail-map')?.click();
    }
  });
  await page.waitForTimeout(300);
}

const startMs = Date.now();
for (let level = 1; level <= MAX_LEVEL; level++) {
  await gotoLevel(level);
  let swaps = 0;
  let stuckTicks = 0;
  let status = 'unknown';
  let s = null;
  while (swaps < MAX_SWAPS_PER_LEVEL) {
    s = await readStatus();
    if (s.completeVisible) { status = 'won'; break; }
    if (s.failVisible) { status = 'lost'; break; }
    const swap = await findSwap();
    if (!swap) {
      stuckTicks += 1;
      await page.waitForTimeout(500);
      if (stuckTicks > 8) { status = 'stuck'; break; }
      continue;
    }
    stuckTicks = 0;
    await dispatchSwap(swap);
    await page.waitForTimeout(SWAP_SETTLE_MS);
    swaps += 1;
  }
  if (status === 'unknown') {
    s = await readStatus();
    status = s.completeVisible ? 'won' : s.failVisible ? 'lost' : 'timeout';
  }
  results.push({ level, status, swaps, ...s });
  console.log(summarize(results[results.length - 1]));
  await dismissEndOverlay();
}

const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
console.log(`\nDone in ${elapsed}s\n`);

const tally = results.reduce((acc, r) => { acc[r.status] = (acc[r.status] ?? 0) + 1; return acc; }, {});
for (const [k, v] of Object.entries(tally)) console.log(`  ${k.padEnd(8)} ${v}`);

if (pageErrors.length > 0) {
  console.error(`\n${pageErrors.length} runtime errors:`);
  for (const e of pageErrors.slice(0, 20)) console.error(`  ${e}`);
}

const lost = results.filter((r) => r.status !== 'won');
if (lost.length > 0) {
  console.error(`\n${lost.length} / ${results.length} levels not won`);
}

await browser.close();
process.exit(lost.length > 0 ? 1 : 0);
