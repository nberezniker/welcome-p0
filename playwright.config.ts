import { defineConfig } from '@playwright/test';

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
      HASH_PEPPER: 'e2e-pepper-0123456789abcdef',
      ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
      APP_BASE_URL: baseURL,
      TELEGRAM_WEBHOOK_SECRET: 'e2e-telegram-webhook-secret',
      TELEGRAM_BOT_USERNAME: 'WELCOME_e2e_bot',
    },
  },
});
