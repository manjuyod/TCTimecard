import test from 'node:test';
import assert from 'node:assert/strict';
import type { AdminEntry, BreakInput } from '../services/adminTimeEntry/contracts';
import { normalizeCorrection } from '../services/adminTimeEntry/policy';
import { validPreservedEntry } from '../services/adminTimeEntry/preview';
import { summarize } from '../services/adminTimeEntry/totals';
import { correctionInput, pendingEntry } from './helpers/adminTimeEntryFixtures';

const now = new Date('2026-11-02T21:00:00Z');
function historicalDay(overrides: Partial<AdminEntry['breaks'][number]> = {}): AdminEntry {
  return pendingEntry({
    workDate: '2026-10-26',
    sessions: [{ ...pendingEntry().sessions[0],
      startAt: '2026-10-26T17:45:00.000Z', endAt: '2026-10-27T02:45:00.000Z' }],
    breaks: [{
      id: 11, sessionId: 99, breakType: 'lunch', payTreatment: 'unpaid',
      status: 'completed', source: 'employee', durationMinutes: 17, note: null,
      startTime: '2026-10-27T21:33:00.000Z', endTime: '2026-10-27T21:50:00.000Z',
      createdAt: '2026-10-27T21:33:48.672329Z', updatedAt: '2026-10-27T21:50:51.589972Z',
      ...overrides,
    }],
  });
}
function inputFor(day: AdminEntry, overrides: Partial<BreakInput> = {}) {
  const { sessionId, source, createdAt, updatedAt, ...original } = day.breaks[0];
  return correctionInput({
    workDate: day.workDate,
    sessions: day.sessions.map(s => ({ id: s.id, startAt: s.startAt, endAt: s.endAt! })),
    breaks: [{ ...original, status: 'voided', ...overrides }],
  });
}
const contextFor = (day: AdminEntry) => ({ day, timezone: day.timezone, now });

for (const status of ['completed', 'voided'] as const) {
  test(`voiding an existing ${status} next-day break preserves history and excludes it from totals`, () => {
    const day = historicalDay({ status });
    const input = inputFor(day);
    const result = normalizeCorrection(input, contextFor(day));
    assert.deepEqual(result.breaks, input.breaks);
    assert.deepEqual(summarize(result.sessions, result.breaks, true), {
      grossMinutes: 540, unpaidBreakMinutes: 0, recordedPaidMinutes: 540, approvedMinutes: 540,
    });
    const nextDay = { ...day, breaks: [{ ...day.breaks[0], ...result.breaks[0], id: 11 }] };
    assert.equal(normalizeCorrection(inputFor(nextDay), contextFor(nextDay)).breaks[0].status, 'voided');
    assert.equal(validPreservedEntry({ ...nextDay, status: 'voided' }, now), true);
  });
}

test('void preservation returns stored timestamps exactly, including historical subminute precision', () => {
  const day = historicalDay({
    startTime: '2026-10-27T21:33:09.123456Z', endTime: '2026-10-27T21:50:09.123456Z',
  });
  const result = normalizeCorrection(inputFor(day, {
    startTime: '2026-10-27T14:33:09.123456-07:00', endTime: '2026-10-27T14:50:09.123456-07:00',
  }), contextFor(day));
  assert.equal(result.breaks[0].startTime, day.breaks[0].startTime);
  assert.equal(result.breaks[0].endTime, day.breaks[0].endTime);
});

test('voiding a historical break permits removing its linked session', () => {
  const day = historicalDay();
  const input = inputFor(day);
  input.sessions[0].id = null;
  assert.equal(normalizeCorrection(input, contextFor(day)).breaks[0].status, 'voided');
});

test('voiding an in-session unpaid break restores its deducted minutes', () => {
  const day = historicalDay({ startTime: '2026-10-26T20:00:00.000Z', endTime: '2026-10-26T21:00:00.000Z', durationMinutes: 60 });
  assert.equal(summarize(day.sessions, day.breaks, true).approvedMinutes, 480);
  const result = normalizeCorrection(inputFor(day), contextFor(day));
  assert.equal(summarize(result.sessions, result.breaks, true).approvedMinutes, 540);
});

test('void preservation does not bypass identity, mandatory child, note, or edited-history validation', () => {
  const day = historicalDay();
  for (const patch of [
    { id: 999 }, { id: null }, { startTime: '2026-10-28T21:33:00Z' },
    { durationMinutes: 18 }, { breakType: 'personal' }, { payTreatment: 'paid' },
    { startTime: null, endTime: null }, { note: 'x'.repeat(2001) },
  ] as Partial<BreakInput>[]) {
    assert.throws(() => normalizeCorrection(inputFor(day, patch), contextFor(day)),
      { code: 'INVALID_INPUT' }, JSON.stringify(patch));
  }
  const input = inputFor(day);
  assert.throws(() => normalizeCorrection({ ...input, breaks: [] }, contextFor(day)), /every existing break/);
  assert.throws(() => normalizeCorrection({ ...input, breaks: [...input.breaks, ...input.breaks] }, contextFor(day)), /duplicate/);
});

test('restoring a voided break requires its date and session containment to be valid', () => {
  for (const overrides of [
    {},
    { startTime: '2026-10-26T16:00:00.000Z', endTime: '2026-10-26T16:17:00.000Z' },
  ]) {
    const day = historicalDay({ ...overrides, status: 'voided' });
    assert.throws(() => normalizeCorrection(inputFor(day, { status: 'completed' }), contextFor(day)),
      /within work date|contained in one session/);
  }
  const day = historicalDay({ status: 'voided' });
  const result = normalizeCorrection(inputFor(day, {
    status: 'completed', startTime: '2026-10-26T21:33:00Z', endTime: '2026-10-26T21:50:00Z',
  }), contextFor(day));
  assert.equal(result.breaks[0].status, 'completed');
  assert.equal(summarize(result.sessions, result.breaks, true).approvedMinutes, 523);
});

test('restoring a duration-only voided break requires positioned times', () => {
  const day = historicalDay({ status: 'voided', startTime: null, endTime: null });
  assert.throws(() => normalizeCorrection(inputFor(day, { status: 'completed' }), contextFor(day)),
    /require start and end times/);
  assert.equal(normalizeCorrection(inputFor(day), contextFor(day)).breaks[0].status, 'voided');
});
