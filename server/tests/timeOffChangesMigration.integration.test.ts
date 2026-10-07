import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import {
  findTimeOffChangeReplay,
  isTimeOffChangeKeyConflict,
  persistTimeOffChangeOperation,
  readTimeOffChangeDetail,
  type TimeOffChangeOperationInput
} from '../services/timeOffChangeRepository';
import {
  inTransaction,
  readMigration,
  seedTimeOffRequest,
  startTimeOffChangesDatabase,
  timeOffChangesDatabaseEnabled,
  withClient,
  type TimeOffChangesDatabase
} from './helpers/timeOffChangesDatabase';

const skip = !timeOffChangesDatabaseEnabled;
let database: TimeOffChangesDatabase | undefined;
const db = () => {
  assert.ok(database);
  return database.pool;
};

const amendmentValues = (requestId: number) => [
  requestId, '2026-11-18', '2026-11-18', '2026-11-18T08:00:00.000Z', '2026-11-19T08:00:00.000Z'
];
const insertAmendment = (requestId: number) => db().query(`
  INSERT INTO public.time_off_amendments
    (request_id, base_version, start_date, end_date, start_at, end_at, partial_day, type, storage_type,
     absence_label, reason, duration_hours, timezone, change_reason, proposed_by)
  VALUES ($1, 2, $2, $3, $4, $5, FALSE, 'sick', 'sick', 'Sick Leave', 'Doctor appointment moved',
    24, 'America/Los_Angeles', 'The appointment moved', 4401)
  RETURNING id
`, amendmentValues(requestId));

const operation = (requestId: number, overrides: Partial<TimeOffChangeOperationInput> = {}): TimeOffChangeOperationInput => {
  const id = overrides.id ?? randomUUID();
  return {
    id,
    requestId,
    actorType: 'TUTOR',
    actorId: 4401,
    franchiseId: 44,
    action: 'cancel',
    amendmentId: null,
    expectedVersion: '1',
    resultVersion: '2',
    idempotencyKey: 'cancel-key-0001',
    inputHash: 'hash-a',
    before: { status: 'approved' },
    after: { status: 'cancelled' },
    target: null,
    changeReason: 'Plans changed for the family',
    response: {
      operationId: id,
      requestId,
      version: '2',
      amendmentId: null,
      outcome: 'cancelled',
      deliveryIds: []
    },
    ...overrides
  };
};

describe('approved time-off change storage', { skip }, () => {
  before(async () => {
    database = await startTimeOffChangesDatabase();
  });
  after(async () => {
    await database?.stop();
  });

  it('applies idempotently on top of the deployed chain', async () => {
    await db().query(readMigration('0016_approved_time_off_changes.sql'));
  });

  it('adds versions and calendar ids without fabricating calendar ids for existing requests', async () => {
    const requestId = await seedTimeOffRequest(db(), { googleCalendarEventId: 'tctimeofflegacy' });
    const row = await db().query('SELECT version::TEXT AS version, google_calendar_id, last_change_operation_id FROM public.time_off_requests WHERE id = $1', [requestId]);
    assert.deepEqual(row.rows[0], { version: '1', google_calendar_id: null, last_change_operation_id: null });
  });

  it('one pending amendment per request rejects the second insert', async () => {
    const requestId = await seedTimeOffRequest(db());
    await insertAmendment(requestId);
    await assert.rejects(insertAmendment(requestId), /time_off_amendments_one_pending_idx/);
  });

  it('terminal amendments are immutable', async () => {
    const requestId = await seedTimeOffRequest(db());
    const amendment = await insertAmendment(requestId);
    await db().query(`UPDATE public.time_off_amendments
      SET status = 'denied', decided_by_type = 'ADMIN', decided_by = 9, decided_at = NOW(), decision_reason = 'No'
      WHERE id = $1`, [amendment.rows[0].id]);
    await assert.rejects(
      db().query("UPDATE public.time_off_amendments SET status = 'approved' WHERE id = $1", [amendment.rows[0].id]),
      /terminal/i
    );
    await assert.rejects(db().query('DELETE FROM public.time_off_amendments WHERE id = $1', [amendment.rows[0].id]), /immutable|cannot/i);
  });

  it('pending amendment proposed fields are frozen', async () => {
    const requestId = await seedTimeOffRequest(db());
    const amendment = await insertAmendment(requestId);
    await assert.rejects(
      db().query("UPDATE public.time_off_amendments SET reason = 'Another long reason' WHERE id = $1", [amendment.rows[0].id]),
      /frozen|immutable/i
    );
  });

  it('version remains precise', async () => {
    const requestId = await seedTimeOffRequest(db(), { version: '9007199254740993' });
    const detail = await withClient(db(), (client) => readTimeOffChangeDetail(client, requestId, 'America/Los_Angeles'));
    assert.equal(detail?.version, '9007199254740993');
  });

  it('same actor key replays the exact saved receipt and scopes keys by actor and franchise', async () => {
    const requestId = await seedTimeOffRequest(db());
    const firstReceipt = await inTransaction(db(), (client) => persistTimeOffChangeOperation(client, operation(requestId)));

    const replay = await withClient(db(), (client) =>
      findTimeOffChangeReplay(client, { kind: 'TUTOR', accountId: 4401, franchiseId: 44 }, 'cancel-key-0001', 'hash-a'));
    assert.deepEqual(replay, firstReceipt);

    await assert.rejects(
      withClient(db(), (client) =>
        findTimeOffChangeReplay(client, { kind: 'TUTOR', accountId: 4401, franchiseId: 44 }, 'cancel-key-0001', 'hash-b')),
      (error: { code?: string }) => error.code === 'TIME_OFF_IDEMPOTENCY_MISMATCH'
    );
    assert.equal(await withClient(db(), (client) =>
      findTimeOffChangeReplay(client, { kind: 'ADMIN', accountId: 4401, franchiseId: 44 }, 'cancel-key-0001', 'hash-a')), null);
    assert.equal(await withClient(db(), (client) =>
      findTimeOffChangeReplay(client, { kind: 'TUTOR', accountId: 4402, franchiseId: 44 }, 'cancel-key-0001', 'hash-a')), null);
    assert.equal(await withClient(db(), (client) =>
      findTimeOffChangeReplay(client, { kind: 'TUTOR', accountId: 4401, franchiseId: 45 }, 'cancel-key-0001', 'hash-a')), null);
  });

  it('operation records are immutable', async () => {
    const requestId = await seedTimeOffRequest(db());
    const saved = operation(requestId, { idempotencyKey: 'immutable-key-0001' });
    await inTransaction(db(), (client) => persistTimeOffChangeOperation(client, saved));
    await assert.rejects(
      db().query("UPDATE public.time_off_change_operations SET change_reason = 'rewritten history' WHERE id = $1", [saved.id]),
      /immutable/i
    );
    await assert.rejects(db().query('DELETE FROM public.time_off_change_operations WHERE id = $1', [saved.id]), /immutable/i);
  });

  it('concurrent use of one key commits once and the loser recovers the winner by fetch', async () => {
    const requestId = await seedTimeOffRequest(db());
    const [first, second] = await Promise.all([db().connect(), db().connect()]);
    try {
      await first.query('BEGIN');
      await second.query('BEGIN');
      const winner = operation(requestId, { idempotencyKey: 'race-key-0001' });
      await persistTimeOffChangeOperation(first, winner);
      const loser = persistTimeOffChangeOperation(second, operation(requestId, { idempotencyKey: 'race-key-0001' }));
      await new Promise((resolve) => setTimeout(resolve, 200));
      await first.query('COMMIT');
      const failure = await loser.then(() => null, (error: unknown) => error);
      assert.ok(isTimeOffChangeKeyConflict(failure), `expected key conflict, got ${String(failure)}`);
      await second.query('ROLLBACK');
      const recovered = await findTimeOffChangeReplay(second, { kind: 'TUTOR', accountId: 4401, franchiseId: 44 },
        'race-key-0001', 'hash-a');
      assert.equal(recovered?.operationId, winner.id);
    } finally {
      await first.query('ROLLBACK').catch(() => undefined);
      first.release();
      second.release();
    }
  });

  it('system expiry uses the reserved actor id and users must be positive', async () => {
    const requestId = await seedTimeOffRequest(db());
    await inTransaction(db(), (client) => persistTimeOffChangeOperation(client, operation(requestId, {
      actorType: 'SYSTEM', actorId: 0, action: 'expire', idempotencyKey: 'expire-key-0001', changeReason: null
    })));
    await assert.rejects(inTransaction(db(), (client) => persistTimeOffChangeOperation(client, operation(requestId, {
      actorType: 'TUTOR', actorId: 0, idempotencyKey: 'zero-actor-0001'
    }))), /check constraint/i);
  });

  it('delivery rows index due work and reject unknown channels', async () => {
    const requestId = await seedTimeOffRequest(db());
    const saved = operation(requestId, { idempotencyKey: 'delivery-key-0001' });
    await inTransaction(db(), (client) => persistTimeOffChangeOperation(client, saved));
    const insert = (channel: string, dedupe: string) => db().query(`
      INSERT INTO public.time_off_change_deliveries
        (id, operation_id, request_id, channel, kind, target_version, payload, recipient, dedupe_key, next_attempt_at)
      VALUES ($1, $2, $3, $4, 'requester_cancelled', 2, '{}'::JSONB, 'ada@example.com', $5, NOW())
    `, [randomUUID(), saved.id, requestId, channel, dedupe]);
    await insert('email', `email:${saved.id}:requester`);
    await assert.rejects(insert('sms', `sms:${saved.id}`), /check constraint/i);
    await assert.rejects(insert('email', `email:${saved.id}:requester`), /duplicate key/i);
    const detail = await withClient(db(), (client) => readTimeOffChangeDetail(client, requestId, 'America/Los_Angeles'));
    assert.equal(detail?.deliveries.length, 1);
    assert.equal(detail?.deliveries[0].status, 'pending');
    assert.equal(detail?.history[0].operationId, saved.id);
    assert.equal(detail?.history[0].reason, 'Plans changed for the family');
  });
});
