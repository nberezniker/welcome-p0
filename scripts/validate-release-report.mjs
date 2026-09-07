#!/usr/bin/env node
// Validates evidence/release-report.json against spec/contracts/release-report.schema.json.
// Hand-rolled mini-validator: implements exactly the JSON-Schema subset the schema
// uses (type incl. type arrays, enum, required, properties, minLength, minimum,
// items.type, additionalProperties) — no external dependencies.
// Exit 0 = valid, 1 = invalid (problems printed to stderr).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA_PATH = path.join(ROOT, 'spec', 'contracts', 'release-report.schema.json');
const REPORT_PATH = path.join(ROOT, 'evidence', 'release-report.json');

const problems = [];
const fail = (msg) => problems.push(msg);

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v; // 'string' | 'number' | 'boolean' | 'object'
}

function validate(value, schema, where) {
  // type: string or array of strings
  if (schema.type !== undefined) {
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = typeOf(value);
    // JSON Schema: integer accepts numbers with integral value; not needed here.
    if (!expected.includes(actual)) {
      fail(`${where}: type must be ${expected.join('|')}, got ${actual}`);
      return;
    }
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    fail(`${where}: value ${JSON.stringify(value)} not in enum [${schema.enum.join(', ')}]`);
  }
  if (typeof value === 'string' && schema.minLength !== undefined && value.length < schema.minLength) {
    fail(`${where}: length ${value.length} < minLength ${schema.minLength}`);
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) {
    fail(`${where}: ${value} < minimum ${schema.minimum}`);
  }
  if (typeOf(value) === 'object' && !Array.isArray(value) && value !== null) {
    for (const req of schema.required ?? []) {
      if (!(req in value)) fail(`${where}: missing required property "${req}"`);
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in value) validate(value[key], sub, `${where}.${key}`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in (schema.properties ?? {}))) fail(`${where}: additional property "${key}" not allowed`);
      }
    }
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => validate(item, schema.items, `${where}[${i}]`));
  }
}

const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
let report;
try {
  report = JSON.parse(readFileSync(REPORT_PATH, 'utf8'));
} catch (e) {
  console.error(`INVALID: evidence/release-report.json is not parseable JSON: ${e.message}`);
  process.exit(1);
}

validate(report, schema, 'release-report');

// Cross-checks beyond the schema that this release promises to uphold honestly:
if (report.status === 'PASS_STAGING' || report.status === 'PASS_PRODUCTION') {
  fail('release-report: PASS_STAGING/PASS_PRODUCTION claimed — nothing was deployed in this environment');
}
if (typeof report.staging_url === 'string' || typeof report.production_url === 'string') {
  fail('release-report: staging_url/production_url must be null (nothing was deployed)');
}
for (const [k, v] of Object.entries(report.integrations ?? {})) {
  if (typeof v?.status !== 'string') fail(`release-report.integrations.${k}: missing status`);
}

if (problems.length > 0) {
  console.error(`INVALID — ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`OK: evidence/release-report.json conforms to ${path.relative(ROOT, SCHEMA_PATH)}`);
console.log(`    status=${report.status} commit_sha=${report.commit_sha} spend_eur=${report.spend_eur} tests=${report.tests.length} gates`);
