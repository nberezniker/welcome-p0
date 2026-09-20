import { NextRequest, NextResponse } from 'next/server';
import { loadPublicProfile, publicCacheHeaders } from '../../../../../lib/public-profile';
import { withRequestContext, jsonError } from '../../../../../lib/http';

export const dynamic = 'force-dynamic';

/** Public JSON projection. Returns ONLY explicitly public fields —
 * no email, account ids, revision, or disabled contacts, ever. */
/* Request scope only — a read-only GET takes no CSRF/rate-limit guard, but its
 * error bodies and log lines must still carry the request's correlation id. */
export const GET = withRequestContext(get);

async function get(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const profile = await loadPublicProfile(slug);
  if (!profile) {
    return jsonError(404, 'not_found', 'Profile not found', { headers: publicCacheHeaders() });
  }
  return NextResponse.json(profile, { headers: publicCacheHeaders() });
}
