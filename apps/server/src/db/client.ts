import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from './schema.ts';

export function createDb(databaseUrl: string) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  // casing: snake_case — поля в коде camelCase, колонки в БД snake_case.
  const db = drizzle(pool, { schema, casing: 'snake_case' });
  return { db, pool };
}

export type Db = ReturnType<typeof createDb>['db'];
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Соединение или открытая транзакция */
export type Executor = Db | Tx;

export async function runMigrations(db: Db) {
  // fileURLToPath, а не .pathname: на Windows .pathname даёт «/C:/…», и папка не находится.
  const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));
  await migrate(db, { migrationsFolder });
}
