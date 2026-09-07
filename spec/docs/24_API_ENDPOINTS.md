# Human-readable API surface (P0)
Exact request/response schemas can evolve, but authorization/semantics may not.

## Public
- `GET /api/public/profiles/:slug` — public projection only; cache revision aware.
- `GET /api/public/events/:slug` — minimal public event metadata, no participant directory.

## Authenticated user
- `GET/PATCH /api/me/profile`
- `GET/PATCH /api/me/public-fields`
- `POST /api/me/qr/rotate` — optional emergency slug rotation, invalidates old slug.
- `GET /api/me/events`
- `POST /api/events/:id/claim/start`
- `POST /api/events/:id/claim/complete`
- `PATCH /api/events/:id/membership`
- `GET /api/events/:id/recommendations`
- `POST /api/introductions`
- `POST /api/introductions/:id/decision`
- `PATCH /api/introductions/:id/field-consent`
- `GET/PATCH /api/connections/:profileId/note`
- `POST /api/channels/telegram/link/start`
- `POST /api/channels/telegram/unlink`
- `POST /api/blocks`
- `POST /api/reports`
- `POST /api/me/export`
- `DELETE /api/me`

## Organizer
- `POST /api/organizer/events`
- `POST /api/organizer/events/:id/import/preview`
- `POST /api/organizer/events/:id/import/commit`
- `GET /api/organizer/events/:id/participants` — event projection only.
- `GET /api/organizer/events/:id/analytics` — aggregate networking funnel.
- `POST /api/organizer/events/:id/campaigns`
- `POST /api/organizer/campaigns/:id/approve`
- `POST /api/organizer/campaigns/:id/test-send`
- `POST /api/organizer/campaigns/:id/launch`

## Webhooks
- `POST /api/webhooks/telegram`
- `POST /api/webhooks/luma` (optional)
- `POST /api/webhooks/whatsapp` (optional)

Every private endpoint tests object-level authorization server-side. IDs in bodies are never trusted as actor identity. Mutations use idempotency keys where double submit/provider retry is plausible.
