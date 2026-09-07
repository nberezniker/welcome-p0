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
    // Phase 2 additions
    'blocks', 'reports',
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

// ---------------------------------------------------------------------------
// Migration 002 — Phase 2 schema additions
// ---------------------------------------------------------------------------

test('migrations 002: events has join_code / directory_close_at / intro_cooldown_days default 30', async () => {
  const sql = getSql();
  const cols = await sql<{ column_name: string; column_default: string | null; is_nullable: string }[]>`
    SELECT column_name, column_default, is_nullable FROM information_schema.columns
    WHERE table_name = 'events'
  `;
  const byName = new Map(cols.map((c) => [c.column_name, c]));
  assert.ok(byName.has('join_code'));
  assert.ok(byName.has('directory_close_at'));
  assert.equal(byName.get('directory_close_at')?.is_nullable, 'YES');
  assert.match(byName.get('intro_cooldown_days')?.column_default ?? '', /30/);
});

test('migrations 002: event_memberships has matching_enabled + attendance_source CHECK', async () => {
  const sql = getSql();
  const cols = await sql<{ column_name: string; column_default: string | null }[]>`
    SELECT column_name, column_default FROM information_schema.columns
    WHERE table_name = 'event_memberships'
  `;
  const byName = new Map(cols.map((c) => [c.column_name, c]));
  assert.match(byName.get('matching_enabled')?.column_default ?? '', /true/);
  assert.match(byName.get('attendance_source')?.column_default ?? '', /none/);

  const accRows = await sql<{ id: string }[]>`
    INSERT INTO accounts (auth_subject) VALUES (${'ms-check:' + Date.now()}) RETURNING id
  `;
  const profRows = await sql<{ id: string }[]>`
    INSERT INTO profiles (account_id, public_slug, display_name) VALUES (${accRows[0]!.id}, ${'ms-check-slug-' + Date.now()}, ${'X'}) RETURNING id
  `;
  const orgRows = await sql<{ id: string }[]>`
    INSERT INTO organizers (display_name) VALUES (${'MS Org'}) RETURNING id
  `;
  const evRows = await sql<{ id: string }[]>`
    INSERT INTO events (organizer_id, name, slug) VALUES (${orgRows[0]!.id}, ${'MS Event'}, ${'ms-check-' + Date.now()}) RETURNING id
  `;
  await assert.rejects(
    sql`INSERT INTO event_memberships (event_id, profile_id, attendance_source)
        VALUES (${evRows[0]!.id}, ${profRows[0]!.id}, ${'guessed'})`,
    (err: { code?: string }) => err.code === '23514',
  );
});

test('migrations 002: consent purpose CHECK rejects unknown purposes', async () => {
  const sql = getSql();
  const accRows = await sql<{ id: string }[]>`
    INSERT INTO accounts (auth_subject) VALUES (${'consent-check:' + Date.now()}) RETURNING id
  `;
  await assert.rejects(
    sql`INSERT INTO consent_events (account_id, purpose, scope_type, policy_version, action)
        VALUES (${accRows[0]!.id}, ${'newsletter'}, ${'global'}, ${'v1'}, ${'grant'})`,
    (err: { code?: string }) => err.code === '23514',
  );
  const ok = await sql`
    INSERT INTO consent_events (account_id, purpose, scope_type, policy_version, action)
    VALUES (${accRows[0]!.id}, ${'event_directory'}, ${'global'}, ${'v1'}, ${'grant'}) RETURNING id
  `;
  assert.ok(ok[0]?.id);
});

test('migrations 002: introductions accepts revoked state', async () => {
  const sql = getSql();
  const accRows = await sql<{ id: string }[]>`
    INSERT INTO accounts (auth_subject) VALUES (${'intro-state:' + Date.now()}) RETURNING id
  `;
  const profRows = await sql<{ id: string }[]>`
    INSERT INTO profiles (account_id, public_slug, display_name)
    VALUES (${accRows[0]!.id}, ${'intro-state-slug-' + Date.now()}, ${'X'}) RETURNING id
  `;
  const profileId = profRows[0]!.id;
  const orgRows = await sql<{ id: string }[]>`
    INSERT INTO organizers (display_name) VALUES (${'IS Org'}) RETURNING id
  `;
  const evRows = await sql<{ id: string }[]>`
    INSERT INTO events (organizer_id, name, slug) VALUES (${orgRows[0]!.id}, ${'IS Event'}, ${'intro-state-' + Date.now()}) RETURNING id
  `;
  // Need a second profile for the pair CHECK (profile_a <> profile_b).
  const acc2 = await sql<{ id: string }[]>`
    INSERT INTO accounts (auth_subject) VALUES (${'intro-state-b:' + Date.now()}) RETURNING id
  `;
  const prof2 = await sql<{ id: string }[]>`
    INSERT INTO profiles (account_id, public_slug, display_name)
    VALUES (${acc2[0]!.id}, ${'intro-state-slug-b-' + Date.now()}, ${'Y'}) RETURNING id
  `;
  const ins = await sql`
    INSERT INTO introductions (event_id, profile_a, profile_b, context_key, state)
    VALUES (${evRows[0]!.id}, ${profileId}, ${prof2[0]!.id}, ${'event:' + evRows[0]!.id}, ${'revoked'}) RETURNING state
  `;
  assert.equal(ins[0]?.state, 'revoked');
});

test('migrations 002: link_challenges.registration_id exists; blocks forbids self-block', async () => {
  const sql = getSql();
  const cols = await sql<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns WHERE table_name = 'link_challenges'
  `;
  assert.ok(cols.some((c) => c.column_name === 'registration_id'));

  const accRows = await sql<{ id: string }[]>`
    INSERT INTO accounts (auth_subject) VALUES (${'blocks-check:' + Date.now()}) RETURNING id
  `;
  const accountId = accRows[0]!.id;
  await assert.rejects(
    sql`INSERT INTO blocks (blocker_account_id, target_account_id) VALUES (${accountId}, ${accountId})`,
    (err: { code?: string }) => err.code === '23514',
  );
});

test('migrations 002: reports stores a row with default open status', async () => {
  const sql = getSql();
  const accRows = await sql<{ id: string }[]>`
    INSERT INTO accounts (auth_subject) VALUES (${'reports-check:' + Date.now()}) RETURNING id
  `;
  const acc2 = await sql<{ id: string }[]>`
    INSERT INTO accounts (auth_subject) VALUES (${'reports-check-b:' + Date.now()}) RETURNING id
  `;
  const rep = await sql<{ status: string }[]>`
    INSERT INTO reports (reporter_account_id, target_account_id, reason)
    VALUES (${accRows[0]!.id}, ${acc2[0]!.id}, ${'spam'}) RETURNING status
  `;
  assert.equal(rep[0]?.status, 'open');
});
