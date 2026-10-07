import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Settings } from 'luxon';
import {
  amendmentExpiresAt,
  findOverlappingTimeOff,
  getTimeOffChangeActions,
  normalizeTimeOffChangeReason,
  resolveTimeOffOffsets,
  validateApprovedTimeOffChange
} from '../services/timeOffChangePolicy';
import type { NormalizedTimeOffSubmission, TimeOffRecord, TimeOffSubmissionInput } from '../types/timeoff';
import type { TimeOffAmendment, TimeOffChangeActor } from '../types/timeOffChanges';

const NOW = '2026-10-07T17:00:00.000Z'; // 10:00 in Los Angeles; notice minimum is 2026-10-21
const TZ = 'America/Los_Angeles';
const tutor: TimeOffChangeActor = { kind: 'TUTOR', accountId: 123, franchiseId: 6 };
const admin: TimeOffChangeActor = { kind: 'ADMIN', accountId: 9, franchiseId: 6 };

const approved = (overrides: Partial<TimeOffRecord> = {}): TimeOffRecord => ({
  id: 42,
  franchiseId: 6,
  tutorId: 123,
  bridgeFlag: false,
  bridgeProfileId: null,
  firstName: 'Ada',
  lastName: 'Lovelace',
  tutorName: 'Ada Lovelace',
  tutorEmail: 'ada@example.com',
  startAt: '2026-10-19T07:00:00.000Z',
  endAt: '2026-10-22T07:00:00.000Z',
  startDate: '2026-10-19',
  endDate: '2026-10-21',
  type: 'pto',
  absenceLabel: 'Paid Time Off',
  reason: 'Family vacation out of town',
  notes: 'Family vacation out of town',
  status: 'approved',
  createdAt: '2026-09-01T18:00:00.000Z',
  createdBy: 123,
  decidedAt: '2026-09-02T18:00:00.000Z',
  decidedBy: 9,
  decisionReason: 'Approved',
  googleCalendarEventId: 'tctimeoff1a',
  durationHours: 72,
  partialDay: false,
  leaveTime: null,
  returnTime: null,
  source: 'authenticated',
  ...overrides
});

const days = (startDate: string, endDate: string, overrides: TimeOffSubmissionInput = {}): TimeOffSubmissionInput => ({
  startDate, endDate, partialDay: false, type: 'pto', reason: 'Family vacation out of town', ...overrides
});

const validate = (
  proposed: TimeOffSubmissionInput,
  options: { request?: TimeOffRecord; actor?: TimeOffChangeActor; nowIso?: string; submittedAt?: string; noticeRequired?: boolean } = {}
) => validateApprovedTimeOffChange({
  request: options.request ?? approved(),
  proposed,
  actor: options.actor ?? tutor,
  timezone: TZ,
  noticeRequired: options.noticeRequired ?? true,
  nowIso: options.nowIso ?? NOW,
  submittedAt: options.submittedAt
});

describe('approved time-off change validation', () => {
  it('lets a tutor reduce leave inside the notice window but not newly cover dates inside it', () => {
    const reduction = validate(days('2026-10-19', '2026-10-20'));
    const tooSoonExpansion = validate(days('2026-10-16', '2026-10-21'));
    const laterExtension = validate(days('2026-10-19', '2026-10-23'));

    assert.equal(reduction.valid, true);
    assert.equal(tooSoonExpansion.valid, false);
    assert.match(tooSoonExpansion.errors.join(' '), /14 days/);
    assert.equal(laterExtension.valid, true);
  });

  it('exempts Sick and Emergency coverage and lets admins bypass notice', () => {
    assert.equal(validate(days('2026-10-16', '2026-10-21', { type: 'emergency' })).valid, true);
    assert.equal(validate(days('2026-10-16', '2026-10-21', { type: 'sick' })).valid, true);
    assert.equal(validate(days('2026-10-16', '2026-10-21'), { actor: admin }).valid, true);
  });

  it('checks a type change into a non-exempt type as a new non-exempt request', () => {
    const sick = approved({ type: 'sick', absenceLabel: 'Sick Leave' });
    assert.equal(validate(days('2026-10-19', '2026-10-21', { type: 'pto' }), { request: sick }).valid, false);
    assert.equal(validate(days('2026-10-19', '2026-10-21', { type: 'emergency' }), { request: sick }).valid, true);
  });

  it('grandfathers a reason-only change and rejects a normalized no-op', () => {
    const reasonOnly = validate(days('2026-10-19', '2026-10-21', { reason: 'Family trip, now visiting grandparents' }));
    const noop = validate(days('2026-10-19', '2026-10-21', { type: 'PTO', reason: ' Family vacation out of town ' }));

    assert.equal(reasonOnly.valid, true);
    assert.equal(noop.valid, false);
    assert.match(noop.errors.join(' '), /no changes/i);
  });

  it('requires both the current and proposed starts to be in the future for both roles', () => {
    const started = approved({ startAt: '2026-10-07T07:00:00.000Z', endAt: '2026-10-09T07:00:00.000Z',
      startDate: '2026-10-07', endDate: '2026-10-08' });
    for (const actor of [tutor, admin]) {
      assert.equal(validate(days('2026-10-08', '2026-10-09'), { request: started, actor }).valid, false);
      assert.equal(validate(days('2026-10-07', '2026-10-21'), { actor }).valid, false, 'full-day leave today has started');
    }
    assert.equal(validate(days('2026-10-08', '2026-10-21'), { actor: admin }).valid, true);
  });

  it('does not let an admin directly edit their own request', () => {
    const own = approved({ tutorId: 9 });
    assert.equal(validate(days('2026-10-19', '2026-10-20'), { request: own, actor: admin }).valid, false);
  });

  it('uses proposal submission time for notice but the current time for start expiry', () => {
    const request = approved({ startAt: '2026-11-02T08:00:00.000Z', endAt: '2026-11-04T08:00:00.000Z',
      startDate: '2026-11-02', endDate: '2026-11-03' });
    const proposed = days('2026-10-26', '2026-11-03');
    const submittedAt = '2026-10-10T17:00:00.000Z';

    assert.equal(validate(proposed, { request, nowIso: '2026-10-20T17:00:00.000Z', submittedAt }).valid, true);
    assert.equal(validate(proposed, { request, nowIso: '2026-10-20T17:00:00.000Z' }).valid, false);
    assert.equal(validate(proposed, { request, nowIso: '2026-10-26T08:00:00.000Z', submittedAt }).valid, false);
  });
});

describe('approved time-off change timezone and input rules', () => {
  it('chooses the earlier ambiguous occurrence even when the server clock is in winter', () => {
    const previous = Settings.now;
    try {
      Settings.now = () => Date.parse('2026-01-15T12:00:00Z');
      Settings.resetCaches();
      const result = validate(days('2026-11-01', '2026-11-01', {
        partialDay: true, leaveTime: '01:30', returnTime: '03:00'
      }), { request: approved(), actor: admin });
      assert.equal(result.value?.startAt, '2026-11-01T08:30:00.000Z');
    } finally {
      Settings.now = previous;
      Settings.resetCaches();
    }
  });

  const novemberRequest = approved({ startAt: '2026-11-09T08:00:00.000Z', endAt: '2026-11-10T08:00:00.000Z',
    startDate: '2026-11-09', endDate: '2026-11-09' });

  it('maps a fall-back full day to 25 hours with an exclusive local-midnight end', () => {
    const result = validate(days('2026-11-01', '2026-11-01'), { request: novemberRequest, actor: admin });
    assert.equal(result.valid, true);
    assert.equal(result.value?.startAt, '2026-11-01T07:00:00.000Z');
    assert.equal(result.value?.endAt, '2026-11-02T08:00:00.000Z');
    assert.equal(result.value?.durationHours, 25);
  });

  it('rejects local times that do not exist on spring-forward days', () => {
    const springRequest = approved({ startAt: '2027-03-20T07:00:00.000Z', endAt: '2027-03-21T07:00:00.000Z',
      startDate: '2027-03-20', endDate: '2027-03-20' });
    const result = validate(days('2027-03-14', '2027-03-14', { partialDay: true, leaveTime: '02:30', returnTime: '04:00' }),
      { request: springRequest, actor: admin });
    assert.equal(result.valid, false);
    assert.match(result.errors.join(' '), /does not exist/i);
  });

  it('resolves an ambiguous fall-back time to the earlier occurrence and reports both offsets', () => {
    const result = validate(days('2026-11-01', '2026-11-01', { partialDay: true, leaveTime: '01:30', returnTime: '03:00' }),
      { request: novemberRequest, actor: admin });
    assert.equal(result.valid, true);
    const value = result.value as NormalizedTimeOffSubmission;
    assert.equal(value.startAt, '2026-11-01T08:30:00.000Z');
    assert.equal(value.endAt, '2026-11-01T11:00:00.000Z');
    assert.deepEqual(resolveTimeOffOffsets(value, TZ), { start: '-07:00', end: '-08:00' });
  });

  it('enforces 10–2000 character request reasons and the 336-hour maximum', () => {
    const reason = (length: number) => validate(days('2026-12-01', '2026-12-01', { reason: 'x'.repeat(length) }), {
      request: novemberRequest, actor: admin
    }).valid;
    assert.deepEqual([reason(9), reason(10), reason(2000), reason(2001)], [false, true, true, false]);
    assert.equal(validate(days('2026-12-01', '2026-12-14'), { request: novemberRequest, actor: admin }).valid, true);
    assert.equal(validate(days('2026-12-01', '2026-12-15'), { request: novemberRequest, actor: admin }).valid, false);
  });

  it('normalizes change reasons to 10–2000 trimmed characters and denial reasons to 1–2000', () => {
    const change = (length: number) => normalizeTimeOffChangeReason(` ${'r'.repeat(length)} `, 'change');
    assert.equal(change(9).valid, false);
    assert.equal(change(10).valid, true);
    assert.deepEqual(change(10), { valid: true, value: 'r'.repeat(10) });
    assert.equal(change(2000).valid, true);
    assert.equal(change(2001).valid, false);
    assert.equal(normalizeTimeOffChangeReason('No', 'denial').valid, true);
    assert.equal(normalizeTimeOffChangeReason('   ', 'denial').valid, false);
    assert.equal(normalizeTimeOffChangeReason(42, 'change').valid, false);
  });
});

const amendment = (overrides: Partial<TimeOffAmendment> = {}): TimeOffAmendment => ({
  id: '7',
  requestId: 42,
  baseVersion: '3',
  status: 'pending',
  proposed: {
    startDate: '2026-10-20', endDate: '2026-10-21', startAt: '2026-10-20T07:00:00.000Z', endAt: '2026-10-22T07:00:00.000Z',
    partialDay: false, leaveTime: null, returnTime: null, type: 'pto', storageType: 'pto',
    absenceLabel: 'Paid Time Off', reason: 'Family vacation out of town', durationHours: 48
  },
  timezone: TZ,
  changeReason: 'Flights moved by one day',
  proposedBy: 123,
  createdAt: '2026-10-06T17:00:00.000Z',
  decidedByType: null,
  decidedBy: null,
  decidedAt: null,
  decisionReason: null,
  ...overrides
});

describe('approved time-off change actions', () => {
  const actions = (actor: TimeOffChangeActor, overrides: { request?: TimeOffRecord; amendment?: TimeOffAmendment | null; nowIso?: string } = {}) =>
    getTimeOffChangeActions({
      actor,
      request: overrides.request ?? approved(),
      amendment: overrides.amendment === undefined ? null : overrides.amendment,
      nowIso: overrides.nowIso ?? NOW
    });

  it('offers an owner tutor change or withdrawal plus cancellation', () => {
    assert.deepEqual(actions(tutor), ['propose', 'cancel']);
    assert.deepEqual(actions(tutor, { amendment: amendment() }), ['withdraw', 'cancel']);
  });

  it('offers scoped admins review, direct edit, and cancellation', () => {
    assert.deepEqual(actions(admin), ['admin_edit', 'cancel']);
    assert.deepEqual(actions(admin, { amendment: amendment() }), ['approve_amendment', 'deny_amendment', 'admin_edit', 'cancel']);
  });

  it('limits an admin to cancelling their own request', () => {
    assert.deepEqual(actions(admin, { request: approved({ tutorId: 9 }), amendment: amendment() }), ['cancel']);
  });

  it('offers nothing outside ownership, scope, approval, or the future', () => {
    assert.deepEqual(actions({ ...tutor, accountId: 124 }), []);
    assert.deepEqual(actions({ ...tutor, franchiseId: 7 }), []);
    assert.deepEqual(actions({ ...admin, franchiseId: 7 }), []);
    assert.deepEqual(actions(admin, { request: approved({ status: 'pending' }) }), []);
    assert.deepEqual(actions(tutor, { request: approved({ status: 'cancelled' }) }), []);
    assert.deepEqual(actions(admin, { nowIso: '2026-10-19T07:00:00.000Z' }), []);
  });

  it('never offers approval of a terminal or expired amendment', () => {
    assert.deepEqual(actions(admin, { amendment: amendment({ status: 'denied', decidedAt: NOW, decidedBy: 9, decidedByType: 'ADMIN' }) }),
      ['admin_edit', 'cancel']);
    const earlierProposal = amendment({ proposed: { ...amendment().proposed, startDate: '2026-10-08', startAt: '2026-10-08T07:00:00.000Z' } });
    assert.deepEqual(actions(admin, { amendment: earlierProposal, nowIso: '2026-10-08T08:00:00.000Z' }), ['admin_edit', 'cancel']);
    assert.deepEqual(actions(tutor, { amendment: earlierProposal, nowIso: '2026-10-08T08:00:00.000Z' }), ['propose', 'cancel']);
  });

  it('expires a proposal at the earlier of the current and proposed starts', () => {
    assert.equal(amendmentExpiresAt(approved(), amendment().proposed), '2026-10-19T07:00:00.000Z');
    assert.equal(amendmentExpiresAt(approved(), { ...amendment().proposed, startAt: '2026-10-12T07:00:00.000Z' }),
      '2026-10-12T07:00:00.000Z');
  });
});

describe('approved time-off change overlap', () => {
  const proposed = { startAt: '2026-10-19T07:00:00.000Z', endAt: '2026-10-23T07:00:00.000Z' };

  it('excludes the parent request and inactive leave and treats touching intervals as separate', () => {
    const conflicts = findOverlappingTimeOff(42, proposed, [
      { id: 42, status: 'approved', startAt: '2026-10-19T07:00:00.000Z', endAt: '2026-10-22T07:00:00.000Z' },
      { id: 43, status: 'denied', startAt: '2026-10-20T07:00:00.000Z', endAt: '2026-10-21T07:00:00.000Z' },
      { id: 44, status: 'cancelled', startAt: '2026-10-20T07:00:00.000Z', endAt: '2026-10-21T07:00:00.000Z' },
      { id: 45, status: 'approved', startAt: '2026-10-23T07:00:00.000Z', endAt: '2026-10-24T07:00:00.000Z' }
    ]);
    assert.deepEqual(conflicts, []);
    assert.deepEqual(findOverlappingTimeOff(42, proposed, [
      { id: 46, status: 'pending', startAt: '2026-10-22T07:00:00.000Z', endAt: '2026-10-24T07:00:00.000Z' }
    ]), [46]);
  });
});
