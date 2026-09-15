import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
// tsx compiles page.tsx JSX with the classic transform — provide the React global
(globalThis as unknown as { React: unknown }).React = React;
import ConnectionsPage from '../../src/app/me/connections/page';
import MeLayout from '../../src/app/me/layout';
import { closeSql } from '../../src/lib/db';
import { PROVIDERS } from '../../src/domain/providers';

/**
 * /me/connections (interop §A4): the page is a renderer of the registry, and it
 * must never show anything but public facts — variable NAMES, never values.
 */

after(async () => {
  await closeSql();
});

/** Renders the server component the way Next would (locale outside a request → en). */
async function renderPage(): Promise<string> {
  const element = await ConnectionsPage();
  return renderToStaticMarkup(element);
}

/** Every env variable the registry mentions, with a leak-detecting sentinel. */
const REGISTRY_ENV = [...new Set(PROVIDERS.flatMap((p) => [...p.setup.env]))];

function withSentinelEnv<T>(run: () => Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const name of REGISTRY_ENV) {
    saved.set(name, process.env[name]);
    process.env[name] = `sentinel-value-${name.toLowerCase()}`;
  }
  return run().finally(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

test('connections: every registered provider is rendered with its resolved status', async () => {
  const html = await renderPage();
  for (const provider of PROVIDERS) {
    assert.ok(html.includes(`data-testid="provider-${provider.id}"`), `${provider.id} card is missing`);
  }
  // The four live-in-this-build providers report Available without any env set.
  assert.match(html, /data-testid="provider-telegram"[^>]*data-status="(live|disabled)"/);
  assert.match(html, /data-testid="provider-ics"[^>]*data-status="planned"/);
  assert.match(html, /data-testid="provider-linkedin"[^>]*data-status="disabled"/);
});

test('connections: an unconfigured channel shows the reason and the variable NAME', async () => {
  const savedToken = process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_BOT_TOKEN;
  try {
    const html = await renderPage();
    const card = html.slice(html.indexOf('data-testid="provider-telegram"'));
    assert.ok(card.includes('data-status="disabled"'), 'telegram must be disabled without its token');
    assert.ok(card.includes('data-testid="provider-reason-telegram"'), 'the reason line must be rendered');
    assert.ok(card.includes('TELEGRAM_BOT_TOKEN'), 'the missing variable must be named');
    assert.ok(card.includes('Unavailable'), 'the status label is localized copy, not a code');
  } finally {
    if (savedToken !== undefined) process.env.TELEGRAM_BOT_TOKEN = savedToken;
  }
});

test('connections: the HTML lists variable NAMES and never their VALUES', async () => {
  const html = await withSentinelEnv(renderPage);
  for (const name of REGISTRY_ENV) {
    assert.ok(html.includes(name), `${name} should be listed as a name`);
    assert.equal(html.includes(`sentinel-value-${name.toLowerCase()}`), false, `${name}: value leaked`);
  }
  // A configured instance reports Available for the two env-gated channels.
  assert.match(html, /data-testid="provider-telegram"[^>]*data-status="live"/);
  assert.match(html, /data-testid="provider-email"[^>]*data-status="live"/);
});

test('connections: setup steps and the do/don\'t block are part of the markup', async () => {
  // With every variable set the live providers expose their action link.
  const html = await withSentinelEnv(renderPage);
  // "How to connect" is a <details> per provider (collapsed, still in the HTML).
  assert.equal(html.includes('data-testid="provider-setup-google-contacts"'), true);
  assert.ok(html.includes('GOOGLE_OAUTH_CLIENT_ID'));
  assert.ok(html.includes('data-testid="connections-privacy"'));
  assert.ok(html.includes('We never scrape LinkedIn or any other network.'));
  assert.ok(html.includes('We never read your mailbox'), 'the mailbox claim must be explicit');
  // Live providers with a page of their own get a real link.
  assert.match(html, /href="\/me\/telegram"/);
  assert.match(html, /href="\/organizer"/);
});

test('connections: the /me shell cannot render without a session', async () => {
  // Outside a request scope there are no cookies, which is exactly the state a
  // signed-out visitor is in: the gate must not produce HTML.
  await assert.rejects(async () => {
    const element = await MeLayout({ children: React.createElement('p', null, 'x') });
    renderToStaticMarkup(element);
  });
});
