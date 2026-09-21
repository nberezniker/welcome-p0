import { test, expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { THEMES, type Theme } from '../../src/lib/theme';
import { en } from '../../src/i18n/en';
import { ru } from '../../src/i18n/ru';
import { es } from '../../src/i18n/es';

/**
 * The public card's contact rows and its QR disclosure — the two things this
 * change touched, verified on a real card in every theme.
 *
 * WHY THIS SPEC IS NOT A SECOND COPY OF tests/e2e/design-themes.spec.ts.
 * That gate measures the card in all four themes and in the un-themed visitor
 * pass, with axe at every impact level, overflow at 390/360 and the review bar's
 * geometry — but it has never seen the card with the QR OPEN, because before
 * this change the QR was always open and the collapsed state is the one a
 * visitor now lands on. So this spec spends its per-theme axe/overflow/tap
 * budget on the EXPANDED state, and checks the collapsed state's overflow and
 * touch targets (the state a phone user actually touches) without paying for a
 * second axe pass on the markup design-themes already scans. Splitting it that
 * way keeps the two gates from asserting the same thing twice and drifting.
 *
 * WHAT IS PROVEN HERE RATHER THAN DESCRIBED:
 *   · a row's VISIBLE text is the localized label — extracted from a clone of
 *     the row with its clipped (`sr-only`) parts removed, because Playwright's
 *     own `toBeVisible`/`innerText` cannot express this: a 1px clipped node
 *     counts as visible, which is exactly how smoke.spec.ts's
 *     `getByText('+34…').toBeVisible()` kept passing while the value stopped
 *     being shown (see the note on that assertion);
 *   · the value is still reachable three ways — `href` (copy link address),
 *     `title` (hover) and the accessible name (screen reader). The name is read
 *     through `toHaveAccessibleName`, i.e. the real name computation;
 *   · the QR is opt-in, is NEVER exposed to assistive tech while collapsed, and
 *     is exposed again when expanded — asserted with ROLE queries, which resolve
 *     through the accessibility tree rather than through the DOM;
 *   · the toggle is keyboard-only operable: reached by pressing Tab (a genuine
 *     traversal, so `:focus-visible` applies), toggled with Enter and with
 *     Space, focus stays on it, and its focus ring is a real computed outline;
 *   · a printed card still carries the QR even when it was collapsed on screen;
 *   · 44px touch targets on every control this change adds or alters, and no
 *     horizontal overflow at 390 or 360 — measured in all five passes.
 */

const OWNER_EMAIL = 'card-contacts-owner@example.org';

/**
 * Four contacts, chosen for the three ways a row can differ: a URL value (the
 * long one that used to wrap mid-word), a handle value, and a phone number —
 * the kind whose missing label produced the "Контакты"/"Contacts"/"Contactos"
 * bug this change fixes.
 */
const LINKEDIN = 'https://www.linkedin.com/in/card-contacts-owner';
const WEBSITE = 'https://a-very-long-personal-site.example.com/portfolio/2026/design-systems-and-more';
const TELEGRAM = '@card_contacts_owner';
const PHONE = '+34 600 000 000';

/** A dictionary value that must exist — a missing one is a finding, not a pass. */
function must(value: string | undefined, where: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`dictionary has no value for ${where}`);
  return value;
}

interface ExpectedRow {
  kind: 'linkedin_url' | 'website' | 'telegram_username' | 'phone';
  value: string;
  /** The href the row must keep carrying: the value's real destination. */
  href: string;
  labels: Record<'en' | 'ru' | 'es', string>;
}

/** In the card's display order (CONTACT_ORDER), which is also the render order. */
const EXPECTED: readonly ExpectedRow[] = [
  {
    kind: 'linkedin_url',
    value: LINKEDIN,
    href: LINKEDIN,
    labels: {
      en: must(en['pubcard.contactLink.linkedin_url'], 'en/published'),
      ru: must(ru['pubcard.contactLink.linkedin_url'], 'ru/published'),
      es: must(es['pubcard.contactLink.linkedin_url'], 'es/published'),
    },
  },
  {
    kind: 'website',
    value: WEBSITE,
    href: WEBSITE,
    labels: {
      en: must(en['pubcard.contactLink.website'], 'en/published'),
      ru: must(ru['pubcard.contactLink.website'], 'ru/published'),
      es: must(es['pubcard.contactLink.website'], 'es/published'),
    },
  },
  {
    kind: 'telegram_username',
    value: TELEGRAM,
    href: 'https://t.me/card_contacts_owner',
    labels: {
      en: must(en['pubcard.contactLink.telegram_username'], 'en/published'),
      ru: must(ru['pubcard.contactLink.telegram_username'], 'ru/published'),
      es: must(es['pubcard.contactLink.telegram_username'], 'es/published'),
    },
  },
  {
    kind: 'phone',
    value: PHONE,
    href: 'tel:+34600000000',
    labels: {
      en: must(en['pubcard.contactLink.phone'], 'en/published'),
      ru: must(ru['pubcard.contactLink.phone'], 'ru/published'),
      es: must(es['pubcard.contactLink.phone'], 'es/published'),
    },
  },
];

const MOBILE = { width: 390, height: 844 };
const NARROW = { width: 360, height: 740 };

/** Client JS is live once the layout's HydrationMarker has run. */
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
 * Seeds the card through the public APIs, so the fixture is the real shape a
 * visitor sees: a published profile whose four contacts are all public. Returns
 * the card's path.
 *
 * All three tests in this file share this fixture. The profile POST is therefore
 * tolerant of its own second run — but only by asserting the CODE it answers
 * with ("an update needs a revision"), never by accepting any failure, so a real
 * validation error cannot hide behind "the fixture already exists".
 */
async function seedCard(page: Page): Promise<string> {
  await loginViaOtp(page, OWNER_EMAIL);

  const profile = await page.request.post('/api/me/profile', {
    data: {
      display_name: 'Card Contacts Owner',
      headline: 'Contacts and QR',
      company: 'WELCOME',
      short_bio: 'A card whose contact rows exercise every kind the projection can emit.',
      languages: ['en', 'ru'],
    },
  });
  const raw = await profile.text();
  if (profile.status() !== 200) {
    expect(profile.status(), raw).toBe(400);
    expect((JSON.parse(raw) as { code?: string }).code, raw).toBe('revision_required');
  }

  for (const row of EXPECTED) {
    const saved = await page.request.put('/api/me/contacts', {
      data: { kind: row.kind, value: row.value, public_enabled: true },
    });
    expect(saved.status(), `PUT ${row.kind}: ${await saved.text()}`).toBe(200);
  }

  await page.goto('/me');
  await waitHydrated(page);
  const publicUrl = (await page.getByTestId('public-url').textContent())?.trim() ?? '';
  expect(publicUrl).toContain('/p/');
  return new URL(publicUrl).pathname;
}

/** A fresh context = a visitor with no session and no theme cookie. */
function anonContext(browser: Browser, viewport = { width: 1280, height: 900 }): Promise<BrowserContext> {
  return browser.newContext({ viewport });
}

/**
 * A row's VISIBLE text: the element cloned with its `.sr-only` parts removed.
 *
 * This is the only honest way to ask "what does a sighted visitor read here".
 * `textContent` includes visually hidden text, and `innerText` includes it too
 * when it is merely CLIPPED — which `sr-only` is (`position:absolute`, 1×1px,
 * `overflow:hidden`) — so both would report the hidden value as though it were
 * on screen, and `toBeVisible()` would agree. Removing the clipped spans from a
 * clone states the requirement directly and fails the moment the value becomes
 * visible text again.
 */
async function visibleText(locator: Locator): Promise<string> {
  return locator.evaluate((el) => {
    const clone = el.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('.sr-only').forEach((node) => node.remove());
    return (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
  });
}

/**
 * The row is FOUND by its accessible name (`label value`), which is itself the
 * assertion that assistive tech gets both parts of the row.
 */
function rowLink(page: Page, label: string, value: string): Locator {
  return page.getByTestId('pubcard-links').getByRole('link', { name: `${label} ${value}` });
}

/** Every axe violation, at every impact level — the bar is zero, not "not serious". */
async function axeViolations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page }).analyze();
  for (const violation of results.violations) {
    console.log(`      axe ${violation.id} [${violation.impact}] ${violation.nodes.length} node(s): ${violation.help}`);
    for (const node of violation.nodes.slice(0, 3)) console.log(`        ${node.html.slice(0, 160)}`);
  }
  return results.violations.map((v) => `${v.id} [${v.impact}] ${v.help}`);
}

/** The controls this change adds or alters, with the 44px rule on both axes. */
async function smallTargets(page: Page): Promise<string[]> {
  const problems: string[] = [];
  const controls = [
    ...(await page.getByTestId('pubcard-links').locator('li a').all()),
    page.getByTestId('pubcard-qr'),
    page.getByTestId('pubcard-vcard'),
    page.getByTestId('pubcard-qr-download'),
  ];
  for (const control of controls) {
    const box = await control.boundingBox();
    const name = (await control.textContent())?.trim().slice(0, 24) ?? '?';
    if (!box) {
      problems.push(`"${name}" has no box`);
      continue;
    }
    if (box.width < 44 || box.height < 44) {
      problems.push(`"${name}" is ${Math.round(box.width)}×${Math.round(box.height)}, below the 44px touch target`);
    }
  }
  return problems;
}

/** Horizontal overflow of the document, in CSS pixels. */
async function overflowPx(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

test('card: rows show the localized label, the value stays reachable, and the QR is opt-in', async ({ page, browser }) => {
  const cardPath = await seedCard(page);
  const anon = await anonContext(browser);
  const visitor = await anon.newPage();
  try {
    await visitor.goto(cardPath);
    await waitHydrated(visitor);

    // ── 1. Visible text is the human label; the value lives elsewhere ────────
    for (const row of EXPECTED) {
      const link = rowLink(visitor, row.labels.en, row.value);
      await expect(link, `${row.kind}: the row is reachable by its accessible name`).toHaveCount(1);
      // The visible text, read past the clipped value.
      expect(await visibleText(link), `${row.kind}: the row's visible text must be the label, not the value`).toBe(row.labels.en);
      // The value is still the destination …
      await expect(link).toHaveAttribute('href', row.href);
      // … still on hover …
      await expect(link).toHaveAttribute('title', row.value);
      // … still what a screen reader reads (the real name computation) …
      await expect(link).toHaveAccessibleName(`${row.labels.en} ${row.value}`);
      // … and still in the DOM text, which is what selecting the row copies.
      expect(await link.evaluate((el) => el.textContent ?? ''), `${row.kind}: the value must stay selectable`).toContain(row.value);
    }

    // The generic section word may not label a row any more.
    const labels = (await visitor.getByTestId('pubcard-contact-label').allTextContents()).map((l) => l.trim());
    expect(labels, 'the rows carry the dictionary labels, in the card order').toEqual(EXPECTED.map((row) => row.labels.en));
    expect(labels, 'no row may be labelled with the section word').not.toContain(en['pubcard.contacts']);

    // ── 2. The 44px touch targets and the overflow this change owns ──────────
    for (const viewport of [MOBILE, NARROW]) {
      await visitor.setViewportSize(viewport);
      expect(await smallTargets(visitor), `touch targets at ${viewport.width}px`).toEqual([]);
      expect(await overflowPx(visitor), `overflow at ${viewport.width}px`).toBeLessThanOrEqual(1);
    }

    // ── 3. The QR is opt-in — and not a hidden-content trap ──────────────────
    const toggle = visitor.getByTestId('pubcard-qr');
    const qrImage = visitor.getByRole('img', { name: en['pubcard.qr'] });
    // Role queries resolve through the accessibility tree, so `toHaveCount(0)`
    // means "not exposed to assistive tech", not merely "no pixels".
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(qrImage, 'collapsed: the QR must not be exposed to assistive tech').toHaveCount(0);
    await expect(
      visitor.getByTestId('pubcard-qr-download'),
      'the download path must stay visible while the code is collapsed',
    ).toBeVisible();

    // Keyboard only: Tab to it (a genuine traversal, so :focus-visible applies),
    // then Enter. Bounded, so a control that fell out of the tab order fails
    // loudly instead of searching forever.
    let reached = false;
    for (let presses = 0; presses < 40 && !reached; presses += 1) {
      await visitor.keyboard.press('Tab');
      reached = await toggle.evaluate((el) => document.activeElement === el);
    }
    expect(reached, 'the QR toggle must be reachable with Tab alone').toBe(true);
    const focusedOutline = await toggle.evaluate((el) => {
      const style = getComputedStyle(el);
      return `${style.outlineStyle} ${style.outlineWidth}`;
    });
    expect(focusedOutline, 'the focused toggle must show a real focus ring').toBe('solid 3px');

    await visitor.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle).toBeFocused();
    await expect(toggle).toHaveText(en['pubcard.qrHide']);
    await expect(qrImage, 'expanded: the QR must be exposed to assistive tech').toHaveCount(1);
    await expect(visitor.getByTestId('pubcard-qr-image')).toBeVisible();
    expect(await overflowPx(visitor), 'the opened QR must not overflow').toBeLessThanOrEqual(1);

    // Space closes it again, and focus never leaves the control.
    await visitor.keyboard.press(' ');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toBeFocused();
    await expect(toggle).toHaveText(en['pubcard.qrShow']);
    await expect(qrImage).toHaveCount(0);

    // ── 4. Print keeps the QR, even though it was collapsed on screen ────────
    await visitor.emulateMedia({ media: 'print' });
    await expect(visitor.getByTestId('pubcard-qr-body'), 'a printed card must carry the QR').toBeVisible();
    await expect(visitor.getByTestId('pubcard-qr-image')).toBeVisible();
    await expect(toggle, 'a toggle is meaningless on paper').toBeHidden();
    await visitor.emulateMedia({ media: 'screen' });
    await expect(qrImage, 'screen restored: the panel is collapsed again').toHaveCount(0);

    // ── 5. axe on the visitor's card, at every impact level ─────────────────
    await visitor.setViewportSize(MOBILE);
    expect(await axeViolations(visitor), 'axe must report zero violations of any impact').toEqual([]);
  } finally {
    await anon.close();
  }
});

test('card: every label is the dictionary word of its language', async ({ page, browser }) => {
  const cardPath = await seedCard(page);
  const anon = await anonContext(browser);
  const visitor = await anon.newPage();
  try {
    for (const locale of ['ru', 'es'] as const) {
      await visitor.goto(`${cardPath}?lang=${locale}`);
      await waitHydrated(visitor);
      const labels = (await visitor.getByTestId('pubcard-contact-label').allTextContents()).map((l) => l.trim());
      expect(labels, `${locale}: the visible labels must be this language's dictionary strings`).toEqual(
        EXPECTED.map((row) => row.labels[locale]),
      );
      // The bug this replaced made the phone row read as the generic section
      // word, so that word may not appear as a row label in any language either.
      expect(labels).not.toContain(must(locale === 'ru' ? ru['pubcard.contacts'] : es['pubcard.contacts'], locale));
      const toggle = visitor.getByTestId('pubcard-qr');
      const showLabel = must(locale === 'ru' ? ru['pubcard.qrShow'] : es['pubcard.qrShow'], locale);
      await expect(toggle).toHaveText(showLabel);
      expect(await visibleText(toggle)).toBe(showLabel);
    }
  } finally {
    await anon.close();
  }
});

test('card: contacts and an open QR hold the bar in all four themes and un-themed', async ({ page, browser }) => {
  test.setTimeout(240_000);
  const cardPath = await seedCard(page);
  const anon = await anonContext(browser);
  const visitor = await anon.newPage();
  const problems: string[] = [];
  try {
    // `none` FIRST: a themed visit plants the theme cookie in this context, and
    // the un-themed pass has to be what a stranger actually gets.
    for (const theme of ['none', ...THEMES] as (Theme | 'none')[]) {
      for (const viewport of [MOBILE, NARROW]) {
        await visitor.setViewportSize(viewport);
        await visitor.goto(theme === 'none' ? cardPath : `${cardPath}?theme=${theme}`);
        await waitHydrated(visitor);

        if (theme === 'none') {
          await expect(visitor.getByTestId('theme-bar'), 'the visitor pass carries no review bar').toHaveCount(0);
        } else {
          await expect(visitor.getByTestId('theme-bar')).toBeVisible();
          await expect(visitor.locator('html')).toHaveAttribute('data-theme', theme);
        }

        // Collapsed: the state a phone user touches (design-themes.spec.ts owns
        // the axe pass on this markup, so only overflow and targets are measured).
        const collapsedProblems: string[] = [];
        const collapsedOverflow = await overflowPx(visitor);
        if (collapsedOverflow > 1) collapsedProblems.push(`collapsed overflow ${collapsedOverflow}px`);
        collapsedProblems.push(...(await smallTargets(visitor)));

        // Expanded: the state no existing gate has ever measured.
        await visitor.getByTestId('pubcard-qr').click();
        await expect(visitor.getByTestId('pubcard-qr-body')).toBeVisible();
        const expandedProblems: string[] = [];
        const expandedOverflow = await overflowPx(visitor);
        if (expandedOverflow > 1) expandedProblems.push(`expanded overflow ${expandedOverflow}px`);
        expandedProblems.push(...(await smallTargets(visitor)));
        const axe = await axeViolations(visitor);
        for (const violation of axe) expandedProblems.push(`axe ${violation}`);

        const label = `${theme} @${viewport.width}`;
        console.log(
          `[card-qr] ${label}: overflow collapsed=${collapsedOverflow}px expanded=${expandedOverflow}px axe=${axe.length} problems=${collapsedProblems.length + expandedProblems.length}`,
        );
        problems.push(
          ...collapsedProblems.map((p) => `${label} (collapsed): ${p}`),
          ...expandedProblems.map((p) => `${label} (expanded): ${p}`),
        );
      }
    }
    expect(problems, 'every theme and viewport must be clean').toEqual([]);
  } finally {
    await anon.close();
  }
});
