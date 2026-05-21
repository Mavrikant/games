import sharp from 'sharp';
import { readFileSync } from 'node:fs';

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
