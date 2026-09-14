# ADR 0010 — The initiator of an introduction consents by initiating

Status: accepted.

## Context

Introductions were built on a strict two-sided rule: `pending → mutual` only
once BOTH `introduction_consents` rows read `accept`, and `POST
/api/introductions` created the initiator's row as `decision = 'pending'`. So
the person who had just requested an introduction had to answer their own
request — request → "now accept yourself" — and, until they did, the
counterparty's accept changed nothing. The rule was right about reciprocity and
wrong about the initiator: agreeing is exactly what requesting IS.

Two related defects shared the same root — the consent record could not express
WHO agreed and HOW:

1. **Provenance was lost.** `accept` meant both "agreed by requesting" and
   "agreed by answering a request". Neither an auditor nor the UI could tell
   the initiator from the counterparty, and `intro.mutual` alone did not record
   who had initiated.
2. **The end of an introduction was silent and the state was dishonest.** A
   `decline` was masked as `pending` for the requester, so their card said
   "waiting for an answer" forever; a `withdraw` showed them the label
   "withdrawn (by you)". Nothing told the other side the introduction was over,
   and the refusal's reason was never recorded in the first place (nothing to
   leak — but nothing to explain either).

Rejected alternatives:

1. **Keep two accepts, relabel the UI only.** The consent row would keep
   asserting something untrue — that the initiator had not agreed — so the
   audit trail stays ambiguous and a re-accept can never be distinguished from
   a first answer.
2. **Auto-complete on creation.** Removes the counterparty's veto and with it
   the product's central promise: the other side controls its own contact data.
   Reciprocity is not negotiable.
3. **Add only `initiator_profile_id` and fix the copy.** The state machine still
   forces a pointless second call, and the consent table still cannot say how
   the initiator agreed.

## Decision

1. **`introduction_consents.source`** — `'explicit' | 'implicit_by_initiation'`
   (nullable, `DEFAULT 'explicit'`, migration 009). Existing rows are
   backfilled to `'explicit'` because before 009 an `accept` could only come
   from an explicit `/respond`. NULL is tolerated for rows written by the
   pre-009 code path during a rolling deploy, and every reader treats "not
   implicit" as "explicit".

2. **The initiator's consent is written at creation**: `POST /api/introductions`
   inserts `decision = 'accept'`, `source = 'implicit_by_initiation'` in the
   same transaction as the `introductions` row.

3. **Reciprocity is unchanged.** The mutual transition still requires BOTH rows
   to read `accept`; what changed is that the initiator's row already exists, so
   the counterparty's single explicit accept completes it. The `count = 2` CAS
   is untouched, which also keeps legacy two-sided rows correct and keeps the
   exactly-one-winner guarantee under concurrency (AC-32).

4. **An explicit answer always wins.** Every `/respond` (accept, decline,
   withdraw) rewrites the row with `source = 'explicit'`, so a row can never
   keep claiming "agreed by requesting" after the party has answered for
   themselves. The initiator's `/respond` remains valid — they can decline or
   withdraw — it is simply no longer required to reach `mutual`.

5. **The audit trail is mandatory.** `intro.consent_implicit` (intro id,
   initiator profile id) is recorded INSIDE the creating transaction, next to
   the consent row it documents: an implicit consent that is not auditable must
   not exist. `intro.requested` continues to record the request itself, and
   `intro.mutual` remains inside the CAS-winning transaction.

6. **The state is honest; the reason stays private.** `GET
   /api/introductions/[id]` reports the true state to both parties — a decline
   is no longer masked as `pending` — and the card shows neutral wording
   (`declinedOther` / `revokedOther`) to the side that did not answer, because
   "(by you)" is a lie for them. Ending an introduction early enqueues ONE
   neutral notice to the other party through the existing outbox
   (`intro_declined_notice` / `intro_withdrawn_notice`, dedupe key
   `intro_{declined|withdrawn}:<intro>:<account>`): it says only that the
   introduction did not happen. No reason, no blame, no reveal fields, no
   contact values, and not which side answered. Suppression is the worker's
   existing send-time decision and is not duplicated here — a recipient with no
   channel is `no_channel`, a recipient without `service_channel` consent is
   `consent_revoked`, and a block between the parties stops delivery.

## Consequences

- The initiator's card opens in the waiting view (one `Withdraw` action); the
  counterparty sees accept/decline. The reveal rule is untouched: only the
  INTERSECTION of both CURRENT `reveal_fields` is decrypted, and only in
  `mutual`.
- The consent table is now auditable about provenance, and a stale implicit
  claim cannot survive an explicit answer.
- Introductions that end early now reach the other side instead of going
  silent. This is deliberate: the notice carries no reason, so nothing private
  is disclosed, while the previous behaviour — a card stuck on "waiting" for an
  introduction that was already over — was the actual defect. The
  `declineNote` copy was updated in all three locales to match.
- The outbox gains two kinds. `outbox_jobs.kind` has no DB CHECK (the closed
  registry is the `OutboxKind` union in `src/infra/outbox.ts`), so the union is
  the place to extend — done.
- A block still freezes the introduction completely: `respond` returns 403
  `blocked` before any state change, so a blocked pair produces no notice at
  all.
