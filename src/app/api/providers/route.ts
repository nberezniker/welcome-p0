import { NextResponse } from 'next/server';
import { internalError } from '../../../lib/http';
import { resolveProviders } from '../../../lib/provider-status';

export const dynamic = 'force-dynamic';

/**
 * GET /api/providers — PUBLIC registry projection (no session, no cookies).
 *
 * Allowlisted fields only: id / kind / auth / capabilities / direction / status /
 * reason_code(+missing_env) / env NAMES. The registry is safe to publish
 * precisely because it stores variable NAMES and never values — the resolver
 * only ever asks whether a variable is set (src/lib/provider-status.ts).
 *
 * `no-store`: the answer depends on this instance's environment, so it must not
 * be cached by a shared cache and served to a differently-configured one.
 */
export async function GET() {
  try {
    return NextResponse.json(
      { ok: true, providers: resolveProviders() },
      {
        headers: {
          'Cache-Control': 'no-store',
          'X-Robots-Tag': 'noindex',
        },
      },
    );
  } catch (err) {
    return internalError(err);
  }
}
