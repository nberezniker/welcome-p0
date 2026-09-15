#!/usr/bin/env node
// Runs the seven release gates sequentially and records the outcome in
// evidence/final-gates.{json,log}. Overwrites the previous run, keeping its
// timestamp/sha in `previous_run` so the history stays auditable.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const JSON_PATH = path.join(ROOT, 'evidence', 'final-gates.json');
const LOG_PATH = path.join(ROOT, 'evidence', 'final-gates.log');

const GATES = [
  { command: 'pnpm typecheck', match: [] },
  { command: 'pnpm lint', match: [] },
  { command: 'pnpm test:unit', match: [/^# (tests|pass|fail) /] },
  { command: 'pnpm test:integration', match: [/^# (tests|pass|fail|skipped) /] },
  { command: 'pnpm test:e2e', match: [/passed|failed/] },
  { command: 'pnpm build', match: [/Compiled successfully|Generating static pages|Route \(app\)/] },
  { command: 'pnpm scan:secrets', match: [/scan:secrets/] },
];

function headSha() {
  const out = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  return out.stdout.trim();
}

function readPrevious() {
  try {
    const previous = JSON.parse(readFileSync(JSON_PATH, 'utf8'));
    return { generated_at: previous.generated_at, head_sha_at_gate_run: previous.head_sha_at_gate_run };
  } catch {
    return null;
  }
}

const previousRun = existsSync(JSON_PATH) ? readPrevious() : null;
const startedAt = new Date();
writeFileSync(
  LOG_PATH,
  `== final gates ${startedAt.toISOString()} head=${headSha()} ==\n`,
  'utf8',
);

const gates = [];
for (const gate of GATES) {
  const gateStart = Date.now();
  const result = spawnSync(gate.command, { shell: true, cwd: ROOT, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  const durationS = Math.round((Date.now() - gateStart) / 1000);
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  appendFileSync(LOG_PATH, `\n== ${gate.command} exit=${result.status} duration=${durationS}s ==\n${output}\n`, 'utf8');

  const summary = output
    .split('\n')
    .filter((line) => gate.match.some((re) => re.test(line.trim())))
    .slice(0, 8);
  if (summary.length === 0) {
    const tail = output.split('\n').filter((l) => l.trim().length > 0).slice(-3);
    summary.push(...tail);
  }

  gates.push({ command: gate.command, exit_code: result.status ?? 1, duration_s: durationS, summary_lines: summary });
  console.log(`${gate.command} → exit ${result.status} (${durationS}s)`);
}

const countOf = (log, re) => {
  const m = log.match(re);
  return m ? Number(m[1]) : 0;
};
const unitLog = gates.find((g) => g.command === 'pnpm test:unit')?.summary_lines.join('\n') ?? '';
const integrationLog = gates.find((g) => g.command === 'pnpm test:integration')?.summary_lines.join('\n') ?? '';
const e2eLog = gates.find((g) => g.command === 'pnpm test:e2e')?.summary_lines.join('\n') ?? '';
const e2ePassed = Number((e2eLog.match(/(\d+) passed/) ?? [])[1] ?? 0);
const e2eFailed = Number((e2eLog.match(/(\d+) failed/) ?? [])[1] ?? 0);

const report = {
  generated_at: new Date().toISOString(),
  head_sha_at_gate_run: headSha(),
  note: 'The seven release gates run fresh and sequentially on the working tree; the combined output is evidence/final-gates.log.',
  previous_run: previousRun,
  gates,
  totals: {
    gates_total: gates.length,
    gates_exit_zero: gates.filter((g) => g.exit_code === 0).length,
    unit: { pass: countOf(unitLog, /^# pass (\d+)/m), fail: countOf(unitLog, /^# fail (\d+)/m) },
    integration: {
      pass: countOf(integrationLog, /^# pass (\d+)/m),
      fail: countOf(integrationLog, /^# fail (\d+)/m),
      skipped: countOf(integrationLog, /^# skipped (\d+)/m),
    },
    e2e: { pass: e2ePassed, fail: e2eFailed },
  },
};

writeFileSync(JSON_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
appendFileSync(LOG_PATH, `\n== summary ${JSON.stringify(report.totals)} ==\n`, 'utf8');
console.log(JSON.stringify(report.totals, null, 2));
process.exit(report.totals.gates_exit_zero === gates.length ? 0 : 1);
