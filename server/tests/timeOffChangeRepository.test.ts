import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  findTimeOffChangeReplay,
  hashTimeOffChangeCommand,
  lockTimeOffChangeRequest,
  readTimeOffChangeDetail
} from '../services/timeOffChangeRepository';
import type { TimeOffSubmissionInput } from '../types/timeoff';
import type { CommandMeta, TimeOffChangeReceipt } from '../types/timeOffChanges';

const requestRow = {
  id: '42',
  franchiseid: 6,
  tutorid: 123,
  bridge_flag: false,
  bridge_profile_id: null,
  first_name: 'Ada',
  last_name: 'Lovelace',
  email: 'ada@example.com',
  start_at: '2026-11-16T08:00:00.000Z',
  end_at: '2026-11-17T08:00:00.000Z',
  type: 'pto',
  absence_label: 'Paid Time Off',
  notes: 'Family vacation out of town',
  status: 'approved',
  created_at: '2026-10-01T18:00:00.000Z',
  created_by: 123,
  decided_at: '2026-10-02T18:00:00.000Z',
  decided_by: 9,
  decision_reason: 'Approved',
  google_calendar_event_id: 'tctimeoff1a',
  duration_hours: '24',
  partial_day: false,
  leave_time: null,
  return_time: null,
  public_metadata: { source: 'authenticated_timecard_app' },
  version: '9007199254740993',
  google_calendar_id: 'center@example.com'
};

const receipt: TimeOffChangeReceipt = {
  operationId: '1b4e28ba-2fa1-41d2-883f-0016d3cca427',
  requestId: 42,
  version: '9007199254740994',
  amendmentId: '7',
  outcome: 'proposed',
  deliveryIds: ['5f0c2b6e-8f43-4d1a-9b65-2c3a4d5e6f70']
};

const tutor = { kind: 'TUTOR' as const, accountId: 123, franchiseId: 6 };

type ProposeCommand = CommandMeta & { action: 'propose'; proposed: TimeOffSubmissionInput; changeReason: string };
const proposeCommand = (overrides: Partial<ProposeCommand> = {}): ProposeCommand => ({
  actor: tutor,
  requestId: 42,
  expectedVersion: '9007199254740993',
  idempotencyKey: 'key-0001',
  nowIso: '2026-10-07T12:00:00.000Z',
  action: 'propose' as const,
  proposed: {
    startDate: '2026-11-16',
    endDate: '2026-11-17',
    partialDay: false,
    type: 'pto',
    reason: 'Family vacation out of town'
  },
  changeReason: 'Flights moved by one day',
  ...overrides
});

const fakeClient = (handler: (sql: string, params: unknown[]) => { rows: unknown[] }) => ({
  calls: [] as Array<{ sql: string; params: unknown[] }>,
  async query(sql: string, params: unknown[] = []) {
    this.calls.push({ sql, params });
    return handler(sql, params);
  }
});

describe('time-off change repository', () => {
  it('keeps BIGINT request versions as exact decimal strings when locking', async () => {
    const client = fakeClient(() => ({ rows: [requestRow] }));
    const locked = await lockTimeOffChangeRequest(client as never, 42, 'America/Los_Angeles');

    assert.equal(locked?.version, '9007199254740993');
    assert.equal(locked?.request.id, 42);
    assert.match(client.calls[0].sql, /FOR UPDATE/);
  });

  it('version remains precise in change detail', async () => {
    const client = fakeClient((sql) => {
      if (/FROM public\.time_off_requests/.test(sql)) return { rows: [requestRow] };
      return { rows: [] };
    });
    const detail = await readTimeOffChangeDetail(client as never, 42, 'America/Los_Angeles');

    assert.equal(detail?.version, '9007199254740993');
    assert.equal(detail?.pendingAmendment, null);
    assert.deepEqual(detail?.allowedActions, []);
    assert.match(client.calls[0].sql, /^(?![\s\S]*FOR UPDATE)/);
  });

  it('same actor key replays the exact saved receipt', async () => {
    const hash = hashTimeOffChangeCommand(proposeCommand());
    const client = fakeClient(() => ({ rows: [{ input_hash: hash, response: receipt }] }));

    const replay = await findTimeOffChangeReplay(client as never, tutor, 'key-0001', hash);

    assert.deepEqual(replay, receipt);
    assert.deepEqual(client.calls[0].params, ['TUTOR', 123, 6, 'key-0001']);
  });

  it('rejects reuse of a key with a changed payload', async () => {
    const original = hashTimeOffChangeCommand(proposeCommand());
    const changed = hashTimeOffChangeCommand(proposeCommand({ changeReason: 'A different change reason' }));
    const client = fakeClient(() => ({ rows: [{ input_hash: original, response: receipt }] }));

    await assert.rejects(
      findTimeOffChangeReplay(client as never, tutor, 'key-0001', changed),
      (error: { code?: string; status?: number }) =>
        error.code === 'TIME_OFF_IDEMPOTENCY_MISMATCH' && error.status === 409
    );
  });

  it('returns no replay when the scoped key is unused', async () => {
    const client = fakeClient(() => ({ rows: [] }));
    assert.equal(await findTimeOffChangeReplay(client as never, tutor, 'key-0001', 'abc'), null);
  });

  it('hashes the normalized command but not the server receipt time or key', () => {
    const base = hashTimeOffChangeCommand(proposeCommand());
    const sameMeaning = hashTimeOffChangeCommand(proposeCommand({
      nowIso: '2026-10-07T13:30:00.000Z',
      idempotencyKey: 'key-0002',
      changeReason: '  Flights moved by one day  ',
      proposed: {
        reason: 'Family vacation out of town ',
        type: 'PTO',
        partialDay: 'false',
        endDate: '2026-11-17',
        startDate: '2026-11-16'
      }
    }));

    assert.equal(sameMeaning, base);
    assert.notEqual(hashTimeOffChangeCommand(proposeCommand({ expectedVersion: '9007199254740994' })), base);
    assert.notEqual(hashTimeOffChangeCommand(proposeCommand({ requestId: 43 })), base);
    assert.notEqual(hashTimeOffChangeCommand({ ...proposeCommand(), action: 'admin_edit' }), base);
  });
});
