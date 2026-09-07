# Threat model and abuse cases

## Assets
Identity bindings, private contact fields, event memberships, introduction decisions, private notes, organizer campaign authority, webhook secrets, auth tokens and release credentials.

## Top abuse/failure cases
| Threat | Required mitigation/test |
|---|---|
| QR/profile enumeration | opaque random slug ≥128-bit entropy; rate limit; no sequential IDs; 404/403 indistinguishable where appropriate |
| Forwarded event claim link | claim token only selects challenge; auth/registration proof required; one-time TTL; scanners cannot consume GET |
| IDOR / cross-tenant | server authorization + RLS/app checks; direct API negative suite with two organizers/two users |
| Public page leaking private fields | public projection DTO; no private fields in HTML/RSC/hydration/cache; snapshot test |
| Webhook spoof/replay | provider verification, durable inbox unique id, timestamp/replay rules where provider supports |
| Double-click/duplicate webhook | DB constraints/idempotency keys; same resource id returned, no duplicate send |
| Consent race | versioned consent checked again at send/reveal time; withdrawal cancels queued work |
| Organizer spam | purpose-specific eligible audience, preview/test send, approval revision, rate cap, unsubscribe suppression, audit |
| Stalking/harassment | block/report; blocked pair not recommended/revealed; rate limit intro requests |
| CSV/XSS/formula injection | strict parser, escaped rendering, no raw HTML, formula neutralization on export |
| SSRF through avatar/profile URL | do not server-fetch arbitrary URLs P0; upload files with MIME/size validation |
| Prompt injection | LLM never gets tools/DB credentials/authorization decisions; structured allowlisted fields only |
| Token/secret leakage | env/secret manager, secret scan, redact logs, no browser profile/cookies committed |
| Cache after revoke/delete | purge/revisioned cache keys; test old public URL response after revoke/delete |
| Unknown provider result | do not blind resend; reconcile or mark unknown; bounded operator review |
| Admin takeover | organizer owner MFA where supported, least privilege, session expiry, audit privileged actions |

## Security release tests
See `tests/SECURITY_TESTS.md`. High/critical unresolved findings block staging promotion. Medium findings require explicit owner risk acceptance with issue link; no hidden waiver inside prompt.
