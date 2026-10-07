import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { Pool } from 'pg';
import { runTimeOffChangeDeliveryPass, type TimeOffChangeDeliveryDeps } from '../services/timeOffChangeDelivery';
import { retryTimeOffChangeDelivery } from '../services/timeOffChangeRepository';
import { createTimeOffChangeService } from '../services/timeOffChanges';
import type { TimeOffEmailPayload } from '../services/timeOffEmail';
import type { TimeOffSubmissionInput } from '../types/timeoff';
import type { TimeOffChangeActor, TimeOffChangeCommand } from '../types/timeOffChanges';
import { FakeCalendar } from './helpers/fakeCalendar';
import {
  resetTimeOffChangesSchema,
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
const CALENDAR = 'calendar@example.com';
const tutor: TimeOffChangeActor = { kind: 'TUTOR', accountId: 4401, franchiseId: 44 };
const admin: TimeOffChangeActor = { kind: 'ADMIN', accountId: 9, franchiseId: 44 };
const later = (seconds: number) => new Date(Date.parse(NOW) + seconds * 1000).toISOString();

const service = () => createTimeOffChangeService({
  pool: db(),
  resolveTimezone: async () => 'America/Los_Angeles',
  resolveNoticeRequired: async () => true,
  resolveContact: async (franchiseId) => ({ id: franchiseId, name: 'Downtown', email: 'center@example.com', gmailId: CALENDAR }),
  overlapEnabled: () => false,
  appOrigin: 'https://timecard.example.com'
});
let keyCounter = 0;
const execute = async (actor: TimeOffChangeActor, requestId: number, body: Record<string, unknown>) => service().execute({
  actor, requestId, expectedVersion: (await service().detail(actor, requestId, NOW)).version,
  idempotencyKey: `delivery-key-${String(keyCounter += 1).padStart(6, '0')}`, nowIso: NOW, ...body
} as TimeOffChangeCommand);
const days = (startDate: string, endDate: string): TimeOffSubmissionInput =>
  ({ startDate, endDate, partialDay: false, type: 'sick', reason: 'Original request reason text' });
const edit = (requestId: number, endDate: string) =>
  execute(admin, requestId, { action: 'admin_edit', proposed: days('2026-11-16', endDate), changeReason: 'Coverage adjusted by center' });
const cancel = (requestId: number) => execute(admin, requestId, { action: 'cancel', changeReason: 'Center closed for the week' });

const eventIdFor = (requestId: number) => `tctimeoff${requestId.toString(32)}`;
const ownedEvent = (requestId: number) => ({
  id: eventIdFor(requestId), summary: 'TIME OFF: Ada Lovelace (Sick Leave)', colorId: '5',
  start: { date: '2026-11-16' }, end: { date: '2026-11-17' },
  extendedProperties: { private: { timeOffRequestId: String(requestId), franchiseId: '44' } }
});
async function approvedWithEvent(calendar: FakeCalendar, seedEvent = true): Promise<number> {
  const requestId = await seedTimeOffRequest(db(), { startDate: '2026-11-16', tutorId: 4401 });
  await db().query('UPDATE public.time_off_requests SET google_calendar_event_id = $2, google_calendar_id = $3 WHERE id = $1',
    [requestId, eventIdFor(requestId), CALENDAR]);
  if (seedEvent) calendar.seed(CALENDAR, ownedEvent(requestId));
  return requestId;
}

const sent: Array<{ to: string; subject: string; dwdSubject: string }> = [];
const deps = (calendar: FakeCalendar, overrides: Partial<TimeOffChangeDeliveryDeps> = {}): TimeOffChangeDeliveryDeps => ({
  pool: db(),
  calendarClientFor: () => calendar,
  sendEmail: async (payload: TimeOffEmailPayload, dwdSubject: string) => {
    sent.push({ to: payload.to, subject: payload.subject, dwdSubject });
  },
  ...overrides
});
const jobs = async (requestId: number) => (await db().query<{
  id: string; kind: string; status: string; attempts: number; next_attempt_at: Date | null; last_error: string | null;
  adopted_event_id: string | null;
}>(`SELECT id::TEXT AS id, kind, status, attempts, next_attempt_at, last_error, adopted_event_id
    FROM public.time_off_change_deliveries WHERE request_id = $1 AND channel = 'calendar' ORDER BY target_version`,
[requestId])).rows;
const terminateIdleWorker = async () => {
  await db().query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
    WHERE datname = current_database() AND state = 'idle in transaction' AND pid <> pg_backend_pid()`);
};

before(async () => {
  if (!skip) database = await startTimeOffChangesDatabase();
});
after(async () => {
  await database?.stop();
});

describe('approved time-off change delivery', { skip }, () => {
  beforeEach(async () => {
    await resetTimeOffChangesSchema(db());
    sent.length = 0;
  });

  it('applies only the newest calendar target and never runs an older edit after a cancellation', async () => {
    const calendar = new FakeCalendar();
    const requestId = await approvedWithEvent(calendar);
    await edit(requestId, '2026-11-17');
    await cancel(requestId);

    const result = await runTimeOffChangeDeliveryPass(deps(calendar), NOW);
    assert.equal(result.superseded, 1);
    assert.deepEqual((await jobs(requestId)).map((job) => [job.kind, job.status]),
      [['calendar_upsert', 'superseded'], ['calendar_delete', 'sent']]);
    assert.equal(calendar.count('patch'), 0);
    assert.equal(calendar.get(CALENDAR, eventIdFor(requestId)), undefined);
    assert.deepEqual(sent.map((email) => email.to), ['ada@example.com', 'ada@example.com']);
  });

  it('a crash after remote success replays to one effective event without touching business state', async () => {
    const calendar = new FakeCalendar();
    const requestId = await approvedWithEvent(calendar);
    await edit(requestId, '2026-11-18');
    const business = async () => (await db().query(
      `SELECT version::TEXT AS version, status, (SELECT COUNT(*)::INT FROM public.pto_ledger_entries) AS ledger,
         (SELECT COUNT(*)::INT FROM public.time_off_change_operations) AS operations
       FROM public.time_off_requests WHERE id = $1`, [requestId])).rows[0];
    const before = await business();
    let crashed = false;
    calendar.afterMutation = async () => {
      if (crashed) return;
      crashed = true;
      await terminateIdleWorker();
    };

    await assert.rejects(runTimeOffChangeDeliveryPass(deps(calendar), NOW));
    assert.equal((await jobs(requestId))[0].status, 'pending');
    assert.equal((await jobs(requestId))[0].attempts, 0);

    await runTimeOffChangeDeliveryPass(deps(calendar), later(1));
    const [job] = await jobs(requestId);
    assert.equal(job.status, 'sent');
    assert.equal(job.adopted_event_id, eventIdFor(requestId));
    assert.equal(calendar.events.size, 1);
    assert.deepEqual((calendar.get(CALENDAR, eventIdFor(requestId)) as { end: unknown }).end, { date: '2026-11-19' });
    assert.deepEqual(await business(), before);
  });

  it('two workers never process the same parent request concurrently', async () => {
    const calendar = new FakeCalendar();
    const requestId = await approvedWithEvent(calendar);
    await edit(requestId, '2026-11-18');
    calendar.afterMutation = () => new Promise((resolve) => setTimeout(resolve, 300));

    const results = await Promise.all([
      runTimeOffChangeDeliveryPass(deps(calendar), NOW),
      runTimeOffChangeDeliveryPass(deps(calendar), NOW)
    ]);
    assert.equal(calendar.count('patch'), 1);
    assert.equal(results.reduce((total, result) => total + result.sent, 0), 2, 'one calendar job and one email');
    assert.equal(sent.length, 1);
    assert.equal((await jobs(requestId))[0].status, 'sent');
  });

  it('cancellation removes a recovery event left by an uncertain earlier attempt', async () => {
    const calendar = new FakeCalendar();
    const requestId = await approvedWithEvent(calendar, false);
    const edited = await edit(requestId, '2026-11-18');
    calendar.afterMutation = async (method) => {
      if (method === 'insert') await terminateIdleWorker();
    };
    await assert.rejects(runTimeOffChangeDeliveryPass(deps(calendar), NOW));
    const recoveryId = `${eventIdFor(requestId)}v${BigInt(edited.version).toString(32)}`;
    assert.ok(calendar.get(CALENDAR, recoveryId), 'the provider created the recovery event before the crash');
    calendar.afterMutation = undefined;

    await cancel(requestId);
    await runTimeOffChangeDeliveryPass(deps(calendar), later(1));
    assert.equal(calendar.get(CALENDAR, recoveryId), undefined);
    assert.deepEqual((await jobs(requestId)).map((job) => job.status), ['superseded', 'sent']);
  });

  it('an unrelated proposal version does not discard the latest calendar job', async () => {
    const calendar = new FakeCalendar();
    const requestId = await approvedWithEvent(calendar);
    await edit(requestId, '2026-11-18');
    await execute(tutor, requestId, { action: 'propose', proposed: days('2026-11-16', '2026-11-19'),
      changeReason: 'One more day if possible' });

    await runTimeOffChangeDeliveryPass(deps(calendar), NOW);
    assert.deepEqual((await jobs(requestId)).map((job) => job.status), ['sent']);
    assert.deepEqual((calendar.get(CALENDAR, eventIdFor(requestId)) as { end: unknown }).end, { date: '2026-11-19' });
  });

  it('retries transient failures on schedule, fails after six attempts, and allows a scoped manual retry', async () => {
    const calendar = new FakeCalendar();
    const requestId = await approvedWithEvent(calendar);
    await edit(requestId, '2026-11-18');
    for (let failure = 0; failure < 6; failure += 1) calendar.failures.push({ method: 'get', status: 503 });

    const delays = [30, 120, 600, 3_600, 21_600];
    let clock = 0;
    for (const [index, delay] of delays.entries()) {
      await runTimeOffChangeDeliveryPass(deps(calendar), later(clock));
      const [job] = await jobs(requestId);
      assert.equal(job.attempts, index + 1);
      assert.equal(job.status, 'pending');
      assert.equal(job.next_attempt_at?.toISOString(), later(clock + delay));
      await runTimeOffChangeDeliveryPass(deps(calendar), later(clock + delay - 1));
      assert.equal((await jobs(requestId))[0].attempts, index + 1, 'not due before its delay');
      clock += delay;
    }
    await runTimeOffChangeDeliveryPass(deps(calendar), later(clock));
    let [job] = await jobs(requestId);
    assert.equal(job.status, 'failed');
    assert.equal(job.attempts, 6);
    assert.match(String(job.last_error), /503/);

    await assert.rejects(retryTimeOffChangeDelivery(db(), { franchiseId: 45, deliveryId: job.id, nowIso: later(clock) }),
      (error: { code?: string }) => error.code === 'TIME_OFF_DELIVERY_NOT_FOUND');
    const retried = await retryTimeOffChangeDelivery(db(), { franchiseId: 44, deliveryId: job.id, nowIso: later(clock) });
    assert.equal(retried.status, 'pending');
    await runTimeOffChangeDeliveryPass(deps(calendar), later(clock + 1));
    [job] = await jobs(requestId);
    assert.equal(job.status, 'sent');
    await assert.rejects(retryTimeOffChangeDelivery(db(), { franchiseId: 44, deliveryId: job.id, nowIso: later(clock + 2) }),
      (error: { code?: string }) => error.code === 'TIME_OFF_DELIVERY_NOT_RETRYABLE');
  });

  it('refuses to revive a calendar job superseded by a newer target', async () => {
    const calendar = new FakeCalendar();
    const requestId = await approvedWithEvent(calendar);
    await edit(requestId, '2026-11-18');
    await cancel(requestId);
    await runTimeOffChangeDeliveryPass(deps(calendar), NOW);
    const [older] = await jobs(requestId);
    await assert.rejects(retryTimeOffChangeDelivery(db(), { franchiseId: 44, deliveryId: older.id, nowIso: NOW }),
      (error: { code?: string }) => error.code === 'TIME_OFF_DELIVERY_SUPERSEDED');
  });

  it('processes at most 20 deliveries per pass and sends each email once', async () => {
    for (let index = 0; index < 13; index += 1) {
      const requestId = await seedTimeOffRequest(db(), { startDate: '2026-11-16', tutorId: 4401 });
      const proposal = await execute(tutor, requestId, { action: 'propose', proposed: days('2026-11-16', '2026-11-17'),
        changeReason: 'Need a second day off' });
      await execute(tutor, requestId, { action: 'withdraw', amendmentId: proposal.amendmentId });
    }
    const calendar = new FakeCalendar();
    assert.equal((await runTimeOffChangeDeliveryPass(deps(calendar), NOW)).sent, 20);
    const rest = await Promise.all([
      runTimeOffChangeDeliveryPass(deps(calendar), NOW),
      runTimeOffChangeDeliveryPass(deps(calendar), NOW)
    ]);
    assert.equal(rest[0].sent + rest[1].sent, 6);
    assert.equal(sent.length, 26);
  });

  it('runs the amendment expiry pass', async () => {
    const requestId = await seedTimeOffRequest(db(), { startDate: '2026-11-16', tutorId: 4401 });
    await execute(tutor, requestId, { action: 'propose', proposed: days('2026-11-09', '2026-11-16'),
      changeReason: 'Leaving a week earlier' });
    const expiryTime = '2026-11-09T09:00:00.000Z';
    const calls: string[] = [];
    await runTimeOffChangeDeliveryPass(deps(new FakeCalendar(), {
      expire: async (nowIso) => {
        calls.push(nowIso);
        return service().expire(nowIso);
      }
    }), expiryTime);
    assert.deepEqual(calls, [expiryTime]);
    assert.equal((await db().query('SELECT status FROM public.time_off_amendments')).rows[0].status, 'expired');
  });
});
