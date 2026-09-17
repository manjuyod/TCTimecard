import test from 'node:test';
import assert from 'node:assert/strict';
import type { AdminTimeEntryRouteDeps } from '../services/adminTimeEntry/contracts';
import { adminApp, withAdminHttp } from './helpers/adminTimeEntryHttp';
const empty = { items: [], nextCursor: null };
function deps(): AdminTimeEntryRouteDeps {
  return {
    listTutors: async () => empty,
    listDays: async () => empty,
    getDetail: async () => {
      throw Object.assign(new Error('Entry not found'), {
        status: 404,
        code: 'NOT_FOUND',
      });
    },
    getHistory: async () => empty,
    previewCorrection: async () => {
      throw new Error('Should not reach unsafe preview');
    },
    previewVoid: async () => {
      throw new Error('sql: SELECT private-secret');
    },
    previewRestore: async () => {
      throw new Error('unavailable');
    },
    commit: async () => {
      throw new Error('unexpected');
    },
    getOperation: async () => null,
  };
}
test('every admin route requires admin session', async () => {
  const paths = [
    '/tutors',
    '/days?start=2026-09-01&end=2026-09-15',
    '/tutor/88/day/2026-09-15',
    '/day/44/history',
    '/operations/00000000-0000-4000-8000-000000000000',
  ];
  for (const auth of [
    null,
    { accountType: 'TUTOR', accountId: 88, franchiseId: 77 },
  ])
    await withAdminHttp(adminApp(deps(), auth), async (base) => {
      for (const path of paths)
        assert.equal((await fetch(base + path)).status, auth ? 403 : 401);
      for (const path of [
        '/corrections/preview',
        '/day/44/void/preview',
        '/day/44/restore/preview',
        '/operations',
      ])
        assert.equal(
          (
            await fetch(base + path, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: '{}',
            })
          ).status,
          auth ? 403 : 401,
        );
    });
});
test('locked center request is enforced and response is direct paginated DTO', async () => {
  const d = deps();
  d.listTutors = async (input) => {
    assert.equal(input.franchiseId, 77);
    assert.equal(input.limit, 50);
    return empty;
  };
  await withAdminHttp(adminApp(d), async (base) => {
    const response = await fetch(base + '/tutors?franchiseId=78');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), empty);
  });
});
test('input bounds prevent service calls, out of scope missing is 404, errors are safe', async () => {
  await withAdminHttp(adminApp(deps()), async (base) => {
    for (const path of [
      '/tutors?limit=101',
      '/tutors?limit=true',
      '/days?start=2026-01-01&end=2026-04-04',
      '/tutor/0/day/2026-09-15',
    ])
      assert.equal((await fetch(base + path)).status, 400);
    assert.equal((await fetch(base + '/tutor/88/day/2026-09-15')).status, 404);
    const response = await fetch(base + '/day/44/void/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        franchiseId: 77,
        expectedRevision: 'hash',
        reason: 'Valid reason',
      }),
    });
    assert.equal(response.status, 500);
    assert.ok(
      !JSON.stringify(await response.json()).includes('private-secret'),
    );
    const unsafe = await fetch(base + '/corrections/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        franchiseId: 77,
        tutorId: 88,
        workDate: '2026-09-15',
        expectedRevision: 'hash',
        sessions: [],
        breaks: [],
        reason: 'Valid reason',
        status: 'approved',
        decidedBy: 123,
      }),
    });
    assert.equal(unsafe.status, 400);
  });
});
