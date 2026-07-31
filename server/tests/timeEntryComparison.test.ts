import test from 'node:test';
import assert from 'node:assert/strict';
import { computeTimeEntryComparisonV2 } from '../services/timeEntryComparison';

test('computeTimeEntryComparisonV2: exposes coverage, payable extra, and break placement', () => {
  const result = computeTimeEntryComparisonV2({
    sessions: [{ startAt: '2026-01-01T09:00:00-06:00', endAt: '2026-01-01T17:00:00-06:00' }],
    breaks: [
      {
        payTreatment: 'unpaid',
        status: 'completed',
        startTime: '2026-01-01T11:45:00-06:00',
        endTime: '2026-01-01T12:15:00-06:00',
        durationMinutes: 30
      }
    ],
    snapshotIntervals: [
      { startAt: '2026-01-01T09:00:00-06:00', endAt: '2026-01-01T12:00:00-06:00' },
      { startAt: '2026-01-01T13:00:00-06:00', endAt: '2026-01-01T17:00:00-06:00' }
    ],
    computedAt: '2026-01-02T00:00:00.000Z'
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.matches, false);
  assert.equal(result.comparison.version, 2);
  assert.equal(result.comparison.computedAt, '2026-01-02T00:00:00.000Z');
  assert.equal(result.comparison.manual.grossMinutes, 480);
  assert.equal(result.comparison.manual.unpaidBreakMinutes, 30);
  assert.equal(result.comparison.manual.paidMinutes, 450);
  assert.equal(result.comparison.manual.totalMinutes, 450);
  assert.deepEqual(result.comparison.scheduled, {
    union: [
      { startAt: '2026-01-01T15:00:00.000Z', endAt: '2026-01-01T18:00:00.000Z' },
      { startAt: '2026-01-01T19:00:00.000Z', endAt: '2026-01-01T23:00:00.000Z' }
    ],
    totalMinutes: 420,
    coveredMinutes: 405,
    deficitMinutes: 15,
    deltaMinutes: -15
  });
  assert.deepEqual(result.comparison.extra, { paidMinutes: 45 });
  assert.deepEqual(result.comparison.breaks, {
    scheduledOverlapMinutes: 15,
    outsideScheduleMinutes: 15,
    outsideSessionMinutes: 0,
    unpositionedMinutes: 0
  });
});

test('computeTimeEntryComparisonV2: keeps raw-session exactMatch as a separate diagnostic', () => {
  const result = computeTimeEntryComparisonV2({
    sessions: [{ startAt: '2026-01-01T09:00:00-06:00', endAt: '2026-01-01T17:00:00-06:00' }],
    breaks: [
      {
        payTreatment: 'paid',
        status: 'completed',
        startTime: '2026-01-01T10:00:00-06:00',
        endTime: '2026-01-01T10:15:00-06:00',
        durationMinutes: 15
      }
    ],
    snapshotIntervals: [{ startAt: '2026-01-01T09:00:00-06:00', endAt: '2026-01-01T17:00:00-06:00' }]
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.comparison.exactMatch, true);
  assert.equal(result.comparison.matches, false);
  assert.equal(result.comparison.manual.paidMinutes, 480);
  assert.equal(result.comparison.scheduled.coveredMinutes, 465);
  assert.equal(result.comparison.extra.paidMinutes, 0);
});

test('computeTimeEntryComparisonV2: duration-only breaks warn without changing a valid match', () => {
  const result = computeTimeEntryComparisonV2({
    sessions: [{ startAt: '2026-01-01T09:00:00-06:00', endAt: '2026-01-01T17:00:00-06:00' }],
    breaks: [
      {
        payTreatment: 'unpaid',
        status: 'completed',
        startTime: null,
        endTime: null,
        durationMinutes: 30
      }
    ],
    snapshotIntervals: [{ startAt: '2026-01-01T09:00:00-06:00', endAt: '2026-01-01T17:00:00-06:00' }]
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.matches, true);
  assert.equal(result.comparison.manual.unpaidBreakMinutes, 0);
  assert.equal(result.comparison.breaks.unpositionedMinutes, 30);
});

test('computeTimeEntryComparisonV2: rejects non-minute-aligned sessions', () => {
  const result = computeTimeEntryComparisonV2({
    sessions: [{ startAt: '2026-01-01T09:00:30-06:00', endAt: '2026-01-01T10:00:00-06:00' }],
    snapshotIntervals: [{ startAt: '2026-01-01T09:00:00-06:00', endAt: '2026-01-01T10:00:00-06:00' }]
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /minute/i);
});
