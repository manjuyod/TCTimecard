import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createPtoRouteStore } from '../services/pto/routeStore';

const balanceRow = {
  cycle_start: '2026-01-01', cycle_end: '2026-12-31', entitlement_days: '5.00',
  granted_days: '5.00', available_days: '4.00', reserved_days: '1.00', grant_count: '1',
  adjusted_days: '0.00', used_days: '0.00'
};

test('authenticated quote resolves the exact membership once and compares every cycle allocation', async () => {
  let identityReads = 0;
  const pool = { query: async (sql: string) => {
    if (/FROM public\.pto_profile_centers center[\s\S]*pto_profile_crm_ids/i.test(sql)) {
      identityReads += 1; return { rowCount: 1, rows: [{ profile_id: '10' }] };
    }
    if (/JSONB_TO_RECORDSET/i.test(sql)) return { rowCount: 1, rows: [{ cycle_start: '2026-01-01', days: '1.00' }] };
    if (/FROM public\.pto_center_settings/i.test(sql)) return { rowCount: 1, rows: [{ enabled: true }] };
    if (/WITH policy AS/i.test(sql)) return { rowCount: 1, rows: [balanceRow] };
    throw new Error(`Unexpected query: ${sql}`);
  } };
  const result = await createPtoRouteStore(pool as never).quoteAuthenticated({
    franchiseId: 6, tutorId: 123, chargeDays: 1, dayCharges: [{ date: '2026-08-17', days: 1 }]
  });
  assert.equal(identityReads, 1);
  assert.equal(result.eligible, true);
  assert.deepEqual(result.cycleAllocations, [{ cycleStart: '2026-01-01', days: 1 }]);
  assert.equal(result.balance?.renewsOn, '2027-01-01');
});

test('public quote sends only the SHA-256 bearer hash to PostgreSQL and returns no balance', async () => {
  const token = 'center-secret';
  let tokenParameter = '';
  const pool = { query: async (sql: string, params: unknown[] = []) => {
    if (/FROM public\.time_off_center_links/i.test(sql)) {
      tokenParameter = String(params[0]); return { rowCount: 1, rows: [{ franchiseid: 6, profile_id: '10' }] };
    }
    if (/JSONB_TO_RECORDSET/i.test(sql)) return { rowCount: 1, rows: [{ cycle_start: '2026-01-01', days: '1.00' }] };
    if (/FROM public\.pto_center_settings/i.test(sql)) return { rowCount: 1, rows: [{ enabled: true }] };
    if (/WITH policy AS/i.test(sql)) return { rowCount: 1, rows: [balanceRow] };
    throw new Error(`Unexpected query: ${sql}`);
  } };
  const result = await createPtoRouteStore(pool as never).quotePublic({ token, email: 'ada@example.com',
    chargeDays: 1, dayCharges: [{ date: '2026-08-17', days: 1 }] });
  assert.equal(tokenParameter, createHash('sha256').update(token).digest('hex'));
  assert.equal(tokenParameter.includes(token), false);
  assert.equal('balance' in result, false);
});
