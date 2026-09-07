# Privacy / GDPR engineering contract
This is an implementation specification, not legal advice or a final privacy notice.

## Data ownership boundary
- **Personal profile:** user-controlled, reusable across events. Organizer never owns the user's global profile, private notes or cross-event network.
- **Event membership:** organizer-scoped event data, limited to event purpose and role authorization.
- **Introduction:** private between two participants. Organizer may receive aggregate counts, not the content of private notes or automatically all contact fields.
- **Marketing:** separate purpose. Joining an event / scanning a QR / starting Telegram does not silently opt a person into organizer or product marketing.

## Consent purposes (when consent is the chosen legal basis)
Use independent records, not one global boolean:
- `PUBLIC_CARD_FIELD`
- `EVENT_DIRECTORY`
- `INTRO_FIELD_REVEAL`
- `SERVICE_CHANNEL_TELEGRAM`
- `ORGANIZER_MARKETING`
- `PRODUCT_MARKETING`

Each record stores scope, field set, policy/version, affirmative action, timestamp and withdrawal. A language choice, page view, link click, imported registration or `/start` parameter is never consent.

## Data minimization
Public card API returns only enabled public fields. Organizer dashboard uses event projections. Matching reads normalized needs/offers and eligibility flags, not private notes, email body, phone, nationality, gender, photo similarity or sensitive categories.

## Retention targets for pilot (must be confirmed before launch)
- raw import file: delete after successful canonical import + short diagnostic window;
- unclaimed registrations: proposed deletion 30 days after event;
- raw webhook bodies: minimal diagnostic TTL, then delete/redact;
- event networking window: proposed 30 days after event unless user keeps a connection explicitly;
- personal profile: until user deletion/inactivity policy;
- audit events: defined retention proportional to security/accountability purpose, without message bodies.

## User rights/product controls
`/settings/data` supports export and deletion request/status. User can revoke public fields, event-directory visibility, channel/marketing consent and introduction field reveal. Product explains consequences without dark patterns. Cache purge is part of revocation.

## Logging
Never log raw OTPs, auth headers, API keys, WhatsApp/Telegram tokens, private contact values, full imported CSV rows or private note text. Error telemetry uses IDs/correlation IDs and redacted metadata.

## Launch gate
Before public launch, fill real controller identity/contact, purposes/legal bases, processors, transfer details, retention, rights/contact route, cookie/analytics details and applicable electronic-marketing rules for launch countries. Do not advertise “100% GDPR compliant”.
