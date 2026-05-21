// Brute-force solvability checker for src/game-logic/lazer-ayna.ts levels.
//
// Why: the laser-mirror grid is small (8×8) but a single misplaced level
// can ship as unsolvable — and #77 did exactly that (L2 required hitting
// both (7,0) and (7,7) from a single horizontal beam, geometrically
// impossible with only / and \ mirrors). Build doesn't catch it, smoke
// doesn't catch it, and a human reviewer would need to brute-force the
// puzzle in their head.
//
// Usage:
//   node scripts/lazer-solver.mjs          # checks LEVELS below, prints solutions
//   node scripts/lazer-solver.mjs --ci     # exit 1 if any level is unsolvable
//
// To verify a new level design before editing the .ts file, edit the LEVELS
// array here, run the script, paste the verified array into game-logic.
//
// Performance: ~5s for mirrorLimit≤3, slow beyond that. For limit≥4 the
// script skips unless --deep is passed.

const GRID = 8;

// Mirror these against src/game-logic/lazer-ayna.ts LEVELS array.
const LEVELS = [
  { name: 'L1', laserSide: 'left', laserIndex: 3, targets: [{col:6,row:0}], mirrorLimit: 1 },
  { name: 'L2', laserSide: 'left', laserIndex: 2, targets: [{col:5,row:7}], mirrorLimit: 1 },
  { name: 'L3', laserSide: 'left', laserIndex: 0, targets: [{col:3,row:0},{col:5,row:4}], mirrorLimit: 1 },
  { name: 'L4', laserSide: 'top',  laserIndex: 1, targets: [{col:1,row:4},{col:6,row:4}], mirrorLimit: 2 },
  { name: 'L5', laserSide: 'left', laserIndex: 0, targets: [{col:3,row:0},{col:5,row:3},{col:2,row:5}], mirrorLimit: 2 },
  { name: 'L6', laserSide: 'left', laserIndex: 0, targets: [{col:3,row:0},{col:5,row:3},{col:2,row:5},{col:1,row:7}], mirrorLimit: 3 },
];

function simulate(level, mirrors) {
  const grid = Array.from({ length: GRID }, () =>
    Array.from({ length: GRID }, () => ({ mirror: null, target: false })),
  );
  for (const t of level.targets) grid[t.row][t.col].target = true;
  for (const m of mirrors) grid[m.row][m.col].mirror = m.type;

  let col, row, dir;
  switch (level.laserSide) {
    case 'left':   col = -1; row = level.laserIndex; dir = 'right'; break;
    case 'right':  col = GRID; row = level.laserIndex; dir = 'left'; break;
    case 'top':    col = level.laserIndex; row = -1; dir = 'down'; break;
    case 'bottom': col = level.laserIndex; row = GRID; dir = 'up'; break;
  }

  const hits = new Set();
  const visited = new Set();
  const MAX = GRID * GRID * 4;
  let steps = 0;

  while (steps++ < MAX) {
    if (dir === 'right') col++;
    else if (dir === 'left') col--;
    else if (dir === 'down') row++;
    else row--;
    if (col < 0 || col >= GRID || row < 0 || row >= GRID) break;
    const key = `${col},${row},${dir}`;
    if (visited.has(key)) break;
    visited.add(key);
    const cell = grid[row][col];
    if (cell.target) hits.add(`${col},${row}`);
    if (cell.mirror === '/') {
      if (dir === 'right') dir = 'up';
      else if (dir === 'left') dir = 'down';
      else if (dir === 'up') dir = 'right';
      else dir = 'left';
    } else if (cell.mirror === '\\') {
      if (dir === 'right') dir = 'down';
      else if (dir === 'left') dir = 'up';
      else if (dir === 'up') dir = 'left';
      else dir = 'right';
    }
  }
  return hits.size === level.targets.length;
}

function solve(level) {
  const placeable = [];
  const targetSet = new Set(level.targets.map((t) => `${t.col},${t.row}`));
  for (let r = 0; r < GRID; r++) {
    for (let c = 0; c < GRID; c++) {
      if (!targetSet.has(`${c},${r}`)) placeable.push({ col: c, row: r });
    }
  }
  const types = ['/', '\\'];

  function pick(k, start, current) {
    if (current.length === k) {
      return simulate(level, current) ? [...current] : null;
    }
    for (let i = start; i < placeable.length; i++) {
      for (const t of types) {
        current.push({ ...placeable[i], type: t });
        const found = pick(k, i + 1, current);
        if (found) return found;
        current.pop();
      }
    }
    return null;
  }

  for (let k = 0; k <= level.mirrorLimit; k++) {
    const sol = pick(k, 0, []);
    if (sol) return { mirrors: sol, minK: k };
  }
  return null;
}

const ci = process.argv.includes('--ci');
const deep = process.argv.includes('--deep');
let failed = 0;

console.log('Slug | mirror limit | min solution | sample mirrors');
console.log('---  | ---:         | ---:         | ---');
for (const lvl of LEVELS) {
  if (lvl.mirrorLimit > 3 && !deep) {
    console.log(`${lvl.name} | ${lvl.mirrorLimit} | (skipped — use --deep) |`);
    continue;
  }
  const result = solve(lvl);
  if (result) {
    console.log(`${lvl.name} | ${lvl.mirrorLimit} | ${result.minK} | ${result.mirrors.map((m) => `${m.type}@(${m.col},${m.row})`).join(' · ')}`);
  } else {
    console.log(`${lvl.name} | ${lvl.mirrorLimit} | **UNSOLVABLE** | —`);
    failed++;
  }
}

if (ci && failed > 0) {
  console.error(`\nCI gate: ${failed} unsolvable level(s).`);
  console.error('Either reduce mirrorLimit (no, you can\'t solve with fewer than\nminK), change target positions, or change laser entry — see\nscripts/lazer-solver.mjs for the search space.');
  process.exit(1);
}
