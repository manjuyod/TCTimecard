import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTimeEntryComparison } from '../src/lib/timeEntryComparison';

test('parseTimeEntryComparison reads the V2 coverage and break-placement contract', () => {
  const parsed = parseTimeEntryComparison({
    version: 2,
    matches: false,
    manual: { totalMinutes: 450, paidMinutes: 450 },
    scheduled: {
      totalMinutes: 420,
      coveredMinutes: 405,
      deficitMinutes: 15,
      deltaMinutes: -15
    },
    extra: { paidMinutes: 45 },
    breaks: {
      scheduledOverlapMinutes: 15,
      outsideScheduleMinutes: 15,
      outsideSessionMinutes: 20,
      unpositionedMinutes: 30
    }
  });

  assert.deepEqual(parsed, {
    version: 2,
    scheduledMinutes: 420,
    coveredMinutes: 405,
    deltaMinutes: -15,
    payableExtraMinutes: 45,
    matches: false,
    scheduledBreakOverlapMinutes: 15,
    outsideSessionMinutes: 20,
    unpositionedMinutes: 30
  });
});

test('parseTimeEntryComparison retains V1 parsing as a fallback', () => {
  const parsed = parseTimeEntryComparison({
    version: 1,
    matches: false,
    manual: { totalMinutes: 480 },
    scheduled: { totalMinutes: 480 },
    diffs: {
      manualOnly: [{ startAt: '2026-01-01T23:00:00.000Z', endAt: '2026-01-02T00:00:00.000Z' }],
      scheduledOnly: [{ startAt: '2026-01-01T15:00:00.000Z', endAt: '2026-01-01T16:00:00.000Z' }]
    }
  });

  assert.deepEqual(parsed, {
    version: 1,
    scheduledMinutes: 480,
    coveredMinutes: 420,
    deltaMinutes: -60,
    payableExtraMinutes: 60,
    matches: false,
    scheduledBreakOverlapMinutes: 0,
    outsideSessionMinutes: 0,
    unpositionedMinutes: 0
  });
});

test('V1 fallback does not treat gross manual-only time as payable extra after an unpaid offset', () => {
  const parsed = parseTimeEntryComparison({
    version: 1,
    matches: true,
    manual: { totalMinutes: 480 },
    scheduled: { totalMinutes: 480 },
    diffs: {
      manualOnly: [{ startAt: '2026-01-01T23:00:00.000Z', endAt: '2026-01-01T23:30:00.000Z' }],
      scheduledOnly: []
    }
  });

  assert.equal(parsed?.coveredMinutes, 480);
  assert.equal(parsed?.payableExtraMinutes, 0);
  assert.equal(parsed?.matches, true);
});

test('parseTimeEntryComparison returns null for unusable comparison data', () => {
  assert.equal(parseTimeEntryComparison(null), null);
  assert.equal(parseTimeEntryComparison({ version: 2, matches: true }), null);
});
