import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acquireProductionLockAndCandidates,
  finalizeProductionCandidate,
  getFinalScheduleEnd,
  isAutoClockOutMinute,
  nextAutoClockOutTick,
  runAutoClockOutPass,
  runProductionPass,
  startAutoClockOutScheduler
} from '../services/autoClockOutScheduler';
import { scheduleCandidateKey, type ScheduleCandidate } from '../services/scheduleSource';
import type { ScheduleSnapshotV1 } from '../services/scheduleSnapshot';
import type { FinalizeClockOutInTransaction } from '../services/clockOutFinalization';

test('eligible minutes are only 00-09 and 50-59', () => {
  for (let minute = 0; minute < 60; minute += 1) {
    const actual = isAutoClockOutMinute(new Date(Date.UTC(2026, 6, 31, 12, minute)));
    assert.equal(actual, minute <= 9 || minute >= 50, `minute ${minute}`);
  }
});

test('next tick skips the middle of the hour', () => {
  assert.equal(
    nextAutoClockOutTick(new Date('2026-07-31T12:09:30.000Z')).toISOString(),
    '2026-07-31T12:50:00.000Z'
  );
  assert.equal(
    nextAutoClockOutTick(new Date('2026-07-31T12:59:30.000Z')).toISOString(),
    '2026-07-31T13:00:00.000Z'
  );
});

test('final schedule end selects the last split block', () => {
  const split: ScheduleSnapshotV1 = {
    version: 1, franchiseId: 77, tutorId: 5, workDate: '2026-07-31',
    timezone: 'America/Los_Angeles', slotMinutes: 60, entries: [],
    intervals: [
      { startAt: '2026-07-31T15:00:00.000-07:00', endAt: '2026-07-31T17:00:00.000-07:00' },
      { startAt: '2026-07-31T18:00:00.000-07:00', endAt: '2026-07-31T20:00:00.000-07:00' }
    ]
  };
  assert.equal(getFinalScheduleEnd(split),
    '2026-07-31T20:00:00.000-07:00');
  assert.equal(getFinalScheduleEnd({ ...split, intervals: [] }), null);
});

const makeCandidates = (count: number): Array<ScheduleCandidate & {
  dayId: number; openSessionId: number; startedAt: string;
}> => Array.from({ length: count }, (_, index) => ({
  dayId: index + 1000, franchiseId: 77, tutorId: index + 1,
  workDate: '2026-07-31', timezone: 'America/Los_Angeles',
  openSessionId: index + 2000, startedAt: '2026-07-31T15:00:00.000-07:00'
}));

const snapshotsEndingAtEightPm = (
  candidates: ScheduleCandidate[]
): Map<string, ScheduleSnapshotV1> => new Map(candidates.map((candidate) => [
  scheduleCandidateKey(candidate),
  {
    version: 1, franchiseId: candidate.franchiseId, tutorId: candidate.tutorId,
    workDate: candidate.workDate, timezone: candidate.timezone, slotMinutes: 60,
    entries: [], intervals: [{
      startAt: `${candidate.workDate}T15:00:00.000-07:00`,
      endAt: `${candidate.workDate}T20:00:00.000-07:00`
    }]
  }
]));

const createLock = () => ({
  client: {} as never,
  release: async () => undefined
});

test('no candidates avoids the MSSQL schedule call', async () => {
  let scheduleCalls = 0;
  const summary = await runAutoClockOutPass({
    now: new Date('2026-07-31T19:50:00.000Z'),
    acquireLockAndCandidates: async () => ({ lock: createLock(), candidates: [] }),
    fetchSchedules: async () => { scheduleCalls += 1; return new Map(); },
    acquireWorkerClient: async () => ({ client: {} as never, release: () => undefined }),
    finalize: async () => ({ kind: 'finalized' })
  });
  assert.equal(scheduleCalls, 0);
  assert.equal(summary.candidates, 0);
});

test('80 due tutors use one schedule batch and at most four PostgreSQL clients total', async () => {
  let scheduleCalls = 0;
  let activeClients = 1; // advisory-lock client
  let peakClients = 1;
  const candidates = makeCandidates(80);
  const summary = await runAutoClockOutPass({
    now: new Date('2026-08-01T03:01:00.000Z'),
    acquireLockAndCandidates: async () => ({ lock: createLock(), candidates }),
    fetchSchedules: async (requested) => {
      scheduleCalls += 1;
      assert.equal(requested.length, 80);
      return snapshotsEndingAtEightPm(requested);
    },
    acquireWorkerClient: async () => {
      activeClients += 1;
      peakClients = Math.max(peakClients, activeClients);
      return { client: {} as never, release: () => { activeClients -= 1; } };
    },
    finalize: async () => ({ kind: 'finalized' })
  });
  assert.equal(scheduleCalls, 1);
  assert.ok(peakClients <= 4);
  assert.equal(summary.succeeded, 80);
});

test('missing schedule and invalid target leave tutors unmodified', async () => {
  const candidates = makeCandidates(2);
  const invalid = snapshotsEndingAtEightPm([candidates[1]]);
  const invalidSnapshot = invalid.get(scheduleCandidateKey(candidates[1]));
  assert.ok(invalidSnapshot);
  invalidSnapshot.intervals = [{
    startAt: 'not-a-time', endAt: 'not-a-time'
  }];
  let finalizeCalls = 0;
  const summary = await runAutoClockOutPass({
    now: new Date('2026-08-01T03:01:00.000Z'),
    acquireLockAndCandidates: async () => ({ lock: createLock(), candidates }),
    fetchSchedules: async () => invalid,
    acquireWorkerClient: async () => ({ client: {} as never, release: () => undefined }),
    finalize: async () => { finalizeCalls += 1; return { kind: 'finalized' }; }
  });
  assert.equal(finalizeCalls, 0);
  assert.deepEqual(summary.skipped, {
    missingSchedule: 1,
    invalidSchedule: 1,
    settingDisabled: 0
  });
});

test('one tutor failure does not abort other due tutors', async () => {
  const candidates = makeCandidates(80);
  let call = 0;
  const summary = await runAutoClockOutPass({
    now: new Date('2026-08-01T03:01:00.000Z'),
    acquireLockAndCandidates: async () => ({ lock: createLock(), candidates }),
    fetchSchedules: async (requested) => snapshotsEndingAtEightPm(requested),
    acquireWorkerClient: async () => ({ client: {} as never, release: () => undefined }),
    finalize: async () => {
      call += 1;
      if (call === 1) throw new Error('controlled database failure');
      return { kind: 'finalized' };
    }
  });
  assert.equal(summary.succeeded, 79);
  assert.equal(summary.failed, 1);
});

test('failed advisory lock exits without candidate or schedule work', async () => {
  let scheduleCalls = 0;
  const summary = await runAutoClockOutPass({
    now: new Date('2026-07-31T19:50:00.000Z'),
    acquireLockAndCandidates: async () => null,
    fetchSchedules: async () => { scheduleCalls += 1; return new Map(); },
    acquireWorkerClient: async () => ({ client: {} as never, release: () => undefined }),
    finalize: async () => ({ kind: 'finalized' })
  });
  assert.equal(scheduleCalls, 0);
  assert.equal(summary.lockAcquired, false);
  assert.equal(summary.candidates, 0);
});

test('scheduler stop cancels the pending tick before it can run', async () => {
  let queued: (() => void) | null = null;
  let cleared = false;
  let passes = 0;
  const scheduler = startAutoClockOutScheduler({
    now: () => new Date('2026-07-31T12:10:00.000Z'),
    setTimer: (callback) => { queued = callback; return 1 as never; },
    clearTimer: () => { cleared = true; },
    runPass: async () => { passes += 1; },
    log: { info: () => undefined, error: () => undefined }
  });
  scheduler.stop();
  (queued as (() => void) | null)?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(cleared, true);
  assert.equal(passes, 0);
});

const productionCandidate = makeCandidates(1)[0];
const productionSnapshot = snapshotsEndingAtEightPm([productionCandidate]).get(
  scheduleCandidateKey(productionCandidate)
)!;

test('production lock reads candidates and unlocks on the same released client', async () => {
  const queries: string[] = [];
  const releaseArgs: unknown[] = [];
  let connects = 0;
  const client = {
    query: async (query: string) => {
      queries.push(query);
      if (query.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
      if (query.includes('pg_advisory_unlock')) return { rows: [{ unlocked: true }] };
      return { rows: [{
        day_id: '1000', franchiseid: '77', tutorid: '5',
        work_date: new Date('2026-07-31T00:00:00.000Z'),
        timezone: 'America/Los_Angeles', open_session_id: '2000',
        start_at: new Date('2026-07-31T22:00:00.000Z')
      }] };
    },
    release: (error?: unknown) => { releaseArgs.push(error); }
  };
  const acquired = await acquireProductionLockAndCandidates({
    connect: async () => { connects += 1; return client; }
  } as never);
  assert.ok(acquired);
  assert.deepEqual(acquired.candidates, [{
    dayId: 1000, franchiseId: 77, tutorId: 5, workDate: '2026-07-31',
    timezone: 'America/Los_Angeles', openSessionId: 2000,
    startedAt: '2026-07-31T22:00:00.000Z'
  }]);
  await acquired.lock.release();
  assert.equal(connects, 1);
  assert.equal(queries.filter((query) => query.includes('pg_advisory_unlock')).length, 1);
  assert.deepEqual(releaseArgs, [undefined]);
});

test('production candidate SQL requires enabled settings and local today plus yesterday', async () => {
  let candidateSql = '';
  const client = {
    query: async (query: string) => {
      if (query.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
      if (query.includes('pg_advisory_unlock')) return { rows: [{ unlocked: true }] };
      candidateSql = query;
      return { rows: [] };
    },
    release: () => undefined
  };
  const acquired = await acquireProductionLockAndCandidates({
    connect: async () => client
  } as never);
  assert.ok(acquired);
  await acquired.lock.release();
  assert.match(candidateSql, /auto_clock_out_enabled\s*=\s*TRUE/i);
  assert.match(candidateSql, /NOW\(\)\s+AT TIME ZONE settings\.timezone/i);
  assert.match(candidateSql, /::date\s*-\s*1/i);
});

test('failed advisory unlock discards the lock client', async () => {
  const releaseArgs: unknown[] = [];
  const client = {
    query: async (query: string) => {
      if (query.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
      if (query.includes('pg_advisory_unlock')) return { rows: [{ unlocked: false }] };
      return { rows: [] };
    },
    release: (error?: unknown) => { releaseArgs.push(error); }
  };
  const acquired = await acquireProductionLockAndCandidates({
    connect: async () => client
  } as never);
  assert.ok(acquired);
  await assert.rejects(acquired.lock.release(), /advisory_unlock_failed/);
  assert.equal(releaseArgs.length, 1);
  assert.ok(releaseArgs[0] instanceof Error);
});

test('production pool maxima one two and three cap total client acquisition', async () => {
  for (const max of [1, 2, 3]) {
    const candidates = makeCandidates(3);
    let connects = 0;
    const lockClient = {
      query: async (query: string) => {
        if (query.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
        if (query.includes('pg_advisory_unlock')) return { rows: [{ unlocked: true }] };
        return { rows: candidates.map((candidate) => ({
          day_id: candidate.dayId, franchiseid: candidate.franchiseId,
          tutorid: candidate.tutorId, work_date: candidate.workDate,
          timezone: candidate.timezone, open_session_id: candidate.openSessionId,
          start_at: candidate.startedAt
        })) };
      },
      release: () => undefined
    };
    const workerClient = { query: async () => ({ rows: [] }), release: () => undefined };
    const pool = {
      options: { max },
      connect: async () => {
        connects += 1;
        if (connects > max) throw new Error('unavailable pool client requested');
        return connects === 1 ? lockClient : workerClient;
      }
    };
    const summary = await runProductionPass({
      pool: pool as never,
      now: new Date('2026-08-01T03:01:00.000Z'),
      fetchSchedules: async (requested) => snapshotsEndingAtEightPm(requested),
      finalize: async () => ({ kind: 'finalized' })
    });
    assert.equal(connects, max, `pool max ${max}`);
    assert.equal(summary.succeeded, 3, `pool max ${max}`);
  }
});

type FakeQueryResult = { rows: unknown[]; rowCount?: number };

const createTransactionClient = (options: { enabled?: boolean } = {}) => {
  const queries: string[] = [];
  const rawDay = {
    id: '1000', franchiseid: '77', tutorid: '5',
    work_date: new Date('2026-07-31T00:00:00.000Z'),
    timezone: 'America/Los_Angeles', status: 'pending', clock_state: '1',
    schedule_snapshot: null, comparison: null,
    submitted_at: new Date('2026-08-01T03:00:00.000Z'), decided_by: '9',
    decided_at: new Date('2026-08-01T03:00:01.000Z'), decision_reason: null,
    created_at: new Date('2026-07-31T21:59:00.000Z'),
    updated_at: new Date('2026-08-01T03:00:02.000Z')
  };
  const rawBreak = {
    id: '3000', entry_day_id: '1000', time_entry_session_id: '2000',
    franchiseid: '77', tutorid: '5', break_type: 'lunch', pay_treatment: 'unpaid',
    start_time: new Date('2026-08-01T02:30:00.000Z'), end_time: null,
    duration_minutes: '0', source: 'employee', status: 'active', note: null,
    created_at: new Date('2026-08-01T02:30:00.000Z'),
    updated_at: new Date('2026-08-01T02:30:00.000Z')
  };
  const client = {
    query: async (query: string): Promise<FakeQueryResult> => {
      queries.push(query);
      if (query === 'BEGIN' || query === 'COMMIT' || query === 'ROLLBACK') return { rows: [] };
      if (query.includes('time_entry_days')) return { rows: [rawDay] };
      if (query.includes('franchise_payroll_settings')) {
        return { rows: [{ auto_clock_out_enabled: options.enabled ?? true }] };
      }
      if (query.includes('time_entry_sessions')) {
        return { rows: [{ id: '2000', start_at: new Date('2026-07-31T22:00:00.000Z') }] };
      }
      if (query.includes('time_entry_breaks')) return { rows: [rawBreak] };
      throw new Error(`unexpected query ${query}`);
    }
  };
  return { client: client as never, queries };
};

test('production transaction normalizes PostgreSQL runtime rows before finalization', async () => {
  let captured: Parameters<FinalizeClockOutInTransaction>[0] | undefined;
  const finalizer: FinalizeClockOutInTransaction = async (params) => {
    captured = params;
    return { kind: 'finalized', day: params.day, breaks: params.activeBreak ? [params.activeBreak] : [] };
  };
  const { client, queries } = createTransactionClient();
  const result = await finalizeProductionCandidate({
    client, candidate: productionCandidate, snapshot: productionSnapshot,
    targetEndAt: '2026-07-31T20:00:00.000-07:00',
    detectedAt: '2026-08-01T03:01:00.000Z'
  }, finalizer);
  assert.equal(result.kind, 'finalized');
  assert.ok(captured);
  assert.deepEqual({
    dayId: captured.day.id,
    franchiseId: captured.day.franchiseid,
    tutorId: captured.day.tutorid,
    workDate: captured.day.work_date,
    clockState: captured.day.clock_state,
    submittedAt: captured.day.submitted_at,
    decidedBy: captured.day.decided_by,
    createdAt: captured.day.created_at,
    sessionId: captured.openSession.id,
    sessionStart: captured.openSession.start_at,
    breakId: captured.activeBreak?.id,
    breakDayId: captured.activeBreak?.entry_day_id,
    breakSessionId: captured.activeBreak?.time_entry_session_id,
    breakDuration: captured.activeBreak?.duration_minutes,
    breakStart: captured.activeBreak?.start_time,
    breakCreatedAt: captured.activeBreak?.created_at
  }, {
    dayId: 1000, franchiseId: 77, tutorId: 5, workDate: '2026-07-31',
    clockState: 1, submittedAt: '2026-08-01T03:00:00.000Z', decidedBy: 9,
    createdAt: '2026-07-31T21:59:00.000Z', sessionId: 2000,
    sessionStart: '2026-07-31T22:00:00.000Z', breakId: 3000,
    breakDayId: 1000, breakSessionId: 2000, breakDuration: 0,
    breakStart: '2026-08-01T02:30:00.000Z',
    breakCreatedAt: '2026-08-01T02:30:00.000Z'
  });
  assert.equal(captured.targetEndAt, '2026-07-31T20:00:00.000-07:00');
  assert.equal(captured.detectedAt, '2026-08-01T03:01:00.000Z');
  assert.equal(captured.source, 'auto_clock_out');
  assert.deepEqual(captured.actor, { accountType: 'SYSTEM', accountId: null });
  assert.equal(captured.activeBreakPolicy, 'close');
  assert.deepEqual(queries.map((query) => query.trim().split(/\s+/).slice(0, 3).join(' ')), [
    'BEGIN', 'SELECT * FROM', 'SELECT auto_clock_out_enabled FROM',
    'SELECT id, start_at', 'SELECT * FROM', 'COMMIT'
  ]);
});

test('production transaction commits only finalized and rolls back every other outcome', async () => {
  for (const kind of ['already_closed', 'active_break', 'invalid_break', 'invalid_end'] as const) {
    const { client, queries } = createTransactionClient();
    const finalizer = (async () => ({ kind })) as FinalizeClockOutInTransaction;
    const result = await finalizeProductionCandidate({
      client, candidate: productionCandidate, snapshot: productionSnapshot,
      targetEndAt: '2026-07-31T20:00:00.000-07:00',
      detectedAt: '2026-08-01T03:01:00.000Z'
    }, finalizer);
    assert.equal(result.kind, kind);
    assert.equal(queries[queries.length - 1], 'ROLLBACK', kind);
    assert.equal(queries.includes('COMMIT'), false, kind);
  }

  const { client, queries } = createTransactionClient();
  await assert.rejects(finalizeProductionCandidate({
    client, candidate: productionCandidate, snapshot: productionSnapshot,
    targetEndAt: '2026-07-31T20:00:00.000-07:00',
    detectedAt: '2026-08-01T03:01:00.000Z'
  }, async () => { throw new Error('controlled finalizer failure'); }), /controlled finalizer failure/);
  assert.equal(queries[queries.length - 1], 'ROLLBACK');
  assert.equal(queries.includes('COMMIT'), false);
});

test('setting disable wins after day lock and rolls back before session work', async () => {
  const { client, queries } = createTransactionClient({ enabled: false });
  const result = await finalizeProductionCandidate({
    client, candidate: productionCandidate, snapshot: productionSnapshot,
    targetEndAt: '2026-07-31T20:00:00.000-07:00',
    detectedAt: '2026-08-01T03:01:00.000Z'
  }, async () => { throw new Error('finalizer must not run'); });
  assert.equal(result.kind, 'setting_disabled');
  assert.equal(queries[0], 'BEGIN');
  assert.match(queries[1], /time_entry_days[\s\S]*FOR UPDATE/);
  assert.match(queries[2], /franchise_payroll_settings[\s\S]*FOR UPDATE/);
  assert.equal(queries[3], 'ROLLBACK');
  assert.equal(queries.some((query) => query.includes('time_entry_sessions')), false);
});

test('scheduler stop during an in-flight pass prevents a later tick', async () => {
  const queued: Array<() => void> = [];
  let resolvePass: (() => void) | undefined;
  let passes = 0;
  const scheduler = startAutoClockOutScheduler({
    now: () => new Date('2026-07-31T12:10:00.000Z'),
    setTimer: (callback) => { queued.push(callback); return queued.length as never; },
    clearTimer: () => undefined,
    runPass: async () => {
      passes += 1;
      await new Promise<void>((resolve) => { resolvePass = resolve; });
    },
    log: { info: () => undefined, error: () => undefined }
  });
  queued[0]();
  scheduler.stop();
  resolvePass?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(passes, 1);
  assert.equal(queued.length, 1);
});
