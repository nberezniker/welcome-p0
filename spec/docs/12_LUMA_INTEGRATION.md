# Luma / event-registration integration

## Principle
WELCOME must not require an event platform to be useful. The permanent profile/QR works independently. Event registration is an adapter.

## P0 — generic/Luma CSV
Organizer uploads a CSV to one event. Server parses into a staging table first; nothing becomes an active membership until validation/claim rules succeed.

Minimum canonical fields:
- `external_guest_id` (optional; preferred when present)
- `email` (identity hint, stored encrypted; normalized hash for lookup)
- `name`
- `approval_status`
- `checked_in_at` or boolean attendance signal (optional)
- `company`, `linkedin_url`, `website` and custom answers as *unverified imported attributes*

Rules:
1. Never execute spreadsheet formulas from imported cells; trim size and neutralize formula prefixes on exports.
2. Validate email format but never reveal whether an email is registered to anonymous callers.
3. Deduplicate by `(event, external_guest_id)` when present; otherwise `(event, normalized email hash)` with explicit collision handling.
4. Re-import is idempotent: update allowed imported fields/revision, no duplicate membership/intro.
5. Imported professional fields are not “verified LinkedIn data”. User can confirm/edit on claim.
6. Unknown approval/status value -> quarantine, not “approved”.
7. CSV raw file gets short retention; parsed canonical rows are audited.

## P1 — Luma API + webhook
Official Luma help currently says API access needs active Luma Plus and a calendar-scoped API key. Implement only when present.

Adapter responsibilities:
- backfill events/guests using API;
- receive `guest.registered`/guest updates per current docs;
- authenticate/verify webhook exactly as current Luma docs specify (do not invent signature scheme);
- durable inbox with unique provider event id;
- map to the same canonical registration service as CSV;
- replay-safe and idempotent;
- quarantine unknown schema/status;
- API failure must not corrupt existing registrations.

## Claim flow
Import does not create a logged-in account. User opens a personal event claim link → authenticates with the allowed method → server proves linkage to one registration → confirms imported fields → explicitly chooses event-directory visibility/notification purposes. Forwarding a link alone cannot claim a registration.

See `contracts/luma-field-map.example.json` and `templates/luma-import-example.csv`.
