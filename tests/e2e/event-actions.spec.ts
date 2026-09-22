import { test, expect, request as playwrightRequest, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { en } from '../../src/i18n/en';
import { ru } from '../../src/i18n/ru';
import { es } from '../../src/i18n/es';

/**
 * The event page's ACTION HIERARCHY — the acceptance gate for the audit that
 * found the page rendering eight `btn` controls with the join action last.
 *
 * WHAT WAS WRONG, AND WHY IT IS MEASURED RATHER THAN ASSERTED:
 *
 *   1. `Join` was the eighth control and sat at y 847–891 on a 390×844 screen
 *      (`documentElement.scrollHeight` 984): a visitor had to scroll past every
 *      secondary action to find the only one that matters. The first test below
 *      fails if the join action is not the FIRST control in the card AND its
 *      bottom edge is not inside the first viewport — the second half is what a
 *      "looks better now" screenshot cannot prove;
 *   2. `Add to calendar` and `Google Calendar` were one action in two competing
 *      buttons, and `Share…` duplicated the four deeplinks beside it. Both are
 *      now ONE control each with the secondary option behind a disclosure, and
 *      the collapsed state is asserted (`event-gcal` / `share-*` must NOT be in
 *      the document until the disclosure is opened);
 *   3. the schedule printed the zone twice — a `When (event timezone)` row and a
 *      separate `Timezone (IANA)` row. The zone now rides on the schedule line,
 *      exactly once, and the IANA row is gone.
 *
 * The page-level gate is here — 390 and 360, the full page, axe at every impact,
 * overflow, the 44px rule on the controls this change owns, plus both calendar
 * paths. tests/e2e/design-gate.spec.ts asserts the same hierarchy inside its
 * single-pass design sweep, and it is the file that writes
 * evidence/design/measurements.json — that sweep is what the per-theme version
 * became once the design review was over. One sweep, one evidence file, and the
 * event page cannot pass by not being measured.
 */

const EMAIL = 'event-actions@example.org';
const EVENT_SLUG = 'e2e-event-actions';
const ONLINE_LINK = 'https://meet.example/event-actions-secret';
const TIMEZONE = 'Europe/Madrid';
const START = '2031-06-12T16:00:00.000Z'; // 18:00 in Madrid (CEST)
const END = '2031-06-12T19:00:00.000Z'; // 21:00 in Madrid

const MOBILE = { width: 390, height: 844 };
const NARROW = { width: 360, height: 740 };

/** A dictionary value that must exist — an empty one is a finding, not a pass. */
function must(value: string | undefined, locale: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`dictionary ${locale} has no value for a key this page renders`);
  }
  return value;
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
  if (!body.devCode) throw new Error('devCode missing from the OTP request response');
  await page.getByTestId('login-code').fill(body.devCode);
  await page.getByTestId('login-verify').click();
  await page.waitForURL(/\/(me|onboarding)$/, { timeout: 30_000 });
}

/**
 * The fixture is deliberately the size of the page the audit measured: a real
 * description, a place and a schedule. A short event would put the join button
 * inside the first screen by accident and the above-the-fold assertion would
 * stop meaning anything.
 */
async function seedEvent(page: Page, who: { email: string; slug: string }): Promise<void> {
  await loginViaOtp(page, who.email);
  // The first save CREATES the profile; a second call for an account that
  // already has one is refused by design (src/domain/profile.ts), and this
  // fixture is allowed to be re-run — so that exact refusal is the accepted
  // outcome, not a silent pass. Every other status is a real failure.
  const profile = await page.request.post('/api/me/profile', { data: { display_name: 'Event Actions Owner' } });
  if (profile.status() !== 200) {
    expect((await profile.json()).code, 'the only tolerated profile answer is revision_required').toBe('revision_required');
  }

  const created = await page.request.post('/api/organizer/events', {
    data: {
      name: 'E2E Event Actions Meetup',
      slug: who.slug,
      mode: 'online',
      access_mode: 'public',
      timezone: TIMEZONE,
      starts_at: START,
      ends_at: END,
      online_link: ONLINE_LINK,
      location_label: 'Sala Norte, Calle de Ejemplo 12, Madrid',
      description:
        'A description at body size, long enough to wrap many times on a phone screen. It talks about the evening programme, '
        + 'who the event is for, what to bring, how the room is found, and what happens afterwards. Nothing here is special: '
        + 'it is ordinary prose of the length an organizer actually writes, which is what makes the page as tall as the one the audit measured.',
      consent_text: 'The organizer adds a data notice here, which also renders as a block on the page.',
    },
  });
  expect(created.status(), await created.text()).toBe(201);
}

/** axe, at EVERY impact level. The bar is `[]`, not "nothing serious". */
async function axeViolations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page }).analyze();
  return results.violations.map((v) => `${v.id} [${v.impact}] ${v.help} (${v.nodes.length} node(s))`);
}

async function overflowPx(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

/**
 * What the page actually shows: the controls of the card in DOM order, the two
 * geometry answers the hierarchy rests on (title and join on one screen), and
 * the schedule line.
 */
async function measure(page: Page) {
  return page.evaluate(
    ([icsTestId, gcalTestId, shareToggleId]) => {
      const selector =
        'main .card a.btn-light, main .card a.btn-accent, main .card a.btn-primary, main .card a.btn-outline,'
        + ' main .card button.btn-light, main .card button.btn-accent, main .card button.btn-primary';
      const controls = [...document.querySelectorAll(selector)].map((el) => {
        const r = el.getBoundingClientRect();
        return {
          id: el.getAttribute('data-testid'),
          top: Math.round(r.top),
          bottom: Math.round(r.bottom),
          width: Math.round(r.width),
          height: Math.round(r.height),
        };
      });
      const box = (sel: string) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { top: Math.round(r.top), bottom: Math.round(r.bottom) };
      };
      const card = document.querySelector('main .card');
      return {
        viewportHeight: window.innerHeight,
        documentHeight: document.documentElement.scrollHeight,
        cardBottom: box('main .card')?.bottom ?? null,
        title: box('main .card h1'),
        join: box('[data-testid="join-button"]'),
        memberState: box('[data-testid="member-state"]'),
        order: controls.map((c) => c.id),
        controls,
        when: (document.querySelector('[data-testid="event-when"]')?.textContent ?? '').trim(),
        whenCount: document.querySelectorAll('[data-testid="event-when"]').length,
        dtLabels: [...document.querySelectorAll('main .card dt')].map((d) => (d.textContent ?? '').trim().replace(/\s*:\s*$/, '')),
        cardText: (card?.textContent ?? '').replace(/\s+/g, ' '),
        icsHref: document.querySelector(`[data-testid="${icsTestId}"]`)?.getAttribute('href') ?? null,
        gcalHref: document.querySelector(`[data-testid="${gcalTestId}"]`)?.getAttribute('href') ?? null,
        shareToggleExpanded: document
          .querySelector(`[data-testid="${shareToggleId}"]`)
          ?.getAttribute('aria-expanded'),
      };
    },
    ['event-ics', 'event-gcal', 'share-toggle'] as const,
  );
}

/**
 * The 44px rule, on both axes, for the controls of the action hierarchy this page
 * is about: the join action and the calendar/share disclosures, collapsed and
 * expanded.
 *
 * The member panel's own controls are deliberately NOT in this list. They used to
 * be excluded because they were pre-existing and outside that change's scope; the
 * reason now is narrower and different — they are measured in full by the
 * member-state test below, where the member's card actually exists, and asserting
 * them twice from two lists would mean two places to update. That test asserts
 * the panel's three toggle ROWS (their labels, not the 16px glyphs) and its two
 * links.
 */
async function smallTargets(page: Page): Promise<string[]> {
  const problems: string[] = [];
  const ids = [
    'join-button',
    'event-ics',
    'event-calendar-more',
    'event-gcal',
    'share-toggle',
    'share-native',
    'share-linkedin',
    'share-whatsapp',
    'share-telegram',
    'share-x',
  ];
  for (const id of ids) {
    const locator = page.getByTestId(id);
    if ((await locator.count()) === 0) continue;
    const box = await locator.first().boundingBox();
    if (!box) continue;
    if (box.width < 44 || box.height < 44) {
      problems.push(`"${id}" is ${Math.round(box.width)}×${Math.round(box.height)}, below the 44px touch target`);
    }
  }
  return problems;
}

/** A cookie-free HTTP client for the same origin. */
async function anonymousClient(page: Page) {
  return playwrightRequest.newContext({ baseURL: new URL(page.url()).origin });
}

const ICS_STAMP = /^20\d{6}T\d{6}Z$/;

test('event actions: join is the first control and is on the first screen at 390 and 360', async ({ page, browser }) => {
  test.setTimeout(180_000);
  await seedEvent(page, { email: EMAIL, slug: EVENT_SLUG });

  const anon = await browser.newContext();
  const visitor = await anon.newPage();
  try {
    for (const viewport of [MOBILE, NARROW]) {
      await visitor.setViewportSize(viewport);
      const response = await visitor.goto(`/e/${EVENT_SLUG}`);
      expect(response?.status()).toBe(200);
      await waitHydrated(visitor);

      const m = await measure(visitor);

      // 1. THE HIERARCHY. The join action is the first control of the card and
      //    its bottom edge is inside the first viewport, with the title above it:
      //    both halves are what "visible on the first screen with the title" means.
      expect(m.order[0], `control order at ${viewport.width}px: ${JSON.stringify(m.order)}`).toBe('join-button');
      expect(m.join, 'the join control must exist for a non-member').not.toBeNull();
      expect(m.title, 'the event title must exist').not.toBeNull();
      expect(
        m.join!.bottom,
        `join bottom ${m.join!.bottom} must be within the ${m.viewportHeight}px first screen`,
      ).toBeLessThanOrEqual(m.viewportHeight);
      expect(m.title!.bottom, 'the title must sit above the join action').toBeLessThan(m.join!.top);

      // 2. ONE calendar control, ONE share control — the secondary options are
      //    NOT in the document until their disclosure is opened.
      expect(m.order).toContain('event-ics');
      expect(m.order).toContain('event-calendar-more');
      expect(m.order).toContain('share-toggle');
      expect(m.order, 'the Google template must be behind the disclosure').not.toContain('event-gcal');
      for (const network of ['share-native', 'share-linkedin', 'share-whatsapp', 'share-telegram', 'share-x']) {
        expect(m.order, `${network} must be behind the disclosure`).not.toContain(network);
      }
      expect(m.order, `exactly four controls up front: ${JSON.stringify(m.order)}`).toEqual([
        'join-button',
        'event-ics',
        'event-calendar-more',
        'share-toggle',
      ]);

      // 3. THE SCHEDULE, printed once, with the zone named once.
      expect(m.whenCount).toBe(1);
      expect(m.when).toContain(TIMEZONE);
      expect(m.when).toContain('·');
      expect(m.dtLabels, 'the separate IANA row must be gone').not.toContain(en['org.timezoneLabel']);
      expect(m.dtLabels).toContain(en['event.timeTitle']);
      const zoneMentions = m.cardText.split(TIMEZONE).length - 1;
      expect(zoneMentions, `the zone is printed ${zoneMentions}× in the card text`).toBe(1);

      // 4. Both secondary options work once opened, and keep their contracts.
      await visitor.getByTestId('event-calendar-more').click();
      const gcal = visitor.getByTestId('event-gcal');
      await expect(gcal).toBeVisible();
      const gcalHref = decodeURIComponent((await gcal.getAttribute('href')) ?? '');
      expect(gcalHref.startsWith('https://calendar.google.com/calendar/render?action=TEMPLATE')).toBe(true);
      expect(gcalHref).toContain('20310612T160000Z/20310612T190000Z');
      await expect(gcal).toHaveAttribute('rel', 'noopener noreferrer');

      await visitor.getByTestId('share-toggle').click();
      await expect(visitor.getByTestId('share-native')).toBeVisible();
      for (const [testId, host] of [
        ['share-linkedin', 'https://www.linkedin.com/'],
        ['share-whatsapp', 'https://wa.me/'],
        ['share-telegram', 'https://t.me/'],
        ['share-x', 'https://x.com/'],
      ] as const) {
        const link = visitor.getByTestId(testId);
        await expect(link).toBeVisible();
        await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
        await expect(link).toHaveAttribute('target', '_blank');
        expect(((await link.getAttribute('href')) ?? '').startsWith(host)).toBe(true);
      }

      // 5. THE GATE, on the expanded state: axe at any impact, no overflow, and
      //    the 44px rule on every control this change owns.
      console.log(
        `[event-actions] @${viewport.width}: document=${m.documentHeight}px card=${m.cardBottom}px `
        + `join=${m.join!.top}-${m.join!.bottom}/${m.viewportHeight} order=[${m.order.join(', ')}] `
        + `collapsed=${m.order.length} when="${m.when}"`,
      );

      expect(await axeViolations(visitor), `axe at ${viewport.width}px`).toEqual([]);
      expect(await overflowPx(visitor), `overflow at ${viewport.width}px`).toBeLessThanOrEqual(1);
      expect(await smallTargets(visitor), `tap targets at ${viewport.width}px`).toEqual([]);

      await visitor.goto(`/e/${EVENT_SLUG}`);
      await waitHydrated(visitor);
    }

    // 6. The ICS route's contract is untouched: same URL, same file, and the
    //    member-only room link still never appears inside it.
    const m = await measure(visitor);
    expect(m.icsHref).toBe(`/api/events/${EVENT_SLUG}/ics`);
    const anonHttp = await anonymousClient(visitor);
    try {
      const res = await anonHttp.get(`/api/events/${EVENT_SLUG}/ics`);
      expect(res.status()).toBe(200);
      expect(res.headers()['content-type']).toContain('text/calendar');
      const body = await res.text();
      expect(body).toContain('BEGIN:VCALENDAR');
      expect(body).toContain(`X-WR-TIMEZONE:${TIMEZONE}`);
      for (const line of body.split('\r\n')) {
        if (line.startsWith('DTSTART:') || line.startsWith('DTEND:')) {
          expect(line.slice(line.indexOf(':') + 1), `not a UTC stamp: ${line}`).toMatch(ICS_STAMP);
        }
      }
      expect(body, 'the room link must never travel inside the .ics').not.toContain(ONLINE_LINK);
      expect(body).not.toContain('event-actions-secret');
    } finally {
      await anonHttp.dispose();
    }

    // 7. An event with no schedule still says so, and still offers no control.
    const undated = await page.request.post('/api/organizer/events', {
      data: { name: 'E2E Event Actions Undated', slug: 'e2e-event-actions-undated', mode: 'offline', access_mode: 'public', timezone: TIMEZONE },
    });
    expect(undated.status(), await undated.text()).toBe(201);
    await visitor.goto('/e/e2e-event-actions-undated');
    await waitHydrated(visitor);
    await expect(visitor.getByTestId('event-no-schedule')).toBeVisible();
    await expect(visitor.getByTestId('event-ics')).toHaveCount(0);
    await expect(visitor.getByTestId('event-calendar-more')).toHaveCount(0);
  } finally {
    await anon.close();
  }
});

test('event actions: a member sees the member state in that slot, and the panel still works', async ({ page }) => {
  test.setTimeout(180_000);
  const member = 'e2e-event-actions-member';
  await seedEvent(page, { email: 'event-actions-member@example.org', slug: member });

  await page.setViewportSize(MOBILE);
  await page.goto(`/e/${member}`);
  await waitHydrated(page);
  await page.getByTestId('join-button').click();
  await expect(page.getByTestId('member-panel')).toBeVisible({ timeout: 30_000 });
  await waitHydrated(page);

  // The slot under the title now names the member state instead of the join CTA.
  const memberState = page.getByTestId('member-state');
  await expect(memberState).toBeVisible();
  await expect(memberState).toHaveText(en['event.alreadyMember']);
  await expect(page.getByTestId('join-button')).toHaveCount(0);
  const stateBox = await memberState.boundingBox();
  const viewportHeight = await page.evaluate(() => window.innerHeight);
  expect(stateBox, 'the member state must have a box').not.toBeNull();
  expect(stateBox!.y + stateBox!.height).toBeLessThanOrEqual(viewportHeight);

  // …and the participation panel is intact, in place, with its directory toggle
  // writing through the same endpoint as before (PATCH, 200).
  await expect(page.getByTestId('member-panel')).toBeVisible();
  await expect(page.getByTestId('event-directory-toggle')).toBeVisible();
  await expect(page.getByTestId('event-marketing-toggle')).toBeVisible();
  const dirToggle = page.getByTestId('event-directory-toggle');
  const wasChecked = await dirToggle.isChecked();
  const patched = page.waitForResponse(
    (r) => r.url().includes('/api/me/memberships/') && r.request().method() === 'PATCH',
  );
  await dirToggle.click();
  expect((await patched).status(), 'the directory toggle must keep writing through its endpoint').toBe(200);
  await expect(dirToggle).toBeChecked({ checked: !wasChecked });

  // THE PANEL'S OWN CONTROLS, MEASURED — previously the one blind spot on this
  // page. This block used to print the smallest targets and assert nothing,
  // because the panel's checkboxes and its two `btn-small` links were
  // pre-existing and outside that change's scope. They are in scope now, so they
  // are asserted like everything else.
  //
  // WHAT IS MEASURED, and why it is the row and not the input: each toggle is a
  // `<label>` that WRAPS its checkbox and carries `min-h-11`, so the whole 44px
  // row is the clickable area while the glyph stays 16px. Measuring the glyph
  // would demand a 44px checkbox nobody needs — the thumb hits the row. The
  // input is still a real `<input type="checkbox">` (the PATCH assertion just
  // above depends on it), which is the part that must not change.
  const panelTargets = await page.evaluate(() => {
    const out: { name: string; w: number; h: number }[] = [];
    const record = (name: string, el: Element | null | undefined) => {
      if (!el) return;
      const r = el.getBoundingClientRect();
      out.push({ name, w: Math.round(r.width), h: Math.round(r.height) });
    };
    for (const id of ['attendance-toggle', 'event-directory-toggle', 'event-marketing-toggle']) {
      const input = document.querySelector(`[data-testid="${id}"]`);
      record(id, input?.closest('label') ?? input);
    }
    const panel = document.querySelector('[data-testid="member-panel"]');
    for (const link of panel?.querySelectorAll('a.btn-light, a.btn-primary, a.btn-accent, a.btn-small-tap') ?? []) {
      record(link.getAttribute('data-testid') ?? `link:"${(link.textContent ?? '').trim()}"`, link);
    }
    for (const button of panel?.querySelectorAll('button') ?? []) {
      record(`button:"${(button.textContent ?? '').trim()}"`, button);
    }
    return out;
  });
  const tooSmall = panelTargets.filter((t) => t.w < 44 || t.h < 44);
  console.log(`[event-actions] member panel tap targets: ${JSON.stringify(panelTargets)}`);
  expect(
    tooSmall,
    `member panel controls below the 44px touch target: ${JSON.stringify(tooSmall)}`,
  ).toEqual([]);
  // A vacuous pass would be worse than a failure: the panel must actually
  // contain the three rows and the two links this assertion claims to cover.
  expect(panelTargets.length, 'the panel must expose its rows and links to this measurement').toBe(5);

  // A member's page still passes axe at every impact, and the room link is still
  // member-only (the visitor never sees it — asserted in the tests above).
  await expect(page.getByTestId('online-room-link')).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
  expect(await overflowPx(page)).toBeLessThanOrEqual(1);
});

test('event actions: the new controls are labelled from the dictionary in EN, RU and ES', async ({ page, browser }) => {
  test.setTimeout(180_000);
  const locale = 'e2e-event-actions-locale';
  await seedEvent(page, { email: 'event-actions-locale@example.org', slug: locale });

  const anon = await browser.newContext();
  const visitor = await anon.newPage();
  try {
    const cases = [
      { lang: 'en', dict: en },
      { lang: 'ru', dict: ru },
      { lang: 'es', dict: es },
    ] as const;
    for (const { lang, dict } of cases) {
      // The locale reaches /e/<slug> the way it does in the product: `?lang=` is
      // scoped to the four public entry points (src/proxy.ts `config.matcher`),
      // and the event page is reached with the cookie that override just set.
      // Asking for `?lang=ru` on /e/ directly would assert a channel this page
      // has never had.
      await visitor.goto(`/?lang=${lang}`);
      await visitor.goto(`/e/${locale}`);
      await waitHydrated(visitor);

      // Every label is the dictionary's own string for this locale: a hardcoded
      // English word (or a missing translation) cannot pass by rendering.
      await expect(visitor.getByTestId('event-ics')).toHaveText(must(dict['event.addToCalendar'], lang));
      await expect(visitor.getByTestId('event-calendar-more')).toHaveText(must(dict['event.calendarMore'], lang));
      await expect(visitor.getByTestId('share-toggle')).toHaveText(must(dict['share.label'], lang));
      await expect(visitor.getByTestId('join-button')).toHaveText(must(dict['event.joinCta'], lang));

      await visitor.getByTestId('event-calendar-more').click();
      await expect(visitor.getByTestId('event-gcal')).toHaveText(must(dict['event.addToGoogleCalendar'], lang));

      await visitor.getByTestId('share-toggle').click();
      await expect(visitor.getByTestId('share-linkedin')).toHaveText(must(dict['share.linkedin'], lang));

      // The schedule line keeps the zone name (an IANA id is not translated) and
      // the compact range its own locale builds.
      const when = ((await visitor.getByTestId('event-when').textContent()) ?? '').trim();
      expect(when, `[${lang}] the zone must be named: ${when}`).toContain(TIMEZONE);
      expect(when.match(/\d{1,2}:\d{2}/g) ?? [], `[${lang}] two times expected in: ${when}`).toHaveLength(2);
      expect(await axeViolations(visitor), `axe [${lang}]`).toEqual([]);
      console.log(`[event-actions] ${lang}: "${when}"`);
    }
  } finally {
    await anon.close();
  }
});
