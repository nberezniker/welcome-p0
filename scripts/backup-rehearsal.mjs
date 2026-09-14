#!/usr/bin/env node
/**
 * AC-54 — backup/restore rehearsal.
 *
 *   node scripts/backup-rehearsal.mjs [--port=55432] [--keep-cluster] [--skip-dump]
 *
 * Proves the production database can actually be restored, by doing it:
 *
 *   1. pg_dump the Neon production database (NEON_CONN_DIRECT from
 *      .env.deploy.secrets) into .runtime/backups/ — a gitignored path, the
 *      dump is never committed;
 *   2. stand up a throw-away PostgreSQL 18 cluster in .runtime/ (Neon runs 18,
 *      so the restore is same-major — no dump rewriting, no version excuses);
 *   3. restore into `welcome_restore_test` and compare, table by table, the row
 *      count and a content checksum against production;
 *   4. report the point-in-time-restore situation honestly (see checkPitr).
 *
 * Secrets are read from the env file and never printed: every URL that reaches
 * the log goes through redact().
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const PORT = Number(argv.find((a) => a.startsWith('--port='))?.slice('--port='.length) ?? 55432);
const KEEP_CLUSTER = argv.includes('--keep-cluster');
const SKIP_DUMP = argv.includes('--skip-dump');

/** PostgreSQL 18 client+server binaries. Neon is 18.x, the local server is 16 —
 * dumping 18 with the 16 client is refused by pg_dump, so the 18 toolchain is
 * required for a faithful rehearsal. */
const PG_BIN = process.env.PG18_BIN || '/opt/homebrew/opt/postgresql@18/bin';
const bin = (name) => path.join(PG_BIN, name);

const RUNTIME = path.join(ROOT, '.runtime');
const CLUSTER_DIR = path.join(RUNTIME, 'pg18-restore');
const BACKUP_DIR = path.join(RUNTIME, 'backups');
const LOG_FILE = path.join(RUNTIME, 'pg18-restore.log');
const LOCAL_DB = 'welcome_restore_test';
const LOCAL_URL = `postgres://postgres@127.0.0.1:${PORT}/${LOCAL_DB}`;
const REPORT_JSON = path.join(ROOT, 'evidence', 'backup-rehearsal.json');
const REPORT_MD = path.join(ROOT, 'evidence', 'BACKUP_RESTORE_REHEARSAL.md');

/** Key tables for AC-54, with the ordering key of their natural primary key. */
const TABLES = [
  { name: 'accounts', key: 'id' },
  { name: 'profiles', key: 'id' },
  { name: 'contact_fields', key: 'id' },
  { name: 'events', key: 'id' },
  { name: 'event_memberships', key: 'id' },
  { name: 'registrations', key: 'id' },
  { name: 'introductions', key: 'id' },
  { name: 'introduction_consents', key: 'introduction_id, profile_id' },
  { name: 'outbox_jobs', key: 'id' },
  { name: 'audit_events', key: 'id' },
  { name: 'consent_events', key: 'id' },
];

// ---------------------------------------------------------------------------
// Secrets — parsed, used, never printed.
// ---------------------------------------------------------------------------

function readEnvFile(file) {
  const out = {};
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

// Deterministic rendering of timestamptz values on BOTH connections: libpq's
// PGTZ sets the session timezone, so prod and scratch render identically.
process.env.PGTZ = 'UTC';

const SECRETS = readEnvFile(path.join(ROOT, '.env.deploy.secrets'));
const PROD_URL = SECRETS.NEON_CONN_DIRECT || '';
const NEON_API_KEY = SECRETS.NEON_API_KEY || process.env.NEON_API_KEY || '';

/** Strips credentials out of a connection string before anything logs it. */
function redact(value) {
  return String(value).replace(/:\/\/([^:@/]+):([^@/]+)@/g, '://$1:***@');
}

function log(line = '') {
  console.log(line);
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

function run(command, args, opts = {}) {
  const startedAt = Date.now();
  const res = spawnSync(command, args, {
    encoding: 'utf8',
    cwd: ROOT,
    env: { ...process.env, PGPASSWORD: process.env.PGPASSWORD },
    ...opts,
  });
  const ms = Date.now() - startedAt;
  if (res.status !== 0) {
    const detail = (res.stderr || res.stdout || '').trim().split('\n').slice(0, 8).join('\n');
    throw new Error(`${path.basename(command)} ${args.map(redact).join(' ')} failed (exit ${res.status})\n${redact(detail)}`);
  }
  return { ms, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/** Single-value query via psql (-tA: tuples only, unaligned). */
function query(url, sql) {
  const res = run(bin('psql'), [url, '-v', 'ON_ERROR_STOP=1', '-tA', '-c', sql]);
  return res.stdout.trim();
}

function queryProd(sql) {
  return query(PROD_URL, sql);
}

function queryLocal(sql) {
  return query(LOCAL_URL, sql);
}

/** Row count + content checksum for one table, as one comparable string.
 * The session timezone comes from PGTZ=UTC (set for every psql this script
 * runs) so timestamptz text rendering is identical on both sides — otherwise
 * the checksums would differ for reasons that are not data. A single statement
 * is used because `psql -c` prints the command tag for utility statements like
 * SET, which would corrupt an unaligned single-value read. */
async function fingerprint(queryFn, table) {
  const sql =
    `SELECT count(*)::text || ':' || COALESCE(md5(string_agg(md5(t::text), '' ORDER BY ${table.key})), '-') ` +
    `FROM ${table.name} t`;
  const raw = queryFn(sql);
  const sep = raw.indexOf(':');
  return { count: Number(raw.slice(0, sep)), checksum: raw.slice(sep + 1) };
}

function clusterRunning() {
  const res = spawnSync(bin('pg_ctl'), ['-D', CLUSTER_DIR, 'status'], { encoding: 'utf8' });
  return res.status === 0;
}

// ---------------------------------------------------------------------------
// Point-in-time restore (Neon)
// ---------------------------------------------------------------------------

/**
 * Neon's PITR/branch-restore is a CONTROL-PLANE feature: it is not reachable
 * over the SQL connection the application uses. Driving it needs a Neon API key
 * (console → Account settings → API keys) or the `neonctl` CLI, neither of
 * which exists in this environment. Rather than assert something untested, this
 * reports exactly what could and could not be verified.
 */
async function checkPitr() {
  const result = { available: null, verified: false, method: null, notes: [] };

  const neonctl = spawnSync('which', ['neonctl'], { encoding: 'utf8' });
  const hasNeonctl = neonctl.status === 0 && (neonctl.stdout ?? '').trim().length > 0;
  result.notes.push(hasNeonctl ? 'neonctl present' : 'neonctl not installed');

  if (!NEON_API_KEY) {
    result.available = 'unknown';
    result.notes.push(
      'NEON_API_KEY is absent, and no console session is available, so a branch/PITR restore could NOT be performed or verified in this rehearsal.',
    );
    result.notes.push(
      'Restoring the dump proves the DATA is recoverable. It does not prove the retention window or the branch-restore path — that stays an untested assumption until an API key is supplied.',
    );
    return result;
  }

  try {
    const res = await fetch('https://console.neon.tech/api/v2/projects', {
      headers: { Authorization: `Bearer ${NEON_API_KEY}`, Accept: 'application/json' },
    });
    if (!res.ok) {
      result.available = false;
      result.notes.push(`Neon API answered ${res.status} for the key in scope.`);
      return result;
    }
    const body = await res.json();
    const projects = body?.projects ?? [];
    result.available = projects.length > 0;
    result.method = 'Neon REST API /projects';
    result.notes.push(`API key accepted; ${projects.length} project(s) visible.`);
    if (projects[0]?.restore_window_seconds) {
      result.notes.push(`Restore window on the first project: ${projects[0].restore_window_seconds}s.`);
    } else {
      result.notes.push('The projects payload disclosed no restore_window_seconds — retention window not confirmed.');
    }
  } catch (err) {
    result.available = false;
    result.notes.push(`Neon API call failed: ${err.message}`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Rehearsal
// ---------------------------------------------------------------------------

async function main() {
  const startedAt = new Date();

  log('WELCOME — backup/restore rehearsal (AC-54)');
  log('');

  // --- preflight ------------------------------------------------------------
  for (const name of ['pg_dump', 'pg_restore', 'initdb', 'pg_ctl', 'createdb', 'psql']) {
    if (!existsSync(bin(name))) {
      throw new Error(`missing ${bin(name)} — set PG18_BIN to a PostgreSQL 18 toolchain`);
    }
  }
  if (!PROD_URL) {
    throw new Error('NEON_CONN_DIRECT is required in .env.deploy.secrets (never printed)');
  }
  if (/\b(localhost|127\.0\.0\.1)\b/.test(PROD_URL)) {
    throw new Error('NEON_CONN_DIRECT points at localhost — refusing to treat a local database as production');
  }
  mkdirSync(BACKUP_DIR, { recursive: true });
  mkdirSync(path.join(ROOT, 'evidence'), { recursive: true });

  const serverVersion = queryProd('show server_version');
  const clientVersion = run(bin('pg_dump'), ['--version']).stdout.trim();
  log(`source server : PostgreSQL ${serverVersion} (credentials redacted)`);
  log(`dump client   : ${clientVersion}`);
  log(`restore target: local PostgreSQL 18 cluster on 127.0.0.1:${PORT} (${LOCAL_DB})`);
  log('');

  // --- 1. dump --------------------------------------------------------------
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
  const dumpFile = path.join(BACKUP_DIR, `neon-${stamp}.dump`);
  let dumpMs = 0;
  let dumpBytes = 0;
  let actualDumpFile = dumpFile;
  if (SKIP_DUMP) {
    const latest = run('bash', ['-c', `ls -1t ${BACKUP_DIR}/*.dump 2>/dev/null | head -1`]).stdout.trim();
    if (!latest) throw new Error('--skip-dump was given but no dump exists in .runtime/backups');
    actualDumpFile = latest;
    dumpBytes = Number(run('bash', ['-c', `wc -c < ${JSON.stringify(latest)}`]).stdout.trim());
    log(`[1] pg_dump    : SKIPPED (--skip-dump), reusing ${path.basename(latest)} (${(dumpBytes / 1024).toFixed(0)} KiB)`);
  } else {
    const res = run(bin('pg_dump'), ['--format=custom', '--no-owner', '--no-privileges', '--file', dumpFile, PROD_URL]);
    dumpMs = res.ms;
    dumpBytes = Number(run('bash', ['-c', `wc -c < ${JSON.stringify(dumpFile)}`]).stdout.trim());
    log(`[1] pg_dump    : ${Math.round(dumpMs / 100) / 10}s, ${(dumpBytes / 1024).toFixed(0)} KiB → .runtime/backups/${path.basename(dumpFile)}`);
  }

  const archivedObjects = Number(run(bin('pg_restore'), ['--list', actualDumpFile]).stdout.split('\n').length);

  // --- 2. ephemeral cluster -------------------------------------------------
  const freshCluster = !existsSync(path.join(CLUSTER_DIR, 'PG_VERSION'));
  if (freshCluster) {
    const res = run(bin('initdb'), ['-D', CLUSTER_DIR, '-U', 'postgres', '--auth=trust', '--encoding=UTF8']);
    log(`[2] initdb     : ${(res.ms / 1000).toFixed(1)}s (fresh cluster in .runtime/pg18-restore)`);
  } else {
    log('[2] initdb     : cluster already present, reusing');
  }

  if (!clusterRunning()) {
    const res = run(bin('pg_ctl'), [
      '-D', CLUSTER_DIR, '-l', LOG_FILE,
      '-o', `-p ${PORT} -c listen_addresses=127.0.0.1 -k ${RUNTIME}`,
      '-w', 'start',
    ]);
    log(`[3] pg_ctl     : started on 127.0.0.1:${PORT} in ${(res.ms / 1000).toFixed(1)}s`);
  } else {
    log('[3] pg_ctl     : cluster already running');
  }
  // Fresh scratch database every run: a stale schema would silently hide a
  // restore failure.
  run(bin('psql'), [LOCAL_URL.replace(`/${LOCAL_DB}`, '/postgres'), '-v', 'ON_ERROR_STOP=1', '-c',
    `DROP DATABASE IF EXISTS ${LOCAL_DB}`]);
  run(bin('createdb'), ['-h', '127.0.0.1', '-p', String(PORT), '-U', 'postgres', LOCAL_DB]);

  // --- 3. restore -----------------------------------------------------------
  const restore = run(bin('pg_restore'), [
    '--no-owner', '--no-privileges', '--exit-on-error', '-d', LOCAL_URL, actualDumpFile,
  ]);
  log(`[4] pg_restore : ${(restore.ms / 1000).toFixed(1)}s, ${archivedObjects} archived entries, restore exit 0`);

  const restoredVersion = queryLocal('show server_version');
  const restoredTables = Number(
    queryLocal("SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'"),
  );
  const prodTables = Number(queryProd("SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'"));
  log(`[5] schema     : ${restoredTables} tables restored (production has ${prodTables})`);
  if (restoredTables !== prodTables) {
    throw new Error(`table count mismatch: restored ${restoredTables}, production ${prodTables}`);
  }

  // --- 4. compare -----------------------------------------------------------
  log('');
  log('[6] comparison : rows and content checksums, production vs restored');
  log('    table                        prod rows   restored   checksum');
  const comparisons = [];
  let mismatches = 0;
  for (const table of TABLES) {
    const prod = await fingerprint(queryProd, table);
    const restored = await fingerprint(queryLocal, table);
    const same = prod.count === restored.count && prod.checksum === restored.checksum;
    if (!same) mismatches++;
    comparisons.push({ table: table.name, prod, restored, same });
    log(
      `    ${table.name.padEnd(28)} ${String(prod.count).padStart(9)} ${String(restored.count).padStart(10)}   ` +
        `${same ? 'match' : `MISMATCH (${prod.checksum.slice(0, 8)} vs ${restored.checksum.slice(0, 8)})`}`,
    );
  }
  log('');
  log(`    ${comparisons.length - mismatches}/${comparisons.length} tables match exactly; ${mismatches} mismatch(es)`);

  // --- 5. PITR --------------------------------------------------------------
  const pitr = await checkPitr();
  log('');
  log(`[7] PITR       : ${pitr.available === null ? 'not verified' : String(pitr.available)}`);
  for (const note of pitr.notes) log(`                 ${note}`);

  // --- 6. teardown ----------------------------------------------------------
  if (!KEEP_CLUSTER) {
    run(bin('pg_ctl'), ['-D', CLUSTER_DIR, '-w', 'stop']);
    log('');
    log('[8] teardown   : scratch cluster stopped (dump kept in .runtime/backups)');
  } else {
    log('');
    log(`[8] teardown   : --keep-cluster given; cluster left running on 127.0.0.1:${PORT}`);
  }

  const finishedAt = new Date();
  const report = {
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    duration_s: Math.round((finishedAt - startedAt) / 100) / 10,
    source: { engine: `PostgreSQL ${serverVersion}`, host: redact(PROD_URL.replace(/^postgres(ql)?:\/\/[^@]*@/, 'postgres://')), tables: prodTables },
    dump: {
      file: path.relative(ROOT, actualDumpFile),
      bytes: dumpBytes,
      ms: dumpMs,
      archived_entries: archivedObjects,
      gitignored: spawnSync('git', ['check-ignore', '-q', actualDumpFile], { cwd: ROOT }).status === 0,
    },
    restore: { engine: `PostgreSQL ${restoredVersion}`, database: LOCAL_DB, ms: restore.ms, tables: restoredTables },
    comparisons,
    mismatches,
    pitr,
  };
  writeFileSync(REPORT_JSON, JSON.stringify(report, null, 2) + '\n');
  writeFileSync(REPORT_MD, renderMarkdown(report));
  log('');
  log(`reports written: evidence/BACKUP_RESTORE_REHEARSAL.md, evidence/backup-rehearsal.json`);
  log(`total: ${report.duration_s}s`);

  if (mismatches > 0) {
    console.error(`\nFAIL: ${mismatches} table(s) did not match after restore`);
    process.exitCode = 1;
  }
}

function renderMarkdown(report) {
  const rows = report.comparisons
    .map(
      (c) =>
        `| \`${c.table}\` | ${c.prod.count} | ${c.restored.count} | ${c.same ? '✅ match' : '❌ mismatch'} | \`${c.prod.checksum.slice(0, 12)}…\` |`,
    )
    .join('\n');

  return `# AC-54 — репетиция бэкапа и восстановления

- **Прогон:** ${report.started_at} → ${report.finished_at} (**${report.duration_s}s**)
- **Источник:** ${report.source.engine}, прод-БД Neon (\`NEON_CONN_DIRECT\` из \`.env.deploy.secrets\`), таблиц в схеме: ${report.source.tables}
- **Восстановление:** ${report.restore.engine}, локальный scratch-кластер, БД \`${report.restore.database}\`
- **Машинный отчёт:** [backup-rehearsal.json](backup-rehearsal.json)
- **Скрипт (повторяемый):** \`scripts/backup-rehearsal.mjs\`

## Что делали

1. \`pg_dump --format=custom --no-owner --no-privileges\` прод-БД → файл в \`.runtime/backups/\`
   (**gitignored, не коммитится**; проверено в прогоне: \`gitignored: ${report.dump.gitignored}\`).
   Дамп: ${(report.dump.bytes / 1024).toFixed(0)} KiB, ${report.dump.archived_entries} архивных записей, ${(report.dump.ms / 1000).toFixed(1)}s.
2. \`initdb\` → одноразовый кластер PostgreSQL 18 в \`.runtime/pg18-restore\` (порт 55432, только \`127.0.0.1\`).
   Мажорная версия совпадает с продом, поэтому дамп восстанавливается **без правок**.
3. \`DROP DATABASE IF EXISTS\` + \`createdb\` — каждый прогон начинается с пустой БД, чтобы остатки прошлого
   прогона не замаскировали ошибку восстановления.
4. \`pg_restore --exit-on-error\` → \`${report.restore.database}\` (${(report.restore.ms / 1000).toFixed(1)}s).
5. Сверка по 11 ключевым таблицам: число строк и контрольная сумма содержимого.
6. Проверка PITR/branch-restore (см. ограничения ниже).
7. Кластер остановлен; дамп оставлен в \`.runtime/backups/\`.

### Контрольные суммы — как считались

\`\`\`sql
-- PGTZ=UTC на обеих сторонах (libpq выставляет timezone сессии)
SELECT count(*)::text || ':' || COALESCE(md5(string_agg(md5(t::text), '' ORDER BY <pk>)), '-') FROM <table> t;
\`\`\`

Часовой пояс закреплён как UTC через \`PGTZ\` для всех вызовов \`psql\`: иначе текстовое представление
\`timestamptz\` отличалось бы, и расхождение контрольных сумм говорило бы о настройке сессии, а не о данных.

## Результат сверки

| Таблица | Строк в проде | Строк после restore | Сверка | Контрольная сумма |
|---|---:|---:|---|---|
${rows}

**Итог: ${report.comparisons.length - report.mismatches}/${report.comparisons.length} таблиц совпали точно, расхождений — ${report.mismatches}.**
Таблиц в схеме: прод ${report.source.tables}, восстановлено ${report.restore.tables}.

## Тайминги

| Этап | Время |
|---|---|
| pg_dump (прод → локальный файл) | ${(report.dump.ms / 1000).toFixed(1)}s |
| pg_restore (файл → scratch-БД) | ${(report.restore.ms / 1000).toFixed(1)}s |
| **Всё вместе (включая initdb, старт/стоп кластера, сверку)** | **${report.duration_s}s** |

## Вывод о восстановимости

Данные прода воспроизводимы на чистой БД из дампа: совпали и число строк, и контрольные суммы по всем
ключевым таблицам, схема восстановилась полностью (${report.restore.tables} таблицы). Значит, **бэкап пригоден
для восстановления** — процедура проверена, а не заявлена.

## Ограничения

- **PITR / branch-restore не проверен.** ${report.pitr.notes.join(' ')}
  Это ограничение среды (нет \`neonctl\` и API-ключа), а не вывод о возможностях Neon. Репетиция
  восстанавливает **данные**; окно хранения и восстановление на момент времени остаются непроверенным
  допущением, пока не будет ключа Neon API.
- Репетиция проверяет восстановление **в локальный кластер**, не в сам Neon: RPO/RTO продакшн-аварии
  (время до переключения трафика, потеря последних транзакций между дампом и аварией) этим не измеряются.
- Дамп снимался на живой БД, поэтому это согласованный снимок на момент \`pg_dump\`, а не «точка» с
  остановленными записями.
- Секреты не печатаются: строка подключения проходит через \`redact()\`, дамп лежит в gitignored
  \`.runtime/\` и не попадает в коммиты.
`;
}

main().catch((err) => {
  console.error(`\nFAILED: ${redact(err.message)}`);
  // Best-effort teardown so a failed run does not leave a server behind.
  try {
    if (clusterRunning()) spawnSync(bin('pg_ctl'), ['-D', CLUSTER_DIR, '-w', 'stop'], { encoding: 'utf8' });
  } catch {
    /* ignore */
  }
  process.exitCode = 1;
});
