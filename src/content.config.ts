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
    // Optional global-leaderboard descriptor. Absent → the game does not
    // participate in the online leaderboard (the default). When present, it
    // appears on /siralama and the in-iframe @shared/leaderboard helper can
    // submit scores with the right direction/label. See docs/LEADERBOARD.md.
    scoring: z
      .object({
        // Stable backend board id; defaults to the slug when omitted, but is
        // explicit so renaming a content file never silently splits a board.
        id: z.string().optional(),
        // The localStorage key the game already writes its local best to
        // (e.g. "2048.best"), so the contract stays aligned with what ships.
        storageKey: z.string(),
        // Human label for the metric ("Skor", "Süre", "Seviye", "Yükseklik").
        label: z.string(),
        // Unit suffix for display ("", "sn", "hamle", "m").
        unit: z.string().optional(),
        // Sort direction for "best": higher points vs. lower time.
        direction: z.enum(['higher', 'lower']).default('higher'),
        // Optional EN label override for the English leaderboard view.
        labelEn: z.string().optional(),
      })
      .optional(),
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
