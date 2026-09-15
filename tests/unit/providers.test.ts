import test from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDERS, PROVIDER_IDS, REQUIRED_ENV, providerById } from '../../src/domain/providers';
import {
  processEnvLookup,
  publicProvider,
  resolveProviderStatus,
  resolveProviders,
  type EnvLookup,
} from '../../src/lib/provider-status';
import { en, type Dictionary } from '../../src/i18n/en';
import { ru } from '../../src/i18n/ru';
import { es } from '../../src/i18n/es';

/**
 * Provider registry (docs-internal/product/SOCIAL_INTEROP_AND_MATCHING.md §A2/§A3).
 * The snapshot below IS the contract: a row can only change here on purpose.
 */

const EXPECTED_ROWS = [
  { id: 'telegram', kind: 'channel', auth: 'bot', capabilities: ['send', 'receive', 'deeplink'], direction: 'both', status: 'live', reason_code: null, env: ['TELEGRAM_BOT_TOKEN'] },
  { id: 'email', kind: 'channel', auth: 'api-key', capabilities: ['send'], direction: 'out', status: 'live', reason_code: null, env: ['RESEND_API_KEY'] },
  { id: 'vcard', kind: 'contacts', auth: 'none', capabilities: ['import', 'export'], direction: 'both', status: 'live', reason_code: null, env: [] },
  { id: 'csv', kind: 'contacts', auth: 'none', capabilities: ['import', 'export'], direction: 'both', status: 'live', reason_code: null, env: [] },
  { id: 'ics', kind: 'calendar', auth: 'none', capabilities: ['export', 'deeplink'], direction: 'out', status: 'planned', reason_code: 'not_implemented', env: [] },
  { id: 'share-deeplinks', kind: 'publish', auth: 'none', capabilities: ['publish'], direction: 'out', status: 'planned', reason_code: 'not_implemented', env: [] },
  { id: 'google-contacts', kind: 'contacts', auth: 'oauth', capabilities: ['import', 'export'], direction: 'both', status: 'planned', reason_code: 'needs_oauth_client', env: ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET'] },
  { id: 'google-calendar', kind: 'calendar', auth: 'oauth', capabilities: ['import', 'export'], direction: 'both', status: 'planned', reason_code: 'needs_oauth_client', env: ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET'] },
  { id: 'microsoft-people', kind: 'contacts', auth: 'oauth', capabilities: ['import', 'export'], direction: 'both', status: 'planned', reason_code: 'needs_oauth_client', env: ['MICROSOFT_OAUTH_CLIENT_ID', 'MICROSOFT_OAUTH_CLIENT_SECRET'] },
  { id: 'github', kind: 'contacts', auth: 'oauth', capabilities: ['import'], direction: 'in', status: 'planned', reason_code: 'needs_oauth_client', env: ['GITHUB_OAUTH_CLIENT_ID', 'GITHUB_OAUTH_CLIENT_SECRET'] },
  { id: 'linkedin', kind: 'publish', auth: 'oauth', capabilities: ['publish'], direction: 'out', status: 'disabled', reason_code: 'policy_restricted', env: ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET'] },
  { id: 'whatsapp', kind: 'channel', auth: 'deeplink', capabilities: ['deeplink', 'send'], direction: 'out', status: 'planned', reason_code: 'not_implemented', env: [] },
  { id: 'instagram', kind: 'publish', auth: 'none', capabilities: ['publish'], direction: 'out', status: 'disabled', reason_code: 'policy_restricted', env: [] },
  { id: 'x', kind: 'publish', auth: 'none', capabilities: ['publish'], direction: 'out', status: 'disabled', reason_code: 'policy_restricted', env: [] },
  { id: 'luma', kind: 'directory', auth: 'api-key', capabilities: ['import'], direction: 'in', status: 'disabled', reason_code: 'awaiting_access', env: ['LUMA_API_KEY'] },
] as const;

const ENV_WITH_EVERYTHING: EnvLookup = () => 'sentinel-value-kept-out-of-payload';
const ENV_WITH_NOTHING: EnvLookup = () => undefined;

test('registry: rows match the §A3 table exactly, in table order', () => {
  const actual = PROVIDERS.map((p) => ({
    id: p.id,
    kind: p.kind,
    auth: p.auth,
    capabilities: [...p.capabilities],
    direction: p.direction,
    status: p.status,
    reason_code: p.reason_code,
    env: [...p.setup.env],
  }));
  assert.deepEqual(actual, EXPECTED_ROWS.map((r) => ({ ...r, capabilities: [...r.capabilities], env: [...r.env] })));
  assert.deepEqual([...PROVIDER_IDS], EXPECTED_ROWS.map((r) => r.id));
});

test('registry: every i18n-keyed step exists in all three dictionaries', () => {
  const dicts: Record<string, Partial<Dictionary>> = { en, ru, es };
  for (const provider of PROVIDERS) {
    assert.ok(provider.setup.steps.length > 0, `${provider.id} must document at least one step`);
    for (const key of provider.setup.steps) {
      for (const [locale, dict] of Object.entries(dicts)) {
        assert.ok(key in dict, `${provider.id}: ${key} missing from ${locale}`);
      }
    }
  }
});

test('registry: direction is exactly what the capability set implies', () => {
  const OUT: readonly string[] = ['send', 'export', 'publish', 'deeplink'];
  const IN: readonly string[] = ['receive', 'import'];
  for (const provider of PROVIDERS) {
    const hasOut = provider.capabilities.some((c) => OUT.includes(c));
    const hasIn = provider.capabilities.some((c) => IN.includes(c));
    const expected = hasOut && hasIn ? 'both' : hasIn ? 'in' : 'out';
    assert.equal(provider.direction, expected, `${provider.id}: direction must follow capabilities`);
    // Structural reading of A1.2: without an API there is nothing to receive.
    assert.ok(
      !(provider.auth === 'none' || provider.auth === 'deeplink') || !provider.capabilities.includes('receive'),
      `${provider.id}: no API, no receive`,
    );
  }
});

test('registry: providerById resolves registered ids and rejects unregistered ones', () => {
  assert.equal(providerById('telegram')?.status, 'live');
  // Declared in the ProviderId union, deliberately absent from the §A3 table.
  assert.equal(providerById('notion'), null);
});

test('resolver: a live env-gated provider without its variable is disabled + not_configured', () => {
  const telegram = providerById('telegram')!;
  const email = providerById('email')!;

  assert.deepEqual(resolveProviderStatus(telegram, ENV_WITH_EVERYTHING), {
    status: 'live',
    reason_code: null,
    missing_env: [],
  });
  assert.deepEqual(resolveProviderStatus(telegram, ENV_WITH_NOTHING), {
    status: 'disabled',
    reason_code: 'not_configured',
    missing_env: ['TELEGRAM_BOT_TOKEN'],
  });
  assert.deepEqual(resolveProviderStatus(email, ENV_WITH_NOTHING), {
    status: 'disabled',
    reason_code: 'not_configured',
    missing_env: ['RESEND_API_KEY'],
  });
});

test('resolver: only telegram and email are env-gated; the gate names live in REQUIRED_ENV', () => {
  assert.deepEqual(Object.keys(REQUIRED_ENV).sort(), ['email', 'telegram']);
  // A provider with no env dependency keeps its registry status under any env.
  for (const provider of PROVIDERS) {
    if (provider.id === 'telegram' || provider.id === 'email') continue;
    assert.deepEqual(resolveProviderStatus(provider, ENV_WITH_NOTHING), {
      status: provider.status,
      reason_code: provider.reason_code,
      missing_env: [],
    });
  }
});

test('resolver: planned and disabled are design states — configuration cannot flip them', () => {
  const linkedin = providerById('linkedin')!;
  const luma = providerById('luma')!;
  assert.equal(resolveProviderStatus(linkedin, ENV_WITH_EVERYTHING).status, 'disabled');
  assert.equal(resolveProviderStatus(linkedin, ENV_WITH_EVERYTHING).reason_code, 'policy_restricted');
  assert.equal(resolveProviderStatus(luma, ENV_WITH_EVERYTHING).status, 'disabled');
  assert.equal(resolveProviderStatus(luma, ENV_WITH_EVERYTHING).reason_code, 'awaiting_access');
  assert.equal(providerById('ics')!.status, 'planned');
});

test('resolver: processEnvLookup treats unset and blank variables as missing', () => {
  const name = 'PROVIDER_STATUS_TEST_VALUE';
  try {
    delete process.env[name];
    assert.equal(processEnvLookup(name), undefined);
    process.env[name] = '   ';
    assert.equal(processEnvLookup(name), undefined);
    process.env[name] = 'x';
    assert.equal(processEnvLookup(name), 'x');
  } finally {
    delete process.env[name];
  }
});

test('payload: exposes exactly the allowlisted fields and never an env VALUE', () => {
  const sentinel = 'sentinel-secret-value-that-must-not-leak';
  const payload = resolveProviders(() => sentinel);
  const raw = JSON.stringify(payload);

  assert.equal(payload.length, PROVIDERS.length);
  const allowed = new Set(['id', 'kind', 'auth', 'capabilities', 'direction', 'status', 'reason_code', 'missing_env', 'env']);
  for (const item of payload) {
    for (const key of Object.keys(item)) assert.ok(allowed.has(key), `unexpected field: ${key}`);
  }
  // Env NAMES travel; values never do — even when every variable is "set".
  assert.equal(raw.includes(sentinel), false);
  assert.equal(raw.includes('TELEGRAM_BOT_TOKEN'), true);

  for (const provider of PROVIDERS) {
    const item = publicProvider(provider, () => sentinel);
    assert.deepEqual(item.env, [...provider.setup.env]);
    assert.equal(item.status, provider.status === 'live' ? 'live' : provider.status);
  }
});
