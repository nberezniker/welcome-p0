import { test, expect, request as playwrightRequest, type Page } from '@playwright/test';

/**
 * Interop e2e (Phase 1, packet 2): the calendar file/links on an event page and
 * the contacts + share affordances on a public card.
 *
 * The ICS endpoint is fetched from a FRESH request context with no cookies, so
 * "anonymous can download it" is proven rather than assumed.
 */

const EMAIL = 'interop@example.org';
const EVENT_SLUG = 'e2e-interop';
const EVENT_START_LOCAL = '2031-05-01T18:00';
const EVENT_END_LOCAL = '2031-05-01T20:00';
const ONLINE_LINK = 'https://meet.example/e2e-room-secret';

/** Local wall-clock input → the UTC stamp the app must emit (`YYYYMMDDTHHMMSSZ`). */
function icsStamp(iso: string): string {
  return iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

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

/** Creates or updates the profile through the editor UI. */
async function createProfile(page: Page, displayName: string): Promise<void> {
  await page.goto('/me/profile');
  await page.getByTestId('pf-name').fill(displayName);
  await page.getByTestId('pf-save').click();
  await expect(page.getByTestId('toast-success')).toBeVisible();
}

/** A cookie-free HTTP client for the same origin. */
async function anonymousClient(page: Page) {
  return playwrightRequest.newContext({ baseURL: new URL(page.url()).origin });
}

test('interop: event page offers the .ics file and the Google template link', async ({ page }) => {
  await loginViaOtp(page, EMAIL);

  // The browser's own conversion is what the form posts, so the expected UTC
  // stamp is computed the same way rather than assumed.
  const [startIso, endIso] = await page.evaluate(
    ([start, end]) => [new Date(start).toISOString(), new Date(end).toISOString()],
    [EVENT_START_LOCAL, EVENT_END_LOCAL] as const,
  );

  await page.goto('/organizer');
  await page.getByTestId('ev-name').fill('E2E Interop Meetup');
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

  // The .ics download is a same-origin link to the API route.
  const ics = page.getByTestId('event-ics');
  await expect(ics).toBeVisible();
  await expect(ics).toHaveAttribute('href', `/api/events/${EVENT_SLUG}/ics`);

  // The Google template link goes straight to the user's own calendar. It is now
  // the SECONDARY half of one calendar action rather than a second action beside
  // the join button, so it is reached through its disclosure — and the collapse
  // is asserted, not assumed (src/app/e/[slug]/calendar-options.tsx).
  await expect(page.getByTestId('event-gcal')).toHaveCount(0);
  await page.getByTestId('event-calendar-more').click();
  const gcal = page.getByTestId('event-gcal');
  await expect(gcal).toBeVisible();
  const gcalHref = (await gcal.getAttribute('href')) ?? '';
  expect(gcalHref.startsWith('https://calendar.google.com/calendar/render?action=TEMPLATE')).toBe(true);
  expect(decodeURIComponent(gcalHref)).toContain(`${icsStamp(startIso)}/${icsStamp(endIso)}`);

  // Share deeplinks: outbound, new tab, never a window opener. They live behind
  // the ONE share control the page offers (src/components/share-links.tsx).
  const share = page.getByTestId('event-share');
  await expect(share).toBeVisible();
  await expect(page.getByTestId('share-linkedin')).toHaveCount(0);
  await page.getByTestId('share-toggle').click();
  for (const [testId, host] of [
    ['share-linkedin', 'https://www.linkedin.com/'],
    ['share-whatsapp', 'https://wa.me/'],
    ['share-telegram', 'https://t.me/'],
    ['share-x', 'https://x.com/'],
  ] as const) {
    const link = page.getByTestId(testId);
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(link).toHaveAttribute('target', '_blank');
    expect(((await link.getAttribute('href')) ?? '').startsWith(host)).toBe(true);
  }

  // The file itself: no cookies, correct type and name, no room link inside.
  const anon = await anonymousClient(page);
  try {
    const res = await anon.get(`/api/events/${EVENT_SLUG}/ics`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/calendar');
    expect(res.headers()['content-disposition']).toContain(`welcome-${EVENT_SLUG}.ics`);
    const body = await res.text();
    expect(body).toContain('BEGIN:VCALENDAR');
    expect(body).toContain('X-WR-TIMEZONE:Europe/Madrid');
    expect(body).toContain(`DTSTART:${icsStamp(startIso)}`);
    expect(body).toContain(`DTEND:${icsStamp(endIso)}`);
    expect(body).toContain('UID:welcome-event-');
    expect(body).not.toContain(ONLINE_LINK);
    expect(body).not.toContain('e2e-room-secret');
  } finally {
    await anon.dispose();
  }

  // An event without a schedule says so instead of offering a broken file.
  await page.goto('/organizer');
  await page.getByTestId('ev-name').fill('E2E Interop Undated');
  await page.locator('#ev-slug').fill('e2e-interop-undated');
  await page.getByTestId('ev-submit').click();
  await page.waitForURL('**/organizer/events/**');
  await page.goto('/e/e2e-interop-undated');
  await expect(page.getByTestId('event-no-schedule')).toBeVisible();
  await expect(page.getByTestId('event-ics')).toHaveCount(0);
});

test('interop: public card offers vCard, an og:url and share deeplinks', async ({ page }) => {
  await loginViaOtp(page, EMAIL);
  await createProfile(page, 'Interop Owner');
  await page.goto('/me');
  const publicUrl = await page.getByTestId('public-url').textContent();
  expect(publicUrl).toContain('/p/');

  await page.goto(publicUrl!);
  await waitHydrated(page);

  // Add to contacts → the vCard endpoint of this card.
  const vcard = page.getByTestId('pubcard-vcard');
  await expect(vcard).toBeVisible();
  const vcardHref = (await vcard.getAttribute('href')) ?? '';
  expect(vcardHref).toContain('/vcard');

  // og:url is the canonical card URL — what a chat preview links to.
  await expect(page.locator('meta[property="og:url"]')).toHaveAttribute('content', /\/p\/[\w-]+$/);

  // Share deeplinks carry the card URL and never hand over the opener window.
  await expect(page.getByTestId('pubcard-share')).toBeVisible();
  const linkedin = page.getByTestId('share-linkedin');
  await expect(linkedin).toHaveAttribute('rel', 'noopener noreferrer');
  const linkedinHref = (await linkedin.getAttribute('href')) ?? '';
  expect(decodeURIComponent(linkedinHref)).toContain('/p/');

  // A cookie-free visitor can still download the vCard.
  const anon = await anonymousClient(page);
  try {
    const res = await anon.get(vcardHref);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/vcard');
    expect(await res.text()).toContain('BEGIN:VCARD');
  } finally {
    await anon.dispose();
  }
});
