import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_THEME, THEMES, isTheme, resolveRequestTheme } from '../../src/lib/theme';
import { en } from '../../src/i18n/en';
import { ru } from '../../src/i18n/ru';
import { es } from '../../src/i18n/es';

/**
 * The theme layer's claims, all machine-checked here:
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
 *   3. CONTRAST — the AA pairs (body text, the chip ink, the primary action) are
 *      computed from the token values themselves, for all four themes, so a
 *      colour that "looks fine" cannot ship below the bar. This is the same
 *      measurement the values were chosen by (docs-internal/design/THEMES.md),
 *      turned into an assertion instead of a table nobody re-derives.
 *   4. COLOUR IS NOT THE ONLY CARRIER — in the `premium` theme an offer chip and
 *      a need chip are the SAME colour, so the group a chip belongs to has to be
 *      announced. The card names each chip list by its heading, and the group
 *      headings are distinct, non-empty strings in all three locales. Both are
 *      pinned here, because the difference is one attribute and one string away
 *      from disappearing in a "cleanup" that every other gate would call green.
 */

// ── 1. Resolution ───────────────────────────────────────────────────────────

test('theme: the four known values are accepted, everything else is not', () => {
  assert.deepEqual([...THEMES], ['soft', 'swiss', 'poster', 'premium']);
  assert.equal(DEFAULT_THEME, 'soft');
  for (const theme of THEMES) assert.equal(isTheme(theme), true);
  for (const value of [
    '',
    'dark',
    'Swiss',
    'SWISS',
    'Premium',
    'soft ',
    'poster2',
    'null',
    undefined,
    null,
    42,
    {},
    [],
  ]) {
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

// ── 3. Contrast, computed from the tokens themselves ────────────────────────

/**
 * The colour literals in globals.css are hex and `oklch(...)` — the `oklch` ones
 * because `soft`'s offer/need chips kept Tailwind's own literals. Both have to
 * resolve to sRGB before a ratio exists, so this is a small, exact
 * implementation of the CSS Color 4 and WCAG 2.1 maths rather than a dependency
 * (the project has no new runtime dependencies, and a devDependency that only
 * ever answers one question is worse than twenty lines that can be read).
 *
 * WHY THIS IS THE SAME MEASUREMENT THE VALUES WERE CHOSEN BY. Run against the
 * numbers already recorded in docs-internal/design/THEMES.md, the hex path
 * reproduces every one of them to within 0.005 — so this is the same yardstick,
 * turned into an assertion. The only figures that move are the four `oklch`
 * pairs, and only by ≤0.11: those were previously read off the browser's own
 * resolution of the literal, while this computes it from the literal directly.
 */
type Rgb = readonly [number, number, number];

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** sRGB gamma decode (WCAG 2.1 / IEC 61966-2-1). */
function srgbToLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

/** sRGB gamma encode — the inverse, for resolving `oklch` back to a literal. */
function linearToSrgb(channel: number): number {
  return channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055;
}

/** CSS Color 4 `oklch()` → sRGB, via OKLab and Ottosson's inverse matrices. */
function oklchToRgb(lightnessPercent: number, chroma: number, hueDegrees: number): Rgb {
  const lightness = lightnessPercent / 100;
  const hue = (hueDegrees * Math.PI) / 180;
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);
  const lRoot = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const mRoot = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const sRoot = lightness - 0.0894841775 * a - 1.291485548 * b;
  const l = lRoot ** 3;
  const m = mRoot ** 3;
  const s = sRoot ** 3;
  return [
    clamp01(linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)),
    clamp01(linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)),
    clamp01(linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)),
  ];
}

/** A token value → sRGB. Throws on a literal this file cannot resolve. */
function parseColour(value: string): Rgb {
  const literal = value.trim().toLowerCase();
  if (literal.startsWith('#')) {
    let hex = literal.slice(1);
    if (hex.length === 3) hex = hex.split('').map((digit) => digit + digit).join('');
    // 8-digit hex is #rrggbbaa; a token is always painted opaque, so the alpha
    // is dropped rather than asserted about.
    if (hex.length !== 6 && hex.length !== 8) throw new Error(`unsupported hex colour: ${value}`);
    return [
      parseInt(hex.slice(0, 2), 16) / 255,
      parseInt(hex.slice(2, 4), 16) / 255,
      parseInt(hex.slice(4, 6), 16) / 255,
    ];
  }
  const oklch = /^oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(literal);
  if (oklch) return oklchToRgb(Number(oklch[1]!), Number(oklch[2]!), Number(oklch[3]!));
  throw new Error(
    `globals.css carries a colour literal this test cannot measure (${value}). Add it to parseColour rather than skipping the theme.`,
  );
}

function relativeLuminance(rgb: Rgb): number {
  return 0.2126 * srgbToLinear(rgb[0]) + 0.7152 * srgbToLinear(rgb[1]) + 0.0722 * srgbToLinear(rgb[2]);
}

/** WCAG 2.1 contrast ratio, foreground over background. Order-independent. */
function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(parseColour(foreground));
  const b = relativeLuminance(parseColour(background));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Every theme's token block, keyed by theme name (`:root` under the default). */
function tokensPerTheme(): Map<string, Record<string, string>> {
  const css = stripComments(readFileSync(GLOBALS_CSS, 'utf8'));
  const tokens = new Map<string, Record<string, string>>();
  const defaultName = 'the default (:root)';
  tokens.set(defaultName, declarationsOf(ruleBody(css, ':root')));
  for (const theme of THEMES) {
    if (theme === DEFAULT_THEME) continue;
    tokens.set(theme, declarationsOf(ruleBody(css, `html[data-theme="${theme}"]`)));
  }
  return tokens;
}

function tokenOf(tokens: Record<string, string>, name: string, theme: string): string {
  const value = tokens[name];
  if (typeof value !== 'string') {
    throw new Error(`${theme} does not define ${name}; every theme must define every token (see the test above)`);
  }
  return value;
}

interface Pair {
  /** What the pair is in the product, so a failure names a place, not two hexes. */
  label: string;
  fg: string;
  bg: string;
}

/**
 * The AA pairs: text on the surface it is actually painted on. `--t-surface` is
 * the foreground of the button pairs, and not `#fff`, because that is literally
 * how `text-white` resolves (`--color-white: var(--t-surface)`).
 */
const TEXT_PAIRS: readonly Pair[] = [
  { label: 'body ink on the page ground', fg: '--t-ink', bg: '--t-canvas' },
  { label: 'body ink on a card', fg: '--t-ink', bg: '--t-surface' },
  { label: 'muted ink on the page ground', fg: '--t-muted', bg: '--t-canvas' },
  { label: 'muted ink on a card', fg: '--t-muted', bg: '--t-surface' },
  { label: 'muted ink on the chip field (a language pill on the ground)', fg: '--t-muted', bg: '--t-mint' },
  { label: 'chip ink on the chip field', fg: '--t-pine', bg: '--t-mint' },
  { label: 'offer chip ink on its field', fg: '--t-offer-ink', bg: '--t-offer' },
  { label: 'need chip ink on its field', fg: '--t-need-ink', bg: '--t-need' },
  { label: 'accent text on a card', fg: '--t-accent', bg: '--t-surface' },
  { label: 'accent text on the page ground', fg: '--t-accent', bg: '--t-canvas' },
  { label: 'accent text on a pale accent panel', fg: '--t-accent', bg: '--t-accent-pale' },
  { label: 'white on the primary action', fg: '--t-surface', bg: '--t-accent' },
  { label: 'white on the primary action while hovered', fg: '--t-surface', bg: '--t-accent-hover' },
  { label: 'white on a solid ink button', fg: '--t-surface', bg: '--t-ink' },
  { label: 'white on a solid ink button while hovered', fg: '--t-surface', bg: '--t-ink-hover' },
];

/** A control's own boundary, which WCAG 1.4.11 puts at 3:1 rather than 4.5:1. */
const BOUNDARY_PAIRS: readonly Pair[] = [
  { label: 'an outline button\'s frame on a card', fg: '--t-line-strong', bg: '--t-surface' },
  { label: 'an outline button\'s frame on the ground', fg: '--t-line-strong', bg: '--t-canvas' },
  { label: 'a form control\'s edge on a card', fg: '--t-field-line', bg: '--t-surface' },
  { label: 'a form control\'s edge on the ground', fg: '--t-field-line', bg: '--t-canvas' },
];

test('contrast: every theme clears AA for body text, the chips and the primary action', () => {
  for (const [theme, tokens] of tokensPerTheme()) {
    for (const pair of TEXT_PAIRS) {
      const ratio = contrastRatio(tokenOf(tokens, pair.fg, theme), tokenOf(tokens, pair.bg, theme));
      assert.ok(
        ratio >= 4.5,
        `${theme}: ${pair.label} measures ${ratio.toFixed(2)}:1, below the 4.5:1 AA bar. Darken the value, or record the shortfall deliberately in docs-internal/design/THEMES.md — do not round it up here.`,
      );
    }
  }
});

test('contrast: a boundary clears 3:1 in every theme that claims one', () => {
  const expectedMinimum = 3;
  for (const [theme, tokens] of tokensPerTheme()) {
    for (const pair of BOUNDARY_PAIRS) {
      const ratio = contrastRatio(tokenOf(tokens, pair.fg, theme), tokenOf(tokens, pair.bg, theme));
      if (theme.startsWith('the default')) {
        // `soft` IS the pre-theme palette and is pinned byte-for-byte above. Its
        // hairlines measure well under 3:1, which is a PRE-EXISTING shortfall of
        // the shipped look — recorded in THEMES.md, not "fixed", because raising
        // them would redesign the page every visitor sees. Pinned as a number so
        // it stays a known one.
        assert.ok(
          ratio < expectedMinimum,
          `the default theme's ${pair.label} now measures ${ratio.toFixed(2)}:1 and clears 3:1 — that IS a change to the default look. Update the :root pin and docs-internal/design/THEMES.md in the same change.`,
        );
        continue;
      }
      assert.ok(
        ratio >= expectedMinimum,
        `${theme}: ${pair.label} measures ${ratio.toFixed(2)}:1, below the 3:1 bar for a control's own boundary`,
      );
    }
  }
});

// ── 4. Colour is not the only carrier ───────────────────────────────────────

const CARD_PAGE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'src',
  'app',
  'p',
  '[slug]',
  'page.tsx',
);

/**
 * In `premium`, an offer chip and a need chip are the SAME colour on purpose
 * (globals.css says why). That is only honest while the group a chip belongs to
 * is ANNOUNCED: a heading above a list names the section, but it does not name
 * the list, so a screen reader moving by list would hear unattached chips. The
 * card therefore labels each list with its own heading, and the two headings are
 * different words in every locale. Both facts are pinned here because each is one
 * attribute or one string away from vanishing in a "cleanup" that leaf-colour,
 * overflow, tap-target and axe gates would all still call green.
 */
test('chips: each group is named, and the two group names differ in every locale', () => {
  const source = readFileSync(CARD_PAGE, 'utf8');

  assert.ok(
    source.includes('aria-labelledby={headingId}'),
    'each chip list must be labelled by its own heading (aria-labelledby={headingId}). Without it the offers and needs groups are distinguishable only by position in premium, where their colours are identical. If this markup was refactored, update this pin to the new mechanism — do not delete it.',
  );
  assert.ok(
    /const headingId = `\$\{testId\}-title`/.test(source),
    'the heading id must be derived from the section testId; that derivation is what keeps the ids unique without a second prop to keep in sync.',
  );

  const testIds = [...source.matchAll(/testId="(pubcard-[a-z]+)"/g)].map((match) => match[1]!);
  assert.ok(testIds.length >= 3, `expected at least three named chip groups, found ${testIds.length}`);
  assert.equal(
    new Set(testIds).size,
    testIds.length,
    'chip group testIds must be unique, or two groups would share one heading id and one accessible name',
  );

  // The two labels that CARRY the offers/needs difference. Merging them (or
  // dropping one in a locale) would leave position as the only difference.
  const labels: ReadonlyArray<{ locale: string; offers: string | undefined; needs: string | undefined }> = [
    { locale: 'en', offers: en['pubcard.helpTitle'], needs: en['pubcard.lookingFor'] },
    { locale: 'ru', offers: ru['pubcard.helpTitle'], needs: ru['pubcard.lookingFor'] },
    { locale: 'es', offers: es['pubcard.helpTitle'], needs: es['pubcard.lookingFor'] },
  ];
  for (const { locale, offers, needs } of labels) {
    assert.ok(typeof offers === 'string' && offers.length > 0, `${locale} has no pubcard.helpTitle`);
    assert.ok(typeof needs === 'string' && needs.length > 0, `${locale} has no pubcard.lookingFor`);
    assert.notEqual(offers, needs, `${locale}: the offers and the needs headings must differ in text, not only in place`);
  }
});
