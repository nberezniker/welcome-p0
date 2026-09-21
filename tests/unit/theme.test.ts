import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_THEME, THEMES, isTheme, resolveRequestTheme } from '../../src/lib/theme';

/**
 * The theme layer's two claims, both machine-checked here:
 *
 *   1. RESOLUTION — which request gets which theme. A wrong answer here is not a
 *      cosmetic bug: getting it wrong in the permissive direction means a
 *      stranger's shared card arrives re-skinned, which is the one thing the
 *      review mode must never do.
 *   2. THE DEFAULT IS STILL TODAY'S LOOK — a static pin on globals.css. The
 *      acceptance bar for this work is "the default theme is byte-compatible
 *      with the look that shipped before themes existed", and a pin is the only
 *      way that stays true: without it, moving one `:root` token turns every
 *      visitor's page into a redesign and every other gate stays green.
 */

// ── 1. Resolution ───────────────────────────────────────────────────────────

test('theme: the three known values are accepted, everything else is not', () => {
  assert.deepEqual([...THEMES], ['soft', 'swiss', 'poster']);
  assert.equal(DEFAULT_THEME, 'soft');
  for (const theme of THEMES) assert.equal(isTheme(theme), true);
  for (const value of ['', 'dark', 'Swiss', 'SWISS', 'soft ', 'poster2', 'null', undefined, null, 42, {}, []]) {
    assert.equal(isTheme(value), false, `${String(value)} must not be a theme`);
  }
});

test('theme: an explicit ?theme= wins over the cookie, either alone decides, neither means none', () => {
  // The query is the way IN to review mode, so it must beat a cookie set earlier.
  assert.equal(resolveRequestTheme('swiss', 'soft'), 'swiss');
  assert.equal(resolveRequestTheme('poster', 'swiss'), 'poster');
  assert.equal(resolveRequestTheme('soft', 'poster'), 'soft');
  // The cookie is the choice a reviewer already made: it follows them to pages
  // the query override does not cover (/e/<slug>, the cabinet).
  assert.equal(resolveRequestTheme(undefined, 'poster'), 'poster');
  assert.equal(resolveRequestTheme(null, 'swiss'), 'swiss');
  // No explicit theme at all is the default state — and it is NOT 'soft' as an
  // applied attribute: `null` is what the layout turns into no `data-theme` and
  // no review bar, i.e. exactly what a stranger opening a shared card gets.
  assert.equal(resolveRequestTheme(undefined, undefined), null);
  assert.equal(resolveRequestTheme(null, null), null);
  assert.equal(resolveRequestTheme('', ''), null);
});

test('theme: an invalid value in either place is ignored, never guessed at', () => {
  // A typo in a shared URL must not silently re-skin a stranger's page...
  assert.equal(resolveRequestTheme('dark', undefined), null);
  assert.equal(resolveRequestTheme('dark', 'swiss'), 'swiss'); // ...and must not
  // discard a real choice made on this device either.
  // Case matters: `THEME=Swiss` is not the theme `swiss`.
  assert.equal(resolveRequestTheme('Swiss', undefined), null);
  assert.equal(resolveRequestTheme(undefined, 'Swiss'), null);
  // A hostile/absent-by-accident value falls back to "none", not to the default
  // theme applied as an attribute: the page renders the default LOOK either way,
  // but only the un-themed one is also bar-free.
  assert.equal(resolveRequestTheme('; DROP TABLE themes', 'soft'), 'soft');
});

// ── 2. The default theme is the pre-theme look ──────────────────────────────

const GLOBALS_CSS = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'src',
  'app',
  'globals.css',
);

/** CSS with comments removed — the prose in globals.css contains braces. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Declarations of one CSS rule body, `--x: y;` → `{ '--x': 'y' }`. */
function declarationsOf(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of block.split('\n')) {
    const match = /^\s*(--[\w-]+)\s*:\s*(.+?);\s*$/.exec(line);
    if (match) out[match[1]!] = match[2]!;
  }
  return out;
}

/** The body of the first rule whose selector line contains `needle`. */
function ruleBody(css: string, needle: string): string {
  const start = css.indexOf(needle);
  assert.notEqual(start, -1, `globals.css must contain a rule matching ${needle}`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  assert.ok(open !== -1 && close !== -1, `rule ${needle} must have a body`);
  return css.slice(open + 1, close);
}

/**
 * The `soft` token block, copied from the pre-theme palette. `soft` is what an
 * un-themed page renders as (there is no `html[data-theme="soft"]` rule on
 * purpose), so if any of these move, the default look moved with them.
 */
const SOFT_AS_SHIPPED: Record<string, string> = {
  // The pre-theme palette, verbatim.
  '--t-canvas': '#f5f4ee',
  '--t-surface': '#fff',
  '--t-ink': '#18241f',
  '--t-muted': '#59665e',
  '--t-line': '#dce0d6',
  '--t-line-strong': '#b9c1b7',
  '--t-field-line': '#ccd3c6',
  '--t-accent': '#c93d26',
  '--t-accent-hover': '#bf3d29',
  '--t-accent-pale': '#fff0e9',
  '--t-ink-hover': '#2c3a33',
  '--t-pine': '#284d3d',
  '--t-mint': '#e6efe4',
  // Tailwind's own emerald-50/800 and sky-50/800, which the offer/need chips
  // used before they became tokens — kept as the exact literals so the computed
  // colour is the same one, not a hand-picked approximation.
  '--t-offer': 'oklch(97.9% 0.021 166.113)',
  '--t-offer-ink': 'oklch(43.2% 0.095 166.913)',
  '--t-need': 'oklch(97.7% 0.013 236.62)',
  '--t-need-ink': 'oklch(44.3% 0.11 240.79)',
  // Tailwind's defaults for shape and voice, so computed styles match exactly.
  '--t-rule-card': '1px',
  '--t-radius-md': '0.375rem',
  '--t-radius-lg': '0.5rem',
  '--t-radius-xl': '0.75rem',
  '--t-radius-2xl': '1rem',
  '--t-radius-3xl': '1.5rem',
  '--t-radius-full': 'calc(infinity * 1px)',
  '--t-shadow-card': '0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)',
  '--t-heading-weight': '800',
  '--t-heading-tracking': '-0.025em',
};

test('tokens: the default theme still carries the pre-theme values', () => {
  const css = stripComments(readFileSync(GLOBALS_CSS, 'utf8'));
  const root = declarationsOf(ruleBody(css, ':root'));
  assert.deepEqual(
    root,
    SOFT_AS_SHIPPED,
    'The un-themed page (which is what every visitor and every STRANGER sees) is pinned to the look that shipped before themes existed. Changing a value here is a redesign of the default page — do it deliberately, and update docs-internal/design/THEMES.md in the same change.',
  );
});

test('tokens: every theme defines every token, so none silently inherits soft', () => {
  const css = stripComments(readFileSync(GLOBALS_CSS, 'utf8'));
  const root = declarationsOf(ruleBody(css, ':root'));
  const rootNames = Object.keys(root).sort();

  // Exactly the non-default themes have a block, and each is complete: a theme
  // that forgot a token would render one soft leftover (a green hairline in the
  // middle of a poster) that no other gate can see.
  for (const theme of THEMES.filter((t) => t !== DEFAULT_THEME)) {
    const block = declarationsOf(ruleBody(css, `html[data-theme="${theme}"]`));
    assert.deepEqual(
      Object.keys(block).sort(),
      rootNames,
      `the "${theme}" theme must define exactly the same tokens as :root`,
    );
    // A theme that redefined nothing would be a value set that silently IS soft
    // (i.e. a switcher option that does nothing). Most tokens differ; the
    // handful that do not are deliberate — swiss keeps #c93d26 because it was
    // MEASURED at 5.03:1 on white (docs-internal/design/THEMES.md), and a
    // "different red" would have been a look, not a fix.
    const differing = rootNames.filter((name) => block[name] !== root[name]);
    assert.ok(
      differing.length >= 12,
      `the "${theme}" theme must actually differ from the default (only ${differing.length} tokens do)`,
    );
    for (const structural of ['--t-canvas', '--t-ink', '--t-line', '--t-radius-xl']) {
      assert.notEqual(block[structural], root[structural], `"${theme}" must at least restate ${structural}`);
    }
  }

  // And there is no block for a theme the app cannot select...
  for (const unknown of ['dark', 'high-contrast']) {
    assert.equal(css.includes(`html[data-theme="${unknown}"]`), false, `no block for the unknown theme ${unknown}`);
  }
  // ...including the default, which is `:root` on purpose: writing `soft` twice
  // is how the two copies drift apart. `DEFAULT_THEME` is applied as `null`.
  assert.equal(css.includes('html[data-theme="soft"]'), false);
});
