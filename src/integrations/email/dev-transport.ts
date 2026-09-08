import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { EmailSendTask, EmailSendResult, EmailTransport } from './transport';

/**
 * Development-only transport (F-01): writes the OTP to the gitignored
 * `.runtime/otp.log` exactly like the pre-F-01 dev path did. Selected ONLY
 * when RESEND_API_KEY is absent AND APP_ENV !== 'production' — never on a
 * serverless production filesystem (read-only → the old unconditional write
 * was the 500 in F-01).
 */
export class DevOtpLogTransport implements EmailTransport {
  readonly name = 'dev_otp_log';

  async send(task: EmailSendTask): Promise<EmailSendResult> {
    const dir = path.join(process.cwd(), '.runtime');
    await mkdir(dir, { recursive: true });
    // Historical line format (unchanged since before F-01): iso \t email \t code
    await appendFile(path.join(dir, 'otp.log'), `${new Date().toISOString()}\t${task.to}\t${task.otpCode ?? task.text}\n`, 'utf8');
    return { state: 'sent' };
  }
}
