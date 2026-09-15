# Phase 4 — «next step» reminders + weekly «who to meet» digest

Implementation of `SOCIAL_INTEROP_AND_MATCHING.md` §B5 and §D item 8. Two
mechanics, both **OFF by default**, both opt-in, both revocable — and nothing in
this feature can send a message until a human switches it on.

Sibling documents: the design (`SOCIAL_INTEROP_AND_MATCHING.md` §B5/§C/Part D),
the deploy-order precedent this packet follows
(`evidence/DEPLOY_NOTES_2026-09-15.md`, migrations 010/011), and the copy rules
the messages follow (`spec/WELCOME_TZ_v3.md` §7 «Never claim these without
evidence»).

---

## 1. What the two mechanics are

### 1.1 «Next step» reminder (`followup_reminder`)

A note the user wrote about someone they met has a `next_step`; the reminder says
back what they wrote, once, when it is due.

| Rule | Why |
|---|---|
| **Only the author is ever addressed.** The recipient account is `connection_notes.owner_account_id`; the counterparty is named in the body but is never a recipient. | The note is the author's own; a third party must never learn it exists. |
| **Only a real meeting counts.** `introductions.state = 'mutual'` — the one state in which BOTH sides agreed. A pending/declined/withdrawn/closed/revoked introduction produces nothing. | Design §C + spec §7: a request is not a meeting, and "contacts were exchanged" may not be claimed from a single click. The check matches the pair in **both** directions (introductions store `profile_a`/`profile_b` in canonical order, which has nothing to do with who wrote the note). |
| **Only open steps.** `next_step_status IN ('proposed','confirmed')`; `done` and `dropped` are terminal, and `none` is not a commitment. | Nagging about a finished or abandoned step is how a permission gets revoked. |
| **The clock starts when the step was written** (`connection_notes.updated_at`), and must be at least `FOLLOWUP_REMINDER_DAYS` days ago (default **7**). | The mutual transition has no recorded timestamp, and inventing a meeting date would be a claim the data cannot support (spec §7). Editing the note postpones the reminder, which is the safe direction. |
| **At most one reminder per note per state transition.** The status is part of the idempotency key and is stored in `connection_notes.followup_reminded_status`. | See §4. |
| **Consent: `service_channel`.** | It is a service message about the recipient's own commitment, not marketing. |

Body (Telegram and email carry the same text, rendered by a pure renderer):

```
WELCOME: a next step you saved

You saved a next step after meeting <Name>:
«<the author's own step text>»

Open WELCOME to see it and mark it done: <APP_BASE_URL>/me/notes
Stop these reminders: <APP_BASE_URL>/api/me/followup/unsubscribe?t=reminders.<id>.<hmac>
```

### 1.2 Weekly digest (`digest_weekly`)

Up to three people, chosen from the recipient's own goals and profile, with the
one-line reason the ranking produced.

| Rule | Why |
|---|---|
| **At most 3 people** (`DIGEST_MAX_PEOPLE`). | Design §B5. Not env-configurable: a size knob is a way to turn a nudge into spam. |
| **Candidates come from the existing recommender.** The scan calls `recommendForEvent` per event (≤5 most recent memberships), so the digest inherits the app's server-side eligibility (active membership + `directory_visible` + `matching_enabled` + no block either way + not already introduced + inside the event's intro cooldown). | Reuse, not a second matching path; the frozen v4 core is only *called*. |
| **One reason per person, or the person is dropped.** The line is `reasons_useful[0]`, else `reasons_growth[0]`, rendered with the SAME `reason4.*` i18n templates the app uses. | An unexplained recommendation is exactly the invented claim spec §7 forbids. Corollary: legacy-only (tag) matches have no v4 reason and are therefore **not** digestible. |
| **Excluded: already introduced, blocked** (from the recommender's eligibility), **already digested in the last 28 days** (`DIGEST_REPEAT_WINDOW_DAYS`, from `digest_sends`). | Design §B5 + the task's exclusion list. |
| **One digest per recipient per ISO week**, UTC (`digest:<account>:<YYYY-Www>`). | The weekly cadence is an idempotency key, not a schedule: the daily cron may run 7 times a week and only the first tick enqueues. |
| **Empty digest ⇒ no message at all.** | A message with nothing in it is an interruption. |
| **Consent: `digest_weekly`**, written together with the opt-in by the same endpoint. | So the message's one-click unsubscribe can revoke exactly this purpose and nothing else. |

Body (same for both channels; `{goal}` is the recipient's OWN top goal):

```
WELCOME: your weekly digest

Chosen from your own goals and your own profile. This is a suggestion, not a promise — what happens next is up to you.

Your goal: <goal>
1. <Name> — <one-line reason>
2. <Name> — <one-line reason>

Open WELCOME: <APP_BASE_URL>/me/notes
Stop the weekly digest: <APP_BASE_URL>/api/me/followup/unsubscribe?t=digest.<id>.<hmac>
```

**What the text can never contain** — held by the renderers' input types, not by
discipline: no contact values, no other person's goals, no note text of another
person, no score, no percentage, no outcome claim. The only number in the digest
is the length of the recipient's own list. `tests/unit/digest-domain.test.ts` and
`tests/integration/followup-digest.test.ts` assert this with fixtures whose
private data is proven to be present in the database and absent from the body.

---

## 2. Flags and their default

Both features **do not exist** unless explicitly switched on. Absent, empty,
`false`, `FALSE`, `0`, `yes`, `TRUE`, `" true"` — everything except the exact
string `true` means off, and that is unit-tested.

| Variable | Default | Effect when off |
|---|---|---|
| `FOLLOWUP_REMINDERS_ENABLED` | *unset* → off | no reminder scan, no job, no switch, `GET/POST /api/me/followup` answers `404 feature_disabled` for this mechanic, and any job already queued is **suppressed at send time** with `feature_disabled`. |
| `DIGEST_ENABLED` | *unset* → off | same, for the digest. |
| `FOLLOWUP_REMINDER_DAYS` | `7` | days between writing a step and its reminder. Ignored unless the reminders flag is on. An unparsable, fractional, zero, negative or absurd (>365) value falls back to the default rather than clamping to something that would fire at once. |

Both flags are read at every call site (never captured at module load), so
turning one off takes effect on the very next tick, for new **and** already
queued jobs. There is no per-mechanic "dry run" mode: off is off.

---

## 3. Consent semantics (and how they differ from the opt-in)

Two independent gates, both required, both fail-closed:

| | Consent (`consent_events`) | Opt-in (`followup_preferences`) |
|---|---|---|
| Answers | "is this class of message allowed at all?" | "did this person ask for THIS mechanic?" |
| Storage | append-only, purpose-scoped, policy-versioned | two timestamps per mechanic (in / out) |
| Read as | latest record per (purpose, scope) wins | `opt_in_at IS NOT NULL AND (opt_out_at IS NULL OR opt_out_at < opt_in_at)` |
| Purpose | `service_channel` (reminder) / `digest_weekly` (digest) | `reminders` / `digest` |
| Written by | `POST /api/consents`, the follow-up endpoint, the one-click link | the follow-up endpoint, the one-click link |

`digest_weekly` is registered exactly like the six existing purposes
(`src/domain/consent.ts` + the `consent_events_purpose_check` CHECK widened by
migration 012), so the existing machinery does the rest. It is **not** in the
`/me/privacy` toggle list: the follow-up card on `/me/notes` is the one surface
that writes both halves together, and a consent granted through any other path
cannot by itself cause a message (the opt-in gate still fails — the safe
direction).

The reminder opt-in deliberately does **not** grant `service_channel` (a narrow
«remind me» switch must not also unlock introduction notices). The switch is
rendered **disabled with the reason** while that consent is missing, instead of
silently doing nothing.

### What happens to a queued message when consent is revoked

Both revocation paths — the in-app switch and the one-click link — run the same
transaction:

1. opt-in timestamp pair updated (audit: `followup.opt_in` / `followup.opt_out`);
2. for the digest, a `digest_weekly` **withdraw** consent event;
3. **suppression of everything already queued**: the digest through the existing
   `suppressJobsForConsent` → `suppressJobsForAccountPurpose` hook, the reminder
   through `suppressJobsForAccountKinds` (kind-scoped, so stopping reminders
   cannot silence introduction notices that share `service_channel`).

A job that was already handed to a transport is **not** retracted — a delivered
message is not un-sent (spec 04 §7). Everything still `pending` or `leased`
becomes terminal `suppressed`, and the send-time re-check is the second,
independent guarantee: `processOutbound` re-reads the flag, the opt-in and the
consent for these two kinds before any transport call.

---

## 4. Caps and idempotency keys

| Mechanic | Key | Guarantee |
|---|---|---|
| Reminder | `followup:<ownerAccountId>:<otherProfileId>:<status>` | `UNIQUE(dedupe_key)` on `outbox_jobs` + `connection_notes.followup_reminded_status`. One reminder per note per state transition. A note returning to a status it was already reminded about is **not** reminded again (a deliberately stricter reading of the cap), and the bookkeeping column is only written when the insert actually created a row. |
| Digest | `digest:<accountId>:<YYYY-Www>` | One digest per account per ISO week, UTC. |

Running the same tick twice therefore inserts nothing the second time — proven
in `tests/integration/followup-digest.test.ts` ("the first tick enqueues exactly
one reminder and one digest; the second enqueues nothing").

Per-tick work is bounded so a scheduled tick stays inside a serverless function
budget: 25 notes, 25 recipients, 5 events per recipient. A backlog drains over
several ticks — the alternative would be one unbounded query in a cron.

---

## 5. Operator steps

### 5.1 Applying to an environment

1. **Apply migration `012_followup_reminders_digest.sql` BEFORE deploying the
   code** (same rule as 010/011 — see `evidence/DEPLOY_NOTES_2026-09-15.md`):
   ```
   DATABASE_URL=<direct connection> node scripts/migrate.mjs
   ```
   The migration is purely additive and idempotent (`IF NOT EXISTS` /
   `DROP CONSTRAINT IF EXISTS` + re-add). Symptom when it is missing: the notes
   page and `GET/POST /api/me/followup` return `500 internal_error` with
   `relation "followup_preferences" does not exist` (Postgres `42P01`) in the
   server log, and public pages keep working.
2. Deploy the code with **both flags unset**. Nothing is scanned, nothing is
   enqueued, no switch is rendered, the endpoint answers 404. Verify:
   ```
   curl -H "x-worker-tick-secret: $WORKER_TICK_SECRET" -X POST $APP_BASE_URL/api/internal/worker-tick
   # → "followup": { "enabled": { "reminders": false, "digest": false },
   #                "reminders": {...0}, "digest": {...0}, "error": null }
   ```
3. To enable one mechanic, set its flag on the deployment and let the next
   scheduled tick run (`vercel.json`: daily at 03:17 UTC). Recommended order:
   `FOLLOWUP_REMINDERS_ENABLED=true` first (it addresses the user's own
   commitment), then `DIGEST_ENABLED=true` once a few recipients have opted in
   from `/me/notes`.
4. To disable: unset the flag. Queued jobs of that mechanic are suppressed at
   send time from that moment on; nothing else changes.
5. `FOLLOWUP_REMINDER_DAYS` only needs setting if the default week is wrong for
   the current cohort — never below 1 day.

### 5.2 Individual user consent

- Opt in at **`/me/notes` → Follow-up messages** (off by default, both switches
  with a one-line explanation of what each contains, plus "how to stop").
- **Stop** from the switch, or from the stop link at the end of any message
  (one click, no sign-in, works even if the mechanic's flag is later turned off).
- The reminder switch requires *service messages* to be allowed; the response
  carries `consent.service_channel` and the UI shows the dependency.

### 5.3 What to look at when something is wrong

| Symptom | Where to look |
|---|---|
| `followup.enabled.*` false in the tick response | the flag is not set on that environment (this is the default, not a bug) |
| `followup.error` non-null | the scan threw (migration 012 missing is the first suspect); the outbox batch of that tick still ran — a failed scan never blocks deliveries |
| A digest was never sent for an opted-in account | no eligible candidate with a v4 reason (legacy tag matches are not digestible), no channel, consent missing, or the week key already used |
| A reminder never sent | introduction not `mutual`, status `done`/`dropped`/`none`, fewer than `FOLLOWUP_REMINDER_DAYS` days, or `followup_reminded_status` already equals the current status |
| A job is `suppressed` | `delivery_attempts.code`: `feature_disabled`, `opt_in_withdrawn`, `consent_revoked`, `no_channel`, `channel_revoked`, `blocked` |

`delivery_attempts` holds state/code only; the message body is stripped from the
job payload once a provider accepts it (`applyOutcome` drops `payload - 'text'`),
so the digest names and the author's step text do not outlive the send.

---

## 6. Files

| Path | What |
|---|---|
| `db/migrations/012_followup_reminders_digest.sql` | purpose CHECK + opt-in bookkeeping + `digest_sends` + "already reminded" columns |
| `src/domain/followup.ts` | pure reminder selection, dedupe key, copy, unsubscribe token |
| `src/domain/digest.ts` | pure digest selection (≤3, exclusions, one line each), week key, copy |
| `src/domain/consent.ts` | `digest_weekly` in the purpose registry |
| `src/infra/followup-scan.ts` | the worker step that scans and enqueues (gates, caps, dedupe keys) |
| `src/infra/followup-preferences.ts` | opt-in read/write + audit |
| `src/infra/outbox.ts` | the two kinds, `suppressJobsForAccountKinds` |
| `src/infra/worker.ts` | scan in the tick, send-time flag/opt-in gates, email rendering for the two kinds |
| `src/app/api/me/followup/route.ts` | opt-in/opt-out (404 while disabled) |
| `src/app/api/me/followup/unsubscribe/route.ts` | one-click stop without a session |
| `src/app/me/notes/followup-toggles.tsx` + `page.tsx` | the Follow-up card |
| `src/i18n/{en,ru,es}.ts` | `followup.*` copy (EN is the reference; parity is enforced) |
| `src/i18n/reason-templates.ts` | `reason4.*` templates for a background process (no `next/headers`) |
| `tests/unit/followup-domain.test.ts`, `tests/unit/digest-domain.test.ts` | pure rules + copy honesty |
| `tests/integration/followup-digest.test.ts` | flags off/on, one-tick vs two-tick, revocation, blocks, purposes, privacy |
| `tests/e2e/followup.spec.ts` | the switch in the UI: round-trip, persistence, absent when the flag is off |
