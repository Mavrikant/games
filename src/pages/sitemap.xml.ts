import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';

export const GET: APIRoute = async ({ site }) => {
  const games = await getCollection('games');
  const base = import.meta.env.BASE_URL;
  const origin = (site ?? new URL(base, 'https://karaman.dev')).origin;
  const buildDate = new Date().toISOString().slice(0, 10);

  const urls = [
    { loc: `${origin}${base}`, lastmod: buildDate },
    ...games.map((g) => ({
      loc: `${origin}${base}${g.id}/`,
      lastmod: g.data.dateAdded,
    })),
  ];

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map(
    (u) => `  <url>
    <loc>${u.loc}</loc>
    <lastmod>${u.lastmod}</lastmod>
  </url>`,
  )
  .join('\n')}
</urlset>
`;

  return new Response(xml, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  });
};
