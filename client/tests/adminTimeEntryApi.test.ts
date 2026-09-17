import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { commitAdminTimeEntryOperation, getAdminTimeEntryDetail } from '../src/lib/adminTimeEntryApi';
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test('correction commits send the reviewed token and stable operation id with session credentials', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify({ operationId: 'op-1' }), { status: 200 });
  };
  const request = { franchiseId: 77, operationId: 'op-1', previewToken: 'signed-preview' };
  await commitAdminTimeEntryOperation(request);
  await commitAdminTimeEntryOperation(request);
  assert.equal(calls[0].url, '/api/time-entry/admin/operations');
  assert.equal(calls[0].init?.credentials, 'include');
  assert.equal(calls[0].init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), request);
  assert.equal(calls[1].init?.body, calls[0].init?.body);
});
test('lookup failure is an error, never a missing-day result', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ code: 'ROSTER_UNAVAILABLE', error: 'Roster unavailable' }), { status: 503 });
  await assert.rejects(getAdminTimeEntryDetail({ franchiseId: 77, tutorId: 88, workDate: '2026-09-15' }),
    (err: unknown) => (err as { status?: number }).status === 503);
});
