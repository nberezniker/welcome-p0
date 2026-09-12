import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { getSql, closeSql } from '../../src/lib/db';
import { POST as requestOtp } from '../../src/app/api/auth/otp/request/route';
import { POST as verifyOtp } from '../../src/app/api/auth/otp/verify/route';
import { POST as upsertProfile } from '../../src/app/api/me/profile/route';
import { PUT as putContact } from '../../src/app/api/me/contacts/route';
import { POST as enrichRoute } from '../../src/app/api/me/enrich/route';
import { selectEnrichmentProvider } from '../../src/integrations/enrichment';
import { loginViaOtp, makeRequest, uniqueEmail, assertStatus, accountIdFromCookie } from './helpers';

after(async () => {
  await closeSql();
});

const LEDGER = 'enrichment_requests';

interface User {
  cookie: string;
  accountId: string;
  profileId: string;
}

async function loginWithProfile(prefix: string, body: Record<string, unknown> = {}): Promise<User> {
  const email = uniqueEmail(prefix);
  const cookie = await loginViaOtp(requestOtp, verifyOtp, email);
  const accountId = await accountIdFromCookie(cookie);
  const res = await upsertProfile(
    makeRequest('/api/me/profile', {
      cookie,
      body: {
        display_name: `Enrich ${prefix}`,
        company: 'Acme Labs',
        industry: 'ai-saas',
        languages: ['en'],
        ...body,
      },
    }),
  );
  assertStatus(res, 200);
  const sql = getSql();
  const rows = await sql<{ id: string }[]>`SELECT id FROM profiles WHERE account_id = ${accountId}`;
  return { cookie, accountId, profileId: rows[0]!.id };
}

function enrich(user: User | null): Promise<Response> {
  return enrichRoute(makeRequest('/api/me/enrich', { method: 'POST', body: {}, cookie: user?.cookie }));
}

/** Snapshot of everything the endpoint must not touch. */
async function snapshot(user: User): Promise<string> {
  const sql = getSql();
  const profiles = await sql`SELECT * FROM profiles WHERE id = ${user.profileId}`;
  const contacts = await sql`
    SELECT kind, encrypted_value, public_enabled FROM contact_fields WHERE profile_id = ${user.profileId} ORDER BY kind
  `;
  return JSON.stringify({ profiles, contacts });
}

async function ledgerCount(accountId: string): Promise<number> {
  const sql = getSql();
  const rows = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM ${sql(LEDGER)} WHERE account_id = ${accountId}
  `;
  return rows[0]?.count ?? 0;
}

// ---------------------------------------------------------------------------
// Mock provider (the CI path)
// ---------------------------------------------------------------------------

test('enrich: mock provider returns a draft with sources and persists NO user content', async () => {
  const user = await loginWithProfile('mock');
  await putContact(
    makeRequest('/api/me/contacts', {
      cookie: user.cookie,
      method: 'PUT',
      body: { kind: 'website', value: 'acme.example', public_enabled: true },
    }),
  );
  await putContact(
    makeRequest('/api/me/contacts', {
      cookie: user.cookie,
      method: 'PUT',
      body: { kind: 'phone', value: '+79001112233', public_enabled: false },
    }),
  );

  const before = await snapshot(user);
  const res = await enrich(user);
  assertStatus(res, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store, private');

  const body = (await res.json()) as {
    ok: boolean;
    provider: string;
    draft: {
      headline: string | null;
      short_bio: string | null;
      company: string | null;
      links: string[];
      suggested_interests: string[];
      suggested_intents: string[];
    };
    sources: { title: string; uri: string }[];
  };
  assert.equal(body.ok, true);
  assert.equal(body.provider, 'enrichment_mock');
  assert.ok(body.draft.headline);
  assert.equal(body.draft.company, 'Acme Labs');
  // Only the user's OWN http(s) links were handed over (phone never becomes a link).
  assert.deepEqual(body.draft.links, ['https://acme.example']);
  assert.deepEqual(body.draft.suggested_interests, ['ai-ml', 'startups']);
  assert.deepEqual(body.draft.suggested_intents, ['seeking-cofounder', 'open-to-cofound']);
  assert.ok(body.sources.length >= 1);
  assert.ok(body.sources.every((s) => /^https:\/\//.test(s.uri)));
  // The draft echoes own data only — nothing about third parties.
  assert.ok(body.draft.short_bio!.includes('Acme Labs'));

  // NOTHING was written except the rate-limit ledger row.
  assert.equal(await snapshot(user), before, 'profile + contacts must be byte-identical after enrich');
  assert.equal(await ledgerCount(user.accountId), 1);
});

test('enrich: an undecryptable contact is skipped, the request still succeeds', async () => {
  const user = await loginWithProfile('undecryptable');
  await putContact(
    makeRequest('/api/me/contacts', {
      cookie: user.cookie,
      method: 'PUT',
      body: { kind: 'website', value: 'good.example', public_enabled: true },
    }),
  );
  // Simulates a value written under a different key (key rotation / restored
  // backup): the row exists but cannot be decrypted with the current ENCRYPTION_KEY.
  const sql = getSql();
  await sql`
    INSERT INTO contact_fields (profile_id, kind, encrypted_value, public_enabled)
    VALUES (${user.profileId}, 'linkedin_url', 'v1.bm90LWEta2V5.butA.va1id', true)
  `;

  const before = await snapshot(user);
  const res = await enrich(user);
  assertStatus(res, 200);
  const body = (await res.json()) as { draft: { links: string[] } };
  // The readable own link is still handed over; the broken row is dropped silently.
  assert.deepEqual(body.draft.links, ['https://good.example']);
  // Degrading never means writing: the corrupt row is left exactly as it was.
  assert.equal(await snapshot(user), before);
  assert.equal(await ledgerCount(user.accountId), 1);
});

test('enrich: requires auth and an existing profile', async () => {
  assertStatus(await enrich(null), 401);

  const email = uniqueEmail('enrich-noprofile');
  const cookie = await loginViaOtp(requestOtp, verifyOtp, email);
  const res = await enrich({ cookie, accountId: 'x', profileId: 'x' });
  assertStatus(res, 400);
  assert.equal(((await res.json()) as { code: string }).code, 'profile_required');
});

test('enrich: provider disabled → 503 enrichment_disabled, retryable:false, no quota spent', async () => {
  const user = await loginWithProfile('disabled');
  const saved = process.env.ENRICHMENT_PROVIDER;
  process.env.ENRICHMENT_PROVIDER = '';
  try {
    const res = await enrich(user);
    assertStatus(res, 503);
    const body = (await res.json()) as { code: string; retryable: boolean };
    assert.equal(body.code, 'enrichment_disabled');
    assert.equal(body.retryable, false);
    assert.equal(await ledgerCount(user.accountId), 0, 'a disabled provider must not spend the quota');
  } finally {
    process.env.ENRICHMENT_PROVIDER = saved;
  }
});

test('enrich: 6th request within the hour → 429 rate_limited (5/hour/account)', async () => {
  const user = await loginWithProfile('ratelimit');
  for (let i = 1; i <= 5; i++) {
    assertStatus(await enrich(user), 200);
  }
  assert.equal(await ledgerCount(user.accountId), 5);

  const sixth = await enrich(user);
  assertStatus(sixth, 429);
  const body = (await sixth.json()) as { code: string; retryable: boolean };
  assert.equal(body.code, 'rate_limited');
  assert.equal(body.retryable, true);
  assert.ok(Number(sixth.headers.get('retry-after')) > 0);
  assert.equal(sixth.headers.get('x-ratelimit-limit'), '5');
  // The rejected attempt must not have been recorded as a request.
  assert.equal(await ledgerCount(user.accountId), 5);
});

test('enrich: provider failure is reported as retryable enrichment_failed without leaking details', async () => {
  const user = await loginWithProfile('fail');
  const saved = process.env.ENRICHMENT_PROVIDER;
  process.env.ENRICHMENT_PROVIDER = 'vertex';
  delete process.env.GCP_PROJECT_ID;
  process.env.GCP_ACCESS_TOKEN = 'test-token';
  try {
    // vertex without a project id → disabled, not a crash
    assertStatus(await enrich(user), 503);
  } finally {
    process.env.ENRICHMENT_PROVIDER = saved;
    delete process.env.GCP_ACCESS_TOKEN;
  }
});

// ---------------------------------------------------------------------------
// LIVE check — never runs in CI; `ENRICHMENT_LIVE=1` + real credentials
// (GCP_PROJECT_ID / GCP_ACCESS_TOKEN from ADC, or GCP_SA_JSON) required.
// ---------------------------------------------------------------------------

test(
  'enrich LIVE: one real Vertex AI call through the configured credentials',
  { skip: process.env.ENRICHMENT_LIVE !== '1' },
  async () => {
    const provider = await selectEnrichmentProvider({
      ...process.env,
      ENRICHMENT_PROVIDER: 'vertex',
    });
    assert.equal(provider.enabled, true, 'vertex provider must be configured for the live check');
    const result = await provider.enrich({
      // Deliberately a public business identity rather than a private person's:
      // grounding sends the payload to a search engine, so the live check keeps
      // the disclosure to an already-public own brand.
      displayName: process.env.ENRICHMENT_LIVE_NAME ?? 'Colmobeat',
      company: process.env.ENRICHMENT_LIVE_COMPANY ?? 'Colmobeat',
      industry: process.env.ENRICHMENT_LIVE_INDUSTRY ?? 'media-content',
      links: process.env.ENRICHMENT_LIVE_LINKS ? process.env.ENRICHMENT_LIVE_LINKS.split(',') : [],
    });
    console.log('[enrich LIVE] result:', JSON.stringify(result, null, 2));
    assert.equal(result.state, 'ok', `live call must succeed, got ${JSON.stringify(result)}`);
    assert.ok(result.draft, 'live call must return a draft');
    assert.equal(result.provider, 'vertex_gemini');
  },
);
