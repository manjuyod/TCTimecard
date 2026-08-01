import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { DateTime } from 'luxon';
import { setPostgresPoolOverride } from '../db/postgres';
import clockRoutes from '../routes/clock';
import type { TimeEntryDayRow } from '../services/clockOutFinalization';

afterEach(() => {
  setPostgresPoolOverride(undefined);
});

const createApp = () => {
  const now = new Date().toISOString();
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as {
      session: { auth: Record<string, unknown>; save: (callback?: (err?: Error) => void) => void };
    }).session = {
      auth: {
        accountType: 'TUTOR',
        accountId: 42,
        franchiseId: 7,
        displayName: 'Test Tutor',
        createdAt: now,
        lastSeenAt: now
      },
      save: (callback) => callback?.()
    };
    next();
  });
  app.use('/api', clockRoutes);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Internal server error' });
  });
  return app;
};

const withServer = async <T>(app: express.Express, fn: (baseUrl: string) => Promise<T>): Promise<T> => {
  const server = await new Promise<ReturnType<express.Express['listen']>>((resolve) => {
    const nextServer = app.listen(0, () => resolve(nextServer));
  });

  try {
    const address = server.address() as AddressInfo;
    return await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
};

type ClockOutHarnessOptions = {
  openSession?: boolean;
  activeBreak?: boolean;
  storedSnapshot?: boolean;
  staleClockState?: boolean;
  invalidClosedSession?: boolean;
  loseCloseRace?: boolean;
  futureSession?: boolean;
};

const createClockOutHarness = (options: ClockOutHarnessOptions = {}) => {
  const timezone = 'UTC';
  const workDate = DateTime.now().setZone(timezone).toISODate();
  assert.ok(workDate);
  const targetEndAt = `${workDate}T14:00:00.000Z`;
  const sessionStart = options.futureSession
    ? `${workDate}T14:01:00.000Z`
    : `${workDate}T08:00:00.000Z`;
  const scheduleSnapshot = {
    version: 1 as const,
    franchiseId: 7,
    tutorId: 42,
    workDate,
    timezone,
    slotMinutes: 60,
    entries: [{ timeId: 1, timeLabel: '8:00 AM - 2:00 PM' }],
    intervals: [{ startAt: `${workDate}T08:00:00.000Z`, endAt: targetEndAt }]
  };
  let day: TimeEntryDayRow = {
    id: 55,
    franchiseid: 7,
    tutorid: 42,
    work_date: workDate,
    timezone,
    status: 'draft',
    clock_state: options.staleClockState === false ? 0 : 1,
    schedule_snapshot: options.storedSnapshot === false ? null : scheduleSnapshot,
    comparison: null,
    submitted_at: null,
    decided_by: null,
    decided_at: null,
    decision_reason: null,
    created_at: `${workDate}T08:00:00.000Z`,
    updated_at: `${workDate}T08:00:00.000Z`
  };
  const openSession = options.openSession === false ? null : { id: 66, start_at: sessionStart };
  const activeBreak = options.activeBreak ? {
    id: 77,
    entry_day_id: day.id,
    time_entry_session_id: openSession?.id ?? null,
    franchiseid: 7,
    tutorid: 42,
    break_type: 'lunch',
    pay_treatment: 'unpaid',
    start_time: `${workDate}T12:00:00.000Z`,
    end_time: null,
    duration_minutes: 0,
    source: 'employee',
    status: 'active',
    note: null,
    created_at: `${workDate}T12:00:00.000Z`,
    updated_at: `${workDate}T12:00:00.000Z`
  } : null;
  const queries: string[] = [];
  const transactions: string[] = [];
  const mutations: string[] = [];

  const client = {
    async query(sqlText: string, params: unknown[] = []) {
      queries.push(sqlText);
      if (sqlText === 'BEGIN' || sqlText === 'COMMIT' || sqlText === 'ROLLBACK') {
        transactions.push(sqlText);
        return { rowCount: 0, rows: [] };
      }
      if (/^(UPDATE|INSERT)/.test(sqlText.trim())) mutations.push(sqlText);
      if (sqlText.includes('FROM public.time_entry_days') && sqlText.includes('FOR UPDATE')) {
        return { rowCount: 1, rows: [{ ...day }] };
      }
      if (sqlText.includes('FROM public.time_entry_sessions') && sqlText.includes('end_at IS NULL')) {
        return openSession ? { rowCount: 1, rows: [{ ...openSession }] } : { rowCount: 0, rows: [] };
      }
      if (sqlText.includes('FROM public.time_entry_breaks') && sqlText.includes("status = 'active'")) {
        return activeBreak ? { rowCount: 1, rows: [{ ...activeBreak }] } : { rowCount: 0, rows: [] };
      }
      if (sqlText.includes("SELECT DATE_TRUNC('minute', NOW()) AS end_at")) {
        return { rowCount: 1, rows: [{ end_at: targetEndAt }] };
      }
      if (sqlText.includes('UPDATE public.time_entry_sessions')) {
        if (options.loseCloseRace) return { rowCount: 0, rows: [] };
        return { rowCount: 1, rows: [{ id: openSession?.id, start_at: sessionStart, end_at: params[0] }] };
      }
      if (sqlText.includes('UPDATE public.time_entry_days') && sqlText.includes('SET clock_state = 0')) {
        day = { ...day, clock_state: 0, timezone: String(params[0]), updated_at: targetEndAt };
        return { rowCount: 1, rows: [{ ...day }] };
      }
      if (sqlText.includes('FROM public.time_entry_sessions') && sqlText.includes('end_at IS NOT NULL')) {
        return {
          rowCount: 1,
          rows: [{
            id: openSession?.id ?? 66,
            start_at: sessionStart,
            end_at: options.invalidClosedSession ? `${workDate}T07:59:00.000Z` : targetEndAt,
            sort_order: 0
          }]
        };
      }
      if (sqlText.includes('FROM public.time_entry_breaks') && sqlText.includes('ANY($1::int[])')) {
        return { rowCount: 0, rows: [] };
      }
      if (sqlText.includes('UPDATE public.time_entry_days') && sqlText.includes('SET status = $1')) {
        day = {
          ...day,
          status: String(params[0]) as TimeEntryDayRow['status'],
          timezone: String(params[1]),
          schedule_snapshot: params[2],
          comparison: params[3],
          clock_state: 0,
          decided_at: params[4] as string | null,
          decision_reason: params[5] as string | null,
          updated_at: targetEndAt
        };
        return { rowCount: 1, rows: [{ ...day }] };
      }
      if (sqlText.includes('INSERT INTO public.time_entry_audit')) {
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
      queries.push(sqlText);
      if (sqlText.includes('FROM franchise_payroll_settings')) {
        return {
          rowCount: 1,
          rows: [{
            franchiseid: 7,
            policytype: 'strict_approval',
            timezone,
            pay_period_type: 'weekly',
            auto_email_enabled: false,
            custom_period_1_start_day: null,
            custom_period_1_end_day: null,
            custom_period_2_start_day: null,
            custom_period_2_end_day: null
          }]
        };
      }
      if (sqlText.includes('FROM franchise_pay_period_overrides')) return { rowCount: 0, rows: [] };
      if (sqlText.includes('FROM public.weekly_attestations')) return { rowCount: 1, rows: [{ exists: 1 }] };
      throw new Error(`Unexpected pool query: ${sqlText}`);
    },
    async connect() {
      return client;
    }
  } as never);

  return { app: createApp(), queries, transactions, mutations, timezone, workDate, dayId: day.id };
};

test('clock state resolves timezone without querying pay-period overrides', async () => {
  const queries: string[] = [];
  setPostgresPoolOverride({
    async query(sqlText: string) {
      queries.push(sqlText);

      if (sqlText.includes('FROM franchise_payroll_settings')) {
        return {
          rowCount: 1,
          rows: [{
            franchiseid: 7,
            policytype: 'strict_approval',
            timezone: 'America/Los_Angeles',
            pay_period_type: 'weekly',
            auto_email_enabled: false,
            custom_period_1_start_day: null,
            custom_period_1_end_day: null,
            custom_period_2_start_day: null,
            custom_period_2_end_day: null
          }]
        };
      }

      if (sqlText.includes('FROM franchise_pay_period_overrides')) {
        return { rowCount: 0, rows: [] };
      }

      if (sqlText.includes('FROM public.weekly_attestations')) {
        return { rowCount: 1, rows: [{ exists: 1 }] };
      }

      if (sqlText.includes('FROM public.time_entry_days')) {
        return { rowCount: 0, rows: [] };
      }

      throw new Error(`Unexpected query: ${sqlText}`);
    }
  } as never);

  await withServer(createApp(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/clock/me/state`);

    assert.equal(response.status, 200);
    assert.equal(queries.filter((sqlText) => sqlText.includes('FROM franchise_payroll_settings')).length, 1);
    assert.equal(queries.filter((sqlText) => sqlText.includes('FROM franchise_pay_period_overrides')).length, 0);
  });
});

test('clock out leaves a six-hour day fully paid when the tutor records no lunch', async () => {
  const timezone = 'UTC';
  const workDate = DateTime.now().setZone(timezone).toISODate();
  assert.ok(workDate);

  const startAt = `${workDate}T08:00:00.000Z`;
  const endAt = `${workDate}T14:00:00.000Z`;
  const scheduleSnapshot = {
    version: 1 as const,
    franchiseId: 7,
    tutorId: 42,
    workDate,
    timezone,
    slotMinutes: 60,
    entries: [{ timeId: 1, timeLabel: '8:00 AM - 2:00 PM' }],
    intervals: [{ startAt, endAt }]
  };
  const baseDay = {
    id: 44,
    franchiseid: 7,
    tutorid: 42,
    work_date: workDate,
    timezone,
    status: 'draft',
    clock_state: 1,
    schedule_snapshot: scheduleSnapshot,
    comparison: null,
    submitted_at: null,
    decided_by: null,
    decided_at: null,
    decision_reason: null,
    created_at: startAt,
    updated_at: startAt
  };
  const queries: string[] = [];
  const auditActions: string[] = [];
  const clockOutAuditMetadata: Array<Record<string, unknown>> = [];
  let savedComparison: Record<string, unknown> | null = null;

  const client = {
    async query(sqlText: string, params: unknown[] = []) {
      queries.push(sqlText);

      if (sqlText === 'BEGIN' || sqlText === 'COMMIT' || sqlText === 'ROLLBACK') {
        return { rowCount: 0, rows: [] };
      }
      if (sqlText.includes('FROM public.time_entry_days') && sqlText.includes('FOR UPDATE')) {
        return { rowCount: 1, rows: [{ ...baseDay }] };
      }
      if (sqlText.includes('FROM public.time_entry_sessions') && sqlText.includes('end_at IS NULL')) {
        return { rowCount: 1, rows: [{ id: 99, start_at: startAt }] };
      }
      if (sqlText.includes('FROM public.time_entry_breaks') && sqlText.includes("status = 'active'")) {
        return { rowCount: 0, rows: [] };
      }
      if (sqlText.includes('UPDATE public.time_entry_sessions')) {
        return { rowCount: 1, rows: [{ id: 99, start_at: startAt, end_at: endAt }] };
      }
      if (sqlText.includes("SELECT DATE_TRUNC('minute', NOW()) AS end_at")) {
        return { rowCount: 1, rows: [{ end_at: endAt }] };
      }
      if (sqlText.includes('FROM public.time_entry_sessions') && sqlText.includes('end_at IS NOT NULL')) {
        return {
          rowCount: 1,
          rows: [{ id: 99, entry_day_id: baseDay.id, start_at: startAt, end_at: endAt, sort_order: 0 }]
        };
      }
      if (sqlText.includes('FROM public.time_entry_breaks') && sqlText.includes('ANY($1::int[])')) {
        return { rowCount: 0, rows: [] };
      }
      if (sqlText.includes('FROM public.time_entry_break_rules')) {
        throw new Error('automatic lunch rule query attempted');
      }
      if (sqlText.includes('INSERT INTO public.time_entry_breaks')) {
        throw new Error('automatic lunch insert attempted');
      }
      if (sqlText.includes('UPDATE public.time_entry_days') && sqlText.includes('SET status = $1')) {
        savedComparison = params[3] as Record<string, unknown>;
        return {
          rowCount: 1,
          rows: [{
            ...baseDay,
            status: params[0],
            clock_state: 0,
            schedule_snapshot: params[2],
            comparison: params[3],
            decided_at: params[4],
            decision_reason: params[5],
            updated_at: endAt
          }]
        };
      }
      if (sqlText.includes('UPDATE public.time_entry_days') && sqlText.includes('SET clock_state = 0')) {
        return { rowCount: 1, rows: [{ ...baseDay, clock_state: 0, updated_at: endAt }] };
      }
      if (sqlText.includes('INSERT INTO public.time_entry_audit')) {
        auditActions.push(String(params[1]));
        if (params[1] === 'clock_out') clockOutAuditMetadata.push(params[6] as Record<string, unknown>);
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
      queries.push(sqlText);

      if (sqlText.includes('FROM franchise_payroll_settings')) {
        return {
          rowCount: 1,
          rows: [{
            franchiseid: 7,
            policytype: 'strict_approval',
            timezone,
            pay_period_type: 'weekly',
            auto_email_enabled: false,
            custom_period_1_start_day: null,
            custom_period_1_end_day: null,
            custom_period_2_start_day: null,
            custom_period_2_end_day: null
          }]
        };
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

  await withServer(createApp(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/clock/me/out`, { method: 'POST' });
    const body = (await response.json()) as {
      error?: string;
      state?: {
        timezone: string;
        workDate: string;
        dayId: number | null;
        dayStatus: string | null;
        clockState: number;
        persistedClockState: number;
        openSessionId: number | null;
        startedAt: string | null;
        activeBreak: unknown | null;
        breaks: unknown[];
        breakSummary: { paidBreakMinutes: number; unpaidBreakMinutes: number };
        attestationBlocking: boolean;
        missingWeekEnd: string | null;
      };
    };

    assert.equal(response.status, 200, body.error);
    assert.deepEqual(body.state, {
      timezone,
      workDate,
      dayId: baseDay.id,
      dayStatus: 'approved',
      clockState: 0,
      persistedClockState: 0,
      openSessionId: null,
      startedAt: null,
      activeBreak: null,
      breaks: [],
      breakSummary: { paidBreakMinutes: 0, unpaidBreakMinutes: 0 },
      attestationBlocking: false,
      missingWeekEnd: null
    });
  });

  const manual = (savedComparison as {
    manual?: { grossMinutes?: number; paidMinutes?: number };
  } | null)?.manual;
  assert.equal(manual?.grossMinutes, 360);
  assert.equal(manual?.paidMinutes, 360);
  assert.equal((savedComparison as { version?: number } | null)?.version, 2);
  assert.equal(queries.some((sqlText) => sqlText.includes('time_entry_break_rules')), false);
  assert.equal(queries.some((sqlText) => sqlText.includes('INSERT INTO public.time_entry_breaks')), false);
  assert.equal(auditActions.includes('auto_break_applied'), false);
  assert.equal(clockOutAuditMetadata[0]?.source, 'clock_out');
  assert.equal(typeof clockOutAuditMetadata[0]?.detectedAt, 'string');
});

test('manual active break takes precedence over a missing snapshot without mutation', async () => {
  const harness = createClockOutHarness({ activeBreak: true, storedSnapshot: false });
  await withServer(harness.app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/clock/me/out`, { method: 'POST' });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: 'End the active break before clocking out.' });
  });
  assert.deepEqual(harness.mutations, []);
  assert.equal(harness.transactions.includes('COMMIT'), false);
  assert.equal(harness.transactions[harness.transactions.length - 1], 'ROLLBACK');
});

test('manual active break with no open session still returns the exact 409 without mutation', async () => {
  const harness = createClockOutHarness({ openSession: false, activeBreak: true, storedSnapshot: false });
  await withServer(harness.app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/clock/me/out`, { method: 'POST' });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: 'End the active break before clocking out.' });
  });
  assert.deepEqual(harness.mutations, []);
  assert.equal(harness.transactions[harness.transactions.length - 1], 'ROLLBACK');
});

test('no open session repairs stale clock state without requiring a snapshot', async () => {
  const harness = createClockOutHarness({ openSession: false, storedSnapshot: false });
  await withServer(harness.app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/clock/me/out`, { method: 'POST' });
    const body = await response.json() as { state?: Record<string, unknown> };
    assert.equal(response.status, 200);
    assert.deepEqual(body.state, {
      timezone: harness.timezone,
      workDate: harness.workDate,
      dayId: harness.dayId,
      dayStatus: 'draft',
      clockState: 0,
      persistedClockState: 0,
      openSessionId: null,
      startedAt: null,
      activeBreak: null,
      breaks: [],
      breakSummary: { paidBreakMinutes: 0, unpaidBreakMinutes: 0 },
      attestationBlocking: false,
      missingWeekEnd: null
    });
  });
  assert.equal(harness.transactions[harness.transactions.length - 1], 'COMMIT');
});

test('invalid stored session comparison returns the existing 400 and rolls back', async () => {
  const harness = createClockOutHarness({ invalidClosedSession: true });
  await withServer(harness.app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/clock/me/out`, { method: 'POST' });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: 'Stored sessions are invalid; re-save your day sessions.'
    });
  });
  assert.equal(harness.transactions.includes('COMMIT'), false);
  assert.equal(harness.transactions[harness.transactions.length - 1], 'ROLLBACK');
});

test('invalid clock-out end returns the stored-session 400 and never commits', async () => {
  const harness = createClockOutHarness({ futureSession: true });
  await withServer(harness.app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/clock/me/out`, { method: 'POST' });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: 'Stored sessions are invalid; re-save your day sessions.'
    });
  });
  assert.equal(harness.transactions.includes('COMMIT'), false);
  assert.equal(harness.transactions[harness.transactions.length - 1], 'ROLLBACK');
});

test('lost session-close race returns a full idempotent out state', async () => {
  const harness = createClockOutHarness({ loseCloseRace: true });
  await withServer(harness.app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/clock/me/out`, { method: 'POST' });
    const body = await response.json() as { error?: string; state?: Record<string, unknown> };
    assert.equal(response.status, 200, body.error);
    assert.equal(body.state?.clockState, 0);
    assert.equal(body.state?.persistedClockState, 0);
    assert.equal(body.state?.openSessionId, null);
  });
  assert.equal(harness.transactions[harness.transactions.length - 1], 'COMMIT');
});
