import { defineConfig } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync, statSync, existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, 'games');

const RESERVED = new Set(['src', 'public', 'node_modules', 'dist']);

const gameEntries = Object.fromEntries(
  readdirSync(root)
    .filter((name) => !name.startsWith('_') && !name.startsWith('.'))
    .filter((name) => !RESERVED.has(name))
    .filter((name) => statSync(resolve(root, name)).isDirectory())
    .filter((name) => existsSync(resolve(root, name, 'index.html')))
    .map((name) => [name, resolve(root, name, 'index.html')]),
);

export default defineConfig({
  root,
  base: '/games/',
  appType: 'mpa',
  publicDir: false,
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      input: {
        main: resolve(root, 'index.html'),
        ...gameEntries,
      },
    },
  },
});
