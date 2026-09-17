import test from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { buildCustomRoute } from 'next/dist/lib/build-custom-route.js';
import { getRedirectStatus } from 'next/dist/lib/redirect-status.js';
import { matchHas } from 'next/dist/shared/lib/router/utils/prepare-destination.js';
import {
  CANONICAL_ORIGIN,
  DEFAULT_CANONICAL_ORIGIN,
  LEGACY_HOSTS,
  LEGACY_REDIRECT_SOURCE,
  canonicalOrigin,
  exactHostPattern,
  legacyHostRedirects,
  legacyHosts,
  legacyRedirectsEnabled,
} from '../../src/lib/legacy-host-redirect';

/**
 * Legacy-host redirect rules (Gap 2). These assertions run the rules through
 * Next's OWN primitives — the compiler that turns a `source` into a matcher
 * (`buildCustomRoute`), the host matcher the request path uses (`matchHas`) and
 * the status mapping (`getRedirectStatus`) — so the test pins the behaviour a
 * request actually gets, not a private re-implementation of it.
 *
 * The end-to-end half (a real request with a spoofed Host header) lives in
 * tests/e2e/legacy-host-redirect.spec.ts.
 */

const rules = legacyHostRedirects();

/** A request stand-in: matchHas reads only `headers` and the presence of cookies. */
function requestWithHost(host: string): IncomingMessage {
  return { headers: { host } } as unknown as IncomingMessage;
}

function routeFor(index: number) {
  const rule = rules[index];
  assert.ok(rule, `rule ${index} must exist`);
  // Same restricted paths Next itself passes when compiling redirect manifests.
  return buildCustomRoute('redirect', rule, ['/_next/']);
}

/** The compiled matcher a request is tested against (the manifest stores it as a
 * string; the server wraps it back into a RegExp). */
function matcherFor(index: number): RegExp {
  const route = routeFor(index);
  assert.equal(typeof route.regex, 'string');
  return new RegExp(route.regex);
}

test('legacy hosts: one rule per host, both hosts covered, no wildcard', () => {
  assert.deepEqual(
    rules.map((rule) => rule.has?.[0]?.value),
    LEGACY_HOSTS.map(exactHostPattern),
  );
  // Every legacy host is listed once and only the legacy hosts are.
  assert.deepEqual([...LEGACY_HOSTS], ['welcome-p0-nikiti4.vercel.app', 'welcome-p0.vercel.app']);
  assert.equal(new Set(LEGACY_HOSTS).size, LEGACY_HOSTS.length);
});

test('legacy hosts: matching is exact — a lookalike host is not redirected', () => {
  const has = rules[0]?.has;
  assert.ok(has);

  // The real host, with and without the port a client may append.
  assert.ok(matchHas(requestWithHost('welcome-p0-nikiti4.vercel.app'), {}, has));
  assert.ok(matchHas(requestWithHost('welcome-p0-nikiti4.vercel.app:443'), {}, has));
  assert.ok(matchHas(requestWithHost('WELCOME-P0-NIKITI4.VERCEL.APP'), {}, has));

  // Next anchors the value with ^…$ but does not escape regex metacharacters,
  // so an unescaped host pattern would also match these. Escaping is what keeps
  // "exactly this host" true.
  for (const lookalike of [
    'welcome-p0-nikiti4.vercel.app.evil.test',
    'evil.welcome-p0-nikiti4.vercel.app',
    'welcome-p0Xnikiti4.vercel.app',
    'welcome-p0-nikiti4Xvercel.app',
    'welcome-p0-nikiti4.vercelXapp',
  ]) {
    assert.equal(
      matchHas(requestWithHost(lookalike), {}, has),
      false,
      `${lookalike} must not match the legacy host rule`,
    );
  }
});

test('canonical domain and other preview hosts are never redirected', () => {
  const hasList = rules.map((rule) => rule.has);
  for (const host of [
    'welcome.colmogravity.net',
    'welcome-p0-git-feature-previews.vercel.app',
    'welcome-p0-abc123.vercel.app',
    'localhost:3000',
  ]) {
    for (const has of hasList) {
      assert.equal(matchHas(requestWithHost(host), {}, has), false, `${host} must not be redirected`);
    }
  }
  // The canonical origin is not itself a legacy host.
  assert.equal(new URL(CANONICAL_ORIGIN).hostname, 'welcome.colmogravity.net');
  assert.ok(!LEGACY_HOSTS.includes(new URL(CANONICAL_ORIGIN).hostname));
});

test('legacy hosts: permanent redirect (308) to the canonical origin', () => {
  for (let i = 0; i < rules.length; i += 1) {
    const rule = rules[i];
    assert.ok(rule);
    assert.equal(rule.permanent, true, 'permanent: true is what yields a 308');
    assert.equal(getRedirectStatus(rule), 308);
    assert.equal(routeFor(i).statusCode, 308, 'the compiled rule carries the 308');
    assert.equal(rule.destination, `${CANONICAL_ORIGIN}/:path`);
    // No query of its own: next merges the incoming query string into the
    // destination, which is how `?utm=qr` survives the hop.
    assert.equal(new URL(rule.destination.replace(':path', 'x')).search, '');
  }
});

test('legacy hosts: page paths match, /api/* is carved out', () => {
  for (let i = 0; i < rules.length; i += 1) {
    const regex = matcherFor(i);
    // Pages (and the bare root) redirect.
    assert.ok(regex.test('/'), `rule ${i}: / must redirect`);
    assert.ok(regex.test('/p/olga-landing'), `rule ${i}: a card path must redirect`);
    assert.ok(regex.test('/e/e2e-mixer'), `rule ${i}: an event path must redirect`);
    assert.ok(regex.test('/apix/page'), `rule ${i}: only "api" is carved out, not "api…"`);

    // API clients keep working on the legacy host.
    assert.equal(regex.test('/api'), false, `rule ${i}: /api must not redirect`);
    assert.equal(regex.test('/api/health'), false, `rule ${i}: /api/health must not redirect`);
    assert.equal(regex.test('/api/me/profile'), false, `rule ${i}: /api/* must not redirect`);
  }

  // The exclusion lives in the source pattern the config exports.
  assert.equal(LEGACY_REDIRECT_SOURCE, '/:path((?!api(?:/|$)).*)');
});

// ---------------------------------------------------------------------------
// Self-hosting: the hosts and the destination are deployment configuration
//
// Both belong to the ORIGINAL deployment. A clone must be able to point the
// rules at its own origin, list its own legacy hosts, or drop them entirely —
// without editing the source (SELF_HOSTING.md).
// ---------------------------------------------------------------------------

test('legacy hosts: the canonical destination follows CANONICAL_ORIGIN, then APP_BASE_URL', () => {
  // Explicit setting wins, with any trailing slash normalised away.
  assert.equal(canonicalOrigin({ CANONICAL_ORIGIN: 'https://mine.test/' }), 'https://mine.test');
  // Otherwise the deployment's own public origin — this is what keeps a clone
  // from sending its visitors to the upstream author's domain.
  assert.equal(canonicalOrigin({ APP_BASE_URL: 'https://ours.test' }), 'https://ours.test');
  // Only with neither set does the historical release domain apply.
  assert.equal(canonicalOrigin({}), DEFAULT_CANONICAL_ORIGIN);
  // An unusable value falls through instead of producing a broken destination.
  assert.equal(canonicalOrigin({ CANONICAL_ORIGIN: 'not a url', APP_BASE_URL: 'https://ours.test' }), 'https://ours.test');
  assert.equal(canonicalOrigin({ CANONICAL_ORIGIN: '   ' }), DEFAULT_CANONICAL_ORIGIN);
});

test('legacy hosts: the host list is overridable, and the destination follows it', () => {
  const env = { LEGACY_REDIRECT_HOSTS: 'old.mine.test, old2.mine.test ,', CANONICAL_ORIGIN: 'https://mine.test' };
  assert.deepEqual(legacyHosts(env), ['old.mine.test', 'old2.mine.test']);
  const rules = legacyHostRedirects(env);
  assert.equal(rules.length, 2);
  assert.deepEqual(rules.map((rule) => rule.has?.[0]?.value), ['old\\.mine\\.test', 'old2\\.mine\\.test']);
  for (const rule of rules) assert.equal(rule.destination, 'https://mine.test/:path');
});

test('legacy hosts: LEGACY_REDIRECTS=off removes every rule', () => {
  assert.equal(legacyRedirectsEnabled({ LEGACY_REDIRECTS: 'off' }), false);
  assert.equal(legacyRedirectsEnabled({ LEGACY_REDIRECTS: 'OFF' }), false);
  assert.equal(legacyRedirectsEnabled({ LEGACY_REDIRECTS: 'on' }), true);
  assert.equal(legacyRedirectsEnabled({}), true, 'unset keeps the release behaviour');
  assert.deepEqual(legacyHostRedirects({ LEGACY_REDIRECTS: 'off' }), []);
});

test('legacy hosts: an empty host list yields no rules, not a broken one', () => {
  assert.deepEqual(legacyHosts({ LEGACY_REDIRECT_HOSTS: '' }), []);
  assert.deepEqual(legacyHostRedirects({ LEGACY_REDIRECT_HOSTS: '' }), []);
});
