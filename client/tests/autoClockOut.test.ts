import assert from 'node:assert/strict';
import test from 'node:test';
import { finalScheduleEnd, nextWorkerRefreshAt } from '../src/lib/autoClockOut';

test('client refresh uses the final split block even when intervals are unordered', () => {
  assert.equal(finalScheduleEnd({ intervals: [
    { startAt: '2026-07-31T18:00:00-07:00', endAt: '2026-07-31T20:00:00-07:00' },
    { startAt: '2026-07-31T17:00:00-07:00', endAt: 'not-a-date' },
    { startAt: '2026-07-31T15:00:00-07:00', endAt: '2026-07-31T17:00:00-07:00' }
  ] }), '2026-07-31T20:00:00-07:00');
});

test('middle-hour end refreshes after minute 50 worker pass', () => {
  assert.equal(
    nextWorkerRefreshAt(
      '2026-07-31T15:30:00-07:00',
      new Date('2026-07-31T22:20:00.000Z')
    ).toISOString(),
    '2026-07-31T22:50:05.000Z'
  );
});

test('minute 59 end refreshes after the next hour starts', () => {
  assert.equal(
    nextWorkerRefreshAt(
      '2026-07-31T15:59:00-07:00',
      new Date('2026-07-31T22:20:00.000Z')
    ).toISOString(),
    '2026-07-31T23:00:05.000Z'
  );
});
