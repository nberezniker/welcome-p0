import { NextRequest, NextResponse } from 'next/server';
import { loadPublicProfile, publicCacheHeaders } from '../../../../../../lib/public-profile';
import { buildVCard } from '../../../../../../domain/vcard';
import { withRequestContext, jsonError } from '../../../../../../lib/http';

export const dynamic = 'force-dynamic';

/** vCard 3.0 download of the public projection only. */
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
  const body = buildVCard(profile);
  return new NextResponse(body, {
    status: 200,
    headers: {
      ...publicCacheHeaders(),
      'Content-Type': 'text/vcard; charset=utf-8',
      'Content-Disposition': `attachment; filename="welcome-${slug}.vcf"`,
    },
  });
}
