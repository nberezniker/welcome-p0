import { NextResponse } from 'next/server';
import { withRequestContext } from '../../../lib/http';
import { taxonomyPayload } from '../../../domain/taxonomy';

/** GET /api/taxonomy — PUBLIC catalogue for pickers and search facets.
 * No auth, no DB: the payload is pure catalogue data (RU+EN labels for both
 * locales at once), so it is safe to serve from a shared cache for an hour. */
export const dynamic = 'force-static';

/* Request scope only — a read-only GET takes no CSRF/rate-limit guard, but its
 * error bodies and log lines must still carry the request's correlation id. */
export const GET = withRequestContext(get);

async function get() {
  return NextResponse.json(
    { ok: true, ...taxonomyPayload() },
    { headers: { 'Cache-Control': 'public, max-age=3600' } },
  );
}
