import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { DateTime } from 'luxon';
import timeEntryRoutes from '../../routes/timeEntry';
import clockRoutes from '../../routes/clock';
import { setPostgresPoolOverride } from '../../db/postgres';
import { setMssqlPoolOverride } from '../../db/mssql';
import { createAdminRepository } from '../../services/adminTimeEntry/repository';
import { createAdminDirectory } from '../../services/adminTimeEntry/directory';
import {
  getScheduleSnapshotSigningSecret,
  signScheduleSnapshot,
  type ScheduleSnapshotV1,
} from '../../services/scheduleSnapshot';
import type { PreviewDeps } from '../../services/adminTimeEntry/contracts';
import { seedPendingEntry } from './adminTimeEntryFixtures';

export const timezone = 'America/Los_Angeles';
export const actor = { accountId: 100, franchiseId: 77 };
export type Trace = {
  clientId: number;
  sql: string;
  parentOwned: boolean;
  rowCount: number | null;
};
export type QueryHook = (
  sql: string,
  result: QueryResult,
  clientId: number,
) => Promise<void>;
const childWrite = (sql: string) =>
  /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+public\.time_entry_(?:sessions|breaks|audit)\b/i.test(
    sql,
  );

/** Intercept boundaries for observation/barriers only. Every SQL query is real. */
export function observedPool(
  pool: Pool,
  traces: Trace[],
  hook?: QueryHook,
): Pool {
  return new Proxy(pool, {
    get(target, property) {
      if (property === 'query')
        return async (...args: any[]) => {
          assert.ok(
            !childWrite(String(args[0])),
            'Writer child writes must use a transaction connection',
          );
          return (pool.query as any)(...args);
        };
      if (property === 'connect')
        return async () => {
          const client = await pool.connect();
          const clientId = (
            await client.query('SELECT pg_backend_pid() AS pid')
          ).rows[0].pid;
          let parentOwned = false;
          return new Proxy(client, {
            get(clientTarget, key) {
              if (key === 'query')
                return async (sql: string, params?: any[]) => {
                  if (sql === 'BEGIN') parentOwned = false;
                  if (childWrite(sql))
                    assert.ok(
                      parentOwned,
                      `Child write before scoped parent lock/creation: ${sql}`,
                    );
                  const result = await client.query(sql, params);
                  if (
                    /FROM public\.time_entry_days/i.test(sql) &&
                    /FOR UPDATE/i.test(sql) &&
                    result.rowCount
                  )
                    parentOwned = true;
                  if (
                    /INSERT INTO public\.time_entry_days/i.test(sql) &&
                    result.rowCount
                  )
                    parentOwned = true;
                  traces.push({
                    clientId,
                    sql,
                    parentOwned,
                    rowCount: result.rowCount,
                  });
                  await hook?.(sql, result, clientId);
                  return result;
                };
              const value = Reflect.get(clientTarget, key);
              return typeof value === 'function'
                ? value.bind(clientTarget)
                : value;
            },
          }) as PoolClient;
        };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export function barrier() {
  let release!: () => void;
  const wait = new Promise<void>((r) => {
    release = r;
  });
  return { wait, release };
}

export async function prepare(pool: Pool) {
  const today = DateTime.now().setZone(timezone).startOf('day'),
    workDate = today.toISODate()!;
  const start = today.set({ hour: 9 }).toUTC().toISO()!,
    end = today.set({ hour: 12 }).toUTC().toISO()!,
    correctedEnd = today.set({ hour: 12, minute: 15 }).toUTC().toISO()!;
  const breakStart = today.set({ hour: 9, minute: 30 }).toUTC().toISO()!,
    breakEnd = today.set({ hour: 10 }).toUTC().toISO()!;
  await pool.query(`CREATE TABLE public.franchise_payroll_settings(franchiseid INTEGER PRIMARY KEY,policytype TEXT NOT NULL,timezone TEXT NOT NULL,pay_period_type TEXT NOT NULL,auto_email_enabled BOOLEAN NOT NULL,custom_period_1_start_day INTEGER,custom_period_1_end_day INTEGER,custom_period_2_start_day INTEGER,custom_period_2_end_day INTEGER,auto_clock_out_enabled BOOLEAN NOT NULL DEFAULT FALSE,clock_in_time_snap_enabled BOOLEAN NOT NULL DEFAULT FALSE,time_off_notice_required BOOLEAN NOT NULL DEFAULT TRUE);
    CREATE TABLE public.franchise_pay_period_overrides(id SERIAL PRIMARY KEY,franchiseid INTEGER NOT NULL,periodstart DATE NOT NULL,periodend DATE NOT NULL,createdat TIMESTAMPTZ NOT NULL DEFAULT NOW());
    INSERT INTO public.franchise_payroll_settings(franchiseid,policytype,timezone,pay_period_type,auto_email_enabled)VALUES(77,'strict_approval','America/Los_Angeles','weekly',FALSE)`);
  const lastSaturday = today.minus({ days: (today.weekday % 7) + 1 });
  await pool.query(
    `INSERT INTO public.weekly_attestations(franchiseid,tutorid,week_start,week_end,timezone,typed_name,attestation_text,attestation_text_version)VALUES(77,88,$1,$2,$3,'Alex Rivera','Fixture attestation','v1')`,
    [
      lastSaturday.minus({ days: 6 }).toISODate(),
      lastSaturday.toISODate(),
      timezone,
    ],
  );
  const base: ScheduleSnapshotV1 = {
    version: 1,
    franchiseId: 77,
    tutorId: 88,
    workDate,
    timezone,
    slotMinutes: 60,
    entries: [],
    intervals: [{ startAt: start, endAt: end }],
  };
  const secret = getScheduleSnapshotSigningSecret();
  const snapshot = secret ? signScheduleSnapshot(base, secret) : base;
  const directory = createAdminDirectory({
    pool: () => pool,
    roster: async (center) => {
      assert.equal(center, 77);
      return [
        {
          tutorId: 88,
          displayName: 'Alex Rivera',
          active: true,
          historyOnly: false,
        },
      ];
    },
  });
  const repo = createAdminRepository({
    pool: () => pool,
    directory,
    timezone: async () => timezone,
  });
  const now = () => today.set({ hour: 23, minute: 59 }).toJSDate(),
    previewSecret = 'disposable-writer-test-secret';
  const deps: PreviewDeps = {
    getDetail: repo.getAdminDetail,
    getById: repo.getAdminDetailById,
    requireActiveTutor: directory.requireActiveTutor,
    getSchedule: async () => null,
    now,
    secret: previewSecret,
  };
  return {
    today,
    workDate,
    start,
    end,
    correctedEnd,
    breakStart,
    breakEnd,
    snapshot,
    repo,
    deps,
    operation: { pool, now, secret: previewSecret },
  };
}

export async function seedDay(
  pool: Pool,
  fixture: Awaited<ReturnType<typeof prepare>>,
  status = 'draft',
) {
  await seedPendingEntry(pool);
  await pool.query(
    'UPDATE public.time_entry_days SET work_date=$1,status=$2 WHERE id=44',
    [fixture.workDate, status],
  );
  await pool.query(
    'UPDATE public.time_entry_sessions SET start_at=$1,end_at=$2 WHERE id=99',
    [fixture.start, fixture.end],
  );
}

export async function databaseState(pool: Pool) {
  const state = {
    days: (
      await pool.query(
        'SELECT row_to_json(d) AS row FROM public.time_entry_days d ORDER BY id',
      )
    ).rows.map((r) => r.row),
    sessions: (
      await pool.query(
        'SELECT row_to_json(s) AS row FROM public.time_entry_sessions s ORDER BY id',
      )
    ).rows.map((r) => r.row),
    breaks: (
      await pool.query(
        'SELECT row_to_json(b) AS row FROM public.time_entry_breaks b ORDER BY id',
      )
    ).rows.map((r) => r.row),
    audits: (
      await pool.query(
        'SELECT row_to_json(a) AS row FROM public.time_entry_audit a ORDER BY id',
      )
    ).rows.map((r) => r.row),
  };
  return state;
}

export async function waitForParentWaiter(pool: Pool, blockerId: number) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (
      (
        await pool.query(
          "SELECT count(*)::integer AS n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%public.time_entry_days%FOR UPDATE%'",
          [blockerId],
        )
      ).rows[0].n > 0
    )
      return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('No actual parent-lock waiter observed');
}

export async function withWriterHttp<T>(
  pool: Pool,
  run: (
    request: (
      method: string,
      path: string,
      body?: unknown,
      admin?: boolean,
    ) => Promise<Response>,
  ) => Promise<T>,
): Promise<T> {
  setPostgresPoolOverride(pool);
  setMssqlPoolOverride({
    request() {
      return {
        input() {
          return this;
        },
        async query() {
          throw new Error('Writer tests must not contact CRM');
        },
      };
    },
  } as never);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const now = new Date().toISOString(),
      admin = req.headers['x-test-role'] === 'admin';
    (req as any).session = {
      auth: {
        accountType: admin ? 'ADMIN' : 'TUTOR',
        accountId: admin ? 100 : 88,
        franchiseId: 77,
        displayName: admin ? 'Test Admin' : 'Alex Rivera',
        createdAt: now,
        lastSeenAt: now,
      },
      save: (callback: () => void) => callback?.(),
    };
    next();
  });
  app.use('/api', timeEntryRoutes);
  app.use('/api', clockRoutes);
  app.use(
    (
      error: any,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) =>
      res
        .status(error.status ?? 500)
        .json({
          error: error.message ?? 'Unexpected error',
          ...(error.code ? { code: error.code } : {}),
        }),
  );
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const request = (
    method: string,
    path: string,
    body: unknown = {},
    admin = false,
  ) =>
    fetch(base + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(admin ? { 'x-test-role': 'admin' } : {}),
      },
      body: method === 'GET' ? undefined : JSON.stringify(body),
    });
  try {
    return await run(request);
  } finally {
    await new Promise<void>((r, j) =>
      server.close((error) => (error ? j(error) : r())),
    );
    setPostgresPoolOverride(undefined);
    setMssqlPoolOverride(undefined);
  }
}
