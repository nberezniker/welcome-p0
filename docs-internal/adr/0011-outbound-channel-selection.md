# ADR 0011 — Outbound channel selection: email as a second delivery channel

Status: accepted.

## Context

Every outbound notification went through one channel. The outbox worker looked up
`channel_bindings` for `provider = 'telegram'` and, when there was no row, closed
the job as `suppressed:no_channel` — a documented, honest outcome ("recipients
without any channel are never emailed", spec S08). The consequence was that a
participant who claimed an imported registration (so WELCOME *does* hold their
address, encrypted) but never linked Telegram could never be notified at all:
not about an introduction request, not about a mutual match, not about their own
event's logistics. The organizer's `service_channel` campaigns had the same hole.

Resend has been wired to production since F-01 (`src/integrations/email/`) and
the login email of an account is deliberately NOT stored in plaintext — only its
peppered lookup hash. The one place an account's own address exists in a
decryptable form is `registrations.encrypted_email` on a registration the account
CLAIMED: `event_memberships.registration_id` is set only by the claim route,
which first proves `accounts.email_lookup_hash = registrations.email_lookup_hash`
(AC-08). That is the only address WELCOME can honestly attribute to an account,
and therefore the only one usable for a push.

## Decision

1. **`email` becomes a channel of the outbox worker**, selected at SEND time from
   live state — the same philosophy as the other send-time preconditions. A
   frozen queue entry never decides the channel; the state at hand does.

   | Telegram binding | Address on file | Consent for the job's purpose | Outcome |
   |---|---|---|---|
   | `active` | — | granted / not required | **telegram** |
   | `active` | — | not granted | `suppressed:consent_revoked` |
   | `revoked` | — | — | `suppressed:channel_revoked` |
   | `blocked` | — | — | `suppressed:channel_blocked` |
   | absent | yes | granted / not required | **email** |
   | absent | yes | not granted | `suppressed:consent_revoked` |
   | absent | no | — | `suppressed:no_channel` |

   The order is deliberate. Consent is evaluated only where a channel would
   otherwise be usable, so a recipient with neither a binding nor an address keeps
   the historical `no_channel` code instead of being reported as a consent
   problem — the existing assertions on that code (introductions, campaigns,
   outbox) stay literally true.

2. **Consent is the job's own purpose, never a generic "ok to email".** The intro
   notices are `service_channel`; a campaign is gated by its own purpose
   (`organizer_marketing` **or** `service_channel`). `service_channel` consent is
   never a substitute for `organizer_marketing` consent, and vice versa: an
   organizer campaign that only holds a service-channel grant is suppressed.

3. **A revoked or blocked binding is terminal.** `/stop` and "block the bot" mean
   stop. Re-routing a message to another channel behind the user's back would
   defeat the opt-out and is never done; only the *absence* of a binding is a
   candidate for the email channel.

4. **Email content is generated from the job KIND, not from the payload text.**
   `src/domain/service-notices.ts` renders the four intro notices from the kind +
   `APP_BASE_URL`, with no parameter through which a name, a contact value, a
   reason or a count could enter. The Telegram bodies stay what they are (the
   "requested" one names the initiator — it is read in a chat the recipient opted
   into); an email is forwardable, indexable and readable on a lock screen, so it
   says only that something happened and links into the app. Campaign bodies are
   the organizer's own `body_text`, verbatim, exactly as on Telegram; only the
   subject is generated, since campaigns have no subject field.

5. **The recipient address never leaves memory.** It is resolved per send from the
   claimed registration, handed straight to the transport and never written to the
   job payload, the attempt row or a log line (`delivery_attempts` stores only
   state/code/provider id). A value that cannot be decrypted (key rotation) degrades
   to `no_channel` with one content-free warning, never to a crash or a retry loop.

6. **Notification email has exactly one provider and no fallback transport.**
   `selectNotificationEmailTransport()` returns the Resend transport when
   `RESEND_API_KEY` is set and `null` otherwise. It deliberately does NOT reuse
   `selectEmailTransport()`: the dev transport writes the recipient address into
   `.runtime/otp.log` (fine for the operator's own OTP, never for a third party),
   and the disabled transport maps a send to `failed`, which would end the job
   terminally on every tick instead of an honest suppression. With no provider the
   job is `suppressed:channel_disabled`.

7. **Locale.** WELCOME stores no per-account locale — the preference lives in the
   `welcome_locale` cookie only (`src/i18n/locale.ts`), and a server-side
   notification has no request to read it from. Emails therefore use the product
   default (EN). The notice renderer is locale-parameterized (EN/RU/ES) so a stored
   locale can be honoured later without touching the templates.

## Consequences

- A participant with a claimed registration and `service_channel` consent now
  receives intro notices by email; the suppression vocabulary
  (`no_channel` / `consent_revoked` / `channel_revoked` / `channel_blocked`)
  keeps its existing meaning, so existing stats and assertions stay readable.
- The outbox job's `channel` column still records the channel *requested* at
  enqueue time (`telegram`). The worker remains the authority on the channel
  actually used. This is consistent with the existing model, where the column is
  informational and every precondition is re-derived at send time; `/stop`
  suppression (`suppressJobsForAccountChannel`) therefore cancels the jobs of a
  recipient whose binding was just revoked — which the worker would have
  suppressed as `channel_revoked` anyway.
- Enqueue sites now carry `event_id` in the payload so the address lookup is
  scoped to the event the notification belongs to (personal introductions have
  none and fall back to the account's most recent claimed registration).
- A deployment without `RESEND_API_KEY` gains no new silent behaviour: email
  candidates become `suppressed:channel_disabled` and are visible in campaign
  stats like every other outcome.

Rejected alternatives:

1. **Send to the login address.** It is not stored — only its peppered hash is.
   Recovering it would mean storing a plaintext address for every account, which
   the privacy design explicitly avoids.
2. **Fall back to email after a revoked binding.** Cheaper to implement, but it
   turns "stop" into "stop on this channel, continue elsewhere" — the opposite of
   what the user asked for, and invisible to them.
3. **Store the rendered email body in the job payload at enqueue time.** It would
   freeze copy that must follow the *kind*, and it would put a per-kind template
   decision (and the recipient's link) into the durable queue for no benefit.
4. **Reuse the OTP dev transport when no provider is configured.** It writes
   addresses to disk; that is acceptable for the operator's own login code and
   never for someone else's address.
