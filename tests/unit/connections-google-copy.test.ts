import test from 'node:test';
import assert from 'node:assert/strict';
import { en } from '../../src/i18n/en';
import { LOCALES, t, type Locale } from '../../src/i18n';

/**
 * /me/connections — the two Google cards, in ALL THREE languages.
 *
 * Two user-reported defects are pinned here:
 *
 *   1. the connect control was a bare, identical word on both cards ("Connect" /
 *      "Подключить"), so nothing on the page told the user which Google account
 *      they were about to open. The control now NAMES the provider, and the
 *      unnamed keys are gone rather than merely unused — a bare button cannot
 *      come back by accident, only by re-adding a key someone must justify;
 *   2. the per-instance branch ("this instance has no Google OAuth client") has
 *      to be sayable in the user's language, not just in English, because it is
 *      the message a self-hosted instance shows every user.
 *
 * The rendered proof lives in tests/integration/connections.test.ts (English, the
 * locale a render outside a request resolves to) and
 * tests/e2e/connections.spec.ts (a real signed-in browser).
 */

const PROVIDERS = [
  { id: 'google-contacts', titleKey: 'providers.google-contacts.title' },
  { id: 'google-calendar', titleKey: 'providers.google-calendar.title' },
] as const;

const CONNECT_KEYS = ['connections.google.connectProvider', 'connections.google.reconnectProvider'] as const;

test('connections copy: the connect control names the provider in every language', () => {
  for (const locale of LOCALES) {
    for (const provider of PROVIDERS) {
      const providerName = t(locale as Locale, provider.titleKey);
      assert.ok(providerName.length > 0, `${locale}: ${provider.titleKey} must exist`);
      for (const key of CONNECT_KEYS) {
        const label = t(locale as Locale, key, { provider: providerName });
        assert.ok(
          label.includes(providerName),
          `${locale}: ${key} must render the provider name, got "${label}"`,
        );
        // …and it must be more than the provider's own name: the VERB has to be
        // there too, otherwise "Connect Google Contacts" becomes a label.
        assert.ok(
          label.replace(providerName, '').trim().length > 2,
          `${locale}: ${key} must name the action as well, got "${label}"`,
        );
      }
    }
  }
});

test('connections copy: the two Google cards cannot read the same on one page', () => {
  for (const locale of LOCALES) {
    const labels = PROVIDERS.map((p) =>
      t(locale as Locale, 'connections.google.connectProvider', {
        provider: t(locale as Locale, p.titleKey),
      }),
    );
    assert.notEqual(
      labels[0],
      labels[1],
      `${locale}: both Google connect controls must be distinguishable ("${labels[0]}" twice)`,
    );
  }
});

test('connections copy: no unnamed connect/reconnect key exists in any dictionary', () => {
  // The reported complaint was a bare «Подключить» / "Connect". Deleting the keys
  // is what makes that unreachable, not discipline: rendering an unnamed control
  // now needs a new key, a new dictionary entry in three files and a review.
  for (const key of ['connections.google.connect', 'connections.google.reconnect']) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(en, key),
      false,
      `${key} must not exist — the connect control always names its provider`,
    );
  }
});

test('connections copy: the "not configured on this instance" branch is honest in every language', () => {
  for (const locale of LOCALES) {
    const stateWord = t(locale as Locale, 'connections.google.state.not_configured');
    const help = t(locale as Locale, 'connections.google.notConfiguredHelp', {
      env: 'GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET',
    });
    assert.ok(stateWord.length > 0, `${locale}: the state word must exist`);
    // The help names the variable NAMES (never values) — it is the operator-facing
    // half of the statement and it has to arrive through the placeholder.
    assert.ok(help.includes('GOOGLE_OAUTH_CLIENT_ID'), `${locale}: the help must name the missing variable`);
    // Honest about there being no control at all, rather than about a broken one:
    // the panel renders no button in this state (integration test asserts that).
    assert.ok(
      !/\bpress\b|\bpulsa\b|нажмите/i.test(help),
      `${locale}: the help must not tell the user to press a control that is not rendered — "${help}"`,
    );
  }
  // …and it is actually TRANSLATED, not an English string copied into ru/es (the
  // dictionary parity test only proves the key is present).
  const english = t('en', 'connections.google.notConfiguredHelp');
  for (const locale of ['ru', 'es'] as const) {
    assert.notEqual(
      t(locale, 'connections.google.notConfiguredHelp'),
      english,
      `${locale}: the not-configured help must be translated, not copied from English`,
    );
    assert.notEqual(
      t(locale, 'connections.google.state.not_configured'),
      t('en', 'connections.google.state.not_configured'),
      `${locale}: the not-configured state word must be translated`,
    );
  }
});

test('connections copy: the honest reads/writes statement differs per provider in every language', () => {
  // The card exists to say exactly what is read and written; one generic sentence
  // reused on both cards would be a false statement for one of them.
  for (const locale of LOCALES) {
    const reads = PROVIDERS.map((p) => t(locale as Locale, `connections.google.reads.${p.id}` as const));
    const writes = PROVIDERS.map((p) => t(locale as Locale, `connections.google.writes.${p.id}` as const));
    assert.notEqual(reads[0], reads[1], `${locale}: the two cards must not share one "reads" sentence`);
    assert.notEqual(writes[0], writes[1], `${locale}: the two cards must not share one "writes" sentence`);
    for (const text of [...reads, ...writes]) assert.ok(text.length > 0);
  }
});
