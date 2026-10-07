import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Pool, PoolClient, types } from 'pg';

types.setTypeParser(types.builtins.DATE, (value) => value);

export const timeOffChangesDatabaseEnabled = process.env.RUN_PTO_POSTGRES_TESTS === '1';

// The shared Neon time-off tables predate this repository's migrations. These
// definitions mirror the columns the application reads and writes.
const PREREQUISITE_TABLES = `
  CREATE TABLE public.time_off_requests (
    id BIGSERIAL PRIMARY KEY, franchiseid INTEGER NOT NULL, tutorid BIGINT, bridge_flag BOOLEAN,
    bridge_profile_id BIGINT, first_name TEXT, last_name TEXT, email TEXT,
    start_at TIMESTAMPTZ NOT NULL, end_at TIMESTAMPTZ NOT NULL, type TEXT NOT NULL,
    absence_label TEXT, notes TEXT, status TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by BIGINT, decided_at TIMESTAMPTZ, decided_by BIGINT, decision_reason TEXT,
    google_calendar_event_id TEXT, duration_hours NUMERIC, partial_day BOOLEAN, leave_time TIME,
    return_time TIME, public_metadata JSONB, decision_token_hash TEXT,
    decision_token_expires_at TIMESTAMPTZ, decision_token_used_at TIMESTAMPTZ
  );
  CREATE TABLE public.time_off_audit (
    id BIGSERIAL PRIMARY KEY, request_id BIGINT NOT NULL, action TEXT NOT NULL,
    actor_account_type TEXT NOT NULL, actor_account_id BIGINT, at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    previous_status TEXT, new_status TEXT NOT NULL, metadata JSONB NOT NULL DEFAULT '{}'::JSONB
  );
`;

// 0001–0009 and 0015 create time-entry/payroll tables unrelated to time off;
// the time-off chain is the PTO foundation followed by this feature.
export const TIME_OFF_MIGRATION_CHAIN = [
  '0010_shared_pto.sql',
  '0011_pto_admin_invariants.sql',
  '0012_pto_routes.sql',
  '0013_persistent_pto_profile_links.sql',
  '0014_database_controlled_pto_linked_login.sql',
  '0016_approved_time_off_changes.sql'
];

export const readMigration = (name: string): string =>
  readFileSync(path.resolve(__dirname, '../../db/migrations', name), 'utf8');

export interface TimeOffChangesDatabase {
  pool: Pool;
  stop: () => Promise<void>;
}

export async function startTimeOffChangesDatabase(
  options: { migrations?: string[] } = {}
): Promise<TimeOffChangesDatabase> {
  const name = `timecard-timeoff-change-test-${randomUUID()}`;
  const docker = (...args: string[]) => execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000
  }).trim();
  docker('run', '--detach', '--rm', '--name', name, '--env', 'POSTGRES_PASSWORD=local_timeoff_change_test',
    '--env', 'POSTGRES_DB=timeoff_change_test', '--publish', '127.0.0.1::5432', 'postgres:17-alpine');
  let pool: Pool | undefined;
  try {
    const portText = docker('port', name, '5432/tcp');
    const port = Number(portText.slice(portText.lastIndexOf(':') + 1));
    if (!Number.isInteger(port) || port < 1) throw new Error('Invalid disposable test port');
    pool = new Pool({
      host: '127.0.0.1', port, database: 'timeoff_change_test', user: 'postgres',
      password: 'local_timeoff_change_test', max: 10
    });
    let ready = false;
    for (let attempt = 0; attempt < 60 && !ready; attempt += 1) {
      try {
        await pool.query('SELECT 1');
        ready = true;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    if (!ready) throw new Error('Disposable PostgreSQL did not start');
    await resetTimeOffChangesSchema(pool, options.migrations);
  } catch (error) {
    await pool?.end().catch(() => undefined);
    try { docker('rm', '--force', name); } catch { /* disposable */ }
    throw error;
  }
  const ready = pool;
  return {
    pool: ready,
    stop: async () => {
      await ready.end();
      try { docker('rm', '--force', name); } catch { /* disposable */ }
    }
  };
}

/** Recreates the public schema and applies the prerequisite tables and migrations. */
export async function resetTimeOffChangesSchema(pool: Pool, migrations = TIME_OFF_MIGRATION_CHAIN): Promise<void> {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await pool.query(PREREQUISITE_TABLES);
  for (const migration of migrations) {
    await pool.query(readMigration(migration));
  }
}

/** Waits until a backend is blocked on a heavyweight lock and reports which kind. */
export async function waitForLockWait(pool: Pool, pid: number): Promise<string> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const result = await pool.query<{ wait_event_type: string | null; wait_event: string | null }>(
      'SELECT wait_event_type, wait_event FROM pg_stat_activity WHERE pid = $1',
      [pid]
    );
    if (result.rows[0]?.wait_event_type === 'Lock') return String(result.rows[0].wait_event);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`PostgreSQL backend ${pid} did not reach a lock wait`);
}

export async function withClient<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await work(client);
  } finally {
    client.release();
  }
}

export async function inTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  return withClient(pool, async (client) => {
    await client.query('BEGIN');
    try {
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  });
}

export interface SeedRequestInput {
  franchiseId?: number;
  tutorId?: number | null;
  type?: string;
  absenceLabel?: string;
  status?: string;
  startAt?: string;
  endAt?: string;
  startDate?: string;
  endDate?: string;
  partialDay?: boolean;
  durationHours?: number;
  notes?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  source?: 'authenticated_timecard_app' | 'public_timeoff_form';
  version?: string;
  googleCalendarEventId?: string | null;
}

export async function seedTimeOffRequest(db: Pool | PoolClient, input: SeedRequestInput = {}): Promise<number> {
  const startDate = input.startDate ?? '2026-11-16';
  const endDate = input.endDate ?? startDate;
  const result = await db.query<{ id: string }>(`
    INSERT INTO public.time_off_requests
      (franchiseid, tutorid, bridge_flag, first_name, last_name, email, start_at, end_at, type, absence_label,
       notes, status, created_by, duration_hours, partial_day, public_metadata, google_calendar_event_id
       ${input.version ? ', version' : ''})
    VALUES ($1, $2, FALSE, $3, $4, $5, $6, $7, $8, $9, $10, $11, $2, $12, $13,
      JSONB_BUILD_OBJECT('source', $14::TEXT, 'startDate', $15::TEXT, 'endDate', $16::TEXT), $17
      ${input.version ? ', $18::BIGINT' : ''})
    RETURNING id
  `, [
    input.franchiseId ?? 44,
    input.tutorId === undefined ? 4401 : input.tutorId,
    input.firstName ?? 'Ada',
    input.lastName ?? 'Lovelace',
    input.email ?? 'ada@example.com',
    input.startAt ?? `${startDate}T08:00:00.000Z`,
    input.endAt ?? new Date(Date.parse(`${endDate}T08:00:00.000Z`) + 86_400_000).toISOString(),
    input.type ?? 'sick',
    input.absenceLabel ?? 'Sick Leave',
    input.notes ?? 'Original request reason text',
    input.status ?? 'approved',
    input.durationHours ?? 24,
    input.partialDay ?? false,
    input.source ?? 'authenticated_timecard_app',
    startDate,
    endDate,
    input.googleCalendarEventId ?? null,
    ...(input.version ? [input.version] : [])
  ]);
  return Number(result.rows[0].id);
}
