# ADR 0004 — Event routes use a single [eventIdOrSlug] dynamic segment

Status: accepted. Context: members receive event links by slug (QR, posters);
the app internally works with uuid ids; separate [eventId] and [eventSlug]
routes would duplicate every handler.

Decision: member-facing event routes (`/api/events/[eventIdOrSlug]/*`) accept
either a uuid or a slug, resolved by an isUuid check (no guessing): uuid →
`id = $1::uuid`, otherwise `slug = $1`. Organizer-only routes keep strict
`[eventId]` (uuid) — organizer surfaces are always linked from our own data.

Consequences: one handler per operation; the extra lookup is one indexed query.
Public event projection treats unknown id-or-slug as a generic 404 (no
existence distinction), which the anti-enumeration tests pin.
