import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { en } from '../../src/i18n/en';
import { ru } from '../../src/i18n/ru';
import { es } from '../../src/i18n/es';

/**
 * Design review — the acceptance gate for the three themes.
 *
 * Everything in the bar is VERIFIED here rather than asserted in a report: axe
 * (including its colour-contrast rule) on the card and the event in each theme,
 * horizontal overflow at 390px and 360px, the 44px touch targets, the review
 * bar's geometry against the primary action it must never cover, the default
 * look being untouched, and the labels being localized. The numbers it measures
 * are written to evidence/design-themes/measurements.json and the screenshots to
 * evidence/design-themes/ — that pair is the evidence, and a reviewer can re-read
 * it without re-running the suite.
 *
 * WHY 390 AND 360 ARE MEASURED, NOT ASSUMED. The owner judges this on a phone.
 * 390×844 is the iPhone 14 class; 360×740 is the widest "small Android" that
 * still sells. A bar with four controls plus a label is exactly the kind of thing
 * that fits at one and wraps, overflows, or covers an action at the other.
 *
 * The bar is rendered by the root layout at the END of the document (never
 * fixed/sticky — see src/components/theme-bar.tsx for why), so the geometry
 * assertions here are deliberately absolute: the bar must start BELOW the card's
 * bottom edge, which is a stronger statement than "it does not overlap the
 * button" and survives future content changes inside the card.
 */

const THEMES = ['soft', 'swiss', 'poster'] as const;
type Theme = (typeof THEMES)[number];

const EVIDENCE_DIR = path.join(process.cwd(), 'evidence', 'design-themes');
const MOBILE = { width: 390, height: 844 };
const NARROW = { width: 360, height: 740 };

interface Sample {
  theme: Theme | 'none';
  page: 'card' | 'event';
  viewport: string;
  pageWidth: number;
  scrollWidth: number;
  overflowPx: number;
  cardBottom: number;
  titleBottom: number;
  actionTop: number;
  actionBottom: number;
  actionAboveFold: boolean;
  barTop: number | null;
  barBottom: number | null;
  barBelowCard: boolean | null;
  minTapTarget: { name: string; width: number; height: number } | null;
  axeSerious: string[];
  axeContrastNodes: number;
}

const samples: Sample[] = [];

/** A dictionary value that must exist — an empty one is a finding, not a pass. */
function must(value: string | undefined, locale: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`dictionary ${locale} has no value for a theme bar label`);
  }
  return value;
}

/**
 * Hides the `next dev` indicator before a screenshot.
 *
 * The suite runs against `next dev` (playwright.config.ts), and Next's own dev
 * overlay is a fixed-position `nextjs-portal` that lands somewhere inside an
 * element screenshot of a card taller than the viewport. It is not part of the
 * page, it moves between two shots of the SAME page, and it would otherwise make
 * the visitor/themed pair impossible to compare pixel-for-pixel — which is
 * exactly the comparison the evidence folder is for. Re-injected per navigation,
 * because a new document drops it.
 */
async function hideDevOverlay(page: Page) {
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
}

async function waitHydrated(page: Page) {
  await expect(page.locator('html[data-hydrated="true"]')).toBeAttached({ timeout: 30_000 });
}

async function loginViaOtp(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await waitHydrated(page);
  await page.getByTestId('login-email').fill(email);
  const requested = page.waitForResponse(
    (r) => r.url().includes('/api/auth/otp/request') && r.request().method() === 'POST',
  );
  await page.getByTestId('login-request').click();
  const body = (await (await requested).json()) as { devCode?: string };
  if (!body.devCode) throw new Error('devCode missing from the OTP request response');
  await page.getByTestId('login-code').fill(body.devCode);
  await page.getByTestId('login-verify').click();
  await page.waitForURL(/\/(me|onboarding)$/, { timeout: 30_000 });
}

/**
 * An account with a card that exercises every themed element — all three chip
 * kinds, the eyebrow, both button families, muted body text and the accent
 * action — plus an event whose join button is the primary action. Seeded through
 * the public APIs so the fixture is the real shape a reviewer would judge.
 */
async function seed(page: Page, opts: { email: string; name: string; slug: string }): Promise<{ cardPath: string }> {
  await loginViaOtp(page, opts.email);

  // The first save CREATES the profile, which is the only path that needs no
  // `revision` (src/domain/profile.ts requires one to update an existing row).
  const profile = await page.request.post('/api/me/profile', {
    data: {
      display_name: opts.name,
      headline: 'Design systems, one markup per theme',
      company: 'WELCOME',
      short_bio: 'Two lines of body copy so the card has real text at body size in every theme.',
      languages: ['en', 'ru'],
      offer_intents: ['open-to-cofound'],
      need_intents: ['seeking-cofounder'],
      interests: ['ai-ml', 'saas'],
      keywords: ['design systems'],
    },
  });
  expect(profile.status(), await profile.text()).toBe(200);

  const created = await page.request.post('/api/organizer/events', {
    data: {
      name: `Themed Meetup ${opts.slug}`,
      slug: opts.slug,
      mode: 'offline',
      access_mode: 'public',
      timezone: 'UTC',
      description: 'A description at body size, long enough to wrap on a phone.',
    },
  });
  expect(created.status(), await created.text()).toBe(201);

  await page.goto('/me');
  await waitHydrated(page);
  const publicUrl = (await page.getByTestId('public-url').textContent())?.trim() ?? '';
  expect(publicUrl).toContain('/p/');
  const cardPath = new URL(publicUrl).pathname;
  // The card renders its taxonomy chips only once the profile payload has landed;
  // /p/<slug> is force-dynamic, so a plain reload is the honest way to read it.
  await page.goto(cardPath);
  await waitHydrated(page);
  await expect(page.getByTestId('pubcard-offers')).toBeVisible();
  await expect(page.getByTestId('pubcard-needs')).toBeVisible();
  return { cardPath };
}

/** Outer box of the first match, in CSS pixels, viewport-relative. */
async function box(page: Page, selector: string) {
  const el = page.locator(selector).first();
  if ((await el.count()) === 0) return null;
  const b = await el.boundingBox();
  return b ? { top: b.y, bottom: b.y + b.height, left: b.x, right: b.x + b.width } : null;
}

/**
 * The primary action each page exists for: the card's accent CTA (intro when the
 * viewer shares an event, sign-in otherwise) and the event's join button.
 */
async function measure(page: Page): Promise<Omit<Sample, 'theme' | 'page' | 'viewport' | 'axeSerious' | 'axeContrastNodes'>> {
  const pageWidth = await page.evaluate(() => window.innerWidth);
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const viewportHeight = await page.evaluate(() => window.innerHeight);

  const card = await box(page, '[data-testid="pubcard"], main .card');
  const title = await box(page, '[data-testid="pubcard-name"], main .card h1');
  const action =
    (await box(page, '[data-testid="pubcard-signin-cta"] a, [data-testid="pubcard-intro-cta"]')) ??
    (await box(page, '[data-testid="join-button"]'));
  const bar = await box(page, '[data-testid="theme-bar"]');

  return {
    pageWidth,
    scrollWidth,
    overflowPx: Math.max(0, scrollWidth - pageWidth),
    cardBottom: card?.bottom ?? -1,
    titleBottom: title?.bottom ?? -1,
    actionTop: action?.top ?? -1,
    actionBottom: action?.bottom ?? -1,
    actionAboveFold: action ? action.bottom <= viewportHeight : false,
    barTop: bar?.top ?? null,
    barBottom: bar?.bottom ?? null,
    barBelowCard: bar && card ? bar.top >= card.bottom - 1 : null,
    minTapTarget: null,
  };
}

/** Smallest tap target among the bar's controls — the 44px rule, measured. */
async function smallestTapTarget(page: Page): Promise<Sample['minTapTarget']> {
  const controls = page.locator('[data-testid="theme-bar"] button');
  const count = await controls.count();
  let smallest: { name: string; width: number; height: number } | null = null;
  for (let i = 0; i < count; i += 1) {
    const control = controls.nth(i);
    const b = await control.boundingBox();
    if (!b) continue;
    const name = (await control.getAttribute('data-testid')) ?? `button-${i}`;
    if (!smallest || b.height < smallest.height || b.width < smallest.width) {
      smallest = { name, width: Math.round(b.width), height: Math.round(b.height) };
    }
  }
  return smallest;
}

/** axe, plus the colour-contrast rule called out by name (it is `serious`). */
async function scan(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id} [${v.impact}] ${v.help}`);
  for (const v of results.violations) {
    console.log(`      axe ${v.id} [${v.impact}] ${v.nodes.length} node(s)`);
    for (const node of v.nodes.slice(0, 3)) console.log(`        ${node.html.slice(0, 140)}`);
  }
  const contrast = results.violations.find((v) => v.id === 'color-contrast');
  return { serious, contrastNodes: contrast?.nodes.length ?? 0 };
}

test.beforeAll(() => {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
});

test('design review: card and event hold the bar in all three themes at 390 and 360', async ({ page }) => {
  test.setTimeout(180_000);
  const { cardPath } = await seed(page, {
    email: 'themes-owner@example.org',
    name: 'Themes Owner',
    slug: 'e2e-themed-meetup',
  });

  const problems: string[] = [];

  const targets = [
    { page: 'card' as const, path: cardPath },
    { page: 'event' as const, path: '/e/e2e-themed-meetup' },
  ];

  // The reference pass: no theme cookie and no query, i.e. exactly what a
  // stranger gets. Its numbers are what the themed passes are compared against,
  // so "the review bar moves nothing" is MEASURED rather than argued from the
  // bar's position in the document.
  for (const target of targets) {
    for (const viewport of [MOBILE, NARROW]) {
      await page.setViewportSize(viewport);
      const response = await page.goto(target.path);
      expect(response?.status()).toBe(200);
      await waitHydrated(page);
      await expect(page.getByTestId('theme-bar')).toHaveCount(0);
      const measured = await measure(page);
      const axe = await scan(page);
      samples.push({
        theme: 'none',
        page: target.page,
        viewport: `${viewport.width}`,
        ...measured,
        minTapTarget: null,
        axeSerious: axe.serious,
        axeContrastNodes: axe.contrastNodes,
      });
      if (viewport === MOBILE) {
        const cardSelector = target.page === 'card' ? '[data-testid="pubcard"]' : 'main .card';
        await hideDevOverlay(page);
        await page.locator(cardSelector).first().screenshot({
          path: path.join(EVIDENCE_DIR, `${target.page}-390-visitor.png`),
        });
      }
      console.log(
        `[themes] none ${target.page} @${viewport.width}: cardBottom=${measured.cardBottom} title=${measured.titleBottom} action=${measured.actionTop}–${measured.actionBottom} overflow=${measured.overflowPx}px axe=${axe.serious.length}`,
      );
    }
  }

  for (const theme of THEMES) {
    for (const target of targets) {
      for (const viewport of [MOBILE, NARROW]) {
        const label = `${viewport.width}`;
        // The viewport decides the layout, so it is set BEFORE the document is
        // fetched: measuring a 390px layout in a 1280px window and then resizing
        // would measure the wrong thing.
        await page.setViewportSize(viewport);
        // `?theme=` is what ENTERS review mode; the cookie it sets carries the
        // theme onward, not backward — so each visit states it explicitly.
        const response = await page.goto(`${target.path}?theme=${theme}`);
        expect(response?.status(), `${target.page} ${theme}`).toBe(200);
        await waitHydrated(page);

        // The bar must be there, and must announce which theme is on.
        await expect(page.getByTestId('theme-bar')).toBeVisible();
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        await expect(page.getByTestId(`theme-option-${theme}`)).toHaveAttribute('aria-pressed', 'true');

        const measured = await measure(page);
        const axe = await scan(page);
        const tap = await smallestTapTarget(page);
        samples.push({
          theme,
          page: target.page,
          viewport: label,
          ...measured,
          minTapTarget: tap,
          axeSerious: axe.serious,
          axeContrastNodes: axe.contrastNodes,
        });

        const where = `${theme} ${target.page} @${label}`;
        if (measured.overflowPx > 0) {
          problems.push(`${where}: horizontal overflow of ${measured.overflowPx}px (scrollWidth ${measured.scrollWidth})`);
        }
        if (measured.barTop !== null && measured.barTop < measured.cardBottom - 1) {
          problems.push(`${where}: the bar (top ${measured.barTop}) starts above the card's bottom (${measured.cardBottom})`);
        }
        if (measured.barTop !== null && measured.actionBottom > 0 && measured.barTop < measured.actionBottom - 1) {
          problems.push(`${where}: the bar covers the primary action (bar ${measured.barTop} < action bottom ${measured.actionBottom})`);
        }
        if (measured.actionTop < 0) problems.push(`${where}: the primary action was not found`);
        if (axe.serious.length > 0) problems.push(`${where}: ${axe.serious.join(' | ')}`);
        if (tap && (tap.height < 44 || tap.width < 44)) {
          problems.push(`${where}: tap target ${tap.name} is ${tap.width}×${tap.height}, below 44px`);
        }

        // The screenshots that go in the evidence folder: the judged element at
        // 390px (only there — 360 is a layout probe, not a deliverable).
        if (viewport === MOBILE) {
          const cardSelector = target.page === 'card' ? '[data-testid="pubcard"]' : 'main .card';
          await hideDevOverlay(page);
          await page.locator(cardSelector).first().screenshot({
            path: path.join(EVIDENCE_DIR, `${target.page}-390-${theme}.png`),
          });
          await page.screenshot({ path: path.join(EVIDENCE_DIR, `${target.page}-390-${theme}-firstscreen.png`) });
          console.log(
            `[themes] ${where}: cardBottom=${measured.cardBottom} title=${measured.titleBottom} action=${measured.actionTop}–${measured.actionBottom} bar=${measured.barTop} overflow=${measured.overflowPx}px axe=${axe.serious.length}`,
          );
        }
      }
    }
  }

  // Geometry is the one thing a theme is NOT allowed to change about the
  // default: the un-themed pass and `?theme=soft` must lay out identically. (A
  // real theme does move the card by 2px per extra border pixel — swiss 2px,
  // poster 3px — which is why this compares against the un-themed pass rather
  // than asserting a shared constant.)
  for (const target of targets) {
    for (const viewport of [`${MOBILE.width}`, `${NARROW.width}`]) {
      const find = (theme: Sample['theme']) =>
        samples.find((s) => s.theme === theme && s.page === target.page && s.viewport === viewport);
      const plain = find('none');
      const soft = find('soft');
      if (!plain || !soft) continue;
      for (const key of ['cardBottom', 'titleBottom', 'actionTop', 'actionBottom'] as const) {
        if (Math.abs(plain[key] - soft[key]) > 0.5) {
          problems.push(
            `${target.page} @${viewport}: theme=soft moved ${key} to ${soft[key]} from the visitor's ${plain[key]}`,
          );
        }
      }
    }
  }

  // Written BEFORE the assertions: evidence has to survive a failing run.
  writeFileSync(
    path.join(EVIDENCE_DIR, 'measurements.json'),
    `${JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        note: 'Measured in Chromium at 390x844 and 360x740 by tests/e2e/design-themes.spec.ts. Theme "none" is the visitor pass (no cookie, no query, no bar). overflowPx > 0 or a bar above cardBottom would be a failure, not a tolerance.',
        samples,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  expect(problems, `design-review findings:\n${problems.join('\n')}`).toEqual([]);
});

test('design review: the default look is untouched, and a visitor sees no bar', async ({ page }) => {
  test.setTimeout(120_000);
  const { cardPath } = await seed(page, {
    email: 'themes-default@example.org',
    name: 'Default Look',
    slug: 'e2e-themed-default',
  });
  await page.setViewportSize(MOBILE);

  /** The computed style of the elements a theme is allowed to change. */
  const computedStyles = () =>
    page.evaluate(() => {
      const props = [
        'backgroundColor',
        'color',
        'borderTopColor',
        'borderTopWidth',
        'borderTopLeftRadius',
        'boxShadow',
        'fontSize',
        'fontWeight',
        'letterSpacing',
        'lineHeight',
        'fontFamily',
      ] as const;
      const selectors = [
        'body',
        '[data-testid="pubcard"]',
        '[data-testid="pubcard-name"]',
        '[data-testid="pubcard-bio"]',
        '.chip',
        '.chip-offer',
        '.chip-need',
        '.eyebrow',
        '[data-testid="pubcard-vcard"]',
        '[data-testid="pubcard-signin-cta"] a',
      ];
      const out: Record<string, Record<string, string>> = {};
      for (const selector of selectors) {
        const el = document.querySelector(selector);
        if (!el) {
          out[selector] = { missing: 'true' };
          continue;
        }
        const style = getComputedStyle(el);
        const entry: Record<string, string> = {};
        for (const prop of props) entry[prop] = style[prop];
        out[selector] = entry;
      }
      return out;
    });

  // 1. A visitor: no theme cookie, no query — no attribute, no bar, no change.
  await page.context().clearCookies();
  await page.goto(cardPath);
  await waitHydrated(page);
  const visitorHtml = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  expect(visitorHtml, 'an un-themed page must carry no data-theme attribute at all').toBeNull();
  await expect(page.getByTestId('theme-bar')).toHaveCount(0);
  const visitorStyles = await computedStyles();
  // The visitor's reference screenshots (card and event) are taken by the first
  // test's un-themed pass, so there is exactly one "today" image per surface.

  // 2. Explicit `soft` — the same theme by name. Byte-identical computed styles,
  //    so an explicit choice of the default cannot drift from the default.
  await page.goto(`${cardPath}?theme=soft`);
  await waitHydrated(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'soft');
  await expect(page.getByTestId('theme-bar')).toBeVisible();
  const softStyles = await computedStyles();
  expect(softStyles, 'theme=soft must compute exactly the same styles as no theme at all').toEqual(visitorStyles);

  // 3. The switcher persists the choice in a cookie, DROPS the query override
  //    (which would otherwise keep winning over the cookie on the reload and make
  //    the switcher look broken), and the bar follows the reviewer onto a page the
  //    query override does not cover (/e/<slug>).
  const posted = page.waitForResponse((r) => r.url().includes('/api/theme') && r.request().method() === 'POST');
  await page.getByTestId('theme-option-poster').click();
  expect((await posted).status()).toBe(200);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'poster');
  expect(new URL(page.url()).searchParams.get('theme'), 'the switched URL must not keep the stale query override').toBeNull();
  const cookies = await page.context().cookies();
  expect(cookies.find((c) => c.name === 'welcome_theme')?.value).toBe('poster');
  await page.goto('/e/e2e-themed-default');
  await waitHydrated(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'poster');
  await expect(page.getByTestId('theme-bar')).toBeVisible();

  // 4. Leaving review mode clears the cookie, and the card goes back to being
  //    exactly the page a visitor gets — measured on the card, the surface the
  //    reference styles were taken from.
  const cleared = page.waitForResponse((r) => r.url().includes('/api/theme') && r.request().method() === 'POST');
  await page.getByTestId('theme-exit').click();
  expect((await cleared).status()).toBe(200);
  // Wait for the reload's effect before reading the jar: the bar disappearing
  // proves the NEW document is the one being asserted about.
  await expect(page.getByTestId('theme-bar')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBeNull();
  expect((await page.context().cookies()).find((c) => c.name === 'welcome_theme')?.value ?? '').toBe('');
  await page.goto(cardPath);
  await waitHydrated(page);
  await expect(page.getByTestId('theme-bar')).toHaveCount(0);
  expect(await computedStyles()).toEqual(visitorStyles);

  // 5. An invalid theme is ignored on both channels: no attribute, no bar, and
  //    nothing remembered.
  await page.goto(`${cardPath}?theme=dark`);
  await waitHydrated(page);
  expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBeNull();
  await expect(page.getByTestId('theme-bar')).toHaveCount(0);
  expect((await page.context().cookies()).find((c) => c.name === 'welcome_theme')).toBeUndefined();
});

test('design review: the bar is localized, and says what it is', async ({ page }) => {
  test.setTimeout(120_000);
  const { cardPath } = await seed(page, {
    email: 'themes-locale@example.org',
    name: 'Locale Owner',
    slug: 'e2e-themed-locale',
  });

  // The card is one of the four public entry points both overrides cover, so a
  // single URL carries language AND theme — which is also how the owner would
  // check a Russian or Spanish review. `must` also fails loudly if a dictionary
  // lost one of these keys, so an untranslated bar cannot pass by rendering an
  // empty string.
  const cases = [
    { lang: 'en', bar: must(en['theme.bar'], 'en'), soft: must(en['theme.soft'], 'en'), exit: must(en['theme.exit'], 'en') },
    { lang: 'ru', bar: must(ru['theme.bar'], 'ru'), soft: must(ru['theme.soft'], 'ru'), exit: must(ru['theme.exit'], 'ru') },
    { lang: 'es', bar: must(es['theme.bar'], 'es'), soft: must(es['theme.soft'], 'es'), exit: must(es['theme.exit'], 'es') },
  ];
  for (const labels of cases) {
    await page.goto(`${cardPath}?lang=${labels.lang}&theme=soft`);
    await waitHydrated(page);
    const bar = page.getByTestId('theme-bar');
    await expect(bar).toBeVisible();
    await expect(bar).toContainText(labels.bar);
    await expect(bar).toContainText(labels.soft);
    await expect(bar).toContainText(labels.exit);
    // The names are distinct words, not the English ones smuggled through.
    const names = await page.locator('[data-testid="theme-switcher"] button').allTextContents();
    expect(names).toHaveLength(3);
    for (const name of names) expect(name.trim().length).toBeGreaterThan(0);
    console.log(`[themes] ${labels.lang}: ${names.map((n) => n.trim()).join(' / ')}`);
  }
});
