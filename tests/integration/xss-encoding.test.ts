import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
// tsx compiles page.tsx JSX with the classic transform — provide the React global
(globalThis as unknown as { React: unknown }).React = React;
import { POST as requestOtp } from '../../src/app/api/auth/otp/request/route';
import { POST as verifyOtp } from '../../src/app/api/auth/otp/verify/route';
import { POST as createProfileRoute } from '../../src/app/api/me/profile/route';
import { GET as publicProfile } from '../../src/app/api/public/profiles/[slug]/route';
import { GET as publicVCard } from '../../src/app/api/public/profiles/[slug]/vcard/route';
import PublicProfilePage from '../../src/app/p/[slug]/page';
import { closeSql } from '../../src/lib/db';
import { loginViaOtp, makeRequest, uniqueEmail, assertStatus } from './helpers';

/** Phase 5 XSS/encoding regression (AC-51, SECURITY_TESTS #12):
 * user-controlled text is stored and returned as DATA (JSON keeps the exact
 * string), rendered ESCAPED in the public card HTML, and cannot inject vCard
 * properties through CRLF. */

after(async () => {
  await closeSql();
});

const SCRIPT = '<script>alert(1)</script>';
const IMG = '<img src=x onerror="alert(\'bio\')">';

interface XssCtx {
  cookie: string;
  slug: string;
}

async function setupXssProfile(): Promise<XssCtx> {
  const cookie = await loginViaOtp(requestOtp, verifyOtp, uniqueEmail('xss'));
  const res = await createProfileRoute(
    makeRequest('/api/me/profile', {
      cookie,
      body: {
        display_name: SCRIPT,
        headline: '"><svg onload=alert(1)>',
        short_bio: `${IMG}\n${SCRIPT}`,
        languages: ['en'],
        offer_tags: ['<b>offer</b>'],
        need_tags: [],
      },
    }),
  );
  assertStatus(res, 200);
  const slug = ((await res.json()) as { profile: { public_slug: string } }).profile.public_slug;
  return { cookie, slug };
}

test('stored XSS: public JSON API returns payloads as plain data strings', async () => {
  const { slug } = await setupXssProfile();
  const res = await publicProfile(makeRequest(`/api/public/profiles/${slug}`), {
    params: Promise.resolve({ slug }),
  });
  assertStatus(res, 200);
  const body = (await res.json()) as {
    display_name: string;
    short_bio: string;
    offer_tags: string[];
  };
  assert.equal(body.display_name, SCRIPT);
  assert.ok(body.short_bio.includes(IMG));
  assert.ok(body.short_bio.includes(SCRIPT));
  assert.deepEqual(body.offer_tags, ['<b>offer</b>']);
});

test('stored XSS: public card HTML contains user data escaped, never executable', async () => {
  const { slug } = await setupXssProfile();
  const element = await PublicProfilePage({ params: Promise.resolve({ slug }) });
  const html = renderToStaticMarkup(element);

  assert.ok(!html.includes('<script>alert(1)</script>'), 'raw script tag from user data must not appear');
  assert.ok(!html.includes('<img src=x'), 'raw img tag from user data must not appear');
  assert.ok(!html.includes('<svg onload'), 'raw svg from user data must not appear');
  // Escaped renderings are present (React text escaping):
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('&lt;img src=x'), 'escaped img payload must be visible as text');
  assert.ok(html.includes('&lt;b&gt;offer&lt;/b&gt;'));
});

test('vCard injection: display_name CRLF property injection is neutralized (\\n escape)', async () => {
  const cookie = await loginViaOtp(requestOtp, verifyOtp, uniqueEmail('vcard-inject'));
  const res = await createProfileRoute(
    makeRequest('/api/me/profile', {
      cookie,
      body: { display_name: 'A\r\nEMAIL:evil@x.y\r\nEND:VCARD' },
    }),
  );
  assertStatus(res, 200);
  const slug = ((await res.json()) as { profile: { public_slug: string } }).profile.public_slug;

  const vres = await publicVCard(makeRequest(`/api/public/profiles/${slug}/vcard`), {
    params: Promise.resolve({ slug }),
  });
  assertStatus(vres, 200);
  const text = await vres.text();

  const lines = text.split('\r\n');
  assert.ok(
    !lines.some((l) => l.startsWith('EMAIL:evil')),
    'injected EMAIL property must not become its own vCard line',
  );
  // The CRLF survived as data, escaped to literal \n inside FN.
  assert.ok(text.includes('FN:A\\nEMAIL:evil@x.y\\nEND:VCARD'));
  // Structural integrity: exactly one BEGIN/END pair, CRLF-terminated.
  assert.equal(lines.filter((l) => l === 'BEGIN:VCARD').length, 1);
  assert.equal(lines.filter((l) => l === 'END:VCARD').length, 1);
  assert.equal(lines[lines.length - 1], '');
  assert.equal(lines[lines.length - 2], 'END:VCARD');
});
