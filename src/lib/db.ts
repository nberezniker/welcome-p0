import postgres from 'postgres';

type GlobalWithSql = typeof globalThis & {
  __welcomeSql?: postgres.Sql;
};

/** Lazy singleton postgres.js client. No ORM. */
export function getSql(): postgres.Sql {
  const g = globalThis as GlobalWithSql;
  if (!g.__welcomeSql) {
    const url = process.env.DATABASE_URL || 'postgres://localhost:5432/welcome_dev';
    g.__welcomeSql = postgres(url, {
      max: 10,
      idle_timeout: 20,
      connect_timeout: 5,
      onnotice: () => {},
    });
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
