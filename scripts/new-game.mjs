#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { argv, exit } from 'node:process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const templates = resolve(__dirname, 'templates');

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const SHARED = new Set([
  'src',
  'public',
  'node_modules',
  'dist',
  '_template',
  '_astro',
]);

function usage(msg) {
  if (msg) console.error(`Error: ${msg}\n`);
  console.error(
    'Usage:\n' +
      '  npm run new-game <slug> -- --title "Title" --description "Desc" \\\n' +
      '                       [--tags "a,b,c"] [--controls "Ok tuşları"]\n' +
      '\n' +
      'Slug must match /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/ and be unique.\n',
  );
  exit(msg ? 1 : 0);
}

function parseArgs(args) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--help') usage();
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) {
        usage(`Missing value for --${key}`);
      }
      out.flags[key] = next;
      i++;
    } else {
      out._.push(a);
    }
  }
  return out;
}

const { _, flags } = parseArgs(argv.slice(2));
const slug = _[0];
if (!slug) usage('Slug is required');
if (!SLUG_RE.test(slug)) usage(`Invalid slug: '${slug}'`);
if (SHARED.has(slug)) usage(`'${slug}' is a reserved name`);

const title = flags.title;
if (!title) usage('--title is required');
const description = flags.description ?? `${title} oyunu.`;
const controls = flags.controls ?? '—';
const tags = (flags.tags ?? '')
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);

const today = new Date().toISOString().slice(0, 10);

const targets = [
  {
    src: 'meta.json',
    dst: `src/content/games/${slug}.json`,
  },
  {
    src: 'body.astro',
    dst: `src/game-bodies/${slug}.astro`,
  },
  {
    src: 'logic.ts',
    dst: `src/game-logic/${slug}.ts`,
  },
  {
    src: 'style.css',
    dst: `src/styles/games/${slug}.css`,
  },
];

const conflicts = targets.filter((t) => existsSync(resolve(root, t.dst)));
if (conflicts.length > 0) {
  console.error('Refusing to overwrite existing files:');
  for (const c of conflicts) console.error(`  ${c.dst}`);
  console.error('\nPick a different slug or delete the existing files first.');
  exit(1);
}

const replacements = {
  __SLUG__: slug,
  __TITLE__: title,
  __DESCRIPTION__: description,
  __DATE__: today,
  __TAGS_JSON__: JSON.stringify(tags),
  __CONTROLS__: controls,
};

function fill(template) {
  return Object.entries(replacements).reduce(
    (acc, [k, v]) => acc.replaceAll(k, v),
    template,
  );
}

for (const { src, dst } of targets) {
  const tpl = readFileSync(resolve(templates, src), 'utf8');
  const out = fill(tpl);
  const dstAbs = resolve(root, dst);
  mkdirSync(dirname(dstAbs), { recursive: true });
  writeFileSync(dstAbs, out);
  console.log(`  created  ${dst}`);
}

console.log(`
Done. Next steps:
  1. Implement game logic   → src/game-logic/${slug}.ts
  2. Update body markup     → src/game-bodies/${slug}.astro
  3. Add thumbnail (opt)    → public/thumbs/${slug}.svg
  4. Verify build           → npm run build
  5. Dev test               → npm run dev  (http://localhost:4321/games/${slug}/)
  6. Commit & PR
        git checkout -b add-${slug}
        git add src/content/games/${slug}.json \\
                src/game-bodies/${slug}.astro \\
                src/game-logic/${slug}.ts \\
                src/styles/games/${slug}.css \\
                public/thumbs/${slug}.svg
        git commit -m "Add ${title}"
        git push -u origin add-${slug}
        gh pr create --fill

See docs/ADDING_A_GAME.md for full guide.
`);
