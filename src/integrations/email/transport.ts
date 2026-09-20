/**
 * Resend email transport (F-01): OTP delivery over the Resend REST API.
 * HTTPS via global fetch to https://api.resend.com/emails — no new dependencies.
 * Credentials come from env at construction (RESEND_API_KEY / RESEND_FROM) —
 * never hardcoded.
 *
 * Outcome mapping (mirrors the Telegram adapter):
 *   2xx + id                 → 'sent'   (provider ACCEPTED; never claim 'delivered')
 *   HTTP 429                 → 'unknown' + code 'rate_limited' + Retry-After
 *   HTTP other 4xx           → 'failed' (permanent, no retry)
 *   HTTP 5xx / timeout / network error / no response → 'unknown'
 */

import {
  defaultFetch,
  isTimeoutError,
  timeoutSignal,
  type FetchLike,
  type OutboundTransportOptions,
} from '../../lib/outbound';

export interface EmailSendTask {
  /** Recipient address. The caller passes only what the provider needs. */
  to: string;
  /** Plain-text subject. No HTML, no private contact values. */
  subject: string;
  /** Plain-text body. */
  text: string;
  /** Raw OTP for the dev log transport (`.runtime/otp.log` keeps the historical
   * `iso\temail\tcode` line format). The Resend transport ignores this field. */
  otpCode?: string;
}

export interface EmailSendResult {
  providerMessageId?: string;
  state: 'sent' | 'failed' | 'unknown';
  code?: string;
  /** Present on 429: the provider's Retry-After value in seconds. */
  retryAfterSeconds?: number;
}

export interface EmailTransport {
  readonly name: string;
  send(task: EmailSendTask): Promise<EmailSendResult>;
}

/**
 * Per-call bound for one Resend request. A message that has not been accepted
 * within this window is reported as a retryable `timeout` (the worker then
 * applies its backoff) rather than holding the request or the tick — the
 * mechanism and its rationale live in src/lib/outbound.ts.
 */
const REQUEST_TIMEOUT_MS = 10_000;

/** The Resend endpoint. Kept as a constant so the host is pinned in one place
 * (tests/unit/static-safety.test.ts asserts this file names it explicitly). */
const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export class ResendEmailTransport implements EmailTransport {
  readonly name = 'resend';
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    /** Test seam only — see OutboundTransportOptions. */
    options: OutboundTransportOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? defaultFetch;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  async send(task: EmailSendTask): Promise<EmailSendResult> {
    let res: Response;
    try {
      res = await this.fetchImpl(RESEND_ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ from: this.from, to: [task.to], subject: task.subject, text: task.text }),
        signal: timeoutSignal(this.timeoutMs),
      });
    } catch (err) {
      return { state: 'unknown', code: isTimeoutError(err) ? 'timeout' : 'network_error' };
    }

    if (res.status === 429) {
      const ra = res.headers.get('retry-after');
      const retryAfterSeconds = ra !== null && /^\d+$/.test(ra) ? parseInt(ra, 10) : undefined;
      return { state: 'unknown', code: 'rate_limited', retryAfterSeconds };
    }

    interface ResendApiResult {
      id?: string;
      message?: string;
    }
    let body: ResendApiResult | null = null;
    try {
      body = (await res.json()) as ResendApiResult;
    } catch {
      // non-JSON body — fall through to status-based mapping
    }

    if (res.ok && typeof body?.id === 'string') {
      return { state: 'sent', providerMessageId: body.id };
    }
    if (res.status >= 500) {
      return { state: 'unknown', code: 'resend_http_5xx' };
    }
    // 4xx: permanent — retrying with the same payload cannot succeed.
    return { state: 'failed', code: `resend_http_${res.status}` };
  }
}
