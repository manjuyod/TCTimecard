import assert from 'node:assert/strict';
import { Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { afterEach, describe, it } from 'node:test';
import express, { Request } from 'express';
import { isTimeOffChangesEnabled } from '../config/timeOffChanges';
import { createTimeOffRouter } from '../routes/timeoff';
import { createTimeOffChangesRouter, type TimeOffChangeRouteDeps } from '../routes/timeOffChanges';
import { TimeOffChangeError } from '../services/timeOffChangeErrors';
import { createTimeOffChangeService } from '../services/timeOffChanges';
import type { TimeOffChangeCommand, TimeOffChangeReceipt } from '../types/timeOffChanges';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

type Session = { accountType: 'TUTOR' | 'ADMIN'; accountId: number; franchiseId: number } | null;
const receipt: TimeOffChangeReceipt = {
  operationId: '1b4e28ba-2fa1-41d2-883f-0016d3cca427', requestId: 42, version: '5', amendmentId: '7',
  outcome: 'proposed', deliveryIds: []
};

function fakeDeps(overrides: Partial<TimeOffChangeRouteDeps> = {}) {
  const calls = { execute: [] as TimeOffChangeCommand[], detail: [] as unknown[], preview: [] as unknown[],
    lists: [] as Array<{ kind: string; input: Record<string, unknown> }>, retries: [] as unknown[] };
  const deps: Partial<TimeOffChangeRouteDeps> = {
    enabled: () => true,
    nowIso: () => '2026-10-07T17:00:00.000Z',
    resolveTimezone: async () => 'America/Los_Angeles',
    service: {
      execute: async (command) => { calls.execute.push(command); return receipt; },
      detail: async (actor, requestId, nowIso) => {
        calls.detail.push({ actor, requestId, nowIso });
        return { version: '4' } as never;
      },
      preview: async (input) => { calls.preview.push(input); return { version: '4' } as never; }
    },
    listRequests: async (input) => { calls.lists.push({ kind: 'requests', input: { ...input } }); return { items: [], nextCursor: null }; },
    listAmendments: async (input) => { calls.lists.push({ kind: 'amendments', input: { ...input } }); return { items: [], nextCursor: null }; },
    listDeliveries: async (input) => { calls.lists.push({ kind: 'deliveries', input: { ...input } }); return { items: [], nextCursor: null }; },
    retryDelivery: async (input) => { calls.retries.push(input); return { id: input.deliveryId, status: 'pending' } as never; },
    ...overrides
  };
  return { calls, deps };
}

async function startApp(session: Session, deps: Partial<TimeOffChangeRouteDeps>, withLegacyRouter = false): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as Request).session = {
      auth: session ? { ...session, displayName: 'Ada Lovelace', createdAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString() } : undefined,
      save(callback: (error?: unknown) => void) { callback(); },
      destroy(callback: (error?: unknown) => void) { callback(); }
    } as Request['session'];
    next();
  });
  app.use('/api', createTimeOffChangesRouter(deps));
  if (withLegacyRouter) {
    app.use('/api', createTimeOffRouter({
      resolveTimezone: async () => 'America/Los_Angeles',
      resolveTimeOffNoticeRequired: async () => true,
      fetchById: async (id) => ({ id, franchiseId: 6, tutorId: 123, status: 'pending' } as never),
      fetchTutors: async () => new Map(),
      getPtoPolicyStatus: async () => ({ enabled: false, reason: 'center_disabled' }),
      changesEnabled: () => deps.enabled?.() ?? false
    }));
  }
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const tutor: Session = { accountType: 'TUTOR', accountId: 123, franchiseId: 6 };
const admin: Session = { accountType: 'ADMIN', accountId: 9, franchiseId: 6 };
const call = (origin: string, method: string, path: string, body?: unknown) => fetch(`${origin}/api${path}`, {
  method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body)
});
const proposed = { startDate: '2026-11-16', endDate: '2026-11-17', partialDay: false, type: 'pto', reason: 'Family trip out of town' };

const TUTOR_ROUTES: Array<[string, string, unknown?]> = [
  ['GET', '/timeoff/42/change-detail'],
  ['POST', '/timeoff/42/change-preview', { proposed }],
  ['POST', '/timeoff/42/amendments', { expectedVersion: '4', idempotencyKey: 'key-00000001', proposed, changeReason: 'Flights moved by a day' }],
  ['POST', '/timeoff/42/amendments/7/withdraw', { expectedVersion: '4', idempotencyKey: 'key-00000001' }],
  ['POST', '/timeoff/42/cancel-approved', { expectedVersion: '4', idempotencyKey: 'key-00000001', changeReason: 'Plans changed for us' }]
];
const ADMIN_ROUTES: Array<[string, string, unknown?]> = [
  ['GET', '/timeoff/admin/requests'],
  ['GET', '/timeoff/admin/amendments'],
  ['GET', '/timeoff/admin/42/change-detail'],
  ['POST', '/timeoff/admin/42/change-preview', { proposed }],
  ['POST', '/timeoff/admin/42/amendments/7/decide', { expectedVersion: '4', idempotencyKey: 'key-00000001', decision: 'approve' }],
  ['POST', '/timeoff/admin/42/change', { expectedVersion: '4', idempotencyKey: 'key-00000001', proposed, changeReason: 'Coverage adjusted' }],
  ['POST', '/timeoff/admin/42/cancel-approved', { expectedVersion: '4', idempotencyKey: 'key-00000001', changeReason: 'Center closed this week' }],
  ['GET', '/timeoff/admin/change-deliveries'],
  ['POST', '/timeoff/admin/change-deliveries/1b4e28ba-2fa1-41d2-883f-0016d3cca427/retry']
];

describe('approved time-off change routes: authentication and scope', () => {
  it('requires authentication on every endpoint, including the capability read', async () => {
    const { calls, deps } = fakeDeps();
    const origin = await startApp(null, deps);
    for (const [method, path, body] of [...TUTOR_ROUTES, ...ADMIN_ROUTES, ['GET', '/timeoff/admin/change-capabilities']] as Array<[string, string, unknown?]>) {
      assert.equal((await call(origin, method, path, body)).status, 401, `${method} ${path}`);
    }
    assert.equal(calls.execute.length + calls.detail.length + calls.preview.length + calls.lists.length + calls.retries.length, 0);
  });

  it('keeps tutor and admin endpoints role-separated without reaching the service', async () => {
    const { calls, deps } = fakeDeps();
    const tutorOrigin = await startApp(tutor, deps);
    for (const [method, path, body] of ADMIN_ROUTES) {
      const response = await call(tutorOrigin, method, path, body);
      assert.equal(response.status, 403, `${method} ${path}`);
    }
    const adminOrigin = await startApp(admin, deps);
    for (const [method, path, body] of TUTOR_ROUTES) {
      assert.equal((await call(adminOrigin, method, path, body)).status, 403, `${method} ${path}`);
    }
    assert.equal(calls.execute.length + calls.detail.length + calls.preview.length + calls.lists.length + calls.retries.length, 0);
  });

  it('derives the actor from the session and ignores body-supplied identity', async () => {
    const { calls, deps } = fakeDeps();
    const tutorOrigin = await startApp(tutor, deps);
    const response = await call(tutorOrigin, 'POST', '/timeoff/42/amendments', {
      expectedVersion: '4', idempotencyKey: 'key-00000001', proposed, changeReason: 'Flights moved by a day',
      actor: { kind: 'ADMIN', accountId: 1, franchiseId: 99 }, franchiseId: 99, tutorId: 555
    });
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), receipt);
    assert.deepEqual(calls.execute[0].actor, { kind: 'TUTOR', accountId: 123, franchiseId: 6 });
    assert.equal(calls.execute[0].action, 'propose');

    const adminOrigin = await startApp(admin, deps);
    await call(adminOrigin, 'POST', '/timeoff/admin/42/cancel-approved?franchiseId=99', {
      expectedVersion: '4', idempotencyKey: 'key-00000002', changeReason: 'Center closed this week', franchiseId: 99
    });
    assert.deepEqual(calls.execute[1].actor, { kind: 'ADMIN', accountId: 9, franchiseId: 6 });
    assert.equal(calls.execute[1].action, 'cancel');
  });

  it('maps each endpoint to its command', async () => {
    const { calls, deps } = fakeDeps();
    const tutorOrigin = await startApp(tutor, deps);
    const adminOrigin = await startApp(admin, deps);
    await call(tutorOrigin, 'POST', '/timeoff/42/amendments/7/withdraw', { expectedVersion: '4', idempotencyKey: 'key-00000003' });
    await call(adminOrigin, 'POST', '/timeoff/admin/42/amendments/7/decide',
      { expectedVersion: '4', idempotencyKey: 'key-00000004', decision: 'deny', reason: 'Coverage is short' });
    await call(adminOrigin, 'POST', '/timeoff/admin/42/amendments/7/decide',
      { expectedVersion: '5', idempotencyKey: 'key-00000005', decision: 'approve' });
    await call(adminOrigin, 'POST', '/timeoff/admin/42/change',
      { expectedVersion: '6', idempotencyKey: 'key-00000006', proposed, changeReason: 'Coverage adjusted' });
    assert.deepEqual(calls.execute.map((command) => [command.action, (command as { amendmentId?: string }).amendmentId ?? null]), [
      ['withdraw', '7'], ['deny_amendment', '7'], ['approve_amendment', '7'], ['admin_edit', null]
    ]);
    assert.equal((calls.execute[1] as { reason?: string }).reason, 'Coverage is short');
  });
});

describe('approved time-off change routes: inputs and errors', () => {
  const validatingService = () => createTimeOffChangeService({
    pool: { connect: async () => { throw new Error('database must not be reached'); } } as never,
    resolveTimezone: async () => 'America/Los_Angeles',
    resolveNoticeRequired: async () => true,
    resolveContact: async () => null,
    overlapEnabled: () => false,
    appOrigin: 'https://timecard.example.com'
  });

  it('returns the documented 400 codes for malformed ids, versions, enums, and reasons', async () => {
    const { deps } = fakeDeps({ service: validatingService() });
    const tutorOrigin = await startApp(tutor, deps);
    const adminOrigin = await startApp(admin, deps);
    const cases: Array<[string, string, string, unknown]> = [
      [tutorOrigin, 'POST', '/timeoff/abc/amendments', { expectedVersion: '4', idempotencyKey: 'key-00000001', proposed, changeReason: 'Flights moved' }],
      [tutorOrigin, 'POST', '/timeoff/42/amendments', { expectedVersion: 4, idempotencyKey: 'key-00000001', proposed, changeReason: 'Flights moved by a day' }],
      [tutorOrigin, 'POST', '/timeoff/42/amendments', { expectedVersion: '04', idempotencyKey: 'key-00000001', proposed, changeReason: 'Flights moved by a day' }],
      [tutorOrigin, 'POST', '/timeoff/42/amendments', { expectedVersion: '4', idempotencyKey: 'key-00000001', proposed, changeReason: 'too short' }],
      [tutorOrigin, 'POST', '/timeoff/42/amendments/x7/withdraw', { expectedVersion: '4', idempotencyKey: 'key-00000001' }],
      [adminOrigin, 'POST', '/timeoff/admin/42/amendments/7/decide', { expectedVersion: '4', idempotencyKey: 'key-00000001', decision: 'maybe' }],
      [adminOrigin, 'POST', '/timeoff/admin/42/amendments/7/decide', { expectedVersion: '4', idempotencyKey: 'key-00000001', decision: 'deny', reason: '' }],
      [adminOrigin, 'POST', '/timeoff/admin/42/cancel-approved', { expectedVersion: '4', idempotencyKey: 'short', changeReason: 'Center closed this week' }]
    ];
    for (const [origin, method, path, body] of cases) {
      const response = await call(origin, method, path, body);
      assert.equal(response.status, 400, `${path} ${JSON.stringify(body)}`);
      assert.equal((await response.json() as { code: string }).code, 'TIME_OFF_INVALID_INPUT', path);
    }
  });

  it('maps domain errors to their status and code without leaking details', async () => {
    const failures: Array<[TimeOffChangeError, number]> = [
      [new TimeOffChangeError('TIME_OFF_SELF_APPROVAL', 'You cannot approve or directly edit your own time off', 403), 403],
      [new TimeOffChangeError('TIME_OFF_NOT_FOUND', 'Time off request not found', 404), 404],
      [new TimeOffChangeError('TIME_OFF_IDEMPOTENCY_MISMATCH', 'Key reused', 409), 409],
      [new TimeOffChangeError('TIME_OFF_PTO_RECONCILIATION_REQUIRED', 'Reconcile first', 422), 422]
    ];
    for (const [error, status] of failures) {
      const { deps } = fakeDeps({ service: {
        execute: async () => { throw error; }, detail: async () => { throw error; }, preview: async () => { throw error; }
      } });
      const origin = await startApp(admin, deps);
      const response = await call(origin, 'POST', '/timeoff/admin/42/amendments/7/decide',
        { expectedVersion: '4', idempotencyKey: 'key-00000001', decision: 'approve' });
      assert.equal(response.status, status);
      assert.deepEqual(await response.json(), { error: error.message, code: error.code });
    }
  });

  it('validates list filters, limits, and cursors', async () => {
    const { calls, deps } = fakeDeps();
    const origin = await startApp(admin, deps);
    const ok = await call(origin, 'GET', '/timeoff/admin/requests?status=all&tutorId=123&from=2026-11-01&to=2026-11-30&requestId=42&limit=200&cursor=abc_DEF-1');
    assert.equal(ok.status, 200);
    assert.deepEqual(calls.lists[0], { kind: 'requests', input: {
      franchiseId: 6, timezone: 'America/Los_Angeles', status: 'all', tutorId: 123, from: '2026-11-01', to: '2026-11-30',
      requestId: 42, cursor: 'abc_DEF-1', limit: 200, today: '2026-10-07'
    } });
    await call(origin, 'GET', '/timeoff/admin/requests');
    assert.equal(calls.lists[1].input.limit, 50);
    assert.equal(calls.lists[1].input.status, undefined);
    for (const query of ['limit=201', 'limit=0', 'status=deleted', 'from=2026-13-01', 'tutorId=-1', 'cursor=bad%20cursor']) {
      const response = await call(origin, 'GET', `/timeoff/admin/requests?${query}`);
      assert.equal(response.status, 400, query);
    }
    assert.equal((await call(origin, 'GET', '/timeoff/admin/change-deliveries?status=sent')).status, 400);
    assert.equal(calls.lists.length, 2);
  });
});

describe('approved time-off change routes: feature gate and compatibility', () => {
  it('defaults the flag off and enables it only for the exact string true', () => {
    assert.equal(isTimeOffChangesEnabled({}), false);
    assert.equal(isTimeOffChangesEnabled({ TIME_OFF_CHANGES_ENABLED: 'TRUE' }), false);
    assert.equal(isTimeOffChangesEnabled({ TIME_OFF_CHANGES_ENABLED: '1' }), false);
    assert.equal(isTimeOffChangesEnabled({ TIME_OFF_CHANGES_ENABLED: 'true' }), true);
  });

  it('hides new operations when disabled but keeps the admin capability readable', async () => {
    const { calls, deps } = fakeDeps({ enabled: () => false });
    const adminOrigin = await startApp(admin, deps);
    const capability = await call(adminOrigin, 'GET', '/timeoff/admin/change-capabilities');
    assert.equal(capability.status, 200);
    assert.deepEqual(await capability.json(), { enabled: false });
    for (const [method, path, body] of ADMIN_ROUTES) {
      const response = await call(adminOrigin, method, path, body);
      assert.equal(response.status, 404, `${method} ${path}`);
      assert.equal((await response.json() as { code: string }).code, 'TIME_OFF_CHANGES_DISABLED');
    }
    const tutorOrigin = await startApp(tutor, deps);
    for (const [method, path, body] of TUTOR_ROUTES) {
      assert.equal((await call(tutorOrigin, method, path, body)).status, 404, `${method} ${path}`);
    }
    assert.equal(calls.execute.length + calls.lists.length + calls.retries.length, 0);
  });

  it('registers management routes ahead of the existing request detail route', async () => {
    const { calls, deps } = fakeDeps();
    const origin = await startApp(admin, deps, true);
    assert.equal((await call(origin, 'GET', '/timeoff/admin/requests')).status, 200);
    assert.equal((await call(origin, 'GET', '/timeoff/admin/amendments')).status, 200);
    assert.equal((await call(origin, 'GET', '/timeoff/admin/change-deliveries')).status, 200);
    assert.equal(calls.lists.length, 3);
    const legacyDetail = await call(origin, 'GET', '/timeoff/admin/42');
    assert.equal(legacyDetail.status, 200);
    assert.equal((await legacyDetail.json() as { request: { id: number } }).request.id, 42);
  });

  it('adds changesEnabled to the existing tutor policy without changing its other fields', async () => {
    for (const enabled of [true, false]) {
      const { deps } = fakeDeps({ enabled: () => enabled });
      const origin = await startApp(tutor, deps, true);
      const response = await call(origin, 'GET', '/timeoff/policy');
      const body = await response.json() as { policy: Record<string, unknown> };
      assert.equal(response.status, 200);
      assert.equal(body.policy.changesEnabled, enabled);
      assert.equal(body.policy.noticeDays, 14);
    }
  });

  it('retries only new-operation deliveries through their own scoped endpoint', async () => {
    const { calls, deps } = fakeDeps();
    const origin = await startApp(admin, deps);
    const response = await call(origin, 'POST', '/timeoff/admin/change-deliveries/1b4e28ba-2fa1-41d2-883f-0016d3cca427/retry');
    assert.equal(response.status, 200);
    assert.deepEqual(calls.retries, [{ franchiseId: 6, deliveryId: '1b4e28ba-2fa1-41d2-883f-0016d3cca427',
      nowIso: '2026-10-07T17:00:00.000Z' }]);
    assert.equal((await call(origin, 'POST', '/timeoff/admin/change-deliveries/not-a-uuid/retry')).status, 400);
  });
});
