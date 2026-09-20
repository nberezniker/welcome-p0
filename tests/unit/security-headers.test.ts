import test from 'node:test';
import assert from 'node:assert/strict';
import nextConfig from '../../next.config';

/**
 * Static gate (unit): the response header set `next.config.ts` actually
 * declares, read from the config object itself.
 *
 * The e2e smoke asserts that the headers REACH the wire (tests/e2e/smoke.spec.ts,
 * F-04); this file asserts what the app DECIDES, including one deliberate
 * absence that a rendered page can never prove:
 *
 *   Strict-Transport-Security is not set by the app. Measured on the live
 *   deployment (2026-09-20, `curl -sI`):
 *     https://welcome.colmogravity.net → max-age=63072000
 *     https://welcome-p0.vercel.app    → max-age=63072000; includeSubDomains; preload
 *   Vercel injects it at the edge for every HTTPS response, with a different
 *   value per zone. Declaring it here as well would put two HSTS headers with
 *   different parameters on the same response; RFC 6797 has a client process
 *   each independently, so what a browser ends up enforcing would depend on the
 *   reader. The platform already owns the directive, so the app must not
 *   duplicate it — and that decision is what the assertion below pins, so a
 *   later "let's add HSTS too" cannot land silently.
 *
 * `nosniff` is the opposite case: measured absent on both hosts, and it is the
 * app's own business (only the app knows the Content-Type it sent).
 */

interface HeaderRule {
  source: string;
  headers: { key: string; value: string }[];
}

/** Resolves the configured header rules regardless of which shape the file uses. */
async function headerRules(): Promise<HeaderRule[]> {
  const configured = nextConfig.headers as unknown;
  assert.ok(configured, 'next.config.ts must declare headers()');
  const rules =
    typeof configured === 'function'
      ? await (configured as () => Promise<HeaderRule[]> | HeaderRule[]).call(nextConfig)
      : await (configured as Promise<HeaderRule[]>);
  assert.ok(Array.isArray(rules) && rules.length > 0, 'headers() must return at least one rule');
  return rules;
}

/** HTTP header names are case-insensitive; the lookup must be too. */
function headerValue(rule: HeaderRule, name: string): string | undefined {
  const wanted = name.toLowerCase();
  return rule.headers.find((h) => h.key.toLowerCase() === wanted)?.value;
}

/** Every header the whole config emits, lowercased name → first value. */
function allHeaders(rules: HeaderRule[]): Map<string, string> {
  const all = new Map<string, string>();
  for (const rule of rules) {
    for (const { key, value } of rule.headers) {
      const lower = key.toLowerCase();
      if (!all.has(lower)) all.set(lower, value);
    }
  }
  return all;
}

test('security headers: the config applies to every path', async () => {
  const rules = await headerRules();
  assert.ok(
    rules.some((r) => r.source === '/:path*'),
    `no catch-all header rule; sources: ${rules.map((r) => r.source).join(', ')}`,
  );
});

test('security headers: X-Content-Type-Options is nosniff on every path', async () => {
  const rules = await headerRules();
  const catchAll = rules.find((r) => r.source === '/:path*');
  assert.ok(catchAll);
  assert.equal(headerValue(catchAll, 'x-content-type-options'), 'nosniff');
});

test('security headers: HSTS is left to the platform that terminates TLS', async () => {
  const rules = await headerRules();
  // Not "missing" — delegated on purpose. See the module comment for the measured
  // values and the duplication hazard; the platform covers every HTTPS response,
  // including the ones this app never renders.
  assert.equal(
    allHeaders(rules).get('strict-transport-security'),
    undefined,
    'the app must not duplicate the platform HSTS header (see this file\'s header comment)',
  );
});

test('security headers: the rest of the posture is still declared', async () => {
  const rules = await headerRules();
  const headers = allHeaders(rules);

  assert.equal(headers.get('x-frame-options'), 'DENY');
  assert.equal(headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.match(headers.get('permissions-policy') ?? '', /camera=\(\)/);

  // The CSP is asserted on its lock-down directives only: whether 'unsafe-eval'
  // is present depends on NODE_ENV (React Refresh in `next dev`), and the e2e
  // smoke covers the production shape.
  const csp = headers.get('content-security-policy') ?? '';
  for (const directive of [
    "default-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ]) {
    assert.ok(csp.includes(directive), `CSP must keep ${directive}; got: ${csp}`);
  }
  assert.ok(!csp.includes("script-src 'self' 'unsafe-inline' 'unsafe-eval'") || process.env.NODE_ENV !== 'production',
    'eval must never be allowed in a production CSP');
});
