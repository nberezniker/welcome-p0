import test from 'node:test';
import assert from 'node:assert/strict';
import { mapCsvRows, IMPORT_MAX_BYTES, IMPORT_MAX_ROWS, IMPORT_PREVIEW_SAMPLE } from '../../src/domain/import';

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
