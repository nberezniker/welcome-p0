import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { en } from '../../src/i18n/en';

/**
 * THE DESIGN GATE — the look that ships, measured rather than asserted.
 *
 * This file is what remains of the four-direction design review. The owner
 * compared the candidate directions on real pages on a real phone, chose the one
 * that ships, and the comparison itself was removed: the token layer stayed
 * (docs-internal/design/THEMES.md records the contract and the recipe for adding
 * a direction back), the switcher, its cookie and its `?theme=` plumbing did not.
 * So there is ONE pass per surface now, not a pass per theme — and the
 * assertions below are unchanged in kind, which is the point: the gate never
 * depended on the theme loop, only on what a visitor's browser can show.
 *
 * 1. LANDING AND THE LEGAL PAGES (`/`, `/legal/privacy`, `/legal/terms`) at 390
 *    AND 360: axe at every impact level, horizontal overflow, and the 44px rule
 *    on every control-shaped element. These three carry the most content and are
 *    read on phones; before this sweep existed they were scanned only in the
 *    default look at whatever viewport another test happened to use.
 *
 * 2. THE CARD AND THE EVENT, the two pages the design direction was judged on,
 *    plus the member panel — the one part of the event page a visitor never sees,
 *    which is how its toggle rows reached a downstream review sitting below the
 *    44px floor. The panel joins the event at the END on purpose: joining
 *    replaces the join button with the member state, and the hierarchy
 *    assertions are about the page BEFORE that happens.
 *
 * 3. THE CARD'S CHIP GROUPS are told apart BY NAME, not by hue: the token layer
 *    permits a design to paint an offer chip and a need chip with the same value,
 *    so the two lists are found by their accessible names and the chips are
 *    asserted to say different words. tests/unit/design-tokens.test.ts pins the
 *    same fact in the source and in all three dictionaries.
 *
 * 4. THE CABINET'S MEMBERSHIP EDITOR (`/me/events`): its two consent rows were
 *    the last bare `size-4` checkboxes in the product — a 16px box, measured as
 *    the control rather than as the row a thumb hits. They are measured here,
 *    like the event panel's rows, at both widths.
 *
 * AXE: ZERO VIOLATIONS OF ANY IMPACT. The assertion deliberately admits no
 * severity level — a finding is either fixed or it is a real problem, and there
 * is no third category in which a finding is nobody's problem.
 *
 * THE TWO TOUCH BARS, AND WHY THERE ARE TWO. Every control a thumb is meant to
 * hit clears the product's 44px floor, and that is what the assertions below
 * hold. There is exactly one documented exception: `.btn-small` (36px), the
 * compact variant the cabinet and organizer console use for density on purpose
 * and which the public card's own share strip uses — a row of four deeplinks
 * that is the card's "pass me on" affordance rather than its primary action.
 * Those controls are still MEASURED and recorded every run, and asserted against
 * the bar that actually applies to them (24×24, WCAG 2.5.8 AA), so the exception
 * is a number in the evidence rather than an exemption in the code; the smallest
 * one today is the "X" link at 34×36. Raising that row to 44px is a change to the
 * card's own layout (its height and its line breaks), which is the owner's call
 * and not a side effect of this gate.
 *
 * WHY 390 AND 360 ARE MEASURED, NOT ASSUMED. 390×844 is the iPhone 14 class;
 * 360×740 is the widest "small Android" that still sells. A layout that fits one
 * and wraps, overflows or mislays a target at the other is the failure this
 * catches.
 */

const EVIDENCE_DIR = path.join(process.cwd(), 'evidence', 'design');
const MOBILE = { width: 390, height: 844 };
const NARROW = { width: 360, height: 740 };

interface Sample {
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
  /** Smallest control-shaped element on the whole page — the 44px rule. */
  minTapTarget: { name: string; width: number; height: number } | null;
  /**
   * The documented compact controls (`.btn-small`, 36px) — recorded, and held to
   * the 24px WCAG 2.5.8 bar rather than the product's 44px one. See the note at
   * the top of the file.
   */
  compactTargets: { name: string; width: number; height: number }[];
  /** EVERY axe violation, of any impact — see the note at the top of the file. */
  axeViolations: string[];
  axeContrastNodes: number;
}

const samples: Sample[] = [];

/**
 * Hides the `next dev` indicator before a screenshot.
 *
 * The suite runs against `next dev` (playwright.config.ts), and Next's own dev
 * overlay is a fixed-position `nextjs-portal` that lands somewhere inside an
 * element screenshot of a card taller than the viewport. It is not part of the
 * page, it moves between two shots of the SAME page, and it would otherwise make
 * the evidence unreadable. Re-injected per navigation, because a new document
 * drops it.
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
 * An account with a card that exercises every designed element — all three chip
 * kinds, the eyebrow, both button families, muted body text and the accent
 * action — plus an event whose join button is the primary action and which
 * carries a real schedule, so the calendar and share controls this sweep must
 * measure actually exist. Seeded through the public APIs, so the fixture is the
 * real shape a reviewer would judge.
 */
async function seed(page: Page, opts: { email: string; name: string; slug: string }): Promise<{ cardPath: string }> {
  await loginViaOtp(page, opts.email);

  // The first save CREATES the profile, which is the only path that needs no
  // `revision` (src/domain/profile.ts requires one to update an existing row).
  const profile = await page.request.post('/api/me/profile', {
    data: {
      display_name: opts.name,
      headline: 'One design, one token layer',
      company: 'WELCOME',
      short_bio: 'Two lines of body copy so the card has real text at body size.',
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
      name: `Design Gate Meetup ${opts.slug}`,
      slug: opts.slug,
      mode: 'offline',
      access_mode: 'public',
      timezone: 'UTC',
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
async function measure(page: Page): Promise<Omit<Sample, 'page' | 'viewport' | 'axeViolations' | 'axeContrastNodes' | 'minTapTarget'>> {
  const pageWidth = await page.evaluate(() => window.innerWidth);
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const viewportHeight = await page.evaluate(() => window.innerHeight);

  const card = await box(page, '[data-testid="pubcard"], main .card');
  const title = await box(page, '[data-testid="pubcard-name"], main .card h1');
  const action =
    (await box(page, '[data-testid="pubcard-signin-cta"] a, [data-testid="pubcard-intro-cta"]')) ??
    (await box(page, '[data-testid="join-button"]'));
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
    compactTargets: [],
  };
}

/**
 * The controls the event page's ACTION HIERARCHY owns, with the 44px rule on
 * both axes. The participation panel's own controls are deliberately not here:
 * they are measured in their own phase below, and folding an unrelated
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
 * A consent row measured the way a THUMB meets it: the `<label>` that carries
 * `min-h-11`, not the 16px checkbox inside it.
 *
 * MEASURING THE ROW, NOT THE GLYPH. Each toggle wraps its checkbox in a label, so
 * the whole 44px row is the clickable area while the checkbox itself stays 16px.
 * Measuring `input[type=checkbox]` would report a 16px box and demand a 44px
 * checkbox — a control nobody has to hit, because the thumb hits the row. What
 * must NOT change is that the input is still a real checkbox driving the same
 * endpoint; every test that drives one does it through that endpoint.
 */
async function consentRows(page: Page, testIdPrefixes: readonly string[]) {
  return page.evaluate((prefixes) => {
    const out: { name: string; width: number; height: number }[] = [];
    const selector = prefixes
      .map((prefix) => `input[type="checkbox"][data-testid^="${prefix}"]`)
      .join(', ');
    for (const input of document.querySelectorAll(selector)) {
      const row = input.closest('label') ?? input;
      const b = row.getBoundingClientRect();
      out.push({
        name: input.getAttribute('data-testid') ?? '',
        width: Math.round(b.width),
        height: Math.round(b.height),
      });
    }
    return out;
  }, testIdPrefixes);
}

/**
 * The member panel's own controls, as the THUMB sees them: the three toggle rows
 * and the two links.
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

/**
 * Horizontal overflow of the document, in CSS pixels — the same number
 * `measure()` records, asked again after a disclosure has been opened.
 */
async function overflowPx(page: Page): Promise<number> {
  return page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth));
}

/**
 * The event page's action hierarchy, in one place, so every pass is held to the
 * same four answers: the join action is the page's first control AND its bottom
 * edge is on the first screen, the two secondary options are collapsed, and the
 * controls the hierarchy owns — before and after the disclosures are opened —
 * clear 44px without the revealed panel overflowing.
 */
function checkEventHierarchy(
  label: string,
  measured: Pick<Sample, 'order' | 'joinBottom' | 'actionAboveFold'>,
  collapsed: Sample['minEventTarget'],
  expanded: Sample['minEventTarget'],
  expandedOverflow: number,
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
  if (expandedOverflow > 0) {
    problems.push(`${label}: the opened disclosures overflow by ${expandedOverflow}px`);
  }
  for (const finding of expandedAxe) problems.push(`${label} expanded axe: ${finding}`);
}

/**
 * axe, at EVERY impact level, plus the colour-contrast rule called out by name.
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

/**
 * THE CONTROL-SHAPED ELEMENTS OF A PAGE — what the 44px rule is applied to.
 *
 * Deliberately NOT `main a`. The landing's links and the legal pages' links are
 * mostly LINKS IN A SENTENCE ("Privacy Policy", the repository URL, a contact
 * address in the middle of a paragraph of policy text), and WCAG 2.5.8 exempts
 * exactly that case from the target-size rule: an inline link's box is the line
 * box, and padding it out to 44px would break the sentence it lives in. What the
 * rule IS applied to is the controls a thumb is meant to hit — the site chrome,
 * the page's own actions, and a disclosure's row.
 *
 * `:not(.btn-small)` is the second, smaller exclusion, and it is a RECORDED one
 * rather than a silence: those controls are measured separately (see
 * `compactControls` and the note at the top of the file) and held to the 24px bar
 * that applies to them. Everything else here clears 44.
 */
const CONTROL_SELECTOR = [
  'header a:not(.btn-small)',
  'header button:not(.btn-small)',
  'main summary',
  'main a.btn-accent:not(.btn-small)',
  'main a.btn-outline:not(.btn-small)',
  'main a.btn-light:not(.btn-small)',
  'main a.btn-primary:not(.btn-small)',
  'main a.btn-nav',
  'main a.btn-small-tap',
].join(', ');

/** Every visible control on the page, with its measured box. */
async function controls(page: Page): Promise<{ name: string; width: number; height: number }[]> {
  return measuredBoxes(page, CONTROL_SELECTOR);
}

/**
 * The compact controls (`.btn-small`, 36px) — the documented density variant the
 * 44px rule does not cover. Measured anyway, on every pass, so the exception
 * stays a number in the evidence and its set cannot grow unnoticed.
 */
async function compactControls(page: Page): Promise<{ name: string; width: number; height: number }[]> {
  return measuredBoxes(page, 'main a.btn-small, main button.btn-small, header a.btn-small, header button.btn-small');
}

async function measuredBoxes(page: Page, selector: string): Promise<{ name: string; width: number; height: number }[]> {
  return page.locator(selector).evaluateAll((els) =>
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

/** The smallest control-shaped element on the page — the 44px rule, measured. */
function smallest(list: { name: string; width: number; height: number }[]): { name: string; width: number; height: number } | null {
  let out: { name: string; width: number; height: number } | null = null;
  for (const entry of list) {
    if (!out || entry.height < out.height || entry.width < out.width) out = entry;
  }
  return out;
}

test.beforeAll(() => {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
});

test('design gate: the landing and the legal pages hold at 390 and 360', async ({ page }) => {
  test.setTimeout(180_000);
  const problems: string[] = [];
  const surfaces = ['/', '/legal/privacy', '/legal/terms'] as const;

  for (const surface of surfaces) {
    for (const viewport of [MOBILE, NARROW]) {
      await page.setViewportSize(viewport);
      const response = await page.goto(surface);
      expect(response?.status(), surface).toBe(200);
      await waitHydrated(page);

      // One design and nothing else: the document must not carry an attribute
      // that could select a different token set.
      expect(
        await page.evaluate(() => document.documentElement.getAttribute('data-theme')),
        `${surface} must carry no data-theme attribute`,
      ).toBeNull();

      const axe = await scan(page);
      const overflow = await overflowPx(page);
      const measured = await controls(page);
      const compact = await compactControls(page);
      const where = `${surface} @${viewport.width}`;

      if (overflow > 0) problems.push(`${where}: horizontal overflow of ${overflow}px`);
      for (const finding of axe.violations) problems.push(`${where}: ${finding}`);
      for (const control of measured) {
        if (control.width < 44 || control.height < 44) {
          problems.push(`${where}: control "${control.name}" is ${control.width}×${control.height}, below the 44px touch target`);
        }
      }
      // The compact variant is not covered by the 44px floor, but it is not
      // exempt from measurement either: the WCAG 2.5.8 AA minimum applies, and
      // the numbers go into the log so the exception stays visible.
      for (const control of compact) {
        if (control.width < 24 || control.height < 24) {
          problems.push(`${where}: compact control "${control.name}" is ${control.width}×${control.height}, below the 24px AA minimum`);
        }
      }
      // A page with no controls at all would pass the loop above by having
      // nothing to measure — so the chrome itself is the floor.
      if (measured.length === 0) problems.push(`${where}: no controls were found to measure`);
      console.log(
        `[design] ${where}: overflow=${overflow}px axe=${axe.violations.length} controls=${measured.length} smallest=${Math.min(...measured.map((c) => Math.min(c.width, c.height)))}px compact=${compact.length}`,
      );
    }
  }

  expect(problems, `public-surface design sweep findings:\n${problems.join('\n')}`).toEqual([]);
});

test('design gate: the card, the event and the member panel hold at 390 and 360', async ({ page }) => {
  test.setTimeout(180_000);
  const { cardPath } = await seed(page, {
    email: 'design-gate-owner@example.org',
    name: 'Design Gate Owner',
    slug: 'e2e-design-gate',
  });

  const problems: string[] = [];
  const targets = [
    { page: 'card' as const, path: cardPath },
    { page: 'event' as const, path: '/e/e2e-design-gate' },
  ];

  for (const target of targets) {
    for (const viewport of [MOBILE, NARROW]) {
      await page.setViewportSize(viewport);
      const response = await page.goto(target.path);
      expect(response?.status()).toBe(200);
      await waitHydrated(page);

      // The visitor's page IS the shipped design: one design means no attribute
      // and no switcher, which is also the page a stranger opening a shared card
      // gets.
      expect(
        await page.evaluate(() => document.documentElement.getAttribute('data-theme')),
        `${target.page} must carry no data-theme attribute`,
      ).toBeNull();

      const measured = await measure(page);
      const axe = await scan(page);
      const tap = smallest(await controls(page));
      const compact = await compactControls(page);
      const isEvent = target.page === 'event';
      let collapsedTargets: Sample['minEventTarget'] = null;
      let expandedTargets: Sample['minEventTarget'] = null;
      let expandedOverflow = 0;
      let expandedAxe: string[] = [];
      if (isEvent) {
        collapsedTargets = await eventActionTargets(page);
        await openEventDisclosures(page);
        expandedAxe = (await scan(page)).violations;
        expandedOverflow = await overflowPx(page);
        expandedTargets = await eventActionTargets(page);
      }

      samples.push({
        page: target.page,
        viewport: `${viewport.width}`,
        ...measured,
        minEventTarget: collapsedTargets,
        expandedOverflowPx: expandedOverflow,
        expandedAxeViolations: expandedAxe,
        minTapTarget: tap,
        compactTargets: compact,
        axeViolations: axe.violations,
        axeContrastNodes: axe.contrastNodes,
      });

      const where = `${target.page} @${viewport.width}`;
      if (measured.overflowPx > 0) {
        problems.push(`${where}: horizontal overflow of ${measured.overflowPx}px (scrollWidth ${measured.scrollWidth})`);
      }
      if (measured.actionTop < 0) problems.push(`${where}: the primary action was not found`);
      // THE ABOVE-THE-FOLD RULE IS THE EVENT'S, not the card's. The card's own
      // primary action sits well below the fold and always has (the card is
      // ~1200px tall and the action is its last element); lifting it above the
      // fold means restructuring the card, which is a product decision this gate
      // records rather than smuggles in. The event is the page where the action
      // has to be the first control AND on the first screen.
      if (isEvent && !measured.actionAboveFold) {
        problems.push(`${where}: the primary action ends at ${measured.actionBottom}, below the first screen`);
      }
      if (axe.violations.length > 0) problems.push(`${where}: ${axe.violations.join(' | ')}`);
      if (tap && (tap.height < 44 || tap.width < 44)) {
        problems.push(`${where}: tap target ${tap.name} is ${tap.width}×${tap.height}, below 44px`);
      }
      for (const control of compact) {
        if (control.width < 24 || control.height < 24) {
          problems.push(`${where}: compact control "${control.name}" is ${control.width}×${control.height}, below the 24px AA minimum`);
        }
      }
      if (isEvent) {
        checkEventHierarchy(where, measured, collapsedTargets, expandedTargets, expandedOverflow, expandedAxe, problems);
      }

      // The screenshots that go in the evidence folder: the judged element at
      // 390px (only there — 360 is a layout probe, not a deliverable).
      if (viewport === MOBILE) {
        const cardSelector = target.page === 'card' ? '[data-testid="pubcard"]' : 'main .card';
        await hideDevOverlay(page);
        await page.locator(cardSelector).first().screenshot({
          path: path.join(EVIDENCE_DIR, `${target.page}-390.png`),
        });
        await page.screenshot({ path: path.join(EVIDENCE_DIR, `${target.page}-390-firstscreen.png`) });
      }
      console.log(
        `[design] ${where}: cardBottom=${measured.cardBottom} action=${measured.actionTop}–${measured.actionBottom} overflow=${measured.overflowPx}px axe=${axe.violations.length} smallest=${tap ? `${tap.width}×${tap.height}` : 'n/a'}`,
      );
    }
  }

  // ── The member panel ───────────────────────────────────────────────────────
  //
  // WHY A SECOND PHASE. The sweep above measures the page a VISITOR gets, and a
  // visitor has no participation panel (it is rendered only for an active member).
  // The panel's own controls were therefore the one part of the event page that
  // no design pass had ever looked at — which is how they reached a downstream
  // review sitting below the 44px floor. They are measured here at both widths:
  // axe at every impact, horizontal overflow, and the 44px rule.
  //
  // The panel joins the event HERE, at the end, deliberately: joining replaces
  // the join button with the member state, and the hierarchy assertions above are
  // about the page BEFORE that happens.
  const panelSamples: {
    viewport: string;
    overflowPx: number;
    axeViolations: string[];
    targets: { name: string; width: number; height: number }[];
  }[] = [];
  {
    await page.goto('/e/e2e-design-gate');
    await waitHydrated(page);
    const join = page.getByTestId('join-button');
    if ((await join.count()) > 0) await join.click();
    await expect(page.getByTestId('member-panel')).toBeVisible({ timeout: 30_000 });

    for (const viewport of [MOBILE, NARROW]) {
      await page.setViewportSize(viewport);
      await page.goto('/e/e2e-design-gate');
      await waitHydrated(page);
      await expect(page.getByTestId('member-panel'), 'the member panel must render').toBeVisible();

      const where = `member-panel @${viewport.width}`;
      const overflow = await overflowPx(page);
      const axe = await scan(page);
      const measuredTargets = await memberPanelTargets(page);
      panelSamples.push({ viewport: `${viewport.width}`, overflowPx: overflow, axeViolations: axe.violations, targets: measuredTargets });

      if (overflow > 0) problems.push(`${where}: horizontal overflow of ${overflow}px`);
      if (axe.violations.length > 0) problems.push(`${where}: ${axe.violations.join(' | ')}`);
      // Five controls: three rows and two links. A shorter list would mean the
      // measurement silently stopped covering something.
      if (measuredTargets.length !== 5) {
        problems.push(`${where}: expected 5 panel controls, measured ${measuredTargets.length} (${JSON.stringify(measuredTargets)})`);
      }
      for (const t of measuredTargets) {
        if (t.width < 44 || t.height < 44) {
          problems.push(`${where}: ${t.name} is ${t.width}×${t.height}, below the 44px touch target`);
        }
      }
      console.log(`[design] ${where}: overflow=${overflow}px axe=${axe.violations.length} targets=${JSON.stringify(measuredTargets)}`);
    }
  }

  // Written BEFORE the assertions: evidence has to survive a failing run.
  writeFileSync(
    path.join(EVIDENCE_DIR, 'measurements.json'),
    `${JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        note: 'Measured in Chromium at 390x844 and 360x740 by tests/e2e/design-gate.spec.ts. One pass per surface: the product ships one design, so there is no theme dimension any more. overflowPx > 0, an event page whose join control is not its first control or is below the first screen, or a control below its touch bar would be a failure, not a tolerance. axeViolations and expandedAxeViolations list EVERY violation of any impact: they must be empty, so any entry here is a failure, not a note. minTapTarget is the smallest control-shaped element on the page; minEventTarget/expandedOverflowPx describe the controls the event action hierarchy owns, before and after its two disclosures are opened. compactTargets lists the documented .btn-small controls (the card share strip among them): they are excluded from the 44px floor and held to the 24px WCAG 2.5.8 minimum, and they are recorded so that exception stays a number rather than an exemption. member_panel is the second phase: the participation panel, which only a member sees — its toggle ROWS (the labels that carry the 44px target, not the 16px boxes inside them) and its two links.',
        samples,
        member_panel: panelSamples,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  expect(problems, `design-gate findings:\n${problems.join('\n')}`).toEqual([]);
});

test('design gate: the card tells its chip groups apart by name, not by hue', async ({ page }) => {
  test.setTimeout(120_000);
  const { cardPath } = await seed(page, {
    email: 'design-gate-carrier@example.org',
    name: 'Carrier Owner',
    slug: 'e2e-design-carrier',
  });
  await page.setViewportSize(MOBILE);

  const offersLabel = en['pubcard.helpTitle'];
  const needsLabel = en['pubcard.lookingFor'];
  expect(offersLabel, 'the two group headings must be different words').not.toBe(needsLabel);

  await page.goto(cardPath);
  await waitHydrated(page);
  expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBeNull();

  // The difference is ANNOUNCED. Each list carries its own accessible name, so a
  // screen reader user hears which group a chip belongs to. Asking for the list
  // BY NAME is the assertion: an unnamed list cannot be found this way at all, so
  // this cannot pass by accident.
  const offersList = page.getByRole('list', { name: offersLabel });
  const needsList = page.getByRole('list', { name: needsLabel });
  await expect(offersList, `no list is named "${offersLabel}"`).toBeVisible();
  await expect(needsList, `no list is named "${needsLabel}"`).toBeVisible();
  await expect(page.getByTestId('pubcard-offers')).toContainText(offersLabel);
  await expect(page.getByTestId('pubcard-needs')).toContainText(needsLabel);

  // ...AND THE CHIPS DIFFER IN TEXT, not only in place.
  const chips = async (list: typeof offersList) =>
    (await list.getByRole('listitem').allTextContents()).map((text) => text.trim()).filter((text) => text.length > 0);
  const offers = await chips(offersList);
  const needs = await chips(needsList);
  expect(offers.length, 'the offers group must render at least one chip').toBeGreaterThan(0);
  expect(needs.length, 'the needs group must render at least one chip').toBeGreaterThan(0);
  for (const text of offers) {
    expect(needs, `"${text}" appears in both groups, so the groups differ only in place`).not.toContain(text);
  }

  const axe = await scan(page);
  expect(axe.violations, `card axe findings:\n${axe.violations.join('\n')}`).toEqual([]);

  console.log(
    `[design] card carrier: offers [${offers.join(', ')}] vs needs [${needs.join(', ')}]; lists named "${offersLabel}" / "${needsLabel}"; axe=${axe.violations.length}`,
  );
});

test('design gate: the cabinet membership editor rows are 44px targets', async ({ page }) => {
  test.setTimeout(120_000);
  const slug = 'e2e-design-cabinet';
  // Own account, own fixture: the cabinet page needs a real membership, and the
  // membership editor renders one card per joined event.
  await loginViaOtp(page, 'design-gate-cabinet@example.org');
  const profile = await page.request.post('/api/me/profile', {
    data: { display_name: 'Cabinet Owner', languages: ['en'] },
  });
  expect(profile.status(), await profile.text()).toBe(200);
  const created = await page.request.post('/api/organizer/events', {
    data: { name: 'Design Gate Cabinet', slug, mode: 'offline', access_mode: 'public', timezone: 'UTC' },
  });
  expect(created.status(), await created.text()).toBe(201);
  const joined = await page.request.post(`/api/events/${slug}/join`, { data: {} });
  expect(joined.status(), await joined.text()).toBe(200);

  const problems: string[] = [];
  const rows = ['dir-toggle-', 'matching-toggle-'];

  for (const viewport of [MOBILE, NARROW]) {
    await page.setViewportSize(viewport);
    const response = await page.goto('/me/events');
    expect(response?.status()).toBe(200);
    await waitHydrated(page);
    await expect(page.getByTestId(/^membership-/).first()).toBeVisible({ timeout: 30_000 });

    const where = `membership editor @${viewport.width}`;
    const overflow = await overflowPx(page);
    const axe = await scan(page);
    const measured = await consentRows(page, rows);

    if (overflow > 0) problems.push(`${where}: horizontal overflow of ${overflow}px`);
    for (const finding of axe.violations) problems.push(`${where}: ${finding}`);
    // Exactly the two consent rows: a longer or shorter list would mean the
    // measurement silently stopped covering something.
    if (measured.length !== 2) {
      problems.push(`${where}: expected 2 consent rows, measured ${measured.length} (${JSON.stringify(measured)})`);
    }
    for (const row of measured) {
      if (row.width < 44 || row.height < 44) {
        problems.push(`${where}: ${row.name} row is ${row.width}×${row.height}, below the 44px touch target`);
      }
    }
    console.log(`[design] ${where}: overflow=${overflow}px axe=${axe.violations.length} rows=${JSON.stringify(measured)}`);

    // The ROW is the target, not just the glyph: clicking the label — whose box
    // is 44px tall and includes the hint line — must toggle the checkbox and
    // drive the same endpoint. Asserted once, at the first viewport, because the
    // binding does not change with width.
    if (viewport === MOBILE && measured.length > 0) {
      const dirRow = page.locator('label:has([data-testid^="dir-toggle-"])');
      const checkbox = page.getByTestId(/^dir-toggle-/);
      const before = await checkbox.isChecked();
      const patched = page.waitForResponse(
        (r) => r.url().includes('/api/me/memberships/') && r.request().method() === 'PATCH',
      );
      await dirRow.click();
      expect((await patched).status(), 'the row must drive the same PATCH the input did').toBe(200);
      await expect(checkbox).toBeChecked({ checked: !before });
      // Restore the fixture's own value so the page is left as it was found.
      const restored = page.waitForResponse(
        (r) => r.url().includes('/api/me/memberships/') && r.request().method() === 'PATCH',
      );
      await dirRow.click();
      expect((await restored).status()).toBe(200);
      await expect(checkbox).toBeChecked({ checked: before });
    }
  }

  expect(problems, `cabinet design-gate findings:\n${problems.join('\n')}`).toEqual([]);
});
