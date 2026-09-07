import { NextRequest, NextResponse } from 'next/server';
import { loadPublicProfile, publicCacheHeaders } from '../../../../../../lib/public-profile';
import { buildVCard } from '../../../../../../domain/vcard';
import { jsonError } from '../../../../../../lib/http';

export const dynamic = 'force-dynamic';

/** vCard 3.0 download of the public projection only. */
export async function GET(
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
