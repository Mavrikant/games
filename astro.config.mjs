import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://karaman.dev',
  base: '/games/',
  trailingSlash: 'always',
  build: {
    format: 'directory',
  },
});
