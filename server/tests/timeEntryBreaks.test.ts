import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeBreakMinuteTotals,
  computeDurationMinutes,
  getDefaultPayTreatment,
  validateBreakWindow,
  type TimeEntryBreakForTotals
} from '../services/timeEntryBreaks';

const baseSession = {
  id: 11,
  startAt: '2026-01-02T09:00:00.000Z',
  endAt: '2026-01-02T17:30:00.000Z'
};

test('computeBreakMinuteTotals: no breaks leaves all break totals at zero', () => {
  assert.deepEqual(computeBreakMinuteTotals([]), {
    paidBreakMinutes: 0,
    unpaidBreakMinutes: 0
  });
});

test('computeBreakMinuteTotals: paid breaks are tracked but not unpaid', () => {
  const breaks: TimeEntryBreakForTotals[] = [
    { payTreatment: 'paid', status: 'completed', durationMinutes: 15 },
    { payTreatment: 'unpaid', status: 'completed', durationMinutes: 30 },
    { payTreatment: 'unpaid', status: 'active', durationMinutes: 10 },
    { payTreatment: 'unpaid', status: 'voided', durationMinutes: 45 }
  ];

  assert.deepEqual(computeBreakMinuteTotals(breaks), {
    paidBreakMinutes: 15,
    unpaidBreakMinutes: 30
  });
});

test('getDefaultPayTreatment: break type defaults follow policy', () => {
  assert.equal(getDefaultPayTreatment('lunch'), 'unpaid');
  assert.equal(getDefaultPayTreatment('rest_break'), 'paid');
  assert.equal(getDefaultPayTreatment('personal'), 'unpaid');
  assert.equal(getDefaultPayTreatment('training'), 'paid');
  assert.equal(getDefaultPayTreatment('travel'), 'paid');
  assert.equal(getDefaultPayTreatment('other'), 'unpaid');
  assert.equal(getDefaultPayTreatment('lunch', { lunch: 'paid', other: 'paid' }), 'paid');
  assert.equal(getDefaultPayTreatment('other', { lunch: 'paid', other: 'paid' }), 'paid');
});

test('computeDurationMinutes: derives server-side duration from start/end', () => {
  assert.equal(
    computeDurationMinutes('2026-01-02T12:00:00.000Z', '2026-01-02T12:30:00.000Z'),
    30
  );
});

test('validateBreakWindow: rejects breaks outside parent session', () => {
  const before = validateBreakWindow({
    session: baseSession,
    startTime: '2026-01-02T08:59:00.000Z',
    endTime: '2026-01-02T09:15:00.000Z',
    existingBreaks: []
  });
  assert.equal(before.ok, false);
  if (!before.ok) assert.match(before.error, /within/i);

  const after = validateBreakWindow({
    session: baseSession,
    startTime: '2026-01-02T17:15:00.000Z',
    endTime: '2026-01-02T17:31:00.000Z',
    existingBreaks: []
  });
  assert.equal(after.ok, false);
  if (!after.ok) assert.match(after.error, /within/i);
});

test('validateBreakWindow: rejects overlapping breaks for same shift', () => {
  const result = validateBreakWindow({
    session: baseSession,
    startTime: '2026-01-02T12:15:00.000Z',
    endTime: '2026-01-02T12:45:00.000Z',
    existingBreaks: [
      {
        id: 90,
        timeEntrySessionId: baseSession.id,
        startTime: '2026-01-02T12:00:00.000Z',
        endTime: '2026-01-02T12:30:00.000Z',
        status: 'completed'
      }
    ]
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /overlap/i);
});
