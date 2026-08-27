import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveClockInStartAt } from '../services/clockInTimeSnap';

const resolve = (detectedAt: string, enabled = true) => resolveClockInStartAt({
  detectedAt: new Date(detectedAt),
  enabled
});

test('Time Snap rounds every quarter-hour boundary down through minute seven and up from minute eight', () => {
  const cases = [
    ['2026-08-01T16:00:45.000Z', '2026-08-01T16:00:00.000Z'],
    ['2026-08-01T16:07:45.000Z', '2026-08-01T16:00:00.000Z'],
    ['2026-08-01T16:08:45.000Z', '2026-08-01T16:15:00.000Z'],
    ['2026-08-01T16:22:45.000Z', '2026-08-01T16:15:00.000Z'],
    ['2026-08-01T16:23:45.000Z', '2026-08-01T16:30:00.000Z'],
    ['2026-08-01T16:37:45.000Z', '2026-08-01T16:30:00.000Z'],
    ['2026-08-01T16:38:45.000Z', '2026-08-01T16:45:00.000Z'],
    ['2026-08-01T16:52:45.000Z', '2026-08-01T16:45:00.000Z'],
    ['2026-08-01T16:53:45.000Z', '2026-08-01T17:00:00.000Z']
  ] as const;

  for (const [detectedAt, expectedStartAt] of cases) {
    const detectedMinute = detectedAt.replace(':45.000Z', ':00.000Z');
    const timeSnapApplied = detectedMinute !== expectedStartAt;

    assert.deepEqual(resolve(detectedAt), {
      detectedAt: detectedMinute,
      startAt: expectedStartAt,
      timeSnapApplied,
      snapTargetAt: timeSnapApplied ? expectedStartAt : null
    });
  }
});

test('Time Snap rolls the final quarter-hour into the next calendar day', () => {
  assert.deepEqual(resolve('2026-08-01T23:53:59.000Z'), {
    detectedAt: '2026-08-01T23:53:00.000Z',
    startAt: '2026-08-02T00:00:00.000Z',
    timeSnapApplied: true,
    snapTargetAt: '2026-08-02T00:00:00.000Z'
  });
});

test('disabled Time Snap records the detected minute without rounding', () => {
  assert.deepEqual(resolve('2026-08-01T16:08:45.000Z', false), {
    detectedAt: '2026-08-01T16:08:00.000Z',
    startAt: '2026-08-01T16:08:00.000Z',
    timeSnapApplied: false,
    snapTargetAt: null
  });
});

test('Time Snap rejects an invalid detection time', () => {
  assert.throws(
    () => resolveClockInStartAt({
      detectedAt: new Date('not-a-time'),
      enabled: true
    }),
    /Clock-in detection time is invalid/
  );
});
