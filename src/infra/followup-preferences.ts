import type { Sql, TransactionSql } from 'postgres';
import { getSql } from '../lib/db';
import { recordAudit } from '../lib/audit';
import { isOptedIn, type FollowupMechanic } from '../domain/followup';

/**
 * Opt-in bookkeeping for the two Phase-4 mechanics (followup_preferences,
 * migration 012).
 *
 * Opt-in is NOT consent, and the two are stored separately on purpose:
 *
 *   - CONSENT (`consent_events`, e.g. `service_channel`, `digest_weekly`) answers
 *     "is this class of message allowed at all?" — append-only, purpose-scoped,
 *     and the thing a revocation suppresses queued jobs by;
 *   - OPT-IN (here) answers "did this person ask for THIS mechanic?" — a pair of
 *     timestamps, so the answer is auditable and re-asking after opting out
 *     works.
 *
 * A message needs both. This module is the only writer of the opt-in half, and
 * every write records an `audit_events` row, so "when did they ask for it" and
 * "when did they stop it" are answerable without reading the feature's state.
 *
 * Note on reminders: opting in does NOT grant `service_channel`. A narrow
 * «remind me about my next step» switch must not silently allow introduction
 * notices too, so the reminder opt-in can be switched on while the consent is
 * still missing — and then nothing is sent (fail-closed, and the UI says why).
 */

type SqlLike = Sql | TransactionSql;

export interface FollowupOptInState {
  readonly reminders: boolean;
  readonly digest: boolean;
}

const NONE: FollowupOptInState = { reminders: false, digest: false };

/**
 * Current opt-in state of one account. A missing row is "never asked" → both
 * false, which is the state of every account that predates migration 012.
 */
export async function loadOptInState(sql: SqlLike = getSql(), accountId: string): Promise<FollowupOptInState> {
  const rows = await sql<{ reminders_in: Date | null; reminders_out: Date | null; digest_in: Date | null; digest_out: Date | null }[]>`
    SELECT reminders_opt_in_at AS reminders_in,
           reminders_opt_out_at AS reminders_out,
           digest_opt_in_at AS digest_in,
           digest_opt_out_at AS digest_out
    FROM followup_preferences
    WHERE account_id = ${accountId}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return NONE;
  return {
    reminders: isOptedIn(row.reminders_in, row.reminders_out),
    digest: isOptedIn(row.digest_in, row.digest_out),
  };
}

/**
 * Records one mechanic's opt-in or opt-out. The row is upserted (one row per
 * account) and only ONE of that mechanic's two columns is stamped per call, so
 * the other stays as evidence of the earlier decision.
 *
 * The four branches are spelled out instead of interpolating a column name: the
 * statement shape stays reviewable, and no SQL fragment is ever assembled from a
 * string that could one day come from a request.
 */
export async function setOptIn(
  sqlLike: SqlLike,
  accountId: string,
  mechanic: FollowupMechanic,
  optedIn: boolean,
  now: Date = new Date(),
): Promise<void> {
  if (mechanic === 'reminders' && optedIn) {
    await sqlLike`
      INSERT INTO followup_preferences (account_id, reminders_opt_in_at, updated_at)
      VALUES (${accountId}, ${now}, now())
      ON CONFLICT (account_id) DO UPDATE SET reminders_opt_in_at = ${now}, updated_at = now()
    `;
  } else if (mechanic === 'reminders') {
    await sqlLike`
      INSERT INTO followup_preferences (account_id, reminders_opt_out_at, updated_at)
      VALUES (${accountId}, ${now}, now())
      ON CONFLICT (account_id) DO UPDATE SET reminders_opt_out_at = ${now}, updated_at = now()
    `;
  } else if (optedIn) {
    await sqlLike`
      INSERT INTO followup_preferences (account_id, digest_opt_in_at, updated_at)
      VALUES (${accountId}, ${now}, now())
      ON CONFLICT (account_id) DO UPDATE SET digest_opt_in_at = ${now}, updated_at = now()
    `;
  } else {
    await sqlLike`
      INSERT INTO followup_preferences (account_id, digest_opt_out_at, updated_at)
      VALUES (${accountId}, ${now}, now())
      ON CONFLICT (account_id) DO UPDATE SET digest_opt_out_at = ${now}, updated_at = now()
    `;
  }

  await recordAudit(sqlLike, accountId, optedIn ? 'followup.opt_in' : 'followup.opt_out', 'account', accountId, {
    mechanic,
  });
}
