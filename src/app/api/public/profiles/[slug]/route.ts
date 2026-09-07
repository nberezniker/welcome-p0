import { NextRequest, NextResponse } from 'next/server';
import { loadPublicProfile, publicCacheHeaders } from '../../../../../lib/public-profile';
import { jsonError } from '../../../../../lib/http';

export const dynamic = 'force-dynamic';

/** Public JSON projection. Returns ONLY explicitly public fields —
 * no email, account ids, revision, or disabled contacts, ever. */
export async function GET(
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
