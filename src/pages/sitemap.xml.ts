import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { CATEGORIES } from '../data/categories';

interface SitemapUrl {
  loc: string;
  lastmod: string;
  alternates?: { hreflang: string; href: string }[];
}

export const GET: APIRoute = async ({ site }) => {
  const games = await getCollection('games');
  const base = import.meta.env.BASE_URL;
  const origin = (site ?? new URL(base, 'https://karaman.dev')).origin;
  const buildDate = new Date().toISOString().slice(0, 10);

  const urls: SitemapUrl[] = [
    // TR homepage with alternates pointing at the EN site
    {
      loc: `${origin}${base}`,
      lastmod: buildDate,
      alternates: [
        { hreflang: 'tr', href: `${origin}${base}` },
        { hreflang: 'en', href: `${origin}${base}en/` },
        { hreflang: 'x-default', href: `${origin}${base}` },
      ],
    },
    { loc: `${origin}${base}ogretmenler/`, lastmod: buildDate },
    // EN homepage
    {
      loc: `${origin}${base}en/`,
      lastmod: buildDate,
      alternates: [
        { hreflang: 'tr', href: `${origin}${base}` },
        { hreflang: 'en', href: `${origin}${base}en/` },
        { hreflang: 'x-default', href: `${origin}${base}` },
      ],
    },
    // 8 curated category landing pages
    ...CATEGORIES.map((cat) => ({
      loc: `${origin}${base}kategori/${cat.tag}/`,
      lastmod: buildDate,
    })),
    // TR game pages — annotate with EN alternate when a translation exists
    ...games.map((g) => {
      const trUrl = `${origin}${base}${g.id}/`;
      if (g.data.en) {
        const enUrl = `${origin}${base}en/${g.id}/`;
        return {
          loc: trUrl,
          lastmod: g.data.dateAdded,
          alternates: [
            { hreflang: 'tr', href: trUrl },
            { hreflang: 'en', href: enUrl },
            { hreflang: 'x-default', href: trUrl },
          ],
        };
      }
      return { loc: trUrl, lastmod: g.data.dateAdded };
    }),
    // EN game pages — only the games that carry an `en` block
    ...games
      .filter((g) => g.data.en)
      .map((g) => ({
        loc: `${origin}${base}en/${g.id}/`,
        lastmod: g.data.dateAdded,
        alternates: [
          { hreflang: 'tr', href: `${origin}${base}${g.id}/` },
          { hreflang: 'en', href: `${origin}${base}en/${g.id}/` },
          { hreflang: 'x-default', href: `${origin}${base}${g.id}/` },
        ],
      })),
  ];

  const renderUrl = (u: SitemapUrl) => {
    const alternates = u.alternates
      ? u.alternates
          .map(
            (a) =>
              `    <xhtml:link rel="alternate" hreflang="${a.hreflang}" href="${a.href}" />`,
          )
          .join('\n')
      : '';
    return `  <url>
    <loc>${u.loc}</loc>
    <lastmod>${u.lastmod}</lastmod>${alternates ? '\n' + alternates : ''}
  </url>`;
  };

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urls.map(renderUrl).join('\n')}
</urlset>
`;

  return new Response(xml, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  });
};
