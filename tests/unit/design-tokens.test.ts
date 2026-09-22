import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { en } from '../../src/i18n/en';
import { ru } from '../../src/i18n/ru';
import { es } from '../../src/i18n/es';

/**
 * The design layer's claims, all machine-checked here:
 *
 *   1. THE TOKEN LAYER IS INTACT AND SINGLE. `--t-*` in globals.css is the only
 *      place a colour, radius, shadow or type weight is written down, `@theme`
 *      maps the utilities onto it, and there is exactly ONE value set. A second
 *      look is a block of values for the same names — the mechanism that made
 *      four directions comparable — so this file pins both halves: the shipped
 *      values, and the fact that nothing selects another set (no `data-theme`
 *      attribute anywhere in src/).
 *   2. THE SHIPPED LOOK DOES NOT DRIFT. A static pin on the `:root` values: the
 *      design ships as tokens now, and without a pin, moving one `:root` value
 *      would restyle every page in the product with every other gate still
 *      green.
 *   3. CONTRAST — the AA pairs (body text, the chip ink, the primary action) are
 *      computed from the token values themselves, so a colour that "looks fine"
 *      cannot ship below the bar. This is the same measurement the values were
 *      chosen by (docs-internal/design/THEMES.md), turned into an assertion
 *      instead of a table nobody re-derives.
 *   4. COLOUR IS NOT THE ONLY CARRIER — the design is allowed to paint two chip
 *      kinds with the same value (the token set makes that a choice, not an
 *      accident), so the group a chip belongs to has to be announced. The card
 *      names each chip list by its heading, and the group headings are distinct,
 *      non-empty strings in all three locales. Both are pinned here, because the
 *      difference is one attribute and one string away from disappearing in a
 *      "cleanup" that every other gate would call green.
 */

// ── 1. The token layer, and the fact that it is single ──────────────────────

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
 * The shipped token values. These are the design: one colour, radius, shadow or
 * type weight may not move here without moving the product's look, which is why
 * the whole set is deep-equal pinned rather than sampled.
 */
const SHIPPED_TOKENS: Record<string, string> = {
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
  // Tailwind's defaults for shape and voice, so computed styles match the
  // pre-token look exactly rather than approximately.
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

test('tokens: the shipped design still carries the values it ships', () => {
  const css = stripComments(readFileSync(GLOBALS_CSS, 'utf8'));
  const root = declarationsOf(ruleBody(css, ':root'));
  assert.deepEqual(
    root,
    SHIPPED_TOKENS,
    'The token layer is the product\'s look. Changing a value here restyles every page — do it deliberately, and update docs-internal/design/THEMES.md in the same change.',
  );
});

test('tokens: @theme maps the utilities onto the tokens, not onto literals', () => {
  const css = stripComments(readFileSync(GLOBALS_CSS, 'utf8'));
  const theme = declarationsOf(ruleBody(css, '@theme'));
  // The mapping is what lets markup say `bg-ink` and `text-muted` instead of a
  // colour, and it is the half that made comparing four directions cheap. A few
  // of the names must be indirections, not copies: if one is ever inlined to a
  // literal, that utility stops following the token layer.
  for (const [utility, token] of [
    ['--color-paper', '--t-canvas'],
    ['--color-ink', '--t-ink'],
    ['--color-muted', '--t-muted'],
    ['--color-accent', '--t-accent'],
    ['--color-pine', '--t-pine'],
    ['--radius-xl', '--t-radius-xl'],
    ['--shadow-sm', '--t-shadow-card'],
    ['--font-weight-extrabold', '--t-heading-weight'],
    ['--tracking-tight', '--t-heading-tracking'],
  ] as const) {
    assert.equal(
      theme[utility],
      `var(${token})`,
      `${utility} must resolve through ${token}; a literal here is a colour that stopped following the token layer`,
    );
  }
  // Deliberately NOT `@theme inline`: plain CSS and the inline `var(--color-*)`
  // styles some components carry must keep resolving.
  assert.equal(css.includes('@theme inline'), false, '@theme must stay non-inline');
});

test('tokens: nothing selects a second value set — no data-theme anywhere in src/', () => {
  const css = stripComments(readFileSync(GLOBALS_CSS, 'utf8'));
  assert.equal(
    /\[data-theme/.test(css),
    false,
    'globals.css must carry ONE token set: a `[data-theme]` selector is how a second look gets selected, and the review that needed it is over (docs-internal/design/THEMES.md has the recipe to add one back deliberately).',
  );

  // The same statement about the app: no page, component or route may set the
  // attribute the CSS would key on. Comments are stripped first — globals.css and
  // layout.tsx both *explain* in prose that no such attribute exists, and prose is
  // not a selector. Walked, not grepped through a shell, so the pin travels with
  // the test suite.
  const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
  const withoutComments = (source: string) =>
    // `[^:]` keeps `https://…` in a string literal from reading as a line comment.
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const offenders: string[] = [];
  for (const entry of readdirSync(srcDir, { recursive: true, encoding: 'utf8' })) {
    if (!/\.(ts|tsx|css)$/.test(entry)) continue;
    const source = readFileSync(path.join(srcDir, entry), 'utf8');
    if (withoutComments(source).includes('data-theme')) offenders.push(entry);
  }
  assert.deepEqual(
    offenders,
    [],
    `these files write or key on data-theme: ${offenders.join(', ')} — the product ships ONE design, and a switcher has to be a deliberate change (see the add-a-theme recipe in docs-internal/design/THEMES.md), not a stray attribute`,
  );
});

// ── 2. Contrast, computed from the tokens themselves ────────────────────────

/**
 * The colour literals in globals.css are hex and `oklch(...)` — the `oklch` ones
 * because the offer/need chips kept Tailwind's own literals. Both have to
 * resolve to sRGB before a ratio exists, so this is a small, exact
 * implementation of the CSS Color 4 and WCAG 2.1 maths rather than a dependency
 * (the project has no new runtime dependencies, and a devDependency that only
 * ever answers one question is worse than twenty lines that can be read).
 *
 * WHY THIS IS THE SAME MEASUREMENT THE VALUES WERE CHOSEN BY. Run against the
 * numbers already recorded in docs-internal/design/THEMES.md, the hex path
 * reproduces every one of them to within 0.005 — so this is the same yardstick,
 * turned into an assertion. The only figures that differ are the four `oklch`
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
    `globals.css carries a colour literal this test cannot measure (${value}). Add it to parseColour rather than skipping the measurement.`,
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

/** The shipped design's tokens, read from `:root`. */
function shippedTokens(): Record<string, string> {
  return declarationsOf(ruleBody(stripComments(readFileSync(GLOBALS_CSS, 'utf8')), ':root'));
}

function tokenOf(tokens: Record<string, string>, name: string): string {
  const value = tokens[name];
  if (typeof value !== 'string') {
    throw new Error(`${name} is missing from the token layer; every pair below is asserted against it`);
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

test('contrast: the shipped design clears AA for body text, the chips and the primary action', () => {
  const tokens = shippedTokens();
  for (const pair of TEXT_PAIRS) {
    const ratio = contrastRatio(tokenOf(tokens, pair.fg), tokenOf(tokens, pair.bg));
    assert.ok(
      ratio >= 4.5,
      `${pair.label} measures ${ratio.toFixed(2)}:1, below the 4.5:1 AA bar. Darken the value, or record the shortfall deliberately in docs-internal/design/THEMES.md — do not round it up here.`,
    );
  }
});

test('contrast: the hairlines are the recorded sub-3:1 shortfall, unchanged', () => {
  // The two hairlines under 3:1 are the SHIPPED design's own, recorded rather
  // than raised: `--t-line-strong` and `--t-field-line` frame real controls
  // (.input, .btn-outline), so 1.85:1 on a card is a genuine shortfall of the
  // design that ships — documented with its numbers in THEMES.md and pinned as
  // a number here, so it stays known. Raising them IS a redesign of every page,
  // which is why the assertion is the other way round.
  const tokens = shippedTokens();
  const expectedMinimum = 3;
  for (const pair of BOUNDARY_PAIRS) {
    const ratio = contrastRatio(tokenOf(tokens, pair.fg), tokenOf(tokens, pair.bg));
    assert.ok(
      ratio < expectedMinimum,
      `${pair.label} now measures ${ratio.toFixed(2)}:1 and clears 3:1 — that IS a change to the shipped look. Update the token pin and docs-internal/design/THEMES.md in the same change.`,
    );
  }
});

// ── 3. Colour is not the only carrier ───────────────────────────────────────

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
 * The token layer lets a design paint an offer chip and a need chip with the
 * SAME value (globals.css says why that is a choice). That is only honest while
 * the group a chip belongs to is ANNOUNCED: a heading above a list names the
 * section, but it does not name the list, so a screen reader moving by list
 * would hear unattached chips. The card therefore labels each list with its own
 * heading, and the two headings are different words in every locale. Both facts
 * are pinned here because each is one attribute or one string away from
 * vanishing in a "cleanup" that leaf-colour, overflow, tap-target and axe gates
 * would all still call green.
 */
test('chips: each group is named, and the two group names differ in every locale', () => {
  const source = readFileSync(CARD_PAGE, 'utf8');

  assert.ok(
    source.includes('aria-labelledby={headingId}'),
    'each chip list must be labelled by its own heading (aria-labelledby={headingId}). Without it the offers and needs groups are distinguishable only by position when their colours are equal. If this markup was refactored, update this pin to the new mechanism — do not delete it.',
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
