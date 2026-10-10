import { createDb, runMigrations } from '../db/client.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL не задан');
const { db, pool } = createDb(url);
await runMigrations(db);
await pool.end();
console.log('Миграции применены.');
