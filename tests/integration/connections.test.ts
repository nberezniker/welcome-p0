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
async function renderPage(searchParams?: Record<string, string | string[]>): Promise<string> {
  const element = await ConnectionsPage(searchParams ? { searchParams: Promise.resolve(searchParams) } : {});
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

// ---------------------------------------------------------------------------
// Phase 2 — the two Google rows
//
// The e2e suite runs against ONE `next dev` whose env either has the Google OAuth
// client or does not (playwright.config.ts documents why a second server is not
// started: two `next dev` processes would share a single `.next` build dir). So
// the CONFIGURED branch is asserted end-to-end in tests/e2e/connections.spec.ts
// and the UNCONFIGURED branch is asserted here, by rendering the same page with
// the two variables absent — the pattern tests/integration/followup-digest.test.ts
// already uses for the one flag that must stay off.
// ---------------------------------------------------------------------------

/** Runs `run` with the Google OAuth pair either absent or set to sentinels. */
async function withGoogleEnv<T>(mode: 'absent' | 'set', run: () => Promise<T>): Promise<T> {
  const names = ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET'];
  const saved = new Map<string, string | undefined>();
  for (const name of names) {
    saved.set(name, process.env[name]);
    if (mode === 'absent') delete process.env[name];
    else process.env[name] = `sentinel-value-${name.toLowerCase()}`;
  }
  try {
    return await run();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/**
 * The slice of HTML belonging to ONE provider card.
 *
 * Sliced on the next `<li class="card"` rather than on the next `provider-*`
 * testid: a card contains several of those (its status chip, its reason line, the
 * Google panel), so slicing on a testid would cut the card off inside itself.
 */
function cardOf(html: string, id: string): string {
  const start = html.indexOf(`data-testid="provider-${id}"`);
  assert.ok(start >= 0, `${id} card must exist`);
  const end = html.indexOf('<li class="card"', start + 1);
  return html.slice(start, end > 0 ? end : undefined);
}

/**
 * The slice belonging to the GOOGLE PANEL inside that card.
 *
 * The card states the instance-level fact too (the registry's own reason line,
 * shared by every provider), so a statement can legitimately appear twice on the
 * card. Assertions about the PANEL must therefore be scoped to the panel.
 */
function panelOf(html: string, id: string): string {
  const card = cardOf(html, id);
  const start = card.indexOf(`data-testid="google-panel-${id}"`);
  assert.ok(start >= 0, `${id} panel must exist`);
  return card.slice(start);
}

test('connections: without the OAuth client both Google rows say so, name both variables, and offer no connect', async () => {
  const html = await withGoogleEnv('absent', () => renderPage());

  for (const id of ['google-contacts', 'google-calendar']) {
    const card = cardOf(html, id);
    assert.ok(card.includes('data-status="disabled"'), `${id} must be disabled without the OAuth client`);
    assert.ok(card.includes(`data-testid="provider-reason-${id}"`), `${id} must render the reason line`);
    // The honest reason names BOTH missing variables — names, never values.
    assert.ok(card.includes('GOOGLE_OAUTH_CLIENT_ID'), `${id} must name the first missing variable`);
    assert.ok(card.includes('GOOGLE_OAUTH_CLIENT_SECRET'), `${id} must name the second missing variable`);
    assert.equal(
      card.includes(`data-testid="google-connect-${id}"`),
      false,
      `${id}: there is nothing to connect to, so there must be no connect control`,
    );
    // The per-instance state is stated, not left blank.
    assert.ok(card.includes(`data-google-state="not_configured"`), `${id} must say which state it is in`);
    assert.ok(card.includes('Not set up on this instance'), `${id} must say which state it is in`);

    // The per-instance truth is the PANEL's own sentence, and the panel says it
    // ONCE. It used to say it twice — a chip plus a dead button styled to look
    // pressable — which is exactly the "invites a press that cannot work" shape
    // the UI review flagged. (The card's registry-level reason line above is a
    // different statement, about the instance, and is unchanged.)
    const panel = panelOf(html, id);
    assert.ok(panel.includes(`data-testid="google-help-${id}"`), `${id} must carry the per-instance explanation`);
    assert.equal(
      panel.split('Not set up on this instance').length - 1,
      1,
      `${id}: the panel must state its state once, not as a chip beside a dead button`,
    );
    assert.equal(
      /aria-disabled/.test(panel),
      false,
      `${id}: the panel must render no disabled ghost button standing in for the connect control`,
    );
  }
});

test('connections: with the OAuth client the Google rows are live, explain what is read and written, and link to the real start route', async () => {
  const html = await withGoogleEnv('set', () => renderPage());

  for (const id of ['google-contacts', 'google-calendar']) {
    const card = cardOf(html, id);

    assert.ok(card.includes('data-status="live"'), `${id} must be live when the client is configured`);
    // Nothing was connected in this render, and the page says exactly that
    // instead of implying a connection.
    assert.ok(card.includes('data-google-state="not_connected"'), `${id} must render "not connected"`);
    assert.ok(card.includes(`href="/api/oauth/google/start?provider=${id}"`), `${id} connect control must point at the start route`);
    // The two halves of the privacy statement, per provider.
    assert.ok(card.includes(`data-testid="google-reads-${id}"`), `${id} must state what is read`);
    assert.ok(card.includes(`data-testid="google-writes-${id}"`), `${id} must state what is written`);
    // And the registry's own status chip agrees with the panel: no card claiming
    // "Available" while its panel says nothing can be done.
    assert.ok(card.includes(`data-testid="provider-status-${id}"`));
    assert.ok(card.includes('Available'));
  }

  // Provider-specific honesty, not a generic sentence reused twice.
  assert.ok(html.includes('Names and email addresses from your Google contacts'));
  assert.ok(html.includes('No contact is created, changed or deleted in Google'));
  assert.ok(html.includes('Nothing. We never read your calendar.'));
  assert.ok(html.includes('their email address is sent only if you tick the opt-in'));
  // The panel never leaks the sentinel VALUES set for this render.
  assert.equal(html.includes('sentinel-value-google_oauth_client_secret'), false);
});

test('connections: the connect control is a PRIMARY action that names its provider', async () => {
  // The user-reported complaint: with two Google cards on one page, a bare
  // "Connect" said nothing about which account was about to be opened. Three
  // properties are asserted, because all three were wrong before: the label names
  // the provider, the control is the primary variant, and it sits ABOVE the
  // explanatory copy rather than below it inside a nested panel row.
  const html = await withGoogleEnv('set', () => renderPage());

  const expected: Record<string, string> = {
    'google-contacts': 'Connect Google Contacts',
    'google-calendar': 'Connect Google Calendar',
  };

  for (const [id, label] of Object.entries(expected)) {
    const card = cardOf(html, id);
    const anchor = new RegExp(`<a[^>]*data-testid="google-connect-${id}"[^>]*>([^<]*)</a>`).exec(card);
    assert.ok(anchor, `${id}: the connect control must be an anchor to the start route`);
    assert.equal(anchor[1]?.trim(), label, `${id}: the control must name the provider it connects`);
    assert.ok(
      /class="[^"]*btn-primary/.test(anchor[0]),
      `${id}: the connect control must be the primary action, not a secondary-looking button`,
    );
    assert.ok(
      /class="[^"]*\bw-full\b/.test(anchor[0]),
      `${id}: the control must be full width on a phone`,
    );
    assert.ok(
      card.indexOf(`google-connect-${id}`) < card.indexOf(`google-help-${id}`),
      `${id}: the action must come before the explanation it refers to`,
    );
    // Two cards, two distinguishable labels.
    assert.notEqual(anchor[1]?.trim(), expected[id === 'google-contacts' ? 'google-calendar' : 'google-contacts']);
  }

  // Disconnect is not rendered at all without a grant, so it cannot compete with
  // the primary action on a fresh account.
  for (const id of Object.keys(expected)) {
    assert.equal(cardOf(html, id).includes(`google-disconnect-${id}`), false, `${id}: nothing to disconnect yet`);
  }
});

test('connections: the OAuth result banner renders only a known word, and nothing at all for an unknown one', async () => {
  const connected = await renderPage({ google: 'google-contacts', status: 'connected' });
  assert.ok(connected.includes('data-testid="google-flow-status"'));
  assert.ok(connected.includes('data-google-flow-status="connected"'));
  assert.ok(connected.includes('Google connected.'));

  const denied = await renderPage({ status: 'denied' });
  assert.ok(denied.includes('data-google-flow-status="denied"'));
  assert.ok(denied.includes('You cancelled the Google consent screen'));

  // An unparsable status is ignored: a hand-typed URL cannot put words in the
  // product's mouth, and a stale link cannot show someone else's outcome.
  const bogus = await renderPage({ status: '<script>alert(1)</script>' });
  assert.equal(bogus.includes('data-testid="google-flow-status"'), false);
  assert.equal(bogus.includes('alert(1)'), false);

  const absent = await renderPage({});
  assert.equal(absent.includes('data-testid="google-flow-status"'), false);
});
