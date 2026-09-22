import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { en, type Dictionary } from '../../src/i18n/en';
import { ru } from '../../src/i18n/ru';
import { es } from '../../src/i18n/es';

/**
 * THE CARD'S CTA STATES, and the ones of them that must never be a lie.
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
 * THE FOURTH STATE, SAME DEFECT SHAPE. Looking at YOUR OWN card offered the
 * introduction, and pressing it could only ever fail: `findSharedEvent`
 * (src/lib/public-profile.ts) resolves "do these two share an event" with a
 * self-join, so an owner who had joined an event of their own came back with a
 * "shared event" whose counterparty was the viewer, and `POST /api/introductions`
 * answered `400 self_intro` behind a generic toast. Observed live, on the owner's
 * card: `intro=1 noconnection=0 signin=0`, then `400 {"code":"self_intro"}`. So
 * the owner's own card gets a state that says it is theirs, and the assertions
 * below demand (a) that it exists with its own copy in three languages, (b) that
 * it is decided by OWNERSHIP and evaluated BEFORE the shared-event arm — because
 * the self-join is exactly what made the introduction win — and (c) that the two
 * states beside it are untouched.
 *
 * WHAT IS PINNED, and why each part is needed:
 *   1. the dictionary keys exist, non-empty, in en AND ru AND es — the parity
 *      test would catch a missing key, this one also catches an empty or
 *      untranslated stand-in that reads as a working fallback;
 *   2. each state's copy is NOT the copy of the state it abuts in any locale —
 *      that is the exact bug signature (a "state of its own" that says the same
 *      words as the state it replaced) — and the own-card copy is not English
 *      pasted into ru/es;
 *   3. page.tsx branches on OWNERSHIP, on `sharedEvent` AND on the session
 *      (`accountId`) and renders a DIFFERENT component for each, with the
 *      own-card arm FIRST — a source pin, because the branch ORDER is what the
 *      self-join broke, and a rendering test on one visitor cannot see the rest;
 *   4. the shared-event branch still renders IntroCta: "keep the existing path to
 *      it" is a requirement, so the pin is that the introduction affordance is
 *      what a shared event gets, unchanged;
 *   5. the own-card component carries no introduction affordance and builds no
 *      URL of its own: it is not allowed to be the introduction with a different
 *      label.
 *
 * The BEHAVIOUR of the states (which one a real signed-in viewer gets, the forced
 * `400 self_intro`, and what changes when they join) is asserted against the
 * running app in tests/e2e/card-own-state.spec.ts, the two-person journey in
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

/** The owner's own card: the state that exists because the viewer IS the subject. */
const OWN_KEYS = ['pubcard.ctaOwnCard', 'pubcard.ctaOwnCardHint', 'pubcard.ctaEditProfile'] as const;

/** The CTA label of each state, in the order the chain must consider them. */
const STATE_CTA_KEYS = [
  'pubcard.ctaOwnCard',
  'pubcard.ctaIntro',
  'pubcard.ctaNothingYet',
  'pubcard.ctaSignIn',
] as const;


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

test('card CTA: the owner’s own-card state has its own copy in all three languages', () => {
  for (const key of OWN_KEYS) {
    for (const { locale, dict } of DICTIONARIES) {
      const value = dict[key];
      assert.ok(
        typeof value === 'string' && value.trim().length > 0,
        `${locale} has no non-empty ${key}: the owner must be told something true about their own card`,
      );
    }
  }

  // The bug signature, twice over: an own-card state that reads like the
  // no-connection state (what it replaces on the owner's card) or like the
  // introduction (the affordance that could only fail there).
  for (const { locale, dict } of DICTIONARIES) {
    assert.notEqual(
      dict['pubcard.ctaOwnCard'],
      dict['pubcard.ctaNothingYet'],
      `${locale}: "this is your card" must not reuse the stranger's-card copy`,
    );
    assert.notEqual(
      dict['pubcard.ctaOwnCard'],
      dict['pubcard.ctaIntro'],
      `${locale}: the owner's card must not be labelled as an introduction`,
    );
    assert.notEqual(
      dict['pubcard.ctaOwnCardHint'],
      dict['pubcard.ctaNothingYetHint'],
      `${locale}: the own-card hint must name the editor, not a future event`,
    );
  }

  // The four labels are four distinct strings in every locale — a locale that
  // collapsed two of them would render a state that cannot be told apart.
  for (const { locale, dict } of DICTIONARIES) {
    const labels = STATE_CTA_KEYS.map((key) => dict[key]);
    assert.equal(
      new Set(labels).size,
      labels.length,
      `${locale}: the four card states must have four distinct labels, got ${JSON.stringify(labels)}`,
    );
  }

  // ...and the two locales are real translations, not English pasted in.
  assert.notEqual(ru['pubcard.ctaOwnCard'], en['pubcard.ctaOwnCard'], 'ru must not fall back to the English copy');
  assert.notEqual(es['pubcard.ctaOwnCard'], en['pubcard.ctaOwnCard'], 'es must not fall back to the English copy');
  assert.notEqual(ru['pubcard.ctaOwnCardHint'], en['pubcard.ctaOwnCardHint'], 'ru hint must be translated');
  assert.notEqual(es['pubcard.ctaOwnCardHint'], en['pubcard.ctaOwnCardHint'], 'es hint must be translated');
});

test('card CTA: the states are one chain, and the own card is decided first', () => {
  const source = readFileSync(CARD_PAGE, 'utf8');

  // (3) The branch itself, in the ORDER that fixes the defect: ownership first
  // (the self-join would otherwise make the shared-event arm win), then the
  // shared-event case, then the signed-in case, then the anonymous one.
  assert.ok(
    /\{ownCard \? \(\s*<OwnCardCta/.test(source),
    'page.tsx must render the own-card state FIRST: `findSharedEvent` self-joins, so a shared event is exactly what an owner sees on their own card',
  );
  assert.ok(
    /\) : sharedEvent \? \(\s*<IntroCta/.test(source),
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

  // Ownership is a fact about the VIEWER's account and the card's slug, resolved
  // by the one helper that asks it — not a flag on the public projection, which
  // is served to anonymous visitors and crawlers.
  assert.ok(
    source.includes('viewerOwnsCard(profile.slug, accountId)'),
    'the own-card branch must be decided by viewerOwnsCard(slug, accountId)',
  );

  // (4) The introduction is not merely still present: it is what the shared-event
  // branch renders, with the two ids that branch is allowed to pass.
  assert.ok(
    source.includes('profileId={sharedEvent.targetProfileId}'),
    'the shared-event branch must keep passing the ids it always passed (event id + target profile id)',
  );

  // The other states' way forward is unchanged: the visitor's OWN events, and no
  // event of the card owner's is named anywhere in it (the privacy boundary).
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

  // (5) And the own-card state's three strings come from the dictionary too, with
  // the editor as the link — the useful thing on your own card.
  assert.ok(
    source.includes("href=\"/me/profile\"") &&
      source.includes("text={t('pubcard.ctaOwnCard')}") &&
      source.includes("label={t('pubcard.ctaEditProfile')}") &&
      source.includes("hint={t('pubcard.ctaOwnCardHint')}"),
    'the own-card state must offer the profile editor and render its own three dictionary strings',
  );
});

test('card CTA: the own-card component is labelled, testable and offers no introduction', () => {
  const source = readFileSync(CARD_CTA, 'utf8');
  // Bounded by the NEXT doc comment, so the slice is this component alone — the
  // components after it discuss introductions in their own comments.
  const ownCardStart = source.indexOf('export function OwnCardCta');
  const ownCardEnd = source.indexOf('/**', ownCardStart + 1);
  const ownCardSource = source.slice(ownCardStart, ownCardEnd === -1 ? undefined : ownCardEnd);
  assert.ok(ownCardStart > 0, 'OwnCardCta must be exported from intro-cta.tsx');

  assert.ok(
    source.includes('export function OwnCardCta'),
    'the own-card state must be its own component — a branch that reuses IntroCta with different text is the affordance that could only fail, in a new string',
  );
  assert.ok(
    source.includes('data-testid="pubcard-owncard-cta"'),
    'the state needs its own testid: the e2e must be able to tell it apart from the three states it borders',
  );
  assert.ok(
    ownCardSource.includes('data-testid="pubcard-edit-profile"'),
    'the editor link needs its own testid — it is the one control this state owns, and the gate measures it',
  );
  // No introduction affordance and no endpoint of its own: the owner's card must
  // not be able to reach the self-intro the server refuses. Asserted on the
  // RENDERED JSX (the block comment above it explains that history and is not the
  // component's behaviour), so a future edit that reintroduces the affordance
  // fails here even if it arrives with a fresh comment.
  const ownCardJsx = ownCardSource.slice(ownCardSource.indexOf('return ('));
  assert.ok(
    !ownCardJsx.includes('intro') && !ownCardJsx.includes('/api/'),
    'the own-card state must not carry the introduction affordance or call any endpoint',
  );
  // No href that could name a third party's event or profile: the only link this
  // component may render is the one it is handed.
  assert.ok(
    !/https?:\/\//.test(ownCardJsx),
    'the own-card state must not build a URL of its own — it renders the href it is given',
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
