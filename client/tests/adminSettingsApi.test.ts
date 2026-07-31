import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { fetchFranchiseSettings, updateFranchiseSettings } from '../src/lib/api';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test('franchise settings client sends scoped GET and Boolean PATCH', async () => {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ input: String(input), init });
    return new Response(JSON.stringify({ settings: { franchiseId: 77, autoClockOutEnabled: true } }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  };
  await fetchFranchiseSettings(77);
  await updateFranchiseSettings({ franchiseId: 77, autoClockOutEnabled: true });
  assert.equal(calls[0]?.input, '/api/admin/settings?franchiseId=77');
  assert.equal(calls[1]?.input, '/api/admin/settings');
  assert.equal(calls[1]?.init?.method, 'PATCH');
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), { franchiseId: 77, autoClockOutEnabled: true });
});
