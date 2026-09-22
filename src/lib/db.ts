import postgres from 'postgres';
import { statementTimeoutMs } from './env';

type GlobalWithSql = typeof globalThis & {
  __welcomeSql?: postgres.Sql;
};

/**
 * The options the shared pool is built with. Exported so the wiring is
 * ASSERTABLE without a database: a unit test can check that the configured
 * statement budget actually reaches the option postgres.js sends to the server,
 * which is otherwise only observable by opening a connection
 * (tests/unit/db-options.test.ts).
 *
 * `statement_timeout` travels as a `connection` parameter, i.e. a server GUC set
 * in the startup packet (postgres.js writes `connection` entries verbatim into
 * it — node_modules/postgres/src/connection.js StartupMessage). That is the
 * point: the bound is enforced BY POSTGRES, so it also covers the case the
 * client cannot see — a statement parked on a lock — and it survives the
 * connection being handed to a different query. A client-side deadline would
 * only abandon the caller and leave the server still working.
 *
 * Read once, at pool construction. Changing STATEMENT_TIMEOUT_MS on a running
 * process does not re-open existing connections — same as DATABASE_URL.
 */
export function sqlClientOptions(): postgres.Options<Record<string, never>> {
  return {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 5,
    connection: { statement_timeout: statementTimeoutMs() },
    onnotice: () => {},
  };
}

/** Lazy singleton postgres.js client. No ORM. */
export function getSql(): postgres.Sql {
  const g = globalThis as GlobalWithSql;
  if (!g.__welcomeSql) {
    const url = process.env.DATABASE_URL || 'postgres://localhost:5432/welcome_dev';
    g.__welcomeSql = postgres(url, sqlClientOptions());
  }
  return g.__welcomeSql;
}

/** Closes the shared pool (used by tests and scripts). */
export async function closeSql(): Promise<void> {
  const g = globalThis as GlobalWithSql;
  if (g.__welcomeSql) {
    await g.__welcomeSql.end({ timeout: 5 });
    delete g.__welcomeSql;
  }
}
