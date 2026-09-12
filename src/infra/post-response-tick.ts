import { after } from 'next/server';
import { selectTransport } from '../integrations/telegram';
import type { ChannelTransport } from '../integrations/telegram/transport';
import { tickOnce } from './worker';

/**
 * Post-response processing for the Telegram webhook (latency fix).
 *
 * The durable accept path (webhook → inbox_events + one outbox job) is
 * unchanged. What changes is WHEN the job runs: the webhook answers Telegram
 * 200 first and only then — via Next's `after()`, which runs once the response
 * has been flushed — drains a short, bounded worker tick. The user's `/start`
 * or command reply therefore goes out seconds after the update arrives instead
 * of waiting for the next scheduled cron tick (observed 1–15 min delays,
 * perceived as "the bot is silent").
 *
 * Durability is untouched — this module is an OPTIMIZATION, never a guarantee:
 *  - it reuses tickOnce(), the exact pipeline `/api/internal/worker-tick` and
 *    the long-running worker run, so leases, dedupe, retries and terminal
 *    states behave identically;
 *  - if `after()` never fires (invocation killed, response aborted, runtime
 *    without a request scope) every job simply stays 'pending' and the
 *    GitHub-Actions cron / worker-tick backstop claims it — nothing is lost;
 *  - every failure here is swallowed and logged: the webhook's 200 is already
 *    on the wire and must never be retried by Telegram because of us.
 */

/** Rounds per invocation: the accepted update, the reply it enqueues, then a
 * final empty round that stops the loop. Small on purpose — a webhook request
 * must never turn into a batch worker. */
export const POST_RESPONSE_MAX_ROUNDS = 3;

/** Claim batch per round — much smaller than the cron worker's 10. */
export const POST_RESPONSE_BATCH_LIMIT = 5;

/** Runs the bounded post-response drain. Never throws. */
export async function runPostResponseTick(deps: { transport?: ChannelTransport } = {}): Promise<void> {
  try {
    const transport = deps.transport ?? (await selectTransport());
    for (let round = 0; round < POST_RESPONSE_MAX_ROUNDS; round++) {
      const report = await tickOnce({
        transport,
        batchLimit: POST_RESPONSE_BATCH_LIMIT,
        // Retention/minimization housekeeping stays on the cron backstop: an
        // interactive webhook reply must not wait behind a cleanup pass.
        cleanup: false,
      });
      if (report.claimed === 0) break;
    }
  } catch (err) {
    // Webhook responses are already sent; a failed fast path is logged and the
    // pending job is picked up by the backstop on its next run.
    console.error('[webhook/telegram] post-response tick failed (backstop will retry):', err);
  }
}

/**
 * Defers the bounded tick until after the webhook response has been sent.
 * `after()` is Next's dynamic API for exactly this; calling it outside a
 * request scope (tests, scripts) throws, which is caught here so the caller's
 * response is unaffected — the cron backstop owns those jobs anyway.
 */
export function schedulePostResponseTick(): void {
  try {
    after(() => runPostResponseTick());
  } catch (err) {
    console.warn(
      '[webhook/telegram] after() unavailable (no request scope) — relying on the worker-tick backstop:',
      err instanceof Error ? err.message : err,
    );
  }
}
