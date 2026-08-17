import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { Pool } from 'pg';

const enabled = process.env.RUN_PTO_POSTGRES_TESTS === '1';
const containerName = `timecard-pto-test-${process.pid}`;
const migrationSql = readFileSync(
  path.resolve(__dirname, '../db/migrations/0010_shared_pto.sql'),
  'utf8'
);
let pool: Pool | undefined;

const docker = (args: string[], timeout = 120_000): string =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout
  }).trim();

const waitForPostgres = async (candidate: Pool): Promise<void> => {
  let lastError: unknown;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await candidate.query('SELECT 1');
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError;
};

const waitForBackendLock = async (candidate: Pool, pid: number): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await candidate.query<{ wait_event_type: string | null }>(
      'SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1',
      [pid]
    );
    if (result.rows[0]?.wait_event_type === 'Lock') return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`PostgreSQL backend ${pid} did not reach a lock wait`);
};

const resetDatabase = async (candidate: Pool): Promise<void> => {
  await candidate.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await candidate.query(`
    CREATE TABLE public.time_off_requests (
      id BIGSERIAL PRIMARY KEY,
      franchiseid INTEGER NOT NULL,
      tutorid BIGINT,
      bridge_flag BOOLEAN,
      bridge_profile_id BIGINT,
      first_name TEXT,
      last_name TEXT,
      email TEXT,
      start_at TIMESTAMPTZ NOT NULL,
      end_at TIMESTAMPTZ NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      duration_hours NUMERIC,
      partial_day BOOLEAN,
      leave_time TIME,
      return_time TIME,
      public_metadata JSONB
    )
  `);
};

before(async () => {
  if (!enabled) return;
  docker([
    'run',
    '--detach',
    '--rm',
    '--name',
    containerName,
    '--env',
    'POSTGRES_PASSWORD=pto_test_password',
    '--env',
    'POSTGRES_DB=pto_test',
    '--publish',
    '127.0.0.1::5432',
    'postgres:17-alpine'
  ]);
  const portOutput = docker(['port', containerName, '5432/tcp']);
  const port = Number(portOutput.slice(portOutput.lastIndexOf(':') + 1));
  assert.ok(Number.isInteger(port) && port > 0, `Unexpected Docker port output: ${portOutput}`);

  pool = new Pool({
    host: '127.0.0.1',
    port,
    database: 'pto_test',
    user: 'postgres',
    password: 'pto_test_password',
    max: 8
  });
  await waitForPostgres(pool);
});

beforeEach(async () => {
  if (!enabled || !pool) return;
  await resetDatabase(pool);
});

after(async () => {
  if (!enabled) return;
  await pool?.end();
  try {
    docker(['rm', '--force', containerName], 30_000);
  } catch {
    // The container is disposable and may already have stopped.
  }
});

test('migration applies and reruns cleanly in disposable PostgreSQL', { skip: !enabled }, async () => {
  assert.ok(pool);
  await pool.query(migrationSql);
  await pool.query(migrationSql);
});

test('identity resolution shares only confirmed people and scopes public email matching by center', { skip: !enabled }, async () => {
  const db = pool;
  assert.ok(db);
  await db.query(migrationSql);
  const resolveProfile = async (args: [number, number | null, number | null, string, string, string, string]) => {
    const result = await db.query<{ id: string }>(
      'SELECT public.pto_resolve_profile($1, $2, $3, $4, $5, $6, $7) AS id',
      args
    );
    return Number(result.rows[0].id);
  };

  const confirmed = await resolveProfile([1, 101, 500, 'shared@example.com', 'authenticated', 'Alice', 'Ng']);
  const sameConfirmed = await resolveProfile([2, 202, 500, 'alice.two@example.com', 'authenticated', 'Alice', 'Ng']);
  assert.equal(sameConfirmed, confirmed);

  const pendingExactName = await resolveProfile([3, 303, null, 'shared@example.com', 'authenticated', 'Alice', 'Ng']);
  assert.notEqual(pendingExactName, confirmed);
  const pendingStatus = await db.query<{ identity_status: string }>(
    'SELECT identity_status FROM public.pto_profiles WHERE id = $1',
    [pendingExactName]
  );
  assert.equal(pendingStatus.rows[0].identity_status, 'pending');
  const candidate = await db.query<{ status: string }>(
    `SELECT status FROM public.pto_profile_match_candidates
     WHERE left_profile_id = LEAST($1::BIGINT, $2::BIGINT)
       AND right_profile_id = GREATEST($1::BIGINT, $2::BIGINT)`,
    [confirmed, pendingExactName]
  );
  assert.equal(candidate.rows[0].status, 'pending');

  const separateCenterPerson = await resolveProfile([2, 203, null, 'shared@example.com', 'authenticated', 'Bob', 'Ng']);
  assert.notEqual(separateCenterPerson, confirmed);
  const publicCenterOne = await resolveProfile([1, null, null, ' SHARED@example.com ', 'public', 'Alice', 'Ng']);
  const publicCenterTwo = await resolveProfile([2, null, null, 'shared@example.com', 'public', 'Bob', 'Ng']);
  assert.equal(publicCenterOne, confirmed);
  assert.equal(publicCenterTwo, separateCenterPerson);

  await assert.rejects(
    resolveProfile([4, null, null, 'shared@example.com', 'public', 'Alice', 'Ng']),
    /exactly one active profile/
  );
});

test('a later confirmed exact-name profile leaves the earlier profile as a pending match', { skip: !enabled }, async () => {
  assert.ok(pool);
  await pool.query(migrationSql);
  const pending = await pool.query<{ id: string }>(`
    SELECT public.pto_resolve_profile(
      30, 3001, NULL, 'reverse.pending@example.com', 'authenticated', 'Reverse', 'Exact'
    ) AS id
  `);
  const confirmed = await pool.query<{ id: string }>(`
    SELECT public.pto_resolve_profile(
      31, 3101, 9310, 'reverse.confirmed@example.com', 'authenticated', 'Reverse', 'Exact'
    ) AS id
  `);
  assert.notEqual(pending.rows[0].id, confirmed.rows[0].id);
  const match = await pool.query<{ status: string }>(`
    SELECT status FROM public.pto_profile_match_candidates
    WHERE left_profile_id = LEAST($1::BIGINT, $2::BIGINT)
      AND right_profile_id = GREATEST($1::BIGINT, $2::BIGINT)
  `, [pending.rows[0].id, confirmed.rows[0].id]);
  assert.equal(match.rows[0].status, 'pending');
});

test('concurrent duplicate reservation keeps allocation and ledger amounts idempotent', { skip: !enabled }, async () => {
  assert.ok(pool);
  await pool.query(migrationSql);
  await pool.query(`
    INSERT INTO public.pto_center_settings (franchiseid, enabled)
    VALUES (10, TRUE)
  `);
  const request = await pool.query<{ id: string; created_at: Date }>(`
    INSERT INTO public.time_off_requests (
      franchiseid, tutorid, bridge_flag, bridge_profile_id, first_name, last_name, email,
      start_at, end_at, type, status, duration_hours, partial_day, public_metadata
    )
    VALUES (
      10, 1001, TRUE, 9001, 'Concurrent', 'Tutor', 'concurrent@example.com',
      '2026-08-17T00:00:00Z', '2026-08-18T00:00:00Z', 'pto', 'draft', 24, FALSE,
      '{"startDate":"2026-08-17","endDate":"2026-08-17","source":"authenticated_timecard_app"}'::JSONB
    )
    RETURNING id, created_at
  `);
  const requestId = Number(request.rows[0].id);
  const reserveSql = `
    SELECT public.pto_reserve_request(
      $1, 10, 1001, 9001, 'concurrent@example.com', 'authenticated',
      'Concurrent', 'Tutor', $2, DATE '2026-08-17', DATE '2026-08-17', FALSE, 24
    )
  `;
  const first = await pool.connect();
  const second = await pool.connect();
  try {
    await first.query('BEGIN');
    await second.query('BEGIN');
    await first.query(reserveSql, [requestId, request.rows[0].created_at]);
    const secondPid = Number((await second.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    const secondReservation = second.query(reserveSql, [requestId, request.rows[0].created_at]);
    await waitForBackendLock(pool, secondPid);
    await first.query('COMMIT');
    await secondReservation;
    await second.query('COMMIT');
  } finally {
    await first.query('ROLLBACK').catch(() => undefined);
    await second.query('ROLLBACK').catch(() => undefined);
    first.release();
    second.release();
  }

  const allocation = await pool.query<{ charged_days: string }>(
    'SELECT charged_days FROM public.pto_request_allocations WHERE request_id = $1',
    [requestId]
  );
  const reservation = await pool.query<{ reserved_days: string }>(
    `SELECT COALESCE(SUM(reserved_delta), 0) AS reserved_days
     FROM public.pto_ledger_entries WHERE request_id = $1 AND event_type = 'reserve'`,
    [requestId]
  );
  assert.equal(Number(allocation.rows[0].charged_days), 1);
  assert.equal(Number(reservation.rows[0].reserved_days), 1);
});

test('policy versions begin on renewal boundaries and produce deterministic cycles', { skip: !enabled }, async () => {
  assert.ok(pool);
  await pool.query(migrationSql);
  await assert.rejects(
    pool.query(`
      INSERT INTO public.pto_policies (effective_from, entitlement_days)
      VALUES (MAKE_DATE(EXTRACT(YEAR FROM CURRENT_DATE)::INTEGER + 1, 7, 1), 9)
    `),
    /renewal boundary/
  );

  const policy = await pool.query<{ effective_from: string }>(`
    INSERT INTO public.pto_policies (effective_from, entitlement_days)
    VALUES (MAKE_DATE(EXTRACT(YEAR FROM CURRENT_DATE)::INTEGER + 1, 1, 1), 6)
    RETURNING effective_from::TEXT
  `);
  const profile = await pool.query<{ id: string }>(`
    INSERT INTO public.pto_profiles (first_name, last_name, identity_status)
    VALUES ('Policy', 'Tutor', 'confirmed')
    RETURNING id
  `);
  const profileId = Number(profile.rows[0].id);
  const priorCycle = await pool.query<{ cycle_id: string }>(
    'SELECT public.pto_get_or_create_cycle($1, $2::DATE - 1) AS cycle_id',
    [profileId, policy.rows[0].effective_from]
  );
  const nextCycle = await pool.query<{ cycle_id: string }>(
    'SELECT public.pto_get_or_create_cycle($1, $2::DATE + 31) AS cycle_id',
    [profileId, policy.rows[0].effective_from]
  );
  const cycles = await pool.query<{ starts_on: string; entitlement_days: string }>(`
    SELECT cycle.starts_on::TEXT, cycle.entitlement_days::TEXT
    FROM public.pto_entitlement_cycles AS cycle
    WHERE cycle.id IN ($1, $2)
    ORDER BY cycle.starts_on
  `, [priorCycle.rows[0].cycle_id, nextCycle.rows[0].cycle_id]);
  assert.deepEqual(cycles.rows, [
    { starts_on: `${Number(policy.rows[0].effective_from.slice(0, 4)) - 1}-01-01`, entitlement_days: '5.00' },
    { starts_on: policy.rows[0].effective_from, entitlement_days: '6.00' }
  ]);
});

test('policy creation cannot reinterpret an already materialized entitlement cycle', { skip: !enabled }, async () => {
  assert.ok(pool);
  await pool.query(migrationSql);
  const profile = await pool.query<{ id: string }>(`
    INSERT INTO public.pto_profiles (first_name, last_name, identity_status)
    VALUES ('Materialized', 'Tutor', 'confirmed')
    RETURNING id
  `);
  await pool.query(`
    SELECT public.pto_get_or_create_cycle(
      $1,
      MAKE_DATE(EXTRACT(YEAR FROM CURRENT_DATE)::INTEGER + 1, 2, 1)
    )
  `, [profile.rows[0].id]);

  await assert.rejects(
    pool.query(`
      INSERT INTO public.pto_policies (effective_from, entitlement_days)
      VALUES (MAKE_DATE(EXTRACT(YEAR FROM CURRENT_DATE)::INTEGER + 1, 1, 1), 7)
    `),
    /materialized PTO cycles/
  );
});

test('concurrent future policy creation serializes with entitlement-cycle materialization', { skip: !enabled }, async () => {
  assert.ok(pool);
  await pool.query(migrationSql);
  const profile = await pool.query<{ id: string }>(`
    INSERT INTO public.pto_profiles (first_name, last_name, identity_status)
    VALUES ('Concurrent Policy', 'Tutor', 'confirmed')
    RETURNING id
  `);
  const policyClient = await pool.connect();
  const cycleClient = await pool.connect();
  try {
    await policyClient.query('BEGIN');
    await cycleClient.query('BEGIN');
    const policy = await policyClient.query<{ effective_from: string }>(`
      INSERT INTO public.pto_policies (effective_from, entitlement_days)
      VALUES (MAKE_DATE(EXTRACT(YEAR FROM CURRENT_DATE)::INTEGER + 1, 1, 1), 8)
      RETURNING effective_from::TEXT
    `);
    const cyclePid = Number(
      (await cycleClient.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid
    );
    const cycleCreation = cycleClient.query<{ cycle_id: string }>(
      'SELECT public.pto_get_or_create_cycle($1, $2::DATE + 1) AS cycle_id',
      [profile.rows[0].id, policy.rows[0].effective_from]
    );
    await waitForBackendLock(pool, cyclePid);
    await policyClient.query('COMMIT');
    const cycle = await cycleCreation;
    await cycleClient.query('COMMIT');
    const stored = await pool.query<{ entitlement_days: string }>(
      'SELECT entitlement_days::TEXT FROM public.pto_entitlement_cycles WHERE id = $1',
      [cycle.rows[0].cycle_id]
    );
    assert.equal(stored.rows[0].entitlement_days, '8.00');
  } finally {
    await policyClient.query('ROLLBACK').catch(() => undefined);
    await cycleClient.query('ROLLBACK').catch(() => undefined);
    policyClient.release();
    cycleClient.release();
  }
});

test('admin adjustments require half-day increments and a non-empty reason', { skip: !enabled }, async () => {
  const db = pool;
  assert.ok(db);
  await db.query(migrationSql);
  const profile = await db.query<{ id: string }>(`
    INSERT INTO public.pto_profiles (first_name, last_name, identity_status)
    VALUES ('Adjustment', 'Tutor', 'confirmed')
    RETURNING id
  `);
  const cycle = await db.query<{ id: string }>(
    'SELECT public.pto_get_or_create_cycle($1, CURRENT_DATE) AS id',
    [profile.rows[0].id]
  );
  const insertAdjustment = (key: string, days: number, metadata: Record<string, unknown>) =>
    db.query(`
      INSERT INTO public.pto_ledger_entries (
        profile_id, cycle_id, event_type, balance_delta, reserved_delta, idempotency_key, metadata
      )
      VALUES ($1, $2, 'adjustment', $3, 0, $4, $5)
    `, [profile.rows[0].id, cycle.rows[0].id, days, key, metadata]);

  await assert.rejects(insertAdjustment('adjustment:quarter', 0.25, { reason: 'Invalid increment' }));
  await assert.rejects(insertAdjustment('adjustment:no-reason', 0.5, {}));
  await insertAdjustment('adjustment:valid', -0.5, { reason: 'Corrected imported balance' });
  const stored = await db.query<{ balance_delta: string; reason: string }>(`
    SELECT balance_delta::TEXT, metadata ->> 'reason' AS reason
    FROM public.pto_ledger_entries
    WHERE idempotency_key = 'adjustment:valid'
  `);
  assert.deepEqual(stored.rows[0], {
    balance_delta: '-0.50',
    reason: 'Corrected imported balance'
  });
});

test('time-off triggers ignore pre-activation rows and enforce reserve-consume-release lifecycle', { skip: !enabled }, async () => {
  assert.ok(pool);
  await pool.query(migrationSql);
  const requestValues = `
    20, 2001, TRUE, 9200, 'Lifecycle', 'Tutor', 'lifecycle@example.com',
    '2026-08-17T00:00:00Z', '2026-08-18T00:00:00Z', 'pto', 'pending', 24, FALSE,
    '{"startDate":"2026-08-17","endDate":"2026-08-17","source":"authenticated_timecard_app"}'::JSONB
  `;
  const beforeActivation = await pool.query<{ id: string }>(`
    INSERT INTO public.time_off_requests (
      franchiseid, tutorid, bridge_flag, bridge_profile_id, first_name, last_name, email,
      start_at, end_at, type, status, duration_hours, partial_day, public_metadata
    ) VALUES (${requestValues}) RETURNING id
  `);
  const ignored = await pool.query<{ count: string }>(
    'SELECT COUNT(*)::TEXT AS count FROM public.pto_request_allocations WHERE request_id = $1',
    [beforeActivation.rows[0].id]
  );
  assert.equal(ignored.rows[0].count, '0');

  await pool.query('INSERT INTO public.pto_center_settings (franchiseid, enabled) VALUES (20, TRUE)');
  const activeRequest = await pool.query<{ id: string }>(`
    INSERT INTO public.time_off_requests (
      franchiseid, tutorid, bridge_flag, bridge_profile_id, first_name, last_name, email,
      start_at, end_at, type, status, duration_hours, partial_day, public_metadata
    ) VALUES (${requestValues}) RETURNING id
  `);
  const requestId = Number(activeRequest.rows[0].id);
  const reserved = await pool.query<{ state: string; charged_days: string }>(
    'SELECT state, charged_days::TEXT FROM public.pto_request_allocations WHERE request_id = $1',
    [requestId]
  );
  assert.deepEqual(reserved.rows[0], { state: 'reserved', charged_days: '1.00' });
  await assert.rejects(
    pool.query("UPDATE public.time_off_requests SET email = 'changed@example.com' WHERE id = $1", [requestId]),
    /Held PTO identity\/date\/type fields cannot be changed/
  );

  await pool.query("UPDATE public.time_off_requests SET status = 'approved' WHERE id = $1", [requestId]);
  await pool.query("UPDATE public.time_off_requests SET status = 'cancelled' WHERE id = $1", [requestId]);
  const released = await pool.query<{ state: string }>(
    'SELECT state FROM public.pto_request_allocations WHERE request_id = $1',
    [requestId]
  );
  assert.equal(released.rows[0].state, 'released');
  const events = await pool.query<{ event_type: string }>(`
    SELECT event_type FROM public.pto_ledger_entries
    WHERE request_id = $1 ORDER BY id
  `, [requestId]);
  assert.deepEqual(events.rows.map((row) => row.event_type), ['reserve', 'consume', 'release']);
});
