import test from 'node:test';
import assert from 'node:assert/strict';
import { computeTimeEntryComparisonV1 } from '../services/timeEntryComparison';

test('computeTimeEntryComparisonV1: exact match with identical intervals', () => {
  const result = computeTimeEntryComparisonV1({
    sessions: [{ startAt: '2026-01-01T09:00:00-06:00', endAt: '2026-01-01T10:00:00-06:00' }],
    snapshotIntervals: [{ startAt: '2026-01-01T09:00:00-06:00', endAt: '2026-01-01T10:00:00-06:00' }]
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.matches, true);
  assert.equal(result.comparison.exactMatch, true);
  assert.equal(result.comparison.manual.totalMinutes, 60);
  assert.equal(result.comparison.scheduled.totalMinutes, 60);
  assert.deepEqual(result.comparison.diffs.manualOnly, []);
  assert.deepEqual(result.comparison.diffs.scheduledOnly, []);
});

test('computeTimeEntryComparisonV1: adjacent schedule blocks merge to a match', () => {
  const result = computeTimeEntryComparisonV1({
    sessions: [{ startAt: '2026-01-01T09:00:00-06:00', endAt: '2026-01-01T10:00:00-06:00' }],
    snapshotIntervals: [
      { startAt: '2026-01-01T09:00:00-06:00', endAt: '2026-01-01T09:30:00-06:00' },
      { startAt: '2026-01-01T09:30:00-06:00', endAt: '2026-01-01T10:00:00-06:00' }
    ]
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.matches, true);
  assert.deepEqual(result.comparison.diffs.manualOnly, []);
  assert.deepEqual(result.comparison.diffs.scheduledOnly, []);
});

test('computeTimeEntryComparisonV1: manual-only time produces diffs', () => {
  const result = computeTimeEntryComparisonV1({
    sessions: [
      { startAt: '2026-01-01T09:00:00-06:00', endAt: '2026-01-01T10:00:00-06:00' },
      { startAt: '2026-01-01T10:00:00-06:00', endAt: '2026-01-01T10:30:00-06:00' }
    ],
    snapshotIntervals: [{ startAt: '2026-01-01T09:00:00-06:00', endAt: '2026-01-01T10:00:00-06:00' }]
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.matches, false);
  assert.equal(result.comparison.manual.totalMinutes, 90);
  assert.equal(result.comparison.scheduled.totalMinutes, 60);
  assert.deepEqual(result.comparison.diffs.scheduledOnly, []);
  assert.deepEqual(result.comparison.diffs.manualOnly, [
    { startAt: '2026-01-01T16:00:00.000Z', endAt: '2026-01-01T16:30:00.000Z' }
  ]);
});

test('computeTimeEntryComparisonV1: rejects non-minute-aligned times', () => {
  const result = computeTimeEntryComparisonV1({
    sessions: [{ startAt: '2026-01-01T09:00:30-06:00', endAt: '2026-01-01T10:00:00-06:00' }],
    snapshotIntervals: [{ startAt: '2026-01-01T09:00:00-06:00', endAt: '2026-01-01T10:00:00-06:00' }]
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /minute/i);
});

