import { test, expect, type Page } from '@playwright/test';
import { en } from '../../src/i18n/en';

/**
 * THE CRASH SURFACE'S FOCUS RING — both halves, in the real browser.
 *
 * The failure this pins is not "the ring looked wrong", it is that the ring was
 * decided by the BROWSER'S `:focus-visible` heuristic instead of by the product:
 * `src/components/error-surface.tsx` moves focus onto its `<h1 tabindex="-1">` so
 * a screen reader announces the failure, and asked for no ring on it (the element
 * is not Tab-reachable, so there is no indicator to keep). The `outline-none`
 * utility could not express that — Tailwind's utilities live in `@layer
 * utilities` and the global `:focus-visible` rule in globals.css is UNLAYERED, so
 * the unlayered rule won and the ring appeared only when the reader's last input
 * had been a key press. Measured before the fix: 3/3 keyboard runs showed
 * `outline: solid 3px`, 0/3 pointer runs did. That is what "intermittent" looked
 * like, and it is why this test drives BOTH modalities rather than one.
 *
 * THE SECOND HALF IS THE ONE THAT COULD REGRESS SILENTLY. A fix that removed
 * focus rings more broadly would also pass the first assertion — and would be
 * worse than the bug. So the SAME crashed document is asked about the surface's
 * own two controls (retry and "back to home"): real, Tab-reachable controls that
 * must still show the global ring. Asserting them in the same page state is the
 * point — the test cannot pass by checking two different documents — and it is
 * also the tightest possible version of the question, because the rule under test
 * is one CSS rule away from the heading it must not affect. (Nothing in the root
 * layout survives a segment failure except the surface itself, so the layout's
 * chrome is not available to ask: src/app/layout.tsx renders only the children.
 * The surface is what there is, and both of its controls are real ones.)
 *
 * THE TRIGGER IS THE REAL ONE. The crash surface has no URL; it appears when a
 * segment fails to load or render, so the test makes the segment's code
 * unavailable (aborting `_next/static/chunks/**`) after hydration and then
 * navigates CLIENT-SIDE — the user's click that React cannot answer. Navigation
 * via the keyboard uses Enter on a focused link, because a mouse click would
 * reset the modality and hide exactly the difference under test.
 */

const FOLD = { width: 390, height: 844 };
const ERROR_TITLE = en['errors.500.title'];

async function waitHydrated(page: Page) {
  await expect(page.locator('html[data-hydrated="true"]')).toBeAttached({ timeout: 30_000 });
}

/** Computed outline style of an element — 'none' means no ring is painted. */
async function outlineStyle(locator: ReturnType<Page['locator']>): Promise<string> {
  return locator.evaluate((el) => getComputedStyle(el as HTMLElement).outlineStyle);
}

for (const modality of ['keyboard', 'pointer'] as const) {
  test(`crash surface: a ${modality} reader gets the failure with no stray ring, and the chrome keeps its own`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize(FOLD);
    await page.goto('/');
    await waitHydrated(page);

    // Only from here on: the document under test must hydrate first, so what
    // fails is the segment's own code and not the shell.
    await page.route('**/_next/static/chunks/**', (route) => route.abort());
    const link = page.locator('a[href="/login"]').first();
    if (modality === 'keyboard') {
      await link.focus();
      await page.keyboard.press('Enter');
    } else {
      await link.click({ noWaitAfter: true, timeout: 5_000 });
    }

    const heading = page.getByRole('heading', { level: 1, name: ERROR_TITLE });
    await expect(heading, 'the crash surface must replace the page it could not render').toBeVisible({
      timeout: 30_000,
    });

    // The surface is the segment boundary's, in the shipped design, in the
    // reader's document: no `data-theme` anywhere (the single-design invariant).
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBeNull();

    // Half one: focus was taken, deliberately and visibly to assistive tech...
    await expect(heading, 'the heading must take focus so the failure is announced').toBeFocused();
    expect(await heading.getAttribute('tabindex'), 'the heading is programmatic-only').toBe('-1');
    // ...and no ring is painted, in EITHER modality. Before the fix the keyboard
    // branch reported 'solid' here while the pointer branch reported 'none'.
    expect(
      await outlineStyle(heading),
      `the focused heading must carry no focus ring after a ${modality} interaction`,
    ).toBe('none');

    // Half two: the surface's OWN two controls are real, Tab-reachable controls
    // and must keep the ring — so "no ring here" cannot be the product quietly
    // dropping focus indicators everywhere.
    //
    // REACHED BY TAB, not by `.focus()`, and that is the honest comparison rather
    // than a convenience. `:focus-visible` is SUPPOSED to be modality-sensitive
    // for controls: a real control focused programmatically right after a mouse
    // click correctly shows no ring (that is the rule working, and asserting
    // 'solid' there would be asserting a bug). What must be true for both kinds of
    // reader is that a KEYBOARD reader of the crash page gets rings on the
    // controls — so the walk is done with the keyboard in both cases, which also
    // mirrors what the modality is actually about. The heading, one line above, is
    // asserted to have no ring in EITHER modality: it is not a control, and that is
    // the half that used to flip with the reader's last input.
    const reached: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      await page.keyboard.press('Tab');
      const focused = page.locator(':focus');
      const tag = await focused.evaluate((el) => el.tagName);
      reached.push(tag);
      expect(
        await outlineStyle(focused),
        `control #${index + 1} reached by Tab ("${tag}") must show the global focus ring`,
      ).toBe('solid');
    }
    expect(reached, 'the crash surface offers exactly its retry button and its way home').toEqual(['BUTTON', 'A']);

    console.log(`[error-surface] ${modality}: heading outline=none, controls reached by Tab ${reached.join('+')} outline=solid`);
  });
}
