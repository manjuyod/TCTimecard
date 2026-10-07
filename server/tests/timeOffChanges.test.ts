import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createTimeOffChangeService,
  planTimeOffChangeDeliveries,
  type TimeOffChangeDeliveryPlanInput
} from '../services/timeOffChanges';
import type { TimeOffRecord } from '../types/timeoff';
import type { TimeOffAmendment, TimeOffChangeCommand } from '../types/timeOffChanges';

const request = (overrides: Partial<TimeOffRecord> = {}): TimeOffRecord => ({
  id: 42, franchiseId: 6, tutorId: 123, bridgeFlag: false, bridgeProfileId: null,
  firstName: 'Ada', lastName: 'Lovelace', tutorName: 'Ada Lovelace', tutorEmail: 'ada@example.com',
  startAt: '2026-11-16T08:00:00.000Z', endAt: '2026-11-18T08:00:00.000Z', startDate: '2026-11-16', endDate: '2026-11-17',
  type: 'pto', absenceLabel: 'Paid Time Off', reason: 'Family vacation out of town', notes: 'Family vacation out of town',
  status: 'approved', createdAt: '2026-10-01T18:00:00.000Z', createdBy: 123, decidedAt: '2026-10-02T18:00:00.000Z',
  decidedBy: 9, decisionReason: 'Approved', googleCalendarEventId: 'tctimeoff1a', durationHours: 48,
  partialDay: false, leaveTime: null, returnTime: null, source: 'authenticated', ...overrides
});

const amendment: TimeOffAmendment = {
  id: '7', requestId: 42, baseVersion: '4', status: 'pending',
  proposed: {
    startDate: '2026-11-16', endDate: '2026-11-18', startAt: '2026-11-16T08:00:00.000Z', endAt: '2026-11-19T08:00:00.000Z',
    partialDay: false, leaveTime: null, returnTime: null, type: 'pto', storageType: 'pto', absenceLabel: 'Paid Time Off',
    reason: 'Family vacation out of town', durationHours: 72
  },
  timezone: 'America/Los_Angeles', changeReason: 'Flights moved by one day', proposedBy: 123,
  createdAt: '2026-10-06T17:00:00.000Z', decidedByType: null, decidedBy: null, decidedAt: null, decisionReason: null
};

const center = { id: 6, name: 'Downtown', email: 'center@example.com', gmailId: 'calendar@example.com' };

const plan = (overrides: Partial<TimeOffChangeDeliveryPlanInput>) => {
  let next = 0;
  return planTimeOffChangeDeliveries({
    operationId: '1b4e28ba-2fa1-41d2-883f-0016d3cca427',
    action: 'propose',
    actor: { kind: 'TUTOR', accountId: 123, franchiseId: 6 },
    at: '2026-10-07T17:00:00.000Z',
    targetVersion: '5',
    before: request(),
    after: request(),
    amendment,
    supersededAmendment: null,
    changeReason: 'Flights moved by one day',
    decisionReason: null,
    calendarId: 'calendar@example.com',
    center,
    appOrigin: 'https://timecard.example.com',
    ...overrides
  }, () => `delivery-${(next += 1)}`);
};
const summary = (deliveries: ReturnType<typeof plan>) =>
  deliveries.map((delivery) => [delivery.channel, delivery.kind, delivery.recipient, delivery.status]);

describe('approved time-off change delivery planning', () => {
  it('notifies the center about tutor proposals, withdrawals, and expiry without calendar work', () => {
    assert.deepEqual(summary(plan({ action: 'propose' })), [['email', 'center_change_proposed', 'center@example.com', 'pending']]);
    assert.deepEqual(summary(plan({ action: 'withdraw' })), [['email', 'center_change_withdrawn', 'center@example.com', 'pending']]);
    assert.deepEqual(summary(plan({ action: 'expire', actor: { kind: 'SYSTEM', accountId: 0, franchiseId: 6 } })),
      [['email', 'center_change_expired', 'center@example.com', 'pending']]);
  });

  it('updates the calendar and the requester when a change takes effect', () => {
    const after = request({ endDate: '2026-11-18', endAt: '2026-11-19T08:00:00.000Z', durationHours: 72 });
    const deliveries = plan({ action: 'approve_amendment', actor: { kind: 'ADMIN', accountId: 9, franchiseId: 6 }, after });

    assert.deepEqual(summary(deliveries), [
      ['calendar', 'calendar_upsert', null, 'pending'],
      ['email', 'requester_change_approved', 'ada@example.com', 'pending']
    ]);
    const calendar = deliveries[0];
    assert.equal(calendar.recoveryEventId, 'tctimeoff1av5');
    assert.equal(calendar.identity, 'calendar@example.com');
    assert.equal(calendar.calendarId, 'calendar@example.com');
    const event = (calendar.payload as { event: { end: { date: string }; id?: string } }).event;
    assert.equal(event.end.date, '2026-11-19');
    assert.equal(event.id, undefined);
    assert.deepEqual((calendar.payload as { knownEventIds: string[] }).knownEventIds, ['tctimeoff1a']);
  });

  it('sends one combined requester message when an admin edit supersedes a proposal', () => {
    const deliveries = plan({
      action: 'admin_edit', actor: { kind: 'ADMIN', accountId: 9, franchiseId: 6 },
      amendment: null, supersededAmendment: amendment, changeReason: 'Coverage adjusted by the center'
    });
    const emails = deliveries.filter((delivery) => delivery.channel === 'email');
    assert.equal(emails.length, 1);
    assert.equal(emails[0].kind, 'requester_edited');
    assert.match(String((emails[0].payload as { text: string }).text), /replaces your pending change request/i);
  });

  it('confirms a tutor cancellation to the requester and tells the center', () => {
    assert.deepEqual(summary(plan({ action: 'cancel', amendment: null, after: request({ status: 'cancelled' }) })), [
      ['calendar', 'calendar_delete', null, 'pending'],
      ['email', 'center_cancelled', 'center@example.com', 'pending'],
      ['email', 'requester_cancel_confirmation', 'ada@example.com', 'pending']
    ]);
    assert.deepEqual(summary(plan({
      action: 'cancel', amendment: null, actor: { kind: 'ADMIN', accountId: 9, franchiseId: 6 },
      after: request({ status: 'cancelled' })
    })).map(([channel, kind]) => [channel, kind]), [['calendar', 'calendar_delete'], ['email', 'requester_cancelled']]);
  });

  it('records unroutable deliveries as visible failures instead of dropping them', () => {
    const deliveries = plan({ action: 'approve_amendment', actor: { kind: 'ADMIN', accountId: 9, franchiseId: 6 },
      center: { ...center, email: null, gmailId: null }, after: request({ tutorEmail: '' }) });
    assert.deepEqual(deliveries.map((delivery) => [delivery.kind, delivery.status]), [
      ['calendar_upsert', 'failed'],
      ['requester_change_approved', 'failed']
    ]);
    assert.ok(deliveries.every((delivery) => delivery.lastError));
  });

  it('links to authenticated review and never to an email decision token', () => {
    const [email] = plan({ action: 'propose' });
    const text = String((email.payload as { text: string }).text);
    assert.match(text, /https:\/\/timecard\.example\.com\/admin\/approvals\?tab=timeoff&franchiseId=6&requestId=42&view=manage&amendmentId=7/);
    assert.doesNotMatch(text, /timeoff\/decision|token=/);
    assert.doesNotMatch(text, /calendar (was|has been) (updated|synced)/i);
  });
});

describe('approved time-off change command validation', () => {
  const unreachablePool = { connect: async () => { throw new Error('database must not be reached'); } };
  const service = createTimeOffChangeService({
    pool: unreachablePool as never,
    resolveTimezone: async () => 'America/Los_Angeles',
    resolveNoticeRequired: async () => true,
    resolveContact: async () => center,
    overlapEnabled: () => false,
    appOrigin: 'https://timecard.example.com'
  });
  const base = {
    actor: { kind: 'TUTOR' as const, accountId: 123, franchiseId: 6 },
    requestId: 42,
    expectedVersion: '4',
    idempotencyKey: 'key-00000001',
    nowIso: '2026-10-07T17:00:00.000Z',
    action: 'cancel' as const,
    changeReason: 'Plans changed for the family'
  };

  it('rejects malformed identifiers, versions, and keys before touching the database', async () => {
    const cases: Array<Partial<TimeOffChangeCommand>> = [
      { requestId: 0 }, { expectedVersion: '04' }, { expectedVersion: '1.5' }, { expectedVersion: '99999999999999999999' },
      { idempotencyKey: 'short' }, { idempotencyKey: 'has spaces in it' }
    ];
    for (const overrides of cases) {
      await assert.rejects(service.execute({ ...base, ...overrides } as TimeOffChangeCommand),
        (error: { code?: string; status?: number }) => error.status === 400 && error.code === 'TIME_OFF_INVALID_INPUT',
        JSON.stringify(overrides));
    }
    await assert.rejects(service.execute({ ...base, action: 'withdraw', amendmentId: 'abc' } as TimeOffChangeCommand),
      (error: { status?: number }) => error.status === 400);
  });

  it('rejects reasons outside their length rules before touching the database', async () => {
    await assert.rejects(service.execute({ ...base, changeReason: 'too short' }),
      (error: { code?: string }) => error.code === 'TIME_OFF_INVALID_INPUT');
    await assert.rejects(service.execute({ ...base, action: 'deny_amendment', amendmentId: '7', reason: '  ' } as TimeOffChangeCommand),
      (error: { code?: string }) => error.code === 'TIME_OFF_INVALID_INPUT');
  });
});
