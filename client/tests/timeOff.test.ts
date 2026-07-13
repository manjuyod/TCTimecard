import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseAdminTimeOffDeepLink, returnTarget, validateTimeOffForm } from '../src/lib/timeOff';

const policy = {
  timezone: 'America/Los_Angeles',
  today: '2026-07-12',
  minimumStartDate: '2026-07-26',
  noticeDays: 14 as const,
  exemptTypes: ['sick', 'emergency'] as Array<'sick' | 'emergency'>,
  allowedTypes: ['pto', 'sick', 'emergency', 'unpaid', 'other'] as Array<
    'pto' | 'sick' | 'emergency' | 'unpaid' | 'other'
  >,
  maxDurationHours: 336
};

describe('time-off client helpers', () => {
  it('mirrors the 14-day and exempt-type policy', () => {
    const base = {
      startDate: '2026-07-25',
      endDate: '2026-07-25',
      partialDay: false,
      leaveTime: '',
      returnTime: '',
      type: 'pto' as const,
      reason: 'Family vacation out of town'
    };
    assert.match(validateTimeOffForm(base, policy).startDate ?? '', /14 days/i);
    assert.equal(validateTimeOffForm({ ...base, type: 'emergency' }, policy).startDate, undefined);
    assert.match(
      validateTimeOffForm({ ...base, type: 'sick', startDate: '2026-07-11', endDate: '2026-07-11' }, policy)
        .startDate ?? '',
      /past/i
    );
  });

  it('requires partial-day times and a 10-character reason', () => {
    const errors = validateTimeOffForm(
      {
        startDate: '2026-07-26',
        endDate: '2026-07-26',
        partialDay: true,
        leaveTime: '',
        returnTime: '',
        type: 'pto',
        reason: 'short'
      },
      policy
    );
    assert.match(errors.leaveTime ?? '', /required/i);
    assert.match(errors.returnTime ?? '', /required/i);
    assert.match(errors.reason ?? '', /10 characters/i);
  });

  it('parses authenticated review and action deep links', () => {
    assert.deepEqual(parseAdminTimeOffDeepLink('?tab=timeoff&franchiseId=6&requestId=42&action=deny'), {
      tab: 'timeoff',
      franchiseId: 6,
      requestId: 42,
      action: 'deny'
    });
  });

  it('preserves pathname, query, and hash through authentication', () => {
    assert.equal(
      returnTarget({ pathname: '/admin/approvals', search: '?tab=timeoff&requestId=42', hash: '#review' }),
      '/admin/approvals?tab=timeoff&requestId=42#review'
    );
  });
});
