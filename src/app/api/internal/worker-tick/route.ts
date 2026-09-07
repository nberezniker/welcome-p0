import { NextRequest } from 'next/server';
import { tickOnce } from '../../../../infra/worker';
import { selectTransport } from '../../../../integrations/telegram';
import { secureSecretEqual } from '../../../../lib/crypto';
import { appEnv } from '../../../../lib/env';
import { jsonError, jsonOk, withApi } from '../../../../lib/http';

export const dynamic = 'force-dynamic';

/**
 * POST|GET /api/internal/worker-tick — serverless replacement for the
 * long-running worker (pnpm worker) when the app is deployed to Vercel.
 * Runs exactly ONE outbox tick via the existing tickOnce() (batch of 10 —
 * comfortably inside the function budget) and returns the per-tick counts.
 *
 * One shared secret (env WORKER_TICK_SECRET), three accepted carriers, every
 * comparison constant-time (secureSecretEqual):
 *   1. header `x-worker-tick-secret` — external pinger / manual runs;
 *   2. `Authorization: Bearer <secret>` — what Vercel Cron sends when the
 *      CRON_SECRET env var is set (set CRON_SECRET = WORKER_TICK_SECRET);
 *   3. `?secret=<secret>` query fallback for callers that cannot send headers.
 *
 * Fail-closed: with WORKER_TICK_SECRET unset the endpoint answers 401 in every
 * environment except APP_ENV=development, where it stays usable without config.
 */

const SECRET_HEADER = 'x-worker-tick-secret';

/** True when the request carries the shared secret in any accepted carrier. */
function isAuthorized(req: NextRequest): boolean {
  const expected = process.env.WORKER_TICK_SECRET;
  if (!expected) return appEnv() === 'development'; // unset secret → fail closed
  if (secureSecretEqual(req.headers.get(SECRET_HEADER) ?? '', expected)) return true;
  const auth = req.headers.get('authorization');
  if (auth?.startsWith('Bearer ') && secureSecretEqual(auth.slice('Bearer '.length), expected)) return true;
  return secureSecretEqual(req.nextUrl.searchParams.get('secret') ?? '', expected);
}

async function tickRoute(req: NextRequest) {
  if (!isAuthorized(req)) {
    return jsonError(401, 'unauthorized_worker_tick', 'Invalid worker tick secret');
  }
  // Same transport wiring as the long-running worker (runWorker): real Bot API
  // when a token is configured, mock only in dev with TELEGRAM_MOCK=1, and the
  // disabled transport otherwise — jobs fail visibly, never silently dropped.
  const report = await tickOnce({ transport: await selectTransport() });
  return jsonOk({
    ok: true,
    processed: report.claimed,
    requeued_leases: report.requeuedLeases,
    results: report.results,
  });
}

// POST for external pingers; GET because Vercel Cron issues GET requests.
export const POST = withApi(tickRoute);
export const GET = withApi(tickRoute);
