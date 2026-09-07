#!/usr/bin/env node
// Scans git-tracked files for obvious secrets and fails on any hit.
// The protected spec/ baseline is excluded from scanning.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
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

const files = trackedFiles().filter((f) => !EXCLUDED(f));
let hits = 0;

for (const file of files) {
  const abs = path.join(ROOT, file);
  let content;
  try {
    const stat = execFileSync('git', ['-C', ROOT, 'cat-file', '-s', `HEAD:${file}`], { encoding: 'utf8' });
    if (parseInt(stat, 10) > 2 * 1024 * 1024) continue;
  } catch {
    // untracked/unknown size — still scan small files below
  }
  try {
    content = readFileSync(abs, 'utf8');
  } catch {
    continue; // deleted or binary-unreadable
  }
  if (content.includes('\u0000')) continue; // binary

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const p of PATTERNS) {
      if (p.re.test(lines[i])) {
        hits++;
        console.error(`SECRET HIT [${p.name}] ${file}:${i + 1}`);
      }
    }
  }
}

if (hits > 0) {
  console.error(`scan:secrets FAILED — ${hits} potential secret(s) found`);
  process.exit(1);
}
console.log('scan:secrets ok — no secrets found in tracked files');
