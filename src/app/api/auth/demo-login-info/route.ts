import { NextResponse } from 'next/server';

/**
 * Demo-login discovery for the login page.
 *
 * The login form needs to know two things before rendering: whether the
 * demo-OTP fallback (AUTH_EXPOSE_DEMO_OTP, see docs-internal/adr/
 * 0009-dev-otp-exposure-staging.md for the staging-allowlist sibling) is live,
 * and which synthetic address to prefill. The flag is read per request — the
 * route is force-dynamic and answers `no-store` — so flipping the env var on a
 * running deployment takes effect without a rebuild and no CDN ever caches a
 * "demo enabled" answer.
 */
export const dynamic = 'force-dynamic';

/** The synthetic account seeded by scripts/seed-demo.mts (is_demo = true). */
const DEMO_EMAIL = 'demo1@welcome.test';

export async function GET(): Promise<NextResponse> {
  const demoLoginEnabled = process.env.AUTH_EXPOSE_DEMO_OTP === 'true';
  return NextResponse.json(
    {
      demoLoginEnabled,
      // The address is only disclosed when the flow can actually complete;
      // otherwise the endpoint stays a bare boolean.
      demoEmail: demoLoginEnabled ? DEMO_EMAIL : null,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
