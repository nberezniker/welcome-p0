import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { THEMES, type Theme } from '../../src/lib/theme';
import { en } from '../../src/i18n/en';
import { ru } from '../../src/i18n/ru';
import { es } from '../../src/i18n/es';

/**
 * Design review — the acceptance gate for the four themes.
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
 * AXE: ZERO VIOLATIONS OF ANY IMPACT. The assertion used to admit `serious` and
 * `critical` and treat `moderate`/`minor` as acceptable noise, which quietly left
 * the whole class of structural findings (an un-landmarked strip of controls was
 * exactly one) as something the gate could not fail on. It now fails on any
 * violation at all: a finding is either fixed or it is a real problem, and there
 * is no third category in which a finding is nobody's problem.
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
 *
 * THE EVENT PAGE'S ACTION HIERARCHY IS PART OF THIS SWEEP, not of a second one:
 * `actionAboveFold` used to be recorded and never asserted, and the event was
 * seeded without a schedule, so the calendar and share controls did not exist to
 * be measured. Both are fixed here — the event carries a real schedule, the
 * primary action must be on the FIRST SCREEN in every pass, the collapsed
 * controls must not be in the document, and the two disclosures are opened inside
 * each pass so their revealed controls get the same axe/overflow/44px treatment
 * as everything else. A hierarchy that only holds in the default look is not a
 * hierarchy. (The non-themed gates for the same surface live in
 * tests/e2e/event-actions.spec.ts.)
 *
 * THE THEME LIST IS THE APP'S OWN (src/lib/theme.ts), not a copy. The sweep below
 * therefore covers a newly added theme automatically instead of going green while
 * the new one is untested; what the list CONTAINS is pinned by
 * tests/unit/theme.test.ts.
 */

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
  /** Every control of the card, in DOM order — the action hierarchy, measured. */
  order: string[];
  /** Bottom edge of the event page's join control, or null when it has none. */
  joinBottom: number | null;
  /** Smallest of the controls the event action hierarchy owns, 44px rule. */
  minEventTarget: { name: string; width: number; height: number } | null;
  /** The same three answers after both disclosures are opened. */
  expandedOverflowPx: number;
  expandedAxeViolations: string[];
  barTop: number | null;
  barBottom: number | null;
  barBelowCard: boolean | null;
  minTapTarget: { name: string; width: number; height: number } | null;
  /** EVERY axe violation, of any impact — see the note at the top of the file. */
  axeViolations: string[];
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
 * The dictionary key for one theme's switcher label. A helper rather than an
 * inline template so the key stays a LITERAL UNION TypeScript can check against
 * all three dictionaries: a theme added to `THEMES` without a `theme.<name>`
 * string in en/ru/es fails `pnpm typecheck` instead of rendering a button with no
 * text on it.
 */
function themeLabelKey(theme: Theme): `theme.${Theme}` {
  return `theme.${theme}`;
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
      // A schedule, so the calendar and share controls this sweep must measure
      // actually exist. Without a start time the page renders neither, and the
      // four themes would be judged on a page that is not the real one.
      starts_at: '2031-05-01T18:00:00.000Z',
      ends_at: '2031-05-01T20:00:00.000Z',
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
async function measure(page: Page): Promise<Omit<Sample, 'theme' | 'page' | 'viewport' | 'axeViolations' | 'axeContrastNodes'>> {
  const pageWidth = await page.evaluate(() => window.innerWidth);
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const viewportHeight = await page.evaluate(() => window.innerHeight);

  const card = await box(page, '[data-testid="pubcard"], main .card');
  const title = await box(page, '[data-testid="pubcard-name"], main .card h1');
  const action =
    (await box(page, '[data-testid="pubcard-signin-cta"] a, [data-testid="pubcard-intro-cta"]')) ??
    (await box(page, '[data-testid="join-button"]'));
  const bar = await box(page, '[data-testid="theme-bar"]');
  const order = await page.evaluate(() =>
    [...document.querySelectorAll('main a.btn-light, main a.btn-accent, main a.btn-primary, main a.btn-outline, main button.btn-light, main button.btn-accent, main button.btn-primary')]
      .map((el) => el.getAttribute('data-testid'))
      .filter((id): id is string => id !== null),
  );

  return {
    pageWidth,
    scrollWidth,
    overflowPx: Math.max(0, scrollWidth - pageWidth),
    cardBottom: card?.bottom ?? -1,
    titleBottom: title?.bottom ?? -1,
    actionTop: action?.top ?? -1,
    actionBottom: action?.bottom ?? -1,
    actionAboveFold: action ? action.bottom <= viewportHeight : false,
    order,
    joinBottom: (await box(page, '[data-testid="join-button"]'))?.bottom ?? null,
    minEventTarget: null,
    expandedOverflowPx: 0,
    expandedAxeViolations: [],
    barTop: bar?.top ?? null,
    barBottom: bar?.bottom ?? null,
    barBelowCard: bar && card ? bar.top >= card.bottom - 1 : null,
    minTapTarget: null,
  };
}

/**
 * The controls the event page's ACTION HIERARCHY owns, with the 44px rule on
 * both axes. The participation panel's own controls are deliberately not here:
 * the hierarchy change neither adds nor restyles them, and folding an unrelated
 * pre-existing property of the panel into this gate would make the gate lie
 * about what it is guarding.
 */
const EVENT_ACTION_CONTROLS = [
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
] as const;

async function eventActionTargets(page: Page): Promise<Sample['minEventTarget']> {
  let smallest: Sample['minEventTarget'] = null;
  for (const id of EVENT_ACTION_CONTROLS) {
    const locator = page.getByTestId(id);
    if ((await locator.count()) === 0) continue;
    const b = await locator.first().boundingBox();
    if (!b) continue;
    const entry = { name: id, width: Math.round(b.width), height: Math.round(b.height) };
    if (!smallest || entry.height < smallest.height || entry.width < smallest.width) smallest = entry;
  }
  return smallest;
}

/** Opens both disclosures of the event page, if the page has them. */
async function openEventDisclosures(page: Page): Promise<void> {
  for (const id of ['event-calendar-more', 'share-toggle'] as const) {
    const locator = page.getByTestId(id);
    if ((await locator.count()) > 0) await locator.click();
  }
}

/**
 * The member panel's own controls, as the THUMB sees them: the three toggle rows
 * and the two links.
 *
 * MEASURING THE ROW, NOT THE GLYPH. Each toggle is a `<label>` wrapping its
 * checkbox and carrying `min-h-11`, so the whole 44px row is the clickable area
 * while the checkbox itself stays 16px. Measuring `input[type=checkbox]` would
 * report a 16px box and demand a 44px checkbox — a control nobody has to hit,
 * because the thumb hits the row. What must NOT change is that the input is still
 * a real checkbox; that is asserted by event-actions.spec.ts, which drives it
 * through its PATCH endpoint.
 */
async function memberPanelTargets(
  page: Page,
): Promise<{ name: string; width: number; height: number }[]> {
  return page.evaluate(() => {
    const out: { name: string; width: number; height: number }[] = [];
    const record = (name: string, el: Element | null | undefined) => {
      if (!el) return;
      const r = el.getBoundingClientRect();
      out.push({ name, width: Math.round(r.width), height: Math.round(r.height) });
    };
    for (const id of ['attendance-toggle', 'event-directory-toggle', 'event-marketing-toggle']) {
      const input = document.querySelector(`[data-testid="${id}"]`);
      record(id, input?.closest('label') ?? input);
    }
    const panel = document.querySelector('[data-testid="member-panel"]');
    for (const link of panel?.querySelectorAll('a') ?? []) {
      record(link.getAttribute('data-testid') ?? `link:"${(link.textContent ?? '').trim()}"`, link);
    }
    return out;
  });
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

/**
 * Horizontal overflow of the document, in CSS pixels — the same number
 * `measure()` records, asked again after a disclosure has been opened.
 */
async function overflowPx(page: Page): Promise<number> {
  return page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth));
}

/**
 * The event page's action hierarchy, in one place, so the un-themed pass and
 * every themed pass are held to the same four answers: the join action is the
 * page's first control AND its bottom edge is on the first screen, the two
 * secondary options are collapsed, and the controls the hierarchy owns — before
 * and after the disclosures are opened — clear 44px without the revealed panel
 * overflowing.
 */
function checkEventHierarchy(
  label: string,
  measured: Pick<Sample, 'order' | 'joinBottom' | 'actionAboveFold'>,
  collapsed: Sample['minEventTarget'],
  expanded: Sample['minEventTarget'],
  expandedOverflowPx: number,
  expandedAxe: string[],
  problems: string[],
): void {
  if (measured.order[0] !== 'join-button') {
    problems.push(`${label}: the join action is not the event page's first control (${measured.order.join(', ') || 'none'})`);
  }
  if (measured.joinBottom === null) {
    problems.push(`${label}: the event page rendered no join control to measure`);
  } else if (!measured.actionAboveFold) {
    problems.push(`${label}: the join action ends at ${measured.joinBottom}, below the first screen`);
  }
  if (measured.order.includes('event-gcal')) {
    problems.push(`${label}: the Google template is not collapsed behind the calendar control`);
  }
  if (measured.order.includes('share-linkedin')) {
    problems.push(`${label}: the deeplinks are not collapsed behind the share control`);
  }
  for (const target of [collapsed, expanded]) {
    if (target && (target.width < 44 || target.height < 44)) {
      problems.push(`${label}: action control "${target.name}" is ${target.width}×${target.height}, below the 44px touch target`);
    }
  }
  if (expandedOverflowPx > 0) {
    problems.push(`${label}: the opened disclosures overflow by ${expandedOverflowPx}px`);
  }
  for (const finding of expandedAxe) problems.push(`${label} expanded axe: ${finding}`);
}

/**
 * axe, at EVERY impact level, plus the colour-contrast rule called out by name.
 *
 * The severity filter is deliberately gone. It used to keep only `serious` and
 * `critical`, which meant a `moderate` finding (the review bar itself once
 * reported as an un-landmarked `region`) could not fail this gate. An exemption
 * that only exists because an assertion was narrow is not a decision, so the
 * assertion is now as wide as axe is.
 */
async function scan(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  const violations = results.violations.map((v) => `${v.id} [${v.impact}] ${v.help} (${v.nodes.length} node(s))`);
  for (const v of results.violations) {
    console.log(`      axe ${v.id} [${v.impact}] ${v.nodes.length} node(s)`);
    for (const node of v.nodes.slice(0, 3)) console.log(`        ${node.html.slice(0, 140)}`);
  }
  const contrast = results.violations.find((v) => v.id === 'color-contrast');
  return { violations, contrastNodes: contrast?.nodes.length ?? 0 };
}

test.beforeAll(() => {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
});

/**
 * THE CONTROL-SHAPED ELEMENTS OF A PAGE — what the 44px rule is applied to.
 *
 * Deliberately NOT `main a`. The landing's links and the legal pages' links are
 * mostly LINKS IN A SENTENCE ("Privacy Policy", the repository URL, a contact
 * address in the middle of a paragraph of policy text), and WCAG 2.5.8 exempts
 * exactly that case from the target-size rule: an inline link's box is the line
 * box, and padding it out to 44px would break the sentence it lives in. What the
 * rule IS applied to is the controls a thumb is meant to hit — the site chrome,
 * the page's own actions, and a disclosure's row — which is the set below.
 */
const CONTROL_SELECTOR = [
  '[data-testid="theme-bar"] button',
  'header a',
  'header button',
  'main summary',
  'main a.btn-accent',
  'main a.btn-outline',
  'main a.btn-light',
  'main a.btn-primary',
  'main a.btn-nav',
].join(', ');

/** Every visible control on the page, with its measured box. */
async function controls(page: Page): Promise<{ name: string; width: number; height: number }[]> {
  return page.locator(CONTROL_SELECTOR).evaluateAll((els) =>
    els
      .filter((el) => (el as HTMLElement).offsetParent !== null)
      .map((el) => {
        const b = el.getBoundingClientRect();
        return {
          name:
            el.getAttribute('data-testid') ??
            (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 24),
          width: Math.round(b.width),
          height: Math.round(b.height),
        };
      }),
  );
}

/**
 * THE LANDING AND THE LEGAL PAGES ARE IN THIS SWEEP TOO.
 *
 * They used to be outside it: the themed sweep covered the card and the event, and
 * the landing (`/`) and the two legal pages were scanned only by a11y.spec.ts in
 * the DEFAULT look, at whatever viewport that test happened to be using. So the
 * four themes — four token sets over one markup, three of which the owner reviews
 * on a phone — were never checked on the three surfaces that carry the most
 * content, and neither was the 360px layout.
 *
 * What is asserted here per pass, for `visitor` (no cookie, no bar) plus each of
 * the four themes, at 390px AND 360px:
 *   · axe at EVERY impact level (the same `scan()` the card and the event use);
 *   · horizontal overflow, in pixels;
 *   · the 44px rule on every control-shaped element (see CONTROL_SELECTOR).
 *
 * What is NOT asserted here, on purpose: the bar's geometry against a primary
 * action. Those pages have no single card whose bottom edge the bar must clear —
 * the bar sits below the page's own footer, and the check that it does not cover
 * the card's action belongs to the card and event tests above.
 */
test('design review: the landing and the legal pages hold in all four themes at 390 and 360', async ({ page }) => {
  test.setTimeout(180_000);
  const problems: string[] = [];
  const surfaces = ['/', '/legal/privacy', '/legal/terms'] as const;

  for (const theme of ['visitor', ...THEMES] as const) {
    for (const surface of surfaces) {
      for (const viewport of [MOBILE, NARROW]) {
        await page.setViewportSize(viewport);
        const url = theme === 'visitor' ? surface : `${surface}?theme=${theme}`;
        const response = await page.goto(url);
        expect(response?.status(), `${surface} ${theme}`).toBe(200);
        await waitHydrated(page);

        // The pass must BE the pass it claims: an un-themed page carries no
        // attribute and no bar; a themed one carries both, and the bar says which.
        if (theme === 'visitor') {
          expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme')), surface).toBeNull();
          await expect(page.getByTestId('theme-bar')).toHaveCount(0);
        } else {
          await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
          await expect(page.getByTestId('theme-bar')).toBeVisible();
        }

        const axe = await scan(page);
        const overflow = await overflowPx(page);
        const measured = await controls(page);
        const where = `${theme} ${surface} @${viewport.width}`;

        if (overflow > 0) problems.push(`${where}: horizontal overflow of ${overflow}px`);
        for (const finding of axe.violations) problems.push(`${where}: ${finding}`);
        for (const control of measured) {
          if (control.width < 44 || control.height < 44) {
            problems.push(`${where}: control "${control.name}" is ${control.width}×${control.height}, below the 44px touch target`);
          }
        }
        // A page with no controls at all would pass the loop above by having
        // nothing to measure — so the chrome itself is the floor.
        if (measured.length === 0) problems.push(`${where}: no controls were found to measure`);
        console.log(
          `[themes] ${where}: overflow=${overflow}px axe=${axe.violations.length} controls=${measured.length} smallest=${Math.min(...measured.map((c) => Math.min(c.width, c.height)))}px`,
        );
      }
    }
  }

  expect(problems, `public-surface theme sweep findings:\n${problems.join('\n')}`).toEqual([]);
});

test('design review: card and event hold the bar in all four themes at 390 and 360', async ({ page }) => {
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
      const isEvent = target.page === 'event';
      if (isEvent) {
        const collapsedTargets = await eventActionTargets(page);
        await openEventDisclosures(page);
        const expandedAxe = await scan(page);
        samples.push({
          theme: 'none',
          page: target.page,
          viewport: `${viewport.width}`,
          ...measured,
          minEventTarget: collapsedTargets,
          expandedOverflowPx: await overflowPx(page),
          expandedAxeViolations: expandedAxe.violations,
          minTapTarget: null,
          axeViolations: axe.violations,
          axeContrastNodes: axe.contrastNodes,
        });
        checkEventHierarchy(`none @${viewport.width}`, measured, collapsedTargets, 
          await eventActionTargets(page), await overflowPx(page), expandedAxe.violations, problems);
      } else {
        samples.push({
          theme: 'none',
          page: target.page,
          viewport: `${viewport.width}`,
          ...measured,
          minTapTarget: null,
          axeViolations: axe.violations,
          axeContrastNodes: axe.contrastNodes,
        });
      }
      if (viewport === MOBILE) {
        const cardSelector = target.page === 'card' ? '[data-testid="pubcard"]' : 'main .card';
        await hideDevOverlay(page);
        await page.locator(cardSelector).first().screenshot({
          path: path.join(EVIDENCE_DIR, `${target.page}-390-visitor.png`),
        });
      }
      console.log(
        `[themes] none ${target.page} @${viewport.width}: cardBottom=${measured.cardBottom} title=${measured.titleBottom} action=${measured.actionTop}–${measured.actionBottom} overflow=${measured.overflowPx}px axe=${axe.violations.length}`,
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
        // `?theme=` is the way INTO review mode, and it is a channel on whatever
        // page the override covers (`/p/*`, here). It is NOT a channel on
        // `/e/<slug>`: the proxy's matcher scopes both `?theme=` and `?lang=` to
        // the same four public entry points, so the event page is reached with
        // the COOKIE this very loop set one iteration earlier — card first, then
        // event, per the `targets` order above.
        //
        // That ordering is load-bearing, and the line that used to stand here
        // ("each visit states it explicitly") was simply wrong about the event:
        // swapping the two targets would leave the event un-themed. The rule
        // itself is pinned, symmetrically for both parameters, by the dedicated
        // test at the end of this file.
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
        const isEvent = target.page === 'event';
        const collapsedEventTargets = isEvent ? await eventActionTargets(page) : null;
        let expandedOverflow = 0;
        let expandedAxe: string[] = [];
        let expandedEventTargets: Sample['minEventTarget'] = null;
        if (isEvent) {
          await openEventDisclosures(page);
          expandedAxe = (await scan(page)).violations;
          expandedOverflow = await overflowPx(page);
          expandedEventTargets = await eventActionTargets(page);
        }
        samples.push({
          theme,
          page: target.page,
          viewport: label,
          ...measured,
          minEventTarget: collapsedEventTargets,
          expandedOverflowPx: expandedOverflow,
          expandedAxeViolations: expandedAxe,
          minTapTarget: tap,
          axeViolations: axe.violations,
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
        if (axe.violations.length > 0) problems.push(`${where}: ${axe.violations.join(' | ')}`);
        if (tap && (tap.height < 44 || tap.width < 44)) {
          problems.push(`${where}: tap target ${tap.name} is ${tap.width}×${tap.height}, below 44px`);
        }
        if (target.page === 'event') {
          checkEventHierarchy(
            where,
            measured,
            collapsedEventTargets,
            expandedEventTargets,
            expandedOverflow,
            expandedAxe,
            problems,
          );
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
            `[themes] ${where}: cardBottom=${measured.cardBottom} title=${measured.titleBottom} action=${measured.actionTop}–${measured.actionBottom} bar=${measured.barTop} overflow=${measured.overflowPx}px axe=${axe.violations.length}`,
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

  // ── The member panel, in every theme ───────────────────────────────────────
  //
  // WHY A SECOND PHASE. The sweep above measures the page a VISITOR gets, and a
  // visitor has no participation panel (it is rendered only for an active member).
  // The panel's own controls were therefore the one part of the event page that
  // no theme pass had ever looked at — which is how they reached this change
  // sitting below the 44px target. They are measured here, in all four themes and
  // in the un-themed pass, at both widths: axe at every impact, horizontal
  // overflow, and the 44px rule.
  //
  // The panel joins the event HERE, at the end, deliberately: joining replaces
  // the join button with the member state, and the hierarchy assertions above are
  // about the page BEFORE that happens.
  const panelSamples: {
    theme: Theme | 'none';
    viewport: string;
    overflowPx: number;
    axeViolations: string[];
    targets: { name: string; width: number; height: number }[];
  }[] = [];
  {
    // The product's way into a named theme is the query on an entry point the
    // override COVERS (`/p/*`), which sets the cookie; the event page is then
    // reached with that cookie. Stated here rather than relied on incidentally:
    // the main loop's card-then-event order makes the same thing happen, but
    // nothing in it says so, which is exactly how "?theme= works on /e/" became
    // a plausible reading of this file.
    const EVENT_PATH = '/e/e2e-themed-meetup';

    await page.goto(EVENT_PATH);
    await waitHydrated(page);
    const join = page.getByTestId('join-button');
    if ((await join.count()) > 0) {
      await join.click();
    }
    await expect(page.getByTestId('member-panel')).toBeVisible({ timeout: 30_000 });

    for (const theme of ['none', ...THEMES] as const) {
      for (const viewport of [MOBILE, NARROW]) {
        await page.setViewportSize(viewport);
        if (theme === 'none') {
          // Only the theme cookie: clearing them all would sign the member out,
          // and this phase needs the member.
          await page.context().clearCookies({ name: 'welcome_theme' });
          await page.goto(EVENT_PATH);
        } else {
          await page.goto(`${cardPath}?theme=${theme}`);
          await page.goto(EVENT_PATH);
        }
        await waitHydrated(page);
        await expect(page.getByTestId('member-panel'), `panel must render (${theme})`).toBeVisible();

        const where = `${theme} member-panel @${viewport.width}`;
        const overflow = await overflowPx(page);
        const axe = await scan(page);
        const targets = await memberPanelTargets(page);
        panelSamples.push({ theme, viewport: `${viewport.width}`, overflowPx: overflow, axeViolations: axe.violations, targets });

        if (theme === 'none') {
          expect(page.locator('html'), 'the un-themed pass must carry no data-theme').not.toHaveAttribute('data-theme', /.*/);
        } else {
          await expect(page.locator('html'), `${where} theme must apply`).toHaveAttribute('data-theme', theme);
        }
        if (overflow > 0) problems.push(`${where}: horizontal overflow of ${overflow}px`);
        if (axe.violations.length > 0) problems.push(`${where}: ${axe.violations.join(' | ')}`);
        // Five controls: three rows and two links. A shorter list would mean the
        // measurement silently stopped covering something.
        if (targets.length !== 5) {
          problems.push(`${where}: expected 5 panel controls, measured ${targets.length} (${JSON.stringify(targets)})`);
        }
        for (const t of targets) {
          if (t.width < 44 || t.height < 44) {
            problems.push(`${where}: ${t.name} is ${t.width}×${t.height}, below the 44px touch target`);
          }
        }
        console.log(
          `[themes] ${where}: overflow=${overflow}px axe=${axe.violations.length} targets=${JSON.stringify(targets)}`,
        );
      }
    }
  }

  // Written BEFORE the assertions: evidence has to survive a failing run.
  writeFileSync(
    path.join(EVIDENCE_DIR, 'measurements.json'),
    `${JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        note: 'Measured in Chromium at 390x844 and 360x740 by tests/e2e/design-themes.spec.ts. Theme "none" is the visitor pass (no cookie, no query, no bar). overflowPx > 0, a bar above cardBottom, or an event page whose join control is not its first control and on the first screen would be a failure, not a tolerance. axeViolations and expandedAxeViolations list EVERY violation of any impact: they must be empty, so any entry here is a failure, not a note. minEventTarget/expandedOverflowPx describe the controls the event action hierarchy owns, before and after its two disclosures are opened. member_panel is the second phase: the participation panel, which only a member sees, measured in all four themes and the un-themed pass at both widths — its toggle ROWS (the labels that carry the 44px target, not the 16px boxes inside them) and its two links.',
        samples,
        member_panel: panelSamples,
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
  // empty string. Every theme name is pulled from the dictionary, so adding a
  // theme without translating it fails here rather than shipping an English word
  // into a Russian bar.
  const cases = [
    {
      lang: 'en',
      bar: must(en['theme.bar'], 'en'),
      exit: must(en['theme.exit'], 'en'),
      defaultName: must(en['theme.soft'], 'en'),
      names: THEMES.map((theme) => must(en[themeLabelKey(theme)], 'en')),
    },
    {
      lang: 'ru',
      bar: must(ru['theme.bar'], 'ru'),
      exit: must(ru['theme.exit'], 'ru'),
      defaultName: must(ru['theme.soft'], 'ru'),
      names: THEMES.map((theme) => must(ru[themeLabelKey(theme)], 'ru')),
    },
    {
      lang: 'es',
      bar: must(es['theme.bar'], 'es'),
      exit: must(es['theme.exit'], 'es'),
      defaultName: must(es['theme.soft'], 'es'),
      names: THEMES.map((theme) => must(es[themeLabelKey(theme)], 'es')),
    },
  ];
  for (const { lang, bar, exit, defaultName, names } of cases) {
    await page.goto(`${cardPath}?lang=${lang}&theme=soft`);
    await waitHydrated(page);
    const barLocator = page.getByTestId('theme-bar');
    await expect(barLocator).toBeVisible();
    await expect(barLocator).toContainText(bar);
    await expect(barLocator).toContainText(defaultName);
    await expect(barLocator).toContainText(exit);

    // Four controls, one per theme, each with real text...
    const rendered = (await page.locator('[data-testid="theme-switcher"] button').allTextContents()).map((n) => n.trim());
    expect(rendered).toHaveLength(THEMES.length);
    for (const name of rendered) expect(name.length).toBeGreaterThan(0);
    // ...and four DISTINCT names: a switcher offering the same word twice is a
    // switcher you cannot use. (Premium reads "Premium" in EN and ES, which is
    // the word in both languages — the requirement is distinctness WITHIN a
    // locale, so that is what is asserted.)
    expect(new Set(rendered).size, `[${lang}] duplicate theme names: ${rendered.join(' / ')}`).toBe(THEMES.length);
    // The rendered names ARE this locale's dictionary values, in switcher order.
    expect(rendered).toEqual(names);
    console.log(`[themes] ${lang}: ${rendered.join(' / ')}`);
  }
});

test('design review: in premium the chip groups are told apart without colour', async ({ page }) => {
  test.setTimeout(120_000);
  const { cardPath } = await seed(page, {
    email: 'themes-carrier@example.org',
    name: 'Carrier Owner',
    slug: 'e2e-themed-carrier',
  });
  await page.setViewportSize(MOBILE);

  const offersLabel = must(en['pubcard.helpTitle'], 'en');
  const needsLabel = must(en['pubcard.lookingFor'], 'en');
  expect(offersLabel, 'the two group headings must be different words').not.toBe(needsLabel);

  await page.goto(`${cardPath}?theme=premium`);
  await waitHydrated(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'premium');

  // 1. THE PREMISE, MEASURED RATHER THAN ASSUMED. `premium` paints an offer chip
  //    and a need chip with the same value, which is the whole reason the group
  //    has to be announced. If a later change gives them different colours, this
  //    assertion fails and that is the moment to revisit the decision — not to
  //    delete the assertion.
  const chipPaint = await page.evaluate(() => {
    const read = (selector: string) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const style = getComputedStyle(el);
      return { background: style.backgroundColor, color: style.color, radius: style.borderTopLeftRadius };
    };
    return { offer: read('.chip-offer'), need: read('.chip-need') };
  });
  expect(chipPaint.offer, 'the fixture must render an offer chip').not.toBeNull();
  expect(chipPaint.need, 'the fixture must render a need chip').not.toBeNull();
  expect(
    chipPaint.offer,
    'premium must paint both chip kinds identically — that is the premise of this test',
  ).toEqual(chipPaint.need);

  // 2. THE DIFFERENCE IS ANNOUNCED. Each list carries its own accessible name,
  //    so a screen reader user hears which group a chip belongs to. Asking for
  //    the list BY NAME is the assertion: an unnamed list cannot be found this
  //    way at all, so this cannot pass by accident.
  const offersList = page.getByRole('list', { name: offersLabel });
  const needsList = page.getByRole('list', { name: needsLabel });
  await expect(offersList, `no list is named "${offersLabel}" in premium`).toBeVisible();
  await expect(needsList, `no list is named "${needsLabel}" in premium`).toBeVisible();
  await expect(page.getByTestId('pubcard-offers')).toContainText(offersLabel);
  await expect(page.getByTestId('pubcard-needs')).toContainText(needsLabel);

  // 3. ...AND THE CHIPS DIFFER IN TEXT, not only in place.
  const chips = async (list: typeof offersList) =>
    (await list.getByRole('listitem').allTextContents()).map((text) => text.trim()).filter((text) => text.length > 0);
  const offers = await chips(offersList);
  const needs = await chips(needsList);
  expect(offers.length, 'the offers group must render at least one chip').toBeGreaterThan(0);
  expect(needs.length, 'the needs group must render at least one chip').toBeGreaterThan(0);
  for (const text of offers) {
    expect(needs, `"${text}" appears in both groups, so the groups differ only in place`).not.toContain(text);
  }

  // 4. The tightened axe bar applies to this page too, at the theme whose whole
  //    point is that hue carries nothing.
  const axe = await scan(page);
  expect(axe.violations, `premium axe findings:\n${axe.violations.join('\n')}`).toEqual([]);

  console.log(
    `[themes] premium carrier: offers [${offers.join(', ')}] vs needs [${needs.join(', ')}]; lists named "${offersLabel}" / "${needsLabel}"; axe=${axe.violations.length}`,
  );
});

/**
 * The two query overrides are scoped IDENTICALLY — pinned here, symmetrically,
 * because this is the invariant that was documented and tested for one parameter
 * and only accidentally true for the other.
 *
 * WHAT WAS ACTUALLY WRONG. An earlier report in this session stated that
 * `?theme=` covers `/e/:path*` while `?lang=` does not, on the grounds that a
 * themed event page had been observed. That observation was real; the conclusion
 * was not. Neither override is a channel on `/e/<slug>` — `src/proxy.ts`'s
 * matcher is the same four entry points for both — and a themed event page is
 * reached with the COOKIE the query set on a covered page. The main sweep above
 * cannot tell those two mechanisms apart, because it visits the card (setting the
 * cookie) immediately before the event, so its `?theme=` on the event is a no-op
 * that happens to look like it worked. This test removes the ambiguity: it asks
 * each page for the override DIRECTLY, with no preceding visit to plant a cookie.
 *
 * It asserts both directions for both parameters. If someone later widens the
 * matcher to cover `/e/:path*`, this fails and says so — which is the point:
 * "the query works everywhere" and "the query works on four entry points and the
 * cookie carries it" are different products, and the choice between them should
 * be made deliberately (docs-internal/design/THEMES.md decision 4) rather than
 * drift in as a side effect.
 */
test('design review: ?theme= and ?lang= are channels on exactly the same entry points', async ({ page }) => {
  test.setTimeout(120_000);
  const EVENT_SLUG = 'e2e-override-scope';
  const { cardPath } = await seed(page, {
    email: 'override-scope@example.org',
    name: 'Override Scope',
    slug: EVENT_SLUG,
  });

  // A clean context: no theme cookie, no locale cookie, nothing planted.
  await page.context().clearCookies();

  // 1. BOTH work on a covered entry point (/p/*). The card is the entry point the
  //    product itself uses to enter review mode.
  await page.goto(`${cardPath}?theme=poster&lang=ru`);
  await waitHydrated(page);
  await expect(page.locator('html'), '?theme= must be a channel on /p/*').toHaveAttribute('data-theme', 'poster');
  await expect(page.locator('html'), '?lang= must be a channel on /p/*').toHaveAttribute('lang', 'ru');

  // 2. NEITHER works on /e/<slug>, with no cookie present. This is the assertion
  //    the missing half of the pair made it possible to get wrong.
  await page.context().clearCookies();
  await page.goto(`/e/${EVENT_SLUG}?theme=poster&lang=ru`);
  await waitHydrated(page);
  await expect(page.locator('html'), '?theme= must NOT be a channel on /e/<slug>').not.toHaveAttribute('data-theme', /.*/);
  await expect(page.locator('html'), '?lang= must NOT be a channel on /e/<slug>').not.toHaveAttribute('lang', 'ru');

  // 3. BOTH arrive on /e/<slug> by COOKIE — the same cookie, set the same way, on
  //    the same entry point. This is the half that made `?theme=` look like it
  //    covered the event page.
  await page.goto(`${cardPath}?theme=poster&lang=ru`);
  await page.goto(`/e/${EVENT_SLUG}`);
  await waitHydrated(page);
  await expect(page.locator('html'), 'the theme cookie must reach /e/<slug>').toHaveAttribute('data-theme', 'poster');
  await expect(page.locator('html'), 'the locale cookie must reach /e/<slug>').toHaveAttribute('lang', 'ru');

  console.log('[themes] override scope: ?theme= and ?lang= both cover /p/* only; /e/<slug> follows the cookie for both');
});
