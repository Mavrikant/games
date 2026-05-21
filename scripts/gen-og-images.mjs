// Generate Open Graph PNG variants from each game's SVG thumbnail.
// SVG og:images don't render in Twitter, Discord, Slack, or LinkedIn
// previews — they require PNG or JPG. We keep the source SVGs (used
// by the in-page card thumbnails, which DO support SVG) and emit a
// matching PNG at 1200×750 (Twitter's preferred 1.91:1 ratio) into
// public/thumbs/og/. Run on-demand: `node scripts/gen-og-images.mjs`.
import sharp from 'sharp';
import { readFileSync, readdirSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const srcDir = 'public/thumbs';
const outDir = 'public/thumbs/og';
mkdirSync(outDir, { recursive: true });

const W = 1200;
const H = 750;

const svgs = readdirSync(srcDir).filter((f) => f.endsWith('.svg'));
let wrote = 0;
let skipped = 0;
for (const f of svgs) {
  const src = join(srcDir, f);
  const out = join(outDir, f.replace(/\.svg$/, '.png'));
  let srcMtime;
  try {
    srcMtime = statSync(src).mtimeMs;
    const outMtime = statSync(out).mtimeMs;
    if (outMtime >= srcMtime) {
      skipped += 1;
      continue;
    }
  } catch {
    /* out doesn't exist; fall through */
  }
  const buf = readFileSync(src);
  // density 200 → roughly 4x supersampling for the 1200px output;
  // sharp resizes down with Lanczos, giving crisp text + edges.
  await sharp(buf, { density: 200 })
    .resize(W, H, { fit: 'cover', background: '#0a0b0e' })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toFile(out);
  wrote += 1;
}
console.log(`og-images: wrote ${wrote}, skipped ${skipped} (up-to-date)`);
