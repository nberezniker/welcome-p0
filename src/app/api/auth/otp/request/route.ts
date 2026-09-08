import { NextRequest, NextResponse } from 'next/server';
import { getSql } from '../../../../../lib/db';
import { appEnv, devExposeOtp, requireHashPepper } from '../../../../../lib/env';
import { emailLookupHash, generateOtpCode, hashOtpCode } from '../../../../../lib/crypto';
import { internalError, jsonError, jsonOk, normalizeEmail, readJsonBody, withApi } from '../../../../../lib/http';
import { otpEmailTask, planOtpDelivery, selectEmailTransport } from '../../../../../integrations/email';

/** OTP request throttling: max codes per account within the window. */
const OTP_REQUEST_WINDOW_MINUTES = 15;
const OTP_REQUEST_MAX_PER_WINDOW = 3;
const OTP_TTL_MINUTES = 10;

async function postRoute(req: NextRequest) {
  try {
    const body = await readJsonBody(req);
    const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    const email = normalizeEmail(b.email);
    if (!email) {
      return jsonError(400, 'invalid_email', 'A valid email address is required');
    }

    const pepper = requireHashPepper();
    const sql = getSql();
    const lookupHash = emailLookupHash(email, pepper);

    // Create the account if absent (status active). Enumeration-safe: same response either way.
    let rows = await sql<{ id: string; is_demo: boolean }[]>`
      INSERT INTO accounts (auth_subject, email_lookup_hash)
      VALUES (${'email:' + lookupHash}, ${lookupHash})
      ON CONFLICT (auth_subject) DO NOTHING
      RETURNING id, is_demo
    `;
    if (rows.length === 0) {
      rows = await sql<{ id: string; is_demo: boolean }[]>`
        SELECT id, is_demo FROM accounts WHERE email_lookup_hash = ${lookupHash} LIMIT 1
      `;
    }
    const account = rows[0];
    if (!account) {
      // Should not happen; fail closed without leaking details.
      return jsonError(500, 'internal_error', 'Unexpected error. Please retry later.', { retryable: true });
    }

    // Throttle OTP requests per account.
    const recent = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM auth_otp_codes
      WHERE account_id = ${account.id}
        AND created_at > now() - (${OTP_REQUEST_WINDOW_MINUTES} * interval '1 minute')
    `;
    const recentCount = recent[0]?.count ?? 0;
    if (recentCount >= OTP_REQUEST_MAX_PER_WINDOW) {
      return jsonError(429, 'rate_limited', 'Too many codes requested. Try again later.', {
        retryable: true,
        headers: { 'Retry-After': String(OTP_REQUEST_WINDOW_MINUTES * 60) },
      });
    }

    const code = generateOtpCode();
    const codeHash = hashOtpCode(code, pepper);

    await sql.begin(async (tx) => {
      // Only the newest code stays valid.
      await tx`
        UPDATE auth_otp_codes
        SET consumed_at = now()
        WHERE account_id = ${account.id} AND consumed_at IS NULL
      `;
      await tx`
        INSERT INTO auth_otp_codes (account_id, code_hash, expires_at)
        VALUES (${account.id}, ${codeHash}, now() + (${OTP_TTL_MINUTES} * interval '1 minute'))
      `;
    });

    // F-01 delivery decision (matrix + demo fallback — see
    // src/integrations/email/index.ts). The old unconditional writeDevOtpLog
    // (a 500 on Vercel's read-only FS) is gone.
    const plan = planOtpDelivery({
      appEnv: appEnv(),
      resendApiKey: process.env.RESEND_API_KEY,
      devExposeOtp: devExposeOtp(),
      exposeDemoOtp: process.env.AUTH_EXPOSE_DEMO_OTP === 'true',
      isDemo: account.is_demo,
    });

    if (plan.action === 'expose') {
      // dev/tests mechanism or the documented is_demo fallback — code in the response.
      return NextResponse.json({ ok: true, devCode: code });
    }
    if (plan.action === 'reject') {
      // Production without any email provider: honest explicit failure.
      return jsonError(plan.status, plan.code, 'Email delivery is not configured. Please try again later.', {
        retryable: plan.retryable,
      });
    }

    const result = await selectEmailTransport().send(otpEmailTask(email, code));
    if (result.state !== 'sent') {
      // Provider unavailable (or disabled transport slipped through): honest retryable failure.
      return jsonError(503, 'email_send_failed', 'Email delivery is temporarily unavailable. Please try again.', {
        retryable: true,
      });
    }
    // Enumeration-safe success: the code itself is never returned here.
    return jsonOk({ ok: true });
  } catch (err) {
    return internalError(err);
  }
}

export const POST = withApi(postRoute);
