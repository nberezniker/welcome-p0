import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectLinkKind,
  isUrlKind,
  linkHref,
  LINK_EXAMPLES,
  LINK_KINDS,
  validateLink,
} from '../../src/domain/links';

test('links: the five card fields are LinkedIn, site, GitHub, Telegram, WhatsApp', () => {
  assert.deepEqual(
    LINK_KINDS.map((k) => k.kind),
    ['linkedin_url', 'github_url', 'telegram_username', 'whatsapp', 'website'],
  );
  for (const def of LINK_KINDS) {
    assert.ok(LINK_EXAMPLES[def.kind].length > 0, `${def.kind} needs an example hint`);
  }
});

test('links: the kind is detected from the domain', () => {
  assert.equal(detectLinkKind('https://www.linkedin.com/in/nikita'), 'linkedin_url');
  assert.equal(detectLinkKind('linkedin.com/in/nikita'), 'linkedin_url');
  assert.equal(detectLinkKind('https://github.com/nikita'), 'github_url');
  assert.equal(detectLinkKind('@nikita'), 'telegram_username');
  assert.equal(detectLinkKind('https://t.me/nikita'), 'telegram_username');
  assert.equal(detectLinkKind('+34 600 111 222'), 'whatsapp');
  assert.equal(detectLinkKind('https://wa.me/34600111222'), 'whatsapp');
  assert.equal(detectLinkKind('https://example.com'), 'website');
  assert.equal(detectLinkKind('example.com'), 'website');
});

test('links: unsafe schemes are rejected for every kind', () => {
  for (const value of [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD4=',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'blob:https://x/y',
  ]) {
    const result = validateLink(value, 'website');
    assert.equal(result.ok, false, `${value} must not validate`);
    if (!result.ok) assert.equal(result.reason, 'unsafe_scheme');
  }
});

test('links: linkedin_url requires a linkedin profile-ish path', () => {
  const ok = validateLink('linkedin.com/in/nikita-berezniker', 'linkedin_url');
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.kind, 'linkedin_url');
    assert.equal(ok.normalized, 'https://linkedin.com/in/nikita-berezniker');
  }
  assert.equal(validateLink('https://www.linkedin.com/company/acme', 'linkedin_url').ok, true);
  assert.equal(validateLink('https://www.linkedin.com/feed/', 'linkedin_url').ok, false);
  assert.equal(validateLink('https://github.com/nikita', 'linkedin_url').ok, false);
  assert.equal(validateLink('https://notlinkedin.com/in/x', 'linkedin_url').ok, false);
});

test('links: github_url requires a single profile segment', () => {
  const ok = validateLink('https://github.com/nikita', 'github_url');
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.normalized, 'https://github.com/nikita');
  assert.equal(validateLink('github.com/nikita/repo', 'github_url').ok, false);
  assert.equal(validateLink('https://gitlab.com/nikita', 'github_url').ok, false);
});

test('links: telegram handles normalize to @handle and reject junk', () => {
  for (const input of ['@nikita', 'nikita', 'https://t.me/nikita', 't.me/nikita/']) {
    const result = validateLink(input, 'telegram_username');
    assert.equal(result.ok, true, `${input} should validate`);
    if (result.ok) assert.equal(result.normalized, '@nikita');
  }
  assert.equal(validateLink('@ab', 'telegram_username').ok, false);
  assert.equal(validateLink('@nikita with spaces', 'telegram_username').ok, false);
  assert.equal(validateLink('https://t.me/', 'telegram_username').ok, false);
});

test('links: whatsapp normalizes to +digits and rejects foreign hosts', () => {
  for (const input of ['+34 600 111 222', '34600111222', '+34-600-111-222', 'https://wa.me/34600111222']) {
    const result = validateLink(input, 'whatsapp');
    assert.equal(result.ok, true, `${input} should validate`);
    if (result.ok) assert.equal(result.normalized, '+34600111222');
  }
  assert.equal(validateLink('+123', 'whatsapp').ok, false);
  assert.equal(validateLink('https://example.com/34600111222', 'whatsapp').ok, false);
});

test('links: website accepts a bare host and strips credentials', () => {
  const ok = validateLink('acme.example', 'website');
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.normalized, 'https://acme.example/');
  const creds = validateLink('https://user:pass@acme.example/x', 'website');
  assert.equal(creds.ok, true);
  if (creds.ok) {
    assert.ok(!creds.normalized.includes('pass'), 'credentials must never be stored in a published link');
    assert.equal(creds.normalized, 'https://acme.example/x');
  }
  assert.equal(validateLink('localhost', 'website').ok, false);
  assert.equal(validateLink('', 'website').ok, false);
});

test('links: linkHref is the only href builder and refuses unsafe values', () => {
  assert.equal(linkHref('telegram_username', '@nikita'), 'https://t.me/nikita');
  assert.equal(linkHref('whatsapp', '+34 600 111 222'), 'https://wa.me/34600111222');
  assert.equal(linkHref('website', 'acme.example'), 'https://acme.example/');
  assert.equal(linkHref('linkedin_url', 'https://linkedin.com/in/x'), 'https://linkedin.com/in/x');
  assert.equal(linkHref('github_url', 'https://github.com/x'), 'https://github.com/x');
  // never an executable / non-http target
  assert.equal(linkHref('website', 'javascript:alert(1)'), null);
  assert.equal(linkHref('linkedin_url', 'data:text/html,x'), null);
  assert.equal(linkHref('telegram_username', '@'), null);
  assert.equal(linkHref('whatsapp', 'no digits here'), null);
  assert.equal(linkHref('website', 'http://'), null);
});

test('links: only URL kinds are rendered as URL links', () => {
  assert.equal(isUrlKind('linkedin_url'), true);
  assert.equal(isUrlKind('github_url'), true);
  assert.equal(isUrlKind('website'), true);
  assert.equal(isUrlKind('telegram_username'), false);
  assert.equal(isUrlKind('whatsapp'), false);
});
