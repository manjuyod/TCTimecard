import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  cancelPendingTimeOff,
  createAuthenticatedTimeOff,
  findPendingTimeOffDecisionFranchiseId,
  fetchPendingTimeOffByDecisionTokenHash,
  storeTimeOffDecisionToken,
  updateTimeOffDecision
} from '../services/timeOffRepository';

const row = {
  id: 42,
  franchiseid: 6,
  tutorid: 123,
  bridge_flag: false,
  bridge_profile_id: null,
  first_name: 'Ada',
  last_name: 'Lovelace',
  email: 'ada@example.com',
  start_at: '2026-07-26T07:00:00.000Z',
  end_at: '2026-07-27T07:00:00.000Z',
  type: 'pto',
  absence_label: 'Paid Time Off',
  notes: 'Family vacation out of town',
  status: 'pending',
  created_at: '2026-07-12T18:00:00.000Z',
  created_by: 123,
  decided_at: null,
  decided_by: null,
  decision_reason: null,
  google_calendar_event_id: null,
  duration_hours: '24',
  partial_day: false,
  leave_time: null,
  return_time: null,
  public_metadata: { source: 'authenticated_timecard_app' }
} as const;

describe('time-off email decision persistence', () => {
  it('consumes the decision token when the tutor cancels a pending request', async () => {
    let statement = '';
    const db = {
      async query(sql: string) {
        statement = sql;
        return { rows: [{ ...row, status: 'cancelled', decision_reason: 'cancelled by tutor' }] };
      }
    };

    const cancelled = await cancelPendingTimeOff(42, 123, 'America/Los_Angeles', db as never);

    assert.equal(cancelled?.status, 'cancelled');
    assert.match(statement, /decision_token_used_at\s*=\s*NOW\(\)/i);
  });

  it('consumes the matching token while recording a nullable email actor', async () => {
    let statement = '';
    let values: unknown[] = [];
    const db = {
      async query(sql: string, params: unknown[]) {
        statement = sql;
        values = params;
        return { rows: [{ ...row, status: 'denied', decision_reason: 'Email correspondence' }] };
      }
    };

    const updated = await updateTimeOffDecision({
      client: db as never,
      requestId: 42,
      status: 'denied',
      actorId: null,
      reason: 'Email correspondence',
      calendarEventId: null,
      timezone: 'America/Los_Angeles',
      expectedTokenHash: 'e'.repeat(64),
      nowIso: '2026-07-12T18:00:00.000Z'
    });

    assert.equal(updated?.status, 'denied');
    assert.match(statement, /decision_token_used_at/i);
    assert.match(statement, /decision_token_hash\s*=\s*\$6/i);
    assert.match(statement, /decision_token_expires_at\s*>\s*\$7/i);
    assert.equal(values.includes(null), true);
    assert.equal(values.includes('e'.repeat(64)), true);
  });

  it('finds the franchise scope only for a usable pending token', async () => {
    let statement = '';
    const db = {
      async query(sql: string) {
        statement = sql;
        return { rows: [{ franchiseid: 6 }] };
      }
    };

    const franchiseId = await findPendingTimeOffDecisionFranchiseId({
      tokenHash: 'd'.repeat(64),
      nowIso: '2026-07-12T18:00:00.000Z',
      db: db as never
    });

    assert.equal(franchiseId, 6);
    assert.match(statement, /decision_token_used_at\s+IS\s+NULL/i);
    assert.match(statement, /decision_token_expires_at\s*>/i);
    assert.match(statement, /status\s*=\s*'pending'/i);
  });

  it('stores the token hash and expiry with an authenticated request', async () => {
    let statement = '';
    let values: unknown[] = [];
    const db = {
      async query(sql: string, params: unknown[]) {
        statement = sql;
        values = params;
        return { rows: [row] };
      }
    };

    const request = await createAuthenticatedTimeOff({
      franchiseId: 6,
      tutorId: 123,
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      submission: {
        startDate: '2026-07-26',
        endDate: '2026-07-26',
        startAt: '2026-07-26T07:00:00.000Z',
        endAt: '2026-07-27T07:00:00.000Z',
        type: 'pto',
        storageType: 'pto',
        absenceLabel: 'Paid Time Off',
        reason: 'Family vacation out of town',
        durationHours: 24,
        partialDay: false,
        leaveTime: null,
        returnTime: null
      },
      timezone: 'America/Los_Angeles',
      decisionToken: {
        tokenHash: 'c'.repeat(64),
        expiresAt: '2026-07-19T18:00:00.000Z'
      }
    }, db as never);

    assert.equal(request.id, 42);
    assert.match(statement, /decision_token_hash/i);
    assert.match(statement, /decision_token_expires_at/i);
    assert.equal(values.includes('c'.repeat(64)), true);
    assert.equal(values.includes('2026-07-19T18:00:00.000Z'), true);
  });

  it('rotates a token only while the request is pending', async () => {
    let statement = '';
    let values: unknown[] = [];
    const db = {
      async query(sql: string, params: unknown[]) {
        statement = sql;
        values = params;
        return { rows: [{ id: 42 }] };
      }
    };

    const stored = await storeTimeOffDecisionToken({
      requestId: 42,
      tokenHash: 'a'.repeat(64),
      expiresAt: '2026-07-19T18:00:00.000Z',
      db: db as never
    });

    assert.equal(stored, true);
    assert.match(statement, /status\s*=\s*'pending'/i);
    assert.match(statement, /decision_token_used_at\s*=\s*NULL/i);
    assert.deepEqual(values, [42, 'a'.repeat(64), '2026-07-19T18:00:00.000Z']);
  });

  it('fetches only an unconsumed, unexpired pending token', async () => {
    let statement = '';
    let values: unknown[] = [];
    const db = {
      async query(sql: string, params: unknown[]) {
        statement = sql;
        values = params;
        return { rows: [row] };
      }
    };

    const request = await fetchPendingTimeOffByDecisionTokenHash({
      tokenHash: 'b'.repeat(64),
      nowIso: '2026-07-12T18:00:00.000Z',
      timezone: 'America/Los_Angeles',
      db: db as never,
      forUpdate: true
    });

    assert.equal(request?.id, 42);
    assert.match(statement, /decision_token_used_at\s+IS\s+NULL/i);
    assert.match(statement, /decision_token_expires_at\s*>\s*\$2/i);
    assert.match(statement, /status\s*=\s*'pending'/i);
    assert.match(statement, /FOR UPDATE/i);
    assert.deepEqual(values, ['b'.repeat(64), '2026-07-12T18:00:00.000Z']);
  });
});
