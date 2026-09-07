// TEST ONLY — CI fails if enabled in production build.
// This transport records sends in memory and replays scripted outcomes.
// It MUST only be selected by selectTransport() when APP_ENV !== 'production'
// AND TELEGRAM_MOCK=1. Never import it from production code paths — only the
// worker/route wiring (via selectTransport) and test files may reference it.
import type { ChannelTransport, TransportResult, TransportSendTask } from './transport';

export class MockTelegramTransport implements ChannelTransport {
  readonly name = 'telegram_mock';

  /** Scripted outcomes consumed FIFO per send(); when empty, sends succeed. */
  public readonly script: TransportResult[] = [];
  /** Every send() call, for assertions. */
  public readonly sent: TransportSendTask[] = [];

  constructor(script: TransportResult[] = []) {
    script.forEach((r) => this.script.push(r));
  }

  async send(task: TransportSendTask): Promise<TransportResult> {
    this.sent.push(task);
    const next = this.script.shift();
    if (next) return { ...next, providerMessageId: next.providerMessageId ?? `mock-${this.sent.length}` };
    return { state: 'sent', providerMessageId: `mock-${this.sent.length}` };
  }

  /** Number of actual send attempts (for AC-42 cap assertions). */
  get sendCount(): number {
    return this.sent.length;
  }
}
