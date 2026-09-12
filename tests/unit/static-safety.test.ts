import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Phase 5 static safety gate (unit): scans src/ for forbidden patterns.
 *  - dangerouslySetInnerHTML: XSS escape hatch — forbidden everywhere;
 *  - eval( / new Function(: dynamic code execution — forbidden everywhere;
 *  - server-side fetch to non-allowlisted hosts: P0 must never fetch remote
 *    URLs (SSRF, spec 04 §9) — outbound hosts are allowed ONLY inside their
 *    dedicated transport file under integrations/ (telegram Bot API; Resend
 *    email API, F-01; Vertex AI enrichment, TAXONOMY v3).
 * Tripwire limitation: fetch targets spanning multiple lines are not parsed;
 * every current call site is single-line. */

const SRC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

/**
 * Approved outbound hosts. `file: null` reserves a host that has been reviewed
 * and approved but has no call site yet — such an entry can NEVER authorize a
 * fetch (only an entry naming the exact file can), the next provider still has
 * to add its own file entry.
 */
const OUTBOUND_ALLOWLIST: { file: string | null; host: string }[] = [
  { file: 'integrations/telegram/transport.ts', host: 'api.telegram.org' },
  { file: 'integrations/email/transport.ts', host: 'api.resend.com' },
  { file: 'integrations/enrichment/transport.ts', host: 'aiplatform.googleapis.com' },
  // Pre-approved for a future Vertex AI Search (Discovery Engine) provider.
  { file: null, host: 'discoveryengine.googleapis.com' },
];

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
  // 1. Any fetch line carrying an absolute http(s) URL must live in an
  //    allowlisted transport file and reference that file's allowlisted host.
  const absolute = scan(/\bfetch\(/, (relFile, lineText) => /['"`]https?:\/\//.test(lineText));
  const offenders = absolute.filter(
    (f) => !OUTBOUND_ALLOWLIST.some((a) => f.file === a.file && f.text.includes(a.host)),
  );
  assert.deepEqual(offenders, []);

  // 2. Client fetches must use relative paths — no http literal in the call line.
  const allowlistedFiles = new Set(OUTBOUND_ALLOWLIST.map((a) => a.file).filter((f): f is string => f !== null));
  const clientWithHttp = scan(/\bfetch\(/, (relFile, lineText) =>
    !allowlistedFiles.has(relFile) && /http:\/\//.test(lineText));
  assert.deepEqual(clientWithHttp, []);

  // 3. Every allowlisted transport that names a file must actually pin its host.
  for (const a of OUTBOUND_ALLOWLIST) {
    if (a.file === null) continue; // reserved host, no call site yet
    const transport = readFileSync(path.join(SRC_DIR, ...a.file.split('/')), 'utf8');
    assert.ok(transport.includes(`https://${a.host}`), `${a.file} must call https://${a.host} explicitly`);
  }
});
