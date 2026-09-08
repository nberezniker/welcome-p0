import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { getSql, closeSql } from '../../src/lib/db';
import { generatePublicSlug } from '../../src/lib/crypto';
import { runCleanupIfDue, runCleanupPass, minimizeTelegramInboxPayload } from '../../src/infra/cleanup';
import { applyOutcome } from '../../src/infra/outbox';
import type { OutboxJobRow } from '../../src/infra/outbox';

// ---------------------------------------------------------------------------
// F-06/F-07 integration: retention cleanup + payload minimization.
// Rows are backdated directly in the DB; assertions check that the cleanup
// pass removes exactly what the retention policy says and nothing else.
// ---------------------------------------------------------------------------

after(async () => {
  await closeSql();
});

async function createAccount(prefix = 'cleanup'): Promise<string> {
  const sql = getSql();
  const rows = await sql<{ id: string }[]>`
    INSERT INTO accounts (auth_subject) VALUES (${`test:${prefix}-${randomUUID()}`}) RETURNING id
  `;
  return rows[0]!.id;
}

test('cleanup: expired sessions removed, fresh kept; stale OTP codes + challenges removed', async () => {
  const sql = getSql();
  const account = await createAccount('sess');
  await sql`INSERT INTO sessions (account_id, token_hash, expires_at) VALUES (${account}, 'h1', now() - interval '1 hour')`;
  await sql`INSERT INTO sessions (account_id, token_hash, expires_at) VALUES (${account}, 'h2', now() + interval '1 day')`;
  await sql`INSERT INTO auth_otp_codes (account_id, code_hash, expires_at, created_at) VALUES (${account}, 'c-old', now() + interval '1 hour', now() - interval '2 days')`;
  await sql`INSERT INTO auth_otp_codes (account_id, code_hash, expires_at) VALUES (${account}, 'c-new', now() + interval '1 hour')`;
  await sql`INSERT INTO link_challenges (account_id, purpose, token_hash, expires_at, created_at) VALUES (${account}, 'telegram_link', 'l-old', now() - interval '31 days', now() - interval '31 days')`;
  await sql`INSERT INTO link_challenges (account_id, purpose, token_hash, expires_at) VALUES (${account}, 'telegram_link', 'l-fresh-expired', now() - interval '1 day')`;

  const report = await runCleanupPass({ sql });
  assert.equal(report.sessions, 1);
  assert.equal(report.otp_codes, 1);
  assert.equal(report.link_challenges, 1);

  const remaining = await sql<{ count: number }[]>`
    SELECT
      (SELECT count(*) FROM sessions WHERE account_id = ${account})::int AS sessions,
      (SELECT count(*) FROM auth_otp_codes WHERE account_id = ${account})::int AS otp,
      (SELECT count(*) FROM link_challenges WHERE account_id = ${account})::int AS challenges
  `;
  assert.deepEqual(remaining[0], { sessions: 1, otp: 1, challenges: 1 });
});

test('cleanup: terminal outbox older than 90d removed with delivery_attempts; pending/young kept', async () => {
  const sql = getSql();
  const account = await createAccount('outbox');
  const oldSent = await sql<{ id: string }[]>`
    INSERT INTO outbox_jobs (dedupe_key, kind, purpose, payload, status, created_at)
    VALUES ('old-sent', 'telegram_reply', 'service_channel', '{}', 'sent', now() - interval '91 days')
    RETURNING id
  `;
  await sql`INSERT INTO delivery_attempts (job_id, state, code) VALUES (${oldSent[0]!.id}, 'sent', null)`;
  await sql`
    INSERT INTO outbox_jobs (dedupe_key, kind, purpose, payload, status, created_at)
    VALUES ('young-failed', 'telegram_reply', 'service_channel', '{}', 'failed', now() - interval '89 days')
  `;
  await sql`
    INSERT INTO outbox_jobs (dedupe_key, kind, purpose, payload, status, created_at)
    VALUES ('old-pending', 'telegram_reply', 'service_channel', '{}', 'pending', now() - interval '91 days')
  `;
  void account;

  const report = await runCleanupPass({ sql });
  assert.equal(report.outbox_jobs, 1, 'only the terminal 90d+ job is deleted');

  const attempts = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM delivery_attempts WHERE job_id = ${oldSent[0]!.id}`;
  assert.equal(attempts[0]!.count, 0, 'delivery_attempts cascade with the job');
  const kept = await sql<{ status: string }[]>`
    SELECT status FROM outbox_jobs WHERE dedupe_key IN ('young-failed', 'old-pending') ORDER BY dedupe_key
  `;
  assert.deepEqual(kept.map((r) => r.status).sort(), ['failed', 'pending']);
});

test('cleanup: inbox_events older than 90d removed; fresh kept', async () => {
  const sql = getSql();
  await sql`INSERT INTO inbox_events (provider, external_event_id, event_type, received_at) VALUES ('telegram', 'i-old', 'non_message', now() - interval '91 days')`;
  await sql`INSERT INTO inbox_events (provider, external_event_id, event_type) VALUES ('telegram', 'i-new', 'non_message')`;

  const report = await runCleanupPass({ sql });
  assert.equal(report.inbox_events, 1);
  const kept = await sql<{ external_event_id: string }[]>`SELECT external_event_id FROM inbox_events`;
  assert.deepEqual(kept.map((r) => r.external_event_id), ['i-new']);
});

test('cleanup: unclaimed registrations of long-ended events removed; claimed/fresh kept', async () => {
  const sql = getSql();
  const account = await createAccount('reg');
  const org = await sql<{ id: string }[]>`
    INSERT INTO organizers (display_name) VALUES ('Cleanup Org') RETURNING id
  `;
  const oldEvent = await sql<{ id: string }[]>`
    INSERT INTO events (organizer_id, slug, name, status, ends_at)
    VALUES (${org[0]!.id}, ${'old-' + randomUUID()}, 'Old', 'completed', now() - interval '45 days')
    RETURNING id
  `;
  const freshEvent = await sql<{ id: string }[]>`
    INSERT INTO events (organizer_id, slug, name, status, ends_at)
    VALUES (${org[0]!.id}, ${'fresh-' + randomUUID()}, 'Fresh', 'active', now() - interval '1 day')
    RETURNING id
  `;
  const insertReg = (eventId: string, state: string) =>
    sql`INSERT INTO registrations (event_id, provider, claim_state) VALUES (${eventId}, 'csv', ${state})`;
  await insertReg(oldEvent[0]!.id, 'unclaimed'); // deleted
  await insertReg(oldEvent[0]!.id, 'claimed'); // kept — organizer audience record
  await insertReg(freshEvent[0]!.id, 'unclaimed'); // kept — grace window not passed
  void account;

  const report = await runCleanupPass({ sql });
  assert.equal(report.registrations_unclaimed, 1);
  const states = await sql<{ claim_state: string }[]>`
    SELECT r.claim_state FROM registrations r
    JOIN events e ON e.id = r.event_id
    WHERE e.id IN (${oldEvent[0]!.id}, ${freshEvent[0]!.id})
  `;
  assert.deepEqual(states.map((r) => r.claim_state).sort(), ['claimed', 'unclaimed']);
});

test('cleanup: deleting accounts past grace are purged — user rows gone, consent/audit kept pseudonymized', async () => {
  const sql = getSql();
  const account = await createAccount('purge');
  const control = await createAccount('keep');
  await sql`UPDATE accounts SET status = 'deleting', auth_subject = 'deleted:' || id::text, email_lookup_hash = NULL, updated_at = now() - interval '8 days' WHERE id = ${account}`;
  await sql`UPDATE accounts SET status = 'deleting', updated_at = now() WHERE id = ${control}`;

  // Full user data graph for the doomed account.
  const profile = await sql<{ id: string }[]>`
    INSERT INTO profiles (account_id, public_slug, display_name) VALUES (${account}, ${generatePublicSlug()}, 'Purge Me') RETURNING id
  `;
  await sql`INSERT INTO contact_fields (profile_id, kind, encrypted_value) VALUES (${profile[0]!.id}, 'phone', 'v1.enc')`;
  await sql`INSERT INTO sessions (account_id, token_hash, expires_at) VALUES (${account}, 'purge-sess', now() + interval '1 day')`;
  await sql`INSERT INTO channel_bindings (account_id, provider, external_id) VALUES (${account}, 'telegram', 'purge-chat')`;
  await sql`INSERT INTO consent_events (account_id, purpose, scope_type, policy_version, action) VALUES (${account}, 'service_channel', 'global', 'v1', 'grant')`;
  await sql`INSERT INTO audit_events (actor_account_id, action, target_type) VALUES (${account}, 'account.delete_requested', 'account')`;

  // A registration "claimed" through this account's membership → link reset.
  const org = await sql<{ id: string }[]>`
    INSERT INTO organizers (display_name) VALUES ('Purge Org') RETURNING id
  `;
  const event = await sql<{ id: string }[]>`
    INSERT INTO events (organizer_id, slug, name, status) VALUES (${org[0]!.id}, ${'ev-' + randomUUID()}, 'E', 'active') RETURNING id
  `;
  const reg = await sql<{ id: string }[]>`
    INSERT INTO registrations (event_id, provider, claim_state) VALUES (${event[0]!.id}, 'csv', 'claimed') RETURNING id
  `;
  await sql`
    INSERT INTO event_memberships (event_id, profile_id, registration_id, directory_visible, state)
    VALUES (${event[0]!.id}, ${profile[0]!.id}, ${reg[0]!.id}, false, 'active')
  `;

  const report = await runCleanupPass({ sql });
  assert.equal(report.accounts_purged, 1, 'one deleting account past grace purged');

  const gone = await sql<{ count: number }[]>`
    SELECT
      (SELECT count(*) FROM sessions WHERE account_id = ${account})::int AS sessions,
      (SELECT count(*) FROM channel_bindings WHERE account_id = ${account})::int AS bindings,
      (SELECT count(*) FROM profiles WHERE account_id = ${account})::int AS profiles,
      (SELECT count(*) FROM contact_fields WHERE profile_id = ${profile[0]!.id})::int AS contacts,
      (SELECT count(*) FROM event_memberships WHERE profile_id = ${profile[0]!.id})::int AS memberships
  `;
  assert.deepEqual(gone[0], { sessions: 0, bindings: 0, profiles: 0, contacts: 0, memberships: 0 });

  // Registration survives, claim link reset to unclaimed.
  const regState = await sql<{ claim_state: string }[]>`SELECT claim_state FROM registrations WHERE id = ${reg[0]!.id}`;
  assert.equal(regState[0]!.claim_state, 'unclaimed');

  // Consent + audit records survive; actor pseudonymized; the shell stays.
  const kept = await sql<{ count: number }[]>`
    SELECT
      (SELECT count(*) FROM consent_events WHERE account_id = ${account})::int AS consents,
      (SELECT count(*) FROM audit_events WHERE actor_account_id = ${account})::int AS audited,
      (SELECT count(*) FROM accounts WHERE id = ${account} AND status = 'deleting')::int AS shell
  `;
  assert.deepEqual(kept[0], { consents: 1, audited: 0, shell: 1 });

  // The fresh control account is untouched.
  const controlCount = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM profiles WHERE account_id = ${control}`;
  assert.equal(controlCount[0]!.count, 0); // control never had a profile — just confirm nothing blew up
  const controlState = await sql<{ status: string }[]>`SELECT status FROM accounts WHERE id = ${control}`;
  assert.equal(controlState[0]!.status, 'deleting');
});

test('cleanup: runCleanupIfDue is gated to at least 6h between runs', async () => {
  const sql = getSql();
  await sql`INSERT INTO worker_heartbeat (id, beat_at, last_cleanup_at) VALUES (true, now(), null) ON CONFLICT (id) DO UPDATE SET last_cleanup_at = null`;
  const first = await runCleanupIfDue({ sql });
  assert.ok(first !== null, 'first call runs (last_cleanup_at was null/old)');
  const second = await runCleanupIfDue({ sql });
  assert.equal(second, null, 'second call within 6h must not run');
});

test('F-07: inbox minimal_payload is minimized after processing; sent outbox payload text dropped', async () => {
  const sql = getSql();
  const inbox = await sql<{ id: number }[]>`
    INSERT INTO inbox_events (provider, external_event_id, event_type, minimal_payload)
    VALUES ('telegram', 'min-1', 'message',
            ${sql.json({ update_id: 1, chat_id: 555, from_id: 444, text: 'hello private', message_id: 9 })})
    RETURNING id
  `;
  const ok = await minimizeTelegramInboxPayload(sql, inbox[0]!.id);
  assert.equal(ok, true);
  const payloads = await sql<{ minimal_payload: Record<string, unknown> }[]>`SELECT minimal_payload FROM inbox_events WHERE id = ${inbox[0]!.id}`;
  const p = payloads[0]!.minimal_payload;
  assert.equal(p['chat_id'], undefined, 'chat_id removed (it lives in channel_bindings)');
  assert.equal(p['text'], undefined);
  assert.equal(p['from_id'], undefined);
  assert.equal(p['update_id'], 1, 'routing-neutral update_id kept');
  assert.equal(p['message_id'], 9, 'routing-neutral message_id kept');

  // Outbox: apply 'sent' → text dropped from the durable payload.
  const job = await sql<OutboxJobRow[]>`
    INSERT INTO outbox_jobs (dedupe_key, kind, purpose, payload, status)
    VALUES ('min-out', 'telegram_reply', 'service_channel',
            ${sql.json({ chat_id: '555', text: 'secret reply text', account_id: randomUUID() })}, 'leased')
    RETURNING id, dedupe_key, kind, subject_id, channel, purpose, payload, due_at, status, lease_until, attempt, created_at
  `;
  const outcome = await applyOutcome(sql, job[0]!, { state: 'sent', code: null, providerMessageId: 'm1', retryAfterSeconds: null });
  assert.equal(outcome, 'sent');
  const afterSent = await sql<{ payload: Record<string, unknown> }[]>`SELECT payload FROM outbox_jobs WHERE id = ${job[0]!.id}`;
  assert.equal(afterSent[0]!.payload['text'], undefined, 'sent job payload must not retain the message text');
  assert.equal(afterSent[0]!.payload['chat_id'], '555', 'non-PII routing fields stay for audit');
});
