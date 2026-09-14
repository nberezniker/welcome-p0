import { randomUUID } from 'node:crypto';
import { getSql } from '../../src/lib/db';
import { generatePublicSlug, emailLookupHash, encryptValue } from '../../src/lib/crypto';
import { requireEncryptionKey, requireHashPepper } from '../../src/lib/env';
import { tickOnce, type TickReport } from '../../src/infra/worker';
import type { ChannelTransport } from '../../src/integrations/telegram/transport';
import type { EmailTransport } from '../../src/integrations/email/transport';

/**
 * Phase-3 integration helpers: direct DB factories for accounts/profiles/
 * bindings/consents (worker-side domain has no HTTP surface to drive them
 * through), plus a due_at helper that forces a job to be immediately claimable
 * on the DB clock.
 */

export interface TestUser {
  accountId: string;
  profileId: string;
}

/** Creates an active account + profile directly in the DB. */
export async function createUser(prefix: string): Promise<TestUser> {
  const sql = getSql();
  const accountRows = await sql<{ id: string }[]>`
    INSERT INTO accounts (auth_subject) VALUES (${'test:' + randomUUID()}) RETURNING id
  `;
  const accountId = accountRows[0]!.id;
  const profileRows = await sql<{ id: string }[]>`
    INSERT INTO profiles (account_id, public_slug, display_name)
    VALUES (${accountId}, ${generatePublicSlug()}, ${prefix + ' Тестов'})
    RETURNING id
  `;
  return { accountId, profileId: profileRows[0]!.id };
}

/** Active telegram binding for an account with a fake chat id. */
export async function bindTelegram(accountId: string, chatId: string): Promise<void> {
  const sql = getSql();
  await sql`
    INSERT INTO channel_bindings (account_id, provider, external_id, state)
    VALUES (${accountId}, 'telegram', ${chatId}, 'active')
  `;
}

export async function grantConsent(
  accountId: string,
  purpose: string,
  scopeType: 'global' | 'event',
  scopeId: string | null,
): Promise<void> {
  const sql = getSql();
  await sql`
    INSERT INTO consent_events (account_id, purpose, scope_type, scope_id, policy_version, action)
    VALUES (${accountId}, ${purpose}, ${scopeType}, ${scopeId}, '2026-09-07', 'grant')
  `;
}

export async function withdrawConsent(
  accountId: string,
  purpose: string,
  scopeType: 'global' | 'event',
  scopeId: string | null,
): Promise<void> {
  const sql = getSql();
  await sql`
    INSERT INTO consent_events (account_id, purpose, scope_type, scope_id, policy_version, action)
    VALUES (${accountId}, ${purpose}, ${scopeType}, ${scopeId}, '2026-09-07', 'withdraw')
  `;
}

/** Overrides a job's due_at to the DB now() so tickOnce claims it immediately
 * (attempt is preserved — backoff/429 tests rely on it). */
export async function makeJobDue(jobId: string): Promise<void> {
  const sql = getSql();
  await sql`UPDATE outbox_jobs SET due_at = now() WHERE id = ${jobId}`;
}

/**
 * Runs worker ticks until a full tick claims nothing (queue drained) or
 * maxTicks is hit. Integration suites share one DB, so leftover pending jobs
 * from earlier suites may occupy the first claim batches — draining makes
 * per-job assertions deterministic.
 */
export async function drainWorker(transport: ChannelTransport, maxTicks = 12): Promise<TickReport[]> {
  return drainWorkerWithEmail(transport, null, maxTicks);
}

/**
 * Same drain, with an injected EMAIL transport (ADR 0011). Pass `null` for a
 * deployment without an email provider (the worker then suppresses email-routed
 * jobs with `channel_disabled`).
 */
export async function drainWorkerWithEmail(
  transport: ChannelTransport,
  emailTransport: EmailTransport | null,
  maxTicks = 12,
): Promise<TickReport[]> {
  const reports: TickReport[] = [];
  for (let i = 0; i < maxTicks; i++) {
    const report = await tickOnce({ transport, emailTransport });
    reports.push(report);
    if (report.claimed === 0) break;
  }
  return reports;
}

/**
 * Gives an account a decryptable email the way the product does: an imported
 * registration that the account CLAIMED — the membership link is what makes the
 * address belong to the account (AC-08), and `registrations.encrypted_email` is
 * the only stored form of it (AES-256-GCM, ENCRYPTION_KEY).
 */
export async function attachClaimedEmail(accountId: string, eventId: string, email: string): Promise<string> {
  const sql = getSql();
  const profileRows = await sql<{ id: string }[]>`
    SELECT id FROM profiles WHERE account_id = ${accountId} LIMIT 1
  `;
  const profileId = profileRows[0]?.id;
  if (!profileId) throw new Error('attachClaimedEmail: account has no profile');
  const pepper = requireHashPepper();
  const lookup = emailLookupHash(email, pepper);
  const registrationRows = await sql<{ id: string }[]>`
    INSERT INTO registrations (event_id, provider, external_guest_id, email_lookup_hash, encrypted_email,
                               imported_name, claim_state)
    VALUES (${eventId}, 'csv', ${'guest-' + randomUUID()}, ${lookup},
            ${encryptValue(email, requireEncryptionKey())}, 'Claimed Guest', 'claimed')
    RETURNING id
  `;
  const registrationId = registrationRows[0]!.id;
  await sql`
    UPDATE event_memberships SET registration_id = ${registrationId}
    WHERE event_id = ${eventId} AND profile_id = ${profileId}
  `;
  return registrationId;
}

export async function jobRow(jobId: string): Promise<{
  id: string;
  status: string;
  attempt: number;
  due_at: Date;
}> {
  const sql = getSql();
  const rows = await sql<{ id: string; status: string; attempt: number; due_at: Date }[]>`
    SELECT id, status, attempt, due_at FROM outbox_jobs WHERE id = ${jobId}
  `;
  if (!rows[0]) throw new Error(`job ${jobId} not found`);
  return rows[0];
}

export async function attemptRows(jobId: string): Promise<{ state: string; code: string | null; provider_message_id: string | null }[]> {
  const sql = getSql();
  return sql<{ state: string; code: string | null; provider_message_id: string | null }[]>`
    SELECT state, code, provider_message_id FROM delivery_attempts WHERE job_id = ${jobId} ORDER BY id
  `;
}
