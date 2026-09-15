import { test, expect, request as playwrightRequest, type Page } from '@playwright/test';

/**
 * Share-preview e2e (Gap 1): a card or an event link pasted into a chat must
 * unfurl with an image, and that image must be fetchable by anyone.
 *
 * The image is a PNG, so nothing here can read its CONTENT. The privacy half of
 * the promise — that only public page fields reach a preview — is enforced by
 * the builders' narrow input type and asserted in tests/unit/og-card.test.ts.
 */

const EMAIL = 'og-image-e2e@example.org';
const EVENT_SLUG = 'e2e-og-image';
const EVENT_START_LOCAL = '2031-06-02T18:00';
const EVENT_END_LOCAL = '2031-06-02T20:00';
const ONLINE_LINK = 'https://meet.example/og-room-secret';
/** A rendered 1200×630 card is tens of KB; a blank or error body is not. */
const MIN_IMAGE_BYTES = 10_000;
const PNG_MAGIC = '89504e470d0a1a0a';

async function waitHydrated(page: Page) {
  await expect(page.locator('html[data-hydrated="true"]')).toBeAttached({ timeout: 30_000 });
}

async function loginViaOtp(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await waitHydrated(page);
  await page.getByTestId('login-email').fill(email);
  const responsePromise = page.waitForResponse(
    (r) => r.url().includes('/api/auth/otp/request') && r.request().method() === 'POST',
  );
  await page.getByTestId('login-request').click();
  const body = (await (await responsePromise).json()) as { devCode?: string };
  if (!body.devCode) throw new Error('devCode missing from OTP request response');
  await page.getByTestId('login-code').fill(body.devCode);
  await page.getByTestId('login-verify').click();
  await page.waitForURL(/\/(me|onboarding)$/, { timeout: 30_000 });
}

/** A cookie-free HTTP client for the same origin. */
async function anonymousClient(page: Page) {
  return playwrightRequest.newContext({ baseURL: new URL(page.url()).origin });
}

/** Fetches an og:image URL with no session and asserts it is a real PNG. */
async function expectPublicImage(imageUrl: string): Promise<Buffer> {
  const anon = await playwrightRequest.newContext();
  try {
    const res = await anon.get(imageUrl);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('image/png');
    const body = await res.body();
    expect(body.byteLength).toBeGreaterThan(MIN_IMAGE_BYTES);
    // The magic bytes: an error page served with image/png would not pass this.
    expect(body.subarray(0, 8).toString('hex')).toBe(PNG_MAGIC);
    return body;
  } finally {
    await anon.dispose();
  }
}

/** Reads the single og:image URL a page declares. */
async function ogImageUrl(page: Page): Promise<string> {
  const meta = page.locator('meta[property="og:image"]');
  await expect(meta).toHaveCount(1);
  const content = await meta.getAttribute('content');
  expect(content).toBeTruthy();
  return content ?? '';
}

test('og: the public card ships a share image anyone can fetch', async ({ page }) => {
  await loginViaOtp(page, EMAIL);
  await page.goto('/me/profile');
  await page.getByTestId('pf-name').fill('OG Preview Owner');
  await page.locator('#pf-headline').fill('Founder of Solbeam');
  await page.locator('#pf-company').fill('Solbeam Labs');
  await page.getByTestId('pf-save').click();
  await expect(page.getByTestId('toast-success')).toBeVisible();

  await page.goto('/me');
  const publicUrl = await page.getByTestId('public-url').textContent();
  expect(publicUrl).toContain('/p/');
  const slug = publicUrl!.split('/p/')[1] ?? '';
  expect(slug.length).toBeGreaterThan(0);

  await page.goto(publicUrl!);
  await waitHydrated(page);

  // The card already advertised og:title/og:url; the image is the piece that was
  // missing, and the file convention declares its canvas and its alt text.
  const imageUrl = await ogImageUrl(page);
  expect(new URL(imageUrl).pathname).toBe(`/p/${slug}/opengraph-image`);
  await expect(page.locator('meta[property="og:image:width"]')).toHaveAttribute('content', '1200');
  await expect(page.locator('meta[property="og:image:height"]')).toHaveAttribute('content', '630');
  const alt = await page.locator('meta[property="og:image:alt"]').getAttribute('content');
  expect(alt?.trim().length ?? 0).toBeGreaterThan(0);

  await expectPublicImage(imageUrl);
});

test('og: the event page carries a title, a canonical url and its own share image', async ({ page }) => {
  await loginViaOtp(page, EMAIL);
  await page.goto('/organizer');
  await page.getByTestId('ev-name').fill('E2E OG Image Meetup');
  await page.locator('#ev-mode').selectOption('online');
  await page.locator('#ev-access').selectOption('public');
  await page.locator('#ev-tz').selectOption('Europe/Madrid');
  await page.locator('#ev-starts').fill(EVENT_START_LOCAL);
  await page.locator('#ev-ends').fill(EVENT_END_LOCAL);
  await page.locator('#ev-online').fill(ONLINE_LINK);
  await page.locator('#ev-slug').fill(EVENT_SLUG);
  await page.getByTestId('ev-submit').click();
  await page.waitForURL('**/organizer/events/**');

  await page.goto(`/e/${EVENT_SLUG}`);
  await waitHydrated(page);

  // Before this change the event page had no OG metadata at all (a shared link
  // unfurled as a bare "Event"); now it mirrors the card.
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', /E2E OG Image Meetup/);
  await expect(page.locator('meta[property="og:url"]')).toHaveAttribute('content', new RegExp(`/e/${EVENT_SLUG}$`));
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', new RegExp(`/e/${EVENT_SLUG}$`));

  const imageUrl = await ogImageUrl(page);
  expect(new URL(imageUrl).pathname).toBe(`/e/${EVENT_SLUG}/opengraph-image`);
  await expectPublicImage(imageUrl);

  // The room link is member-conditional; the preview is rendered for anonymous
  // visitors, so neither the page nor the image route may carry it.
  const anon = await anonymousClient(page);
  try {
    const html = await (await anon.get(`/e/${EVENT_SLUG}`)).text();
    expect(html).not.toContain(ONLINE_LINK);
    expect(html).not.toContain('og-room-secret');
  } finally {
    await anon.dispose();
  }
});

test('og: an unknown slug 404s instead of leaking that something exists', async ({ request }) => {
  const missing = 'og-e2e-unknown-slug-0001';

  // The page and its preview must answer the same way — otherwise the image
  // route becomes a way to probe which slugs exist.
  for (const path of [`/p/${missing}`, `/p/${missing}/opengraph-image`, `/e/${missing}`, `/e/${missing}/opengraph-image`]) {
    const res = await request.get(path);
    expect(res.status(), `${path} must 404`).toBe(404);
  }

  // The 404 carries no image: a chat client must not receive a body it would
  // mistake for a preview (next's file convention does emit an og:image tag on
  // the 404 render — that URL is the one asserted 404 above).
  const notFoundImage = await request.get(`/p/${missing}/opengraph-image`);
  expect(notFoundImage.headers()['content-type'] ?? '').not.toContain('image/');
  expect((await notFoundImage.body()).byteLength).toBeLessThan(MIN_IMAGE_BYTES);
});
