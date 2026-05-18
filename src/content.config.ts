import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const games = defineCollection({
  loader: glob({ pattern: '*.json', base: './src/content/games' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    dateAdded: z.string(),
    tags: z.array(z.string()).default([]),
    controls: z.string().optional(),
    thumbnail: z.string().optional(),
  }),
});

export const collections = { games };
