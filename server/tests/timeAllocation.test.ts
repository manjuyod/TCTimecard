import test from 'node:test';
import assert from 'node:assert/strict';
import { computeTimeAllocation } from '../services/timeAllocation';

const day = '2026-01-01';
const at = (time: string) => `${day}T${time}:00-06:00`;
const session = (start: string, end: string) => ({ startAt: at(start), endAt: at(end) });
const schedule = (start: string, end: string) => ({ startAt: at(start), endAt: at(end) });
const timedBreak = (
  start: string,
  end: string,
  payTreatment: 'paid' | 'unpaid' = 'unpaid',
  status: 'active' | 'completed' | 'voided' = 'completed'
) => ({
  startTime: at(start),
  endTime: at(end),
  durationMinutes: 1,
  payTreatment,
  status
});

test('between-segment unpaid lunch preserves scheduled coverage and creates no extra time', () => {
  const result = computeTimeAllocation({
    sessions: [session('09:00', '17:00')],
    scheduleIntervals: [schedule('09:00', '12:00'), schedule('13:00', '17:00')],
    breaks: [timedBreak('12:00', '13:00')]
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.allocation.scheduled.totalMinutes, 420);
  assert.equal(result.allocation.scheduled.coveredMinutes, 420);
  assert.equal(result.allocation.scheduled.deficitMinutes, 0);
  assert.equal(result.allocation.scheduled.deltaMinutes, 0);
  assert.equal(result.allocation.extra.paidMinutes, 0);
  assert.equal(result.allocation.manual.paidMinutes, 420);
  assert.equal(result.allocation.breaks.scheduledOverlapMinutes, 0);
  assert.equal(result.allocation.matches, true);
});

test('a partially scheduled unpaid break creates only the overlapping coverage deficit', () => {
  const result = computeTimeAllocation({
    sessions: [session('09:00', '17:00')],
    scheduleIntervals: [schedule('09:00', '12:00'), schedule('13:00', '17:00')],
    breaks: [timedBreak('11:45', '12:15')]
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.allocation.scheduled.coveredMinutes, 405);
  assert.equal(result.allocation.scheduled.deficitMinutes, 15);
  assert.equal(result.allocation.scheduled.deltaMinutes, -15);
  assert.equal(result.allocation.extra.paidMinutes, 45);
  assert.equal(result.allocation.manual.unpaidBreakMinutes, 30);
  assert.equal(result.allocation.breaks.scheduledOverlapMinutes, 15);
  assert.equal(result.allocation.breaks.outsideScheduleMinutes, 15);
  assert.equal(result.allocation.matches, false);
});

test('a paid break remains payable but reduces scheduled tutoring coverage', () => {
  const result = computeTimeAllocation({
    sessions: [session('09:00', '17:00')],
    scheduleIntervals: [schedule('09:00', '17:00')],
    breaks: [timedBreak('10:00', '10:15', 'paid')]
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.allocation.manual.grossMinutes, 480);
  assert.equal(result.allocation.manual.paidBreakMinutes, 15);
  assert.equal(result.allocation.manual.paidMinutes, 480);
  assert.equal(result.allocation.scheduled.coveredMinutes, 465);
  assert.equal(result.allocation.scheduled.deficitMinutes, 15);
  assert.equal(result.allocation.extra.paidMinutes, 0);
  assert.equal(result.allocation.matches, false);
});

test('full scheduled coverage plus payable extra time does not match', () => {
  const result = computeTimeAllocation({
    sessions: [session('08:30', '17:00')],
    scheduleIntervals: [schedule('09:00', '17:00')],
    breaks: []
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.allocation.scheduled.coveredMinutes, 480);
  assert.equal(result.allocation.scheduled.deltaMinutes, 0);
  assert.equal(result.allocation.extra.paidMinutes, 30);
  assert.equal(result.allocation.matches, false);
});

test('shifted equal-duration work reports both a coverage deficit and payable extra', () => {
  const result = computeTimeAllocation({
    sessions: [session('10:00', '18:00')],
    scheduleIntervals: [schedule('09:00', '17:00')],
    breaks: []
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.allocation.manual.paidMinutes, 480);
  assert.equal(result.allocation.scheduled.totalMinutes, 480);
  assert.equal(result.allocation.scheduled.coveredMinutes, 420);
  assert.equal(result.allocation.scheduled.deltaMinutes, -60);
  assert.equal(result.allocation.extra.paidMinutes, 60);
  assert.equal(result.allocation.matches, false);
});

test('a timed break outside every recorded session is warning-only', () => {
  const result = computeTimeAllocation({
    sessions: [session('09:00', '17:00')],
    scheduleIntervals: [schedule('09:00', '17:00')],
    breaks: [timedBreak('08:00', '08:30')]
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.allocation.manual.unpaidBreakMinutes, 0);
  assert.equal(result.allocation.manual.paidMinutes, 480);
  assert.equal(result.allocation.scheduled.coveredMinutes, 480);
  assert.equal(result.allocation.breaks.outsideSessionMinutes, 30);
  assert.equal(result.allocation.matches, true);
});

test('a duration-only break is non-deducting, warning-only, and does not block a match', () => {
  const result = computeTimeAllocation({
    sessions: [session('09:00', '17:00')],
    scheduleIntervals: [schedule('09:00', '17:00')],
    breaks: [
      {
        startTime: null,
        endTime: null,
        durationMinutes: 30,
        payTreatment: 'unpaid',
        status: 'completed'
      }
    ]
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.allocation.manual.unpaidBreakMinutes, 0);
  assert.equal(result.allocation.manual.paidMinutes, 480);
  assert.equal(result.allocation.breaks.unpositionedMinutes, 30);
  assert.equal(result.allocation.matches, true);
});

test('active and voided breaks do not affect allocation or warnings', () => {
  const result = computeTimeAllocation({
    sessions: [session('09:00', '17:00')],
    scheduleIntervals: [schedule('09:00', '17:00')],
    breaks: [
      timedBreak('10:00', '10:15', 'unpaid', 'active'),
      timedBreak('11:00', '11:15', 'unpaid', 'voided')
    ]
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.allocation.manual.unpaidBreakMinutes, 0);
  assert.equal(result.allocation.breaks.scheduledOverlapMinutes, 0);
  assert.equal(result.allocation.breaks.outsideSessionMinutes, 0);
  assert.equal(result.allocation.breaks.unpositionedMinutes, 0);
  assert.equal(result.allocation.matches, true);
});

test('overlapping timed break records are normalized before deduction', () => {
  const result = computeTimeAllocation({
    sessions: [session('09:00', '17:00')],
    scheduleIntervals: [schedule('09:00', '12:00'), schedule('13:00', '17:00')],
    breaks: [timedBreak('12:00', '13:00'), timedBreak('12:30', '13:30')]
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.allocation.manual.unpaidBreakMinutes, 90);
  assert.equal(result.allocation.manual.paidMinutes, 390);
  assert.equal(result.allocation.breaks.scheduledOverlapMinutes, 30);
  assert.equal(result.allocation.breaks.outsideScheduleMinutes, 60);
});

test('mixed paid and unpaid overlap gives unpaid time precedence without double counting', () => {
  const result = computeTimeAllocation({
    sessions: [session('09:00', '17:00')],
    scheduleIntervals: [schedule('09:00', '12:00'), schedule('13:00', '17:00')],
    breaks: [
      timedBreak('12:00', '13:00', 'paid'),
      timedBreak('12:30', '13:30', 'unpaid')
    ]
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.allocation.manual.paidBreakMinutes, 30);
  assert.equal(result.allocation.manual.unpaidBreakMinutes, 60);
  assert.equal(result.allocation.manual.paidMinutes, 420);
  assert.equal(result.allocation.scheduled.coveredMinutes, 390);
  assert.equal(result.allocation.extra.paidMinutes, 30);
  assert.equal(result.allocation.breaks.scheduledOverlapMinutes, 30);
  assert.equal(result.allocation.breaks.outsideScheduleMinutes, 60);
});

test('string session and schedule timestamps require a timezone offset', () => {
  const sessionResult = computeTimeAllocation({
    sessions: [{ startAt: '2026-01-01T09:00:00', endAt: '2026-01-01T10:00:00' }],
    scheduleIntervals: [schedule('09:00', '10:00')],
    breaks: []
  });
  assert.equal(sessionResult.ok, false);

  const scheduleResult = computeTimeAllocation({
    sessions: [session('09:00', '10:00')],
    scheduleIntervals: [
      { startAt: '2026-01-01T09:00:00', endAt: '2026-01-01T10:00:00' }
    ],
    breaks: []
  });
  assert.equal(scheduleResult.ok, false);
});
