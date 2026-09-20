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

// ---------------------------------------------------------------------------
// Next.js dynamic route params are a Promise
// ---------------------------------------------------------------------------

/**
 * Next hands dynamic route parameters over as a Promise (`params: Promise<…>`).
 * Reading one synchronously still works, but it is deprecated and dev-only
 * visible as
 *   "A param property was accessed directly with `params.x`. `params` is a
 *    Promise and must be unwrapped with `await` or `React.use()` …"
 * (https://nextjs.org/docs/messages/sync-dynamic-apis) — nothing fails, a
 * warning is printed, and the access is gone from production logs entirely. The
 * only reliable check is a static one, which is this test.
 *
 * Two zero-tolerance invariants over src/app:
 *   1. no `params.<member>` access — route params are read only after
 *      `const { … } = await params`. Nothing else under src/app may call a local
 *      `params` either, which is why the search-param reader in the Google
 *      callback is named `query` and the login page destructures `searchParams`:
 *      the rule needs no allowlist to stay honest.
 *   2. every `params: Promise<…>` declaration is matched by an `await` of that
 *      promise, so a handler cannot take the promise and never unwrap it.
 */
function appSourceFiles(): { file: string; rel: string }[] {
  return listSourceFiles(path.join(SRC_DIR, 'app')).map((file) => ({
    file,
    rel: path.relative(SRC_DIR, file).split(path.sep).join('/'),
  }));
}

test('static safety: route params are never read before being awaited', () => {
  const files = appSourceFiles();
  const syncReads: Finding[] = [];
  const unbalanced: { file: string; declared: number; awaited: number }[] = [];
  let declarations = 0;

  for (const { file, rel } of files) {
    const source = readFileSync(file, 'utf8');
    source.split('\n').forEach((text, i) => {
      if (/\bparams\.[A-Za-z_$]/.test(text)) syncReads.push({ file: rel, line: i + 1, text: text.trim() });
    });
    // `\b` before `params` is what keeps `searchParams: Promise<…>` out of the
    // count — a search-param promise is a different, separately awaited value.
    const declared = source.match(/\bparams\s*:\s*Promise\s*</g)?.length ?? 0;
    const awaited = source.match(/\bawait\s+params\b|\bawait\s+[A-Za-z_$][\w$]*\.params\b/g)?.length ?? 0;
    declarations += declared;
    if (declared !== awaited) unbalanced.push({ file: rel, declared, awaited });
  }

  assert.deepEqual(syncReads, []);
  assert.deepEqual(unbalanced, []);
  // Guards the scanner rather than the code: if a refactor moved the routes out
  // of src/app, both assertions above would pass vacuously.
  assert.ok(declarations >= 30, `expected the app's route params to be scanned, found ${declarations}`);
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
