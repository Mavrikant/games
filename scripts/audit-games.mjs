#!/usr/bin/env node
// Static audit for src/game-logic/*.ts — reports @shared/* adoption and
// remaining PITFALLS patterns. Run `npm run audit:games` to see the
// migration debt and pick the next refactor target.
//
// Designed as a guide, not a gate: prints a Markdown table to stdout.
// Exit code is always 0 unless the directory is missing.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const logicDir = resolve(root, 'src', 'game-logic');

if (!existsSync(logicDir)) {
  console.error(`Not found: ${logicDir}`);
  process.exit(1);
}

const files = readdirSync(logicDir)
  .filter((f) => f.endsWith('.ts'))
  .sort();

/**
 * Look backward up to `window` lines from index `i` for a `try {` opener.
 * Heuristic — does not parse braces; good enough for the codebase style.
 */
function hasNearbyTry(lines, i, window = 10) {
  // Inline try { ... } catch on the same line.
  if (/try\s*\{.*\}\s*catch/.test(lines[i])) return true;
  for (let j = Math.max(0, i - window); j < i; j++) {
    if (/try\s*\{/.test(lines[j])) return true;
  }
  return false;
}

const rows = [];

for (const file of files) {
  const path = resolve(logicDir, file);
  const content = readFileSync(path, 'utf8');
  const lines = content.split('\n');

  const usesSharedStorage = /from\s+'@shared\/storage'/.test(content);
  const usesSharedGameModule = /from\s+'@shared\/game-module'/.test(content);
  const usesSharedOverlay = /from\s+'@shared\/overlay'/.test(content);
  const usesSharedGenToken = /from\s+'@shared\/gen-token'/.test(content);
  const usesDefineGame = /defineGame\s*\(/.test(content);

  // Anti-pattern: module-level top-level querySelector (no leading whitespace).
  let moduleLevelQs = 0;
  for (const line of lines) {
    if (/^(const|let)\s+\w+.*=\s*document\.querySelector/.test(line)) {
      moduleLevelQs++;
    }
  }

  // Anti-pattern: localStorage call without nearby try (or @shared/storage).
  let unguardedStorage = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!/localStorage\.(getItem|setItem|removeItem)/.test(lines[i])) continue;
    if (hasNearbyTry(lines, i)) continue;
    unguardedStorage++;
  }

  // Adoption score: 0..4 (storage, game-module/defineGame, overlay, gen-token).
  let score = 0;
  if (usesSharedStorage) score++;
  if (usesSharedGameModule && usesDefineGame) score++;
  if (usesSharedOverlay) score++;
  if (usesSharedGenToken) score++;

  const slug = file.replace(/\.ts$/, '');
  rows.push({
    slug,
    score,
    storage: usesSharedStorage,
    gameModule: usesSharedGameModule && usesDefineGame,
    overlay: usesSharedOverlay,
    genToken: usesSharedGenToken,
    moduleLevelQs,
    unguardedStorage,
    loc: lines.length,
  });
}

// Sort: lowest adoption first, then unguarded-storage count, then size.
rows.sort((a, b) => {
  if (a.score !== b.score) return a.score - b.score;
  if (a.unguardedStorage !== b.unguardedStorage)
    return b.unguardedStorage - a.unguardedStorage;
  return b.loc - a.loc;
});

const mark = (b) => (b ? '✓' : '·');

const totalGames = rows.length;
const fullyAdopted = rows.filter((r) => r.score === 4).length;
const noAdoption = rows.filter((r) => r.score === 0).length;
const anyUnguarded = rows.filter((r) => r.unguardedStorage > 0).length;
const anyModuleLevelQs = rows.filter((r) => r.moduleLevelQs > 0).length;

const banner = `
# Game-logic audit

| Toplam oyun | Tam adoption (4/4) | Adoption yok (0/4) | Unguarded storage | Module-level querySelector |
|---:|---:|---:|---:|---:|
| ${totalGames} | ${fullyAdopted} | ${noAdoption} | ${anyUnguarded} | ${anyModuleLevelQs} |

## Detaylı tablo

| Slug | Score | Storage | GameModule | Overlay | GenToken | UnsafeLS | ModLvlQS | LOC |
|---|---:|:---:|:---:|:---:|:---:|---:|---:|---:|
`;

console.log(banner.trim());

for (const r of rows) {
  console.log(
    `| ${r.slug} | ${r.score}/4 | ${mark(r.storage)} | ${mark(r.gameModule)} | ${mark(r.overlay)} | ${mark(r.genToken)} | ${r.unguardedStorage} | ${r.moduleLevelQs} | ${r.loc} |`,
  );
}

console.log(`
## Notlar

- **UnsafeLS**: \`localStorage\` çağrısı yakın try/catch içinde değil
  (PITFALLS#unguarded-storage aktif riski). Heuristic — yanlış pozitif olabilir.
- **ModLvlQS**: \`const x = document.querySelector(...)\` top-level
  (PITFALLS#unguarded-storage'in DOM varyantı; Safari private mode crash riski yok ama early-access patterns kötü).
- En düşük score'lu oyunlar önce gelir; o tarafta migration başla.
- \`--ci\` flag ile CI'da çalışırsa unsafe storage veya module-level qS
  görürse exit 1. Yeni oyunlar için ratchet — eklenen oyun mevcut
  standardı bozarsa CI fail.
`);

// CI mode: exit non-zero if any regression. This locks in the current
// post-migration state — no future agent can land a game that uses raw
// localStorage outside try/catch or declares module-level querySelectors.
if (process.argv.includes('--ci')) {
  if (anyUnguarded > 0 || anyModuleLevelQs > 0) {
    console.error(
      `\nCI gate: ${anyUnguarded} unsafe localStorage call(s) and ${anyModuleLevelQs} module-level querySelector(s) detected.`,
    );
    console.error(
      `Use @shared/storage and move DOM access into init() (see docs/SHARED_HELPERS.md).`,
    );
    process.exit(1);
  }
  console.log('CI gate: passed (0 unsafe storage, 0 module-level querySelector).');
}
