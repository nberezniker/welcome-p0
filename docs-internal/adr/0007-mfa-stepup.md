# ADR 0007 — MFA step-up for organizer owners (F-03)

Status: accepted. Spec: WELCOME_TZ_v3.md §9 («MFA для organizer owner»).

## Context

Organizer owners can approve and send campaigns to an event's eligible
audience — the highest-impact action in the product. OTP login alone (email +
6-digit code) authenticates the account, but the session cookie is then
usable for up to 30 days. An attacker with a stolen cookie could approve and
send organizer-marketing messages. §9 requires MFA for organizer owner roles;
ordinary members, staff/admins and personal-product flows are out of scope.

## Decision

1. **Enrollment model (TOTP, RFC 6238).** One optional credential per account
   (`mfa_credentials`, migration 006). The shared secret is generated with
   `node:crypto`, stored only AES-256-GCM encrypted with the existing
   `ENCRYPTION_KEY` (`src/lib/crypto.ts`), never in plaintext. Enabling is
   two-step: `POST /api/me/mfa/totp` issues a pending secret + 8 recovery
   codes, `POST /api/me/mfa/totp/confirm` activates it after a correct code.
   Recovery codes are stored only as SHA-256 hashes and are single-use.
   The raw email used in the otpauth label is supplied by the client and
   validated against `accounts.email_lookup_hash` — no plaintext email is
   stored next to the secret.

2. **Step-up window: 30 minutes.** A session that has passed MFA carries
   `sessions.mfa_verified_at`. Owner-level organizer actions call
   `requireMfaFresh(session)`, which requires `mfa_verified_at` within the
   last 30 minutes **and** a confirmed credential; otherwise the API answers
   `403 {code:'mfa_required'}` and the client opens the code modal, calls
   `POST /api/auth/mfa/verify`, then retries the action. Why 30 minutes:
   short enough to bound a stolen-cookie window for irreversible sends, long
   enough that approving a campaign does not nag the owner on every click.
   A fresh stamp is refreshed by re-running the step-up; it is not extended
   by ordinary page views. Without any `mfa_verified_at` the member may still
   use the product (profiles, directory, intros) — only owner actions are
   gated (403, not a hard logout).

3. **Owner-only, admin exempt.** Spec §9 targets the organizer *owner*. The
   `approve` route already excludes admins; `send` gates the MFA check only
   when the caller's role is `owner` — platform/organizer `admin` keeps its
   current privilege without MFA. Accounts **without** a confirmed factor are
   unaffected: `mfa_required` is never raised for them, so no existing login
   or campaign flow changes behavior.

4. **Enumeration-safe failures.** All verification failures (no factor, wrong
   TOTP, wrong recovery code, throttled) answer the same payload
   (`401 mfa_invalid` at login step-up, `400 mfa_invalid_code` during
   enroll/disable). Wrong attempts are durable fact rows in
   `mfa_verify_failures` — the same sliding-window pattern as
   `otp_verify_failures` — max 5 per account per 15 minutes.

5. **Disable requires the current TOTP.** The owner's factor has no other
   second channel, so the code IS the confirmation: `DELETE /api/me/mfa`
   succeeds only with a correct TOTP (rotation of a confirmed factor in
   `POST /api/me/mfa/totp` likewise).

## Consequences

- Migrations 006 adds three tables + one sessions column; export/subject-
  access excludes MFA credentials and recovery codes entirely (the export
  route enumerates its tables explicitly, and account deletion removes both
  via `ON DELETE CASCADE`).
- The per-IP in-memory bucket (ADR 0005) additionally covers the MFA routes;
  the per-account DB counter remains the authoritative limit.
- 403 `mfa_required` surfaces in existing campaign UI as the step-up modal —
  no forced logout, no session churn.
