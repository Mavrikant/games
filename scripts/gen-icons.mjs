import sharp from 'sharp';
import pngToIco from 'png-to-ico';
import { readFileSync, writeFileSync } from 'node:fs';

const svg = readFileSync('public/favicon.svg');
const targets = [
  { out: 'public/icon-192.png', size: 192 },
  { out: 'public/icon-512.png', size: 512 },
  { out: 'public/icon-maskable-512.png', size: 512, padding: 0.1 },
  { out: 'public/apple-touch-icon.png', size: 180 },
];

for (const { out, size, padding } of targets) {
  if (padding) {
    const pad = Math.round(size * padding);
    const inner = size - pad * 2;
    const innerSvg = await sharp(svg, { density: 400 }).resize(inner, inner).png().toBuffer();
    await sharp({
      create: { width: size, height: size, channels: 4, background: '#0a0b0e' },
    })
      .composite([{ input: innerSvg, top: pad, left: pad }])
      .png()
      .toFile(out);
  } else {
    await sharp(svg, { density: 400 }).resize(size, size).png().toFile(out);
  }
  console.log('wrote', out);
}

// favicon.ico — multi-size (16/32/48), PNG-embedded ICO. Browsers request
// /favicon.ico by name; the SVG/PNG <link>s cover modern UAs, this is the
// legacy fallback. Referenced explicitly in BaseLayout since the app lives
// under /games/ (root-level auto-request would miss it).
const icoPngs = await Promise.all(
  [16, 32, 48].map((s) => sharp(svg, { density: 400 }).resize(s, s).png().toBuffer()),
);
writeFileSync('public/favicon.ico', await pngToIco(icoPngs));
console.log('wrote public/favicon.ico');
