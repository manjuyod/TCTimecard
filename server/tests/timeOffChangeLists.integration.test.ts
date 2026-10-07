import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { Pool } from 'pg';
import {
  listAdminTimeOffRequests,
  listPendingTimeOffAmendments,
  listTimeOffChangeDeliveries
} from '../services/timeOffChangeRepository';
import { createTimeOffChangeService } from '../services/timeOffChanges';
import type { TimeOffChangeActor, TimeOffChangeCommand } from '../types/timeOffChanges';
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
const TZ = 'America/Los_Angeles';
const NOW = '2026-10-07T17:00:00.000Z';
const base = { franchiseId: 44, timezone: TZ, today: '2026-10-07', limit: 50 };
const service = () => createTimeOffChangeService({
  pool: db(), resolveTimezone: async () => TZ, resolveNoticeRequired: async () => true,
  resolveContact: async () => ({ id: 44, name: 'Downtown', email: 'center@example.com', gmailId: 'calendar@example.com' }),
  overlapEnabled: () => false, appOrigin: 'https://timecard.example.com'
});
const tutor: TimeOffChangeActor = { kind: 'TUTOR', accountId: 4401, franchiseId: 44 };
const admin: TimeOffChangeActor = { kind: 'ADMIN', accountId: 9, franchiseId: 44 };
let keyCounter = 0;
const execute = async (actor: TimeOffChangeActor, requestId: number, body: Record<string, unknown>) => service().execute({
  actor, requestId, expectedVersion: (await service().detail(actor, requestId, NOW)).version,
  idempotencyKey: `list-key-${String(keyCounter += 1).padStart(6, '0')}`, nowIso: NOW, ...body
} as TimeOffChangeCommand);
const withCode = (code: string) => (error: unknown) => (error as { code?: string } | null)?.code === code;

before(async () => {
  if (!skip) database = await startTimeOffChangesDatabase();
});
after(async () => {
  await database?.stop();
});

describe('approved time-off management lists', { skip }, () => {
  beforeEach(async () => {
    await resetTimeOffChangesSchema(db());
  });

  it('defaults to approved center requests starting today or later, newest start first', async () => {
    const past = await seedTimeOffRequest(db(), { startDate: '2026-10-01' });
    const today = await seedTimeOffRequest(db(), { startDate: '2026-10-07', startAt: '2026-10-07T07:00:00.000Z', endAt: '2026-10-08T07:00:00.000Z' });
    const later = await seedTimeOffRequest(db(), { startDate: '2026-11-16' });
    await seedTimeOffRequest(db(), { startDate: '2026-11-17', status: 'cancelled' });
    await seedTimeOffRequest(db(), { startDate: '2026-11-18', franchiseId: 45 });

    const page = await listAdminTimeOffRequests(db(), base);
    assert.deepEqual(page.items.map((item) => item.request.id), [later, today]);
    assert.equal(page.items[0].version, '1');
    assert.equal(page.nextCursor, null);
    const all = await listAdminTimeOffRequests(db(), { ...base, status: 'all' });
    assert.ok(all.items.some((item) => item.request.id === past));
    assert.equal(all.items.some((item) => item.request.franchiseId !== 44), false);
  });

  it('filters by status, tutor, request id, and local-date overlap in the center timezone', async () => {
    const sunday = await seedTimeOffRequest(db(), { startDate: '2026-11-15', tutorId: 4401 });
    const monday = await seedTimeOffRequest(db(), { startDate: '2026-11-16', tutorId: 4402 });
    const denied = await seedTimeOffRequest(db(), { startDate: '2026-11-16', status: 'denied', tutorId: 4401 });

    const overlap = await listAdminTimeOffRequests(db(), { ...base, status: 'all', from: '2026-11-16', to: '2026-11-16' });
    assert.deepEqual(overlap.items.map((item) => item.request.id).sort(), [monday, denied].sort(),
      'a full day ending at local midnight does not overlap the next day');
    assert.deepEqual((await listAdminTimeOffRequests(db(), { ...base, status: 'denied' })).items.map((item) => item.request.id), [denied]);
    assert.deepEqual((await listAdminTimeOffRequests(db(), { ...base, status: 'all', tutorId: 4402 })).items.map((item) => item.request.id), [monday]);
    assert.deepEqual((await listAdminTimeOffRequests(db(), { ...base, status: 'all', requestId: sunday })).items.map((item) => item.request.id), [sunday]);
  });

  it('pages with stable cursors bound to their filters', async () => {
    const ids: number[] = [];
    for (let index = 0; index < 55; index += 1) {
      ids.push(await seedTimeOffRequest(db(), { startDate: index < 30 ? '2026-11-16' : '2026-11-17' }));
    }
    const first = await listAdminTimeOffRequests(db(), base);
    assert.equal(first.items.length, 50);
    assert.ok(first.nextCursor);
    const second = await listAdminTimeOffRequests(db(), { ...base, cursor: first.nextCursor as string });
    assert.equal(second.items.length, 5);
    assert.equal(second.nextCursor, null);
    const seen = [...first.items, ...second.items].map((item) => item.request.id);
    assert.equal(new Set(seen).size, 55);
    assert.deepEqual(seen.slice(0, 25), ids.slice(30).reverse(), 'start_at DESC, then id DESC');

    await assert.rejects(listAdminTimeOffRequests(db(), { ...base, status: 'all', cursor: first.nextCursor as string }),
      withCode('TIME_OFF_INVALID_CURSOR'));
    await assert.rejects(listAdminTimeOffRequests(db(), { ...base, cursor: 'not-a-real-cursor' }), withCode('TIME_OFF_INVALID_CURSOR'));
    assert.equal((await listAdminTimeOffRequests(db(), { ...base, limit: 200 })).items.length, 55);
  });

  it('queues pending amendments oldest first for the center only and reports a pending flag on requests', async () => {
    const first = await seedTimeOffRequest(db(), { startDate: '2026-11-16', tutorId: 4401 });
    const second = await seedTimeOffRequest(db(), { startDate: '2026-11-18', tutorId: 4401 });
    const outside = await seedTimeOffRequest(db(), { startDate: '2026-11-18', tutorId: 4401, franchiseId: 45 });
    const proposed = (startDate: string) => ({ startDate, endDate: startDate, partialDay: false, type: 'sick', reason: 'Original request reason text' });
    const a = await execute(tutor, first, { action: 'propose', proposed: proposed('2026-11-17'), changeReason: 'Moved by one day' });
    const b = await execute(tutor, second, { action: 'propose', proposed: proposed('2026-11-19'), changeReason: 'Moved by one day' });
    await execute({ ...tutor, franchiseId: 45 }, outside, { action: 'propose', proposed: proposed('2026-11-19'),
      changeReason: 'Moved by one day' });

    const queue = await listPendingTimeOffAmendments(db(), { franchiseId: 44, timezone: TZ, limit: 50, nowIso: NOW });
    assert.deepEqual(queue.items.map((item) => item.amendment.id), [a.amendmentId, b.amendmentId]);
    assert.equal(queue.items[0].request.id, first);
    assert.equal(queue.items[0].actionable, true);
    const requests = await listAdminTimeOffRequests(db(), base);
    assert.equal(requests.items.find((item) => item.request.id === first)?.pendingAmendmentId, a.amendmentId);
  });

  it('lists only the center deliveries with an optional status filter', async () => {
    const mine = await seedTimeOffRequest(db(), { startDate: '2026-11-16', tutorId: 4401 });
    const other = await seedTimeOffRequest(db(), { startDate: '2026-11-16', tutorId: 4401, franchiseId: 45 });
    await execute(admin, mine, { action: 'cancel', changeReason: 'Center closed this week' });
    await execute({ ...admin, franchiseId: 45 }, other, { action: 'cancel', changeReason: 'Center closed this week' });
    await db().query("UPDATE public.time_off_change_deliveries SET status = 'failed', last_error = 'boom' WHERE channel = 'email'");

    const open = await listTimeOffChangeDeliveries(db(), { franchiseId: 44, limit: 50 });
    assert.deepEqual(open.items.map((item) => [item.requestId, item.channel, item.status]).sort(), [
      [mine, 'calendar', 'pending'], [mine, 'email', 'failed']
    ].sort());
    const failed = await listTimeOffChangeDeliveries(db(), { franchiseId: 44, status: 'failed', limit: 50 });
    assert.deepEqual(failed.items.map((item) => [item.channel, item.lastError]), [['email', 'boom']]);
  });

  it('keeps public requests admin-only and other centers invisible', async () => {
    const publicRequest = await seedTimeOffRequest(db(), { startDate: '2026-11-16', tutorId: null, source: 'public_timeoff_form' });
    const otherCenter = await seedTimeOffRequest(db(), { startDate: '2026-11-16', tutorId: 4401, franchiseId: 45 });
    await assert.rejects(service().detail(tutor, publicRequest, NOW), withCode('TIME_OFF_NOT_FOUND'));
    assert.equal((await service().detail(admin, publicRequest, NOW)).request.source, 'public');
    await assert.rejects(service().detail(tutor, otherCenter, NOW), withCode('TIME_OFF_NOT_FOUND'));
    await assert.rejects(service().detail(admin, otherCenter, NOW), withCode('TIME_OFF_NOT_FOUND'));
  });
});
