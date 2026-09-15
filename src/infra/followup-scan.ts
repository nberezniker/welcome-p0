import type { Sql } from 'postgres';
import { hasGrant } from '../domain/consent';
import {
  DIGEST_MAX_PEOPLE,
  digestDedupeKey,
  digestRepeatWindowStartMs,
  digestWeekKey,
  renderDigestMessage,
  selectDigestPeople,
  type DigestCandidate,
} from '../domain/digest';
import {
  renderReminderMessage,
  selectDueReminders,
  unsubscribePath,
  type FollowupNoteInput,
} from '../domain/followup';
import { goalLabel } from '../domain/goals';
import { parseCatalog, reasonLabelOfV4 } from '../domain/picker';
import { recommendForEvent } from '../domain/recommendations';
import { formatReasonV4 } from '../domain/reasons-v4';
import { taxonomyPayload } from '../domain/taxonomy';
import { DEFAULT_LOCALE } from '../i18n/locale';
import { reasonV4Templates } from '../i18n/reason-templates';
import { appBaseUrl, digestEnabled, followupReminderDays, followupRemindersEnabled, requireHashPepper } from '../lib/env';
import { getSql } from '../lib/db';
import { enqueueOutbox } from './outbox';
import { decideRecipientChannel, loadTelegramBindingState, resolveAccountEmail } from './recipient-channel';

/**
 * Phase-4 follow-up scan — the worker step that turns the two mechanics'
 * bookkeeping into outbox jobs (docs-internal/product/
 * SOCIAL_INTEROP_AND_MATCHING.md §B5 + §D item 8).
 *
 * It is a SCAN, not a sender: it enqueues and stops. The existing worker
 * pipeline (outbox → claim → channel selection → transport) does the sending
 * exactly as it does for every other kind, which is what keeps the consent,
 * suppression and channel rules in ONE place.
 *
 * Gates, in order, for both mechanics — a message is enqueued only when ALL of
 * them hold (the task's non-negotiable #2):
 *
 *   1. the feature flag is on            → otherwise the scan does not even run a
 *                                          single query for that mechanic;
 *   2. the recipient opted in            → followup_preferences, explicit and
 *                                          revocable (timestamp pair);
 *   3. the required consent is granted   → `service_channel` for the reminder,
 *                                          `digest_weekly` for the digest;
 *   4. a delivery channel is available   → the SHARED decision function, so the
 *                                          scan and the send-time re-check cannot
 *                                          disagree;
 *   5. the recipient is not suppressed   → not blocked, no withdrawal in flight
 *                                          (3 covers it), and the send-time
 *                                          re-check runs the same rules again.
 *
 * Idempotency is a property of the DEDUPE KEY, not of the scan's bookkeeping:
 * `followup:<owner>:<other>:<status>` and `digest:<account>:<week>` are UNIQUE in
 * outbox_jobs, so a second tick inside the same window inserts nothing and the
 * bookkeeping below is only written when the insert actually created a row.
 *
 * Cost: a bounded number of rows per tick (see the three caps) so a tick stays
 * inside a serverless function budget. A backlog therefore drains over several
 * ticks — documented in the phase-4 operator doc, not hidden.
 */

/** Notes examined per tick. Oldest first, so nothing starves behind a flood. */
const REMINDER_SCAN_LIMIT = 25;
/** Opted-in recipients examined per tick. */
const DIGEST_ACCOUNT_LIMIT = 25;
/** Events consulted per recipient (the digest reuses the per-event recommender). */
const DIGEST_EVENTS_PER_ACCOUNT = 5;

export interface MechanicScanReport {
  readonly scanned: number;
  readonly enqueued: number;
}

export interface FollowupScanReport {
  readonly enabled: { readonly reminders: boolean; readonly digest: boolean };
  readonly reminders: MechanicScanReport;
  readonly digest: MechanicScanReport;
  /** Set when the scan itself failed; the tick still delivers its outbox batch. */
  readonly error: string | null;
}

const EMPTY: MechanicScanReport = { scanned: 0, enqueued: 0 };

/**
 * Runs both scans for one tick. Returns early — without touching the database —
 * when both flags are off, which is the default and the only state a deployment
 * is in until a human turns a mechanic on.
 */
export async function runFollowupScan(sql: Sql = getSql(), now: Date = new Date()): Promise<FollowupScanReport> {
  const enabled = { reminders: followupRemindersEnabled(), digest: digestEnabled() };
  if (!enabled.reminders && !enabled.digest) {
    return { enabled, reminders: EMPTY, digest: EMPTY, error: null };
  }
  try {
    const reminders = enabled.reminders ? await scanReminders(sql, now) : EMPTY;
    const digest = enabled.digest ? await scanDigest(sql, now) : EMPTY;
    return { enabled, reminders, digest, error: null };
  } catch (err) {
    // A broken scan must never take the deliveries down with it: the outbox
    // batch of this tick is still claimed and processed by the caller.
    const message = err instanceof Error ? err.message : String(err);
    console.error('[followup-scan] failed:', err);
    return { enabled, reminders: EMPTY, digest: EMPTY, error: message };
  }
}

// ---------------------------------------------------------------------------
// Mechanic 1 — «next step» reminder
// ---------------------------------------------------------------------------

interface ReminderRow {
  owner_account_id: string;
  other_profile_id: string;
  other_display_name: string;
  next_step: string | null;
  next_step_status: string;
  updated_at: Date;
  followup_reminded_status: string | null;
  introduction_mutual: boolean;
  other_account_id: string;
}

/**
 * Enqueues one reminder per due, opted-in, consented, reachable note.
 *
 * The candidate query already encodes gates 2 (opt-in), 5 (not blocked) and the
 * "the introduction actually became mutual" rule; the per-row loop applies the
 * channel decision (gate 4) and the consent check (gate 3) on live state, so a
 * withdrawal between the query and the enqueue cannot slip through.
 */
async function scanReminders(sql: Sql, now: Date): Promise<MechanicScanReport> {
  const days = followupReminderDays();
  const rows = await sql<ReminderRow[]>`
    SELECT cn.owner_account_id,
           cn.other_profile_id,
           p.display_name AS other_display_name,
           cn.next_step,
           cn.next_step_status,
           cn.updated_at,
           cn.followup_reminded_status,
           -- "the introduction actually became a meeting": state 'mutual' is the
           -- only state in which BOTH sides agreed, so it is the only state that
           -- may be called a meeting (spec §7). The pair is matched in BOTH
           -- directions — introductions store profile_a/profile_b in canonical
           -- order, which has nothing to do with who wrote the note.
           EXISTS (
             SELECT 1 FROM introductions i
             JOIN profiles pa ON pa.id = i.profile_a
             JOIN profiles pb ON pb.id = i.profile_b
             WHERE i.state = 'mutual'
               AND (
                 (pa.account_id = cn.owner_account_id AND pb.id = cn.other_profile_id)
                 OR (pb.account_id = cn.owner_account_id AND pa.id = cn.other_profile_id)
               )
           ) AS introduction_mutual,
           p.account_id AS other_account_id
    FROM connection_notes cn
    JOIN profiles p ON p.id = cn.other_profile_id
    JOIN accounts a ON a.id = cn.owner_account_id AND a.status = 'active'
    JOIN followup_preferences fp ON fp.account_id = cn.owner_account_id
    WHERE cn.next_step IS NOT NULL
      AND cn.next_step_status IN ('proposed','confirmed')
      AND fp.reminders_opt_in_at IS NOT NULL
      AND (fp.reminders_opt_out_at IS NULL OR fp.reminders_opt_out_at < fp.reminders_opt_in_at)
      AND cn.updated_at <= now() - (${days} * interval '1 day')
      AND cn.followup_reminded_status IS DISTINCT FROM cn.next_step_status
      AND NOT EXISTS (
        SELECT 1 FROM blocks b
        WHERE (b.blocker_account_id = cn.owner_account_id AND b.target_account_id = p.account_id)
           OR (b.blocker_account_id = p.account_id AND b.target_account_id = cn.owner_account_id)
      )
    ORDER BY cn.updated_at
    LIMIT ${REMINDER_SCAN_LIMIT}
  `;

  const notes: FollowupNoteInput[] = rows.map((row) => ({
    ownerAccountId: row.owner_account_id,
    otherProfileId: row.other_profile_id,
    otherDisplayName: row.other_display_name,
    nextStep: row.next_step,
    nextStepStatus: row.next_step_status,
    stepSetAtMs: new Date(row.updated_at).getTime(),
    introductionMutual: row.introduction_mutual === true,
    remindedStatus: row.followup_reminded_status,
  }));

  const due = selectDueReminders(notes, { nowMs: now.getTime(), days });
  const byKey = new Map(rows.map((row) => [`${row.owner_account_id}:${row.other_profile_id}`, row]));

  let enqueued = 0;
  for (const reminder of due) {
    const row = byKey.get(`${reminder.ownerAccountId}:${reminder.otherProfileId}`);
    if (!row) continue;
    if (!(await recipientIsReachable(sql, reminder.ownerAccountId, 'service_channel'))) continue;

    const message = renderReminderMessage({
      locale: DEFAULT_LOCALE,
      counterpartyName: reminder.otherDisplayName,
      nextStep: reminder.nextStep,
      link: `${baseUrl()}${NOTES_PATH}`,
      unsubscribeLink: `${baseUrl()}${unsubscribePath(reminder.ownerAccountId, 'reminders', requireHashPepper())}`,
    });

    const created = await sql.begin(async (tx) => {
      const result = await enqueueOutbox(tx, {
        dedupeKey: reminder.dedupeKey,
        kind: 'followup_reminder',
        subjectId: reminder.otherProfileId,
        channel: 'telegram',
        // A service message about the recipient's OWN commitment — never marketing.
        purpose: 'service_channel',
        payload: {
          account_id: reminder.ownerAccountId,
          // No event context: the note is not event-scoped, so the email channel
          // falls back to the account's most recent claimed registration.
          event_id: null,
          text: message.text,
          enforce_consent: true,
          counterparty_account_id: row.other_account_id,
          followup_status: reminder.status,
        },
      });
      if (result.created) {
        // Bookkeeping in the SAME transaction as the enqueue (spec 04 §7): the
        // "already reminded" state and the job can never disagree.
        await tx`
          UPDATE connection_notes
          SET followup_reminded_status = ${reminder.status}, followup_reminded_at = now()
          WHERE owner_account_id = ${reminder.ownerAccountId}
            AND other_profile_id = ${reminder.otherProfileId}
        `;
      }
      return result.created;
    });
    if (created) enqueued += 1;
  }

  return { scanned: rows.length, enqueued };
}

// ---------------------------------------------------------------------------
// Mechanic 2 — weekly «who to meet» digest
// ---------------------------------------------------------------------------

interface DigestRecipientRow {
  account_id: string;
  profile_id: string;
  goals: string[];
}

/**
 * Enqueues at most one digest per opted-in recipient per ISO week.
 *
 * The candidates come from the EXISTING per-event recommender, so the digest
 * inherits the app's own server-side eligibility (active membership + directory
 * visible + matching enabled + no block + not already introduced + inside the
 * event's intro cooldown) instead of re-implementing it. Candidates from several
 * events are merged, the recently digested are excluded, and the pure selector
 * caps the list and attaches one reason per person.
 */
async function scanDigest(sql: Sql, now: Date): Promise<MechanicScanReport> {
  const weekKey = digestWeekKey(now.getTime());
  const recipients = await sql<DigestRecipientRow[]>`
    SELECT fp.account_id, pr.id AS profile_id, pr.goals
    FROM followup_preferences fp
    JOIN accounts a ON a.id = fp.account_id AND a.status = 'active'
    JOIN profiles pr ON pr.account_id = fp.account_id
    WHERE fp.digest_opt_in_at IS NOT NULL
      AND (fp.digest_opt_out_at IS NULL OR fp.digest_opt_out_at < fp.digest_opt_in_at)
    ORDER BY fp.digest_opt_in_at
    LIMIT ${DIGEST_ACCOUNT_LIMIT}
  `;

  const catalog = parseCatalog(taxonomyPayload());
  const templates = reasonV4Templates(DEFAULT_LOCALE);
  const labelOf = catalog ? reasonLabelOfV4(catalog, DEFAULT_LOCALE) : null;

  let enqueued = 0;
  for (const recipient of recipients) {
    if (!(await recipientIsReachable(sql, recipient.account_id, 'digest_weekly'))) continue;

    const eventRows = await sql<{ event_id: string }[]>`
      SELECT m.event_id
      FROM event_memberships m
      JOIN profiles p ON p.id = m.profile_id
      WHERE p.account_id = ${recipient.account_id} AND m.state = 'active'
      ORDER BY m.created_at DESC
      LIMIT ${DIGEST_EVENTS_PER_ACCOUNT}
    `;

    const perEvent: DigestCandidate[][] = [];
    for (const event of eventRows) {
      const result = await recommendForEvent(
        sql,
        { accountId: recipient.account_id, profileId: recipient.profile_id },
        event.event_id,
        DIGEST_MAX_PEOPLE,
        'useful',
      );
      perEvent.push(
        result.items.map((item) => ({
          profileId: item.profile_id,
          displayName: item.display_name,
          score: item.score,
          reasonsUseful: item.reasons_useful,
          reasonsGrowth: item.reasons_growth,
        })),
      );
    }

    // «already digested recently» — read from the durable record, not from the
    // outbox (whose payload text is minimized after send).
    const digestedRows = await sql<{ profile_id: string }[]>`
      SELECT DISTINCT profile_id FROM digest_sends
      WHERE account_id = ${recipient.account_id}
        AND sent_at >= ${new Date(digestRepeatWindowStartMs(now.getTime()))}
    `;
    const people = selectDigestPeople(perEvent.flat(), {
      excludedProfileIds: digestedRows.map((r) => r.profile_id),
    });
    // An empty digest is not a message — it is an interruption. Send nothing.
    if (people.length === 0) continue;

    const firstGoal = recipient.goals.find((id) => goalLabel(id, DEFAULT_LOCALE) !== null) ?? null;
    const message = renderDigestMessage({
      locale: DEFAULT_LOCALE,
      goalLabel: firstGoal ? goalLabel(firstGoal, DEFAULT_LOCALE) : null,
      people: people.map((person) => ({
        displayName: person.displayName,
        reason: labelOf ? formatReasonV4(person.reason, templates, labelOf) : '',
      })),
      link: `${baseUrl()}${NOTES_PATH}`,
      unsubscribeLink: `${baseUrl()}${unsubscribePath(recipient.account_id, 'digest', requireHashPepper())}`,
    });

    const created = await sql.begin(async (tx) => {
      const result = await enqueueOutbox(tx, {
        dedupeKey: digestDedupeKey(recipient.account_id, weekKey),
        kind: 'digest_weekly',
        subjectId: recipient.profile_id,
        channel: 'telegram',
        purpose: 'digest_weekly',
        payload: {
          account_id: recipient.account_id,
          event_id: null,
          text: message.text,
          enforce_consent: true,
        },
      });
      if (result.created) {
        for (const person of people) {
          await tx`
            INSERT INTO digest_sends (account_id, profile_id, job_id)
            VALUES (${recipient.account_id}, ${person.profileId}, ${result.id})
          `;
        }
      }
      return result.created;
    });
    if (created) enqueued += 1;
  }

  return { scanned: recipients.length, enqueued };
}

// ---------------------------------------------------------------------------
// Shared send-time-equivalent gates
// ---------------------------------------------------------------------------

/**
 * Gate 3 + 4 for one recipient: is the required consent granted AND is there a
 * channel the message could actually travel on? Deliberately the SAME
 * `decideRecipientChannel` the worker calls at send time — one decision rule, so
 * the scan cannot enqueue something the worker would immediately suppress (or
 * worse, vice versa).
 */
async function recipientIsReachable(
  sql: Sql,
  accountId: string,
  purpose: 'service_channel' | 'digest_weekly',
): Promise<boolean> {
  const consentGranted = await hasGrant(sql, accountId, purpose);
  if (!consentGranted) return false;
  const binding = await loadTelegramBindingState(sql, accountId);
  const hasEmail = binding === null ? (await resolveAccountEmail(sql, accountId, null)) !== null : false;
  const decision = decideRecipientChannel({
    telegramBinding: binding?.state ?? null,
    hasEmail,
    consentGranted,
  });
  return decision.channel !== 'suppress';
}

function baseUrl(): string {
  return appBaseUrl().replace(/\/+$/, '');
}

/** Where a reminder/digest sends the recipient to see the actual content. */
export const NOTES_PATH = '/me/notes';
