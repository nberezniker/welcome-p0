import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { POST as requestOtp } from '../../src/app/api/auth/otp/request/route';
import { POST as verifyOtp } from '../../src/app/api/auth/otp/verify/route';
import { POST as createProfileRoute } from '../../src/app/api/me/profile/route';
import { POST as createEventRoute } from '../../src/app/api/organizer/events/route';
import { POST as importsRoute } from '../../src/app/api/events/[eventIdOrSlug]/imports/route';
import { getSql, closeSql } from '../../src/lib/db';
import { loginViaOtp, makeRequest, uniqueEmail, assertStatus, accountIdFromCookie } from './helpers';

/**
 * Explicit column mapping (organizer picks which CSV column feeds which field)
 * and the preview counters that say how many rows would be inserted vs. updated.
 * Preview is read-only; commit is the only writer and reuses the same mapping.
 */

after(async () => {
  await closeSql();
});

async function login(prefix: string): Promise<string> {
  const email = uniqueEmail(prefix);
  const cookie = await loginViaOtp(requestOtp, verifyOtp, email);
  await accountIdFromCookie(cookie);
  const res = await createProfileRoute(
    makeRequest('/api/me/profile', { body: { display_name: `User ${prefix}` }, cookie }),
  );
  assertStatus(res, 200);
  return cookie;
}

async function createEvent(cookie: string): Promise<{ id: string; slug: string }> {
  const res = await createEventRoute(
    makeRequest('/api/organizer/events', {
      body: { name: 'Import Mapping Meetup', mode: 'offline', access_mode: 'public', timezone: 'UTC' },
      cookie,
    }),
  );
  assertStatus(res, 201);
  return ((await res.json()) as { event: { id: string; slug: string } }).event;
}

/** Headers auto-mapping cannot resolve — the mapping has to do the work. */
function nonCanonicalCsv(): string {
  return [
    'Полное имя,Рабочая почта,Компания,Роль,Табельный номер,Статус',
    'Alice Sample,alice.sample@example.org,Acme,Engineer,g-1,approved',
    'Bob Sample,bob.sample@example.org,Glob,Designer,g-2,unknown',
  ].join('\n');
}

const NON_CANONICAL_MAPPING = {
  'Полное имя': 'name',
  'Рабочая почта': 'email',
  'Компания': 'company',
  'Роль': 'role',
  'Табельный номер': 'external_id',
  'Статус': 'approval_status',
};

interface PreviewBody {
  mapping: Record<string, string | null>;
  columns: string[];
  would_insert: number;
  would_update: number;
  would_skip: number;
  quarantined_count: number;
  errors: string[];
  sample: Record<string, unknown>[];
  preview: { totalRows: number; quarantined: number; sample: unknown[] };
}

async function importCsv(
  cookie: string,
  eventId: string,
  csvText: string,
  mode: 'preview' | 'commit',
  mapping?: Record<string, string>,
): Promise<Response> {
  return importsRoute(
    makeRequest(`/api/events/${eventId}/imports`, {
      body: mapping ? { csv_text: csvText, mode, mapping } : { csv_text: csvText, mode },
      cookie,
    }),
    { params: Promise.resolve({ eventIdOrSlug: eventId }) },
  );
}

async function registrationCount(eventId: string): Promise<number> {
  const sql = getSql();
  const rows = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM registrations WHERE event_id = ${eventId}
  `;
  return rows[0]!.count;
}

async function importedNames(eventId: string): Promise<string[]> {
  const sql = getSql();
  const rows = await sql<{ imported_name: string | null }[]>`
    SELECT imported_name FROM registrations WHERE event_id = ${eventId} ORDER BY imported_name ASC
  `;
  return rows.map((r) => r.imported_name ?? '');
}

test('import mapping: preview echoes the final mapping and the CSV columns', async () => {
  const cookie = await login('imap-echo');
  const e = await createEvent(cookie);

  const res = await importCsv(cookie, e.id, nonCanonicalCsv(), 'preview', NON_CANONICAL_MAPPING);
  assertStatus(res, 200);
  const body = (await res.json()) as PreviewBody;

  assert.deepEqual(body.columns, ['Полное имя', 'Рабочая почта', 'Компания', 'Роль', 'Табельный номер', 'Статус']);
  assert.equal(body.mapping.name, 'Полное имя');
  assert.equal(body.mapping.email, 'Рабочая почта');
  assert.equal(body.mapping.company, 'Компания');
  assert.equal(body.mapping.role, 'Роль');
  assert.equal(body.mapping.external_id, 'Табельный номер');
  assert.equal(body.mapping.approval_status, 'Статус');
});

test('import mapping: the mapping actually changes the result (auto-map would miss)', async () => {
  const cookie = await login('imap-effect');
  const e = await createEvent(cookie);
  const csv = nonCanonicalCsv();

  // Without the mapping the columns are unknown: name/email do not resolve, so
  // no row is importable (the rows carry a name but not a *valid* email).
  const auto = await importCsv(cookie, e.id, csv, 'preview');
  assertStatus(auto, 200);
  const autoBody = (await auto.json()) as PreviewBody;
  assert.equal(autoBody.mapping.name, null);
  assert.equal(autoBody.mapping.email, null);
  assert.equal(autoBody.would_insert, 0);

  // With the mapping the same file yields two importable rows.
  const mapped = await importCsv(cookie, e.id, csv, 'preview', NON_CANONICAL_MAPPING);
  assertStatus(mapped, 200);
  const mappedBody = (await mapped.json()) as PreviewBody;
  assert.equal(mappedBody.would_insert, 2);
  assert.equal(mappedBody.would_update, 0);

  // Commit reuses the mapping and writes the rows with the right values.
  const commit = await importCsv(cookie, e.id, csv, 'commit', NON_CANONICAL_MAPPING);
  assertStatus(commit, 200);
  const counts = (await commit.json()) as { counts: { created: number; updated: number } };
  assert.equal(counts.counts.created, 2);
  assert.deepEqual(await importedNames(e.id), ['Alice Sample', 'Bob Sample']);
});

test('import mapping: preview writes nothing', async () => {
  const cookie = await login('imap-readonly');
  const e = await createEvent(cookie);

  const res = await importCsv(cookie, e.id, nonCanonicalCsv(), 'preview', NON_CANONICAL_MAPPING);
  assertStatus(res, 200);
  assert.equal(await registrationCount(e.id), 0);
});

test('import mapping: an unknown field is rejected with unknown_mapping_field', async () => {
  const cookie = await login('imap-badfield');
  const e = await createEvent(cookie);

  const res = await importCsv(cookie, e.id, nonCanonicalCsv(), 'preview', { 'Полное имя': 'nickname' });
  assertStatus(res, 400);
  const body = (await res.json()) as { code: string };
  assert.equal(body.code, 'unknown_mapping_field');
  assert.equal(await registrationCount(e.id), 0);
});

test('import mapping: a column absent from the CSV is rejected with unknown_csv_column', async () => {
  const cookie = await login('imap-badcol');
  const e = await createEvent(cookie);

  const res = await importCsv(cookie, e.id, nonCanonicalCsv(), 'preview', { 'No Such Column': 'name' });
  assertStatus(res, 400);
  const body = (await res.json()) as { code: string };
  assert.equal(body.code, 'unknown_csv_column');
});

test('import mapping: two columns for one field is rejected with duplicate_mapping_field', async () => {
  const cookie = await login('imap-dup');
  const e = await createEvent(cookie);

  const res = await importCsv(cookie, e.id, nonCanonicalCsv(), 'preview', {
    'Полное имя': 'name',
    'Рабочая почта': 'name',
  });
  assertStatus(res, 400);
  const body = (await res.json()) as { code: string };
  assert.equal(body.code, 'duplicate_mapping_field');
});

test('import mapping: re-preview after a commit reports would_update, not would_insert', async () => {
  const cookie = await login('imap-update');
  const e = await createEvent(cookie);
  const csv = nonCanonicalCsv();

  const first = await importCsv(cookie, e.id, csv, 'commit', NON_CANONICAL_MAPPING);
  assertStatus(first, 200);
  const firstCounts = (await first.json()) as { counts: { created: number; updated: number } };
  assert.equal(firstCounts.counts.created, 2);
  assert.equal(firstCounts.counts.updated, 0);

  // Same file again: every row matches by (event_id, provider, external_guest_id).
  const again = await importCsv(cookie, e.id, csv, 'preview', NON_CANONICAL_MAPPING);
  assertStatus(again, 200);
  const againBody = (await again.json()) as PreviewBody;
  assert.equal(againBody.would_insert, 0);
  assert.equal(againBody.would_update, 2);
  assert.equal(await registrationCount(e.id), 2);
});

test('import mapping: would_update counts only rows that already exist', async () => {
  const cookie = await login('imap-mixed');
  const e = await createEvent(cookie);

  const first = await importCsv(cookie, e.id, nonCanonicalCsv(), 'commit', NON_CANONICAL_MAPPING);
  assertStatus(first, 200);

  // One existing row (g-1) plus one brand new row (g-3).
  const mixed = [
    'Полное имя,Рабочая почта,Компания,Роль,Табельный номер,Статус',
    'Alice Updated,alice.sample@example.org,Acme,Engineer,g-1,approved',
    'Carol New,carol.new@example.org,Init,Founder,g-3,approved',
  ].join('\n');
  const res = await importCsv(cookie, e.id, mixed, 'preview', NON_CANONICAL_MAPPING);
  assertStatus(res, 200);
  const body = (await res.json()) as PreviewBody;
  assert.equal(body.would_insert, 1);
  assert.equal(body.would_update, 1);
  assert.equal(body.would_skip, 0);
  // Still read-only.
  assert.equal(await registrationCount(e.id), 2);
});

test('import mapping: repeated commit is idempotent (0 inserts, N updates, revision grows)', async () => {
  const cookie = await login('imap-idempotent');
  const e = await createEvent(cookie);
  const csv = nonCanonicalCsv();

  assertStatus(await importCsv(cookie, e.id, csv, 'commit', NON_CANONICAL_MAPPING), 200);
  const second = await importCsv(cookie, e.id, csv, 'commit', NON_CANONICAL_MAPPING);
  assertStatus(second, 200);
  const counts = (await second.json()) as { counts: { created: number; updated: number } };
  assert.equal(counts.counts.created, 0);
  assert.equal(counts.counts.updated, 2);
  assert.equal(await registrationCount(e.id), 2);

  const sql = getSql();
  const rows = await sql<{ import_revision: number }[]>`
    SELECT import_revision::int AS import_revision FROM registrations WHERE event_id = ${e.id}
  `;
  for (const row of rows) assert.equal(row.import_revision, 2);
});

test('import mapping: preview counts quarantined rows and caps the sample at 50', async () => {
  const cookie = await login('imap-quarantine');
  const e = await createEvent(cookie);

  const lines = ['Полное имя,Рабочая почта,Табельный номер,Статус'];
  for (let i = 0; i < 60; i++) {
    lines.push(`Person ${i},person${i}@example.org,p-${i},maybe`);
  }
  const res = await importCsv(
    cookie,
    e.id,
    lines.join('\n'),
    'preview',
    { 'Полное имя': 'name', 'Рабочая почта': 'email', 'Табельный номер': 'external_id', Статус: 'approval_status' },
  );
  assertStatus(res, 200);
  const body = (await res.json()) as PreviewBody;
  assert.equal(body.quarantined_count, 60);
  assert.equal(body.would_insert, 60);
  assert.ok(body.sample.length <= 50, 'sample must be capped at 50');
  assert.equal(body.sample.length, 50);
});

test('import mapping: rows with no upsert key are reported as would_skip', async () => {
  const cookie = await login('imap-skip');
  const e = await createEvent(cookie);

  // Name only: no external id and no valid email, so there is nothing to key on.
  const csv = ['Полное имя,Заметки', 'Nameless Key,hello'].join('\n');
  const res = await importCsv(cookie, e.id, csv, 'preview', { 'Полное имя': 'name' });
  assertStatus(res, 200);
  const body = (await res.json()) as PreviewBody;
  assert.equal(body.would_insert, 0);
  assert.equal(body.would_skip, 1);

  const commit = await importCsv(cookie, e.id, csv, 'commit', { 'Полное имя': 'name' });
  assertStatus(commit, 200);
  const counts = (await commit.json()) as { counts: { created: number; skipped: number } };
  assert.equal(counts.counts.created, 0);
  assert.equal(counts.counts.skipped, 1);
  // A skipped-only file leaves the table untouched.
  assert.equal(await registrationCount(e.id), 0);
});

test('import mapping: a non-organizer cannot import even with a valid mapping', async () => {
  const owner = await login('imap-owner');
  const e = await createEvent(owner);

  const stranger = await login('imap-stranger');
  const res = await importCsv(stranger, e.id, nonCanonicalCsv(), 'preview', NON_CANONICAL_MAPPING);
  assertStatus(res, 403);
});

test('import mapping: an anonymous request is rejected before any mapping work', async () => {
  const owner = await login('imap-anon-owner');
  const e = await createEvent(owner);

  const res = await importsRoute(
    makeRequest(`/api/events/${e.id}/imports`, {
      body: { csv_text: nonCanonicalCsv(), mode: 'preview', mapping: NON_CANONICAL_MAPPING },
    }),
    { params: Promise.resolve({ eventIdOrSlug: e.id }) },
  );
  assertStatus(res, 401);
});
