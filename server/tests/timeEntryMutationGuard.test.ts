import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import timeEntryRoutes from '../routes/timeEntry';
import { setPostgresPoolOverride } from '../db/postgres';
import {
  finalizeClockOutInTransaction,
  type ClockOutTransaction,
  type TimeEntryDayRow,
} from '../services/clockOutFinalization';
import { assertDayNotVoided, timeEntryMutationErrorHandler } from '../services/timeEntryMutationGuard';

afterEach(() => setPostgresPoolOverride(undefined));

test('production writer error middleware preserves the voided conflict code', async () => {
  const app = express();
  app.post('/api/guard', () => assertDayNotVoided({ status: 'voided' }));
  app.use('/api', timeEntryMutationErrorHandler);
  app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(500).json({ error: 'Unmapped' }));
  const server = app.listen(0);
  await new Promise<void>(resolve => server.on('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/guard`, { method: 'POST' });
    assert.equal(response.status, 409);
    assert.equal((await response.json() as { code: string }).code, 'INVALID_ENTRY_STATE');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('shared finalization refuses a voided day before using the transaction', async () => {
  const calls: string[] = [];
  const unexpected = async (): Promise<never> => {
    throw new Error('Unexpected transaction call');
  };
  const methods: ClockOutTransaction = {
    resolveTargetEndAt: unexpected,
    closeActiveBreak: unexpected,
    closeSession: unexpected,
    invalidateDay: unexpected,
    setClockStateOut: unexpected,
    appendAudit: unexpected,
    listClosedSessions: unexpected,
    listBreaks: unexpected,
    saveSubmission: unexpected,
  };
  const transaction = new Proxy(methods, {
    get(target, property, receiver) {
      calls.push(String(property));
      return Reflect.get(target, property, receiver);
    },
  });
  const day: TimeEntryDayRow = {
    id: 44,
    franchiseid: 77,
    tutorid: 88,
    work_date: '2026-09-15',
    timezone: 'America/Los_Angeles',
    status: 'voided',
    clock_state: 0,
    schedule_snapshot: null,
    comparison: null,
    submitted_at: '2026-09-16T01:00:00Z',
    decided_by: 100,
    decided_at: '2026-09-16T02:00:00Z',
    decision_reason: 'Voided erroneous entry',
    created_at: '2026-09-15T22:00:00Z',
    updated_at: '2026-09-16T02:00:00Z',
  };
  await assert.rejects(
    finalizeClockOutInTransaction({
      transaction,
      day,
      openSession: { id: 99, start_at: '2026-09-15T22:00:00Z' },
      activeBreak: null,
      targetEndAt: '2026-09-16T01:00:00Z',
      detectedAt: '2026-09-16T01:00:00Z',
      snapshot: {
        version: 1,
        franchiseId: 77,
        tutorId: 88,
        workDate: day.work_date,
        timezone: day.timezone,
        slotMinutes: 60,
        entries: [],
        intervals: [],
      },
      source: 'auto_clock_out',
      actor: { accountType: 'SYSTEM', accountId: null },
      activeBreakPolicy: 'close',
    }),
    (error: unknown) =>
      (error as { status?: number; code?: string }).status === 409 &&
      (error as { code?: string }).code === 'INVALID_ENTRY_STATE',
  );
  assert.deepEqual(
    calls,
    [],
    'A valid-shaped stale candidate cannot even access a transaction method',
  );
});
test('voided ordinary mutations reject while approved invalidation remains allowed', () => {
  assert.throws(() => assertDayNotVoided({ status: 'voided' }), {
    status: 409,
    code: 'INVALID_ENTRY_STATE',
  });
  assert.doesNotThrow(() => assertDayNotVoided({ status: 'approved' }));
});

test('legacy admin correction endpoints refuse immediate writes', async () => {
  let writes = 0;
  setPostgresPoolOverride({
    connect: async () => {
      writes++;
      throw new Error('Unexpected database write');
    },
  } as never);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const now = new Date().toISOString();
    (req as unknown as { session: unknown }).session = {
      auth: {
        accountType: 'ADMIN',
        accountId: 100,
        franchiseId: 77,
        createdAt: now,
        lastSeenAt: now,
      },
      save: (cb?: () => void) => cb?.(),
    };
    next();
  });
  app.use('/api', timeEntryRoutes);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.on('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/time-entry/admin/day/44`;
  try {
    for (const [method, suffix] of [
      ['PUT', ''],
      ['POST', '/breaks'],
      ['PUT', '/breaks/9'],
      ['POST', '/breaks/9/void'],
    ]) {
      const response = await fetch(`${base}${suffix}?franchiseId=77`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reason: 'Corrected entry',
          sessions: [],
          breakType: 'lunch',
          payTreatment: 'paid',
          durationMinutes: 30,
        }),
      });
      assert.equal(response.status, 409, `${method} ${suffix}`);
      assert.equal(
        ((await response.json()) as { code: string }).code,
        'ADMIN_CORRECTION_REQUIRED',
      );
    }
    assert.equal(writes, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
