import { test, expect } from '@playwright/test';
import http from 'node:http';
import { E2E_CANONICAL_ORIGIN } from './e2e-env';

/**
 * Legacy-host redirects (Gap 2) over real HTTP, against the same server the rest
 * of the suite runs on.
 *
 * Printed QR codes point at `welcome-p0-nikiti4.vercel.app`, which must now send
 * page navigation to the canonical domain — while `/api/*` keeps answering there
 * (health checks, API clients) and every other host is left alone.
 *
 * The requests are made with node:http because the Host header has to be spoofed
 * and Playwright's request API cannot send one. The rule shapes are asserted
 * against next's own matcher in tests/unit/legacy-host-redirect.test.ts.
 */

const PORT = Number(process.env.E2E_PORT ?? 3111);
/** The destination the e2e server was booted with (playwright.config.ts). */
const CANONICAL = E2E_CANONICAL_ORIGIN;
const CANONICAL_HOST = new URL(E2E_CANONICAL_ORIGIN).hostname;
const LEGACY_HOSTS = ['welcome-p0-nikiti4.vercel.app', 'welcome-p0.vercel.app'];

/** A request to the dev server as if it had arrived for another host. */
function requestAs(host: string, path: string): Promise<{ status: number; location: string | null }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path, method: 'GET', headers: { host } },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0, location: res.headers.location ?? null }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('legacy hosts: page navigation is sent to the canonical domain, 308', async () => {
  for (const host of LEGACY_HOSTS) {
    const root = await requestAs(host, '/');
    expect(root.status, `${host}/`).toBe(308);
    expect(root.location).toBe(`${CANONICAL}/`);

    // Path AND query survive the hop — a shared link with campaign parameters
    // must keep working.
    const deep = await requestAs(host, '/p/some-card?utm_source=qr&lang=ru');
    expect(deep.status, `${host}/p/some-card`).toBe(308);
    expect(deep.location).toBe(`${CANONICAL}/p/some-card?utm_source=qr&lang=ru`);

    const event = await requestAs(host, '/e/some-event');
    expect(event.status).toBe(308);
    expect(event.location).toBe(`${CANONICAL}/e/some-event`);
  }
});

test('legacy hosts: /api/* keeps answering there instead of redirecting', async () => {
  for (const host of LEGACY_HOSTS) {
    for (const path of ['/api/health', '/api/taxonomy']) {
      const res = await requestAs(host, `${path}?probe=1`);
      expect(res.location, `${host}${path} must not redirect`).toBeNull();
      expect(res.status, `${host}${path}`).not.toBe(308);
      expect(res.status).toBeLessThan(400);
    }
  }
});

test('the canonical domain and other *.vercel.app hosts are never redirected', async () => {
  for (const host of [
    CANONICAL_HOST,
    'welcome-p0-git-my-branch.vercel.app',
    'welcome-p0-abc123.vercel.app',
    'welcome-p0-nikiti4.vercel.app.evil.test',
    'welcome-p0Xnikiti4.vercelXapp',
    '127.0.0.1',
  ]) {
    const res = await requestAs(host, '/');
    expect(res.status, `${host} must not be redirected`).not.toBe(308);
    expect(res.location, `${host} must not redirect`).toBeNull();
  }
});
