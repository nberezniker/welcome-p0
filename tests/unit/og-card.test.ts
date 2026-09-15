import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import {
  OG_IMAGE_SIZE,
  eventCardMarkup,
  hostFromBaseUrl,
  personCardMarkup,
  type OgPersonCard,
} from '../../src/lib/og-card';

/**
 * Preview-card builders (Gap 1). The image itself is rendered by `next/og`
 * (satori); what is asserted here is the markup that goes into it — including
 * the privacy promise, which is enforced in two places and tested in both:
 * the narrow input type (`@ts-expect-error`, i.e. `pnpm typecheck`) and the fact
 * that the builders only ever read the fields they name (the runtime assertions
 * below, fed an object carrying private values).
 */

/** The markup an image route hands to next/og, as text. */
function html(element: ReactElement): string {
  return renderToStaticMarkup(element);
}

const HOST = 'welcome.colmogravity.net';

test('person card: renders the public fields and the site host', () => {
  const out = html(
    personCardMarkup({
      displayName: 'Olga Landing',
      headline: 'Founder of Solbeam',
      company: 'Solbeam Labs',
      host: HOST,
    }),
  );
  assert.match(out, /Olga Landing/);
  assert.match(out, /Founder of Solbeam/);
  assert.match(out, /Solbeam Labs/);
  assert.match(out, /welcome\.colmogravity\.net/);
  assert.match(out, /WELCOME/);
});

test('person card: a card without headline or company still renders its name', () => {
  const out = html(personCardMarkup({ displayName: 'Olga Landing', headline: null, company: null }));
  assert.match(out, /Olga Landing/);
  // Nothing invented for the absent fields, and no empty footer either.
  assert.doesNotMatch(out, /Founder/);
  assert.doesNotMatch(out, /welcome\.colmogravity\.net/);
});

test('event card: renders title, schedule and place', () => {
  const out = html(
    eventCardMarkup({
      title: 'E2E Interop Meetup',
      when: '1 May 2031, 18:00 — 20:00',
      place: 'Madrid, Spain',
      host: HOST,
    }),
  );
  assert.match(out, /E2E Interop Meetup/);
  assert.match(out, /1 May 2031, 18:00 — 20:00/);
  assert.match(out, /Madrid, Spain/);
  assert.match(out, /welcome\.colmogravity\.net/);
});

test('event card: an undated event renders its title alone', () => {
  const out = html(eventCardMarkup({ title: 'Undated Meetup', when: null, place: null }));
  assert.match(out, /Undated Meetup/);
  assert.doesNotMatch(out, /18:00/);
});

test('cards: long values are elided, so the footer cannot be pushed off', () => {
  const long = 'O'.repeat(120);
  const out = html(personCardMarkup({ displayName: long, host: HOST }));
  assert.doesNotMatch(out, new RegExp(long));
  assert.match(out, /O{20}/);
  assert.match(out, /…/);
  // The footer survives.
  assert.match(out, /welcome\.colmogravity\.net/);
});

test('cards: user text is escaped, never markup', () => {
  const out = html(personCardMarkup({ displayName: '<b>Olga</b>', host: HOST }));
  assert.match(out, /&lt;b&gt;Olga&lt;\/b&gt;/);
  assert.doesNotMatch(out, /<b>Olga<\/b>/);
});

test('cards: the canvas is the 1200×630 share-image convention', () => {
  assert.deepEqual({ ...OG_IMAGE_SIZE }, { width: 1200, height: 630 });
});

test('privacy: the narrow input type rejects a private field at compile time', () => {
  // Each call below is a compile error, asserted by `@ts-expect-error` — which
  // itself fails the build if the error ever stops happening (unused directive).
  // Goals, contact values, card opt-outs and event member state simply have no
  // slot in a public preview.
  void (
    // @ts-expect-error — a goal is not part of a public card
    personCardMarkup({ displayName: 'Olga', goal: 'Raise a Series A round' })
  );
  void (
    // @ts-expect-error — contact values never reach a public image
    personCardMarkup({ displayName: 'Olga', contacts: [{ kind: 'email', value: 'olga@example.org' }] })
  );
  void (
    // @ts-expect-error — the card's privacy opt-out list is not a card field
    personCardMarkup({ displayName: 'Olga', hidden_fields: ['short_bio'] })
  );
  void (
    // @ts-expect-error — no slot for the member-only online room link
    eventCardMarkup({ title: 'Mixer', online_link: 'https://meet.example/room-secret' })
  );
  void (
    // @ts-expect-error — free text that may quote the room link
    eventCardMarkup({ title: 'Mixer', description: 'Join at https://meet.example/room-secret' })
  );
  void (
    // @ts-expect-error — attendance is member state, never public preview data
    eventCardMarkup({ title: 'Mixer', attendance_source: 'self' })
  );
});

test('privacy: private values in a wider object never reach the markup', () => {
  // The runtime half: types are erased, so a caller CAN hand the builder an
  // object with extra keys. The builders read fields by name and never spread
  // the input, which is why this stays empty.
  const wide = {
    displayName: 'Olga Landing',
    headline: 'Founder of Solbeam',
    company: 'Solbeam Labs',
    host: HOST,
    goal: 'Raise a Series A round',
    short_bio: 'Private draft bio',
    email: 'olga@example.org',
    phone: '+34600999888',
    telegram_username: 'olga_private',
    hidden_fields: ['short_bio'],
    contacts: [{ kind: 'email', value: 'olga@example.org' }],
  } as unknown as OgPersonCard;

  const out = html(personCardMarkup(wide));
  assert.match(out, /Olga Landing/, 'the public field is still rendered');
  for (const secret of [
    'Series A',
    'Private draft bio',
    'olga@example.org',
    '+34600999888',
    'olga_private',
    'hidden_fields',
  ]) {
    assert.doesNotMatch(out, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${secret} leaked`);
  }
});

test('hostFromBaseUrl: derives the footer host from APP_BASE_URL', () => {
  assert.equal(hostFromBaseUrl('https://welcome.colmogravity.net'), 'welcome.colmogravity.net');
  assert.equal(hostFromBaseUrl('https://welcome.colmogravity.net/'), 'welcome.colmogravity.net');
  // A dev base URL keeps its host but not its port: a port is not part of a
  // site's identity.
  assert.equal(hostFromBaseUrl('http://127.0.0.1:3111'), '127.0.0.1');
  assert.equal(hostFromBaseUrl('http://localhost:3000'), 'localhost');
  // A malformed value drops the footer instead of failing the image route.
  assert.equal(hostFromBaseUrl(''), '');
  assert.equal(hostFromBaseUrl('welcome.colmogravity.net'), '');
});
