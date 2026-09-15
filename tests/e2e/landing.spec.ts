import { test, expect, type Page } from '@playwright/test';

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

const PILOT_MAILTO = /^mailto:nberezniker@gmail\.com\?subject=WELCOME%20pilot$/;
const REPO_URL = 'https://github.com/nberezniker/welcome-p0';
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
  await expect(page.getByTestId('footer-repo-link')).toHaveAttribute('href', REPO_URL);
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
