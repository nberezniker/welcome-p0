import type { EmailTransport, EmailSendResult, EmailSendTask } from '../../src/integrations/email/transport';

/**
 * TEST-ONLY email transport (ADR 0011): records sends in memory and replays
 * scripted outcomes.
 *
 * Deliberately lives under tests/ rather than src/: the Telegram mock is a src
 * module because `selectTransport()` can lazily load it behind the
 * TELEGRAM_MOCK=1 gate, while notification email has exactly one real provider
 * (Resend) and no mock branch at all — the worker only ever sees a mock through
 * an injected `emailTransport` dependency in tests. Keeping it here means the
 * static gate "mock transport is never statically imported outside tests"
 * stays true without an exemption.
 */
export class MockEmailTransport implements EmailTransport {
  readonly name = 'email_mock';

  /** Scripted outcomes consumed FIFO per send(); when empty, sends succeed. */
  public readonly script: EmailSendResult[] = [];
  /** Every send() call, for assertions. */
  public readonly sent: EmailSendTask[] = [];

  constructor(script: EmailSendResult[] = []) {
    script.forEach((r) => this.script.push(r));
  }

  async send(task: EmailSendTask): Promise<EmailSendResult> {
    this.sent.push(task);
    const next = this.script.shift();
    if (next) return { ...next, providerMessageId: next.providerMessageId ?? `mock-email-${this.sent.length}` };
    return { state: 'sent', providerMessageId: `mock-email-${this.sent.length}` };
  }

  get sendCount(): number {
    return this.sent.length;
  }
}
