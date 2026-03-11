import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DateTime } from 'luxon';
import { setPostgresPoolOverride } from '../db/postgres';
import {
  computeCustomSemimonthlyWindow,
  resolvePayPeriod,
  validateCustomSemimonthlyConfig
} from '../payroll/payPeriodResolution';

type QueryResult = { rowCount: number; rows: Array<Record<string, unknown>> };
type FakePool = {
  query: (sql: string, params?: unknown[]) => Promise<QueryResult>;
};

afterEach(() => {
  setPostgresPoolOverride(undefined);
});

test('custom semimonthly resolves the second half within a month', () => {
  const forDateLocal = DateTime.fromISO('2026-03-15', { zone: 'America/Los_Angeles' }).startOf('day');
  const window = computeCustomSemimonthlyWindow(forDateLocal, {
    period1StartDay: 11,
    period1EndDay: 25,
    period2StartDay: 26,
    period2EndDay: 10
  });

  assert.equal(window.startLocal.toISODate(), '2026-03-11');
  assert.equal(window.endLocal.toISODate(), '2026-03-25');
});

test('custom semimonthly resolves the cross-month half', () => {
  const forDateLocal = DateTime.fromISO('2026-03-05', { zone: 'America/Los_Angeles' }).startOf('day');
  const window = computeCustomSemimonthlyWindow(forDateLocal, {
    period1StartDay: 11,
    period1EndDay: 25,
    period2StartDay: 26,
    period2EndDay: 10
  });

  assert.equal(window.startLocal.toISODate(), '2026-02-26');
  assert.equal(window.endLocal.toISODate(), '2026-03-10');
});

test('custom semimonthly clamps to shorter months without gaps', () => {
  const forDateLocal = DateTime.fromISO('2025-02-28', { zone: 'America/Los_Angeles' }).startOf('day');
  const window = computeCustomSemimonthlyWindow(forDateLocal, {
    period1StartDay: 11,
    period1EndDay: 31,
    period2StartDay: 1,
    period2EndDay: 10
  });

  assert.equal(window.startLocal.toISODate(), '2025-02-11');
  assert.equal(window.endLocal.toISODate(), '2025-02-28');
});

test('custom semimonthly validation rejects gaps and overlaps', () => {
  const invalid = validateCustomSemimonthlyConfig({
    period1StartDay: 11,
    period1EndDay: 24,
    period2StartDay: 26,
    period2EndDay: 10
  });

  assert.equal(invalid.ok, false);
  if (invalid.ok) return;
  assert.match(invalid.error, /contiguous|gap|overlap/i);
});

test('pay period resolver prefers overrides over recurring custom settings', async () => {
  const fakePool: FakePool = {
    async query(sql: string): Promise<QueryResult> {
      if (sql.includes('FROM franchise_payroll_settings')) {
        return {
          rowCount: 1,
          rows: [
            {
              franchiseid: 42,
              policytype: 'strict_approval',
              timezone: 'America/Los_Angeles',
              pay_period_type: 'custom_semimonthly',
              auto_email_enabled: false,
              custom_period_1_start_day: 11,
              custom_period_1_end_day: 25,
              custom_period_2_start_day: 26,
              custom_period_2_end_day: 10
            }
          ]
        };
      }

      if (sql.includes('FROM franchise_pay_period_overrides')) {
        return {
          rowCount: 1,
          rows: [
            {
              id: 99,
              periodstart: '2026-03-12',
              periodend: '2026-03-18',
              createdat: '2026-03-01T00:00:00.000Z'
            }
          ]
        };
      }

      throw new Error(`Unexpected query: ${sql}`);
    }
  };

  setPostgresPoolOverride(fakePool as never);

  const payPeriod = await resolvePayPeriod(42, '2026-03-15');

  assert.equal(payPeriod.source, 'override');
  assert.equal(payPeriod.overrideId, 99);
  assert.equal(payPeriod.startDate, '2026-03-12');
  assert.equal(payPeriod.endDate, '2026-03-18');
  assert.equal(payPeriod.periodType, 'custom_semimonthly');
});
