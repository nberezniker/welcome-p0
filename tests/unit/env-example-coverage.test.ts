import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDERS, REQUIRED_ENV } from '../../src/domain/providers';

/**
 * `.env.example` must not drift from the code.
 *
 * A self-hoster clones the repo and reads exactly one environment file. If the
 * code grows a variable that the example file does not mention, that deployment
 * has a feature quietly behaving differently from the documentation — the exact
 * "pretending" this project refuses to do.
 *
 * Three invariants, all static (no app boot, no database):
 *
 *   1. COVERAGE — every variable the application code reads is documented;
 *   2. NO PHANTOMS — every documented variable is either read by the code or
 *      declared by the provider registry. This is what caught the file's old
 *      `LOG_LEVEL` / `AUTH_BASE_URL` / `SENTRY_DSN` / `WHATSAPP_*` entries: names
 *      nothing reads, which a reader would fill in expecting an effect;
 *   3. LABELS — every documented variable says REQUIRED or OPTIONAL (<feature>),
 *      so "which features need what" is answerable by reading the file.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXAMPLE_PATH = path.join(ROOT, '.env.example');

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/** Every `*.ts`/`*.tsx` under a directory, relative to the repo root. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...sourceFiles(rel));
    else if (/\.tsx?$/.test(entry.name)) out.push(rel);
  }
  return out;
}

/**
 * Variables read by code. Mirrors the shapes the runtime actually uses:
 * `process.env.NAME`, `process.env['NAME']`, and the `env.NAME` / `env['NAME']`
 * access the transports use on their injected env record (that injection is what
 * makes them testable, so it must not be missed here).
 */
function envReads(text: string): Set<string> {
  const names = new Set<string>();
  for (const m of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) names.add(m[1]!);
  for (const m of text.matchAll(/process\.env\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g)) names.add(m[1]!);
  for (const m of text.matchAll(/(?:^|[^\w.$])(?:env|Env|ENV)\.([A-Z][A-Z0-9_]*)/g)) names.add(m[1]!);
  for (const m of text.matchAll(/(?:^|[^\w.$])(?:env|Env|ENV)\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g)) names.add(m[1]!);
  return names;
}

/** Names assigned by an uncommented `NAME=…` line, with their line numbers. */
function documentedNames(text: string): Map<string, number> {
  const names = new Map<string, number>();
  text.split('\n').forEach((line, index) => {
    const m = /^([A-Z][A-Z0-9_]*)=/.exec(line);
    if (m) names.set(m[1]!, index + 1);
  });
  return names;
}

/** The contiguous comment block directly above a line (a blank line ends it). */
function labelBlock(text: string, lineNumber: number): string {
  const lines = text.split('\n');
  const block: string[] = [];
  for (let i = lineNumber - 2; i >= 0; i -= 1) {
    const line = lines[i]!;
    if (!line.startsWith('#')) break;
    block.unshift(line);
  }
  return block.join('\n');
}

// ---------------------------------------------------------------------------
// The scope of "the application"
// ---------------------------------------------------------------------------

/**
 * Files whose env reads must be documented. `src/` is the running application;
 * `next.config.ts` is part of it (CSP and redirect rules are evaluated from env
 * at boot). Operator scripts and tests are deliberately OUT of scope: they read
 * throwaway variables (`INTEGRATION_DATABASE_URL`, `E2E_PORT`, `PG18_BIN`,
 * `MATRIX_OWNER_EMAIL`) that a self-hoster never sets, and documenting them in
 * the one file a newcomer reads would bury the five variables that matter.
 */
const IN_SCOPE = [...sourceFiles('src'), 'next.config.ts'];

/**
 * Provided by the runtime, not by the operator: `next dev` sets it, and a value
 * in `.env.local` would be overwritten by the framework anyway.
 */
const FRAMEWORK_PROVIDED = new Set(['NODE_ENV']);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const exampleText = readFileSync(EXAMPLE_PATH, 'utf8');
const documented = documentedNames(exampleText);

const codeReads = new Set<string>();
for (const file of IN_SCOPE) {
  for (const name of envReads(readFileSync(path.join(ROOT, file), 'utf8'))) codeReads.add(name);
}

/** Names the provider registry publishes in the UI, read by no code (yet). */
const registryNames = new Set<string>([
  ...PROVIDERS.flatMap((provider) => provider.setup.env),
  ...Object.values(REQUIRED_ENV).flatMap((names) => names ?? []),
]);

test('.env.example documents every variable the application reads', () => {
  const undocumented = [...codeReads].filter((name) => !documented.has(name) && !FRAMEWORK_PROVIDED.has(name));
  assert.deepEqual(
    undocumented.sort(),
    [],
    'add these to .env.example (name + REQUIRED/OPTIONAL label + how to obtain it)',
  );
});

test('.env.example has no variable that nothing reads', () => {
  const phantoms = [...documented.keys()].filter((name) => !codeReads.has(name) && !registryNames.has(name));
  assert.deepEqual(
    phantoms.sort(),
    [],
    'these names are not read by any code and are not declared by the provider registry — ' +
      'a reader would set them and see nothing happen; remove them or declare the provider',
  );
});

test('.env.example labels every variable REQUIRED or OPTIONAL (<feature>)', () => {
  const unlabelled: string[] = [];
  for (const [name, line] of documented) {
    const block = labelBlock(exampleText, line);
    if (!/\bREQUIRED\b/.test(block) && !/\bOPTIONAL\b/.test(block)) unlabelled.push(`${name} (line ${line})`);
  }
  assert.deepEqual(unlabelled.sort(), [], 'each entry needs its own REQUIRED / OPTIONAL comment block');
});

test('.env.example labels the five variables the app cannot boot without as REQUIRED', () => {
  // The contract in prose, pinned so the file cannot lose it: this is what a
  // stranger needs to get a running instance, and nothing else is mandatory.
  const required = new Set<string>();
  for (const [name, line] of documented) {
    if (/\bREQUIRED\b/.test(labelBlock(exampleText, line))) required.add(name);
  }
  assert.deepEqual(
    [...required].sort(),
    ['APP_BASE_URL', 'APP_ENV', 'DATABASE_URL', 'ENCRYPTION_KEY', 'HASH_PEPPER'],
    'exactly these five are REQUIRED; everything else must be an optional feature',
  );
});

test('.env.example assigns each variable once', () => {
  const occurrences = new Map<string, number>();
  for (const line of exampleText.split('\n')) {
    const m = /^([A-Z][A-Z0-9_]*)=/.exec(line);
    if (m) occurrences.set(m[1]!, (occurrences.get(m[1]!) ?? 0) + 1);
  }
  const duplicates = [...occurrences].filter(([, count]) => count > 1).map(([name]) => name);
  assert.deepEqual(duplicates, [], 'a duplicate entry makes the file ambiguous about which line wins');
});

test('.env.example is not the deployment: no tracked value looks like a credential', () => {
  // Belt-and-braces with scan:secrets: the example file is the one place a
  // developer is tempted to paste a working key "temporarily".
  for (const line of exampleText.split('\n')) {
    if (line.startsWith('#')) continue;
    const value = line.slice(line.indexOf('=') + 1);
    assert.ok(
      value.length < 40 || !/^[A-Za-z0-9+/_-]{40,}$/.test(value),
      `line looks like a committed value, not a placeholder: ${line}`,
    );
  }
});
