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
const cssDir = resolve(root, 'src', 'styles', 'games');

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

  // Overlay CSS contract: if @shared/overlay is imported, the per-game CSS
  // must define a `.overlay--hidden` (or `.<prefix>-overlay--hidden`) rule.
  // The helper toggles the class; the visual effect comes from CSS. Missing
  // this CSS makes hideOverlay() a no-op — see pitfall: missing-overlay-css.
  let missingOverlayCss = false;
  if (usesSharedOverlay) {
    const cssPath = resolve(cssDir, `${slug}.css`);
    if (!existsSync(cssPath)) {
      missingOverlayCss = true;
    } else {
      const cssContent = readFileSync(cssPath, 'utf8');
      // Accept either canonical .overlay--hidden or per-game prefixed (e.g. .pc-overlay--hidden).
      const hasHiddenRule = /\.[\w-]*overlay--hidden\s*\{/.test(cssContent);
      if (!hasHiddenRule) missingOverlayCss = true;
    }
  }

  rows.push({
    slug,
    score,
    storage: usesSharedStorage,
    gameModule: usesSharedGameModule && usesDefineGame,
    overlay: usesSharedOverlay,
    genToken: usesSharedGenToken,
    moduleLevelQs,
    unguardedStorage,
    missingOverlayCss,
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
const anyMissingOverlayCss = rows.filter((r) => r.missingOverlayCss).length;

const banner = `
# Game-logic audit

| Toplam oyun | Tam adoption (4/4) | Adoption yok (0/4) | Unguarded storage | Module-level qS | Missing overlay CSS |
|---:|---:|---:|---:|---:|---:|
| ${totalGames} | ${fullyAdopted} | ${noAdoption} | ${anyUnguarded} | ${anyModuleLevelQs} | ${anyMissingOverlayCss} |

## Detaylı tablo

| Slug | Score | Storage | GameModule | Overlay | GenToken | UnsafeLS | ModLvlQS | OvCSS | LOC |
|---|---:|:---:|:---:|:---:|:---:|---:|---:|:---:|---:|
`;

console.log(banner.trim());

for (const r of rows) {
  // OvCSS column: '·' = no overlay import (n/a), '✓' = imports + has CSS,
  // '✗' = imports but CSS missing the .overlay--hidden rule (broken).
  let ovCss;
  if (!r.overlay) ovCss = '·';
  else ovCss = r.missingOverlayCss ? '✗' : '✓';
  console.log(
    `| ${r.slug} | ${r.score}/4 | ${mark(r.storage)} | ${mark(r.gameModule)} | ${mark(r.overlay)} | ${mark(r.genToken)} | ${r.unguardedStorage} | ${r.moduleLevelQs} | ${ovCss} | ${r.loc} |`,
  );
}

console.log(`
## Notlar

- **UnsafeLS**: \`localStorage\` çağrısı yakın try/catch içinde değil
  (PITFALLS#unguarded-storage aktif riski). Heuristic — yanlış pozitif olabilir.
- **ModLvlQS**: \`const x = document.querySelector(...)\` top-level
  (PITFALLS#module-level-dom-access).
- **OvCSS**: \`@shared/overlay\` import edildi ama oyun-spesifik CSS'te
  \`.overlay--hidden\` (veya prefixli varyantı) tanımı yok →
  \`hideOverlay()\` görsel hiçbir şey yapmaz (PITFALLS#missing-overlay-css).
- En düşük score'lu oyunlar önce gelir; o tarafta migration başla.
- \`--ci\` flag ile CI'da çalışırsa unsafe storage, module-level qS,
  veya missing overlay CSS görürse exit 1. Yeni oyunlar için ratchet —
  eklenen oyun mevcut standardı bozarsa CI fail.
`);

// CI mode: exit non-zero if any regression. This locks in the current
// post-migration state — no future agent can land a game that uses raw
// localStorage outside try/catch, declares module-level querySelectors,
// or imports @shared/overlay without the required CSS contract.
if (process.argv.includes('--ci')) {
  if (anyUnguarded > 0 || anyModuleLevelQs > 0 || anyMissingOverlayCss > 0) {
    const offenders = rows
      .filter((r) => r.missingOverlayCss)
      .map((r) => r.slug)
      .join(', ');
    console.error(
      `\nCI gate: ${anyUnguarded} unsafe localStorage call(s), ${anyModuleLevelQs} module-level querySelector(s), ${anyMissingOverlayCss} missing overlay CSS rule(s).`,
    );
    if (anyMissingOverlayCss > 0) {
      console.error(`  Missing .overlay--hidden in: ${offenders}`);
      console.error(`  Fix: add the .overlay / .overlay--hidden block from scripts/templates/style.css`);
    }
    console.error(
      `Use @shared/storage, move DOM access into init(), and define .overlay--hidden CSS (see docs/SHARED_HELPERS.md, PITFALLS.md#missing-overlay-css).`,
    );
    process.exit(1);
  }
  console.log('CI gate: passed (0 unsafe storage, 0 module-level querySelector, 0 missing overlay CSS).');
}
