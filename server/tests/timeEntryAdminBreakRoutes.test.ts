import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { setPostgresPoolOverride } from '../db/postgres';
import timeEntryRoutes from '../routes/timeEntry';

type SessionAuth = {
  accountType: 'ADMIN' | 'TUTOR';
  accountId: number;
  franchiseId: number | null;
  displayName?: string;
};

type QueryResult = { rowCount: number; rows: Array<Record<string, unknown>> };
type BreakRow = {
  id: number;
  entry_day_id: number;
  time_entry_session_id: number | null;
  franchiseid: number;
  tutorid: number;
  break_type: string;
  pay_treatment: string;
  start_time: string | null;
  end_time: string | null;
  duration_minutes: number;
  source: string;
  status: string;
  note: string | null;
  created_at: string;
  updated_at: string;
};

const now = '2026-01-02T18:00:00.000Z';

const baseDay = {
  id: 44,
  franchiseid: 77,
  tutorid: 88,
  work_date: '2026-01-02',
  timezone: 'America/Los_Angeles',
  status: 'pending',
  schedule_snapshot: {
    version: 1,
    franchiseId: 77,
    tutorId: 88,
    workDate: '2026-01-02',
    timezone: 'UTC',
    slotMinutes: 60,
    entries: [],
    intervals: [{ startAt: '2026-01-02T09:00:00.000Z', endAt: '2026-01-02T17:00:00.000Z' }]
  },
  comparison: null,
  submitted_at: now,
  decided_by: null,
  decided_at: null,
  decision_reason: null,
  created_at: now,
  updated_at: now
};

const baseSession = {
  id: 99,
  entry_day_id: baseDay.id,
  start_at: '2026-01-02T09:00:00.000Z',
  end_at: '2026-01-02T17:00:00.000Z',
  sort_order: 0
};

const createBreak = (): BreakRow => ({
  id: 123,
  entry_day_id: baseDay.id,
  time_entry_session_id: null,
  franchiseid: baseDay.franchiseid,
  tutorid: baseDay.tutorid,
  break_type: 'lunch',
  pay_treatment: 'unpaid',
  start_time: null,
  end_time: null,
  duration_minutes: 30,
  source: 'auto_rule',
  status: 'completed',
  note: 'Auto-applied after 360 gross minutes',
  created_at: now,
  updated_at: now
});

afterEach(() => {
  setPostgresPoolOverride(undefined);
});

const createApp = (auth: SessionAuth) => {
  const sessionNow = new Date().toISOString();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: { auth: Record<string, unknown>; save: (callback?: (err?: Error) => void) => void } }).session = {
      auth: {
        ...auth,
        createdAt: sessionNow,
        lastSeenAt: sessionNow
      },
      save: (callback) => {
        if (callback) callback();
      }
    };
    next();
  });
  app.use('/api', timeEntryRoutes);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = typeof (err as { status?: number } | null | undefined)?.status === 'number'
      ? (err as { status: number }).status
      : 500;
    const message = err instanceof Error ? err.message : 'Internal server error';
    res.status(status).json({ error: message });
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

test('admin break update preserves original break source while auditing manager edit', async () => {
  let breakRow = createBreak();
  let auditMetadata: Record<string, unknown> | null = null;

  const client = {
    async query(sql: string, params: unknown[] = []): Promise<QueryResult> {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: 0, rows: [] };

      if (sql.includes('FROM public.time_entry_days') && sql.includes('FOR UPDATE')) {
        return { rowCount: 1, rows: [{ ...baseDay }] };
      }

      if (sql.includes('FROM public.time_entry_breaks') && sql.includes('FOR UPDATE')) {
        return { rowCount: 1, rows: [{ ...breakRow }] };
      }

      if (sql.includes('FROM public.time_entry_sessions')) {
        return { rowCount: 1, rows: [{ ...baseSession }] };
      }

      if (sql.includes('FROM public.time_entry_breaks') && sql.includes('ANY($1::int[])')) {
        return { rowCount: 1, rows: [{ ...breakRow }] };
      }

      if (sql.includes('UPDATE public.time_entry_breaks')) {
        breakRow = {
          ...breakRow,
          time_entry_session_id: params[0] as number | null,
          break_type: String(params[1]),
          pay_treatment: String(params[2]),
          start_time: params[3] as string | null,
          end_time: params[4] as string | null,
          duration_minutes: Number(params[5]),
          source: sql.includes("source = 'manager'") ? 'manager' : breakRow.source,
          status: 'completed',
          note: params[6] as string | null,
          updated_at: now
        };
        return { rowCount: 1, rows: [{ ...breakRow }] };
      }

      if (sql.includes('UPDATE public.time_entry_days')) {
        return { rowCount: 1, rows: [{ ...baseDay, updated_at: now }] };
      }

      if (sql.includes('INSERT INTO public.time_entry_audit')) {
        auditMetadata = params[6] as Record<string, unknown>;
        return { rowCount: 1, rows: [] };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {
      return undefined;
    }
  };

  setPostgresPoolOverride({ connect: async () => client } as never);
  const app = createApp({ accountType: 'ADMIN', accountId: 100, franchiseId: 77, displayName: 'Admin User' });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/time-entry/admin/day/${baseDay.id}/breaks/${breakRow.id}?franchiseId=77`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        breakType: 'lunch',
        payTreatment: 'paid',
        durationMinutes: 30,
        note: 'Paid lunch exception'
      })
    });

    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      day: {
        breaks: Array<{ source: string; payTreatment: string; note: string | null }>;
        comparison: {
          version: number;
          matches: boolean;
          breaks: { unpositionedMinutes: number };
        };
        breakSummary: {
          paidBreakMinutes: number;
          unpaidBreakMinutes: number;
          paidMinutes: number;
          unpositionedBreakMinutes: number;
        };
      };
    };

    assert.equal(body.day.breaks[0].source, 'auto_rule');
    assert.equal(body.day.breaks[0].payTreatment, 'paid');
    assert.equal(body.day.breaks[0].note, 'Paid lunch exception');
    assert.equal(body.day.breakSummary.paidBreakMinutes, 0);
    assert.equal(body.day.breakSummary.unpaidBreakMinutes, 0);
    assert.equal(body.day.breakSummary.paidMinutes, 480);
    assert.equal(body.day.breakSummary.unpositionedBreakMinutes, 30);
    assert.equal(body.day.comparison.version, 2);
    assert.equal(body.day.comparison.matches, true);
    assert.equal(body.day.comparison.breaks.unpositionedMinutes, 30);
    assert.equal((auditMetadata?.break as { source?: string } | undefined)?.source, 'auto_rule');
    assert.equal((auditMetadata?.previousBreak as { source?: string } | undefined)?.source, 'auto_rule');
  });
});

test('admin session edits recompute comparison with existing break timestamps', async () => {
  let sessionRows = [{ ...baseSession }];
  const timedBreak: BreakRow = {
    ...createBreak(),
    time_entry_session_id: baseSession.id,
    start_time: '2026-01-02T09:15:00.000Z',
    end_time: '2026-01-02T09:45:00.000Z',
    duration_minutes: 30,
    source: 'employee'
  };
  let storedComparison: Record<string, unknown> | null = null;

  const client = {
    async query(sql: string, params: unknown[] = []): Promise<QueryResult> {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: 0, rows: [] };
      if (sql.includes('FROM public.time_entry_days')) {
        return { rowCount: 1, rows: [{ ...baseDay }] };
      }
      if (sql.includes('DELETE FROM public.time_entry_sessions')) {
        sessionRows = [];
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes('FROM public.time_entry_sessions')) {
        return { rowCount: sessionRows.length, rows: sessionRows.map((row) => ({ ...row })) };
      }
      if (sql.includes('FROM public.time_entry_breaks') && sql.includes('ANY($1::int[])')) {
        return { rowCount: 1, rows: [{ ...timedBreak }] };
      }
      if (sql.includes('UPDATE public.time_entry_days')) {
        storedComparison = params[0] as Record<string, unknown>;
        return {
          rowCount: 1,
          rows: [{ ...baseDay, status: 'pending', comparison: storedComparison, updated_at: now }]
        };
      }
      if (sql.includes('INSERT INTO public.time_entry_sessions')) {
        sessionRows.push({
          id: 200,
          entry_day_id: baseDay.id,
          start_at: String(params[3]),
          end_at: String(params[4]),
          sort_order: Number(params[5])
        });
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('INSERT INTO public.time_entry_audit')) {
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {
      return undefined;
    }
  };

  setPostgresPoolOverride({ connect: async () => client } as never);
  const app = createApp({ accountType: 'ADMIN', accountId: 100, franchiseId: 77, displayName: 'Admin User' });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/time-entry/admin/day/${baseDay.id}?franchiseId=77`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reason: 'Corrected session start',
        sessions: [
          {
            startAt: '2026-01-02T10:00:00.000Z',
            endAt: '2026-01-02T17:00:00.000Z'
          }
        ]
      })
    });

    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      day: {
        comparison: {
          version: number;
          scheduled: { coveredMinutes: number; deltaMinutes: number };
          breaks: { outsideSessionMinutes: number };
        };
        breakSummary: {
          unpaidBreakMinutes: number;
          paidMinutes: number;
          outsideSessionBreakMinutes: number;
        };
      };
    };

    assert.equal(body.day.comparison.version, 2);
    assert.equal(body.day.comparison.scheduled.coveredMinutes, 420);
    assert.equal(body.day.comparison.scheduled.deltaMinutes, -60);
    assert.equal(body.day.comparison.breaks.outsideSessionMinutes, 30);
    assert.equal(body.day.breakSummary.unpaidBreakMinutes, 0);
    assert.equal(body.day.breakSummary.paidMinutes, 420);
    assert.equal(body.day.breakSummary.outsideSessionBreakMinutes, 30);
  });

  assert.equal((storedComparison as { version?: number } | null)?.version, 2);
});
