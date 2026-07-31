import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { DateTime } from 'luxon';
import { setPostgresPoolOverride } from '../db/postgres';
import clockRoutes from '../routes/clock';

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
        breaks: unknown[];
        breakSummary: { paidBreakMinutes: number; unpaidBreakMinutes: number };
      };
    };

    assert.equal(response.status, 200, body.error);
    assert.deepEqual(body.state?.breaks, []);
    assert.equal(body.state?.breakSummary.unpaidBreakMinutes, 0);
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
});
