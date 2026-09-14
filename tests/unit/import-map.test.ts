import test from 'node:test';
import assert from 'node:assert/strict';
import { mapCsvRows, validateMapping, IMPORT_MAX_BYTES, IMPORT_MAX_ROWS, IMPORT_PREVIEW_SAMPLE } from '../../src/domain/import';

test('import constants match the brief (5MB / 5000 rows / preview sample 50)', () => {
  assert.equal(IMPORT_MAX_BYTES, 5 * 1024 * 1024);
  assert.equal(IMPORT_MAX_ROWS, 5000);
  assert.equal(IMPORT_PREVIEW_SAMPLE, 50);
});

test('import: auto-map finds canonical columns', () => {
  const rows = [
    ['name', 'email', 'company', 'role', 'external_id', 'approval_status'],
    ['Alice', 'alice@example.org', 'Acme', 'Engineer', 'g-1', 'approved'],
  ];
  const r = mapCsvRows(rows);
  assert.equal(r.records.length, 1);
  assert.equal(r.records[0]?.name, 'Alice');
  assert.equal(r.records[0]?.email, 'alice@example.org');
  assert.equal(r.records[0]?.company, 'Acme');
  assert.equal(r.records[0]?.role, 'Engineer');
  assert.equal(r.records[0]?.externalId, 'g-1');
  assert.equal(r.records[0]?.approvalStatus, 'approved');
});

test('import: mapping override uses organizer-provided headers', () => {
  const rows = [
    ['Full Name', 'Mail', 'Организация', 'Должность'],
    ['Bob', 'bob@example.org', 'Glob', 'CTO'],
  ];
  const r = mapCsvRows(rows, { name: 'Full Name', email: 'Mail', company: 'Организация', role: 'Должность' });
  assert.equal(r.records.length, 1);
  assert.equal(r.records[0]?.name, 'Bob');
  assert.equal(r.records[0]?.email, 'bob@example.org');
  assert.equal(r.records[0]?.role, 'CTO');
});

test('import: headline column is accepted as role fallback', () => {
  const rows = [['name', 'headline'], ['Carol', 'Designer']];
  const r = mapCsvRows(rows);
  assert.equal(r.records[0]?.role, 'Designer');
});

test('import: emails are normalized; invalid emails flagged, not fatal', () => {
  const rows = [
    ['name', 'email'],
    ['Dave', ' DAVE@Example.ORG '],
    ['Ed', 'not-an-email'],
    ['Fay', ''],
  ];
  const r = mapCsvRows(rows);
  assert.equal(r.records[0]?.email, 'dave@example.org');
  assert.equal(r.records[0]?.emailValid, true);
  assert.equal(r.records[1]?.emailValid, false);
  assert.equal(r.records[2]?.email, null);
  assert.equal(r.errors.length, 0);
});

test('import: approval_status normalization (interpretation ③)', () => {
  const rows = [
    ['name', 'approval_status'],
    ['A', 'confirmed'],
    ['B', ''],
    ['C', 'maybe'],
  ];
  const r = mapCsvRows(rows);
  assert.equal(r.records[0]?.approvalStatus, 'approved');
  assert.equal(r.records[1]?.approvalStatus, 'unknown');
  assert.equal(r.records[2]?.approvalStatus, 'quarantined');
});

test('import: rows without name AND without valid email are errors and skipped', () => {
  const rows = [
    ['name', 'email'],
    ['', ''],
    ['Only Email', 'ok@example.org'],
  ];
  const r = mapCsvRows(rows);
  assert.equal(r.records.length, 1);
  assert.ok(r.errors.length >= 1);
});

test('import: duplicates within a file collapse to the first record', () => {
  const rows = [
    ['name', 'email'],
    ['Gail', 'gail@example.org'],
    ['Gail Dup', 'gail@example.org'],
  ];
  const r = mapCsvRows(rows);
  assert.equal(r.records.length, 1);
  assert.equal(r.records[0]?.name, 'Gail');
  assert.equal(r.preview.duplicatesInFile, 1);
});

test('import: preview sample capped at 50, counts correct', () => {
  const rows: string[][] = [['name', 'email']];
  for (let i = 0; i < 120; i++) rows.push([`Person ${i}`, `p${i}@example.org`]);
  const r = mapCsvRows(rows);
  assert.equal(r.records.length, 120);
  assert.equal(r.preview.totalRows, 120);
  assert.equal(r.preview.sample.length, IMPORT_PREVIEW_SAMPLE);
  assert.equal(r.preview.validEmails, 120);
  assert.equal(r.preview.invalidEmails, 0);
});

test('import: mapped extra columns land in imported_data (formula cells stay data)', () => {
  const rows = [
    ['name', 'email', 'notes'],
    ['Hal', 'hal@example.org', '=HYPERLINK("http://evil.example","win")'],
  ];
  const r = mapCsvRows(rows);
  assert.equal(r.records[0]?.importedData['notes'], '=HYPERLINK("http://evil.example","win")');
});

test('import: empty header row → error, no records', () => {
  const r = mapCsvRows([[], []]);
  assert.equal(r.records.length, 0);
  assert.ok(r.errors.length > 0);
});

// ── Explicit mapping (organizer picks the columns) ──────────────────────────

test('import: mapCsvRows echoes the resolved mapping and the header columns', () => {
  const rows = [
    ['Full Name', 'Mail', 'Company Name'],
    ['Ines', 'ines@example.org', 'Northwind'],
  ];
  const r = mapCsvRows(rows, { name: 'Full Name', email: 'Mail' });
  assert.deepEqual(r.columns, ['Full Name', 'Mail', 'Company Name']);
  assert.equal(r.mapping.name, 'Full Name');
  assert.equal(r.mapping.email, 'Mail');
  // Auto-mapped or unmapped fields are reported honestly, never invented.
  assert.equal(r.mapping.company, null);
  assert.equal(r.mapping.role, null);
  assert.equal(r.mapping.external_id, null);
  assert.equal(r.mapping.approval_status, null);
});

test('import: mapping echo reports the auto-resolved column when no override is given', () => {
  const r = mapCsvRows([['name', 'email'], ['Jo', 'jo@example.org']]);
  assert.equal(r.mapping.name, 'name');
  assert.equal(r.mapping.email, 'email');
});

test('validateMapping: accepts {csvColumn: field} and returns the canonical {field: column}', () => {
  const columns = ['Full Name', 'Mail', 'Org'];
  const v = validateMapping({ 'Full Name': 'name', Mail: 'email', Org: 'company' }, columns);
  assert.equal(v.ok, true);
  if (!v.ok) return;
  assert.deepEqual(v.mapping, { name: 'Full Name', email: 'Mail', company: 'Org' });
});

test('validateMapping: column matching ignores surrounding whitespace and case', () => {
  const v = validateMapping({ ' full name ': 'name' }, ['Full Name']);
  assert.equal(v.ok, true);
  if (!v.ok) return;
  // The header spelling from the CSV is what downstream matching receives.
  assert.equal(v.mapping.name, 'Full Name');
});

test('validateMapping: unknown field → unknown_mapping_field', () => {
  const v = validateMapping({ Name: 'nickname' }, ['Name']);
  assert.equal(v.ok, false);
  if (v.ok) return;
  assert.equal(v.code, 'unknown_mapping_field');
});

test('validateMapping: column absent from the CSV → unknown_csv_column', () => {
  const v = validateMapping({ 'No Such Column': 'name' }, ['Name', 'Email']);
  assert.equal(v.ok, false);
  if (v.ok) return;
  assert.equal(v.code, 'unknown_csv_column');
});

test('validateMapping: two columns for one field → duplicate_mapping_field', () => {
  const v = validateMapping({ Name: 'name', 'Full Name': 'name' }, ['Name', 'Full Name']);
  assert.equal(v.ok, false);
  if (v.ok) return;
  assert.equal(v.code, 'duplicate_mapping_field');
});

test('validateMapping: headline is an alias of role, so role+headline collide', () => {
  const v = validateMapping({ Headline: 'headline', Title: 'role' }, ['Headline', 'Title']);
  assert.equal(v.ok, false);
  if (v.ok) return;
  assert.equal(v.code, 'duplicate_mapping_field');

  // Alone, the alias resolves to the canonical role field.
  const single = validateMapping({ Headline: 'headline' }, ['Headline']);
  assert.equal(single.ok, true);
  if (!single.ok) return;
  assert.equal(single.mapping.role, 'Headline');
});

test('validateMapping: non-string field value → invalid_mapping', () => {
  const v = validateMapping({ Name: 42 }, ['Name']);
  assert.equal(v.ok, false);
  if (v.ok) return;
  assert.equal(v.code, 'invalid_mapping');
});

test('validateMapping: an empty mapping is valid (auto-mapping applies)', () => {
  const v = validateMapping({}, ['Name']);
  assert.equal(v.ok, true);
  if (!v.ok) return;
  assert.deepEqual(v.mapping, {});
});

test('import: explicit mapping changes which value lands in which field', () => {
  // The same file, read twice: auto-mapping cannot know "Эл. адрес" is the email
  // (it is not one of the documented header candidates), an explicit mapping
  // makes it unambiguous.
  const rows = [
    ['name', 'Эл. адрес', 'Заметки'],
    ['Ким, Лена', 'lena@example.org', '=2+2'],
  ];
  const auto = mapCsvRows(rows);
  assert.equal(auto.records[0]?.email, null);
  assert.equal(auto.records[0]?.emailValid, false);

  const v = validateMapping({ name: 'name', 'Эл. адрес': 'email' }, rows[0]!);
  assert.equal(v.ok, true);
  if (!v.ok) return;
  const mapped = mapCsvRows(rows, v.mapping);
  assert.equal(mapped.records[0]?.name, 'Ким, Лена');
  assert.equal(mapped.records[0]?.email, 'lena@example.org');
  assert.equal(mapped.records[0]?.emailValid, true);
  // Unmapped columns are still preserved as data.
  assert.equal(mapped.records[0]?.importedData['Заметки'], '=2+2');
});
