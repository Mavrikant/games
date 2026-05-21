#!/usr/bin/env node
// Headless smoke test of every built game.
//
// What it does:
//   1. Spawns `astro preview` to serve dist/ on http://localhost:4321
//   2. For each game in src/content/games/, opens /games/<slug>/ in a
//      headless chromium tab and checks:
//        - HTTP load succeeds
//        - No uncaught page errors (window.onerror)
//        - No console.error messages
//        - At least one visible element renders inside <body>
//      Then takes a screenshot to test-results/<slug>.png.
//   3. Aggregates results; exits 1 if any game failed.
//
// Why: PR #57 (Vardiya grid) and PR #58 (trafik-memuru lock) both slipped
// past the build-only CI because they were runtime / layout bugs.  A real
// browser load catches the entire class of "JS exception on init", "DOM
// missing", "console.error spam" — without per-game custom assertions.
//
// Per-game customization is opt-in: scripts/smoke-scenarios/<slug>.mjs can
// export `async function (page) { ... }` and we'll run it after the default
// checks pass.  No file → only the defaults run.
//
// Limitations (and what M1 deliberately does NOT cover):
//   - Pixel-perfect visual regression is out of scope; the screenshots are
//     debugging aids saved as CI artifacts, not diffed.
//   - Gameplay correctness beyond "init renders without crashing" still
//     needs the manual PLAYTEST.md checklist for any non-trivial change.

import { readdirSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import process from 'node:process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const contentDir = resolve(root, 'src', 'content', 'games');
const scenariosDir = resolve(__dirname, 'smoke-scenarios');
const resultsDir = resolve(root, 'test-results');

if (existsSync(resultsDir)) rmSync(resultsDir, { recursive: true, force: true });
mkdirSync(resultsDir, { recursive: true });

const PORT = Number(process.env.SMOKE_PORT ?? 4321);
const BASE_URL = `http://127.0.0.1:${PORT}`;

const NAV_TIMEOUT_MS = 8_000;
const SETTLE_MS = 600;
// Allow external resources to be blocked entirely — we only test our code.
const BLOCK_EXTERNAL = true;
const SERVER_READY_TIMEOUT_MS = 30_000;

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch (err) {
  console.error('Playwright is not installed. Run `npm install` first.');
  console.error(err.message);
  process.exit(1);
}

// 1. Spawn astro preview server.
const server = spawn('npx', ['astro', 'preview', '--host', '127.0.0.1', '--port', String(PORT)], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverErrors = '';
server.stderr.on('data', (chunk) => {
  serverErrors += chunk.toString();
});
server.on('exit', (code) => {
  if (code !== null && code !== 0 && !shuttingDown) {
    console.error(`Preview server exited early (code ${code}):\n${serverErrors}`);
  }
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (!server.killed) server.kill('SIGTERM');
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

async function waitForReady() {
  const start = Date.now();
  while (Date.now() - start < SERVER_READY_TIMEOUT_MS) {
    try {
      const res = await fetch(`${BASE_URL}/games/`);
      if (res.ok || res.status === 404) return; // server up
    } catch {
      /* not ready */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(
    `astro preview did not start within ${SERVER_READY_TIMEOUT_MS}ms\n${serverErrors}`,
  );
}

try {
  await waitForReady();

  const slugs = readdirSync(contentDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();

  if (slugs.length === 0) {
    console.error('No games found in src/content/games/');
    process.exit(1);
  }

  console.log(`Smoke-testing ${slugs.length} games via headless chromium...`);

  const browser = await chromium.launch();

  // Two viewports — site is mobile-first but most desktop traffic still
  // exists. Mobile catches layout breaks (overlap, off-screen elements);
  // desktop catches things that hide at narrow widths. Each viewport gets
  // its own context + page.
  const viewports = [
    { name: 'mobile', viewport: { width: 375, height: 667 } },
    { name: 'desktop', viewport: { width: 1024, height: 768 } },
  ];

  async function makeContext(viewport) {
    const context = await browser.newContext({
      viewport,
      deviceScaleFactor: 1,
    });
    // Block external (non-localhost) requests so flaky CDN/font hosts don't
    // hang networkidle and don't pollute the console with cert errors.
    if (BLOCK_EXTERNAL) {
      await context.route('**/*', (route) => {
        const url = route.request().url();
        if (url.startsWith(BASE_URL) || url.startsWith('about:') || url.startsWith('data:')) {
          return route.continue();
        }
        return route.abort();
      });
    }
    return context;
  }

  const failures = [];

  for (const vp of viewports) {
    console.log(`\n[${vp.name} ${vp.viewport.width}×${vp.viewport.height}]`);
    const context = await makeContext(vp.viewport);

    for (const slug of slugs) {
      const url = `${BASE_URL}/games/${slug}/`;
      const page = await context.newPage();
      const consoleErrors = [];
      page.on('pageerror', (err) => {
        consoleErrors.push(`pageerror: ${err.message}`);
      });
      page.on('console', (msg) => {
        if (msg.type() !== 'error') return;
        const text = msg.text();
        if (/Failed to load resource/.test(text)) return;
        if (/net::ERR_/.test(text)) return;
        consoleErrors.push(`console.error: ${text}`);
      });

      try {
        const response = await page.goto(url, {
          waitUntil: 'load',
          timeout: NAV_TIMEOUT_MS,
        });
        if (!response || !response.ok()) {
          const status = response ? response.status() : 'no-response';
          consoleErrors.push(`http: ${status}`);
        }
        await page.waitForTimeout(SETTLE_MS);

        const hasContent = await page.evaluate(() => {
          const body = document.body;
          if (!body) return false;
          if (body.querySelector('canvas, svg')) return true;
          return (body.textContent ?? '').trim().length > 0;
        });
        if (!hasContent) consoleErrors.push('structural: body has no visible content');

        // Per-game scenarios run on mobile viewport only — the typical
        // play environment for karaman.dev/games. If a desktop-only
        // assertion is needed, gate via page.viewportSize() inside it.
        if (vp.name === 'mobile') {
          const scenarioPath = resolve(scenariosDir, `${slug}.mjs`);
          if (existsSync(scenarioPath)) {
            try {
              const mod = await import(pathToFileURL(scenarioPath).href);
              if (typeof mod.default === 'function') {
                await mod.default(page);
              }
            } catch (err) {
              consoleErrors.push(`scenario: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }

        await page.screenshot({
          path: resolve(resultsDir, `${slug}-${vp.name}.png`),
          fullPage: false,
        });

        if (consoleErrors.length > 0) {
          failures.push({ slug: `${slug} (${vp.name})`, errors: consoleErrors });
          process.stdout.write('✗');
        } else {
          process.stdout.write('.');
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failures.push({ slug: `${slug} (${vp.name})`, errors: [`navigation: ${message}`] });
        process.stdout.write('✗');
      } finally {
        await page.close();
      }
    }
    process.stdout.write('\n');
    await context.close();
  }

  await browser.close();

  const totalChecks = slugs.length * viewports.length;
  if (failures.length > 0) {
    console.error(`\n${failures.length} / ${totalChecks} viewport-checks failed:\n`);
    for (const f of failures) {
      console.error(`  ${f.slug}:`);
      for (const e of f.errors) console.error(`    ${e}`);
    }
    process.exitCode = 1;
  } else {
    console.log(
      `\nAll ${slugs.length} games passed smoke across ${viewports.length} viewports.`,
    );
    console.log(`Screenshots: test-results/<slug>-{mobile,desktop}.png`);
  }
} catch (err) {
  console.error('Smoke test crashed:', err);
  process.exitCode = 1;
} finally {
  shutdown();
  // Give the server a moment to shut down cleanly before this process exits.
  await new Promise((r) => setTimeout(r, 200));
}
