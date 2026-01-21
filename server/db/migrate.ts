import fs from 'fs';
import path from 'path';
import { getPostgresPool } from './postgres';

type Migration = { name: string; sql: string };

const MIGRATIONS_DIR = path.resolve(__dirname, 'migrations');

const listMigrations = (): Migration[] => {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    throw new Error(`[migrate] migrations directory not found: ${MIGRATIONS_DIR}`);
  }

  const entries = fs.readdirSync(MIGRATIONS_DIR, { withFileTypes: true });
  const migrations = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.sql'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const fullPath = path.join(MIGRATIONS_DIR, name);
      const sql = fs.readFileSync(fullPath, 'utf8');
      return { name, sql };
    });

  return migrations;
};

const ensureMigrationsTable = async (): Promise<void> => {
  const pool = getPostgresPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
};

const fetchAppliedMigrations = async (): Promise<Set<string>> => {
  const pool = getPostgresPool();
  const result = await pool.query<{ name: string }>('SELECT name FROM public.schema_migrations ORDER BY name ASC');
  return new Set((result.rows ?? []).map((row) => row.name));
};

const applyMigration = async (migration: Migration): Promise<void> => {
  const pool = getPostgresPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(migration.sql);
    await client.query('INSERT INTO public.schema_migrations (name) VALUES ($1)', [migration.name]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
};

const main = async (): Promise<void> => {
  await ensureMigrationsTable();

  const migrations = listMigrations();
  if (!migrations.length) {
    console.log('[migrate] No migrations found.');
    return;
  }

  const applied = await fetchAppliedMigrations();
  const pending = migrations.filter((migration) => !applied.has(migration.name));

  if (!pending.length) {
    console.log('[migrate] No pending migrations.');
    return;
  }

  console.log(`[migrate] Applying ${pending.length} migration(s)...`);
  for (const migration of pending) {
    console.log(`[migrate] Applying ${migration.name}...`);
    await applyMigration(migration);
  }

  console.log('[migrate] Done.');
};

main()
  .catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[migrate] Failed:', message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      const pool = getPostgresPool();
      await pool.end();
    } catch {
      // ignore
    }
  });
