import { NextRequest, NextResponse } from 'next/server';
import QRCode from 'qrcode';
import { loadPublicProfile, publicCacheHeaders } from '../../../../../../lib/public-profile';
import { appBaseUrl } from '../../../../../../lib/env';
import { withRequestContext, jsonError } from '../../../../../../lib/http';

export const dynamic = 'force-dynamic';

/** QR code (SVG) encoding the absolute public URL of the profile.
 * The slug never changes, so the QR never needs to be reprinted. */
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
  const url = `${appBaseUrl()}/p/${encodeURIComponent(profile.slug)}`;
  const svg = await QRCode.toString(url, { type: 'svg', margin: 1, width: 512 });
  return new NextResponse(svg, {
    status: 200,
    headers: {
      ...publicCacheHeaders(),
      'Cache-Control': 'public, max-age=300',
      'Content-Type': 'image/svg+xml; charset=utf-8',
    },
  });
}
