import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { runMigrations } from '../../scripts/migrate.mjs';
import { listMigrationFiles } from '../../scripts/migrate.mjs';
import { getSql, closeSql } from '../../src/lib/db';

after(async () => {
  await closeSql();
});

test('migrations: applying again is a no-op (idempotent, exactly one row per version)', async () => {
  const first = await runMigrations();
  const second = await runMigrations();
  assert.deepEqual(second.applied, []);
  void first;

  const sql = getSql();
  const files = await listMigrationFiles();
  const rows = await sql<{ version: string }[]>`SELECT version FROM schema_migrations`;
  assert.equal(rows.length, files.length);
  for (const f of files) {
    assert.ok(rows.some((r) => r.version === f.version), `missing schema_migrations row for ${f.version}`);
  }
});

test('migrations: adapted contract tables exist with required columns', async () => {
  const sql = getSql();

  const tables = [
    'accounts', 'profiles', 'contact_fields', 'organizers', 'organizer_members',
    'events', 'registrations', 'event_memberships', 'channel_bindings', 'link_challenges',
    'consent_events', 'introductions', 'introduction_consents', 'connection_notes',
    'campaigns', 'inbox_events', 'outbox_jobs', 'delivery_attempts', 'audit_events',
    'sessions', 'auth_otp_codes', 'worker_heartbeat', 'schema_migrations',
  ];
  for (const t of tables) {
    const r = await sql`SELECT to_regclass(${'public.' + t}) AS reg`;
    assert.ok(r[0]?.reg, `table ${t} must exist`);
  }
});

test('migrations: accounts has is_demo + email_lookup_hash; rate_limits is absent', async () => {
  const sql = getSql();
  const cols = await sql<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns WHERE table_name = 'accounts'
  `;
  const names = cols.map((c) => c.column_name);
  assert.ok(names.includes('is_demo'));
  assert.ok(names.includes('email_lookup_hash'));

  const rateLimits = await sql`SELECT to_regclass('public.rate_limits') AS reg`;
  assert.equal(rateLimits[0]?.reg, null, 'rate_limits table must NOT exist');
});

test('migrations: events has the Phase-1 extra columns', async () => {
  const sql = getSql();
  const cols = await sql<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns WHERE table_name = 'events'
  `;
  const names = cols.map((c) => c.column_name);
  for (const c of ['mode', 'access_mode', 'max_participants', 'location_label', 'online_link', 'description', 'consent_text', 'networking_window_days']) {
    assert.ok(names.includes(c), `events.${c} must exist`);
  }
  const def = await sql<{ column_default: string }[]>`
    SELECT column_default FROM information_schema.columns
    WHERE table_name = 'events' AND column_name = 'networking_window_days'
  `;
  assert.match(def[0]?.column_default ?? '', /30/);
});

test('migrations: sessions table shape matches the brief', async () => {
  const sql = getSql();
  const cols = await sql<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns WHERE table_name = 'sessions'
  `;
  const names = cols.map((c) => c.column_name);
  for (const c of ['id', 'account_id', 'token_hash', 'expires_at', 'created_at']) {
    assert.ok(names.includes(c), `sessions.${c} must exist`);
  }
  const uniq = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM pg_indexes
    WHERE tablename = 'sessions' AND indexdef LIKE '%UNIQUE%token_hash%'
  `;
  assert.equal((uniq[0]?.count ?? 0) >= 1, true, 'sessions.token_hash must be UNIQUE');
});

test('migrations: profiles CHECK enforces slug length >= 22 at the DB level', async () => {
  const sql = getSql();
  const checks = await sql<{ conname: string }[]>`
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'profiles'::regclass AND contype = 'c'
  `;
  assert.ok(checks.some((c) => c.conname === 'profiles_public_slug_check' || c.conname.includes('public_slug')));

  const accRows = await sql<{ id: string }[]>`
    INSERT INTO accounts (auth_subject) VALUES (${'check-test:' + Date.now()}) RETURNING id
  `;
  const accountId = accRows[0]?.id as string;
  await assert.rejects(
    sql`INSERT INTO profiles (account_id, public_slug, display_name) VALUES (${accountId}, ${'short-slug'}, ${'X'})`,
    (err: { code?: string }) => err.code === '23514',
  );
});
