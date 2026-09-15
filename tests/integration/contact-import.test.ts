import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { POST as requestOtp } from '../../src/app/api/auth/otp/request/route';
import { POST as verifyOtp } from '../../src/app/api/auth/otp/verify/route';
import { POST as saveProfileRoute } from '../../src/app/api/me/profile/route';
import { POST as importContactsRoute } from '../../src/app/api/me/contacts/import/route';
import { getSql, closeSql } from '../../src/lib/db';
import { emailLookupHash } from '../../src/lib/crypto';
import { accountIdFromCookie, loginViaOtp, makeRequest, uniqueEmail, assertStatus } from './helpers';

/**
 * POST /api/me/contacts/import (interop §A1): "who of my contacts is already
 * here" — answered from the peppered lookup key the product already holds, with
 * NOTHING from the address book persisted. The two tests that matter are the
 * table snapshot ("nothing is stored") and the audit row ("only the fact, with
 * numbers, no content").
 */

after(async () => {
  await closeSql();
});

interface Account {
  email: string;
  cookie: string;
  accountId: string;
  slug: string;
  displayName: string;
}

/** A real account through the real OTP flow, with a profile (matches need one). */
async function newAccount(prefix: string): Promise<Account> {
  const email = uniqueEmail(prefix);
  const cookie = await loginViaOtp(requestOtp, verifyOtp, email);
  const displayName = `Import ${prefix}`;
  const saved = await saveProfileRoute(makeRequest('/api/me/profile', { body: { display_name: displayName }, cookie }));
  assertStatus(saved, 200);
  const payload = (await saved.json()) as { profile: { public_slug: string } };
  return {
    email,
    cookie,
    accountId: await accountIdFromCookie(cookie),
    slug: payload.profile.public_slug,
    displayName,
  };
}

function vcard(entries: { email: string; name?: string }[]): string {
  return entries
    .map((entry) =>
      ['BEGIN:VCARD', 'VERSION:3.0', `FN:${entry.name ?? 'Contact'}`, `EMAIL:${entry.email}`, 'END:VCARD'].join('\r\n'),
    )
    .join('\r\n');
}

async function importVcf(cookie: string | null, content: string, filename = 'contacts.vcf') {
  return importContactsRoute(
    makeRequest('/api/me/contacts/import', {
      method: 'POST',
      body: { content, filename },
      ...(cookie ? { cookie } : {}),
    }),
  );
}

interface ImportPayload {
  ok: boolean;
  scanned: number;
  matched_count: number;
  matched: { display_name: string; slug: string; headline: string | null }[];
  unmatched_count: number;
  matched_truncated: boolean;
  skipped: number;
}

/** Row counts of every base table — the "did anything get stored" snapshot. */
async function tableCounts(): Promise<Record<string, number>> {
  const sql = getSql();
  const tables = await sql<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `;
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const rows = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM ${sql(table.table_name)}`;
    counts[table.table_name] = rows[0]?.count ?? 0;
  }
  return counts;
}

function diffCounts(before: Record<string, number>, afterCounts: Record<string, number>): Record<string, number> {
  const diff: Record<string, number> = {};
  for (const [table, count] of Object.entries(afterCounts)) {
    const delta = count - (before[table] ?? 0);
    if (delta !== 0) diff[table] = delta;
  }
  return diff;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

test('contacts import: an address already on WELCOME comes back as a name and a card link', async () => {
  const neighbour = await newAccount('neighbour');
  const importer = await newAccount('importer');

  const res = await importVcf(importer.cookie, vcard([
    { email: neighbour.email.toUpperCase(), name: 'Neighbour' },
    { email: 'nobody-here@example.com', name: 'Nobody' },
  ]));
  assertStatus(res, 200);
  // Read the raw body BEFORE parsing: the response is a list of people, never a
  // list of addresses — no '@' anywhere in the payload.
  const text = await res.clone().text();
  const body = (await res.json()) as ImportPayload;
  assert.equal(body.ok, true);
  assert.equal(body.scanned, 2, 'both addresses were scanned');
  assert.equal(body.matched_count, 1);
  assert.equal(body.matched[0]?.slug, neighbour.slug);
  assert.equal(body.matched[0]?.display_name, neighbour.displayName);
  assert.equal(body.unmatched_count, 1);
  assert.equal(body.matched_truncated, false);
  assert.equal(text.includes('@'), false, 'no email address may appear anywhere in the response');
  for (const match of body.matched) {
    assert.deepEqual(Object.keys(match).sort(), ['display_name', 'headline', 'slug']);
  }
  // Authed payload: never cached by a shared cache.
  assert.equal(res.headers.get('cache-control'), 'no-store, private');
  assert.equal(res.headers.get('x-ratelimit-limit'), '5');
});

test('contacts import: a CSV address book matches the same way', async () => {
  const neighbour = await newAccount('neighbour-csv');
  const importer = await newAccount('importer-csv');

  const csv = ['Почта,Имя', `${neighbour.email},Сосед`, 'stranger@example.com,Незнакомец'].join('\n');
  const res = await importVcf(importer.cookie, csv, 'contacts.csv');
  assertStatus(res, 200);
  const body = (await res.json()) as ImportPayload;
  assert.equal(body.scanned, 2);
  assert.equal(body.matched_count, 1);
  assert.equal(body.matched[0]?.slug, neighbour.slug);
});

test('contacts import: the caller itself and inactive accounts are never matched', async () => {
  const inactive = await newAccount('inactive');
  const importer = await newAccount('importer-self');
  const sql = getSql();
  await sql`UPDATE accounts SET status = 'disabled' WHERE id = ${inactive.accountId}`;
  try {
    const res = await importVcf(importer.cookie, vcard([
      { email: importer.email, name: 'Me' },
      { email: inactive.email, name: 'Disabled' },
    ]));
    assertStatus(res, 200);
    const body = (await res.json()) as ImportPayload;
    assert.equal(body.scanned, 2);
    assert.equal(body.matched_count, 0, 'neither the caller nor a disabled account may be revealed');
    assert.equal(body.unmatched_count, 2);
  } finally {
    await sql`UPDATE accounts SET status = 'active' WHERE id = ${inactive.accountId}`;
  }
});

// ---------------------------------------------------------------------------
// Privacy: nothing is stored
// ---------------------------------------------------------------------------

test('contacts import: NOTHING is stored — only one audit fact row, with numbers', async () => {
  const neighbour = await newAccount('neighbour-store');
  const importer = await newAccount('importer-store');
  const sql = getSql();
  const unknown = 'never-heard-of@example.com';
  const unknownHash = emailLookupHash(unknown, process.env.HASH_PEPPER ?? '');

  const before = await tableCounts();
  const res = await importVcf(importer.cookie, vcard([
    { email: neighbour.email, name: 'Known' },
    { email: unknown, name: 'Unknown' },
  ]));
  assertStatus(res, 200);
  const afterCounts = await tableCounts();

  // The whole point: the only difference in the database is the audit fact.
  assert.deepEqual(diffCounts(before, afterCounts), { audit_events: 1 });

  // And the imported address left no lookup key anywhere.
  const keys = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM accounts WHERE email_lookup_hash = ${unknownHash}
  `;
  assert.equal(keys[0]?.count, 0, 'the imported address must not be stored as a lookup key');

  const events = await sql<{ action: string; metadata: Record<string, unknown> }[]>`
    SELECT action, metadata FROM audit_events
    WHERE actor_account_id = ${importer.accountId}
    ORDER BY created_at DESC
    LIMIT 1
  `;
  assert.equal(events[0]?.action, 'contacts.import.match');
  const metadata = events[0]?.metadata ?? {};
  assert.deepEqual(Object.keys(metadata).sort(), ['format', 'matched_count', 'scanned', 'skipped']);
  assert.equal(metadata.scanned, 2);
  assert.equal(metadata.matched_count, 1);
  assert.equal(JSON.stringify(metadata).includes('@'), false, 'the audit row may never hold an address');

  // The raw address book is nowhere: neither the matched nor the unknown address
  // exists as a lookup key beyond the neighbour's own pre-existing account.
  const stored = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM accounts
    WHERE email_lookup_hash IN (${emailLookupHash(neighbour.email, process.env.HASH_PEPPER ?? '')}, ${unknownHash})
  `;
  assert.equal(stored[0]?.count, 1, 'only the neighbour existed before the import');
});

// ---------------------------------------------------------------------------
// Auth, limits, degenerate input
// ---------------------------------------------------------------------------

test('contacts import: without a session → 401 and no audit row', async () => {
  const sql = getSql();
  const before = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM audit_events`;
  const res = await importVcf(null, vcard([{ email: 'someone@example.com' }]));
  assertStatus(res, 401);
  assert.equal(((await res.json()) as { code: string }).code, 'unauthorized');
  const afterRows = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM audit_events`;
  assert.equal(afterRows[0]?.count, before[0]?.count, 'an unauthenticated attempt must leave no trace');
});

test('contacts import: malformed bodies and address-less files are refused with 400', async () => {
  const importer = await newAccount('importer-invalid');

  const noBody = await importContactsRoute(
    makeRequest('/api/me/contacts/import', { method: 'POST', body: {}, cookie: importer.cookie }),
  );
  assertStatus(noBody, 400);
  assert.equal(((await noBody.json()) as { code: string }).code, 'invalid_body');

  const notAnObject = await importContactsRoute(
    makeRequest('/api/me/contacts/import', { method: 'POST', body: [1, 2], cookie: importer.cookie }),
  );
  assertStatus(notAnObject, 400);
  assert.equal(((await notAnObject.json()) as { code: string }).code, 'invalid_body');

  const noContacts = await importVcf(importer.cookie, 'BEGIN:VCARD\nFN:Nobody\nEND:VCARD');
  assertStatus(noContacts, 400);
  assert.equal(((await noContacts.json()) as { code: string }).code, 'no_contacts');

  const brokenCsv = await importVcf(importer.cookie, 'name,email\n"Anna,anna@example.com\n', 'contacts.csv');
  assertStatus(brokenCsv, 400);
  assert.equal(((await brokenCsv.json()) as { code: string }).code, 'csv_parse_error');
});

test('contacts import: over 5 MB → 413, over 5000 contacts → 413', async () => {
  const importer = await newAccount('importer-limits');

  const oversized = `${'x'.repeat(5 * 1024 * 1024 + 1)}`;
  const big = await importVcf(importer.cookie, oversized);
  assertStatus(big, 413);
  assert.equal(((await big.json()) as { code: string }).code, 'payload_too_large');

  const rows = ['email,name'];
  for (let i = 0; i <= 5000; i++) rows.push(`person${i}@example.com,Person ${i}`);
  const tooMany = await importVcf(importer.cookie, rows.join('\n'), 'contacts.csv');
  assertStatus(tooMany, 413);
  const body = (await tooMany.json()) as { code: string; message: string };
  assert.equal(body.code, 'payload_too_large');
  assert.match(body.message, /5000-contact limit/);
});

test('contacts import: the 6th request inside the hour is 429 with Retry-After', async () => {
  // A dedicated account: the budget is per account, and the earlier tests must
  // not eat it.
  const importer = await newAccount('importer-quota');
  const content = vcard([{ email: `quota-${Date.now()}@example.com` }]);

  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await importVcf(importer.cookie, content);
    assertStatus(res, 200);
    assert.equal(res.headers.get('x-ratelimit-remaining'), String(5 - attempt));
  }
  const sixth = await importVcf(importer.cookie, content);
  assertStatus(sixth, 429);
  const body = (await sixth.json()) as { code: string; retryable: boolean };
  assert.equal(body.code, 'rate_limited');
  assert.equal(body.retryable, true);
  assert.equal(sixth.headers.get('x-ratelimit-remaining'), '0');
  const retryAfter = Number(sixth.headers.get('retry-after') ?? '0');
  assert.ok(retryAfter > 0 && retryAfter <= 3600, `Retry-After must be inside the window, got ${retryAfter}`);

  // Another account is unaffected by that account's exhaustion.
  const other = await newAccount('importer-quota-other');
  const fresh = await importVcf(other.cookie, content);
  assertStatus(fresh, 200);
});
