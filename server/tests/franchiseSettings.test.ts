import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getFranchiseSettings,
  updateFranchiseSettings
} from '../services/franchiseSettings';

test('missing franchise settings remain safely disabled', async () => {
  const db = {
    query: async () => ({ rowCount: 0, rows: [] })
  };

  assert.deepEqual(await getFranchiseSettings(77, db as never), {
    franchiseId: 77,
    autoClockOutEnabled: false
  });
});

test('stored auto-clock-out flag is mapped from PostgreSQL', async () => {
  const db = {
    query: async () => ({
      rowCount: 1,
      rows: [{ franchiseid: 77, auto_clock_out_enabled: true }]
    })
  };

  assert.deepEqual(await getFranchiseSettings(77, db as never), {
    franchiseId: 77,
    autoClockOutEnabled: true
  });
});

test('updating settings persists the requested franchise and Boolean', async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return {
        rowCount: 1,
        rows: [{ franchiseid: 77, auto_clock_out_enabled: true }]
      };
    }
  };

  const result = await updateFranchiseSettings(
    { franchiseId: 77, autoClockOutEnabled: true },
    db as never
  );

  assert.deepEqual(calls[0]?.params, [77, true]);
  assert.match(calls[0]?.sql ?? '', /ON CONFLICT \(franchiseid\)/i);
  assert.deepEqual(result, { franchiseId: 77, autoClockOutEnabled: true });
});
