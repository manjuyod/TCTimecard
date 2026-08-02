import assert from 'node:assert/strict';
import test from 'node:test';
import {
  finalizeClockOutInTransaction,
  type ClockOutAuditEntry,
  type ClockOutTransaction,
  type TimeEntryDayRow
} from '../services/clockOutFinalization';
import type { ScheduleSnapshotV1 } from '../services/scheduleSnapshot';
import type { TimeEntryBreakRow } from '../services/timeEntryBreaks';

const detectedAt = '2026-08-01T03:01:00.000Z';
const target = '2026-07-31T20:00:00.000-07:00';
const snapshot: ScheduleSnapshotV1 = {
  version: 1, franchiseId: 77, tutorId: 20, workDate: '2026-07-31',
  timezone: 'America/Los_Angeles', slotMinutes: 60,
  entries: [{ timeId: 1, timeLabel: '3:00 PM - 8:00 PM' }],
  intervals: [{ startAt: '2026-07-31T15:00:00.000-07:00', endAt: target }],
  issuedAt: '2026-08-01T02:50:00.000Z'
};

const day: TimeEntryDayRow = {
  id: 100, franchiseid: 77, tutorid: 20, work_date: '2026-07-31',
  timezone: 'America/Los_Angeles', status: 'draft', clock_state: 1,
  schedule_snapshot: null, comparison: null, submitted_at: null,
  decided_by: null, decided_at: null, decision_reason: null,
  created_at: '2026-07-31T22:00:00.000Z', updated_at: '2026-07-31T22:00:00.000Z'
};

const activeBreak: TimeEntryBreakRow = {
  id: 9, entry_day_id: 100, time_entry_session_id: 5,
  franchiseid: 77, tutorid: 20, break_type: 'lunch',
  pay_treatment: 'unpaid', start_time: '2026-07-31T19:45:00.000-07:00',
  end_time: null, duration_minutes: 0, source: 'employee', status: 'active',
  note: null, created_at: detectedAt, updated_at: detectedAt
};

const makeHarness = (options: { sessionStart?: string; loseCloseRace?: boolean } = {}) => {
  const state = {
    sessionStart: options.sessionStart ?? '2026-07-31T15:00:00.000-07:00',
    sessionEndAt: null as string | null,
    breakEndAt: null as string | null,
    dayStatus: 'draft' as TimeEntryDayRow['status'],
    clockState: 1,
    savedTimezone: null as string | null,
    auditEntries: [] as ClockOutAuditEntry[],
    auditMetadata: [] as Array<Record<string, unknown>>
  };
  const transaction: ClockOutTransaction = {
    resolveTargetEndAt: async (explicit) => explicit ?? detectedAt,
    closeActiveBreak: async (row, endAt) => {
      state.breakEndAt = endAt;
      return { ...row, end_time: endAt, duration_minutes: 15, status: 'completed' };
    },
    closeSession: async (sessionId, endAt) => {
      if (options.loseCloseRace) return null;
      state.sessionEndAt = endAt;
      return { id: sessionId, startAt: state.sessionStart, endAt };
    },
    invalidateDay: async (row) => ({ ...row, status: 'pending' }),
    setClockStateOut: async (row) => {
      state.clockState = 0;
      return { ...row, clock_state: 0 };
    },
    appendAudit: async (entry) => {
      state.auditEntries.push(entry);
      state.auditMetadata.push(entry.metadata ?? {});
    },
    listClosedSessions: async () => state.sessionEndAt ? [{
      startAt: state.sessionStart, endAt: state.sessionEndAt
    }] : [],
    listBreaks: async () => state.breakEndAt ? [{
      ...activeBreak, end_time: state.breakEndAt,
      duration_minutes: 15, status: 'completed'
    }] : [],
    saveSubmission: async (row, decision) => {
      state.dayStatus = decision.nextStatus;
      state.savedTimezone = row.timezone;
      return { ...row, status: decision.nextStatus, clock_state: 0,
        schedule_snapshot: snapshot, comparison: decision.comparison };
    }
  };
  return { state, transaction };
};

test('automatic finalization stores the exact scheduled target and closes an active break', async () => {
  const harness = makeHarness();
  const result = await finalizeClockOutInTransaction({
    transaction: harness.transaction, day,
    openSession: { id: 5, start_at: harness.state.sessionStart },
    activeBreak, targetEndAt: target, detectedAt, snapshot,
    source: 'auto_clock_out',
    actor: { accountType: 'SYSTEM', accountId: null },
    activeBreakPolicy: 'close'
  });
  assert.equal(result.kind, 'finalized');
  assert.equal(harness.state.sessionEndAt, target);
  assert.equal(harness.state.breakEndAt, target);
  assert.equal(harness.state.dayStatus, 'pending');
  assert.equal(harness.state.clockState, 0);
  assert.equal(harness.state.auditMetadata.some((value) => value.source === 'auto_clock_out'), true);
  assert.equal(
    harness.state.auditEntries.some((entry) =>
      entry.action === 'submitted' && entry.actorAccountType === 'SYSTEM' && entry.actorAccountId === null
    ),
    true
  );
});

test('manual finalization rejects an active break without mutation', async () => {
  const harness = makeHarness();
  const result = await finalizeClockOutInTransaction({
    transaction: harness.transaction, day,
    openSession: { id: 5, start_at: harness.state.sessionStart },
    activeBreak, snapshot, source: 'clock_out', detectedAt,
    actor: { accountType: 'TUTOR', accountId: 20 }, activeBreakPolicy: 'reject'
  });
  assert.deepEqual(result, { kind: 'active_break' });
  assert.equal(harness.state.sessionEndAt, null);
});

test('target at or before session start is skipped without mutation', async () => {
  const harness = makeHarness({ sessionStart: '2026-07-31T20:01:00.000-07:00' });
  const result = await finalizeClockOutInTransaction({
    transaction: harness.transaction, day,
    openSession: { id: 5, start_at: harness.state.sessionStart },
    activeBreak: null, targetEndAt: target, detectedAt, snapshot,
    source: 'auto_clock_out', actor: { accountType: 'SYSTEM', accountId: null },
    activeBreakPolicy: 'close'
  });
  assert.deepEqual(result, { kind: 'invalid_end' });
  assert.equal(harness.state.sessionEndAt, null);
});

test('conditional session close losing a race returns already_closed', async () => {
  const harness = makeHarness({ loseCloseRace: true });
  const result = await finalizeClockOutInTransaction({
    transaction: harness.transaction, day,
    openSession: { id: 5, start_at: harness.state.sessionStart },
    activeBreak: null, targetEndAt: target, detectedAt, snapshot,
    source: 'auto_clock_out', actor: { accountType: 'SYSTEM', accountId: null },
    activeBreakPolicy: 'close'
  });
  assert.deepEqual(result, { kind: 'already_closed' });
});

test('time before the scheduled block sends automatic completion to pending', async () => {
  const harness = makeHarness({ sessionStart: '2026-07-31T14:45:00.000-07:00' });
  const result = await finalizeClockOutInTransaction({
    transaction: harness.transaction, day,
    openSession: { id: 5, start_at: harness.state.sessionStart },
    activeBreak: null, targetEndAt: target, detectedAt, snapshot,
    source: 'auto_clock_out', actor: { accountType: 'SYSTEM', accountId: null },
    activeBreakPolicy: 'close'
  });
  assert.equal(result.kind, 'finalized');
  assert.equal(harness.state.dayStatus, 'pending');
});

test('active break at the target is invalid and leaves the session open', async () => {
  const harness = makeHarness();
  const result = await finalizeClockOutInTransaction({
    transaction: harness.transaction, day,
    openSession: { id: 5, start_at: harness.state.sessionStart },
    activeBreak: { ...activeBreak, start_time: target },
    targetEndAt: target, detectedAt, snapshot,
    source: 'auto_clock_out', actor: { accountType: 'SYSTEM', accountId: null },
    activeBreakPolicy: 'close'
  });
  assert.deepEqual(result, { kind: 'invalid_break' });
  assert.equal(harness.state.sessionEndAt, null);
  assert.equal(harness.state.breakEndAt, null);
});

test('lost session-close race does not partially close an automatic break', async () => {
  const harness = makeHarness({ loseCloseRace: true });
  const result = await finalizeClockOutInTransaction({
    transaction: harness.transaction, day,
    openSession: { id: 5, start_at: harness.state.sessionStart },
    activeBreak, targetEndAt: target, detectedAt, snapshot,
    source: 'auto_clock_out', actor: { accountType: 'SYSTEM', accountId: null },
    activeBreakPolicy: 'close'
  });
  assert.deepEqual(result, { kind: 'already_closed' });
  assert.equal(harness.state.breakEndAt, null);
});

test('automatic break must belong to the locked open session', async () => {
  const harness = makeHarness();
  const result = await finalizeClockOutInTransaction({
    transaction: harness.transaction, day,
    openSession: { id: 5, start_at: harness.state.sessionStart },
    activeBreak: { ...activeBreak, time_entry_session_id: 6 },
    targetEndAt: target, detectedAt, snapshot,
    source: 'auto_clock_out', actor: { accountType: 'SYSTEM', accountId: null },
    activeBreakPolicy: 'close'
  });
  assert.deepEqual(result, { kind: 'invalid_break' });
  assert.equal(harness.state.sessionEndAt, null);
  assert.equal(harness.state.breakEndAt, null);
});

test('automatic break must start within the locked session', async () => {
  const harness = makeHarness();
  const result = await finalizeClockOutInTransaction({
    transaction: harness.transaction, day,
    openSession: { id: 5, start_at: harness.state.sessionStart },
    activeBreak: { ...activeBreak, start_time: '2026-07-31T14:59:00.000-07:00' },
    targetEndAt: target, detectedAt, snapshot,
    source: 'auto_clock_out', actor: { accountType: 'SYSTEM', accountId: null },
    activeBreakPolicy: 'close'
  });
  assert.deepEqual(result, { kind: 'invalid_break' });
  assert.equal(harness.state.sessionEndAt, null);
  assert.equal(harness.state.breakEndAt, null);
});

test('manual finalization keeps the resolved day timezone when the snapshot differs', async () => {
  const harness = makeHarness();
  const result = await finalizeClockOutInTransaction({
    transaction: harness.transaction,
    day: { ...day, timezone: 'America/Chicago' },
    openSession: { id: 5, start_at: harness.state.sessionStart },
    activeBreak: null, targetEndAt: target, detectedAt, snapshot,
    source: 'clock_out', actor: { accountType: 'TUTOR', accountId: 20 },
    activeBreakPolicy: 'reject'
  });
  assert.equal(result.kind, 'finalized');
  assert.equal(harness.state.savedTimezone, 'America/Chicago');
});

test('automatic finalization persists the validated snapshot timezone', async () => {
  const harness = makeHarness();
  const result = await finalizeClockOutInTransaction({
    transaction: harness.transaction,
    day: { ...day, timezone: 'America/Chicago' },
    openSession: { id: 5, start_at: harness.state.sessionStart },
    activeBreak: null, targetEndAt: target, detectedAt, snapshot,
    source: 'auto_clock_out', actor: { accountType: 'SYSTEM', accountId: null },
    activeBreakPolicy: 'close'
  });
  assert.equal(result.kind, 'finalized');
  assert.equal(harness.state.savedTimezone, 'America/Los_Angeles');
});

test('invalidation audit preserves tutor actor and status metadata', async () => {
  const harness = makeHarness();
  const result = await finalizeClockOutInTransaction({
    transaction: harness.transaction,
    day: { ...day, status: 'approved' },
    openSession: { id: 5, start_at: harness.state.sessionStart },
    activeBreak: null, targetEndAt: target, detectedAt, snapshot,
    source: 'clock_out', actor: { accountType: 'TUTOR', accountId: 20 },
    activeBreakPolicy: 'reject'
  });
  assert.equal(result.kind, 'finalized');
  const invalidated = harness.state.auditEntries.find((entry) => entry.action === 'invalidated');
  assert.equal(invalidated?.actorAccountType, 'TUTOR');
  assert.equal(invalidated?.actorAccountId, 20);
  assert.equal(invalidated?.previousStatus, 'approved');
  assert.equal(invalidated?.newStatus, 'pending');
  assert.equal(invalidated?.metadata?.reason, 'clock_out');
});
