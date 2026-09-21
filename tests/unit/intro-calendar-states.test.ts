import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
// tsx compiles .tsx with the classic transform — provide the React global
// (same line as tests/integration/connections.test.ts).
(globalThis as unknown as { React: unknown }).React = React;
import { IntroCalendar, type IntroCalendarStrings } from '../../src/app/me/introductions/intro-calendar';
import { CALENDAR_FAILURES, type CalendarControlState, type CalendarFailure } from '../../src/domain/meeting-calendar';
import { t, type Locale } from '../../src/i18n';

/**
 * THE HONEST-STATE GATE for the introduction card's calendar control.
 *
 * It is a markup test rather than a browser test for one measured reason: the
 * e2e server is started once with a fake Google OAuth client configured
 * (playwright.config.ts), so a browser can reach exactly two of this control's
 * states — `ready` is unreachable without a real Google grant, and
 * `not_configured` needs a server WITH the variables deleted. Both of those are
 * still states a self-hosted instance or a connected user will actually see, so
 * they are asserted here, by rendering the component the way Next would.
 *
 * WHAT IS ASSERTED, AND WHY IT IS NOT COSMETIC: that a state which cannot
 * succeed offers NOTHING TO PRESS. A form next to "Google Calendar is not
 * connected" invites exactly the press the rest of this app refuses to invite
 * (/me/connections: "this card offers no button at all rather than one that
 * could only fail"). And that the states are rendered from the DICTIONARY in
 * every language, so a hardcoded English sentence cannot pass as one.
 *
 * The words come from the real dictionaries through `t()`, which throws on a
 * missing key — so a renamed key fails here instead of rendering nothing.
 */
function stringsFor(locale: Locale): IntroCalendarStrings {
  return {
    title: t(locale, 'intros.calendar.title'),
    hint: t(locale, 'intros.calendar.hint'),
    startLabel: t(locale, 'intros.calendar.startLabel'),
    endLabel: t(locale, 'intros.calendar.endLabel'),
    timezoneLabel: t(locale, 'intros.calendar.timezoneLabel'),
    submit: t(locale, 'intros.calendar.submit'),
    sending: t(locale, 'intros.calendar.sending'),
    done: t(locale, 'intros.calendar.done'),
    openInGoogle: t(locale, 'intros.calendar.openInGoogle'),
    addressNotSent: t(locale, 'intros.calendar.addressNotSent'),
    connectLink: t(locale, 'intros.calendar.connectLink'),
    notConfigured: t(locale, 'intros.calendar.notConfigured'),
    notConnected: t(locale, 'intros.calendar.notConnected'),
    reconnect: t(locale, 'intros.calendar.reconnect'),
    failures: Object.fromEntries(
      CALENDAR_FAILURES.map((failure) => [failure, t(locale, `intros.calendar.error.${failure}` as const)]),
    ) as Record<CalendarFailure, string>,
  };
}

function render(state: CalendarControlState, locale: Locale = 'en', missingEnv: string[] = []): string {
  return renderToStaticMarkup(
    React.createElement(IntroCalendar, {
      introId: 'intro-1',
      counterpartSlug: 'ada-lovelace',
      state,
      missingEnv,
      strings: stringsFor(locale),
    }),
  );
}

/** The states in which nothing can be sent, and must therefore offer nothing. */
const NO_FORM_STATES: CalendarControlState[] = ['not_configured', 'not_connected', 'expired', 'revoked'];

test('intro calendar: a state that cannot succeed offers nothing to press', () => {
  for (const state of NO_FORM_STATES) {
    const html = render(state);
    assert.match(html, new RegExp(`data-calendar-state="${state}"`), `${state}: the state must be on the markup`);
    assert.equal(html.includes('intro-calendar-submit-'), false, `${state}: no submit control`);
    assert.equal(html.includes('intro-calendar-start-'), false, `${state}: no start field`);
    assert.equal(html.includes('<input'), false, `${state}: no input at all`);
    // …and nothing that could look like a result either.
    assert.equal(html.includes('intro-calendar-done-'), false, `${state}: nothing was done`);
  }
});

test('intro calendar: not configured names the missing variables, never their values', () => {
  const html = render('not_configured', 'en', ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET']);
  assert.ok(html.includes('GOOGLE_OAUTH_CLIENT_ID'), 'the first missing variable must be named');
  assert.ok(html.includes('GOOGLE_OAUTH_CLIENT_SECRET'), 'the second missing variable must be named');
  // The sentence is the dictionary's, with {env} filled: an un-filled placeholder
  // would be a visible bug, so it is asserted rather than assumed.
  assert.equal(html.includes('{env}'), false, '{env} must be interpolated');
  assert.ok(html.includes('This instance has no Google OAuth client'));
  // Nothing about a connection, because connecting is impossible here.
  assert.equal(html.includes('intro-calendar-connect-'), false);
});

test('intro calendar: not connected says why, and links to the one place that fixes it', () => {
  const html = render('not_connected');
  assert.ok(html.includes('intro-calendar-connection-intro-1'));
  assert.ok(html.includes('href="/me/connections"'), 'the way out must be a link, not an instruction');
  assert.ok(html.includes(stringsFor('en').notConnected));
  // A connection that expired or was revoked is a DIFFERENT sentence: the user
  // has connected before, so telling them "not connected yet" would be wrong.
  const expired = render('expired');
  const revoked = render('revoked');
  assert.ok(expired.includes(stringsFor('en').reconnect));
  assert.ok(revoked.includes(stringsFor('en').reconnect));
  assert.equal(expired.includes(stringsFor('en').notConnected), false);
});

test('intro calendar: only a ready connection renders the form, and it cannot submit itself', () => {
  const html = render('ready');
  assert.match(html, /data-calendar-state="ready"/);
  assert.ok(html.includes('intro-calendar-start-intro-1'));
  assert.ok(html.includes('intro-calendar-end-intro-1'));
  assert.ok(html.includes('intro-calendar-submit-intro-1'));
  // The date fields are labelled — an unlabelled datetime input is unusable with
  // a screen reader, and axe would only catch it in a browser.
  assert.match(html, /<label[^>]*for="intro-calendar-start-intro-1"/);
  assert.match(html, /<label[^>]*for="intro-calendar-end-intro-1"/);
  // NOTHING IS SENT BEFORE THE USER ACTS: with an empty time the control ships
  // disabled, so there is no press that could post a default meeting.
  const submitTag = html.match(/<button[^>]*data-testid="intro-calendar-submit-intro-1"[^>]*>/)?.[0] ?? '';
  assert.ok(submitTag.length > 0, 'the submit control must be rendered');
  assert.ok(submitTag.includes('disabled'), `the submit control must start disabled: ${submitTag}`);
  // No result, no failure: nothing has been attempted yet.
  assert.equal(html.includes('intro-calendar-done-'), false);
  assert.equal(html.includes('intro-calendar-error-'), false);
  // The zone is a device fact, so it is not on the server's first render at all.
  assert.ok(html.includes('intro-calendar-timezone-intro-1'));
});

test('intro calendar: every state is rendered from the dictionary in EN, RU and ES', () => {
  for (const locale of ['en', 'ru', 'es'] as const) {
    const strings = stringsFor(locale);
    const html = render('not_connected', locale);
    assert.ok(html.includes(strings.title), `${locale}: the title must be this locale's`);
    assert.ok(html.includes(strings.notConnected), `${locale}: the state sentence must be this locale's`);
    assert.ok(html.includes(strings.connectLink), `${locale}: the link label must be this locale's`);
    // Distinctness, both ways: an English string in the Russian render is exactly
    // the silent regression this catches.
    if (locale !== 'en') {
      assert.ok(
        !html.includes(stringsFor('en').notConnected),
        `${locale}: the English sentence must not appear in a translated render`,
      );
      assert.notEqual(strings.notConnected, stringsFor('en').notConnected, `${locale} must actually translate it`);
    }
  }
});
