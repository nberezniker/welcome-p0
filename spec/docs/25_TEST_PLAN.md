# Test strategy

## Layers
1. Unit: matching, canonical pair, token helpers, purpose/field policy, CSV parser, URL validation, PII redaction.
2. DB/integration: migrations, constraints, idempotency, outbox leasing, withdrawal race, deletion cascade/soft-delete policy.
3. Authorization/RLS: two users + two organizers + anonymous; direct API/SQL claim tests.
4. Provider contract: Telegram webhook/deep link; Luma CSV; optional live adapters.
5. E2E: browser flows from clean account through mutual introduction and revoke/delete.
6. Security: threat-model cases, secret scan, dependency audit, XSS/CSV formula/CSRF/IDOR/rate limits.
7. Release: staging public URL, actual QR decode/open, real Telegram round trip, worker, backup restore/rollback rehearsal.

## Golden scenario
Alice creates profile → enables LinkedIn URL public but email private → Bob scans → sees only public fields → both join same event → complementary needs/offers → Alice gets Bob with fact-based reason → requests intro → Bob accepts → each separately selects fields → mutual reveal → Alice saves private note/next step → organizer sees +1 mutual intro aggregate, not note/contact → Alice revokes email field → subsequent public/reveal response no longer includes it.

## Required negative scenario
Carol from Organizer A attempts direct GET/PATCH on Organizer B event/profile/intro IDs and must receive 403/404 without leaking existence. Repeat with service-style endpoint and server action, not UI only.

## Review test
Inject a controlled defect into a disposable branch (e.g. return private email in public DTO). Gates/reviewer must FAIL. Remove defect; only then can review system be considered effective.
