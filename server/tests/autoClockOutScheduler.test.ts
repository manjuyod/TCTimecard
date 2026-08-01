import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getFinalScheduleEnd,
  isAutoClockOutMinute,
  nextAutoClockOutTick,
  runAutoClockOutPass,
  startAutoClockOutScheduler
} from '../services/autoClockOutScheduler';
import { scheduleCandidateKey, type ScheduleCandidate } from '../services/scheduleSource';
import type { ScheduleSnapshotV1 } from '../services/scheduleSnapshot';

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
