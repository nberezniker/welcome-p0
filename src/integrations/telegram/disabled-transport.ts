import type { ChannelTransport, TransportResult } from './transport';

/**
 * Disabled transport: the channel has no credentials (or mock mode is off).
 * Jobs are FAILED with code 'channel_disabled' — a clear, auditable terminal
 * state. We NEVER silently drop or pretend success, and never fall back to a
 * mock outside the explicit dev/mock gate.
 */
export class DisabledTransport implements ChannelTransport {
  readonly name = 'telegram_disabled';

  async send(): Promise<TransportResult> {
    return { state: 'failed', code: 'channel_disabled' };
  }
}
