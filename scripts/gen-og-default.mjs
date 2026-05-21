// Generate the default site-level OG image (public/og-default.png),
// used by the homepage and any page that doesn't pass its own
// ogImage prop. Brand-styled card at Twitter's preferred 1200×750.
import sharp from 'sharp';

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 750">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0a0b0e" />
      <stop offset="100%" stop-color="#14171c" />
    </linearGradient>
    <linearGradient id="logo" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#6366f1" />
      <stop offset="100%" stop-color="#818cf8" />
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.3" r="0.6">
      <stop offset="0%" stop-color="#6366f1" stop-opacity="0.15" />
      <stop offset="100%" stop-color="#6366f1" stop-opacity="0" />
    </radialGradient>
  </defs>
  <rect width="1200" height="750" fill="url(#bg)"/>
  <rect width="1200" height="750" fill="url(#glow)"/>
  <!-- Decorative tiles representing the game grid -->
  <g opacity="0.18">
    <rect x="80"   y="120" width="140" height="90" rx="14" fill="#6366f1"/>
    <rect x="240"  y="120" width="140" height="90" rx="14" fill="#22d3ee"/>
    <rect x="400"  y="120" width="140" height="90" rx="14" fill="#f59e0b"/>
    <rect x="80"   y="540" width="140" height="90" rx="14" fill="#f43f5e"/>
    <rect x="240"  y="540" width="140" height="90" rx="14" fill="#22c55e"/>
    <rect x="980"  y="120" width="140" height="90" rx="14" fill="#a855f7"/>
    <rect x="820"  y="540" width="140" height="90" rx="14" fill="#06b6d4"/>
    <rect x="980"  y="540" width="140" height="90" rx="14" fill="#ec4899"/>
  </g>
  <!-- Brand logo + title -->
  <g transform="translate(600,330)">
    <rect x="-44" y="-100" width="88" height="88" rx="20" fill="url(#logo)" />
    <text x="0" y="-30" font-family="ui-sans-serif, system-ui, -apple-system, sans-serif" font-size="56" font-weight="800" fill="white" text-anchor="middle">K</text>
  </g>
  <text x="600" y="440" font-family="ui-sans-serif, system-ui, -apple-system, sans-serif" font-size="64" font-weight="700" fill="#f5f6f8" text-anchor="middle">Tarayıcı Oyunları</text>
  <text x="600" y="490" font-family="ui-sans-serif, system-ui, -apple-system, sans-serif" font-size="28" font-weight="400" fill="#98a0ad" text-anchor="middle">ücretsiz · indirmesiz · anında oyna</text>
  <text x="600" y="660" font-family="ui-sans-serif, system-ui, -apple-system, sans-serif" font-size="22" font-weight="500" fill="#5a6473" text-anchor="middle" letter-spacing="2">karaman.dev/games</text>
</svg>`;

await sharp(Buffer.from(svg), { density: 200 })
  .resize(1200, 750, { fit: 'cover' })
  .png({ compressionLevel: 9 })
  .toFile('public/og-default.png');

console.log('wrote public/og-default.png (1200×750)');
