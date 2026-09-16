import { DEFAULT_LOCALE, type Locale } from '../i18n/locale';
import { hmacHex, timingSafeHexEqual } from '../lib/crypto';

/**
 * «Next step» reminder — the PURE half of the first Phase-4 follow-up mechanic
 * (docs-internal/product/SOCIAL_INTEROP_AND_MATCHING.md §B5 + §D item 8).
 *
 * The design says: a note with a «next step» gets a reminder of «что ты хотел
 * сделать» N days later. Four rules make that safe, and every one of them lives
 * in this file rather than in SQL, so a unit test can prove it:
 *
 *   1. ONLY the author is ever addressed. A reminder exists for the account that
 *      wrote its OWN next_step; the counterparty is mentioned in the body but is
 *      never a recipient (see selectDueReminders + the scan's account_id).
 *   2. ONLY a step that actually happened. `introductionMutual` is derived from
 *      `introductions.state = 'mutual'` — the only state in which BOTH sides
 *      agreed. Spec §7 forbids claiming "contacts were exchanged" from a single
 *      request, so a pending/declined/revoked/closed introduction produces no
 *      reminder at all.
 *   3. `done`/`dropped` are terminal: nagging about a step the user finished or
 *      abandoned is the fastest way to lose the right to send anything.
 *   4. At most ONE reminder per note per state transition: the status the note
 *      was already reminded about is part of the dedupe key AND of the stored
 *      bookkeeping (connection_notes.followup_reminded_status).
 *
 * No DB access here. The scan (src/infra/followup-scan.ts) loads rows and passes
 * them in; this module only decides.
 */

/** The two mechanics of Phase 4 — also the opt-in pairs in followup_preferences. */
export type FollowupMechanic = 'reminders' | 'digest';

/** The `connection_notes.next_step_status` machine (migration 001 CHECK). */
export const NEXT_STEP_STATUSES = ['none', 'proposed', 'confirmed', 'done', 'dropped'] as const;
export type NextStepStatus = (typeof NEXT_STEP_STATUSES)[number];

/**
 * The only statuses a reminder may be about — the step is set and still open.
 * `none` is excluded on purpose: a note with text but no declared step is not a
 * commitment, and reminding about it would invent one (spec §7).
 */
export const REMINDABLE_STATUSES = ['proposed', 'confirmed'] as const;
export type RemindableStatus = (typeof REMINDABLE_STATUSES)[number];

export function isRemindableStatus(value: unknown): value is RemindableStatus {
  return typeof value === 'string' && (REMINDABLE_STATUSES as readonly string[]).includes(value);
}

const MS_PER_DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Opt-in bookkeeping (followup_preferences, migration 012)
// ---------------------------------------------------------------------------

/**
 * The single reading of "is this mechanic opted in": the freshest of the two
 * timestamps wins, so re-opting in after an opt-out works and a later opt-out
 * always beats an earlier opt-in. Absent opt-in is NOT opted in — both mechanics
 * are off for every account that never asked, which is what makes the whole
 * feature inert by default on top of the env flags.
 */
export function isOptedIn(optInAt: Date | null, optOutAt: Date | null): boolean {
  if (!optInAt) return false;
  if (!optOutAt) return true;
  return optOutAt.getTime() < optInAt.getTime();
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/** One loaded note row, already joined against the introduction state. */
export interface FollowupNoteInput {
  /** The note's author — the ONLY possible recipient. */
  readonly ownerAccountId: string;
  readonly otherProfileId: string;
  /** Display name of the person the step is about. Shown in the body only. */
  readonly otherDisplayName: string;
  readonly nextStep: string | null;
  readonly nextStepStatus: string;
  /** Epoch ms of connection_notes.updated_at — when the step was last written. */
  readonly stepSetAtMs: number;
  /** True when an introduction between the two profiles reached 'mutual'. */
  readonly introductionMutual: boolean;
  /** connection_notes.followup_reminded_status — the transition already reminded. */
  readonly remindedStatus: string | null;
}

export interface DueReminder {
  readonly ownerAccountId: string;
  readonly otherProfileId: string;
  readonly otherDisplayName: string;
  readonly nextStep: string;
  readonly status: RemindableStatus;
  readonly dedupeKey: string;
}

/**
 * Stable idempotency key: one reminder per note per state transition.
 *
 * The status is part of the key, which makes "at most one" a UNIQUE-constraint
 * property of `outbox_jobs` rather than a race-prone read-then-write. A note
 * that returns to a status it was already reminded about is NOT reminded twice —
 * a deliberately stricter reading of the cap (a second reminder for a repeated
 * transition would be indistinguishable from nagging).
 */
export function followupReminderDedupeKey(
  ownerAccountId: string,
  otherProfileId: string,
  status: RemindableStatus,
): string {
  return `followup:${ownerAccountId}:${otherProfileId}:${status}`;
}

export interface SelectRemindersOptions {
  readonly nowMs: number;
  /** Days that must have passed since the step was written (default from env). */
  readonly days: number;
}

/**
 * The due reminders of one scan, deterministic and total: the same input always
 * produces the same list in the same order (the scan enqueues in that order, so
 * two ticks of an idempotent system cannot disagree).
 */
export function selectDueReminders(
  notes: readonly FollowupNoteInput[],
  options: SelectRemindersOptions,
): DueReminder[] {
  const thresholdMs = options.days * MS_PER_DAY;
  const due: DueReminder[] = [];

  for (const note of notes) {
    if (!isRemindableStatus(note.nextStepStatus)) continue;
    const step = (note.nextStep ?? '').trim();
    if (step.length === 0) continue;
    if (note.introductionMutual !== true) continue;
    // A missing/unparsable timestamp is "not due", never "due immediately".
    if (!Number.isFinite(note.stepSetAtMs) || note.stepSetAtMs <= 0) continue;
    if (options.nowMs - note.stepSetAtMs < thresholdMs) continue;
    // One reminder per (note, state transition).
    if (note.remindedStatus === note.nextStepStatus) continue;
    due.push({
      ownerAccountId: note.ownerAccountId,
      otherProfileId: note.otherProfileId,
      otherDisplayName: note.otherDisplayName,
      nextStep: step,
      status: note.nextStepStatus,
      dedupeKey: followupReminderDedupeKey(note.ownerAccountId, note.otherProfileId, note.nextStepStatus),
    });
  }

  due.sort((a, b) => {
    if (a.ownerAccountId !== b.ownerAccountId) return a.ownerAccountId < b.ownerAccountId ? -1 : 1;
    return a.otherProfileId < b.otherProfileId ? -1 : a.otherProfileId > b.otherProfileId ? 1 : 0;
  });
  return due;
}

// ---------------------------------------------------------------------------
// Copy (spec §7: no invented outcomes, no promises, no third-party data)
// ---------------------------------------------------------------------------
//
// Message bodies live here, as plain-text COPY per locale, exactly like the
// intro notices in src/domain/service-notices.ts — the UI strings live in the
// i18n dictionaries, but an outbound body is not a UI string and is kept next
// to the rule that produces it. The renderer takes a closed input type and
// nothing else: there is no parameter through which a contact value, the
// counterparty's private data or any number other than the recipient's own
// could reach the text.
//
// The body is the recipient's OWN data going back to its author: their own step
// text, and the name of a person they already met (directory-visible, and shown
// to them in the app anyway). No other person is ever messaged about this note.

interface ReminderCopy {
  readonly subject: string;
  readonly body: string;
}

const REMINDER_COPY: Record<Locale, ReminderCopy> = {
  en: {
    subject: 'WELCOME: a next step you saved',
    body: 'You saved a next step after meeting {name}:\n«{step}»\n\nOpen WELCOME to see it and mark it done: {link}\nStop these reminders: {unsubscribe}\n',
  },
  ru: {
    subject: 'WELCOME: следующий шаг, который вы записали',
    body: 'После знакомства с {name} вы записали следующий шаг:\n«{step}»\n\nОткройте WELCOME, чтобы посмотреть и отметить: {link}\nОтключить эти напоминания: {unsubscribe}\n',
  },
  es: {
    subject: 'WELCOME: un próximo paso que guardaste',
    body: 'Después de conocer a {name} guardaste un próximo paso:\n«{step}»\n\nAbre WELCOME para verlo y marcarlo: {link}\nDesactivar estos recordatorios: {unsubscribe}\n',
  },
};

export interface ReminderMessageInput {
  readonly locale: Locale;
  readonly counterpartyName: string;
  readonly nextStep: string;
  readonly link: string;
  readonly unsubscribeLink: string;
}

export interface OutboundMessage {
  readonly subject: string;
  readonly text: string;
}

/** One-line-safe value: whitespace collapsed, length bounded. */
function flat(value: string, maxLength: number): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length > maxLength ? `${collapsed.slice(0, maxLength - 1)}…` : collapsed;
}

function substitute(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => vars[key] ?? match);
}

/**
 * Renders the reminder for either channel. `locale` defaults to the product
 * default because the WORKER does not read the recipient's stored language: a
 * durable per-account preference has existed since migration 014
 * (`accounts.locale`, src/i18n/README.md), but this module is a pure renderer
 * and its only caller (src/infra/worker.ts) passes DEFAULT_LOCALE. Honouring the
 * column outbound is a behaviour change with its own copy and tests, so it is
 * deliberately left for a separate change — recorded as a known gap, not an
 * oversight.
 */
export function renderReminderMessage(input: ReminderMessageInput): OutboundMessage {
  return {
    subject: reminderSubject(input.locale),
    text: substitute(reminderCopy(input.locale).body, {
      name: flat(input.counterpartyName, 120) || '—',
      step: flat(input.nextStep, 300),
      link: input.link,
      unsubscribe: input.unsubscribeLink,
    }),
  };
}

/**
 * The subject alone, for the email channel: the worker picks a subject for a
 * stored job by KIND (the payload stores the body, and the subject of a service
 * message carries no recipient data worth duplicating into a row that outlives
 * the send).
 */
export function reminderSubject(locale: Locale = DEFAULT_LOCALE): string {
  return reminderCopy(locale).subject;
}

function reminderCopy(locale: Locale): ReminderCopy {
  return REMINDER_COPY[locale] ?? REMINDER_COPY[DEFAULT_LOCALE];
}

// ---------------------------------------------------------------------------
// One-click unsubscribe (email-safe: no session, no login)
// ---------------------------------------------------------------------------
//
// The link has to work from a mailbox, so it cannot carry a session cookie. It
// carries an HMAC over (mechanic, account id) instead: unforgeable without
// HASH_PEPPER, stable (nothing to store or expire), and it names no email
// address — the token is the only thing in the URL. Revoking through it goes
// down the SAME path as the in-app toggle, so queued jobs are suppressed
// identically.

/** Opaque but verifiable token: `<mechanic>.<accountId>.<hmac>`. */
export function unsubscribeToken(accountId: string, mechanic: FollowupMechanic, pepper: string): string {
  return `${mechanic}.${accountId}.${hmacHex(unsubscribeSignatureInput(accountId, mechanic), pepper)}`;
}

/** The route a token is valid for. Kept beside the token so a message can never
 *  carry a link the handler would not verify. */
export const UNSUBSCRIBE_ROUTE_PATH = '/api/me/followup/unsubscribe';

/** Ready-to-paste relative URL for a message body (the scan prepends the host). */
export function unsubscribePath(accountId: string, mechanic: FollowupMechanic, pepper: string): string {
  return `${UNSUBSCRIBE_ROUTE_PATH}?t=${encodeURIComponent(unsubscribeToken(accountId, mechanic, pepper))}`;
}

export interface UnsubscribeTokenPayload {
  readonly accountId: string;
  readonly mechanic: FollowupMechanic;
}

/**
 * Verifies a token in constant time and returns what it authorizes. Any
 * malformed or mismatched token returns null — the caller answers with the same
 * generic "link is not valid" page it shows for an unknown account, so the
 * endpoint cannot be used to probe which accounts exist.
 */
export function verifyUnsubscribeToken(token: string | null, pepper: string): UnsubscribeTokenPayload | null {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [mechanic, accountId, signature] = parts as [string, string, string];
  if (mechanic !== 'reminders' && mechanic !== 'digest') return null;
  if (!/^[0-9a-f-]{36}$/i.test(accountId)) return null;
  const expected = hmacHex(unsubscribeSignatureInput(accountId, mechanic), pepper);
  if (!timingSafeHexEqual(signature, expected)) return null;
  return { accountId, mechanic };
}

function unsubscribeSignatureInput(accountId: string, mechanic: FollowupMechanic): string {
  return `followup-unsubscribe:${mechanic}:${accountId}`;
}
