import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildTimeOffPolicy, normalizeTimeOffSubmission } from '../services/timeOffPolicy';

const options = {
  timezone: 'America/Los_Angeles',
  nowIso: '2026-07-12T18:00:00.000Z',
  maxDurationHours: 336
};

describe('time-off policy', () => {
  it('returns the franchise-local 14-day policy boundary', () => {
    assert.deepEqual(buildTimeOffPolicy(options), {
      timezone: 'America/Los_Angeles',
      today: '2026-07-12',
      minimumStartDate: '2026-07-26',
      noticeDays: 14,
      exemptTypes: ['sick', 'emergency'],
      allowedTypes: ['pto', 'sick', 'emergency', 'unpaid', 'other'],
      maxDurationHours: 336
    });
  });

  it('allows a non-exempt full-day request exactly 14 local days ahead', () => {
    const result = normalizeTimeOffSubmission(
      {
        startDate: '2026-07-26',
        endDate: '2026-07-26',
        partialDay: false,
        type: 'pto',
        reason: 'Family vacation out of town'
      },
      options
    );

    assert.equal(result.valid, true);
    assert.deepEqual(result.value, {
      startDate: '2026-07-26',
      endDate: '2026-07-26',
      startAt: '2026-07-26T07:00:00.000Z',
      endAt: '2026-07-27T07:00:00.000Z',
      partialDay: false,
      leaveTime: null,
      returnTime: null,
      type: 'pto',
      storageType: 'pto',
      absenceLabel: 'Paid Time Off',
      reason: 'Family vacation out of town',
      durationHours: 24
    });
  });

  it('rejects non-exempt requests inside the 14-day window', () => {
    const result = normalizeTimeOffSubmission(
      {
        startDate: '2026-07-25',
        endDate: '2026-07-25',
        partialDay: false,
        type: 'unpaid',
        reason: 'Personal appointment out of town'
      },
      options
    );

    assert.equal(result.valid, false);
    assert.match(result.errors.join('\n'), /at least 14 days/i);
  });

  it('allows sick and emergency requests today but rejects past starts', () => {
    for (const type of ['sick', 'emergency'] as const) {
      const today = normalizeTimeOffSubmission(
        {
          startDate: '2026-07-12',
          endDate: '2026-07-12',
          partialDay: false,
          type,
          reason: 'Unexpected situation requiring leave'
        },
        options
      );
      assert.equal(today.valid, true, type);
    }

    const past = normalizeTimeOffSubmission(
      {
        startDate: '2026-07-11',
        endDate: '2026-07-11',
        partialDay: false,
        type: 'sick',
        reason: 'Unexpected illness requiring leave'
      },
      options
    );
    assert.equal(past.valid, false);
    assert.match(past.errors.join('\n'), /cannot be in the past/i);
  });

  it('maps emergency to the compatible other storage type and label', () => {
    const result = normalizeTimeOffSubmission(
      {
        startDate: '2026-07-13',
        endDate: '2026-07-13',
        partialDay: false,
        type: 'emergency',
        reason: 'Unexpected family emergency today'
      },
      options
    );

    assert.equal(result.valid, true);
    assert.equal(result.value?.storageType, 'other');
    assert.equal(result.value?.absenceLabel, 'Emergency');
  });

  it('matches source partial-day overnight and multi-date normalization', () => {
    const overnight = normalizeTimeOffSubmission(
      {
        startDate: '2026-07-12',
        endDate: '2026-07-12',
        partialDay: true,
        leaveTime: '23:00',
        returnTime: '01:00',
        type: 'emergency',
        reason: 'Unexpected family emergency overnight'
      },
      options
    );
    assert.equal(overnight.valid, true);
    assert.equal(overnight.value?.durationHours, 2);
    assert.equal(overnight.value?.endAt, '2026-07-13T08:00:00.000Z');

    const multiDate = normalizeTimeOffSubmission(
      {
        startDate: '2026-07-26',
        endDate: '2026-07-27',
        partialDay: true,
        leaveTime: '13:30',
        returnTime: '09:00',
        type: 'other',
        reason: 'Conference travel across two work days'
      },
      options
    );
    assert.equal(multiDate.valid, true);
    assert.equal(multiDate.value?.durationHours, 19.5);
  });

  it('requires a reason between 10 and 2000 characters', () => {
    const short = normalizeTimeOffSubmission(
      {
        startDate: '2026-07-26',
        endDate: '2026-07-26',
        partialDay: false,
        type: 'pto',
        reason: 'Too short'
      },
      options
    );
    assert.equal(short.valid, false);
    assert.match(short.errors.join('\n'), /at least 10 characters/i);

    const long = normalizeTimeOffSubmission(
      {
        startDate: '2026-07-26',
        endDate: '2026-07-26',
        partialDay: false,
        type: 'pto',
        reason: 'x'.repeat(2001)
      },
      options
    );
    assert.equal(long.valid, false);
    assert.match(long.errors.join('\n'), /2000 characters or fewer/i);
  });
});
