import type { EmailTransport, EmailSendResult } from './transport';

/**
 * Disabled transport (F-01): no email provider is configured in production.
 * Sends FAIL with code 'channel_disabled' — a clear, auditable state. The OTP
 * route maps this to an honest 503 instead of the old silent 500. We NEVER
 * silently drop, never fall back to a dev log on a production filesystem.
 */
export class DisabledEmailTransport implements EmailTransport {
  readonly name = 'email_disabled';

  async send(): Promise<EmailSendResult> {
    return { state: 'failed', code: 'channel_disabled' };
  }
}
