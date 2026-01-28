import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveClockOutSubmission, shouldInvalidateClockDayStatus } from '../services/clockSubmission';
import { computeTimeEntryComparisonV1 } from '../services/timeEntryComparison';
import type { ScheduleSnapshotV1 } from '../services/scheduleSnapshot';

const baseSnapshot: ScheduleSnapshotV1 = {
  version: 1,
  franchiseId: 10,
  tutorId: 20,
  workDate: '2026-01-02',
  timezone: 'America/Chicago',
  slotMinutes: 60,
  entries: [{ timeId: 1, timeLabel: '9:00 AM - 10:00 AM' }],
  intervals: [{ startAt: '2026-01-02T09:00:00-06:00', endAt: '2026-01-02T10:00:00-06:00' }]
};

test('clock-out auto submission: out-of-schedule minutes -> pending with auto metadata', () => {
  const computed = computeTimeEntryComparisonV1({
    sessions: [{ startAt: '2026-01-02T09:00:00-06:00', endAt: '2026-01-02T10:30:00-06:00' }],
    snapshotIntervals: baseSnapshot.intervals
  });

  assert.equal(computed.ok, true);
  if (!computed.ok) return;

  const decision = resolveClockOutSubmission({
    snapshot: baseSnapshot,
    comparison: computed.comparison,
    workDate: baseSnapshot.workDate,
    timezone: baseSnapshot.timezone
  });

  assert.equal(decision.nextStatus, 'pending');
  assert.equal(decision.decisionReason, null);
  assert.equal(decision.audit.action, 'submitted');
  assert.equal(decision.audit.metadata.auto, true);
  assert.equal(decision.audit.metadata.reason, 'outside_schedule');
});

test('clock-out auto submission: exact match -> auto-approved', () => {
  const computed = computeTimeEntryComparisonV1({
    sessions: [{ startAt: '2026-01-02T09:00:00-06:00', endAt: '2026-01-02T10:00:00-06:00' }],
    snapshotIntervals: baseSnapshot.intervals
  });

  assert.equal(computed.ok, true);
  if (!computed.ok) return;

  const decision = resolveClockOutSubmission({
    snapshot: baseSnapshot,
    comparison: computed.comparison,
    workDate: baseSnapshot.workDate,
    timezone: baseSnapshot.timezone
  });

  assert.equal(decision.nextStatus, 'approved');
  assert.equal(decision.audit.action, 'auto_approved');
  assert.ok(decision.decidedAt);
});

test('clock-out invalidation helper: approved/denied should be invalidated', () => {
  assert.equal(shouldInvalidateClockDayStatus('approved'), true);
  assert.equal(shouldInvalidateClockDayStatus('denied'), true);
  assert.equal(shouldInvalidateClockDayStatus('pending'), false);
  assert.equal(shouldInvalidateClockDayStatus('draft'), false);
});
