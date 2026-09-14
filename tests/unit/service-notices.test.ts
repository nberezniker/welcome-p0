import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SERVICE_NOTICE_KINDS,
  campaignEmailSubject,
  isServiceNoticeKind,
  serviceNoticeEmail,
} from '../../src/domain/service-notices';

/**
 * Email copy is a privacy surface, not a formatting detail: an email leaves the
 * app (forwardable, indexable, readable on a lock screen), so these tests assert
 * the CONTENT RULES, not exact wording:
 *   - only the app link is actionable;
 *   - no names, no contact values, no reason, no counts.
 */

const BASE = 'https://welcome.example.org';

test('service notices: every kind renders a subject and a body with the app link (EN default)', () => {
  for (const kind of SERVICE_NOTICE_KINDS) {
    const mail = serviceNoticeEmail(kind, BASE);
    assert.ok(mail.subject.length > 0, `${kind}: subject`);
    assert.ok(mail.text.length > 0, `${kind}: body`);
    assert.ok(mail.text.includes(`${BASE}/me/introductions`), `${kind}: deep link`);
  }
});

test('service notices: a trailing slash on APP_BASE_URL never doubles in the link', () => {
  const mail = serviceNoticeEmail('intro_mutual_notice', `${BASE}/`);
  assert.ok(mail.text.includes(`${BASE}/me/introductions`));
  assert.equal(mail.text.includes('//me/introductions'), false);
});

test('service notices: bodies carry no contact values, no handles and no names', () => {
  for (const kind of SERVICE_NOTICE_KINDS) {
    for (const locale of ['en', 'ru', 'es'] as const) {
      const mail = serviceNoticeEmail(kind, BASE, locale);
      const text = mail.text;
      assert.equal(text.includes('@'), false, `${kind}/${locale}: no email handle or @-mention`);
      assert.equal(/\+?\d[\d\s-]{6,}/.test(text), false, `${kind}/${locale}: no phone-like value`);
      assert.equal(/https?:\/\/[^\s]*\/(p|e)\//.test(text), false, `${kind}/${locale}: no profile/event link`);
      assert.equal(text.includes('{'), false, `${kind}/${locale}: every placeholder is interpolated`);
    }
  }
});

test('service notices: the declined/withdrawn bodies disclose no cause and no blame', () => {
  // The notices say THAT it ended — never why, never who. The banned vocabulary
  // is the disclosure vocabulary (a stated cause or an accusation), not the word
  // "private": promising privacy is exactly what these bodies are for.
  const disclosure = ['because', 'declined by', 'rejected', 'refused', 'причин', 'отклонил', 'motivo', 'rechaz'];
  for (const kind of ['intro_declined_notice', 'intro_withdrawn_notice'] as const) {
    for (const locale of ['en', 'ru', 'es'] as const) {
      const mail = serviceNoticeEmail(kind, BASE, locale);
      const haystack = `${mail.subject}\n${mail.text}`.toLowerCase();
      for (const forbidden of disclosure) {
        assert.equal(haystack.includes(forbidden), false, `${kind}/${locale}: "${forbidden}" leaked`);
      }
    }
  }
});

test('service notices: the completed/declined notices never name a side or a party', () => {
  // Both bodies are rendered from the KIND alone — there is no parameter through
  // which an account, profile or display name could reach the template.
  for (const kind of ['intro_declined_notice', 'intro_withdrawn_notice'] as const) {
    const mail = serviceNoticeEmail(kind, BASE, 'en');
    assert.equal(/\b(?:he|she|they)\b/i.test(mail.text), false, 'no party pronouns');
    assert.equal(/by you|by them|initiator|counterparty/i.test(mail.text), false, 'no party attribution');
  }
});

test('service notices: the requested notice never names the initiator (unlike the chat body)', () => {
  // The Telegram body interpolates the initiator's display name; the email one
  // is rendered from the KIND alone, so there is no way to pass a name in.
  const mail = serviceNoticeEmail('intro_requested_notice', BASE);
  assert.equal(/[A-Z][a-z]+ [A-Z][a-z]+/.test(mail.text), false, 'no person-like tokens in the body');
  assert.equal(/[A-Z][a-z]+ [A-Z][a-z]+/.test(mail.subject), false, 'no person-like tokens in the subject');
});

test('service notices: locales render different copy for the same kind', () => {
  const en = serviceNoticeEmail('intro_requested_notice', BASE, 'en');
  const ru = serviceNoticeEmail('intro_requested_notice', BASE, 'ru');
  const es = serviceNoticeEmail('intro_requested_notice', BASE, 'es');
  assert.notEqual(en.subject, ru.subject);
  assert.notEqual(ru.subject, es.subject);
  assert.equal(new Set([en.subject, ru.subject, es.subject]).size, 3);
});

test('service notice kinds are recognised only from the closed registry', () => {
  for (const kind of SERVICE_NOTICE_KINDS) assert.equal(isServiceNoticeKind(kind), true);
  assert.equal(isServiceNoticeKind('telegram_reply'), false);
  assert.equal(isServiceNoticeKind('intro_requested_notification'), false);
  assert.equal(isServiceNoticeKind(null), false);
});

test('campaign email subject is neutral and locale-dependent', () => {
  assert.equal(campaignEmailSubject('en'), 'WELCOME: a message from the event organizer');
  assert.notEqual(campaignEmailSubject('ru'), campaignEmailSubject('en'));
  assert.notEqual(campaignEmailSubject('es'), campaignEmailSubject('en'));
  assert.equal(/[A-Z][a-z]+ [A-Z][a-z]+/.test(campaignEmailSubject('en')), false);
});
