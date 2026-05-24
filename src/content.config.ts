import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'zod';

const games = defineCollection({
  loader: glob({ pattern: '*.json', base: './src/content/games' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    dateAdded: z.string(),
    tags: z.array(z.string()).default([]),
    controls: z.string().optional(),
    howToPlay: z.string().optional(),
    thumbnail: z.string().optional(),
    // Optional English translation. When present, /games/en/<slug>/ is
    // emitted with these fields; without it, the EN route is skipped so
    // we don't ship an English page that's actually Turkish content.
    en: z
      .object({
        title: z.string(),
        description: z.string(),
        controls: z.string().optional(),
        howToPlay: z.string().optional(),
      })
      .optional(),
  }),
});

export const collections = { games };
