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
    autoClockOutEnabled: false,
    clockInTimeSnapEnabled: false
  });
});

test('stored automatic timekeeping flags are mapped from PostgreSQL', async () => {
  const db = {
    query: async () => ({
      rowCount: 1,
      rows: [{
        franchiseid: 77,
        auto_clock_out_enabled: true,
        clock_in_time_snap_enabled: true
      }]
    })
  };

  assert.deepEqual(await getFranchiseSettings(77, db as never), {
    franchiseId: 77,
    autoClockOutEnabled: true,
    clockInTimeSnapEnabled: true
  });
});

test('partial settings update preserves omitted values atomically', async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return {
        rowCount: 1,
        rows: [{
          franchiseid: 77,
          auto_clock_out_enabled: true,
          clock_in_time_snap_enabled: true
        }]
      };
    }
  };

  const result = await updateFranchiseSettings(
    { franchiseId: 77, clockInTimeSnapEnabled: true },
    db as never
  );

  assert.deepEqual(calls[0]?.params, [77, null, true]);
  assert.match(calls[0]?.sql ?? '', /ON CONFLICT \(franchiseid\)/i);
  assert.match(calls[0]?.sql ?? '', /COALESCE\(\$2, franchise_payroll_settings\.auto_clock_out_enabled\)/i);
  assert.match(calls[0]?.sql ?? '', /COALESCE\(\$3, franchise_payroll_settings\.clock_in_time_snap_enabled\)/i);
  assert.deepEqual(result, {
    franchiseId: 77,
    autoClockOutEnabled: true,
    clockInTimeSnapEnabled: true
  });
});
