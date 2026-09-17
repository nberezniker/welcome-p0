import { defineConfig } from '@playwright/test';
import { E2E_CANONICAL_ORIGIN, E2E_OPERATOR_CONTACT_EMAIL } from './tests/e2e/e2e-env';

const PORT = Number(process.env.E2E_PORT ?? 3111);
const baseURL = `http://127.0.0.1:${PORT}`;
export const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL || 'postgres://localhost:5432/welcome_e2e';

/**
 * E2E smoke: chromium only, against `next dev` on a dedicated welcome_e2e DB.
 * globalSetup resets the schema and applies migrations (deterministic state).
 */
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  globalSetup: './tests/e2e/global-setup.mjs',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'off',
  },
  webServer: {
    command: `pnpm exec next dev -p ${PORT}`,
    url: `${baseURL}/`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      DATABASE_URL: E2E_DATABASE_URL,
      APP_ENV: 'development',
      AUTH_DEV_EXPOSE_OTP: 'true',
      // Demo-login e2e (tests/e2e/demo-login.spec.ts): the "enabled" case needs
      // the REAL flag on the running server, so it is set here rather than
      // mocked. The "disabled" case mocks the discovery endpoint instead.
      AUTH_EXPOSE_DEMO_OTP: 'true',
      // One suite, one IP, ~15 sign-ins inside a minute: the per-IP OTP bucket
      // (10/min, src/lib/http.ts) is a product guard against abuse, not a test
      // fixture, so it is raised for this server only. Ignored when
      // APP_ENV=production, and the integration suite still pins the 10/min
      // default (tests/integration/security-hardening.test.ts).
      RATE_LIMIT_OTP_CAPACITY: '200',
      HASH_PEPPER: 'e2e-pepper-0123456789abcdef',
      ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
      APP_BASE_URL: baseURL,
      // Deployment-coupled values, pinned to synthetic .test fixtures here so
      // the suite never encodes the upstream author's domain or inbox. Both are
      // read at server boot: CANONICAL_ORIGIN by next.config.ts
      // (src/lib/legacy-host-redirect.ts) and OPERATOR_CONTACT_EMAIL by the
      // landing page and the legal pages (src/lib/env.ts).
      CANONICAL_ORIGIN: E2E_CANONICAL_ORIGIN,
      OPERATOR_CONTACT_EMAIL: E2E_OPERATOR_CONTACT_EMAIL,
      TELEGRAM_WEBHOOK_SECRET: 'e2e-telegram-webhook-secret',
      TELEGRAM_BOT_USERNAME: 'WELCOME_e2e_bot',
      // Phase 2 (tests/e2e/connections.spec.ts): the two Google rows are LIVE on
      // this server, so the spec can drive their connect/disconnect controls and
      // the per-user states. The values are deliberately fake and no e2e test ever
      // reaches Google — the flows that would are covered with a mocked transport
      // in tests/integration/google-oauth.test.ts. The UNCONFIGURED branch for
      // these two rows is asserted in tests/integration/connections.test.ts, for
      // the same reason the followup flags below are split: a second env
      // configuration would need a second `next dev` sharing one `.next` dir.
      GOOGLE_OAUTH_CLIENT_ID: 'e2e-client-id.apps.googleusercontent.com',
      GOOGLE_OAUTH_CLIENT_SECRET: 'e2e-client-secret-never-sent-to-google',
      // Phase 4 (tests/e2e/followup.spec.ts): the reminder mechanic is ON so its
      // opt-in switch can be driven end-to-end, while the digest flag is
      // deliberately LEFT UNSET so the same server also proves the other half of
      // the rule — flag off ⇒ no switch rendered and the endpoint answers 404.
      // "Both flags off ⇒ the whole card is absent" is asserted at the API level
      // in tests/integration/followup-digest.test.ts: it needs a second server
      // without both flags, and two `next dev` processes for one project
      // directory would share a single `.next` build dir.
      FOLLOWUP_REMINDERS_ENABLED: 'true',
    },
  },
});
