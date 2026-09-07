# Production acceptance — must all pass or be explicitly N/A by scope

## Identity/profile/QR
- [ ] Account creation/login uses verified auth flow; enumeration-safe error path.
- [ ] Public slug is opaque/random; public card works without app/account.
- [ ] Only explicitly public fields appear in public API/HTML/hydration/cache.
- [ ] vCard contains only public fields and escapes values correctly.
- [ ] QR decodes to exact HTTPS public URL and opens on iOS/Android/in-app browsers.
- [ ] User can rotate/revoke public field and old cache updates.

## Event/import/claim
- [ ] CSV preview + commit; malformed/oversized/formula cells handled safely.
- [ ] Re-import is idempotent.
- [ ] Imported registration alone does not create/claim account.
- [ ] Forwarded/expired claim link cannot bind another user.
- [ ] Unknown status goes to quarantine.

## Matching/introductions
- [ ] no-self, block suppression, event eligibility, stable deterministic order.
- [ ] reason uses only actual shared/complementary normalized fields.
- [ ] intro creation idempotent on double click.
- [ ] A/B independent decisions; contacts reveal only after required mutual decision/field consent.
- [ ] consent withdrawal before send/reveal suppresses it.
- [ ] private note/next step visible only to owner.

## Organizer
- [ ] Two organizers cannot access each other's event data.
- [ ] Organizer cannot read user's global network/private notes/private contacts.
- [ ] staff/admin/owner permissions differ and are tested server-side.
- [ ] analytics are aggregate/event-scoped and demo excluded.
- [ ] campaign purpose/audience preview, test-send, approval revision, launch and unsubscribe suppression work.

## Telegram P0
- [ ] real HTTPS webhook + secret validation.
- [ ] deep-link one-time challenge binds correct authenticated account.
- [ ] `/start` is not consent.
- [ ] real inbound + outbound round trip on staging.
- [ ] block/stop/unlink prevents subsequent automated messages as specified.

## Privacy/security
- [ ] purpose-scoped consent, no language/page click implicit consent.
- [ ] export and delete flow exercised; public/cache/channel consequences verified.
- [ ] direct API IDOR/cross-tenant negative suite green.
- [ ] XSS/CSRF/rate-limit/CSV formula/webhook replay tests green.
- [ ] secret scan + dependency/security review green; no high/critical unresolved.
- [ ] logs/evidence inspected for PII/secrets.

## Quality/ops
- [ ] EN/RU/ES core flows; mobile 360/390/768/1440, accessibility baseline.
- [ ] unit + integration + DB auth + E2E + browser all green.
- [ ] controlled defect causes gates/reviewer to fail.
- [ ] staging health includes DB/worker/migration, not homepage only.
- [ ] backup restore and rollback rehearsal recorded.
- [ ] immutable reviewed SHA/artifact promoted; no production rebuild drift.
- [ ] mocks/seeded demo disabled/excluded in production.

## Optional integrations
- [ ] Luma API: either live verified or visibly disabled; CSV P0 still works.
- [ ] LinkedIn OIDC: either live verified or disabled; no scraping fallback.
- [ ] WhatsApp Business: either live verified with policy/template/webhook evidence or disabled; `wa.me` not counted.

## Release report
- [ ] `RELEASE_REPORT.md` validates against `contracts/release-report.schema.json` conceptually/schema tool if wired.
- [ ] exact URLs, SHA, tests, integrations, blockers, spend and unverified items listed.
