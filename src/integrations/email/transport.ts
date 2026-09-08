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

const REQUEST_TIMEOUT_MS = 10_000;

export class ResendEmailTransport implements EmailTransport {
  readonly name = 'resend';

  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(task: EmailSendTask): Promise<EmailSendResult> {
    let res: Response;
    try {
      res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ from: this.from, to: [task.to], subject: task.subject, text: task.text }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const timedOut = err instanceof Error && err.name === 'TimeoutError';
      return { state: 'unknown', code: timedOut ? 'timeout' : 'network_error' };
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
