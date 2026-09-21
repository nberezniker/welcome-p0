// Theme evidence capture — the committed way to (re)produce
// evidence/design-themes/.
//
// WHY THIS EXISTS. The theme work shipped with screenshots in
// evidence/design-themes/ that were produced by an ad-hoc capture that was never
// committed, so the folder could not be regenerated: the images were evidence of
// a run nobody could repeat. This is that capture, written down. It takes a
// running server and the slugs of a card and an event that already exist, and it
// writes exactly the files `tests/e2e/design-themes.spec.ts` asserts about —
// same names, same viewport, same element — so the two agree by construction
// rather than by someone remembering to keep them in step.
//
// WHAT IT DOES NOT DO. It does not reset the database, seed a fixture, or run
//    axe. Seeding and the assertions belong to the e2e suite (which owns the
//    gates); this script answers one question — "what do the four themes
//    actually look like on THIS fixture?" — and answers it reproducibly.
//
// USAGE. Prerequisite: a server, and a slug for each surface.
//   pnpm exec next dev -p 3111          # or any server with the fixture
//   node scripts/capture-theme-evidence.mjs \
//     --card=/p/themes-owner --event=/e/e2e-themed-meetup
//
// Options (all optional except that a surface with no slug is skipped):
//   --base=<url>      default $E2E_BASE_URL or http://127.0.0.1:3111
//   --card=<path>     the public card, e.g. /p/<slug>
//   --event=<path>    the public event, e.g. /e/<slug>
//   --out=<dir>       default evidence/design-themes
//   --width=<n>       default 390 (the viewport the evidence folder is for)
//   --height=<n>      default 844
//
// The theme is applied by setting the `welcome_theme` cookie, which is how a
// reviewer's choice persists onto /e/<slug> as well — one channel for both
// surfaces, and the same channel the switcher uses. `visitor` is the pass with
// no cookie at all: the page a stranger gets, and the reference every themed
// capture is compared against.
import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { THEMES } from '../src/lib/theme.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** `--flag=value` out of argv, with a default. */
function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const baseURL = (arg('base', process.env.E2E_BASE_URL || 'http://127.0.0.1:3111')).replace(/\/+$/, '');
const outDir = path.resolve(arg('out', path.join(ROOT, 'evidence', 'design-themes')));
const width = Number(arg('width', '390'));
const height = Number(arg('height', '844'));

const surfaces = [
  { surface: 'card', path: arg('card', null) },
  { surface: 'event', path: arg('event', null) },
].filter((s) => typeof s.path === 'string' && s.path.length > 0);

if (surfaces.length === 0) {
  console.error(
    'Nothing to capture: pass --card=/p/<slug> and/or --event=/e/<slug>.\n' +
      'The script deliberately does not invent a fixture — point it at one that exists.',
  );
  process.exit(2);
}

mkdirSync(outDir, { recursive: true });

/** `next dev`'s overlay is a fixed portal that lands inside an element shot. */
async function hideDevOverlay(page) {
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
}

async function waitHydrated(page) {
  await page.waitForSelector('html[data-hydrated="true"]', { state: 'attached', timeout: 30_000 });
}

/** The selectors the e2e suite measures, so the two read the same box. */
function selectorsFor(surface) {
  return surface === 'card'
    ? {
        element: '[data-testid="pubcard"]',
        action: '[data-testid="pubcard-signin-cta"] a, [data-testid="pubcard-intro-cta"]',
      }
    : { element: 'main .card', action: '[data-testid="join-button"]' };
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
const page = await context.newPage();

/** Every capture, so the manifest is a record of what was taken, not a claim. */
const captures = [];
const findings = [];

for (const { surface, path: surfacePath } of surfaces) {
  const { element, action } = selectorsFor(surface);

  for (const theme of ['visitor', ...THEMES]) {
    // `visitor` is the no-cookie pass. Anything else states the theme the way the
    // switcher stores it, then reloads so the document is rendered for it.
    await context.clearCookies();
    if (theme !== 'visitor') {
      await context.addCookies([{ name: 'welcome_theme', value: theme, url: baseURL }]);
    }

    const response = await page.goto(`${baseURL}${surfacePath}`, { waitUntil: 'domcontentloaded' });
    if (!response || response.status() !== 200) {
      findings.push(`${surface} ${theme}: ${surfacePath} answered ${response ? response.status() : 'no response'}`);
      continue;
    }
    await waitHydrated(page);

    const applied = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    const expected = theme === 'visitor' ? null : theme;
    if (applied !== expected) {
      // Not cosmetic: a capture labelled "premium" that rendered something else
      // would be a false record, which is worse than no record.
      findings.push(`${surface} ${theme}: document carries data-theme=${applied}, expected ${expected}`);
    }

    const geometry = await page.evaluate(
      (sel) => {
        const box = (selector) => {
          const el = document.querySelector(selector);
          if (!el) return null;
          const b = el.getBoundingClientRect();
          return { top: b.y, bottom: b.y + b.height };
        };
        return {
          innerWidth: window.innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          element: box(sel.element),
          action: box(sel.action),
          bar: box('[data-testid="theme-bar"]'),
        };
      },
      { element, action },
    );

    if (geometry.scrollWidth > geometry.innerWidth) {
      findings.push(
        `${surface} ${theme}: horizontal overflow of ${geometry.scrollWidth - geometry.innerWidth}px at ${width}px`,
      );
    }

    await hideDevOverlay(page);
    const elementFile = path.join(outDir, `${surface}-${width}-${theme}.png`);
    const screenFile = path.join(outDir, `${surface}-${width}-${theme}-firstscreen.png`);
    const target = page.locator(element).first();
    if ((await target.count()) === 0) {
      findings.push(`${surface} ${theme}: no element matched ${element}`);
      continue;
    }
    await target.screenshot({ path: elementFile });
    await page.screenshot({ path: screenFile });

    captures.push({
      surface,
      theme,
      path: surfacePath,
      viewport: `${width}x${height}`,
      data_theme: applied,
      element_bottom: geometry.element ? Math.round(geometry.element.bottom * 1000) / 1000 : null,
      action_top: geometry.action ? Math.round(geometry.action.top * 1000) / 1000 : null,
      bar_top: geometry.bar ? Math.round(geometry.bar.top * 1000) / 1000 : null,
      overflow_px: geometry.scrollWidth - geometry.innerWidth,
      files: [
        { file: path.relative(ROOT, elementFile), bytes: readFileSync(elementFile).length, sha256: sha256(elementFile) },
        { file: path.relative(ROOT, screenFile), bytes: readFileSync(screenFile).length, sha256: sha256(screenFile) },
      ],
    });
    console.log(
      `[capture] ${surface} ${theme}: element bottom ${captures.at(-1).element_bottom} · bar ${captures.at(-1).bar_top} · overflow ${captures.at(-1).overflow_px}px`,
    );
  }
}

await browser.close();

// Written even when a finding exists: the record of a bad run is itself evidence.
writeFileSync(
  path.join(outDir, 'theme-capture.json'),
  `${JSON.stringify(
    {
      generated_at: new Date().toISOString(),
      script: 'scripts/capture-theme-evidence.mjs',
      base_url: baseURL,
      viewport: `${width}x${height}`,
      note: 'Theme screenshots for the surfaces and slugs given on the command line. "visitor" is the no-cookie pass. Reproduce with the exact command in the script header; the SHA-256s are what make a re-run comparable to this one.',
      captures,
    },
    null,
    2,
  )}\n`,
  'utf8',
);

if (findings.length > 0) {
  console.error(`\n[capture] findings:\n${findings.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
console.log(`\n[capture] ${captures.length} capture(s) written to ${path.relative(ROOT, outDir)}/`);
