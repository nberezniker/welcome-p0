import test from 'node:test';
import assert from 'node:assert/strict';
import { buildId, healthVersionExposed } from '../../src/lib/build-identity';

/**
 * The flag that decides whether GET /api/health publishes a deployment identity.
 *
 * Pinned here because the safe direction matters more than the feature: the
 * project deliberately stopped publishing `migration_version` publicly (F-16),
 * and this is the one field that reopens that door. Every value other than the
 * exact string 'true' must leave it closed.
 */

const ENV = process.env as unknown as Record<string, string | undefined>;

function withEnv(vars: Record<string, string | undefined>, body: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, ENV[key]);
    if (value === undefined) delete ENV[key];
    else ENV[key] = value;
  }
  try {
    body();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete ENV[key];
      else ENV[key] = value;
    }
  }
}

test('build identity: only the exact string "true" enables it', () => {
  withEnv({ HEALTH_EXPOSE_VERSION: undefined }, () => assert.equal(healthVersionExposed(), false));
  for (const value of ['true', 'TRUE', 'True', '1', 'yes', 'on', '', ' true']) {
    withEnv({ HEALTH_EXPOSE_VERSION: value }, () => {
      assert.equal(healthVersionExposed(), value === 'true', `HEALTH_EXPOSE_VERSION=${JSON.stringify(value)}`);
    });
  }
});

test('build identity: the value is the operator\'s, never invented', () => {
  withEnv({ APP_BUILD_ID: 'gitsha-abc123' }, () => assert.equal(buildId(), 'gitsha-abc123'));
  // Whitespace-only and empty are null, not '' — a blank string in a monitoring
  // payload reads as a fact.
  withEnv({ APP_BUILD_ID: '   ' }, () => assert.equal(buildId(), null));
  withEnv({ APP_BUILD_ID: '' }, () => assert.equal(buildId(), null));
  withEnv({ APP_BUILD_ID: undefined }, () => assert.equal(buildId(), null));
  // Trimmed, so a value pasted with padding still matches what the operator set.
  withEnv({ APP_BUILD_ID: '  gitsha-abc123\n' }, () => assert.equal(buildId(), 'gitsha-abc123'));
});
