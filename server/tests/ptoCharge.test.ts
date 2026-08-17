import assert from 'node:assert/strict';
import test from 'node:test';
import { calculatePtoCharge } from '../services/ptoCharge';

test('full-date PTO charges weekdays, Saturdays, and Sundays at their ordinary rates', () => {
  const quote = calculatePtoCharge({
    startDate: '2026-08-14',
    endDate: '2026-08-16',
    partialDay: false
  });

  assert.deepEqual(quote.dayCharges, [
    { date: '2026-08-14', days: 1, cycleStart: '2026-01-01', cycleEnd: '2026-12-31' },
    { date: '2026-08-15', days: 0.5, cycleStart: '2026-01-01', cycleEnd: '2026-12-31' },
    { date: '2026-08-16', days: 0, cycleStart: '2026-01-01', cycleEnd: '2026-12-31' }
  ]);
  assert.equal(quote.totalDays, 1.5);
  assert.deepEqual(quote.cycleCharges, [
    { cycleStart: '2026-01-01', cycleEnd: '2026-12-31', days: 1.5 }
  ]);
  assert.equal(quote.entitlementDays, 5);
  assert.equal(quote.carryoverDays, 0);
});

test('same-day partial PTO charges one half-day through four hours and one day above it', () => {
  const fourHours = calculatePtoCharge({
    startDate: '2026-08-17',
    endDate: '2026-08-17',
    partialDay: true,
    durationHours: 4
  });
  const overFourHours = calculatePtoCharge({
    startDate: '2026-08-17',
    endDate: '2026-08-17',
    partialDay: true,
    durationHours: 4.01
  });

  assert.equal(fourHours.totalDays, 0.5);
  assert.equal(overFourHours.totalDays, 1);
});

test('multi-date partial PTO uses half-days at the first and last eligible dates', () => {
  const quote = calculatePtoCharge({
    startDate: '2026-08-14',
    endDate: '2026-08-17',
    partialDay: true
  });

  assert.deepEqual(
    quote.dayCharges.map(({ date, days }) => ({ date, days })),
    [
      { date: '2026-08-14', days: 0.5 },
      { date: '2026-08-15', days: 0.5 },
      { date: '2026-08-16', days: 0 },
      { date: '2026-08-17', days: 0.5 }
    ]
  );
  assert.equal(quote.totalDays, 1.5);
});

test('PTO charges are split across the entitlement cycle containing each leave date', () => {
  const quote = calculatePtoCharge({
    startDate: '2026-12-31',
    endDate: '2027-01-02',
    partialDay: false
  });

  assert.deepEqual(quote.cycleCharges, [
    { cycleStart: '2026-01-01', cycleEnd: '2026-12-31', days: 1 },
    { cycleStart: '2027-01-01', cycleEnd: '2027-12-31', days: 1.5 }
  ]);
  assert.equal(quote.totalDays, 2.5);
});

test('PTO charge previews reject non-calendar and inverted date ranges', () => {
  assert.throws(
    () => calculatePtoCharge({ startDate: '2026-02-30', endDate: '2026-03-01', partialDay: false }),
    /valid ISO calendar dates/
  );
  assert.throws(
    () => calculatePtoCharge({ startDate: '2026-03-02', endDate: '2026-03-01', partialDay: false }),
    /endDate must not precede startDate/
  );
});

test('same-day partial PTO requires a positive finite duration', () => {
  assert.throws(
    () => calculatePtoCharge({ startDate: '2026-08-17', endDate: '2026-08-17', partialDay: true }),
    /durationHours must be positive/
  );
  assert.throws(
    () => calculatePtoCharge({
      startDate: '2026-08-17',
      endDate: '2026-08-17',
      partialDay: true,
      durationHours: Number.POSITIVE_INFINITY
    }),
    /durationHours must be positive/
  );
});
