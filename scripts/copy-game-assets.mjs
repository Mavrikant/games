import {
  readdirSync,
  statSync,
  existsSync,
  mkdirSync,
  copyFileSync,
} from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..', 'games');
const dist = resolve(__dirname, '..', 'dist');

const RESERVED = new Set(['src', 'public', 'node_modules', 'dist']);
const THUMB_EXTS = ['svg', 'png', 'jpg', 'jpeg', 'webp'];

let copied = 0;
for (const name of readdirSync(root)) {
  if (name.startsWith('_') || name.startsWith('.') || RESERVED.has(name)) continue;
  const dir = resolve(root, name);
  if (!statSync(dir).isDirectory()) continue;
  for (const ext of THUMB_EXTS) {
    const src = resolve(dir, `thumb.${ext}`);
    if (!existsSync(src)) continue;
    const dst = resolve(dist, name, `thumb.${ext}`);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
    copied++;
  }
}
console.log(`Copied ${copied} game thumbnail(s).`);
