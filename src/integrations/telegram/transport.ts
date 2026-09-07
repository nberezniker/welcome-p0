/**
 * Telegram Bot API transport (P0: sendMessage only, plain text, no parse mode).
 * HTTPS via global fetch to https://api.telegram.org/bot<token>/sendMessage.
 * Token comes from TELEGRAM_BOT_TOKEN at construction — never hardcoded.
 *
 * Outcome mapping (spec 04 §7):
 *   2xx + ok:true            → 'sent'   (provider ACCEPTED; never claim 'delivered')
 *   HTTP 429                 → 'unknown' + code 'rate_limited' + Retry-After (AC-43)
 *   HTTP 400/401/403/404/409 → 'failed' (permanent, no retry)
 *   HTTP 5xx / timeout / network error / no response → 'unknown' (capped retries, AC-42)
 */

export interface TransportSendTask {
  jobId: string;
  /** Resolved external channel id (Telegram chat id as string). */
  chatId: string;
  /** Final message text. No private contact values, no HTML. */
  text: string;
}

export interface TransportResult {
  providerMessageId?: string;
  state: 'sent' | 'failed' | 'unknown';
  code?: string;
  /** Present on 429: the provider's Retry-After value in seconds. */
  retryAfterSeconds?: number;
}

export interface ChannelTransport {
  readonly name: string;
  send(task: TransportSendTask): Promise<TransportResult>;
}

const REQUEST_TIMEOUT_MS = 10_000;

export class TelegramTransport implements ChannelTransport {
  readonly name = 'telegram_bot_api';

  constructor(private readonly token: string) {}

  async send(task: TransportSendTask): Promise<TransportResult> {
    const url = `https://api.telegram.org/bot${this.token}/sendMessage`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: task.chatId, text: task.text }),
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

    interface TelegramApiResult {
      ok?: boolean;
      result?: { message_id?: number };
      description?: string;
    }
    let body: TelegramApiResult | null = null;
    try {
      body = (await res.json()) as TelegramApiResult;
    } catch {
      // non-JSON body — fall through to status-based mapping
    }

    if (res.ok && body?.ok === true && typeof body.result?.message_id === 'number') {
      return { state: 'sent', providerMessageId: String(body.result.message_id) };
    }
    if (res.status >= 500) {
      return { state: 'unknown', code: 'tg_http_5xx' };
    }
    // 4xx: permanent — retrying with the same payload cannot succeed.
    return { state: 'failed', code: `tg_http_${res.status}` };
  }
}
