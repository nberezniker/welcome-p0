import { after } from 'next/server';
import { selectTransport } from '../integrations/telegram';
import type { ChannelTransport } from '../integrations/telegram/transport';
import { appEnv } from '../lib/env';
import { log } from '../lib/logger';
import { tickOnce, type JobErrorReporter } from './worker';

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

/** Runs the bounded post-response drain. Never throws.
 *
 * `reportJobError` is the worker's injectable reporter (see JobErrorReporter in
 * infra/worker.ts): omitted in production — where the default console.error is
 * what an operator needs — and supplied by the one test that breaks a transport
 * on purpose, so that expected stack trace does not bury the gate output. */
export async function runPostResponseTick(
  deps: { transport?: ChannelTransport; reportJobError?: JobErrorReporter } = {},
): Promise<void> {
  try {
    const transport = deps.transport ?? (await selectTransport());
    for (let round = 0; round < POST_RESPONSE_MAX_ROUNDS; round++) {
      const report = await tickOnce({
        transport,
        batchLimit: POST_RESPONSE_BATCH_LIMIT,
        // Retention/minimization housekeeping stays on the cron backstop: an
        // interactive webhook reply must not wait behind a cleanup pass.
        cleanup: false,
        // Same for the Phase-4 follow-up scan: it is bounded, but it is not part
        // of answering the user who just wrote to the bot. The scheduled tick
        // owns it, and until then the scan's own flags keep it inert anyway.
        followupScan: false,
        reportJobError: deps.reportJobError,
      });
      if (report.claimed === 0) break;
    }
  } catch (err) {
    // Webhook responses are already sent; a failed fast path is logged and the
    // pending job is picked up by the backstop on its next run. No recipient,
    // chat or payload travels with the line — the outbox row id is enough to
    // find the job.
    log.error('[webhook/telegram] post-response tick failed (backstop will retry)', {
      event: 'post_response_tick_failed',
      err,
    });
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
    // `after()` throws precisely when there is no request scope — a script, or
    // any integration test driving this route handler directly (the same
    // situation `captureAfter()` in tests/integration/telegram-webhook-after.test.ts
    // emulates). There the worker-tick backstop is the documented, expected
    // answer rather than an anomaly, and the note was printed dozens of times
    // per gate run. In production it means a real misconfiguration — this route
    // is always invoked in a request scope — so it stays loud exactly there.
    if (appEnv() === 'production') {
      log.warn('[webhook/telegram] after() unavailable (no request scope) — relying on the worker-tick backstop', {
        event: 'after_unavailable',
        err,
      });
    }
  }
}
