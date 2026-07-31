import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { setMssqlPoolOverride } from '../db/mssql';
import {
  fetchLatestScheduleSnapshots,
  scheduleCandidateKey
} from '../services/scheduleSource';

afterEach(() => setMssqlPoolOverride(undefined));

test('80 active tutors are fetched in one batched MSSQL request', async () => {
  const queries: string[] = [];
  setMssqlPoolOverride({
    request: () => ({
      input() { return this; },
      async query(sql: string) {
        queries.push(sql);
        return { recordset: Array.from({ length: 80 }, (_, index) => ({
          FranchiseID: 77, TutorID: index + 1,
          WorkDate: new Date('2026-07-31T00:00:00Z'),
          TimeID: 1, TimeLabel: '3:00 PM - 4:00 PM'
        })) };
      }
    })
  } as never);

  const candidates = Array.from({ length: 80 }, (_, index) => ({
    franchiseId: 77, tutorId: index + 1, workDate: '2026-07-31',
    timezone: 'America/Los_Angeles'
  }));
  const snapshots = await fetchLatestScheduleSnapshots(
    candidates,
    new Date('2026-07-31T19:00:00Z')
  );

  assert.equal(queries.length, 1);
  assert.equal(snapshots.size, 80);
  assert.equal(
    snapshots.get(scheduleCandidateKey(candidates[0]))?.intervals[0]?.endAt,
    '2026-07-31T16:00:00.000-07:00'
  );
});

test('split blocks remain separate and expose the final end', async () => {
  setMssqlPoolOverride({
    request: () => ({
      input() { return this; },
      async query() {
        return { recordset: [
          { FranchiseID: 77, TutorID: 5, WorkDate: new Date('2026-07-31T00:00:00Z'),
            TimeID: 1, TimeLabel: '3:00 PM - 5:00 PM' },
          { FranchiseID: 77, TutorID: 5, WorkDate: new Date('2026-07-31T00:00:00Z'),
            TimeID: 2, TimeLabel: '6:00 PM - 8:00 PM' }
        ] };
      }
    })
  } as never);
  const candidate = {
    franchiseId: 77, tutorId: 5, workDate: '2026-07-31',
    timezone: 'America/Los_Angeles'
  };
  const snapshots = await fetchLatestScheduleSnapshots(
    [candidate],
    new Date('2026-07-31T19:00:00Z')
  );
  const snapshot = snapshots.get(scheduleCandidateKey(candidate));
  assert.ok(snapshot);
  assert.deepEqual(snapshot.intervals.map((entry) => entry.endAt), [
    '2026-07-31T17:00:00.000-07:00',
    '2026-07-31T20:00:00.000-07:00'
  ]);
});

test('malformed explicit ranges do not create authoritative intervals', async () => {
  setMssqlPoolOverride({
    request: () => ({
      input() { return this; },
      async query() {
        return { recordset: [
          { FranchiseID: 77, TutorID: 5, WorkDate: new Date('2026-07-31T00:00:00Z'),
            TimeID: 1, TimeLabel: '3:00 PM - nonsense' }
        ] };
      }
    })
  } as never);
  const candidate = {
    franchiseId: 77, tutorId: 5, workDate: '2026-07-31',
    timezone: 'America/Los_Angeles'
  };

  const snapshots = await fetchLatestScheduleSnapshots(
    [candidate],
    new Date('2026-07-31T19:00:00Z')
  );

  assert.deepEqual(snapshots.get(scheduleCandidateKey(candidate))?.intervals, []);
});
