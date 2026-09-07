import type { ChannelTransport } from './transport';
import { TelegramTransport } from './transport';
import { DisabledTransport } from './disabled-transport';

// TEST ONLY — CI fails if enabled in production build.
// The mock transport is loaded lazily behind the env gate so production bundles
// never evaluate mock-transport.ts at module load.
let mockPromise: Promise<ChannelTransport> | null = null;

function loadMock(): Promise<ChannelTransport> {
  if (!mockPromise) {
    mockPromise = import('./mock-transport').then((m) => new m.MockTelegramTransport());
  }
  return mockPromise;
}

export type TransportEnv = Record<string, string | undefined>;

function resolveAppEnv(env: TransportEnv): 'development' | 'test' | 'production' {
  if (env.APP_ENV === 'production' || env.APP_ENV === 'test') return env.APP_ENV;
  return 'development';
}

/**
 * Transport selection matrix (gate: mock ONLY in non-production with TELEGRAM_MOCK=1):
 *   1. TELEGRAM_BOT_TOKEN set            → real Bot API transport (any env)
 *   2. no token, APP_ENV !== production,
 *      TELEGRAM_MOCK=1                   → mock transport (dev/tests only)
 *   3. otherwise (incl. PRODUCTION with
 *      no token)                         → disabled transport: jobs fail with
 *      code 'channel_disabled', never silently dropped, never mocked.
 */
export async function selectTransport(env: TransportEnv = process.env): Promise<ChannelTransport> {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (token && token.length > 0) return new TelegramTransport(token);
  if (resolveAppEnv(env) !== 'production' && env.TELEGRAM_MOCK === '1') return loadMock();
  return new DisabledTransport();
}

/** Deep-link bot username: env TELEGRAM_BOT_USERNAME, dev fallback per brief. */
export function telegramBotUsername(usernameEnv?: string): string {
  const fromEnv = usernameEnv ?? process.env.TELEGRAM_BOT_USERNAME;
  return fromEnv && fromEnv.length > 0 ? fromEnv : 'WELCOME_dev_bot';
}

export { TelegramTransport } from './transport';
export { DisabledTransport } from './disabled-transport';
export type { ChannelTransport, TransportResult, TransportSendTask } from './transport';
