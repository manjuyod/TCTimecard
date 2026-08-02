import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveClockInStartAt } from '../services/clockInTimeSnap';

const interval = (startAt: string, endAt = '2026-08-01T17:00:00.000Z') => ({ startAt, endAt });

test('Time Snap uses the inclusive eight-minute-early and two-minute-late boundaries', () => {
  const scheduled = interval('2026-08-01T16:00:00.000Z');
  const cases = [
    ['2026-08-01T15:51:45.000Z', '2026-08-01T15:51:00.000Z', false],
    ['2026-08-01T15:52:45.000Z', '2026-08-01T16:00:00.000Z', true],
    ['2026-08-01T16:00:45.000Z', '2026-08-01T16:00:00.000Z', true],
    ['2026-08-01T16:02:45.000Z', '2026-08-01T16:00:00.000Z', true],
    ['2026-08-01T16:03:45.000Z', '2026-08-01T16:03:00.000Z', false]
  ] as const;

  for (const [detectedAt, expectedStartAt, expectedApplied] of cases) {
    const result = resolveClockInStartAt({
      detectedAt: new Date(detectedAt),
      timezone: 'America/Los_Angeles',
      workDate: '2026-08-01',
      enabled: true,
      intervals: [scheduled]
    });

    assert.equal(result.detectedAt, detectedAt.replace(':45.000Z', ':00.000Z'));
    assert.equal(result.startAt, expectedStartAt);
    assert.equal(result.timeSnapApplied, expectedApplied);
    assert.equal(result.matchedScheduledStartAt, expectedApplied ? '2026-08-01T16:00:00.000Z' : null);
  }
});

test('Time Snap ignores disabled, non-hour, wrong-day, and malformed schedule starts', () => {
  const detectedAt = new Date('2026-08-01T15:52:45.000Z');
  const intervals = [
    interval('2026-08-01T15:30:00.000Z'),
    interval('2026-08-02T16:00:00.000Z', '2026-08-02T17:00:00.000Z'),
    interval('not-a-time')
  ];

  for (const enabled of [false, true]) {
    const result = resolveClockInStartAt({
      detectedAt,
      timezone: 'America/Los_Angeles',
      workDate: '2026-08-01',
      enabled,
      intervals
    });
    assert.equal(result.startAt, '2026-08-01T15:52:00.000Z');
    assert.equal(result.timeSnapApplied, false);
    assert.equal(result.matchedScheduledStartAt, null);
  }
});

test('Time Snap deterministically selects the closest eligible scheduled start', () => {
  const result = resolveClockInStartAt({
    detectedAt: new Date('2026-08-01T16:02:30.000Z'),
    timezone: 'America/Los_Angeles',
    workDate: '2026-08-01',
    enabled: true,
    intervals: [
      interval('2026-08-01T18:00:00.000Z', '2026-08-01T19:00:00.000Z'),
      interval('2026-08-01T16:00:00.000Z'),
      interval('2026-08-01T17:00:00.000Z', '2026-08-01T18:00:00.000Z')
    ]
  });

  assert.deepEqual(result, {
    detectedAt: '2026-08-01T16:02:00.000Z',
    startAt: '2026-08-01T16:00:00.000Z',
    timeSnapApplied: true,
    matchedScheduledStartAt: '2026-08-01T16:00:00.000Z'
  });
});
