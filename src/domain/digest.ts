import { DEFAULT_LOCALE, type Locale } from '../i18n/locale';
import type { ReasonV4 } from './reasons-v4';

/**
 * Weekly «who to meet» digest — the PURE half of the second Phase-4 follow-up
 * mechanic (docs-internal/product/SOCIAL_INTEROP_AND_MATCHING.md §B5 + §D item
 * 8: «мягкий недельный дайджест (по согласию): 3 человека, полезных для твоей
 * цели X»).
 *
 * This module ranks nothing and reads nothing: the candidates arrive already
 * scored by the FROZEN v4 layer (`rankCandidates` via recommendForEvent), so the
 * digest inherits exactly the app's matching behaviour instead of growing a
 * second one. What lives here is the part the design makes non-negotiable:
 *
 *   - at most `DIGEST_MAX_PEOPLE` (3) people, ever;
 *   - everyone excluded who is already introduced (the caller's eligibility
 *     query handles that), blocked (same), or was recently in a previous digest
 *     (this module, from the caller's history);
 *   - ONE reason per person, taken from the v4 reason the ranking produced — a
 *     person the ranking cannot explain is dropped, because an unexplained
 *     recommendation is exactly the invented claim spec §7 forbids;
 *   - deterministic order, so a re-run of the same week cannot reorder the list.
 *
 * PRIVACY (design §C «нерушимо»): the only fields this module can see are the
 * candidate's directory-visible display name, the frozen v4 reason codes, and
 * the recipient's own goal label. Another person's goals, notes, contact values
 * or scores are not parameters of anything here — they cannot leak into the
 * message by accident, and tests/unit/digest-domain.test.ts proves it.
 *
 * No DB access: the scan (src/infra/followup-scan.ts) loads rows and passes them
 * in.
 */

/** Hard cap of the design §B5 («3 человека»). Not env-configurable on purpose:
 *  a digest is a nudge, and a configurable size is a way to turn it into spam. */
export const DIGEST_MAX_PEOPLE = 3;

/**
 * Someone already digested this recently is skipped for this long, so the same
 * three faces cannot be re-sent week after week. A window (rather than "ever")
 * keeps the digest useful once a person becomes relevant again.
 */
export const DIGEST_REPEAT_WINDOW_DAYS = 28;

const MS_PER_DAY = 86_400_000;

/** Epoch ms before which a digested person must not be digested again. */
export function digestRepeatWindowStartMs(nowMs: number): number {
  return nowMs - DIGEST_REPEAT_WINDOW_DAYS * MS_PER_DAY;
}

/** One already-ranked candidate, in the shape the v4 layer plus the directory
 *  query produce. `score` is the frozen usefulness score, echoed for ordering. */
export interface DigestCandidate {
  readonly profileId: string;
  readonly displayName: string;
  readonly score: number;
  readonly reasonsUseful: readonly ReasonV4[];
  readonly reasonsGrowth: readonly ReasonV4[];
}

export interface DigestPerson {
  readonly profileId: string;
  readonly displayName: string;
  /** The single sentence the message shows next to the name. */
  readonly reason: ReasonV4;
  readonly score: number;
}

/**
 * Merges the per-event recommendation lists of ONE recipient into a single
 * candidate pool: a person who shares more than one event with the viewer
 * appears once, keeping the best score the frozen layer gave them. Sorted by
 * score (desc) then profile id, so the merge itself is order-independent.
 */
export function mergeDigestCandidates(
  lists: readonly (readonly DigestCandidate[])[],
): DigestCandidate[] {
  const byProfile = new Map<string, DigestCandidate>();
  for (const list of lists) {
    for (const candidate of list) {
      if (typeof candidate?.profileId !== 'string' || candidate.profileId.length === 0) continue;
      const current = byProfile.get(candidate.profileId);
      if (!current || candidate.score > current.score) byProfile.set(candidate.profileId, candidate);
    }
  }
  return [...byProfile.values()].sort((a, b) =>
    b.score !== a.score ? b.score - a.score : a.profileId < b.profileId ? -1 : a.profileId > b.profileId ? 1 : 0,
  );
}

/**
 * The one line the recipient reads next to a name. Line 1 («Польза», what this
 * person does for the viewer's goal) is what the design's digest is about, so it
 * wins; a growth-only reason (what the viewer could learn or give) is the honest
 * fallback. `null` means the v4 layer had nothing to say — drop the person.
 */
export function oneLineReason(candidate: DigestCandidate): ReasonV4 | null {
  return candidate.reasonsUseful[0] ?? candidate.reasonsGrowth[0] ?? null;
}

export interface SelectDigestOptions {
  /** People already sent to this recipient inside the repeat window. */
  readonly excludedProfileIds?: readonly string[];
  readonly limit?: number;
}

/**
 * The digest of one recipient: at most `limit` (default 3) people, each with the
 * one reason that explains them. Returns `[]` when nothing qualifies — the
 * caller then sends NOTHING, because an empty digest is not a message, it is an
 * interruption.
 */
export function selectDigestPeople(
  candidates: readonly DigestCandidate[],
  options: SelectDigestOptions = {},
): DigestPerson[] {
  const excluded = new Set(options.excludedProfileIds ?? []);
  const rawLimit = options.limit ?? DIGEST_MAX_PEOPLE;
  const limit = Math.max(0, Math.min(DIGEST_MAX_PEOPLE, Math.floor(rawLimit)));
  if (limit === 0) return [];

  const people: DigestPerson[] = [];
  for (const candidate of mergeDigestCandidates([candidates])) {
    if (people.length >= limit) break;
    if (excluded.has(candidate.profileId)) continue;
    const reason = oneLineReason(candidate);
    if (!reason) continue;
    people.push({
      profileId: candidate.profileId,
      displayName: candidate.displayName,
      reason,
      score: candidate.score,
    });
  }
  return people;
}

// ---------------------------------------------------------------------------
// Cadence
// ---------------------------------------------------------------------------

/**
 * ISO-8601 week key in UTC (`2026-W38`). The weekly cadence is expressed as an
 * idempotency key rather than a schedule: the daily worker tick may run many
 * times in a week, and the UNIQUE dedupe key makes exactly the first of them
 * enqueue. ISO weeks are used so the key is stable across DST and across a tick
 * that lands at 00:10 on a Monday.
 */
export function digestWeekKey(nowMs: number): string {
  const date = new Date(nowMs);
  const thursday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNumber = thursday.getUTCDay() === 0 ? 7 : thursday.getUTCDay();
  thursday.setUTCDate(thursday.getUTCDate() + 4 - dayNumber);
  const isoYear = thursday.getUTCFullYear();
  const yearStart = Date.UTC(isoYear, 0, 1);
  const week = Math.ceil(((thursday.getTime() - yearStart) / MS_PER_DAY + 1) / 7);
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

/** One digest per account per ISO week — the whole weekly cadence. */
export function digestDedupeKey(accountId: string, weekKey: string): string {
  return `digest:${accountId}:${weekKey}`;
}

// ---------------------------------------------------------------------------
// Copy (spec §7: no invented outcomes, no promises, no numbers of our own)
// ---------------------------------------------------------------------------
//
// The body is built from a CLOSED input: the recipient's own goal label, the
// directory-visible names the v4 layer ranked for them, and the already-rendered
// one-line reasons (rendered with the app's own `reason4.*` templates, so the
// message and the app cannot drift apart). There is no field for contact values,
// for another person's goals, or for any statistic — nothing to forget to strip.
//
// The body also has to SAY that the recommendations come from the recipient's
// own goals; that sentence is part of the copy, not the caller's business.

interface DigestCopy {
  readonly subject: string;
  readonly body: string;
}

const DIGEST_COPY: Record<Locale, DigestCopy> = {
  en: {
    subject: 'WELCOME: your weekly digest',
    body:
      'Chosen from your own goals and your own profile. This is a suggestion, not a promise — what happens next is up to you.\n\n' +
      '{goal}{people}\n\nOpen WELCOME: {link}\nStop the weekly digest: {unsubscribe}\n',
  },
  ru: {
    subject: 'WELCOME: недельный дайджест',
    body:
      'Подобрано по вашим целям и вашему профилю. Это подсказка, а не обещание — что будет дальше, решаете вы.\n\n' +
      '{goal}{people}\n\nОткрыть WELCOME: {link}\nОтключить недельный дайджест: {unsubscribe}\n',
  },
  es: {
    subject: 'WELCOME: tu resumen semanal',
    body:
      'Elegido a partir de tus propios objetivos y de tu perfil. Es una sugerencia, no una promesa: lo que pase después lo decides tú.\n\n' +
      '{goal}{people}\n\nAbrir WELCOME: {link}\nDesactivar el resumen semanal: {unsubscribe}\n',
  },
};

const GOAL_LINE: Record<Locale, string> = {
  en: 'Your goal: {goal}\n',
  ru: 'Ваша цель: {goal}\n',
  es: 'Tu objetivo: {goal}\n',
};

export interface DigestMessagePerson {
  readonly displayName: string;
  /** The one-line reason, already rendered in `locale` by the caller. */
  readonly reason: string;
}

export interface DigestMessageInput {
  readonly locale: Locale;
  /** The RECIPIENT's own top goal, already localized; null when none is set. */
  readonly goalLabel: string | null;
  readonly people: readonly DigestMessagePerson[];
  readonly link: string;
  readonly unsubscribeLink: string;
}

/**
 * Renders the digest for either channel. `locale` defaults to the product
 * default for the same documented reason as the reminder copy (no per-account
 * locale is stored server-side). An empty `people` list renders the derivation
 * sentence alone — callers must not enqueue such a message (see the scan).
 */
export function renderDigestMessage(input: DigestMessageInput): OutboundMessage {
  const locale = DIGEST_COPY[input.locale] ? input.locale : DEFAULT_LOCALE;
  const copy = digestCopy(locale);
  const goal = flat(input.goalLabel ?? '', 120);
  return {
    subject: copy.subject,
    text: substitute(copy.body, {
      goal: goal.length > 0 ? substitute(GOAL_LINE[locale], { goal }) : '',
      people: renderPeople(input.people),
      link: input.link,
      unsubscribe: input.unsubscribeLink,
    }),
  };
}

/** The subject alone, for the email channel (see reminderSubject). */
export function digestSubject(locale: Locale = DEFAULT_LOCALE): string {
  return digestCopy(locale).subject;
}

function digestCopy(locale: Locale): DigestCopy {
  return DIGEST_COPY[locale] ?? DIGEST_COPY[DEFAULT_LOCALE];
}

/**
 * Numbered lines; a candidate whose reason resolves to nothing is not printed at
 * all, and the numbering follows the PRINTED lines — a list that starts at "2."
 * because an entry was dropped would read as a bug in the recipient's inbox.
 */
function renderPeople(people: readonly DigestMessagePerson[]): string {
  const lines: string[] = [];
  for (const person of people) {
    const name = flat(person.displayName, 120);
    const reason = flat(person.reason, 200);
    if (name.length === 0 || reason.length === 0) continue;
    lines.push(`${lines.length + 1}. ${name} — ${reason}`);
  }
  return lines.join('\n');
}

/** Subject + plain-text body, the shape both channels render (same as
 *  NoticeEmail in src/domain/service-notices.ts) — deliberately NOT the outbox
 *  payload: the scan passes it through, it never becomes a stored private field. */
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
