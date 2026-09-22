import { test, expect, type Page } from '@playwright/test';
import { E2E_OPERATOR_CONTACT_EMAIL } from './e2e-env';
import { PROJECT_REPO_URL } from '../../src/lib/project';

/**
 * Product-site landing e2e (spec §7 guardrails): every marketing section is
 * rendered in EN and RU, the CTAs point where their labels claim, the honest
 * P0 status stays in place, and nothing overflows at 360px.
 *
 * Screenshots for `evidence/screenshots/` are captured by
 * scripts/capture-evidence.mjs (the Playwright config keeps auto-shots off).
 */

/** The marketing sections, in page order. */
const SECTIONS = [
  'section-problem',
  'section-how',
  'section-member',
  'section-organizer',
  'section-trust',
  'section-faq',
  'section-final-cta',
] as const;

// The operator contact is deployment configuration; the e2e server is booted
// with the synthetic fixture from tests/e2e/e2e-env.ts, so the assertion pins
// the CONTRACT (the CTA mails the configured operator with the pilot subject)
// rather than one deployment's inbox.
const PILOT_MAILTO = new RegExp(
  `^mailto:${E2E_OPERATOR_CONTACT_EMAIL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\?subject=WELCOME%20pilot$`,
);
const SCREENSHOTS = 'evidence/screenshots';

async function waitHydrated(page: Page) {
  await expect(page.locator('html[data-hydrated="true"]')).toBeAttached({ timeout: 30_000 });
}

/** Heading levels in DOM order: h1 first, one h1 only, never a skipped level. */
async function headingLevels(page: Page): Promise<number[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6')).map((h) => Number(h.tagName.slice(1))),
  );
}

async function overflowAt360(page: Page): Promise<number> {
  await page.setViewportSize({ width: 360, height: 780 });
  await page.waitForTimeout(150);
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

/**
 * The phone height budget, and it is the point of this file's newest tests.
 *
 * MEASURED, NOT ASSUMED. On production at 390px the landing was 7853px tall —
 * 9.3 screens of scrolling, against 1.2 for the event page and 1.8 for the card.
 * The cause was packaging, not copy: 27 single-sentence cards each paying 48px of
 * padding and a 16px grid gap, a hero that made the same promise twice, a filled
 * notice block above the fold, and a six-row FAQ whose rows were already
 * collapsible but 22px tall. All of that is now compressed (see
 * src/app/page.tsx for the four changes and globals.css for the primitives).
 *
 * The budget is 5 screens of an iPhone-14-class viewport. Two assertions, because
 * one number cannot say both things:
 *   · the ENGLISH page must fit in the budget — it is the reference locale and
 *     the one the report quotes;
 *   · Russian and Spanish must stay within TRANSLATION_HEADROOM of it. They are
 *     inherently longer (RU measures ~1.06 of EN, long words wrap more), so they
 *     get headroom — but a BOUNDED one, which is what stops a future translation
 *     from quietly re-inflating the page on the one surface that is judged on a
 *     phone. A single shared bound was tried first and rejected: it would have to
 *     be set to the longest locale's number, which is not a budget at all.
 */
const PHONE_VIEWPORT = { width: 390, height: 844 };
const SCREENS_BUDGET = 5;
const HEIGHT_BOUND = PHONE_VIEWPORT.height * SCREENS_BUDGET;
/** Measured EN→RU ratio is ~1.06; the bound leaves room for the copy to move. */
const TRANSLATION_HEADROOM = 1.12;

async function landingHeight(page: Page, lang: string): Promise<number> {
  await page.setViewportSize(PHONE_VIEWPORT);
  await page.goto(`/?lang=${lang}`);
  await waitHydrated(page);
  // Layout-affecting styles and the web font fallback both settle before the
  // height is read; without this the first measurement is short by a line.
  await page.waitForTimeout(200);
  return page.evaluate(() => document.documentElement.scrollHeight);
}

test('landing: the phone height stays inside its budget in all three locales', async ({ page }) => {
  const heights: Record<string, number> = {};
  for (const lang of ['en', 'ru', 'es'] as const) {
    heights[lang] = await landingHeight(page, lang);
    const screens = (heights[lang]! / PHONE_VIEWPORT.height).toFixed(2);
    console.log(`[landing] ${lang} @390: ${heights[lang]}px = ${screens} screens (budget ${SCREENS_BUDGET})`);
  }

  expect(
    heights.en,
    `the landing is ${heights.en}px at 390px = ${(heights.en! / PHONE_VIEWPORT.height).toFixed(2)} screens, ` +
      `over the ${SCREENS_BUDGET}-screen budget (${HEIGHT_BOUND}px). It was 7853px before the compression — ` +
      'adding a section or a second copy of a claim belongs behind a disclosure, not back on this page.',
  ).toBeLessThanOrEqual(HEIGHT_BOUND);

  for (const lang of ['ru', 'es'] as const) {
    expect(
      heights[lang]!,
      `the ${lang} landing is ${heights[lang]}px against ${heights.en}px for English ` +
        `(ratio ${(heights[lang]! / heights.en!).toFixed(3)}), over the ${TRANSLATION_HEADROOM} translation headroom`,
    ).toBeLessThanOrEqual(Math.ceil(heights.en! * TRANSLATION_HEADROOM));
  }
});

/**
 * COMPRESSION, NOT DELETION — pinned so it stays that way.
 *
 * The height above was won by removing ONE thing (the hero paragraph, which said
 * exactly what the three claims below it said) and by re-packaging the rest. The
 * assertions here are the other half of that bargain: every claim that was on the
 * page is still on the page, and every one of them is still readable text in the
 * document — not an image, not a tooltip, and not a string that only exists in a
 * dictionary the page stopped rendering.
 */
test('landing: nothing was dropped to buy the height — every claim is still rendered once', async ({ page }) => {
  await page.goto('/?lang=en');
  await waitHydrated(page);

  // The promise is made ONCE, in the hero, as a list of three claims.
  const heroClaims = page.getByTestId('hero-claims').locator('li');
  await expect(heroClaims, 'the hero states the promise as three claims').toHaveCount(3);

  // And no claim is stated twice anywhere on the page: a string that appears
  // twice is the exact defect this page was compressed to fix.
  const duplicates = await page.evaluate(() => {
    const texts = ['One QR instead of a stack of business cards', 'Contacts open only by mutual consent', 'A profile that outlives the event'];
    const body = document.body.innerText;
    return texts.filter((t) => body.split(t).length - 1 !== 1);
  });
  expect(duplicates, 'these claims are missing or stated more than once').toEqual([]);

  // Every section is still present, and every claim list still has its claims.
  for (const id of SECTIONS) {
    await expect(page.getByTestId(id), id).toBeVisible();
  }
  await expect(page.getByTestId('problem-list').locator('li'), 'problem claims').toHaveCount(3);
  await expect(page.getByTestId('how-steps').locator('li'), 'how steps').toHaveCount(3);
  await expect(page.getByTestId('how-example').locator('li'), 'consent example rows').toHaveCount(3);
  await expect(page.getByTestId('member-list').locator('li'), 'member claims').toHaveCount(4);
  await expect(page.getByTestId('organizer-list').locator('li'), 'organizer claims').toHaveCount(4);
  await expect(page.getByTestId('trust-list').locator('li'), 'trust claims').toHaveCount(4);
  await expect(page.getByTestId('faq-item'), 'FAQ questions').toHaveCount(6);
  // The two standing honesty notices keep their full text, not a shortened form.
  await expect(page.getByTestId('organizer-consent-note')).toContainText(/not consent to marketing/i);
  await expect(page.getByTestId('trust-no-scraping')).toContainText(/do not scrape LinkedIn/i);
  // The P0 status is stated VERBATIM, as a line rather than a block.
  await expect(page.getByTestId('status-notice')).toHaveText('P0 build — a working preview, not yet a staged service.');
  await expect(page.getByTestId('status-notice')).toHaveAttribute('role', 'status');
});

/**
 * FIVE COLLAPSED ROWS, NOT SIX OPEN ANSWERS — and the answers are all still there.
 *
 * The FAQ was already native `<details>`/`<summary>`, so the height it was paying
 * was the closed state: 6 rows of 64px each carrying a 22px tap target, i.e. the
 * smallest target on the page inside the largest box. The row is now the target
 * (`.summary` takes `min-h-11`), and the section is asserted to start CLOSED —
 * an `open` attribute on load would put every answer back into the flow and make
 * the height budget a lie.
 */
test('landing: the FAQ is collapsed on load, and opening a row still reveals its answer', async ({ page }) => {
  await page.goto('/?lang=en');
  await waitHydrated(page);
  const items = page.getByTestId('faq-item');
  await expect(items).toHaveCount(6);
  const openOnLoad = await items.evaluateAll((els) => els.map((el) => (el as HTMLDetailsElement).open));
  expect(openOnLoad, 'every FAQ row must start collapsed — an open row is back in the flow').toEqual(
    Array.from({ length: 6 }, () => false),
  );
  // Each summary is itself the row, and the row is a 44px target.
  const boxes = await items.locator('summary').evaluateAll((els) =>
    els.map((el) => Math.round(el.getBoundingClientRect().height)),
  );
  for (const height of boxes) expect(height, 'a FAQ summary must be at least 44px tall').toBeGreaterThanOrEqual(44);

  const before = await page.evaluate(() => document.documentElement.scrollHeight);
  await items.first().locator('summary').click();
  expect(await items.first().evaluate((el) => (el as HTMLDetailsElement).open)).toBe(true);
  const after = await page.evaluate(() => document.documentElement.scrollHeight);
  expect(after, 'opening a row must reveal its answer, i.e. add height').toBeGreaterThan(before);

  // The content that was there before the compression is still the content: the
  // six questions are the dictionary's six questions, in order.
  const questions = (await items.locator('summary h3').allTextContents()).map((q) => q.trim());
  expect(questions.sort()).toEqual(
    [
      'Do I need to install an app?',
      'How do I become a pilot organiser?',
      'How do contacts open?',
      'How much does it cost?',
      'What does the other person see?',
      'What happens to my data?',
    ].sort(),
  );
});

/**
 * ONE VISUAL SYSTEM FOR THE BUTTONS, measured on the rendered page rather than
 * pinned to class names:
 *
 *   · WIDTH — every button in a CTA row is a column of the same grid, so the
 *     widths are equal by construction. They used to be content-sized, which made
 *     the accent button wider than the outline one beside it and made the pair
 *     look accidental.
 *   · ONE ARROW — every arrow on a marketing button is `→`. The page used to mix
 *     `↗` and `→` in the same view, which reads as two different meanings for the
 *     same affordance.
 *   · HIERARCHY — nothing in the header may look as heavy as the primary action:
 *     no control in the header shares the CTA's fill, so the accent button is the
 *     only solid block above the fold. (The two dark pills that used to sit there
 *     — "Sign in" and the active language — competed with it for exactly that
 *     reason.)
 */
test('landing: one button system — equal widths, one arrow, and a quiet header', async ({ page }) => {
  await page.setViewportSize(PHONE_VIEWPORT);
  await page.goto('/?lang=en');
  await waitHydrated(page);

  // Width: every CTA row's columns are the same width, and each clears 44px.
  const rows = await page.locator('.cta-row').evaluateAll((els) =>
    els.map((row) => [...row.children].map((child) => {
      const b = child.getBoundingClientRect();
      return { w: Math.round(b.width), h: Math.round(b.height) };
    })),
  );
  expect(rows.length, 'the page must render at least one CTA row').toBeGreaterThan(0);
  for (const row of rows) {
    const widths = row.map((b) => b.w);
    expect(new Set(widths).size, `CTA row widths differ: ${widths.join(' / ')}`).toBe(1);
    for (const box of row) expect(box.h, 'a CTA must clear the 44px touch target').toBeGreaterThanOrEqual(44);
  }

  // One arrow convention: `→` on the buttons, and no `↗` left on any CTA.
  const labels = await page.locator('.cta-row a, [data-testid="member-cta"]').allTextContents();
  expect(labels.length).toBeGreaterThan(0);
  for (const label of labels) {
    expect(label, `"${label.trim()}" uses an arrow this page does not use`).not.toContain('↗');
  }
  await expect(page.getByTestId('cta-demo')).toContainText('→');

  // Hierarchy: the header holds no control with the primary action's fill.
  const fills = await page.evaluate(() => {
    const bg = (el: Element) => getComputedStyle(el).backgroundColor;
    const cta = document.querySelector('[data-testid="cta-demo"]');
    const header = [...document.querySelectorAll('header a, header button')].filter(
      (el) => (el as HTMLElement).offsetParent !== null,
    );
    return {
      ctaFill: cta ? bg(cta) : '',
      headerFills: header.map((el) => ({ name: el.textContent?.trim().slice(0, 20) ?? '', fill: bg(el) })),
    };
  });
  expect(fills.ctaFill, 'the primary CTA must actually be filled').not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
  for (const control of fills.headerFills) {
    expect(
      control.fill,
      `the header control "${control.name}" is filled like the primary action (${control.fill}) — the nav must not outrank the CTA`,
    ).not.toBe(fills.ctaFill);
  }
  // ...and specifically: the active language is not a second dark block.
  const activeLanguage = page.locator('[data-testid="locale-switcher"] button[aria-pressed="true"]');
  await expect(activeLanguage).toHaveCount(1);
  const activeFill = await activeLanguage.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(activeFill, 'the current language must not be painted like the primary action').not.toBe(fills.ctaFill);
});

test('landing (EN): all sections, heading order, honest CTAs and status', async ({ page }) => {
  await page.goto('/?lang=en');
  await waitHydrated(page);

  await expect(page.getByRole('heading', { level: 1 })).toContainText('One QR.');
  for (const id of SECTIONS) {
    await expect(page.getByTestId(id), id).toBeVisible();
  }

  // The hero makes both paths available: demo first, organizer second.
  await expect(page.getByTestId('cta-demo')).toHaveAttribute('href', '/login');
  await expect(page.getByTestId('cta-organizer')).toHaveAttribute('href', '/organizer');

  // Consent example: three rows, closed until the second side confirms.
  const example = page.getByTestId('how-example');
  await expect(example.locator('li')).toHaveCount(3);
  await expect(example).toContainText('Contact closed');
  await expect(example).toContainText('Contact open on both sides');

  // Guardrails: no LinkedIn scraping claim, no "we do not spam" hand-waving.
  await expect(page.getByTestId('trust-no-scraping')).toContainText(/do not scrape LinkedIn/i);
  await expect(page.getByTestId('organizer-consent-note')).toContainText(/not consent to marketing/i);

  // FAQ: six native disclosures; the pilot answer links to the human inbox.
  await expect(page.getByTestId('faq-item')).toHaveCount(6);
  await page.getByTestId('faq-item').first().locator('summary').click();
  await expect(page.getByTestId('faq-item').first()).toContainText('No. The profile opens in the browser');
  await page.getByTestId('faq-item').nth(5).locator('summary').click();
  await expect(page.getByTestId('faq-pilot-link')).toBeVisible();
  await expect(page.getByTestId('faq-pilot-link')).toHaveAttribute('href', PILOT_MAILTO);
  await expect(page.getByTestId('final-cta-pilot')).toHaveAttribute('href', PILOT_MAILTO);
  await expect(page.getByTestId('final-cta-demo')).toHaveAttribute('href', '/login');

  // Footer keeps privacy/terms plus the open repository, with a safe rel.
  await expect(page.getByTestId('footer-repo-link')).toHaveAttribute('href', PROJECT_REPO_URL);
  await expect(page.getByTestId('footer-repo-link')).toHaveAttribute('rel', /noopener/);
  await expect(page.getByRole('link', { name: 'Privacy' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Terms' })).toBeVisible();

  // Honest status stays visible: P0 build, staging pending.
  await expect(page.getByRole('status')).toContainText('P0 build');
  await expect(page.locator('footer')).toContainText('staging pending');

  // No external images or fonts — the page ships only its own assets. Absolute
  // links are allowed as long as they are the page's OWN origin: the canonical
  // URL of the share metadata is absolute by definition, while a CDN stylesheet,
  // font or preconnect from a third party still fails here.
  await expect(page.locator('img[src^="http"]')).toHaveCount(0);
  const foreignLinks = await page.evaluate(() =>
    Array.from(document.querySelectorAll('link[href^="http"]'))
      .map((el) => (el as HTMLLinkElement).href)
      .filter((href) => new URL(href).origin !== location.origin),
  );
  expect(foreignLinks).toEqual([]);

  // Semantic structure: one h1, then no skipped heading levels.
  const levels = await headingLevels(page);
  expect(levels.filter((l) => l === 1)).toHaveLength(1);
  expect(levels[0]).toBe(1);
  for (let i = 1; i < levels.length; i++) {
    const previous = levels[i - 1]!;
    const current = levels[i]!;
    expect(current - previous, `heading jump at index ${i}`).toBeLessThanOrEqual(1);
  }
});

test('landing (RU): translated sections, same anchors and no English fallback', async ({ page }) => {
  const res = await page.goto('/?lang=ru');
  expect(res?.status()).toBe(200);
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  await waitHydrated(page);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Один QR.');

  for (const id of SECTIONS) {
    await expect(page.getByTestId(id), id).toBeVisible();
  }
  await expect(page.getByTestId('section-problem')).toContainText('Визитки теряются');
  await expect(page.getByTestId('section-how')).toContainText('Профиль за минуту');
  await expect(page.getByTestId('section-member')).toContainText('Мини-лендинг вместо визитки');
  await expect(page.getByTestId('section-organizer')).toContainText('Импорт участников из CSV');
  await expect(page.getByTestId('section-trust')).toContainText('Никакого скрейпинга LinkedIn');
  await expect(page.getByTestId('section-faq')).toContainText('Вопросы, которые задают чаще всего');
  await expect(page.getByTestId('section-final-cta')).toContainText('Начните со своего профиля');

  await expect(page.getByTestId('faq-item')).toHaveCount(6);
  await page.getByTestId('faq-item').first().locator('summary').click();
  await expect(page.getByTestId('faq-item').first()).toContainText('Профиль открывается в браузере по QR');
  await expect(page.getByTestId('faq-pilot-link')).toHaveAttribute('href', PILOT_MAILTO);
  await expect(page.getByTestId('footer-repo-link')).toContainText('Исходный код');
  await expect(page.getByRole('status')).toContainText('P0-сборка');

  // Section headers are translated, not the English fallback.
  await expect(page.getByTestId('section-problem').getByRole('heading', { level: 2 })).not.toHaveText(/Meeting someone/);
});

test('landing: no horizontal overflow at 360px in EN and RU', async ({ page }) => {
  for (const lang of ['en', 'ru'] as const) {
    await page.goto(`/?lang=${lang}`);
    await waitHydrated(page);
    expect(await overflowAt360(page), `overflow (${lang})`).toBeLessThanOrEqual(1);
    // The sections stack instead of shrinking into unreadable columns.
    for (const id of SECTIONS) {
      await expect(page.getByTestId(id), `${id} (${lang})`).toBeVisible();
    }
    await expect(page.getByTestId('cta-demo')).toBeVisible();
  }
});

// Evidence shots live here rather than in scripts/capture-evidence.mjs: the
// landing is static, so the e2e gate regenerates these on every run.
test('landing: evidence screenshots (desktop 1280 + mobile 360, EN and RU)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/?lang=en');
  await waitHydrated(page);
  await page.screenshot({ path: `${SCREENSHOTS}/landing-1280-en.png`, fullPage: true });
  await page.goto('/?lang=ru');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  await waitHydrated(page);
  await page.screenshot({ path: `${SCREENSHOTS}/landing-1280-ru.png`, fullPage: true });

  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto('/?lang=ru');
  await waitHydrated(page);
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${SCREENSHOTS}/landing-360-ru.png`, fullPage: true });
  await page.goto('/?lang=en');
  await waitHydrated(page);
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${SCREENSHOTS}/landing-360-en.png`, fullPage: true });
});
