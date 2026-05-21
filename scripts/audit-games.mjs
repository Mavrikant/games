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
const contentDir = resolve(root, 'src', 'content', 'games');
const thumbsDir = resolve(root, 'public', 'thumbs');

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

  // Thumbnail reference check: if the JSON metadata sets `thumbnail`,
  // the referenced file under public/thumbs/ must actually exist. A dangling
  // reference renders as a broken <img> on the archive card (Card.astro reads
  // the field unconditionally). See pitfall: dangling-thumbnail-reference.
  //
  // Inverse case (orphan-thumbnail): an SVG exists at public/thumbs/<slug>.svg
  // but the JSON doesn't reference it, so Card falls back to the letter
  // placeholder. The user shipped the asset but forgot to wire it. Less
  // catastrophic than a dangling reference but still a hidden defect.
  let danglingThumbnail = null;     // referenced filename missing
  let orphanThumbnail = false;      // file exists but JSON doesn't reference it
  const jsonPath = resolve(contentDir, `${slug}.json`);
  if (existsSync(jsonPath)) {
    let meta;
    try {
      meta = JSON.parse(readFileSync(jsonPath, 'utf8'));
    } catch {
      meta = null;
    }
    if (meta && typeof meta.thumbnail === 'string' && meta.thumbnail.length > 0) {
      const thumbPath = resolve(thumbsDir, meta.thumbnail);
      if (!existsSync(thumbPath)) danglingThumbnail = meta.thumbnail;
    } else {
      // No thumbnail field — check if a matching SVG sits unused on disk.
      const slugSvg = resolve(thumbsDir, `${slug}.svg`);
      if (existsSync(slugSvg)) orphanThumbnail = true;
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
    danglingThumbnail,
    orphanThumbnail,
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
const anyDanglingThumbnail = rows.filter((r) => r.danglingThumbnail).length;
const anyOrphanThumbnail = rows.filter((r) => r.orphanThumbnail).length;

const banner = `
# Game-logic audit

| Toplam | 4/4 | 0/4 | Unsafe LS | Mod qS | Miss OvCSS | Dangling thumb |
|---:|---:|---:|---:|---:|---:|---:|
| ${totalGames} | ${fullyAdopted} | ${noAdoption} | ${anyUnguarded} | ${anyModuleLevelQs} | ${anyMissingOverlayCss} | ${anyDanglingThumbnail} |

## Detaylı tablo

| Slug | Score | Storage | GameModule | Overlay | GenToken | UnsafeLS | ModLvlQS | OvCSS | Thumb | LOC |
|---|---:|:---:|:---:|:---:|:---:|---:|---:|:---:|:---:|---:|
`;

console.log(banner.trim());

for (const r of rows) {
  // OvCSS column: '·' = no overlay import (n/a), '✓' = imports + has CSS,
  // '✗' = imports but CSS missing the .overlay--hidden rule (broken).
  let ovCss;
  if (!r.overlay) ovCss = '·';
  else ovCss = r.missingOverlayCss ? '✗' : '✓';
  // Thumb column: '✗' = JSON references a file that doesn't exist;
  // '○' = file sits on disk but JSON doesn't reference it (Card falls back
  // to letter placeholder); '·' = neither (no asset, no field).
  let thumb;
  if (r.danglingThumbnail) thumb = '✗';
  else if (r.orphanThumbnail) thumb = '○';
  else thumb = '·';
  console.log(
    `| ${r.slug} | ${r.score}/4 | ${mark(r.storage)} | ${mark(r.gameModule)} | ${mark(r.overlay)} | ${mark(r.genToken)} | ${r.unguardedStorage} | ${r.moduleLevelQs} | ${ovCss} | ${thumb} | ${r.loc} |`,
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
- **Thumb**: \`✗\` JSON \`thumbnail\` alanı eksik bir dosyaya işaret
  ediyor (broken \`<img>\`) — \`○\` SVG dosyası diskte var ama JSON
  alanı yok (Card harf placeholder'a düşer). Her ikisi de
  PITFALLS#dangling-thumbnail-reference / orphan varyantı.
- En düşük score'lu oyunlar önce gelir; o tarafta migration başla.
- \`--ci\` flag ile CI'da çalışırsa unsafe storage, module-level qS,
  missing overlay CSS veya dangling thumbnail görürse exit 1.
  Yeni oyunlar için ratchet — eklenen oyun mevcut standardı bozarsa CI fail.
`);

// CI mode: exit non-zero if any regression. This locks in the current
// post-migration state — no future agent can land a game that uses raw
// localStorage outside try/catch, declares module-level querySelectors,
// imports @shared/overlay without the required CSS contract, or
// references a thumbnail file that doesn't exist.
if (process.argv.includes('--ci')) {
  if (
    anyUnguarded > 0 ||
    anyModuleLevelQs > 0 ||
    anyMissingOverlayCss > 0 ||
    anyDanglingThumbnail > 0 ||
    anyOrphanThumbnail > 0
  ) {
    const overlayOffenders = rows
      .filter((r) => r.missingOverlayCss)
      .map((r) => r.slug)
      .join(', ');
    const danglingOffenders = rows
      .filter((r) => r.danglingThumbnail)
      .map((r) => `${r.slug} → ${r.danglingThumbnail}`)
      .join('; ');
    const orphanOffenders = rows
      .filter((r) => r.orphanThumbnail)
      .map((r) => r.slug)
      .join(', ');
    console.error(
      `\nCI gate: ${anyUnguarded} unsafe localStorage, ${anyModuleLevelQs} module-level qS, ${anyMissingOverlayCss} missing overlay CSS, ${anyDanglingThumbnail} dangling thumb(s), ${anyOrphanThumbnail} orphan thumb(s).`,
    );
    if (anyMissingOverlayCss > 0) {
      console.error(`  Missing .overlay--hidden in: ${overlayOffenders}`);
      console.error(`  Fix: add the .overlay / .overlay--hidden block from scripts/templates/style.css`);
    }
    if (anyDanglingThumbnail > 0) {
      console.error(`  Dangling thumbnail reference(s): ${danglingOffenders}`);
      console.error(`  Fix: either create the SVG at public/thumbs/<slug>.svg, or remove the "thumbnail" field from the JSON.`);
    }
    if (anyOrphanThumbnail > 0) {
      console.error(`  Orphan thumbnail file(s) (SVG exists but JSON has no "thumbnail" field): ${orphanOffenders}`);
      console.error(`  Fix: add "thumbnail": "<slug>.svg" to the JSON, or delete the unused SVG.`);
    }
    console.error(
      `See docs/SHARED_HELPERS.md and PITFALLS.md for migration steps.`,
    );
    process.exit(1);
  }
  console.log('CI gate: passed (0 unsafe storage, 0 module-level qS, 0 missing overlay CSS, 0 dangling thumbnails, 0 orphan thumbnails).');
}
