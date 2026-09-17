import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Pool, types } from 'pg';
types.setTypeParser(types.builtins.DATE, (value) => value);
export async function withTimeEntryDatabase(
  run: (pool: Pool) => Promise<void>,
): Promise<void> {
  const name = `timecard-admin-entry-test-${randomUUID()}`;
  const docker = (...args: string[]) =>
    execFileSync('docker', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120000,
    }).trim();
  let pool: Pool | undefined,
    started = false;
  try {
    docker(
      'run',
      '--detach',
      '--rm',
      '--name',
      name,
      '--env',
      'POSTGRES_PASSWORD=local_time_entry_test',
      '--env',
      'POSTGRES_DB=time_entry_test',
      '--publish',
      '127.0.0.1::5432',
      'postgres:17-alpine',
    );
    started = true;
    const portText = docker('port', name, '5432/tcp');
    const port = Number(portText.slice(portText.lastIndexOf(':') + 1));
    if (!Number.isInteger(port) || port < 1)
      throw new Error('Invalid disposable test port');
    pool = new Pool({
      host: '127.0.0.1',
      port,
      database: 'time_entry_test',
      user: 'postgres',
      password: 'local_time_entry_test',
      max: 8,
    });
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try {
        await pool.query('SELECT 1');
        ready = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    if (!ready) throw new Error('Disposable PostgreSQL did not start');
    for (const file of [
      '0001_time_entry_and_weekly_attestations.sql',
      '0002_clock_in_out.sql',
      '0005_time_entry_breaks.sql',
      '0015_admin_time_entry_operations.sql',
    ])
      await pool.query(
        readFileSync(
          path.resolve(__dirname, '../../db/migrations', file),
          'utf8',
        ),
      );
    await run(pool);
  } finally {
    await pool?.end();
    if (started) docker('stop', name);
  }
}
