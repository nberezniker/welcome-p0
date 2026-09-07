import test from 'node:test';
import assert from 'node:assert/strict';
import { checkRevision, validateProfileInput, validateContactInput } from '../../src/domain/profile';
import { buildVCard } from '../../src/domain/vcard';

test('revision: matching revision is accepted and bumped', () => {
  assert.deepEqual(checkRevision(1, 1), { ok: true, nextRevision: 2 });
  assert.deepEqual(checkRevision(41, 41), { ok: true, nextRevision: 42 });
});

test('revision: stale revision is a conflict carrying the current revision', () => {
  assert.deepEqual(checkRevision(3, 1), { ok: false, currentRevision: 3 });
  assert.deepEqual(checkRevision(3, 999), { ok: false, currentRevision: 3 });
});

test('revision: missing or malformed revision is a conflict (route turns missing into 400)', () => {
  assert.deepEqual(checkRevision(1, undefined), { ok: false, currentRevision: 1 });
  assert.deepEqual(checkRevision(1, '1'), { ok: false, currentRevision: 1 });
  assert.deepEqual(checkRevision(1, 1.5), { ok: false, currentRevision: 1 });
  assert.deepEqual(checkRevision(1, 0), { ok: false, currentRevision: 1 });
  assert.deepEqual(checkRevision(1, null), { ok: false, currentRevision: 1 });
});

test('profile validation: minimal valid body with tag normalization', () => {
  const r = validateProfileInput({
    display_name: '  Anna  ',
    languages: ['RU', 'en'],
    offer_tags: [' Design ', 'design', 'UX'],
    need_tags: ['pilot'],
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.displayName, 'Anna');
    assert.deepEqual(r.value.languages, ['ru', 'en']);
    assert.deepEqual(r.value.offerTags, ['design', 'ux']);
    assert.deepEqual(r.value.needTags, ['pilot']);
  }
});

test('profile validation: rejects bad bodies', () => {
  assert.equal(validateProfileInput(null).ok, false);
  assert.equal(validateProfileInput('x').ok, false);
  assert.equal(validateProfileInput({}).ok, false); // display_name missing
  assert.equal(validateProfileInput({ display_name: '' }).ok, false);
  assert.equal(validateProfileInput({ display_name: 'x'.repeat(121) }).ok, false);
  const badTags = validateProfileInput({ display_name: 'A', offer_tags: [42] });
  assert.equal(badTags.ok, false);
  if (!badTags.ok) assert.equal(badTags.code, 'invalid_tags');
  const badLang = validateProfileInput({ display_name: 'A', languages: [1] });
  assert.equal(badLang.ok, false);
  const longTag = validateProfileInput({ display_name: 'A', need_tags: ['x'.repeat(81)] });
  assert.equal(longTag.ok, false);
});

test('contact validation: whitelisted kinds, boolean public_enabled', () => {
  const ok = validateContactInput({ kind: 'telegram_username', value: '@user', public_enabled: true });
  assert.equal(ok.ok, true);
  for (const kind of ['whatsapp', 'phone', 'website', 'linkedin_url']) {
    assert.equal(validateContactInput({ kind, value: 'x', public_enabled: false }).ok, true);
  }
  assert.equal(validateContactInput({ kind: 'email', value: 'a@b.c', public_enabled: true }).ok, false);
  assert.equal(validateContactInput({ kind: 'phone', value: '', public_enabled: true }).ok, false);
  assert.equal(validateContactInput({ kind: 'phone', value: 'x'.repeat(301), public_enabled: true }).ok, false);
  assert.equal(validateContactInput({ kind: 'phone', value: 'x', public_enabled: 'yes' }).ok, false);
});

// ---------------------------------------------------------------------------
// vCard builder
// ---------------------------------------------------------------------------

test('vcard: header/footer, CRLF endings, public contacts only', () => {
  const v = buildVCard({
    slug: 'abcdefghij'.slice(0, 10) + 'aaaaaaaaaaaa',
    display_name: 'Anna',
    headline: 'Designer',
    company: 'Freelance',
    short_bio: 'bio',
    languages: ['ru', 'en'],
    offer_tags: ['design'],
    need_tags: ['pilot'],
    contacts: [
      { kind: 'telegram_username', value: '@anna' },
      { kind: 'phone', value: '+79000000000' },
    ],
  });
  assert.ok(v.startsWith('BEGIN:VCARD\r\n'));
  assert.ok(v.endsWith('END:VCARD\r\n'));
  assert.ok(v.includes('VERSION:3.0\r\n'));
  assert.ok(v.includes('FN:Anna\r\n'));
  assert.ok(v.includes('TITLE:Designer\r\n'));
  assert.ok(v.includes('ORG:Freelance\r\n'));
  assert.ok(v.includes('NOTE:bio\r\n'));
  assert.ok(v.includes('LANG:ru\r\n'));
  assert.ok(v.includes('X-SOCIALPROFILE;TYPE=telegram:https://t.me/anna\r\n'));
  assert.ok(v.includes('TEL;TYPE=CELL:+79000000000\r\n'));
});

test('vcard: multi-line display name cannot inject properties', () => {
  const v = buildVCard({
    slug: 'aaaaaaaaaaaaaaaaaaaaaa',
    display_name: 'Evil\r\nEMAIL:hacker@evil.test',
    headline: null,
    company: null,
    short_bio: null,
    languages: [],
    offer_tags: [],
    need_tags: [],
    contacts: [],
  });
  const lines = v.split('\r\n');
  assert.equal(lines.filter((l) => l.startsWith('EMAIL:')).length, 0);
  assert.ok(v.includes('FN:Evil\\nEMAIL:hacker@evil.test'));
});
