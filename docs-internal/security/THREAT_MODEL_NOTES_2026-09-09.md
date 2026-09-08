# Threat-model notes — documented accepted risks (2026-09-09)

Companion to `SECURITY_AUDIT_2026-09-08.md`. After the remediation batch
(F-01, F-02, F-04–F-10, F-12–F-16), three findings remain OPEN by design.
This note documents the decision, the compensating controls and the trigger
to revisit each one. Statuses were agreed with the project owner for the P0
milestone; none of these are silent gaps.

## F-11 — Event existence disclosure for closed events (accepted, by design)

- **Finding**: `GET /api/events/[eventIdOrSlug]` returns 404 vs 403-shaped
  behaviour that lets a caller holding a slug/id distinguish "closed event
  exists" from "no such event" (`src/lib/event-view.ts`). Event slugs are
  either organizer-chosen or 128-bit random (`generateEventSlug()`), and
  closed-event membership requires a join code, so knowledge of the slug
  already implies legitimate context (an invitation, a QR, or the organizer).
- **Decision**: accept for P0. Changing to uniform `unlisted`/404 responses
  would complicate the join UX for a marginal gain.
- **Compensating controls**: join-code brute force is throttled twice
  (10/min/IP bucket + DB `join_attempts` lock at 20/15 min per event+IP);
  `JOIN_CODE_MIN` is 8; join-code comparison is constant-time.
- **Revisit when**: events become discoverable through search/public listings,
  or slugs become guessable/sequential.

## F-13 — Per-instance in-memory IP limiter (mitigated)

- **Finding**: `src/lib/ratelimit.ts` token buckets are per-process; on
  serverless multi-instance deployments the same IP can multiply its budget.
- **Decision**: accept as a P0 limitation (ADR 0005), because the
  security-critical counters are now DURABLE and DB-backed:
  `auth_otp_codes` request throttle (per account), `otp_verify_failures`
  (5 / 15 min per account, F-13), and `join_attempts` (20 / 15 min per
  event+IP, F-02). The IP buckets remain a coarse first line against bursts.
- **Revisit when**: abuse patterns appear that rely on IP churn across
  instances, or when the app gains Redis/a shared store — then move the
  buckets behind it.

## F-17 — Locale cookie without HttpOnly (accepted, info)

- **Finding**: `welcome_locale` is a plain first-party preference cookie
  (values: en/ru/es). It carries no identifier and grants no capability.
- **Decision**: accept. Making it HttpOnly is harmless but pointless; the
  session cookie (`welcome_session`) is already HttpOnly + SameSite=Lax +
  Secure-in-production (F-18's concern is resolved by F-01 enabling a real
  production login flow; flags set in `src/lib/auth.ts`).
- **Revisit when**: the cookie starts influencing anything security-relevant.

## F-18 — Production session-cookie flags (resolved via F-01)

Blocked in the audit because production login was broken (F-01 500s made
Set-Cookie unreachable live). F-01 restores the request path; the flags are
set unconditionally in code (`httpOnly`, `sameSite: 'lax'`,
`secure: isProduction()`), and the e2e suite exercises the login flow.
**Remaining**: verify Set-Cookie flags once on the live deployment after the
next production deploy (out of scope for the local remediation batch; no prod
mutations were performed here).

## Explicitly out of scope (audit backlog)

- **F-03 (MFA/step-up for organizer owner)** — large; planned separately.
- **F-14 residual** — `events.join_code` is stored in plaintext (constant-time
  compare is in place). Migration 005 carries a TODO: hash per-event codes in
  a dedicated migration + backfill before commercial launch.
- **Next.js 16 major upgrade** — separate work item, not a security fix.
