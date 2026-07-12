import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { getEnv } from '../config/env.js';

const { Client } = pg;

async function migrate(): Promise<void> {
  const env = getEnv();
  const client = new Client({ connectionString: env.DATABASE_URL });
  await client.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    const migrationsDir = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      'migrations',
    );
    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const id = file;
      const { rows } = await client.query(
        'SELECT 1 FROM schema_migrations WHERE id = $1',
        [id],
      );
      if (rows.length > 0) {
        console.log(`skip ${id}`);
        continue;
      }
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      console.log(`apply ${id}...`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [id]);
        await client.query('COMMIT');
        console.log(`applied ${id}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
    console.log('Migrations complete.');
  } finally {
    await client.end();
  }
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
