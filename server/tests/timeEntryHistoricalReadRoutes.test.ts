import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { setPostgresPoolOverride } from '../db/postgres';
import timeEntryRoutes from '../routes/timeEntry';

afterEach(() => {
  setPostgresPoolOverride(undefined);
});

const createTutorApp = () => {
  const now = new Date().toISOString();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as {
      session: { auth: Record<string, unknown>; save: (callback?: (err?: Error) => void) => void };
    }).session = {
      auth: {
        accountType: 'TUTOR',
        accountId: 42,
        franchiseId: 7,
        displayName: 'Historical Tutor',
        createdAt: now,
        lastSeenAt: now
      },
      save: (callback) => callback?.()
    };
    next();
  });
  app.use('/api', timeEntryRoutes);
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
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
};

test('historical reads recompute V2 without changing stored approval decisions', async () => {
  const writes: string[] = [];
  const workDate = '2026-01-02';
  const pool = {
    async query(sqlText: string) {
      if (/^\s*(UPDATE|INSERT|DELETE)/i.test(sqlText)) writes.push(sqlText);

      if (sqlText.includes('FROM public.time_entry_days')) {
        return {
          rowCount: 1,
          rows: [
            {
              id: 44,
              franchiseid: 7,
              tutorid: 42,
              work_date: workDate,
              timezone: 'UTC',
              status: 'approved',
              schedule_snapshot: {
                version: 1,
                franchiseId: 7,
                tutorId: 42,
                workDate,
                timezone: 'UTC',
                slotMinutes: 60,
                entries: [],
                intervals: [
                  { startAt: '2026-01-02T09:00:00.000Z', endAt: '2026-01-02T17:00:00.000Z' }
                ]
              },
              comparison: {
                version: 1,
                matches: false,
                manual: { totalMinutes: 450 },
                scheduled: { totalMinutes: 480 }
              },
              submitted_at: '2026-01-02T17:05:00.000Z',
              decided_by: 99,
              decided_at: '2026-01-02T18:00:00.000Z',
              decision_reason: 'Previously approved by manager',
              created_at: '2026-01-02T09:00:00.000Z',
              updated_at: '2026-01-02T18:00:00.000Z'
            }
          ]
        };
      }

      if (sqlText.includes('FROM public.time_entry_sessions')) {
        return {
          rowCount: 1,
          rows: [
            {
              id: 10,
              entry_day_id: 44,
              start_at: '2026-01-02T09:00:00.000Z',
              end_at: '2026-01-02T17:00:00.000Z',
              sort_order: 0
            }
          ]
        };
      }

      if (sqlText.includes('FROM public.time_entry_breaks')) {
        return {
          rowCount: 1,
          rows: [
            {
              id: 20,
              entry_day_id: 44,
              time_entry_session_id: null,
              franchiseid: 7,
              tutorid: 42,
              break_type: 'lunch',
              pay_treatment: 'unpaid',
              start_time: '2026-01-02T08:00:00.000Z',
              end_time: '2026-01-02T08:30:00.000Z',
              duration_minutes: 30,
              source: 'manager',
              status: 'completed',
              note: null,
              created_at: '2026-01-02T18:00:00.000Z',
              updated_at: '2026-01-02T18:00:00.000Z'
            }
          ]
        };
      }

      throw new Error(`Unexpected query: ${sqlText}`);
    }
  };
  setPostgresPoolOverride(pool as never);

  await withServer(createTutorApp(), async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/time-entry/me?start=${workDate}&end=${workDate}`
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      days: Array<{
        status: string;
        decidedBy: number | null;
        decidedAt: string | null;
        decisionReason: string | null;
        comparison: {
          version: number;
          matches: boolean;
          scheduled: { coveredMinutes: number; deltaMinutes: number };
          extra: { paidMinutes: number };
          breaks: { outsideSessionMinutes: number };
        };
        breakSummary: {
          unpaidBreakMinutes: number;
          paidMinutes: number;
          outsideSessionBreakMinutes: number;
        };
      }>;
    };

    const day = body.days[0];
    assert.equal(day.status, 'approved');
    assert.equal(day.decidedBy, 99);
    assert.equal(day.decisionReason, 'Previously approved by manager');
    assert.equal(day.comparison.version, 2);
    assert.equal(day.comparison.matches, true);
    assert.equal(day.comparison.scheduled.coveredMinutes, 480);
    assert.equal(day.comparison.scheduled.deltaMinutes, 0);
    assert.equal(day.comparison.extra.paidMinutes, 0);
    assert.equal(day.comparison.breaks.outsideSessionMinutes, 30);
    assert.equal(day.breakSummary.unpaidBreakMinutes, 0);
    assert.equal(day.breakSummary.paidMinutes, 480);
    assert.equal(day.breakSummary.outsideSessionBreakMinutes, 30);
  });

  assert.deepEqual(writes, []);
});
