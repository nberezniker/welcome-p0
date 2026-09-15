import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTACT_IMPORT_MAX_BYTES,
  CONTACT_IMPORT_MAX_CONTACTS,
  detectContactFormat,
  parseContacts,
} from '../../src/domain/contact-import';

/**
 * Address-book parser (interop §A1: "friendship with contacts" without Google
 * OAuth). Pure by contract — everything here runs without a DB, which is the
 * point: an address book is read, matched, and forgotten.
 */

function contactsOf(text: string, filename?: string): { email: string; name: string | null }[] {
  const result = parseContacts(text, { filename });
  assert.equal(result.ok, true, `expected a successful parse, got ${JSON.stringify(result)}`);
  if (!result.ok) throw new Error('unreachable');
  return result.contacts;
}

// ---------------------------------------------------------------------------
// vCard
// ---------------------------------------------------------------------------

test('vcard: several cards, FN as the name, CRLF line endings', () => {
  const vcf = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    'FN:Anna Petrova',
    'N:Petrova;Anna;;;',
    'EMAIL;TYPE=WORK:anna@example.com',
    'END:VCARD',
    'BEGIN:VCARD',
    'VERSION:3.0',
    'FN:Boris Sokolov',
    'EMAIL:boris@example.com',
    'EMAIL;TYPE=HOME:boris.work@example.com',
    'END:VCARD',
    '',
  ].join('\r\n');

  const result = parseContacts(vcf);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.format, 'vcard');
  assert.equal(result.skipped, 0);
  assert.deepEqual(result.contacts, [
    { email: 'anna@example.com', name: 'Anna Petrova' },
    // Both mailboxes of one person are offered: either one may be the one
    // registered on WELCOME.
    { email: 'boris@example.com', name: 'Boris Sokolov' },
    { email: 'boris.work@example.com', name: 'Boris Sokolov' },
  ]);
});

test('vcard: a card without FN falls back to N (given name first), and folded lines are unfolded', () => {
  const vcf = [
    'BEGIN:VCARD',
    'N:Sokolova;Mariya;;;',
    'EMAIL:mariya@example.com',
    'NOTE:a long note that is folded',
    '  onto the next line',
    'END:VCARD',
  ].join('\n');

  assert.deepEqual(contactsOf(vcf), [{ email: 'mariya@example.com', name: 'Mariya Sokolova' }]);
});

test('vcard: base64 / quoted-printable payloads and binary properties are ignored, not decoded', () => {
  const vcf = [
    'BEGIN:VCARD',
    'FN:Encoded Person',
    'PHOTO;ENCODING=BASE64;TYPE=JPEG:/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAg',
    'EMAIL;ENCODING=QUOTED-PRINTABLE:encoded=40example.com',
    'EMAIL:plain@example.com',
    'END:VCARD',
  ].join('\n');

  const result = parseContacts(vcf);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  // The encoded address is skipped rather than half-decoded, the plain one is kept.
  assert.deepEqual(result.contacts, [{ email: 'plain@example.com', name: 'Encoded Person' }]);
  assert.equal(result.skipped, 0);
});

test('vcard: a card with no EMAIL counts as skipped, unknown and garbage lines are dropped', () => {
  const vcf = [
    'BEGIN:VCARD',
    'FN:No Address',
    'TEL;TYPE=CELL:+34 600 000 000',
    'END:VCARD',
    'this is not vcard at all',
    'BEGIN:VCARD',
    'FN:Keeper',
    'item1.EMAIL;TYPE=INTERNET:keeper@example.com',
    'END:VCARD',
  ].join('\r\n');

  const result = parseContacts(vcf);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.contacts, [{ email: 'keeper@example.com', name: 'Keeper' }]);
  assert.equal(result.skipped, 1, 'the address-less card is reported as skipped');
});

test('vcard: invalid addresses are skipped, duplicates collapse, normalization is trim+lowercase', () => {
  const vcf = [
    'BEGIN:VCARD',
    'FN:Duplicate',
    'EMAIL:  Duplicate@Example.COM ',
    'EMAIL:duplicate@example.com',
    'EMAIL:not-an-email',
    'EMAIL:@nope',
    'END:VCARD',
  ].join('\n');

  const result = parseContacts(vcf);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.contacts, [{ email: 'duplicate@example.com', name: 'Duplicate' }]);
  assert.equal(result.skipped, 2, 'both unusable addresses are counted');
});

test('vcard: a truncated export without END:VCARD still yields its card', () => {
  const vcf = 'BEGIN:VCARD\nFN:Cut Off\nEMAIL:cut@example.com\n';
  assert.deepEqual(contactsOf(vcf), [{ email: 'cut@example.com', name: 'Cut Off' }]);
});

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

test('csv: auto-detects the email column in EN and RU spellings', () => {
  for (const header of ['email', 'E-Mail', 'mail', 'Почта']) {
    const csv = `${header},Имя\nfirst@example.com,Первый\n`;
    assert.deepEqual(contactsOf(csv), [{ email: 'first@example.com', name: 'Первый' }], `header: ${header}`);
  }
});

test('csv: name column priority is exact → full → given, and family/last columns are never a name', () => {
  const csv = [
    'E-Mail,First Name,Last Name,ФИО',
    'a@example.com,Anna,Petrova,',
    'b@example.com,Boris,Sokolov,',
  ].join('\n');
  // "Name" is absent, so "Full name" ("ФИО") outranks "First name" — and the
  // family name is never used as the person's name.
  assert.deepEqual(contactsOf(csv), [
    { email: 'a@example.com', name: null },
    { email: 'b@example.com', name: null },
  ]);

  const withFull = ['email,name,family name', 'a@example.com,Anna Petrova,Petrova'].join('\n');
  assert.deepEqual(contactsOf(withFull), [{ email: 'a@example.com', name: 'Anna Petrova' }]);

  const fullOnly = ['email,full name', 'a@example.com,Anna Petrova'].join('\n');
  assert.deepEqual(contactsOf(fullOnly), [{ email: 'a@example.com', name: 'Anna Petrova' }]);
});

test('csv: quoted fields with commas survive the existing CSV parser', () => {
  const csv = ['name,email', '"Petrova, Anna",anna@example.com'].join('\r\n');
  assert.deepEqual(contactsOf(csv), [{ email: 'anna@example.com', name: 'Petrova, Anna' }]);
});

test('csv: no usable header → positional fallback (first address, name on its left)', () => {
  const csv = ['Anna,anna@example.com,Madrid', 'boris@example.com'].join('\n');
  assert.deepEqual(contactsOf(csv), [
    { email: 'anna@example.com', name: 'Anna' },
    { email: 'boris@example.com', name: null },
  ]);
});

test('csv: a headerless file whose first row is data does not lose that row', () => {
  // The first row carries an address, so it is data, not a header.
  const csv = 'Boris,boris@example.com\nAnna,anna@example.com';
  assert.deepEqual(contactsOf(csv), [
    { email: 'boris@example.com', name: 'Boris' },
    { email: 'anna@example.com', name: 'Anna' },
  ]);
});

test('csv: an unterminated quote is refused instead of importing half a file', () => {
  const result = parseContacts('name,email\n"Anna,anna@example.com\n');
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'csv_parse_error');
});

test('csv: rows without any address are counted as skipped', () => {
  const csv = ['email,name', 'a@example.com,Anna', ',Nameless', 'no-address-here,Boris'].join('\n');
  const result = parseContacts(csv);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.contacts, [{ email: 'a@example.com', name: 'Anna' }]);
  assert.equal(result.skipped, 2);
});

test('csv: a BOM and CRLF from a spreadsheet export are tolerated', () => {
  const csv = `\uFEFFemail;name`.replace(';', ',') + '\r\nanna@example.com,Anna\r\n';
  assert.deepEqual(contactsOf(csv), [{ email: 'anna@example.com', name: 'Anna' }]);
});

// ---------------------------------------------------------------------------
// Format detection, limits, degenerate inputs
// ---------------------------------------------------------------------------

test('format: the BEGIN:VCARD marker decides, the .vcf extension is the fallback hint', () => {
  assert.equal(detectContactFormat('BEGIN:VCARD\nEND:VCARD'), 'vcard');
  assert.equal(detectContactFormat('email,name\na@b.co,A'), 'csv');
  // No marker in the text: the extension is all we have, and it is believed.
  assert.equal(detectContactFormat('FN:No Marker', 'contacts.vcf'), 'vcard');
  assert.equal(detectContactFormat('anything', 'contacts.csv'), 'csv');
});

test('format: a .vcf that actually holds CSV answers no_contacts instead of guessing', () => {
  // Deliberate: a wrong extension is reported, not silently reinterpreted —
  // "nothing found" is an honest answer, an invented parse would not be.
  const result = parseContacts('email,name\nanna@example.com,Anna', { filename: 'contacts.vcf' });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'no_contacts');
});

test('limits: more than the contact ceiling is reported as truncated, never silently cut', () => {
  const rows = ['email,name'];
  for (let i = 0; i <= CONTACT_IMPORT_MAX_CONTACTS; i++) rows.push(`person${i}@example.com,Person ${i}`);
  const result = parseContacts(rows.join('\n'));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.contacts.length, CONTACT_IMPORT_MAX_CONTACTS);
  assert.equal(result.truncated, true);

  const exact = ['email,name'];
  for (let i = 0; i < CONTACT_IMPORT_MAX_CONTACTS; i++) exact.push(`person${i}@example.com,Person ${i}`);
  const boundary = parseContacts(exact.join('\n'));
  assert.equal(boundary.ok, true);
  if (!boundary.ok) return;
  assert.equal(boundary.truncated, false, 'exactly at the ceiling is fine');
});

test('limits: an oversized body is refused before parsing', () => {
  const oversized = `${'a'.repeat(CONTACT_IMPORT_MAX_BYTES + 1)}`;
  const result = parseContacts(oversized);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'payload_too_large');
});

test('degenerate input: empty, whitespace and address-less content answer no_contacts', () => {
  for (const input of ['', '   \n  ', 'BEGIN:VCARD\nFN:Nobody\nEND:VCARD', 'name,company\nAnna,ACME']) {
    const result = parseContacts(input);
    assert.equal(result.ok, false, `expected a refusal for ${JSON.stringify(input)}`);
    if (result.ok) continue;
    assert.equal(result.code, 'no_contacts');
  }
});

test('privacy: the parser returns nothing but email + name pairs', () => {
  const vcf = 'BEGIN:VCARD\nFN:Anna\nEMAIL:anna@example.com\nTEL:+34600000000\nEND:VCARD';
  const result = parseContacts(vcf);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  for (const contact of result.contacts) {
    assert.deepEqual(Object.keys(contact).sort(), ['email', 'name']);
  }
  assert.equal(JSON.stringify(result).includes('+34600000000'), false, 'a phone number must not survive the parse');
});
