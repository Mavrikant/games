import { defineCollection, z } from 'astro:content';

const games = defineCollection({
  type: 'data',
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
