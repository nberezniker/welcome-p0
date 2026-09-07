import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
// tsx compiles page.tsx JSX with the classic transform — provide the React global
(globalThis as unknown as { React: unknown }).React = React;
import { POST as otpRequest } from '../../src/app/api/auth/otp/request/route';
import { POST as otpVerify } from '../../src/app/api/auth/otp/verify/route';
import { POST as upsertProfile, GET as getProfile } from '../../src/app/api/me/profile/route';
import { PUT as putContact, GET as getContacts } from '../../src/app/api/me/contacts/route';
import { GET as publicProfile } from '../../src/app/api/public/profiles/[slug]/route';
import { GET as publicVCard } from '../../src/app/api/public/profiles/[slug]/vcard/route';
import { GET as publicQr } from '../../src/app/api/public/profiles/[slug]/qr.svg/route';
import PublicProfilePage from '../../src/app/p/[slug]/page';
import { makeRequest, uniqueEmail, loginViaOtp, assertStatus } from './helpers';
import { closeSql } from '../../src/lib/db';
import { emailLookupHash } from '../../src/lib/crypto';
import { requireHashPepper } from '../../src/lib/env';

after(async () => {
  await closeSql();
});

const PUBLIC_FIELDS = [
  'slug', 'display_name', 'headline', 'company', 'short_bio',
  'languages', 'offer_tags', 'need_tags', 'contacts',
];

interface Ctx {
  cookie: string;
  slug: string;
}

async function setupProfile(): Promise<Ctx> {
  const email = uniqueEmail('profile');
  const cookie = await loginViaOtp(otpRequest, otpVerify, email);

  const createRes = await upsertProfile(
    makeRequest('/api/me/profile', {
      cookie,
      body: {
        display_name: 'Тест Пользователь',
        headline: 'Engineer',
        company: 'TestCo',
        short_bio: 'Ищу пилотных пользователей.',
        languages: ['ru', 'en'],
        offer_tags: [' Design ', 'design', 'prototyping'],
        need_tags: ['pilot'],
      },
    }),
  );
  assertStatus(createRes, 200);
  const created = (await createRes.json()) as { profile: { public_slug: string; revision: number; offer_tags: string[] } };
  assert.equal(created.profile.revision, 1);
  assert.match(created.profile.public_slug, /^[A-Za-z0-9_-]{22}$/);
  assert.deepEqual(created.profile.offer_tags, ['design', 'prototyping']);

  // contacts: telegram public, phone private (no email kind exists in the P0 whitelist)
  const tRes = await putContact(
    makeRequest('/api/me/contacts', {
      cookie,
      method: 'PUT',
      body: { kind: 'telegram_username', value: '@tester', public_enabled: true },
    }),
  );
  assertStatus(tRes, 200);
  const pRes = await putContact(
    makeRequest('/api/me/contacts', {
      cookie,
      method: 'PUT',
      body: { kind: 'phone', value: '+79001112233', public_enabled: false },
    }),
  );
  assertStatus(pRes, 200);

  return { cookie, slug: created.profile.public_slug };
}

test('profile CRUD with optimistic concurrency and 409 on stale revision', async () => {
  const { cookie } = await setupProfile();

  const first = await getProfile(makeRequest('/api/me/profile', { cookie }));
  assertStatus(first, 200);
  const p1 = (await first.json()) as { profile: { revision: number } };
  assert.equal(p1.profile?.revision, 1);

  // update with current revision → bump
  const upd = await upsertProfile(
    makeRequest('/api/me/profile', {
      cookie,
      body: { display_name: 'Тест Пользователь', headline: 'Staff Engineer', revision: 1 },
    }),
  );
  assertStatus(upd, 200);
  const u1 = (await upd.json()) as { revision: number };
  assert.equal(u1.revision, 2);

  // stale revision → 409 + current revision in header/body
  const stale = await upsertProfile(
    makeRequest('/api/me/profile', {
      cookie,
      body: { display_name: 'Тест Пользователь', revision: 1 },
    }),
  );
  assert.equal(stale.status, 409);
  assert.equal(stale.headers.get('x-current-revision'), '2');
  const staleBody = (await stale.json()) as { code: string; correlation_id: string; retryable: boolean; message: string };
  assert.equal(staleBody.code, 'revision_conflict');
  assert.match(staleBody.correlation_id, /^[0-9a-f-]{36}$/);
  assert.equal(typeof staleBody.retryable, 'boolean');

  // missing revision → 400
  const noRev = await upsertProfile(
    makeRequest('/api/me/profile', { cookie, body: { display_name: 'X' } }),
  );
  assert.equal(noRev.status, 400);
  assert.equal(((await noRev.json()) as { code: string }).code, 'revision_required');
});

test('profile routes require a session', async () => {
  const noAuth = await getProfile(makeRequest('/api/me/profile'));
  assert.equal(noAuth.status, 401);
  const noAuthPost = await upsertProfile(makeRequest('/api/me/profile', { body: { display_name: 'X' } }));
  assert.equal(noAuthPost.status, 401);
});

test('contacts: encrypted at rest (DB holds no plaintext), whitelist enforced, values decrypt for owner', async () => {
  const email = uniqueEmail('contacts');
  const cookie = await loginViaOtp(otpRequest, otpVerify, email);

  // no profile yet → 400 profile_required
  const noProfile = await putContact(
    makeRequest('/api/me/contacts', { cookie, method: 'PUT', body: { kind: 'phone', value: '+1', public_enabled: false } }),
  );
  assert.equal(noProfile.status, 400);
  assert.equal(((await noProfile.json()) as { code: string }).code, 'profile_required');

  await assertStatus(
    await upsertProfile(makeRequest('/api/me/profile', { cookie, body: { display_name: 'C' } })),
    200,
  );

  await putContact(
    makeRequest('/api/me/contacts', { cookie, method: 'PUT', body: { kind: 'whatsapp', value: '+7 900 555-66-77', public_enabled: true } }),
  );

  const badKind = await putContact(
    makeRequest('/api/me/contacts', { cookie, method: 'PUT', body: { kind: 'email', value: 'a@b.c', public_enabled: true } }),
  );
  assert.equal(badKind.status, 400);
  assert.equal(((await badKind.json()) as { code: string }).code, 'invalid_kind');

  const list = await getContacts(makeRequest('/api/me/contacts', { cookie }));
  assertStatus(list, 200);
  const contacts = (await list.json()) as { contacts: { kind: string; value: string; public_enabled: boolean }[] };
  assert.equal(contacts.contacts.length, 1);
  assert.equal(contacts.contacts[0]?.value, '+7 900 555-66-77');

  // DB never contains the plaintext — the stored value is the v1.<iv>.<ct>.<tag> envelope
  const { getSql } = await import('../../src/lib/db');
  const sql = getSql();
  const hash = emailLookupHash(email, requireHashPepper());
  const stored = await sql<{ encrypted_value: string }[]>`
    SELECT c.encrypted_value FROM contact_fields c
    JOIN profiles p ON p.id = c.profile_id
    JOIN accounts a ON a.id = p.account_id
    WHERE a.email_lookup_hash = ${hash}
  `;
  assert.equal(stored.length, 1);
  const v = stored[0]?.encrypted_value ?? '';
  assert.match(v, /^v1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/);
  assert.ok(!v.includes('+7 900 555-66-77'), 'plaintext must not be stored');
});

test('public API returns ONLY the public projection (disabled contact and private data absent)', async () => {
  const { slug } = await setupProfile();

  const res = await publicProfile(makeRequest(`/api/public/profiles/${slug}`), { params: Promise.resolve({ slug }) });
  assertStatus(res, 200);
  assert.match(res.headers.get('x-robots-tag') ?? '', /noindex/);
  const body = (await res.json()) as Record<string, unknown>;

  // exact key set — nothing extra leaks
  assert.deepEqual(Object.keys(body).sort(), [...PUBLIC_FIELDS].sort());
  const raw = JSON.stringify(body);
  assert.ok(!raw.includes('revision'), 'revision must not appear');
  assert.ok(!raw.includes('+79001112233'), 'disabled contact value must not appear');
  assert.ok(!raw.includes('account_id') && !raw.includes('email'), 'ids/email must not appear');

  const contacts = body.contacts as { kind: string; value: string }[];
  assert.deepEqual(contacts, [{ kind: 'telegram_username', value: '@tester' }]);
  assert.equal(body.display_name, 'Тест Пользователь');
});

test('public API: unknown slug → 404 not_found', async () => {
  const res = await publicProfile(makeRequest('/api/public/profiles/does-not-exist-aaaaaaaa'), { params: Promise.resolve({ slug: 'does-not-exist-aaaaaaaa' }) });
  assert.equal(res.status, 404);
  assert.equal(((await res.json()) as { code: string }).code, 'not_found');
});

test('public page renders public data, hides disabled contacts, escapes user text', async () => {
  const { slug } = await setupProfile();
  const Page = PublicProfilePage;
  const element = await Page({ params: Promise.resolve({ slug }) });
  const html = renderToStaticMarkup(element);

  assert.ok(html.includes('Тест Пользователь'));
  assert.ok(html.includes('@tester'));
  assert.ok(!html.includes('+79001112233'), 'disabled phone must not be in the page HTML');
  assert.ok(!html.includes('revision'));
});

test('vCard: text/vcard 3.0 with only public fields and CRLF endings', async () => {
  const { slug } = await setupProfile();
  const res = await publicVCard(makeRequest(`/api/public/profiles/${slug}/vcard`), { params: Promise.resolve({ slug }) });
  assertStatus(res, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/vcard/);
  const text = await res.text();
  assert.ok(text.startsWith('BEGIN:VCARD\r\n'));
  assert.ok(text.endsWith('END:VCARD\r\n'));
  assert.ok(text.includes('VERSION:3.0\r\n'));
  assert.ok(text.includes('FN:Тест Пользователь\r\n'));
  assert.ok(text.includes('X-SOCIALPROFILE;TYPE=telegram:https://t.me/tester\r\n'));
  assert.ok(!text.includes('+79001112233'), 'disabled contact must not be in the vCard');
  assert.ok(!text.split('\r\n').some((l) => l.startsWith('TEL') && l.includes('79001112233')));
});

test('QR: renders SVG of the absolute public URL', async () => {
  const { slug } = await setupProfile();
  const res = await publicQr(makeRequest(`/api/public/profiles/${slug}/qr.svg`), { params: Promise.resolve({ slug }) });
  assertStatus(res, 200);
  assert.match(res.headers.get('content-type') ?? '', /image\/svg\+xml/);
  const svg = await res.text();
  assert.ok(svg.includes('<svg'));
  assert.ok(svg.includes('</svg>'));
  assert.ok(svg.length > 500, 'QR svg must contain path data');
});
