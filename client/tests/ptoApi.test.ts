import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import * as api from '../src/lib/api';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

type PtoApi = {
  fetchPtoActivationPreview: (franchiseId: number) => Promise<unknown>;
  activatePtoCenter: (franchiseId: number) => Promise<unknown>;
  fetchAdminPtoProfiles: (args: { franchiseId: number; search?: string; page?: number; pageSize?: number }) => Promise<unknown>;
  fetchTutorPtoProfile: () => Promise<unknown>;
  quoteTutorPto: (payload: Record<string, unknown>) => Promise<unknown>;
  addTutorPtoEmail: (email: string) => Promise<unknown>;
};

test('PTO API client exposes scoped admin activation and profile requests', async () => {
  const pto = api as unknown as PtoApi;
  assert.equal(typeof pto.fetchPtoActivationPreview, 'function');
  assert.equal(typeof pto.activatePtoCenter, 'function');
  assert.equal(typeof pto.fetchAdminPtoProfiles, 'function');

  const calls: Array<{ input: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ input: String(input), init });
    const body = String(input).includes('activation-preview')
      ? { preview: { activeCrmTutorCount: 2 } }
      : String(input).includes('/activate')
        ? { sync: { activeTutorCount: 2 } }
        : { items: [], page: 2, pageSize: 25, total: 0 };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  await pto.fetchPtoActivationPreview(77);
  await pto.activatePtoCenter(77);
  await pto.fetchAdminPtoProfiles({ franchiseId: 77, search: 'Ada Lovelace', page: 2, pageSize: 25 });

  assert.equal(calls[0]?.input, '/api/pto/admin/activation-preview?franchiseId=77');
  assert.equal(calls[1]?.input, '/api/pto/admin/activate');
  assert.equal(calls[1]?.init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), { franchiseId: 77 });
  assert.equal(calls[2]?.input, '/api/pto/admin/profiles?franchiseId=77&search=Ada+Lovelace&page=2&pageSize=25');
});

test('PTO API client sends authenticated quote and alternate-email requests', async () => {
  const pto = api as unknown as PtoApi;
  assert.equal(typeof pto.fetchTutorPtoProfile, 'function');
  assert.equal(typeof pto.quoteTutorPto, 'function');
  assert.equal(typeof pto.addTutorPtoEmail, 'function');

  const calls: Array<{ input: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ input: String(input), init });
    const body = String(input).endsWith('/emails')
      ? { email: { id: '9', email: 'ada+pto@example.com', source: 'manual', active: true } }
      : String(input).endsWith('/quote')
        ? { eligible: true, reason: 'eligible', chargeDays: 1, cycleAllocations: [] }
        : { profile: null, memberships: [], emails: [], balance: null };
    return new Response(JSON.stringify(body), { status: String(input).endsWith('/emails') ? 201 : 200,
      headers: { 'Content-Type': 'application/json' } });
  };

  await pto.fetchTutorPtoProfile();
  await pto.quoteTutorPto({ startDate: '2026-09-01', endDate: '2026-09-01', partialDay: false });
  await pto.addTutorPtoEmail('Ada+PTO@example.com');

  assert.equal(calls[0]?.input, '/api/pto/me');
  assert.equal(calls[1]?.input, '/api/pto/me/quote');
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), {
    startDate: '2026-09-01', endDate: '2026-09-01', partialDay: false
  });
  assert.equal(calls[2]?.input, '/api/pto/me/emails');
  assert.deepEqual(JSON.parse(String(calls[2]?.init?.body)), { email: 'Ada+PTO@example.com' });
});
