import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildTimeOffChangeEmails, type TimeOffChangeEmailSnapshot } from '../services/timeOffChangeEmail';
import type { TimeOffRecord } from '../types/timeoff';
import type { TimeOffAmendment } from '../types/timeOffChanges';

const record = (overrides: Partial<TimeOffRecord> = {}): TimeOffRecord => ({
  id: 42, franchiseId: 6, tutorId: 123, bridgeFlag: false, bridgeProfileId: null, firstName: 'Ada', lastName: 'Lovelace',
  tutorName: 'Ada Lovelace', tutorEmail: 'ada@example.com', startAt: '2026-11-16T08:00:00.000Z', endAt: '2026-11-18T08:00:00.000Z',
  startDate: '2026-11-16', endDate: '2026-11-17', type: 'pto', absenceLabel: 'Paid Time Off', reason: 'Family trip',
  notes: 'Family trip', status: 'approved', createdAt: '2026-10-01T18:00:00.000Z', createdBy: 123,
  decidedAt: '2026-10-02T18:00:00.000Z', decidedBy: 9, decisionReason: 'Approved', googleCalendarEventId: 'tctimeoff1a',
  durationHours: 48, partialDay: false, leaveTime: null, returnTime: null, source: 'authenticated', ...overrides
});
const proposal: TimeOffAmendment = {
  id: '7', requestId: 42, baseVersion: '4', status: 'pending',
  proposed: { startDate: '2026-11-16', endDate: '2026-11-18', startAt: '2026-11-16T08:00:00.000Z', endAt: '2026-11-19T08:00:00.000Z',
    partialDay: false, leaveTime: null, returnTime: null, type: 'pto', storageType: 'pto', absenceLabel: 'Paid Time Off',
    reason: 'Family trip', durationHours: 72 },
  timezone: 'America/Los_Angeles', changeReason: 'Flights moved', proposedBy: 123, createdAt: '2026-10-06T17:00:00.000Z',
  decidedByType: null, decidedBy: null, decidedAt: null, decisionReason: null
};
const center = { id: 6, name: 'Downtown <Main>', email: 'center@example.com', gmailId: 'calendar@example.com' };
const snapshot = (overrides: Partial<TimeOffChangeEmailSnapshot>): TimeOffChangeEmailSnapshot => ({
  operationId: '1b4e28ba-2fa1-41d2-883f-0016d3cca427', action: 'propose', actorKind: 'TUTOR', at: '2026-10-07T17:00:00.000Z',
  before: record(), after: record(), amendment: proposal, supersededAmendment: null, changeReason: 'Flights moved',
  decisionReason: null, ...overrides
});
const build = (overrides: Partial<TimeOffChangeEmailSnapshot>) =>
  buildTimeOffChangeEmails(snapshot(overrides), center, 'https://timecard.example.com');

describe('approved time-off change emails', () => {
  it('freezes the center recipient, Gmail identity, and both date ranges for a proposal', () => {
    const [email] = build({});
    assert.equal(email.recipient, 'center@example.com');
    assert.equal(email.impersonationSubject, 'calendar@example.com');
    assert.equal(email.dedupeKey, '1b4e28ba-2fa1-41d2-883f-0016d3cca427:email:center_change_proposed');
    assert.match(email.text, /Current: 2026-11-16 through 2026-11-17, Paid Time Off/);
    assert.match(email.text, /Proposed: 2026-11-16 through 2026-11-18, Paid Time Off/);
    assert.match(email.text, /stays in effect until an admin approves/);
    assert.match(email.text, /Recorded 2026-10-07T17:00:00.000Z/);
  });

  it('links proposals to authenticated review and never to an original decision token', () => {
    const [email] = build({});
    assert.match(email.text, /\/admin\/approvals\?tab=timeoff&franchiseId=6&requestId=42&view=manage&amendmentId=7/);
    assert.doesNotMatch(`${email.text}${email.html}`, /timeoff\/decision|#token=|action=approve/);
  });

  it('sends one combined requester message when an admin edit or cancellation supersedes a proposal', () => {
    const edit = build({ action: 'admin_edit', actorKind: 'ADMIN', amendment: null, supersededAmendment: proposal,
      after: record({ endDate: '2026-11-16', endAt: '2026-11-17T08:00:00.000Z' }) });
    assert.deepEqual(edit.map((email) => [email.kind, email.recipient]), [['requester_edited', 'ada@example.com']]);
    assert.match(edit[0].text, /Now: 2026-11-16, Paid Time Off/);
    assert.match(edit[0].text, /Previously: 2026-11-16 through 2026-11-17/);
    assert.match(edit[0].text, /replaces your pending change request/);

    const cancel = build({ action: 'cancel', actorKind: 'ADMIN', amendment: null, supersededAmendment: proposal,
      after: record({ status: 'cancelled' }) });
    assert.deepEqual(cancel.map((email) => email.kind), ['requester_cancelled']);
    assert.match(cancel[0].text, /pending change request was also closed/);
  });

  it('tells the center and confirms to the requester when a tutor cancels', () => {
    assert.deepEqual(build({ action: 'cancel', amendment: null, after: record({ status: 'cancelled' }) })
      .map((email) => [email.kind, email.recipient]), [
      ['center_cancelled', 'center@example.com'],
      ['requester_cancel_confirmation', 'ada@example.com']
    ]);
  });

  it('notifies the requester of approval and denial with the reason, without claiming calendar sync', () => {
    const [approved] = build({ action: 'approve_amendment', actorKind: 'ADMIN',
      after: record({ endDate: '2026-11-18', endAt: '2026-11-19T08:00:00.000Z' }) });
    const [denied] = build({ action: 'deny_amendment', actorKind: 'ADMIN', decisionReason: 'Coverage is short' });
    assert.equal(approved.kind, 'requester_change_approved');
    assert.match(approved.text, /\/tutor\/time-off\?requestId=42/);
    assert.match(denied.text, /Reason: Coverage is short/);
    assert.doesNotMatch(`${approved.text}${denied.text}`, /calendar (was|has been) (updated|synced)/i);
  });

  it('escapes HTML from names, centers, and reasons', () => {
    const [email] = build({ changeReason: '<script>alert(1)</script>' });
    assert.doesNotMatch(email.html, /<script>/);
    assert.match(email.html, /&lt;script&gt;/);
  });
});
