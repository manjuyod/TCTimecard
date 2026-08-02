import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { setMssqlPoolOverride } from '../db/mssql';
import { setPostgresPoolOverride } from '../db/postgres';
import clockRoutes from '../routes/clock';
import type { TimeEntryDayRow } from '../services/clockOutFinalization';

afterEach(() => {
  setMssqlPoolOverride(undefined);
  setPostgresPoolOverride(undefined);
});

const createApp = () => {
  const now = new Date().toISOString();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as {
      session: { auth: Record<string, unknown>; save: (callback?: (error?: Error) => void) => void };
    }).session = {
      auth: {
        accountType: 'TUTOR', accountId: 42, franchiseId: 7,
        displayName: 'Time Snap Tutor', createdAt: now, lastSeenAt: now
      },
      save: (callback) => callback?.()
    };
    next();
  });
  app.use('/api', clockRoutes);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Internal server error' });
  });
  return app;
};

const withServer = async <T>(app: express.Express, run: (baseUrl: string) => Promise<T>): Promise<T> => {
  const server = await new Promise<ReturnType<express.Express['listen']>>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  try {
    const address = server.address() as AddressInfo;
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
};

const payrollSettingsRow = (clockInTimeSnapEnabled: boolean) => ({
  franchiseid: 7,
  policytype: 'strict_approval',
  timezone: 'America/Los_Angeles',
  pay_period_type: 'weekly',
  auto_email_enabled: false,
  custom_period_1_start_day: null,
  custom_period_1_end_day: null,
  custom_period_2_start_day: null,
  custom_period_2_end_day: null,
  auto_clock_out_enabled: false,
  clock_in_time_snap_enabled: clockInTimeSnapEnabled
});

const createClockInHarness = (options: {
  clockInTimeSnapEnabled: boolean;
  scheduleFailure?: boolean;
}) => {
  const workDate = '2026-08-01';
  let day: TimeEntryDayRow = {
    id: 55,
    franchiseid: 7,
    tutorid: 42,
    work_date: workDate,
    timezone: 'America/Los_Angeles',
    status: 'draft',
    clock_state: 0,
    schedule_snapshot: null,
    comparison: null,
    submitted_at: null,
    decided_by: null,
    decided_at: null,
    decision_reason: null,
    created_at: '2026-08-01T15:00:00.000Z',
    updated_at: '2026-08-01T15:00:00.000Z'
  };
  let insertedStartAt: string | null = null;
  let auditMetadata: Record<string, unknown> | null = null;
  let scheduleQueries = 0;

  const client = {
    async query(sqlText: string, params: unknown[] = []) {
      if (sqlText === 'BEGIN' || sqlText === 'COMMIT' || sqlText === 'ROLLBACK') {
        return { rowCount: 0, rows: [] };
      }
      if (sqlText.includes('INSERT INTO public.time_entry_days')) {
        return { rowCount: 0, rows: [] };
      }
      if (sqlText.includes('FROM public.time_entry_days') && sqlText.includes('FOR UPDATE')) {
        return { rowCount: 1, rows: [{ ...day }] };
      }
      if (sqlText.includes('FROM public.time_entry_sessions') && sqlText.includes('end_at IS NULL')) {
        return { rowCount: 0, rows: [] };
      }
      if (sqlText.includes('MAX(sort_order)')) {
        return { rowCount: 1, rows: [{ next_sort_order: 0 }] };
      }
      if (sqlText.includes('INSERT INTO public.time_entry_sessions')) {
        insertedStartAt = params.find((value) => typeof value === 'string' && value.includes('T')) as string
          ?? '2026-08-01T15:52:00.000Z';
        return { rowCount: 1, rows: [{ id: 99, start_at: insertedStartAt }] };
      }
      if (sqlText.includes('UPDATE public.time_entry_days') && sqlText.includes('SET clock_state = 1')) {
        day = { ...day, clock_state: 1 };
        return { rowCount: 1, rows: [{ ...day }] };
      }
      if (sqlText.includes('INSERT INTO public.time_entry_audit')) {
        auditMetadata = params[6] as Record<string, unknown>;
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected client query: ${sqlText}`);
    },
    release() {
      return undefined;
    }
  };

  setPostgresPoolOverride({
    async query(sqlText: string) {
      if (sqlText.includes('franchise_payroll_settings')) {
        return { rowCount: 1, rows: [payrollSettingsRow(options.clockInTimeSnapEnabled)] };
      }
      if (sqlText.includes('FROM franchise_pay_period_overrides')) {
        return { rowCount: 0, rows: [] };
      }
      if (sqlText.includes('FROM public.weekly_attestations')) {
        return { rowCount: 1, rows: [{ exists: 1 }] };
      }
      throw new Error(`Unexpected pool query: ${sqlText}`);
    },
    async connect() {
      return client;
    }
  } as never);

  setMssqlPoolOverride({
    request() {
      return {
        input() {
          return this;
        },
        async query() {
          scheduleQueries += 1;
          if (options.scheduleFailure) throw new Error('schedule database unavailable');
          return {
            recordset: [{
              FranchiseID: 7,
              TutorID: 42,
              WorkDate: workDate,
              TimeID: 10,
              TimeLabel: '9:00 AM - 10:00 AM'
            }]
          };
        }
      };
    }
  } as never);

  return {
    app: createApp(),
    insertedStartAt: () => insertedStartAt,
    auditMetadata: () => auditMetadata,
    scheduleQueries: () => scheduleQueries
  };
};

test('enabled Time Snap hard-records the scheduled hour and audit details', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-08-01T15:52:45.000Z') });
  const harness = createClockInHarness({ clockInTimeSnapEnabled: true });

  await withServer(harness.app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/clock/me/in`, { method: 'POST' });
    const body = await response.json() as { state?: { startedAt?: string } };
    assert.equal(response.status, 201, JSON.stringify(body));
    assert.equal(body.state?.startedAt, '2026-08-01T16:00:00.000Z');
  });

  assert.equal(harness.insertedStartAt(), '2026-08-01T16:00:00.000Z');
  assert.equal(harness.scheduleQueries(), 1);
  assert.equal(harness.auditMetadata()?.detectedAt, '2026-08-01T15:52:00.000Z');
  assert.equal(harness.auditMetadata()?.startedAt, '2026-08-01T16:00:00.000Z');
  assert.equal(harness.auditMetadata()?.timeSnapApplied, true);
  assert.equal(harness.auditMetadata()?.matchedScheduledStartAt, '2026-08-01T16:00:00.000Z');
});

test('schedule failure records the actual minute without failing clock-in', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-08-01T15:52:45.000Z') });
  const harness = createClockInHarness({ clockInTimeSnapEnabled: true, scheduleFailure: true });
  const originalError = console.error;
  console.error = () => undefined;
  try {
    await withServer(harness.app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/clock/me/in`, { method: 'POST' });
      const body = await response.json() as { state?: { startedAt?: string } };
      assert.equal(response.status, 201, JSON.stringify(body));
      assert.equal(body.state?.startedAt, '2026-08-01T15:52:00.000Z');
    });
  } finally {
    console.error = originalError;
  }

  assert.equal(harness.scheduleQueries(), 1);
  assert.equal(harness.auditMetadata()?.timeSnapApplied, false);
  assert.equal(harness.auditMetadata()?.matchedScheduledStartAt, null);
});

test('disabled Time Snap records the actual minute without querying schedules', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-08-01T15:52:45.000Z') });
  const harness = createClockInHarness({ clockInTimeSnapEnabled: false });

  await withServer(harness.app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/clock/me/in`, { method: 'POST' });
    const body = await response.json() as { state?: { startedAt?: string } };
    assert.equal(response.status, 201, JSON.stringify(body));
    assert.equal(body.state?.startedAt, '2026-08-01T15:52:00.000Z');
  });

  assert.equal(harness.scheduleQueries(), 0);
  assert.equal(harness.auditMetadata()?.timeSnapApplied, false);
});

test('break start before a future snapped session is rejected without mutation', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-08-01T15:55:00.000Z') });
  const workDate = '2026-08-01';
  const transactions: string[] = [];
  let auditInserted = false;
  const dayRow: TimeEntryDayRow = {
    id: 55, franchiseid: 7, tutorid: 42, work_date: workDate,
    timezone: 'America/Los_Angeles', status: 'draft', clock_state: 1,
    schedule_snapshot: null, comparison: null, submitted_at: null,
    decided_by: null, decided_at: null, decision_reason: null,
    created_at: '2026-08-01T15:52:00.000Z', updated_at: '2026-08-01T15:52:00.000Z'
  };
  const breakRow = {
    id: 70, entry_day_id: 55, time_entry_session_id: 99,
    franchiseid: 7, tutorid: 42, break_type: 'lunch', pay_treatment: 'unpaid',
    start_time: '2026-08-01T15:55:00.000Z', end_time: null,
    duration_minutes: 0, source: 'employee', status: 'active', note: null,
    created_at: '2026-08-01T15:55:00.000Z', updated_at: '2026-08-01T15:55:00.000Z'
  };
  const client = {
    async query(sqlText: string) {
      if (sqlText === 'BEGIN' || sqlText === 'COMMIT' || sqlText === 'ROLLBACK') {
        transactions.push(sqlText);
        return { rowCount: 0, rows: [] };
      }
      if (sqlText.includes('FROM public.time_entry_days') && sqlText.includes('FOR UPDATE')) {
        return { rowCount: 1, rows: [dayRow] };
      }
      if (sqlText.includes('FROM public.time_entry_sessions') && sqlText.includes('end_at IS NULL')) {
        return { rowCount: 1, rows: [{ id: 99, start_at: '2026-08-01T16:00:00.000Z' }] };
      }
      if (sqlText.includes('FROM public.time_entry_breaks') && sqlText.includes("status = 'active'")) {
        return { rowCount: 0, rows: [] };
      }
      if (sqlText.includes('INSERT INTO public.time_entry_breaks')) {
        const guarded = /WHERE DATE_TRUNC\('minute', NOW\(\)\) >= \$7::timestamptz/i.test(sqlText);
        return guarded ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [breakRow] };
      }
      if (sqlText.includes('INSERT INTO public.time_entry_audit')) {
        auditInserted = true;
        return { rowCount: 1, rows: [] };
      }
      if (sqlText.includes('FROM public.time_entry_breaks') && sqlText.includes('ANY($1::int[])')) {
        return { rowCount: 1, rows: [breakRow] };
      }
      throw new Error(`Unexpected client query: ${sqlText}`);
    },
    release() {
      return undefined;
    }
  };
  setPostgresPoolOverride({
    async query(sqlText: string) {
      if (sqlText.includes('franchise_payroll_settings')) {
        return { rowCount: 1, rows: [payrollSettingsRow(true)] };
      }
      if (sqlText.includes('FROM franchise_pay_period_overrides')) return { rowCount: 0, rows: [] };
      if (sqlText.includes('FROM public.weekly_attestations')) return { rowCount: 1, rows: [{ exists: 1 }] };
      throw new Error(`Unexpected pool query: ${sqlText}`);
    },
    async connect() {
      return client;
    }
  } as never);

  await withServer(createApp(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/clock/me/break/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ breakType: 'lunch' })
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: 'A break cannot start before your recorded clock-in time.'
    });
  });
  assert.equal(auditInserted, false);
  assert.equal(transactions[transactions.length - 1], 'ROLLBACK');
});
