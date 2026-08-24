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
    if (/pto_authenticated_linked_profile/i.test(sql)) {
      identityReads += 1; return { rowCount: 1, rows: [{ profile_id: '10' }] };
    }
    if (/JSONB_TO_RECORDSET/i.test(sql)) return { rowCount: 1, rows: [{ cycle_start: '2026-01-01', days: '1.00' }] };
    if (/FROM public\.pto_center_settings/i.test(sql)) return { rowCount: 1, rows: [{ enabled: true }] };
    if (/WITH policy AS/i.test(sql)) return { rowCount: 1, rows: [balanceRow] };
    throw new Error(`Unexpected query: ${sql}`);
  } };
  const result = await createPtoRouteStore(pool as never).quoteAuthenticated({
    franchiseId: 6, tutorId: 123, balanceDate: '2026-08-16', chargeDays: 1,
    dayCharges: [{ date: '2026-08-17', days: 1 }]
  });
  assert.equal(identityReads, 1);
  assert.equal(result.eligible, true);
  assert.deepEqual(result.cycleAllocations, [{ cycleStart: '2026-01-01', days: 1 }]);
  assert.equal(result.balance?.renewsOn, '2027-01-01');
});

test('authenticated quote uses an eligible linked pool without requiring the login center to be enabled', async () => {
  let sourceCenterReads = 0;
  const pool = { query: async (sql: string) => {
    if (/pto_authenticated_linked_profile/i.test(sql)
      || /FROM public\.pto_profile_centers center[\s\S]*pto_profile_crm_ids/i.test(sql)) {
      return { rowCount: 1, rows: [{ profile_id: '8' }] };
    }
    if (/JSONB_TO_RECORDSET/i.test(sql)) {
      return { rowCount: 1, rows: [{ cycle_start: '2026-01-01', days: '1.00' }] };
    }
    if (/FROM public\.pto_center_settings/i.test(sql)) {
      sourceCenterReads += 1;
      return { rowCount: 1, rows: [{ enabled: false }] };
    }
    if (/WITH policy AS/i.test(sql)) return { rowCount: 1, rows: [balanceRow] };
    throw new Error(`Unexpected query: ${sql}`);
  } };

  const result = await createPtoRouteStore(pool as never).quoteAuthenticated({
    franchiseId: 16, tutorId: 3487, balanceDate: '2026-08-23', chargeDays: 1,
    dayCharges: [{ date: '2026-08-24', days: 1 }]
  });

  assert.equal(result.eligible, true);
  assert.equal(result.balance?.availableDays, 4);
  assert.equal(sourceCenterReads, 0);
});

test('public quote sends only the SHA-256 bearer hash to PostgreSQL and returns no balance', async () => {
  const token = 'center-secret';
  let tokenParameter = '';
  const pool = { query: async (sql: string, params: unknown[] = []) => {
    if (/FROM public\.time_off_center_links/i.test(sql)) {
      tokenParameter = String(params[0]); return { rowCount: 1, rows: [{ franchiseid: 6 }] };
    }
    if (/FROM public\.pto_profile_emails email/i.test(sql)) return { rowCount: 1, rows: [{ profile_id: '10' }] };
    if (/JSONB_TO_RECORDSET/i.test(sql)) return { rowCount: 1, rows: [{ cycle_start: '2026-01-01', days: '1.00' }] };
    if (/FROM public\.pto_center_settings/i.test(sql)) return { rowCount: 1, rows: [{ enabled: true }] };
    if (/WITH policy AS/i.test(sql)) return { rowCount: 1, rows: [balanceRow] };
    throw new Error(`Unexpected query: ${sql}`);
  } };
  const store = createPtoRouteStore(pool as never);
  const center = await store.authorizePublicCenter(token);
  assert.deepEqual(center, { franchiseId: 6 });
  const result = await store.quotePublic({ franchiseId: 6, email: 'ada@example.com', balanceDate: '2026-08-16',
    chargeDays: 1, dayCharges: [{ date: '2026-08-17', days: 1 }] });
  assert.equal(tokenParameter, createHash('sha256').update(token).digest('hex'));
  assert.equal(tokenParameter.includes(token), false);
  assert.equal('balance' in result, false);
});

test('inactive or unknown public center tokens fail authorization before identity lookup', async () => {
  let identityReads = 0;
  const pool = { query: async (sql: string) => {
    if (/FROM public\.time_off_center_links/i.test(sql)) return { rowCount: 0, rows: [] };
    if (/FROM public\.pto_profile_emails/i.test(sql)) identityReads += 1;
    return { rowCount: 0, rows: [] };
  } };
  assert.equal(await createPtoRouteStore(pool as never).authorizePublicCenter('inactive-token'), null);
  assert.equal(identityReads, 0);
});

test('authenticated quote keeps true cross-January allocations in separate entitlement cycles', async () => {
  const pool = { query: async (sql: string) => {
    if (/pto_authenticated_linked_profile/i.test(sql)) {
      return { rowCount: 1, rows: [{ profile_id: '10' }] };
    }
    if (/JSONB_TO_RECORDSET/i.test(sql)) return { rowCount: 2, rows: [
      { cycle_start: '2026-01-01', days: '1.00' }, { cycle_start: '2027-01-01', days: '1.00' }
    ] };
    if (/FROM public\.pto_center_settings/i.test(sql)) return { rowCount: 1, rows: [{ enabled: true }] };
    if (/WITH policy AS/i.test(sql)) return { rowCount: 1, rows: [balanceRow] };
    throw new Error(`Unexpected query: ${sql}`);
  } };
  const result = await createPtoRouteStore(pool as never).quoteAuthenticated({
    franchiseId: 6, tutorId: 123, balanceDate: '2026-12-31', chargeDays: 2,
    dayCharges: [{ date: '2026-12-31', days: 1 }, { date: '2027-01-01', days: 1 }]
  });
  assert.deepEqual(result.cycleAllocations, [
    { cycleStart: '2026-01-01', days: 1 }, { cycleStart: '2027-01-01', days: 1 }
  ]);
});

test('two center identities resolve one canonical balance while dormant identities stay unresolved', async () => {
  const balanceProfileIds: string[] = [];
  const pool = { query: async (sql: string, params: unknown[] = []) => {
    if (/pto_authenticated_linked_profile/i.test(sql)) {
      const identity = `${params[0]}:${params[1]}`;
      return ['1:101', '2:202'].includes(identity)
        ? { rowCount: 1, rows: [{ profile_id: '10' }] }
        : { rowCount: 1, rows: [{ profile_id: null }] };
    }
    if (/FROM public\.pto_profile_emails email/i.test(sql)) {
      const identity = `${params[0]}:${params[1]}`;
      return ['1:ada.center1@example.com', '2:ada.center2@example.com'].includes(identity)
        ? { rowCount: 1, rows: [{ profile_id: '10' }] }
        : { rowCount: 0, rows: [] };
    }
    if (/JSONB_TO_RECORDSET/i.test(sql)) {
      return { rowCount: 1, rows: [{ cycle_start: '2026-01-01', days: '1.00' }] };
    }
    if (/FROM public\.pto_center_settings/i.test(sql)) {
      return { rowCount: 1, rows: [{ enabled: params[0] !== 3 }] };
    }
    if (/WITH policy AS/i.test(sql)) {
      balanceProfileIds.push(String(params[0]));
      return { rowCount: 1, rows: [balanceRow] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  } };
  const store = createPtoRouteStore(pool as never);
  const charge = { balanceDate: '2026-08-20', chargeDays: 1,
    dayCharges: [{ date: '2026-08-21', days: 1 }] };

  const authenticated = await Promise.all([
    store.quoteAuthenticated({ franchiseId: 1, tutorId: 101, ...charge }),
    store.quoteAuthenticated({ franchiseId: 2, tutorId: 202, ...charge })
  ]);
  const publicQuotes = await Promise.all([
    store.quotePublic({ franchiseId: 1, email: 'ada.center1@example.com', ...charge }),
    store.quotePublic({ franchiseId: 2, email: 'ada.center2@example.com', ...charge })
  ]);
  const dormantAuthenticated = await store.quoteAuthenticated({ franchiseId: 3, tutorId: 303, ...charge });
  const dormantPublic = await store.quotePublic({ franchiseId: 3, email: 'ada.center3@example.com', ...charge });

  assert.deepEqual(authenticated.map((result) => result.balance?.availableDays), [4, 4]);
  assert.deepEqual(publicQuotes.map((result) => result.eligible), [true, true]);
  assert.deepEqual(balanceProfileIds, ['10', '10', '10', '10', '10', '10']);
  assert.equal(dormantAuthenticated.reason, 'center_disabled');
  assert.equal(dormantPublic.reason, 'identity_unresolved');
});
