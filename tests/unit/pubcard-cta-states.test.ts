import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { en, type Dictionary } from '../../src/i18n/en';
import { ru } from '../../src/i18n/ru';
import { es } from '../../src/i18n/es';

/**
 * THE CARD'S THREE CTA STATES, and the one of them that must never be a lie.
 *
 * WHY THIS TEST EXISTS. The card's action was a two-way branch — `sharedEvent ?
 * intro : sign-in` — so a visitor who was ALREADY SIGNED IN and shared no event
 * with the card's owner was told "Sign in to connect". Nothing failed: the string
 * existed, was translated, rendered, and every existing gate (axe, overflow, tap
 * targets, fold, screenshot) was green with a button whose label named a state the
 * visitor was not in and whose link could not change it. The failure mode is a
 * MISSING THIRD STATE, so the assertions below enumerate the three states and
 * demand each one's own copy — and, for the middle one, that it does not silently
 * fall back to the sign-in string that used to stand for it.
 *
 * WHAT IS PINNED, and why each part is needed:
 *   1. the three dictionary keys exist, non-empty, in en AND ru AND es — the
 *      parity test would catch a missing key, this one also catches an empty or
 *      untranslated stand-in that reads as a working fallback;
 *   2. the new state's copy is NOT the sign-in copy in any locale — that is the
 *      exact bug signature (a "state of its own" that says the same words as the
 *      state it replaced);
 *   3. page.tsx branches on `sharedEvent` AND on the session (`accountId`) and
 *      renders a DIFFERENT component for each — a source pin, because the branch
 *      is the thing that was missing, and a rendering test on one visitor cannot
 *      see the other two;
 *   4. the shared-event branch still renders IntroCta: "keep the existing path to
 *      it" is a requirement, so the pin is that the introduction affordance is
 *      what a shared event gets, unchanged.
 *
 * The BEHAVIOUR of the three states (what a real signed-in non-member sees, and
 * what changes when they join) is asserted against the running app in
 * tests/e2e/two-user-walkthrough.spec.ts, and the fold/44px/axe consequences in
 * tests/e2e/design-gate.spec.ts.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CARD_PAGE = path.join(ROOT, 'src', 'app', 'p', '[slug]', 'page.tsx');
const CARD_CTA = path.join(ROOT, 'src', 'app', 'p', '[slug]', 'intro-cta.tsx');

const DICTIONARIES: readonly { locale: string; dict: Partial<Dictionary> }[] = [
  { locale: 'en', dict: en },
  { locale: 'ru', dict: ru },
  { locale: 'es', dict: es },
];

const NEW_KEYS = ['pubcard.ctaNothingYet', 'pubcard.ctaNothingYetHint', 'pubcard.ctaMyEvents'] as const;

test('card CTA: the signed-in-no-shared-event state has its own copy in all three languages', () => {
  for (const key of NEW_KEYS) {
    for (const { locale, dict } of DICTIONARIES) {
      const value = dict[key];
      assert.ok(
        typeof value === 'string' && value.trim().length > 0,
        `${locale} has no non-empty ${key}: the state must say something true, and a missing key falls back to English instead of failing`,
      );
    }
  }

  // The bug signature: a third state that reads exactly like the second one it
  // replaced. "Sign in" is the thing this visitor cannot do and does not need.
  for (const { locale, dict } of DICTIONARIES) {
    assert.notEqual(
      dict['pubcard.ctaNothingYet'],
      dict['pubcard.ctaSignIn'],
      `${locale}: the no-shared-event state must not reuse the sign-in copy — that is the lie it exists to remove`,
    );
    assert.notEqual(
      dict['pubcard.ctaNothingYetHint'],
      dict['pubcard.ctaSignInHint'],
      `${locale}: the no-shared-event state needs its own hint, not the sign-in one`,
    );
  }

  // ...and the two locales are real translations, not English pasted in.
  assert.notEqual(ru['pubcard.ctaNothingYet'], en['pubcard.ctaNothingYet'], 'ru must not fall back to the English copy');
  assert.notEqual(es['pubcard.ctaNothingYet'], en['pubcard.ctaNothingYet'], 'es must not fall back to the English copy');
});

test('card CTA: the three states are three branches, and a shared event keeps the introduction', () => {
  const source = readFileSync(CARD_PAGE, 'utf8');

  // (3) The branch itself: the shared-event case first, then the signed-in case,
  // then the anonymous one. The middle branch is what did not exist.
  assert.ok(
    /\{sharedEvent \? \(\s*<IntroCta/.test(source),
    'page.tsx must render the introduction when the visitor shares an event with the card owner',
  );
  assert.ok(
    /\) : accountId \? \(\s*<NoConnectionCta/.test(source),
    'page.tsx must render a state of its own for a SIGNED-IN visitor with no shared event, not the sign-in CTA',
  );
  assert.ok(
    /\) : \(\s*<SignInCta/.test(source),
    'page.tsx must keep the sign-in CTA for the anonymous visitor — that is the one visitor it is true for',
  );

  // (4) The introduction is not merely still present: it is what the shared-event
  // branch renders, with the two ids that branch is allowed to pass.
  assert.ok(
    source.includes('profileId={sharedEvent.targetProfileId}'),
    'the shared-event branch must keep passing the ids it always passed (event id + target profile id)',
  );

  // The new state's way forward is the VISITOR'S OWN events — no event of the
  // card owner's is named anywhere in it (the privacy boundary of the card).
  assert.ok(
    source.includes('href="/me/events"'),
    'the no-shared-event state must point at the visitor’s own events: joining the same event is what makes an introduction possible',
  );
  assert.ok(
    source.includes("text={t('pubcard.ctaNothingYet')}") &&
      source.includes("label={t('pubcard.ctaMyEvents')}") &&
      source.includes("hint={t('pubcard.ctaNothingYetHint')}"),
    'the no-shared-event state must render its own three strings through the dictionary',
  );
});

test('card CTA: the no-shared-event component is labelled and testable, and names no event', () => {
  const source = readFileSync(CARD_CTA, 'utf8');

  assert.ok(
    source.includes('data-testid="pubcard-noconnection-cta"'),
    'the state needs its own testid: the e2e must be able to tell it apart from the sign-in CTA it replaced',
  );
  assert.ok(
    source.includes('export function NoConnectionCta'),
    'the state must be its own component — a branch that reuses SignInCta with different text is the same lie in a new string',
  );
  // No href that could name a third party's event or profile: the only link this
  // component may render is the one it is handed.
  assert.ok(
    !/https?:\/\//.test(source.slice(source.indexOf('export function NoConnectionCta'))),
    'the no-shared-event state must not build a URL of its own — it renders the href it is given',
  );
});
