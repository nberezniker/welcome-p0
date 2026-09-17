#!/usr/bin/env node
// Scans git-tracked files for obvious secrets and fails on any hit.
// The protected spec/ baseline is excluded from scanning.
//
// ---------------------------------------------------------------------------
// PER-LINE EXEMPTIONS — `secret-scan:allow <reason>`
//
// A true-positive-shaped string sometimes has to exist in a tracked file: a test
// needs a value that LOOKS like an OAuth token to prove the parser handles it.
// Deleting the fixture or loosening the pattern would both cost real protection,
// so this scanner accepts an explicit, in-place exemption instead:
//
//     const ACCESS_TOKEN = 'ya29.synthetic';  // secret-scan:allow <reason>
//
// Rules that keep an exemption from becoming a silent bypass:
//
//   1. it must sit in a COMMENT on the very same line as the offending literal
//      (the marker is only recognised after `//`, `#`, `/*`, `<!--` or `--`), so
//      it cannot be smuggled in as data;
//   2. the reason is MANDATORY and must be at least MIN_REASON_LENGTH
//      characters — `secret-scan:allow x` is not an exemption, it is a hit;
//   3. every exemption is PRINTED on every run (stdout, under EXEMPTION), with
//      file, line, matched pattern and the reason verbatim, so the list is
//      reviewable without opening the files;
//   4. a marker on a line that matches nothing is reported as a STALE EXEMPTION,
//      and a marker whose reason is missing/too short is reported as MALFORMED —
//      a malformed marker does NOT exempt anything.
//
// The mechanism is deliberately in-band: a reviewer reading a diff sees the
// exemption and its justification next to the change that needed it.
// ---------------------------------------------------------------------------

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Repo root to scan. `--root <dir>` overrides it: the gate has to be provable on
 * a throwaway repo (tests/unit/scan-secrets-exemptions.test.ts) so its
 * protection can be demonstrated without touching this working tree.
 */
export function resolveRoot(argv = process.argv) {
  const at = argv.indexOf('--root');
  if (at === -1) return path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const value = argv[at + 1];
  if (!value) {
    console.error('scan:secrets --root requires a directory argument');
    process.exit(2);
  }
  return path.resolve(value);
}

const ROOT = resolveRoot();
const SELF = 'scripts/scan-secrets.mjs';

const PATTERNS = [
  { name: 'OpenAI-style key', re: /sk-[A-Za-z0-9]{20,}/ },
  { name: 'AWS access key id', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'private key block', re: /BEGIN (RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY/ },
  { name: 'GitHub token', re: /gh[pousr]_[A-Za-z0-9]{36,}/ },
  { name: 'GitHub fine-grained PAT', re: /github_pat_[A-Za-z0-9_]{20,}/ },
  { name: 'Telegram bot token', re: /\b\d{5,}:[A-Za-z0-9_-]{30,}\b/ },
  { name: 'Slack token', re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'Google API key', re: /AIza[0-9A-Za-z_-]{35}/ },
  { name: 'assigned password literal', re: /\b(password|passwd|pwd|api[_-]?key|secret|access[_-]?token)\b\s*[:=]\s*["'][^"']{8,}["']/i },
  { name: 'JWT', re: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
];

/**
 * Comment opener + `secret-scan:allow` + the reason, to end of line. The reason
 * group is OPTIONAL in the regex on purpose: `secret-scan:allow` with nothing
 * after it is still an intended exemption, and labelling it MALFORMED (with the
 * length complaint) is far more useful than reporting a bare SECRET HIT.
 */
export const EXEMPTION_MARKER = /(?:\/\/|#|\/\*|<!--|--)\s*secret-scan:allow\b[ \t]*(\S.*)?$/;

/** Shortest accepted reason; blocks `secret-scan:allow x` as a bypass. */
export const MIN_REASON_LENGTH = 12;

/**
 * Scans one file's text. Pure — no git, no fs — so a unit test can feed it
 * fixtures directly.
 *
 * Returns four buckets; the CLI decides what is fatal:
 *   - `hits`       unmarked matches                       → FAIL;
 *   - `malformed`  marked matches with a missing/short reason → FAIL;
 *   - `exemptions` marked matches with a valid reason     → printed, not fatal;
 *   - `stale`      markers on lines that match nothing    → printed, not fatal.
 */
export function scanText(content, file = '<text>') {
  const hits = [];
  const malformed = [];
  const exemptions = [];
  const stale = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const matched = PATTERNS.filter((p) => p.re.test(line));

    const marker = EXEMPTION_MARKER.exec(line);
    if (!marker) {
      for (const p of matched) hits.push({ file, line: i + 1, pattern: p.name });
      continue;
    }

    // Strip a trailing block-comment close so `/* … */` yields the same reason
    // text as `// …`.
    const reason = (marker[1] ?? '').replace(/\*\/\s*$/, '').trim();

    if (matched.length === 0) {
      stale.push({ file, line: i + 1, reason });
      continue;
    }
    if (reason.length < MIN_REASON_LENGTH) {
      for (const p of matched) malformed.push({ file, line: i + 1, pattern: p.name, reason });
      continue;
    }
    for (const p of matched) exemptions.push({ file, line: i + 1, pattern: p.name, reason });
  }

  return { hits, malformed, exemptions, stale };
}

function trackedFiles() {
  try {
    const out = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
    return out.split('\0').filter(Boolean);
  } catch {
    console.error('scan:secrets requires a git repository');
    process.exit(1);
  }
}

const EXCLUDED = (f) =>
  f.startsWith('spec/') || // protected baseline (contains reference patterns itself)
  f === SELF ||
  f === 'pnpm-lock.yaml'; // dependency metadata only

function scanTrackedFiles() {
  const result = { hits: [], malformed: [], exemptions: [], stale: [] };
  for (const file of trackedFiles().filter((f) => !EXCLUDED(f))) {
    const abs = path.join(ROOT, file);
    try {
      const stat = execFileSync('git', ['-C', ROOT, 'cat-file', '-s', `HEAD:${file}`], { encoding: 'utf8' });
      if (parseInt(stat, 10) > 2 * 1024 * 1024) continue;
    } catch {
      // untracked/unknown size — still scan small files below
    }
    let content;
    try {
      content = readFileSync(abs, 'utf8');
    } catch {
      continue; // deleted or binary-unreadable
    }
    if (content.includes('\u0000')) continue; // binary

    const one = scanText(content, file);
    for (const key of Object.keys(result)) result[key].push(...one[key]);
  }
  return result;
}

function formatExemption(e) {
  return `EXEMPTION [${e.pattern}] ${e.file}:${e.line} — ${e.reason}`;
}

/** Prints everything that is wrong and exits 1. Exemptions never reach here. */
function reportFailure({ hits, malformed }, exemptionCount) {
  for (const h of hits) console.error(`SECRET HIT [${h.pattern}] ${h.file}:${h.line}`);
  for (const m of malformed) {
    console.error(
      `SECRET HIT [${m.pattern}] ${m.file}:${m.line} — the 'secret-scan:allow' marker is not a ` +
        `valid exemption: the reason must be at least ${MIN_REASON_LENGTH} characters ` +
        `(got ${m.reason.length}${m.reason.length === 0 ? ', empty' : `: "${m.reason}"`})`,
    );
  }
  console.error(
    `scan:secrets FAILED — ${hits.length + malformed.length} potential secret(s) found ` +
      `(${exemptionCount} documented exemption(s) are not counted among them)`,
  );
  process.exit(1);
}

// Main guard: importable as a module by tests, runnable as a script by pnpm.
const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const found = scanTrackedFiles();

  // Exemptions are printed on EVERY run, pass or fail — that is the whole point
  // of the mechanism (header rule 3). stdout, so even a green gate shows them.
  for (const e of found.exemptions) console.log(formatExemption(e));
  for (const s of found.stale) {
    console.log(
      `STALE EXEMPTION ${s.file}:${s.line} — the marker matches nothing on this line; remove it ` +
        `(reason was: "${s.reason}")`,
    );
  }

  if (found.hits.length > 0 || found.malformed.length > 0) {
    reportFailure(found, found.exemptions.length);
  }
  console.log(
    `scan:secrets ok — no secrets found in tracked files ` +
      `(${found.exemptions.length} documented exemption(s), ${found.stale.length} stale)`,
  );
}
