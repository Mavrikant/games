import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';

// Cache-busting friendly RSS for "new games" feed readers + newsletter
// aggregators. Each game becomes an <item>; sorted newest-first by
// `dateAdded`.

function escapeXml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export const GET: APIRoute = async ({ site }) => {
  const games = await getCollection('games');
  const sorted = games.sort((a, b) =>
    b.data.dateAdded.localeCompare(a.data.dateAdded),
  );

  const base = '/games/';
  const baseUrl = new URL(base, site ?? 'https://karaman.dev').href;
  const feedTitle = 'karaman.dev/games — yeni oyunlar';
  const feedDesc =
    'Tarayıcıda oynanan ücretsiz Türkçe oyun arşivinin yeni eklenenler akışı.';

  const items = sorted
    .map((g) => {
      const url = `${baseUrl}${g.id}/`;
      const pubDate = new Date(`${g.data.dateAdded}T00:00:00Z`).toUTCString();
      const tags = (g.data.tags ?? [])
        .map((t) => `<category>${escapeXml(t)}</category>`)
        .join('');
      return `    <item>
      <title>${escapeXml(g.data.title)}</title>
      <link>${escapeXml(url)}</link>
      <guid isPermaLink="true">${escapeXml(url)}</guid>
      <pubDate>${pubDate}</pubDate>
      <description>${escapeXml(g.data.description)}</description>
      ${tags}
    </item>`;
    })
    .join('\n');

  const lastBuildDate = new Date().toUTCString();

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(feedTitle)}</title>
    <link>${escapeXml(baseUrl)}</link>
    <atom:link href="${escapeXml(baseUrl + 'feed.xml')}" rel="self" type="application/rss+xml" />
    <description>${escapeXml(feedDesc)}</description>
    <language>tr</language>
    <lastBuildDate>${lastBuildDate}</lastBuildDate>
${items}
  </channel>
</rss>`;

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=900',
    },
  });
};
