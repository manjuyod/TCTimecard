import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { Pool, PoolClient } from 'pg';
import { createPostgresPtoStore } from '../services/pto';
import { createPtoRouteStore } from '../services/pto/routeStore';
import { applyApprovedTimeOffChange, quoteApprovedTimeOffChange } from '../services/pto/timeOffChanges';
import { persistTimeOffChangeOperation } from '../services/timeOffChangeRepository';
import type { NormalizedTimeOffSubmission } from '../types/timeoff';
import type { TimeOffChangeOperationAction } from '../types/timeOffChanges';
import {
  approvedPto as approvedPtoIn,
  inTransaction,
  linkLogin as linkLoginIn,
  resetTimeOffChangesSchema,
  seedPtoTutor as seedPtoTutorIn,
  seedTimeOffRequest,
  startTimeOffChangesDatabase,
  timeOffChangesDatabaseEnabled,
  waitForLockWait,
  type TimeOffChangesDatabase
} from './helpers/timeOffChangesDatabase';

const skip = !timeOffChangesDatabaseEnabled;
const withCode = (code: string) => (error: unknown) => (error as { code?: string } | null)?.code === code;
let database: TimeOffChangesDatabase | undefined;
const db = (): Pool => {
  assert.ok(database);
  return database.pool;
};

const DAY_MS = 86_400_000;
const nextDate = (date: string, days = 1) => new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
const dayCount = (startDate: string, endDate: string) =>
  Math.round((Date.parse(`${endDate}T00:00:00.000Z`) - Date.parse(`${startDate}T00:00:00.000Z`)) / DAY_MS) + 1;

const fullDays = (startDate: string, endDate: string, overrides: Partial<NormalizedTimeOffSubmission> = {}): NormalizedTimeOffSubmission => ({
  startDate,
  endDate,
  startAt: `${startDate}T08:00:00.000Z`,
  endAt: `${nextDate(endDate)}T08:00:00.000Z`,
  partialDay: false,
  leaveTime: null,
  returnTime: null,
  type: 'pto',
  storageType: 'pto',
  absenceLabel: 'Paid Time Off',
  reason: 'Original request reason text',
  durationHours: dayCount(startDate, endDate) * 24,
  ...overrides
});
const unpaid = (startDate: string, endDate: string) =>
  fullDays(startDate, endDate, { type: 'unpaid', storageType: 'unpaid', absenceLabel: 'Unpaid Time Off' });

const seedPtoTutor = (input: Parameters<typeof seedPtoTutorIn>[1] = {}) => seedPtoTutorIn(db(), input);
const linkLogin = (profileId: string, franchiseId: number, tutorId: number, withCrmId = false) =>
  linkLoginIn(db(), profileId, franchiseId, tutorId, withCrmId);
const approvedPto = (startDate: string, endDate = startDate, input: Parameters<typeof approvedPtoIn>[3] = {}) =>
  approvedPtoIn(db(), startDate, endDate, input);

async function applyChange(
  client: PoolClient,
  requestId: number,
  action: TimeOffChangeOperationAction,
  target: NormalizedTimeOffSubmission | null,
  options: { expectedVersion?: string; operationId?: string; franchiseId?: number } = {}
): Promise<string> {
  const expectedVersion = options.expectedVersion ?? (await client.query<{ version: string }>(
    'SELECT version::TEXT AS version FROM public.time_off_requests WHERE id = $1', [requestId]
  )).rows[0].version;
  const id = options.operationId ?? randomUUID();
  const resultVersion = (BigInt(expectedVersion) + 1n).toString();
  await persistTimeOffChangeOperation(client, {
    id,
    requestId,
    actorType: 'ADMIN',
    actorId: 9,
    franchiseId: options.franchiseId ?? 44,
    action,
    amendmentId: null,
    expectedVersion,
    resultVersion,
    idempotencyKey: id,
    inputHash: 'test-hash',
    before: {},
    after: {},
    target,
    changeReason: 'Change reason for the test',
    response: {
      operationId: id, requestId, version: resultVersion, amendmentId: null,
      outcome: action === 'cancel' ? 'cancelled' : 'edited', deliveryIds: []
    }
  });
  return applyApprovedTimeOffChange(client, id);
}

const change = (
  requestId: number,
  action: TimeOffChangeOperationAction,
  target: NormalizedTimeOffSubmission | null,
  options: { franchiseId?: number } = {}
) => inTransaction(db(), (client) => applyChange(client, requestId, action, target, options));

const balance = (profileId: string, date = '2026-11-16') => createPtoRouteStore(db()).getBalanceSummary(profileId, date);
const ledger = async (requestId: number) => (await db().query<{
  id: string; event_type: string; balance_delta: string; reserved_delta: string; idempotency_key: string;
  source_membership_id: string | null;
}>(`SELECT id::TEXT AS id, event_type, balance_delta::TEXT AS balance_delta, reserved_delta::TEXT AS reserved_delta,
      idempotency_key, source_membership_id::TEXT AS source_membership_id
    FROM public.pto_ledger_entries WHERE request_id = $1 ORDER BY id`, [requestId])).rows;
const allocations = async (requestId: number) => (await db().query<{ id: string; charged_days: string; state: string; starts_on: string }>(
  `SELECT allocation.id::TEXT AS id, allocation.charged_days::TEXT AS charged_days, allocation.state,
     cycle.starts_on::TEXT AS starts_on
   FROM public.pto_request_allocations allocation
   JOIN public.pto_entitlement_cycles cycle ON cycle.id = allocation.cycle_id
   WHERE allocation.request_id = $1 ORDER BY cycle.starts_on`, [requestId])).rows;
const requestRow = async (requestId: number) => (await db().query<{
  status: string; version: string; start_date: string; type: string; leave_time: string | null;
}>(`SELECT status, version::TEXT AS version, public_metadata ->> 'startDate' AS start_date, type, leave_time::TEXT AS leave_time
    FROM public.time_off_requests WHERE id = $1`, [requestId])).rows[0];

before(async () => {
  if (!skip) database = await startTimeOffChangesDatabase();
});
after(async () => {
  await database?.stop();
});

describe('approved time-off PTO reconciliation', { skip }, () => {
  beforeEach(async () => {
    await resetTimeOffChangesSchema(db());
  });

  it('replacements reprice one allocation and append deltas while retaining all history', async () => {
    const tutor = await seedPtoTutor();
    const requestId = await approvedPto('2026-11-16', '2026-11-17');
    assert.equal((await balance(tutor.profileId)).availableDays, 3);
    assert.equal((await requestRow(requestId)).version, '2');
    const [original] = await allocations(requestId);
    const originalLedger = await ledger(requestId);

    assert.equal(await change(requestId, 'admin_edit', fullDays('2026-11-16', '2026-11-18')), '3');
    let summary = await balance(tutor.profileId);
    assert.equal(summary.availableDays, 2);
    assert.equal(summary.usedDays, 3);
    assert.deepEqual(await allocations(requestId), [{ ...original, charged_days: '3.00' }]);
    const increased = (await ledger(requestId)).slice(originalLedger.length);
    assert.equal(increased.length, 1);
    assert.equal(increased[0].event_type, 'consume');
    assert.equal(increased[0].balance_delta, '-1.00');
    assert.equal(increased[0].reserved_delta, '0.00');
    assert.match(increased[0].idempotency_key, new RegExp(`^change-consume:[0-9a-f-]{36}:${original.id}$`));
    assert.equal(increased[0].source_membership_id, tutor.membershipId);

    await change(requestId, 'admin_edit', fullDays('2026-11-16', '2026-11-16'));
    summary = await balance(tutor.profileId);
    assert.equal(summary.availableDays, 4);
    assert.equal(summary.usedDays, 1);

    assert.equal(await change(requestId, 'cancel', null), '5');
    summary = await balance(tutor.profileId);
    assert.equal(summary.availableDays, 5);
    assert.equal(summary.usedDays, 0);
    assert.equal((await requestRow(requestId)).status, 'cancelled');
    assert.deepEqual(await allocations(requestId), [{ ...original, charged_days: '1.00', state: 'released' }]);
    const finalLedger = await ledger(requestId);
    assert.deepEqual(finalLedger.slice(0, originalLedger.length), originalLedger);
    assert.equal(finalLedger.some((entry) => entry.idempotency_key.startsWith('release:')), false,
      'approved cancellation must not also run the legacy status refund');
    assert.equal((await db().query('SELECT COUNT(*)::INT AS count FROM public.time_off_requests')).rows[0].count, 1);
  });

  it('paid to unpaid refunds actual consumption and unpaid to paid consumes only the new charge', async () => {
    const tutor = await seedPtoTutor();
    const requestId = await approvedPto('2026-11-16', '2026-11-17');

    await change(requestId, 'admin_edit', unpaid('2026-11-16', '2026-11-17'));
    assert.equal((await balance(tutor.profileId)).availableDays, 5);
    assert.equal((await balance(tutor.profileId)).usedDays, 0);
    assert.deepEqual((await allocations(requestId)).map(({ charged_days, state }) => [charged_days, state]), [['2.00', 'released']]);
    assert.equal((await requestRow(requestId)).type, 'unpaid');

    await change(requestId, 'admin_edit', fullDays('2026-11-16', '2026-11-16'));
    assert.equal((await balance(tutor.profileId)).availableDays, 4);
    assert.deepEqual((await allocations(requestId)).map(({ charged_days, state }) => [charged_days, state]), [['1.00', 'consumed']]);
  });

  it('a cross-cycle move cannot spend the old cycle credit in the new cycle', async () => {
    const tutor = await seedPtoTutor();
    const requestId = await approvedPto('2026-12-30', '2026-12-31');
    const cycle = await db().query<{ id: string }>('SELECT public.pto_get_or_create_cycle($1, DATE \'2027-01-04\') AS id', [tutor.profileId]);
    await db().query(`INSERT INTO public.pto_ledger_entries
      (profile_id, cycle_id, event_type, balance_delta, idempotency_key, metadata, source_membership_id)
      VALUES ($1, $2, 'adjustment', -4, 'test-adjust-2027', '{"reason":"test"}', $3)`,
    [tutor.profileId, cycle.rows[0].id, tutor.membershipId]);

    await assert.rejects(change(requestId, 'admin_edit', fullDays('2027-01-04', '2027-01-05')), withCode('PTO_INSUFFICIENT_BALANCE'));
    assert.equal((await requestRow(requestId)).start_date, '2026-12-30');
    assert.equal((await balance(tutor.profileId, '2026-12-30')).availableDays, 3);
    assert.equal((await balance(tutor.profileId, '2027-01-04')).availableDays, 1);

    await change(requestId, 'admin_edit', fullDays('2027-01-04', '2027-01-04'));
    assert.equal((await balance(tutor.profileId, '2026-12-30')).availableDays, 5);
    assert.equal((await balance(tutor.profileId, '2027-01-04')).availableDays, 0);
    assert.deepEqual((await allocations(requestId)).map(({ starts_on, charged_days, state }) => [starts_on, charged_days, state]), [
      ['2026-01-01', '2.00', 'released'],
      ['2027-01-01', '1.00', 'consumed']
    ]);
  });

  it('two centers sharing one balance cannot overspend under concurrent edits', async () => {
    const tutor = await seedPtoTutor();
    await linkLogin(tutor.profileId, 45, 4501, true);
    const first = await approvedPto('2026-11-16');
    const second = await approvedPto('2026-11-23', '2026-11-23', { franchiseId: 45, tutorId: 4501 });
    assert.equal((await balance(tutor.profileId)).availableDays, 3);

    const [left, right] = [await db().connect(), await db().connect()];
    try {
      const rightPid = (await right.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await left.query('BEGIN');
      await right.query('BEGIN');
      await applyChange(left, first, 'admin_edit', fullDays('2026-11-16', '2026-11-18'));
      const contender = applyChange(right, second, 'admin_edit', fullDays('2026-11-23', '2026-11-25'), { franchiseId: 45 })
        .then(() => null, (error: unknown) => error);
      await waitForLockWait(db(), rightPid);
      await left.query('COMMIT');
      assert.equal((await contender as { code?: string }).code, 'PTO_INSUFFICIENT_BALANCE');
      await right.query('ROLLBACK');
    } finally {
      left.release();
      right.release();
    }
    assert.equal((await balance(tutor.profileId)).availableDays, 1);
  });

  it('competing edit and cancellation at one version apply exactly one', async () => {
    const tutor = await seedPtoTutor();
    const requestId = await approvedPto('2026-11-16', '2026-11-17');
    const version = (await requestRow(requestId)).version;
    const [left, right] = [await db().connect(), await db().connect()];
    try {
      const rightPid = (await right.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await left.query('BEGIN');
      await right.query('BEGIN');
      await applyChange(left, requestId, 'admin_edit', fullDays('2026-11-16', '2026-11-18'), { expectedVersion: version });
      const cancellation = applyChange(right, requestId, 'cancel', null, { expectedVersion: version })
        .then(() => null, (error: unknown) => error);
      await waitForLockWait(db(), rightPid);
      await left.query('COMMIT');
      assert.equal((await cancellation as { code?: string }).code, 'TIME_OFF_VERSION_CONFLICT');
      await right.query('ROLLBACK');
    } finally {
      left.release();
      right.release();
    }
    assert.equal((await requestRow(requestId)).status, 'approved');
    assert.equal((await balance(tutor.profileId)).availableDays, 2);
    assert.equal((await ledger(requestId)).filter((entry) => entry.idempotency_key.startsWith('change-')).length, 1);
  });

  it('repeating an applied operation adds no ledger entries', async () => {
    await seedPtoTutor();
    const requestId = await approvedPto('2026-11-16', '2026-11-17');
    const operationId = randomUUID();
    await inTransaction(db(), async (client) => {
      assert.equal(await applyChange(client, requestId, 'admin_edit', fullDays('2026-11-16', '2026-11-18'), { operationId }), '3');
      const countLedger = async () => (await client.query('SELECT COUNT(*)::INT AS count FROM public.pto_ledger_entries WHERE request_id = $1', [requestId])).rows[0].count;
      const count = await countLedger();
      assert.equal(await applyApprovedTimeOffChange(client, operationId), '3');
      assert.equal(await countLedger(), count);
    });
    const committed = (await ledger(requestId)).length;
    assert.equal(await inTransaction(db(), (client) => applyApprovedTimeOffChange(client, operationId)), '3');
    assert.equal((await ledger(requestId)).length, committed);
  });

  it('weekend and partial-day replacements follow the shared day charges', async () => {
    const tutor = await seedPtoTutor();
    const requestId = await approvedPto('2026-11-16');
    assert.equal((await balance(tutor.profileId)).availableDays, 4);

    await change(requestId, 'admin_edit', fullDays('2026-11-20', '2026-11-22'));
    assert.equal((await balance(tutor.profileId)).availableDays, 3.5);
    assert.equal((await allocations(requestId))[0].charged_days, '1.50');

    await change(requestId, 'admin_edit', {
      ...fullDays('2026-11-23', '2026-11-23'),
      partialDay: true,
      leaveTime: '09:00',
      returnTime: '12:00',
      startAt: '2026-11-23T17:00:00.000Z',
      endAt: '2026-11-23T20:00:00.000Z',
      durationHours: 3
    });
    assert.equal((await balance(tutor.profileId)).availableDays, 4.5);
    assert.equal((await requestRow(requestId)).leave_time, '09:00:00');
  });

  it('non-January renewal policies price replacement cycles from the database', async () => {
    const tutor = await seedPtoTutor();
    await db().query(`INSERT INTO public.pto_policies (effective_from, entitlement_days, renewal_month, renewal_day)
      VALUES ('2027-07-01', 8, 7, 1)`);
    const requestId = await approvedPto('2027-08-02');
    assert.equal((await balance(tutor.profileId, '2027-08-02')).availableDays, 7);

    const quote = await inTransaction(db(), (client) =>
      quoteApprovedTimeOffChange(client, requestId, fullDays('2027-08-02', '2027-08-04')));
    assert.equal(quote.eligible, true);
    assert.equal(quote.tracked, true);
    assert.deepEqual(quote.cycles, [{ cycleStart: '2027-07-01', oldDays: 1, newDays: 3, availableDays: 7, availableAfter: 5 }]);

    await change(requestId, 'admin_edit', fullDays('2027-08-02', '2027-08-04'));
    assert.equal((await balance(tutor.profileId, '2027-08-02')).availableDays, 5);
  });

  it('previews never write and report insufficient replacement balance', async () => {
    const tutor = await seedPtoTutor();
    const requestId = await approvedPto('2026-11-16', '2026-11-17');
    const before = (await ledger(requestId)).length;
    const cycles = (await db().query('SELECT COUNT(*)::INT AS count FROM public.pto_entitlement_cycles')).rows[0].count;

    const quote = await inTransaction(db(), (client) =>
      quoteApprovedTimeOffChange(client, requestId, fullDays('2026-11-16', '2026-11-24')));
    assert.equal(quote.eligible, false);
    assert.equal(quote.reason, 'insufficient_balance');
    assert.deepEqual(quote.cycles, [{ cycleStart: '2026-01-01', oldDays: 2, newDays: 7.5, availableDays: 3, availableAfter: -2.5 }]);
    const crossYear = await inTransaction(db(), (client) =>
      quoteApprovedTimeOffChange(client, requestId, fullDays('2027-01-04', '2027-01-05')));
    assert.deepEqual(crossYear.cycles.map((cycle) => [cycle.cycleStart, cycle.oldDays, cycle.newDays, cycle.availableDays]), [
      ['2026-01-01', 2, 0, 3],
      ['2027-01-01', 0, 2, 5]
    ]);
    assert.equal((await ledger(requestId)).length, before);
    assert.equal((await db().query('SELECT COUNT(*)::INT AS count FROM public.pto_entitlement_cycles')).rows[0].count, cycles);
    assert.equal((await balance(tutor.profileId)).availableDays, 3);
  });

  it('merged profiles reconcile against the canonical shared balance', async () => {
    const target = await seedPtoTutor({ franchiseId: 46, tutorId: 4601, email: 'ada46@example.com' });
    const source = await seedPtoTutor();
    const requestId = await approvedPto('2026-11-16');
    const candidate = await db().query<{ id: string }>(`INSERT INTO public.pto_profile_match_candidates
      (left_profile_id, right_profile_id) VALUES ($1, $2) RETURNING id`, [target.profileId, source.profileId]);
    await db().query('SELECT public.pto_admin_decide_alias($1, \'confirm\', \'admin-44\', 44)', [candidate.rows[0].id]);

    await change(requestId, 'admin_edit', fullDays('2026-11-16', '2026-11-17'));
    assert.equal((await balance(target.profileId)).availableDays, 3);
    assert.equal((await balance(source.profileId)).availableDays, 3);
  });

  it('a detached center carries the current consumption and later reductions follow the allocation', async () => {
    const tutor = await seedPtoTutor();
    const requestId = await approvedPto('2026-11-16', '2026-11-17');
    await change(requestId, 'admin_edit', fullDays('2026-11-16', '2026-11-18'));
    const detached = await db().query<{ id: string }>(
      'SELECT public.pto_admin_detach_membership($1, $2, \'admin-44\', 44) AS id', [tutor.profileId, tutor.membershipId]);
    const detachedProfileId = detached.rows[0].id;
    assert.equal((await balance(detachedProfileId)).availableDays, 2);

    await change(requestId, 'admin_edit', fullDays('2026-11-16', '2026-11-16'));
    assert.equal((await balance(detachedProfileId)).availableDays, 4);
  });

  it('a disabled center still refunds reductions but blocks increases', async () => {
    const tutor = await seedPtoTutor();
    const requestId = await approvedPto('2026-11-16', '2026-11-17');
    await db().query('SELECT * FROM public.pto_deactivate_center(44, \'900\')');

    await assert.rejects(change(requestId, 'admin_edit', fullDays('2026-11-16', '2026-11-18')), withCode('PTO_CENTER_DISABLED'));
    await change(requestId, 'admin_edit', fullDays('2026-11-16', '2026-11-16'));
    assert.equal((await balance(tutor.profileId)).availableDays, 4);
    await change(requestId, 'cancel', null);
    assert.equal((await balance(tutor.profileId)).availableDays, 5);
  });

  it('approved-change writes cannot alter identity and plain writes cannot alter held fields', async () => {
    await seedPtoTutor();
    const requestId = await approvedPto('2026-11-16', '2026-11-17');
    const operationId = randomUUID();
    const forged = (sql: string) => inTransaction(db(), async (client) => {
      await persistTimeOffChangeOperation(client, {
        id: operationId, requestId, actorType: 'ADMIN', actorId: 9, franchiseId: 44, action: 'admin_edit',
        amendmentId: null, expectedVersion: '2', resultVersion: '3', idempotencyKey: `${operationId}:${sql.length}`,
        inputHash: 'h', before: {}, after: {}, target: fullDays('2026-11-16', '2026-11-18'), changeReason: 'Forged change test',
        response: { operationId, requestId, version: '3', amendmentId: null, outcome: 'edited', deliveryIds: [] }
      });
      await client.query(sql, [requestId, operationId]);
    });

    await assert.rejects(forged(`UPDATE public.time_off_requests SET tutorid = 9999, version = version + 1,
      last_change_operation_id = $2 WHERE id = $1`), /TIME_OFF_CHANGE_GUARD/);
    await assert.rejects(forged(`UPDATE public.time_off_requests SET end_at = end_at + INTERVAL '7 days', version = version + 1,
      last_change_operation_id = $2 WHERE id = $1`), /TIME_OFF_CHANGE_GUARD/);
    await assert.rejects(db().query(`UPDATE public.time_off_requests SET start_at = start_at + INTERVAL '1 day' WHERE id = $1`,
      [requestId]), /Held PTO identity\/date\/type fields cannot be changed/);

    await db().query('UPDATE public.time_off_requests SET version = 99, notes = $2 WHERE id = $1', [requestId, 'A plain note edit']);
    assert.equal((await requestRow(requestId)).version, '2');
  });

  it('legacy status changes advance the version exactly once', async () => {
    const requestId = await seedTimeOffRequest(db(), { status: 'pending' });
    assert.equal((await requestRow(requestId)).version, '1');
    await db().query("UPDATE public.time_off_requests SET decision_token_hash = 'abc' WHERE id = $1", [requestId]);
    assert.equal((await requestRow(requestId)).version, '1');
    await db().query("UPDATE public.time_off_requests SET status = 'cancelled' WHERE id = $1", [requestId]);
    assert.equal((await requestRow(requestId)).version, '2');
  });

  it('positive-charge legacy PTO without allocations is untracked; zero-charge leave is not', async () => {
    const tutor = await seedPtoTutor();
    const legacy = await approvedPto('2026-11-16', '2026-11-17', { legacy: true });
    assert.deepEqual(await allocations(legacy), []);

    const quote = await inTransaction(db(), (client) => quoteApprovedTimeOffChange(client, legacy, fullDays('2026-11-16', '2026-11-18')));
    assert.equal(quote.tracked, false);
    assert.equal(quote.eligible, false);
    assert.equal(quote.reason, 'reconciliation_required');
    await assert.rejects(change(legacy, 'admin_edit', fullDays('2026-11-16', '2026-11-18')), withCode('TIME_OFF_PTO_RECONCILIATION_REQUIRED'));

    await change(legacy, 'admin_edit', fullDays('2026-11-16', '2026-11-17', { reason: 'A clarified reason only' }));
    const cancelQuote = await inTransaction(db(), (client) => quoteApprovedTimeOffChange(client, legacy, null));
    assert.equal(cancelQuote.eligible, true);
    assert.equal(cancelQuote.tracked, false);
    assert.match(cancelQuote.warnings.join(' '), /no PTO refund/i);
    await change(legacy, 'cancel', null);
    assert.deepEqual(await ledger(legacy), []);
    assert.equal((await balance(tutor.profileId)).availableDays, 5);

    const sunday = await approvedPto('2026-11-22', '2026-11-22', { legacy: true });
    await change(sunday, 'admin_edit', fullDays('2026-11-29', '2026-11-29'));
    await change(sunday, 'admin_edit', fullDays('2026-11-30', '2026-11-30'));
    assert.equal((await balance(tutor.profileId)).availableDays, 4);
  });
});

describe('PTO writers acquire the policy lock before profile and allocation rows', { skip }, () => {
  beforeEach(async () => {
    await resetTimeOffChangesSchema(db());
  });

  /**
   * Holds the policy lock, starts the writer, and proves the writer is parked
   * on the policy lock while the listed rows remain free to lock.
   */
  async function assertPolicyLockFirst(
    writer: (client: PoolClient) => Promise<unknown>,
    freeRows: string[]
  ): Promise<void> {
    const [holder, worker] = [await db().connect(), await db().connect()];
    try {
      const workerPid = (await worker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await holder.query('BEGIN');
      await holder.query("SELECT PG_ADVISORY_XACT_LOCK(HASHTEXTEXTENDED('pto-policy-version', 0))");
      await worker.query('BEGIN');
      const pending = writer(worker).then(() => null, (error: unknown) => error);
      assert.equal(await waitForLockWait(db(), workerPid), 'advisory');
      for (const sql of freeRows) await holder.query(sql);
      await holder.query('ROLLBACK');
      assert.equal(await pending, null);
      await worker.query('COMMIT');
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      await worker.query('ROLLBACK').catch(() => undefined);
      holder.release();
      worker.release();
    }
  }

  const lockProfile = (profileId: string) => `SELECT 1 FROM public.pto_profiles WHERE id = ${Number(profileId)} FOR UPDATE NOWAIT`;
  const lockAllocations = (requestId: number) =>
    `SELECT 1 FROM public.pto_request_allocations WHERE request_id = ${requestId} FOR UPDATE NOWAIT`;

  it('initial decisions', async () => {
    const tutor = await seedPtoTutor();
    const requestId = await seedTimeOffRequest(db(), { type: 'pto', absenceLabel: 'Paid Time Off', status: 'pending' });
    await assertPolicyLockFirst(
      (client) => client.query("UPDATE public.time_off_requests SET status = 'approved' WHERE id = $1", [requestId]),
      [lockProfile(tutor.profileId), lockAllocations(requestId)]
    );
    assert.equal((await allocations(requestId))[0].state, 'consumed');
  });

  it('approved changes', async () => {
    const tutor = await seedPtoTutor();
    const requestId = await approvedPto('2026-11-16');
    await assertPolicyLockFirst(
      (client) => applyChange(client, requestId, 'admin_edit', fullDays('2026-11-16', '2026-11-17')),
      [lockProfile(tutor.profileId), lockAllocations(requestId)]
    );
    assert.equal((await balance(tutor.profileId)).availableDays, 3);
  });

  it('alias decisions', async () => {
    const left = await seedPtoTutor({ franchiseId: 46, tutorId: 4601, email: 'ada46@example.com' });
    const right = await seedPtoTutor();
    const candidate = await db().query<{ id: string }>(`INSERT INTO public.pto_profile_match_candidates
      (left_profile_id, right_profile_id) VALUES ($1, $2) RETURNING id`, [left.profileId, right.profileId]);
    await assertPolicyLockFirst(
      (client) => client.query('SELECT public.pto_admin_decide_alias($1, \'confirm\', \'admin-44\', 44)', [candidate.rows[0].id]),
      [lockProfile(left.profileId), lockProfile(right.profileId),
        `SELECT 1 FROM public.pto_profile_match_candidates WHERE id = ${Number(candidate.rows[0].id)} FOR UPDATE NOWAIT`]
    );
  });

  it('membership detachment', async () => {
    const tutor = await seedPtoTutor();
    const requestId = await approvedPto('2026-11-16');
    await assertPolicyLockFirst(
      (client) => client.query('SELECT public.pto_admin_detach_membership($1, $2, \'admin-44\', 44)', [tutor.profileId, tutor.membershipId]),
      [lockProfile(tutor.profileId), lockAllocations(requestId),
        `SELECT 1 FROM public.pto_profile_centers WHERE id = ${Number(tutor.membershipId)} FOR UPDATE NOWAIT`]
    );
  });

  it('account linking and unlinking', async () => {
    const tutor = await seedPtoTutor();
    await approvedPto('2026-11-16');
    const account = await db().query<{ id: string }>(`INSERT INTO public.pto_discovered_tutor_accounts
      (provider, crm_id, franchiseid, tutor_id, normalized_first_name, normalized_last_name, crm_snapshot, crm_active)
      VALUES ('timecard-center:47', '4701', 47, 4701, 'ada', 'lovelace', '{}', TRUE) RETURNING id`);
    await db().query(`INSERT INTO public.pto_profile_link_decisions (profile_id, account_id, status)
      VALUES ($1, $2, 'pending')`, [tutor.profileId, account.rows[0].id]);
    await assertPolicyLockFirst(
      (client) => client.query('SELECT public.pto_admin_link_account($1, $2, \'admin-44\', 44, 1, \'link-1\')',
        [tutor.profileId, account.rows[0].id]),
      [lockProfile(tutor.profileId)]
    );
    await assertPolicyLockFirst(
      (client) => client.query('SELECT public.pto_admin_unlink_account($1, $2, \'admin-44\', 44, 2, \'unlink-1\')',
        [tutor.profileId, account.rows[0].id]),
      [lockProfile(tutor.profileId)]
    );
  });

  it('administrator adjustments and their provenance', async () => {
    const tutor = await seedPtoTutor();
    await approvedPto('2026-11-16');
    await assertPolicyLockFirst(
      (client) => createPostgresPtoStore(client as unknown as Pool).adjustBalance({
        profileId: tutor.profileId, membershipId: tutor.membershipId, cycleStart: '2026-01-01', deltaDays: 1,
        reason: 'Correction for a test', actorId: 'admin-44', actorFranchiseId: 44
      }),
      [lockProfile(tutor.profileId)]
    );
    const legacy = await db().query<{ id: string }>(`INSERT INTO public.pto_ledger_entries
      (profile_id, cycle_id, event_type, balance_delta, idempotency_key, metadata)
      SELECT $1, id, 'adjustment', 0.5, 'legacy-adjust', '{"reason":"legacy"}' FROM public.pto_entitlement_cycles
      WHERE profile_id = $1 LIMIT 1 RETURNING id`, [tutor.profileId]);
    await assertPolicyLockFirst(
      (client) => client.query('SELECT public.pto_admin_assign_adjustment_provenance($1, $2, $3, \'admin-44\', 44, \'prov-1\')',
        [tutor.profileId, legacy.rows[0].id, tutor.membershipId]),
      [lockProfile(tutor.profileId)]
    );
  });
});
