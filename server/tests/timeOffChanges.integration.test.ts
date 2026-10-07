import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { Pool } from 'pg';
import { createPtoRouteStore } from '../services/pto/routeStore';
import { createTimeOffChangeService, type TimeOffChangeDeps } from '../services/timeOffChanges';
import { updateTimeOffDecision } from '../services/timeOffRepository';
import type { TimeOffSubmissionInput } from '../types/timeoff';
import type { TimeOffChangeActor, TimeOffChangeCommand, TimeOffChangeDetail } from '../types/timeOffChanges';
import {
  approvedPto,
  inTransaction,
  resetTimeOffChangesSchema,
  seedPtoTutor,
  seedTimeOffRequest,
  startTimeOffChangesDatabase,
  timeOffChangesDatabaseEnabled,
  type TimeOffChangesDatabase
} from './helpers/timeOffChangesDatabase';

const skip = !timeOffChangesDatabaseEnabled;
let database: TimeOffChangesDatabase | undefined;
const db = (): Pool => {
  assert.ok(database);
  return database.pool;
};

const NOW = '2026-10-07T17:00:00.000Z';
const tutor: TimeOffChangeActor = { kind: 'TUTOR', accountId: 4401, franchiseId: 44 };
const admin: TimeOffChangeActor = { kind: 'ADMIN', accountId: 9, franchiseId: 44 };
const withCode = (code: string) => (error: unknown) => (error as { code?: string } | null)?.code === code;

let timezone = 'America/Los_Angeles';
let wakes = 0;
const service = (overrides: Partial<TimeOffChangeDeps> = {}) => createTimeOffChangeService({
  pool: db(),
  resolveTimezone: async () => timezone,
  resolveNoticeRequired: async () => true,
  resolveContact: async (franchiseId) => ({ id: franchiseId, name: 'Downtown', email: 'center@example.com', gmailId: 'calendar@example.com' }),
  overlapEnabled: () => false,
  appOrigin: 'https://timecard.example.com',
  wake: () => { wakes += 1; },
  ...overrides
});

const days = (startDate: string, endDate: string, overrides: TimeOffSubmissionInput = {}): TimeOffSubmissionInput => ({
  startDate, endDate, partialDay: false, type: 'pto', reason: 'Original request reason text', ...overrides
});
let keyCounter = 0;
const key = () => `test-key-${String(keyCounter += 1).padStart(6, '0')}`;

const detail = (actor: TimeOffChangeActor, requestId: number, nowIso = NOW) => service().detail(actor, requestId, nowIso);
const effective = (value: TimeOffChangeDetail) => {
  const { startAt, endAt, startDate, endDate, type, absenceLabel, reason, durationHours, partialDay, status,
    decidedAt, decidedBy, decisionReason } = value.request;
  return { startAt, endAt, startDate, endDate, type, absenceLabel, reason, durationHours, partialDay, status,
    decidedAt, decidedBy, decisionReason };
};
const command = async (
  actor: TimeOffChangeActor,
  requestId: number,
  body: Record<string, unknown>,
  options: { nowIso?: string; idempotencyKey?: string; expectedVersion?: string } = {}
) => {
  const nowIso = options.nowIso ?? NOW;
  const expectedVersion = options.expectedVersion ?? (await detail(actor, requestId, nowIso)).version;
  return service().execute({
    actor, requestId, expectedVersion, idempotencyKey: options.idempotencyKey ?? key(), nowIso, ...body
  } as TimeOffChangeCommand);
};
const propose = (requestId: number, proposed: TimeOffSubmissionInput, options = {}) =>
  command(tutor, requestId, { action: 'propose', proposed, changeReason: 'Flights moved by one day' }, options);

const count = async (sql: string, params: unknown[] = []) => (await db().query<{ count: number }>(sql, params)).rows[0].count;
const deliveries = async (operationId: string) => (await db().query<{ channel: string; kind: string; recipient: string | null }>(
  'SELECT channel, kind, recipient FROM public.time_off_change_deliveries WHERE operation_id = $1 ORDER BY channel, kind',
  [operationId])).rows;
const balance = (profileId: string) => createPtoRouteStore(db()).getBalanceSummary(profileId, '2026-11-16');

before(async () => {
  if (!skip) database = await startTimeOffChangesDatabase();
});
after(async () => {
  await database?.stop();
});

describe('approved time-off change lifecycle', { skip }, () => {
  beforeEach(async () => {
    await resetTimeOffChangesSchema(db());
    timezone = 'America/Los_Angeles';
  });

  it('a proposal leaves the effective request, PTO, and calendar untouched', async () => {
    const pto = await seedPtoTutor(db());
    const requestId = await approvedPto(db(), '2026-11-16', '2026-11-17');
    await db().query("UPDATE public.time_off_requests SET google_calendar_event_id = 'tctimeoffevent' WHERE id = $1", [requestId]);
    const before = await detail(tutor, requestId);
    const audits = await count('SELECT COUNT(*)::INT AS count FROM public.time_off_audit');

    const receipt = await propose(requestId, days('2026-11-16', '2026-11-18'));
    const after = await detail(tutor, requestId);

    assert.equal(after.request.status, 'approved');
    assert.deepEqual(effective(after), effective(before));
    assert.equal(after.request.googleCalendarEventId, 'tctimeoffevent');
    assert.equal(after.version, String(Number(before.version) + 1));
    assert.equal(receipt.version, after.version);
    assert.equal(receipt.outcome, 'proposed');
    assert.equal(after.pendingAmendment?.id, receipt.amendmentId);
    assert.equal(after.pendingAmendment?.proposed.endDate, '2026-11-18');
    assert.deepEqual(after.allowedActions, ['withdraw', 'cancel']);
    assert.deepEqual(after.history.map((entry) => entry.action), ['propose']);
    assert.equal((await balance(pto.profileId)).availableDays, 3);
    assert.deepEqual(await deliveries(receipt.operationId), [{ channel: 'email', kind: 'center_change_proposed', recipient: 'center@example.com' }]);
    assert.equal(await count('SELECT COUNT(*)::INT AS count FROM public.time_off_audit'), audits + 1);
    assert.ok(wakes > 0);
  });

  it('withdrawal and denial close proposals while the original approval stays effective', async () => {
    const requestId = await seedTimeOffRequest(db(), { startDate: '2026-11-16', endDate: '2026-11-17', tutorId: 4401 });
    const before = await detail(tutor, requestId);
    const first = await propose(requestId, days('2026-11-16', '2026-11-18', { type: 'sick' }));
    const withdrawn = await command(tutor, requestId, { action: 'withdraw', amendmentId: first.amendmentId });
    assert.equal(withdrawn.outcome, 'withdrawn');
    assert.deepEqual(await deliveries(withdrawn.operationId), [{ channel: 'email', kind: 'center_change_withdrawn', recipient: 'center@example.com' }]);

    const second = await propose(requestId, days('2026-11-17', '2026-11-17', { type: 'sick' }));
    const denied = await command(admin, requestId, { action: 'deny_amendment', amendmentId: second.amendmentId, reason: 'Coverage is short' });
    assert.equal(denied.outcome, 'denied');
    assert.deepEqual(await deliveries(denied.operationId), [{ channel: 'email', kind: 'requester_change_denied', recipient: 'ada@example.com' }]);

    const after = await detail(admin, requestId);
    assert.deepEqual(effective(after), effective(before));
    assert.equal(after.pendingAmendment, null);
    assert.equal(after.version, String(Number(before.version) + 4));
    assert.deepEqual(after.history.map((entry) => entry.action), ['propose', 'withdraw', 'propose', 'deny_amendment']);
  });

  it('approval swaps the effective fields exactly once and keeps the original approval metadata', async () => {
    const pto = await seedPtoTutor(db());
    const requestId = await approvedPto(db(), '2026-11-16', '2026-11-17');
    const before = await detail(admin, requestId);
    const proposal = await propose(requestId, days('2026-11-16', '2026-11-18'));
    const approveKey = key();
    const approved = await command(admin, requestId, { action: 'approve_amendment', amendmentId: proposal.amendmentId },
      { idempotencyKey: approveKey });
    const after = await detail(admin, requestId);

    assert.equal(after.request.status, 'approved');
    assert.equal(after.request.endDate, '2026-11-18');
    assert.equal(after.request.decidedAt, before.request.decidedAt);
    assert.equal(after.request.decidedBy, before.request.decidedBy);
    assert.equal((await balance(pto.profileId)).availableDays, 2);
    assert.deepEqual((await deliveries(approved.operationId)).map(({ channel, kind }) => [channel, kind]),
      [['calendar', 'calendar_upsert'], ['email', 'requester_change_approved']]);

    const ledger = await count('SELECT COUNT(*)::INT AS count FROM public.pto_ledger_entries');
    const replay = await command(admin, requestId, { action: 'approve_amendment', amendmentId: proposal.amendmentId },
      { idempotencyKey: approveKey, expectedVersion: String(Number(after.version) - 1) });
    assert.deepEqual(replay, approved);
    assert.equal(await count('SELECT COUNT(*)::INT AS count FROM public.pto_ledger_entries'), ledger);
    assert.equal((await detail(admin, requestId)).version, after.version);
  });

  it('admin edits and cancellations supersede a pending proposal with one requester message', async () => {
    const pto = await seedPtoTutor(db());
    const requestId = await approvedPto(db(), '2026-11-16', '2026-11-17');
    const first = await propose(requestId, days('2026-11-16', '2026-11-18'));
    const edited = await command(admin, requestId, {
      action: 'admin_edit', proposed: days('2026-11-16', '2026-11-16'), changeReason: 'Coverage adjusted by the center'
    });
    assert.equal(edited.amendmentId, first.amendmentId);
    assert.equal(edited.outcome, 'edited');
    assert.deepEqual((await deliveries(edited.operationId)).map(({ kind }) => kind), ['calendar_upsert', 'requester_edited']);
    assert.equal((await db().query('SELECT status FROM public.time_off_amendments WHERE id = $1', [first.amendmentId])).rows[0].status,
      'superseded');
    assert.equal((await balance(pto.profileId)).availableDays, 4);

    const second = await propose(requestId, days('2026-11-16', '2026-11-17'));
    const cancelled = await command(admin, requestId, { action: 'cancel', changeReason: 'Center closed for the week' });
    const after = await detail(admin, requestId);
    assert.equal(after.request.status, 'cancelled');
    assert.equal(after.pendingAmendment, null);
    assert.deepEqual(after.allowedActions, []);
    assert.equal((await db().query('SELECT status FROM public.time_off_amendments WHERE id = $1', [second.amendmentId])).rows[0].status,
      'superseded');
    assert.deepEqual((await deliveries(cancelled.operationId)).map(({ kind }) => kind), ['calendar_delete', 'requester_cancelled']);
    assert.equal((await balance(pto.profileId)).availableDays, 5);
    assert.equal((await balance(pto.profileId)).usedDays, 0);
  });

  it('expiry closes a proposal at the earlier start, reads report it first, and approval after expiry fails', async () => {
    const requestId = await seedTimeOffRequest(db(), { startDate: '2026-11-16', endDate: '2026-11-17', tutorId: 4401 });
    const before = await detail(admin, requestId);
    const proposal = await propose(requestId, days('2026-11-09', '2026-11-17', { type: 'sick' }));
    const later = '2026-11-09T09:00:00.000Z';

    const read = await detail(admin, requestId, later);
    assert.equal(read.pendingAmendment?.status, 'expired');
    assert.deepEqual(read.allowedActions, ['admin_edit', 'cancel']);
    await assert.rejects(command(admin, requestId, { action: 'approve_amendment', amendmentId: proposal.amendmentId },
      { nowIso: later }), withCode('TIME_OFF_AMENDMENT_EXPIRED'));

    assert.equal(await service().expire(later), 1);
    assert.equal(await service().expire(later), 0);
    const after = await detail(admin, requestId, later);
    assert.deepEqual(effective(after), effective(before));
    assert.equal(after.pendingAmendment, null);
    assert.equal(after.version, String(Number(before.version) + 2));
    const history = after.history[after.history.length - 1];
    assert.equal(history?.action, 'expire');
    assert.equal(history?.actorType, 'SYSTEM');
    assert.deepEqual(await deliveries(history?.operationId ?? ''), [{ channel: 'email', kind: 'center_change_expired', recipient: 'center@example.com' }]);
  });

  it('a command after an unpersisted expiry catches up the expiry before applying', async () => {
    const requestId = await seedTimeOffRequest(db(), { startDate: '2026-11-16', endDate: '2026-11-17', tutorId: 4401 });
    await propose(requestId, days('2026-11-09', '2026-11-17', { type: 'sick' }));
    const later = '2026-11-09T09:00:00.000Z';
    const seen = await detail(tutor, requestId, later);
    assert.deepEqual(seen.allowedActions, ['propose', 'cancel']);

    const receipt = await propose(requestId, days('2026-11-16', '2026-11-16', { type: 'sick' }),
      { nowIso: later, expectedVersion: seen.version });
    assert.equal(receipt.version, String(Number(seen.version) + 2));
    assert.deepEqual((await detail(tutor, requestId, later)).history.map((entry) => entry.action), ['propose', 'expire', 'propose']);
  });

  it('failed audits and insufficient PTO leave no partial writes or jobs', async () => {
    const pto = await seedPtoTutor(db());
    const requestId = await approvedPto(db(), '2026-11-16', '2026-11-17');
    const before = await detail(tutor, requestId);
    await db().query(`CREATE FUNCTION public.fail_audit() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'audit store unavailable'; END; $$`);
    await db().query('CREATE TRIGGER fail_audit BEFORE INSERT ON public.time_off_audit FOR EACH ROW EXECUTE FUNCTION public.fail_audit()');
    await assert.rejects(propose(requestId, days('2026-11-16', '2026-11-18')), /audit store unavailable/);
    await db().query('DROP TRIGGER fail_audit ON public.time_off_audit');
    for (const table of ['time_off_amendments', 'time_off_change_operations', 'time_off_change_deliveries']) {
      assert.equal(await count(`SELECT COUNT(*)::INT AS count FROM public.${table}`), 0, table);
    }
    assert.equal((await detail(tutor, requestId)).version, before.version);

    const proposal = await propose(requestId, days('2026-11-16', '2026-11-24'));
    const jobs = await count('SELECT COUNT(*)::INT AS count FROM public.time_off_change_deliveries');
    await assert.rejects(command(admin, requestId, { action: 'approve_amendment', amendmentId: proposal.amendmentId }),
      withCode('PTO_INSUFFICIENT_BALANCE'));
    const after = await detail(admin, requestId);
    assert.equal(after.pendingAmendment?.status, 'pending');
    assert.equal(after.request.endDate, '2026-11-17');
    assert.equal(await count('SELECT COUNT(*)::INT AS count FROM public.time_off_change_deliveries'), jobs);
    assert.equal((await balance(pto.profileId)).availableDays, 3);
  });

  it('previews normalize in the center timezone and quote without writing', async () => {
    await seedPtoTutor(db());
    const requestId = await approvedPto(db(), '2026-11-16', '2026-11-17');
    const preview = await service().preview({ actor: tutor, requestId, proposed: days('2026-11-16', '2026-11-18'), nowIso: NOW });
    assert.equal(preview.version, (await detail(tutor, requestId)).version);
    assert.equal(preview.normalized.endAt, '2026-11-19T08:00:00.000Z');
    assert.deepEqual(preview.resolvedOffsets, { start: '-08:00', end: '-08:00' });
    assert.deepEqual(preview.pto?.cycles, [{ cycleStart: '2026-01-01', oldDays: 2, newDays: 3, availableDays: 3, availableAfter: 2 }]);
    assert.equal(await count('SELECT COUNT(*)::INT AS count FROM public.time_off_change_operations'), 0);
    await assert.rejects(service().preview({ actor: tutor, requestId, proposed: days('2026-10-09', '2026-11-17'), nowIso: NOW }),
      withCode('TIME_OFF_INVALID_CHANGE'));
  });
});

describe('approved time-off change races and idempotency', { skip }, () => {
  beforeEach(async () => {
    await resetTimeOffChangesSchema(db());
    timezone = 'America/Los_Angeles';
  });

  it('same key and body replays; same key with a changed body conflicts', async () => {
    const requestId = await seedTimeOffRequest(db(), { startDate: '2026-11-16', tutorId: 4401 });
    const version = (await detail(tutor, requestId)).version;
    const body = { action: 'propose', proposed: days('2026-11-16', '2026-11-17', { type: 'sick' }), changeReason: 'Need a second day' };
    const first = await command(tutor, requestId, body, { idempotencyKey: 'stable-key-1', expectedVersion: version });
    assert.deepEqual(await command(tutor, requestId, body, { idempotencyKey: 'stable-key-1', expectedVersion: version }), first);
    await assert.rejects(command(tutor, requestId, { ...body, changeReason: 'Need a different day' },
      { idempotencyKey: 'stable-key-1', expectedVersion: version }), withCode('TIME_OFF_IDEMPOTENCY_MISMATCH'));
    assert.equal(await count('SELECT COUNT(*)::INT AS count FROM public.time_off_amendments'), 1);
  });

  it('two admin decisions at one version produce one success and one conflict', async () => {
    const requestId = await seedTimeOffRequest(db(), { startDate: '2026-11-16', tutorId: 4401 });
    const proposal = await propose(requestId, days('2026-11-16', '2026-11-17', { type: 'sick' }));
    const version = (await detail(admin, requestId)).version;
    const results = await Promise.allSettled([
      command(admin, requestId, { action: 'approve_amendment', amendmentId: proposal.amendmentId }, { expectedVersion: version }),
      command({ ...admin, accountId: 10 }, requestId, { action: 'deny_amendment', amendmentId: proposal.amendmentId, reason: 'No' },
        { expectedVersion: version })
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const failure = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    assert.equal(failure.reason.code, 'TIME_OFF_VERSION_CONFLICT');
  });

  it('proposal versus direct edit and cancellation versus approval each apply exactly one', async () => {
    const requestId = await seedTimeOffRequest(db(), { startDate: '2026-11-16', tutorId: 4401 });
    const version = (await detail(admin, requestId)).version;
    const editRace = await Promise.allSettled([
      propose(requestId, days('2026-11-16', '2026-11-17', { type: 'sick' }), { expectedVersion: version }),
      command(admin, requestId, { action: 'admin_edit', proposed: days('2026-11-18', '2026-11-18', { type: 'sick' }),
        changeReason: 'Coverage adjusted by the center' }, { expectedVersion: version })
    ]);
    assert.equal(editRace.filter((result) => result.status === 'fulfilled').length, 1);

    const current = await detail(admin, requestId);
    const proposal = current.pendingAmendment
      ? { amendmentId: current.pendingAmendment.id }
      : await propose(requestId, days('2026-11-19', '2026-11-19', { type: 'sick' }));
    const atVersion = (await detail(admin, requestId)).version;
    const cancelRace = await Promise.allSettled([
      command(tutor, requestId, { action: 'cancel', changeReason: 'Plans changed for the family' }, { expectedVersion: atVersion }),
      command(admin, requestId, { action: 'approve_amendment', amendmentId: proposal.amendmentId }, { expectedVersion: atVersion })
    ]);
    assert.equal(cancelRace.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = cancelRace.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    assert.equal(rejected.reason.code, 'TIME_OFF_VERSION_CONFLICT');
  });

  it('replay requires current visibility', async () => {
    const requestId = await seedTimeOffRequest(db(), { startDate: '2026-11-16', tutorId: 4401 });
    const version = (await detail(admin, requestId)).version;
    const body = { action: 'cancel', changeReason: 'Center closed for the week' };
    await command(admin, requestId, body, { idempotencyKey: 'visibility-key-1', expectedVersion: version });
    await assert.rejects(command({ ...admin, franchiseId: 45 }, requestId, body,
      { idempotencyKey: 'visibility-key-1', expectedVersion: version }), withCode('TIME_OFF_NOT_FOUND'));
    await assert.rejects(command({ ...tutor, accountId: 4402 }, requestId, body,
      { idempotencyKey: 'visibility-key-1', expectedVersion: version }), withCode('TIME_OFF_NOT_FOUND'));
  });

  it('rejects stale amendment ids, admin self-approval, and a changed center timezone', async () => {
    const own = await seedTimeOffRequest(db(), { startDate: '2026-11-16', tutorId: 9, franchiseId: 44 });
    const requestId = await seedTimeOffRequest(db(), { startDate: '2026-11-16', tutorId: 4401 });
    const first = await propose(requestId, days('2026-11-16', '2026-11-17', { type: 'sick' }));
    await command(tutor, requestId, { action: 'withdraw', amendmentId: first.amendmentId });
    await assert.rejects(command(admin, requestId, { action: 'approve_amendment', amendmentId: first.amendmentId }),
      withCode('TIME_OFF_AMENDMENT_CLOSED'));
    await assert.rejects(command(admin, requestId, { action: 'approve_amendment', amendmentId: '999999' }),
      withCode('TIME_OFF_AMENDMENT_NOT_FOUND'));

    const selfTutor: TimeOffChangeActor = { kind: 'TUTOR', accountId: 9, franchiseId: 44 };
    const ownProposal = await command(selfTutor, own, { action: 'propose', proposed: days('2026-11-16', '2026-11-17', { type: 'sick' }),
      changeReason: 'Need a second day off' });
    await assert.rejects(command(admin, own, { action: 'approve_amendment', amendmentId: ownProposal.amendmentId }),
      withCode('TIME_OFF_SELF_APPROVAL'));
    await assert.rejects(command(admin, own, { action: 'admin_edit', proposed: days('2026-11-18', '2026-11-18', { type: 'sick' }),
      changeReason: 'Editing my own leave' }), withCode('TIME_OFF_SELF_APPROVAL'));
    assert.equal((await command(admin, own, { action: 'cancel', changeReason: 'Cancelling my own leave' })).outcome, 'cancelled');

    const second = await propose(requestId, days('2026-11-16', '2026-11-17', { type: 'sick' }));
    timezone = 'America/Denver';
    await assert.rejects(command(admin, requestId, { action: 'approve_amendment', amendmentId: second.amendmentId }),
      withCode('TIME_OFF_TIMEZONE_CHANGED'));
  });
});

describe('initial decisions remain compatible', { skip }, () => {
  beforeEach(async () => {
    await resetTimeOffChangesSchema(db());
  });

  it('captures the calendar id on approval and advances the version once', async () => {
    const requestId = await seedTimeOffRequest(db(), { status: 'pending', startDate: '2026-11-16' });
    const decided = await inTransaction(db(), (client) => updateTimeOffDecision({
      client, requestId, status: 'approved', actorId: 9, reason: 'Approved', calendarEventId: 'tctimeoffx',
      calendarId: 'calendar@example.com', timezone: 'America/Los_Angeles'
    }));
    assert.equal(decided?.status, 'approved');
    const row = (await db().query('SELECT version::TEXT AS version, google_calendar_id FROM public.time_off_requests WHERE id = $1',
      [requestId])).rows[0];
    assert.deepEqual(row, { version: '2', google_calendar_id: 'calendar@example.com' });
  });
});
