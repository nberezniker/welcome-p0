import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Phase 5 static safety gate (unit): scans src/ for forbidden patterns.
 *  - dangerouslySetInnerHTML: XSS escape hatch — forbidden everywhere;
 *  - eval( / new Function(: dynamic code execution — forbidden everywhere;
 *  - server-side fetch to non-allowlisted hosts: P0 must never fetch remote
 *    URLs (SSRF, spec 04 §9) — the ONLY outbound host allowed is
 *    https://api.telegram.org, and ONLY inside integrations/telegram/transport.ts.
 * Tripwire limitation: fetch targets spanning multiple lines are not parsed;
 * every current call site is single-line. */

const SRC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
const OUTBOUND_ALLOWLIST_FILE = 'integrations/telegram/transport.ts';
const OUTBOUND_ALLOWLIST_HOST = 'api.telegram.org';

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

interface Finding {
  file: string;
  line: number;
  text: string;
}

function scan(pattern: RegExp, filter?: (relFile: string, lineText: string) => boolean): Finding[] {
  const findings: Finding[] = [];
  for (const file of listSourceFiles(SRC_DIR)) {
    const rel = path.relative(SRC_DIR, file).split(path.sep).join('/');
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((text, i) => {
      if (pattern.test(text) && (!filter || filter(rel, text))) {
        findings.push({ file: rel, line: i + 1, text: text.trim() });
      }
    });
  }
  return findings;
}

test('static safety: no dangerouslySetInnerHTML anywhere in src/', () => {
  const findings = scan(/dangerouslySetInnerHTML/);
  assert.deepEqual(findings, []);
});

test('static safety: no eval( or new Function( anywhere in src/', () => {
  const evalFindings = scan(/\beval\(/);
  assert.deepEqual(evalFindings, []);
  const functionFindings = scan(/new\s+Function\s*\(/);
  assert.deepEqual(functionFindings, []);
});

test('static safety: fetch( targets stay within the outbound allowlist', () => {
  // 1. Any fetch line carrying an absolute http(s) URL must live in the
  //    allowlisted transport file and reference api.telegram.org.
  const absolute = scan(/\bfetch\(/, (relFile, lineText) => /['"`]https?:\/\//.test(lineText));
  const offenders = absolute.filter(
    (f) => !(f.file === OUTBOUND_ALLOWLIST_FILE && f.text.includes(OUTBOUND_ALLOWLIST_HOST)),
  );
  assert.deepEqual(offenders, []);

  // 2. Client fetches must use relative paths — no http literal in the call line.
  const clientWithHttp = scan(/\bfetch\(/, (relFile, lineText) =>
    relFile !== OUTBOUND_ALLOWLIST_FILE && /http:\/\//.test(lineText));
  assert.deepEqual(clientWithHttp, []);

  // 3. The allowlisted transport must actually pin the allowlisted host.
  const transport = readFileSync(path.join(SRC_DIR, 'integrations', 'telegram', 'transport.ts'), 'utf8');
  assert.ok(transport.includes('https://api.telegram.org'), 'transport must call api.telegram.org explicitly');
});
