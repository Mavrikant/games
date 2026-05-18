import type { GameMeta } from './types';

const metaModules = import.meta.glob<{ default: GameMeta }>(
  '/*/meta.json',
  { eager: true },
);

const RESERVED = new Set(['src', 'public', 'node_modules', 'dist']);

function deriveSlug(path: string): string {
  const match = path.match(/^\/([^/]+)\//);
  if (!match || !match[1]) {
    throw new Error(`Unexpected path: ${path}`);
  }
  return match[1];
}

export interface ResolvedGame extends GameMeta {
  url: string;
  thumbnailUrl?: string;
}

export const games: ResolvedGame[] = Object.entries(metaModules)
  .filter(([path]) => {
    const slug = deriveSlug(path);
    return !slug.startsWith('_') && !RESERVED.has(slug);
  })
  .map(([path, mod]) => {
    const meta = mod.default;
    const slug = meta.slug || deriveSlug(path);
    return {
      ...meta,
      slug,
      url: `${slug}/`,
      thumbnailUrl: meta.thumbnail ? `${slug}/${meta.thumbnail}` : undefined,
    };
  })
  .sort((a, b) => b.dateAdded.localeCompare(a.dateAdded));

export const allTags: string[] = [
  ...new Set(games.flatMap((g) => g.tags)),
].sort();
