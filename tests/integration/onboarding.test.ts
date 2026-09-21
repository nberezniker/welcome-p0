import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
// tsx compiles page.tsx JSX with the classic transform — provide the React global
(globalThis as unknown as { React: unknown }).React = React;
import { POST as requestOtp } from '../../src/app/api/auth/otp/request/route';
import { POST as verifyOtp } from '../../src/app/api/auth/otp/verify/route';
import { POST as createProfileRoute, GET as getProfileRoute } from '../../src/app/api/me/profile/route';
import { PUT as putContactRoute } from '../../src/app/api/me/contacts/route';
import { GET as publicProfile } from '../../src/app/api/public/profiles/[slug]/route';
import { GET as publicVCard } from '../../src/app/api/public/profiles/[slug]/vcard/route';
import PublicProfilePage, { generateMetadata } from '../../src/app/p/[slug]/page';
import { closeSql } from '../../src/lib/db';
import { loginViaOtp, makeRequest, uniqueEmail, assertStatus } from './helpers';

/**
 * Pass B integration path: what onboarding writes is what the public card shows.
 *
 * The privacy invariant is asserted from both ends — the API JSON and the rendered
 * HTML — because the card is a server component and the projection is shared.
 */

after(async () => {
  await closeSql();
});

interface Onboarded {
  cookie: string;
  slug: string;
}

/** Everything the onboarding wizard posts, in one profile write. */
async function onboard(prefix: string, overrides: Record<string, unknown> = {}): Promise<Onboarded> {
  const cookie = await loginViaOtp(requestOtp, verifyOtp, uniqueEmail(prefix));
  const res = await createProfileRoute(
    makeRequest('/api/me/profile', {
      cookie,
      body: {
        display_name: `Onboarded ${prefix}`,
        headline: 'Founder building networking tools',
        company: 'Acme Labs',
        short_bio: 'I build things',
        languages: ['en'],
        offer_tags: [],
        need_tags: [],
        need_intents: ['seeking-cofounder'],
        offer_intents: ['offering-services'],
        interests: ['ai-ml', 'startups'],
        keywords: ['foodtech'],
        job_function: 'founder-ceo',
        industry: 'ai-saas',
        hidden_fields: [],
        ...overrides,
      },
    }),
  );
  assertStatus(res, 200);
  const body = (await res.json()) as { profile: { public_slug: string } };
  return { cookie, slug: body.profile.public_slug };
}

test('onboarding path: the profile API accepts the whole wizard payload and reads it back', async () => {
  const { cookie, slug } = await onboard('full');
  const res = await getProfileRoute(makeRequest('/api/me/profile', { cookie }));
  assertStatus(res, 200);
  const profile = ((await res.json()) as { profile: Record<string, unknown> }).profile;
  assert.equal(profile['need_intents'] && (profile['need_intents'] as string[])[0], 'seeking-cofounder');
  assert.deepEqual(profile['offer_intents'], ['offering-services']);
  assert.deepEqual(profile['interests'], ['ai-ml', 'startups']);
  assert.deepEqual(profile['keywords'], ['foodtech']);
  assert.equal(profile['job_function'], 'founder-ceo');
  assert.equal(profile['industry'], 'ai-saas');
  assert.deepEqual(profile['hidden_fields'], []);
  assert.equal(profile['public_slug'], slug);
  assert.equal(profile['revision'], 1);
});

test('onboarding path: hidden_fields keeps a field off the card in JSON and in HTML', async () => {
  const { cookie, slug } = await onboard('hidden', {
    hidden_fields: ['short_bio', 'company', 'interests'],
  });

  const json = await publicProfile(makeRequest(`/api/public/profiles/${slug}`), {
    params: Promise.resolve({ slug }),
  });
  assertStatus(json, 200);
  const body = (await json.json()) as Record<string, unknown>;
  // The field KEYS stay (a stable projection shape) but the values are withheld.
  assert.equal(body['short_bio'], null);
  assert.equal(body['company'], null);
  assert.deepEqual(body['interests'], []);
  // Untouched fields are still published.
  assert.deepEqual(body['need_intents'], ['seeking-cofounder']);
  assert.deepEqual(body['keywords'], ['foodtech']);

  const element = await PublicProfilePage({ params: Promise.resolve({ slug }) });
  const html = renderToStaticMarkup(element);
  assert.ok(!html.includes('I build things'), 'hidden bio must not be rendered');
  assert.ok(!html.includes('Acme Labs'), 'hidden company must not be rendered');
  assert.ok(html.includes('Onboarded hidden'), 'the name is always published');

  const vcard = await publicVCard(makeRequest(`/api/public/profiles/${slug}/vcard`), {
    params: Promise.resolve({ slug }),
  });
  const vcardText = await vcard.text();
  assert.ok(!vcardText.includes('I build things'), 'hidden bio must not reach the vCard');
  assert.ok(!vcardText.includes('ORG:Acme Labs'), 'hidden company must not reach the vCard');

  // The owner still sees their own value in the editor.
  const mine = await getProfileRoute(makeRequest('/api/me/profile', { cookie }));
  const profile = ((await mine.json()) as { profile: { short_bio: string } }).profile;
  assert.equal(profile.short_bio, 'I build things');
});

test('onboarding path: an unknown hidden_fields id is rejected', async () => {
  const cookie = await loginViaOtp(requestOtp, verifyOtp, uniqueEmail('hidden-bad'));
  const res = await createProfileRoute(
    makeRequest('/api/me/profile', {
      cookie,
      body: { display_name: 'Bad hidden', hidden_fields: ['contacts', 'email'] },
    }),
  );
  assert.equal(res.status, 400);
  const body = (await res.json()) as { code: string; message: string };
  assert.equal(body.code, 'invalid_hidden_fields');
  assert.match(body.message, /hidden_fields must be a subset of/);
});

test('onboarding path: a GitHub link is a first-class public contact (migration 008)', async () => {
  const { cookie, slug } = await onboard('github');
  const put = await putContactRoute(
    makeRequest('/api/me/contacts', {
      method: 'PUT',
      cookie,
      body: { kind: 'github_url', value: 'https://github.com/onboarded', public_enabled: true },
    }),
  );
  assertStatus(put, 200);
  const privatePhone = await putContactRoute(
    makeRequest('/api/me/contacts', {
      method: 'PUT',
      cookie,
      body: { kind: 'phone', value: '+34600222222', public_enabled: false },
    }),
  );
  assertStatus(privatePhone, 200);

  const json = await publicProfile(makeRequest(`/api/public/profiles/${slug}`), {
    params: Promise.resolve({ slug }),
  });
  const body = (await json.json()) as { contacts: { kind: string; value: string }[] };
  assert.deepEqual(body.contacts, [{ kind: 'github_url', value: 'https://github.com/onboarded' }]);
  assert.ok(!JSON.stringify(body).includes('+34600222222'), 'a private contact never appears in JSON');

  const element = await PublicProfilePage({ params: Promise.resolve({ slug }) });
  const html = renderToStaticMarkup(element);
  assert.ok(html.includes('https://github.com/onboarded'));
  assert.ok(html.includes('rel="noopener noreferrer nofollow"'), 'outbound links carry the rel set');
  assert.ok(!html.includes('+34600222222'), 'a private contact never appears in HTML');
});

test('onboarding path: the card renders the axes as labels, not raw ids', async () => {
  const { slug } = await onboard('labels');
  const element = await PublicProfilePage({ params: Promise.resolve({ slug }) });
  const html = renderToStaticMarkup(element);
  // EN is the default locale in tests: the picker labels, not "seeking-cofounder".
  assert.ok(!html.includes('seeking-cofounder'), 'raw intent ids must not be rendered');
  assert.ok(!html.includes('ai-ml'), 'raw interest ids must not be rendered');
  // The headings keep their text and now also carry the ids that name the lists
  // below them (attribute order is not asserted here — the binding is).
  assert.match(html, /<h2[^>]*id="pubcard-offers-title"[^>]*>How I can help<\/h2>/);
  assert.match(html, /<h2[^>]*id="pubcard-needs-title"[^>]*>Looking for<\/h2>/);
  assert.match(html, /data-testid="pubcard-interests"/);
  assert.ok(html.includes('foodtech'), 'keywords are shown as expertise');
  // ...and each chip list is NAMED BY its own heading. In the `premium` theme the
  // offers and needs chips are the same colour by design, so this is the only
  // thing that tells a screen reader user which group a chip belongs to.
  // Asserted on rendered HTML, not merely in the source.
  for (const group of ['offers', 'needs', 'interests'] as const) {
    assert.ok(
      html.includes(`aria-labelledby="pubcard-${group}-title"`),
      `the ${group} chip list must be labelled by its heading — premium tells its groups apart by name, not by hue`,
    );
  }
});

test('onboarding path: the card carries shareable meta tags', async () => {
  const { slug } = await onboard('meta');
  const meta = await generateMetadata({ params: Promise.resolve({ slug }) });
  assert.equal(meta.title, 'Onboarded meta — WELCOME card');
  assert.equal(meta.description, 'Networking card: Founder building networking tools');
  assert.equal(meta.openGraph?.title, 'Onboarded meta — WELCOME card');
  assert.equal(meta.openGraph?.description, 'Networking card: Founder building networking tools');
  assert.deepEqual(meta.robots, { index: false, follow: false });

  const missing = await generateMetadata({ params: Promise.resolve({ slug: 'nope-nope-nope-nope-nope' }) });
  assert.deepEqual(missing.robots, { index: false, follow: false });
  assert.ok(!JSON.stringify(missing).includes('nope'), 'a missing card must not confirm the slug exists');
});

test('onboarding path: the profile API rejects an unknown intent for the wrong side', async () => {
  const cookie = await loginViaOtp(requestOtp, verifyOtp, uniqueEmail('wrong-side'));
  const res = await createProfileRoute(
    makeRequest('/api/me/profile', {
      cookie,
      body: { display_name: 'Wrong side', offer_intents: ['seeking-cofounder'] },
    }),
  );
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as { code: string }).code, 'invalid_offer_intents');
});
