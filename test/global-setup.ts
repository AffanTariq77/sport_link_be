import pg from 'pg';
import { runMigrations } from '../src/db/migrate.js';

// Rebuilds the test database from migrations before the suite. Never point this at a real database.
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is not set');
  if (!/_test\b/.test(new URL(url).pathname)) throw new Error('TEST_DATABASE_URL must point to a *_test database');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query(
    'DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;',
  );
  await client.end();
  await runMigrations(url);
}
