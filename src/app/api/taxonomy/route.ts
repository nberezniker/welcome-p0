import { NextResponse } from 'next/server';
import { taxonomyPayload } from '../../../domain/taxonomy';

/** GET /api/taxonomy — PUBLIC catalogue for pickers and search facets.
 * No auth, no DB: the payload is pure catalogue data (RU+EN labels for both
 * locales at once), so it is safe to serve from a shared cache for an hour. */
export const dynamic = 'force-static';

export async function GET() {
  return NextResponse.json(
    { ok: true, ...taxonomyPayload() },
    { headers: { 'Cache-Control': 'public, max-age=3600' } },
  );
}
