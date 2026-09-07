import test from 'node:test';
import assert from 'node:assert/strict';
import { neutralizeCsvCell, normalizeApprovalStatus, parseCsv } from '../../src/domain/csv';

// ---------------------------------------------------------------------------
// neutralizeCsvCell — CSV formula injection defense (= + - @)
// ---------------------------------------------------------------------------

test('neutralizeCsvCell: formula prefixes get a leading apostrophe', () => {
  assert.equal(neutralizeCsvCell('=cmd|"/c calc"'), "'=cmd|\"/c calc\"");
  assert.equal(neutralizeCsvCell('=HYPERLINK("http://evil.example","x")'), "'=HYPERLINK(\"http://evil.example\",\"x\")");
  assert.equal(neutralizeCsvCell('+SUM(A1)'), "'+SUM(A1)");
  assert.equal(neutralizeCsvCell('-2+3'), "'-2+3");
  assert.equal(neutralizeCsvCell('@import_url'), "'@import_url");
});

test('neutralizeCsvCell: plain values are unchanged', () => {
  assert.equal(neutralizeCsvCell('alice'), 'alice');
  assert.equal(neutralizeCsvCell('Alice Works @ Acme'), 'Alice Works @ Acme');
  assert.equal(neutralizeCsvCell(''), '');
  assert.equal(neutralizeCsvCell("'=already"), "'=already");
});

test('neutralizeCsvCell: only the FIRST character counts (spec security test 13)', () => {
  assert.equal(neutralizeCsvCell(' x=evil'), ' x=evil');
});

// ---------------------------------------------------------------------------
// normalizeApprovalStatus — unknown status → quarantine, never approved
// (interpretation ③: approved/confirmed → approved; unknown/''/missing → unknown;
//  everything else → quarantined)
// ---------------------------------------------------------------------------

test('normalizeApprovalStatus: approved/confirmed (case-insensitive, trimmed) → approved', () => {
  assert.equal(normalizeApprovalStatus('approved'), 'approved');
  assert.equal(normalizeApprovalStatus('Approved '), 'approved');
  assert.equal(normalizeApprovalStatus('CONFIRMED'), 'approved');
  assert.equal(normalizeApprovalStatus('confirmed'), 'approved');
});

test('normalizeApprovalStatus: unknown/empty/missing → unknown', () => {
  assert.equal(normalizeApprovalStatus('unknown'), 'unknown');
  assert.equal(normalizeApprovalStatus(''), 'unknown');
  assert.equal(normalizeApprovalStatus('   '), 'unknown');
  assert.equal(normalizeApprovalStatus(null), 'unknown');
  assert.equal(normalizeApprovalStatus(undefined), 'unknown');
});

test('normalizeApprovalStatus: any other value → quarantined (fail closed)', () => {
  assert.equal(normalizeApprovalStatus('maybe'), 'quarantined');
  assert.equal(normalizeApprovalStatus('yes'), 'quarantined');
  assert.equal(normalizeApprovalStatus('pending'), 'quarantined');
  assert.equal(normalizeApprovalStatus('approved;x'), 'quarantined');
});

// ---------------------------------------------------------------------------
// parseCsv — RFC4180 subset with limits
// ---------------------------------------------------------------------------

test('parseCsv: simple header + rows, LF endings', () => {
  const r = parseCsv('name,email\nAlice,a@x.org\nBob,b@x.org');
  assert.equal(r.errors.length, 0);
  assert.equal(r.truncated, false);
  assert.deepEqual(r.rows, [['name', 'email'], ['Alice', 'a@x.org'], ['Bob', 'b@x.org']]);
});

test('parseCsv: CRLF endings, trailing newline produces no empty row', () => {
  const r = parseCsv('a,b\r\nc,d\r\n');
  assert.deepEqual(r.rows, [['a', 'b'], ['c', 'd']]);
  assert.equal(r.errors.length, 0);
});

test('parseCsv: quoted fields keep commas/newlines as data', () => {
  const r = parseCsv('a,b\n"x,y","line1\nline2"');
  assert.deepEqual(r.rows, [['a', 'b'], ['x,y', 'line1\nline2']]);
  assert.equal(r.errors.length, 0);
});

test('parseCsv: doubled quotes inside quoted fields', () => {
  const r = parseCsv('"he said ""hi"""');
  assert.deepEqual(r.rows, [['he said "hi"']]);
});

test('parseCsv: UTF-8 BOM is stripped', () => {
  const r = parseCsv('\uFEFFa,b\n1,2');
  assert.deepEqual(r.rows, [['a', 'b'], ['1', '2']]);
});

test('parseCsv: empty middle lines are skipped', () => {
  const r = parseCsv('a,b\n\nc,d\n');
  assert.deepEqual(r.rows, [['a', 'b'], ['c', 'd']]);
});

test('parseCsv: unquoted fields are trimmed, quoted fields keep spaces', () => {
  const r = parseCsv(' Alice , x , " keep "');
  assert.deepEqual(r.rows, [['Alice', 'x', ' keep ']]);
});

test('parseCsv: empty input → no rows, no errors', () => {
  assert.deepEqual(parseCsv('').rows, []);
  assert.deepEqual(parseCsv('\n').rows, []);
});

test('parseCsv: maxRows exceeded → truncated flag (rows still parsed, import rejects)', () => {
  const text = ['h1,h2', '1,1', '2,2', '3,3'].join('\n');
  const r = parseCsv(text, { maxRows: 2 });
  assert.equal(r.truncated, true);
  assert.equal(r.rows.length, 4); // header + 3 data rows, flagged
});

test('parseCsv: maxRows not exceeded → not truncated', () => {
  const r = parseCsv('h1,h2\n1,1\n2,2', { maxRows: 2 });
  assert.equal(r.truncated, false);
});

test('parseCsv: row wider than maxColumns → structural error', () => {
  const r = parseCsv('a,b,c\n1,2,3,4', { maxColumns: 3 });
  assert.ok(r.errors.length > 0);
});

test('parseCsv: unterminated quote → structural error', () => {
  const r = parseCsv('a,"b\nc,d');
  assert.ok(r.errors.some((e) => /unterminated/.test(e)));
});

test('parseCsv: quote in the middle of an unquoted field is data (lenient)', () => {
  const r = parseCsv('a"b,c');
  assert.deepEqual(r.rows, [['a"b', 'c']]);
  assert.equal(r.errors.length, 0);
});
