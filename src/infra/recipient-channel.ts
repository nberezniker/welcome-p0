import type { Sql, TransactionSql } from 'postgres';
import { decryptValue } from '../lib/crypto';
import { requireEncryptionKey } from '../lib/env';
import { log } from '../lib/logger';

/**
 * Recipient channel selection (ADR 0011).
 *
 * Outbound notification jobs used to be Telegram-only: a recipient without any
 * binding was suppressed with `no_channel` and never reached. Since an account's
 * email is already stored (encrypted, on the claimed registration) the worker now
 * has a documented second channel, chosen at SEND time from live state:
 *
 *   1. an ACTIVE telegram binding wins (chat is the richest, most immediate one);
 *   2. otherwise, if a decryptable account email exists, email — but only when
 *      the job's own consent precondition holds (`service_channel` for the intro
 *      notices, the campaign purpose for campaigns);
 *   3. a REVOKED or BLOCKED binding is terminal for that recipient: "stop" must
 *      never be re-routed to another channel behind the user's back;
 *   4. otherwise `no_channel`, exactly as before.
 *
 * The decision itself is a pure function (unit-tested); the two resolvers below
 * are the only DB access. NOTHING here ever logs a recipient address.
 */

type SqlLike = Sql | TransactionSql;

export type TelegramBindingState = 'active' | 'revoked' | 'blocked';

export interface ChannelFacts {
  /** Telegram binding state for the recipient account, or null when none exists. */
  telegramBinding: TelegramBindingState | null;
  /** True when a decryptable account email exists. The address itself never leaves the resolver. */
  hasEmail: boolean;
  /** Consent for the job's purpose/scope: null when the job does not opt in. */
  consentGranted: boolean | null;
}

export type ChannelDecision =
  | { channel: 'telegram' }
  | { channel: 'email' }
  | { channel: 'suppress'; code: string };

/**
 * Pure channel selection. Branch order is deliberate (see the module comment):
 * consent only ever decides when a channel would otherwise be available, so a
 * recipient with neither a binding nor an email keeps the historical
 * `no_channel` code instead of being reported as a consent problem.
 */
export function decideRecipientChannel(facts: ChannelFacts): ChannelDecision {
  if (facts.telegramBinding === 'revoked') return { channel: 'suppress', code: 'channel_revoked' };
  if (facts.telegramBinding === 'blocked') return { channel: 'suppress', code: 'channel_blocked' };
  if (facts.telegramBinding === 'active') {
    return facts.consentGranted === false
      ? { channel: 'suppress', code: 'consent_revoked' }
      : { channel: 'telegram' };
  }
  if (!facts.hasEmail) return { channel: 'suppress', code: 'no_channel' };
  return facts.consentGranted === false
    ? { channel: 'suppress', code: 'consent_revoked' }
    : { channel: 'email' };
}

/** Telegram binding state for an account (any provider row), or null. */
export async function loadTelegramBindingState(
  sql: SqlLike,
  accountId: string,
): Promise<{ state: TelegramBindingState; externalId: string } | null> {
  const rows = await sql<{ state: TelegramBindingState; external_id: string }[]>`
    SELECT state, external_id FROM channel_bindings
    WHERE account_id = ${accountId} AND provider = 'telegram'
    LIMIT 1
  `;
  const row = rows[0];
  return row ? { state: row.state, externalId: row.external_id } : null;
}

/**
 * Resolves the account's own email address (decrypted, in memory only).
 *
 * Source of truth: `registrations.encrypted_email` of a registration the account
 * CLAIMED — `event_memberships.registration_id` is only set after the claim
 * verified `accounts.email_lookup_hash = registrations.email_lookup_hash`
 * (AC-08), so the address provably belongs to this account. The login address
 * itself is never stored in plaintext (only its peppered lookup hash), which is
 * why the claimed registration is the single available source.
 *
 * `eventId` scopes the lookup to one event when the job has one; without it the
 * account's most recently imported registration email is used.
 *
 * Returns null (never a log line, never a throw) when no row matches or the
 * stored value cannot be decrypted — a key rotation must degrade to
 * `no_channel`, not to a 500 that stalls the queue.
 */
export async function resolveAccountEmail(
  sql: SqlLike,
  accountId: string,
  eventId: string | null = null,
): Promise<string | null> {
  const rows = await sql<{ encrypted_email: string }[]>`
    SELECT r.encrypted_email
    FROM event_memberships m
    JOIN profiles p ON p.id = m.profile_id
    JOIN registrations r ON r.id = m.registration_id
    WHERE p.account_id = ${accountId}
      AND r.encrypted_email IS NOT NULL
      AND (${eventId}::uuid IS NULL OR m.event_id = ${eventId}::uuid)
    ORDER BY r.created_at DESC
    LIMIT 1
  `;
  const encrypted = rows[0]?.encrypted_email;
  if (!encrypted) return null;
  try {
    return decryptValue(encrypted, requireEncryptionKey());
  } catch {
    // Deliberately silent about the value: a decryptable-on-a-different-key row
    // is a data issue, not a reason to put an address (or its ciphertext) in a
    // log. The event label carries the signal, and the caught error is NOT passed
    // on — a decryption failure message is the one message that can quote the
    // input it failed on.
    log.warn('[notify] a stored account email could not be decrypted; falling back to no channel', {
      event: 'account_email_undecryptable',
    });
    return null;
  }
}
