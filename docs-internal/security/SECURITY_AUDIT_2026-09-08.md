# Security & Compliance Audit — 2026-09-08 (GLM-5.3 via ZCode, verified by AutoCoder)

Scope: full repo (`main` @ `db1e550`), live deployment https://welcome-p0-nikiti4.vercel.app.
Method: read-only code review, existing test suites, `pnpm audit`/licenses, live GET/HEAD probes + authorized OTP/worker-tick probes. No mutations.

## Findings summary

| ID | Sev | Title | Evidence | Effort |
|----|-----|-------|----------|--------|
| F-01 | **Critical** | Prod login broken: OTP transport missing; `writeDevOtpLog` unconditional → 500 on Vercel (read-only FS). Live-confirmed: 2×500 `correlation_id` | `src/app/api/auth/otp/request/route.ts:14-18,86`; live POST 500 ×2 | M |
| F-02 | High | join_code brute-force unthrottled (4-char min; only successful joins counted; no IP rule) | `src/domain/events.ts:176-177`, `src/lib/http.ts:130-136`, `settings/route.ts:11` | S |
| F-03 | High | No MFA/step-up for organizer owner (spec §9 requirement) | spec `WELCOME_TZ_v3.md:462`; grep 2FA=0 | L |
| F-04 | Medium | Missing CSP / X-Frame-Options / Permissions-Policy / Referrer-Policy on pages | live headers | S |
| F-05 | Medium | Delete = soft only (no purge); export lacks introductions (GDPR 15/17) | `src/app/api/me/route.ts:32-45`, `me/export/route.ts:24-52` | M |
| F-06 | Medium | No retention jobs (sessions/OTP/challenges/outbox/inbox/unactivated imports) | 4 DELETE statements total in codebase | M |
| F-07 | Medium | PII in `outbox_jobs.payload` / `inbox_events.minimal_payload` (text, chat_id) stored indefinitely | `integrations/telegram/updates.ts:15-21` | M |
| F-08 | Medium | Authed GETs rely on platform default caching (`public, max-age=0`) instead of explicit no-store | live 401 `/api/me/profile` headers | S |
| F-09 | Low | `WORKER_TICK_SECRET` accepted via query string (leaks to logs) | `worker-tick/route.ts:36` | S |
| F-10 | Low (candidate) | Login `?next=` allows `/\evil.com` (WHATWG backslash) → open redirect | `src/app/login/page.tsx:24` | S |
| F-11 | Low | Event existence disclosed for closed events (by-design P0; document or `unlisted`) | `src/lib/event-view.ts:29-49` | S |
| F-12 | Low | Actions pinned by tag, not SHA | `.github/workflows/ci.yml` | S |
| F-13 | Low | In-memory rate limits are per-instance (mitigated by DB counters on OTP/join-create; otp_verify lacks DB counter) | `src/lib/ratelimit.ts:118-148` | S |
| F-14 | Low | `join_code` non-constant-time compare; `contact_fields.kind` no CHECK; slug no max-length | `events.ts:177`, `001_init.sql:45,39` | S |
| F-15 | Medium | No privacy notice/terms on prod; no DPA/SCC/subprocessors; no 72h breach playbook; DPIA not assessed | footer link dead; template has placeholders | M |
| F-16 | Low | Public health exposes `migration_version` | live /api/health | S |
| F-17 | Info | Locale cookie without HttpOnly (not sensitive) | `api/locale/route.ts:27-33` | S |
| F-18 | Info (candidate) | Prod session-cookie flags unverified until F-01 fixed | `src/lib/auth.ts:100-110` | S |

**Totals: 1 critical, 2 high, 5 medium (incl. F-15), 9 low/info.**
Dependency audit: `pnpm audit` — no known vulnerabilities (prod + full). Licenses: MIT×281, Apache-2.0×22, ISC/BSD — no forbidden. next 15.5.25 (16.x available, planned upgrade).

## Compliance matrix (GDPR-oriented)

| Area | Status | Gap → action |
|------|--------|--------------|
| Roles/bases | Partial | Document controller/processor per purpose (template exists with placeholders) |
| Transparency | Partial | Publish `/legal/privacy` + `/legal/terms`; fix footer link (F-15) |
| Data subject rights | Partial | +introductions in export (F-05); purge phase (F-05) |
| Retention | **Missing** | Cleanup cron (F-06): sessions/OTP/challenges, outbox/inbox >90d, unactivated imports 30d post-event |
| Residency | Partial | Neon Frankfurt ✓, Vercel fra1 ✓; Vercel Inc = subprocessor → DPA/SCC list |
| Security of processing | Partial | F-06/F-07; Neon free PITR window limited — verify restore plan |
| Minimization | Partial | Filter `registrations.imported_data` to whitelist (B7) |
| Cookies/trackers | **OK** | 2 first-party cookies only, 0 third-party scripts |
| OSS hygiene | Mostly | CODEOWNERS + branch protection + dependabot (F-12 adjacent) |

## Remediation plan (tracker-ready)

### P0 — release blocker (this week)
1. **Fix prod OTP delivery (F-01)** — M. Email transport (Resend/SES) behind provider adapter; remove unconditional `writeDevOtpLog` from prod path (dev-gate `APP_ENV!=='development'` → skip + no file); CI gate: production build forbids `AUTH_DEV_EXPOSE_OTP`. Verification: live login e2e on prod + Set-Cookie flags check (closes F-18).
2. **join_code throttling (F-02)** — S. `/join` into `IP_RATE_RULES` (10/min/IP) + DB failed-attempt counter per event; `JOIN_CODE_MIN` 4→8. Verification: new integration test (N wrong codes → 429) + existing suite.

### P1 — before pilot (1–2 weeks)
3. **Security headers (F-04)** — S. `headers()` in `next.config.ts`: CSP `default-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'`, XFO DENY, Permissions-Policy, Referrer-Policy. Verification: securityheaders-style curl matrix.
4. **Retention cron (F-06, F-07)** — M. Second cron entry + cleanup module (expired sessions/otp/challenges; terminal outbox/inbox >90d with `text` nulling; unactivated registrations 30d post-event). Verification: integration test with backdated rows.
5. **Subject rights completion (F-05)** — M. Export +introductions/consents; purge job for `status='deleting'` (anonymize profile tables, keep audit with pseudonymized actor). Verification: round-trip test export→delete→purge.
6. **Privacy/legal pages (F-15)** — M. Fill `PRIVACY_COPY_TEMPLATE`, ship `/legal/privacy`, `/legal/terms`, subprocessor list (Vercel, Neon, Telegram), breach playbook 72h. Verification: footer link resolves; content review sign-off.
7. **Cache discipline (F-08)** — S. `privateCacheHeaders()` helper applied to all authed GETs. Verification: header matrix test.

### P2 — hardening (month)
8. **MFA for organizer owner (F-03)** — L. TOTP enrollment + step-up on campaign approve/send; recovery codes.
9. **Payload minimization (F-07, B7)** — M. Null `text` after processing; whitelist `audit_events.metadata` keys; filter `imported_data`.
10. **Hardening bundle (F-09, F-10, F-12, F-16, F-14)** — S. Remove `?secret=` carrier; reject `\` in login `next`; pin actions by SHA (+dependabot); hide `migration_version` from public health; `JOIN_CODE` constant-time compare + DB CHECKs; slug max-length.
11. **Documented accepted risks (F-11, F-13, F-17, F-18)** — S. Threat-model notes: event existence disclosure (by design), per-instance limiter (DB counters compensate), cookie inventory.

## Verified strong (keep)
- AES-256-GCM per-value IV, HMAC pepper, hash-only tokens, constant-time compares with dummy-burn (anti-enumeration).
- Server-side object-level authz everywhere tested; no role-granting endpoint exists.
- Parameterized SQL only; zero `dangerouslySetInnerHTML`; link scheme allowlist; vCard/CSV escaping; import quarantine.
- Webhook secret-before-parse + dedupe + 24h staleness; consent re-check at send; suppression on revoke/stop; unknown-cap retry.
- Zero third-party scripts/trackers; CI defect-drill; secret scanner; IDOR negative suite.
