# ADR 0009 — Dev-OTP exposure allowlist for staging-test deployments

Status: accepted.

## Context

F-01 (ADR 0006) gave OTP delivery its final shape: `planOtpDelivery()` is a
pure function, `AUTH_DEV_EXPOSE_OTP` exposes the code in development only, a
demo account (`accounts.is_demo`) with `AUTH_EXPOSE_DEMO_OTP=true` exposes the
code without a provider, and production without a provider fails closed with
`503 email_channel_disabled`.

That leaves one gap. A **staging-test deployment** runs `APP_ENV=production`
(the fail-closed behaviour is exactly what we want to verify there) but has no
email provider and hosts no `is_demo` accounts. Reviewers need to log in with a
real, ordinary account to exercise the untouched flow — profiles, directory,
introductions, organizer campaigns.

Two rejected alternatives:

1. **Set `AUTH_DEV_EXPOSE_OTP=true` on staging.** It is hard-gated on
   `APP_ENV=development`, so it silently does nothing on a production build —
   the misleading "flag is on but no code appears" failure mode.
2. **Flag every staging account `is_demo`.** It would work, but it overloads a
   data property (is this row synthetic demo content?) with an auth policy, and
   it silently changes what the seed/export/analytics code sees.

## Decision

1. **A named allowlist, not a blanket flag.** Two variables, both required:
   - `AUTH_EXPOSE_OTP_EMAILS=true` — master switch, off unless exactly `true`;
   - `AUTH_EXPOSE_OTP_EMAIL_ALLOWLIST=a@b.c,d@e.f` — comma-separated addresses.
   The branch lives in the same pure `planOtpDelivery()`, between the demo
   branch and the real provider branch, so the whole delivery matrix stays one
   unit-tested function (F-01 coverage is preserved). The switch alone exposes
   nothing: an address must also be on the list.

2. **Matching is peppered and constant-time.** The route passes the account's
   already-computed `emailLookupHash` into `isEmailAllowlisted()`
   (`src/lib/crypto.ts`); each list entry is normalized (trim + lowercase) and
   HMAC'd with the same `HASH_PEPPER`, then compared with `timingSafeHexEqual`.
   The raw target email and the raw list entries never meet, and the full list
   is always scanned — no early exit that would leak match position.

3. **Loud, address-free warning.** When the switch is live while
   `APP_ENV=production`, the OTP route emits
   `DEV OTP EXPOSURE ENABLED ON PRODUCTION — staging-test only (N allowlisted
   addresses)` exactly once per process (`warnIfOtpExposureOnProduction`, built
   on `createOtpExposureWarner`). It reports only the COUNT: the addresses
   never reach logs. The warning is a tripwire, not a guard — this is an
   operator-explicit exception, and it is documented as such in
   `.env.deploy.example` ("never enable in a real production deployment").

4. **Demo login stays separate.** `AUTH_EXPOSE_DEMO_OTP` + `is_demo` remains
   the "seeded demo account" path and is now documented in `.env.example`. The
   login page discovers it through `GET /api/auth/demo-login-info`, which reads
   the flag per request (`force-dynamic`, `Cache-Control: no-store`) so
   toggling it needs no rebuild.

## Consequences

- Staging-test can log in with a normal account without an email provider;
  production without a provider still fails closed exactly as F-01 defined.
- The exposure surface is an explicit, auditable list of synthetic addresses.
  Everyone else — including any address NOT on the list — gets `{ok:true}` with
  no `devCode`, i.e. the enumeration-safe shape is unchanged.
- If the flag is left on by mistake, an account still needs to be on the list;
  the only leaked credential is the OTP of an address the operator deliberately
  named, and the warning fires on every cold start where it is live.
- ADR 0008 is intentionally left free (no decision recorded under that number),
  so this ADR is numbered 0009.
