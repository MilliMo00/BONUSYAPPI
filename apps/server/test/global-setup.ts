import pg from 'pg';
import { createDb, runMigrations } from '../src/db/client.ts';
import { TEST_DATABASE_URL } from './helpers.ts';

/** Пересоздаёт схему тестовой базы и применяет миграции — заодно проверяется, что они работают с нуля. */
export default async function setup() {
  if (!/test/.test(new URL(TEST_DATABASE_URL).pathname)) {
    throw new Error('TEST_DATABASE_URL должен указывать на базу с "test" в имени — тесты стирают все данные');
  }
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  await client.query(
    'DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;',
  );
  await client.end();
  const { db, pool } = createDb(TEST_DATABASE_URL);
  await runMigrations(db);
  await pool.end();
}
