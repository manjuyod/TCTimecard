import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyApprovedTimeOffChange,
  mapApprovedChangeDatabaseError,
  quoteApprovedTimeOffChange,
  retryTimeOffChangeTransaction
} from '../services/pto/timeOffChanges';
import type { NormalizedTimeOffSubmission } from '../types/timeoff';

const proposed: NormalizedTimeOffSubmission = {
  startDate: '2026-11-16',
  endDate: '2026-11-18',
  startAt: '2026-11-16T08:00:00.000Z',
  endAt: '2026-11-19T08:00:00.000Z',
  partialDay: false,
  leaveTime: null,
  returnTime: null,
  type: 'pto',
  storageType: 'pto',
  absenceLabel: 'Paid Time Off',
  reason: 'Family vacation out of town',
  durationHours: 72
};

const fakeClient = (rows: unknown[]) => ({
  calls: [] as Array<{ sql: string; params: unknown[] }>,
  async query(sql: string, params: unknown[] = []) {
    this.calls.push({ sql, params });
    return { rows };
  }
});

describe('approved time-off PTO adapter', () => {
  it('previews with normalized camelCase target fields and numeric cycle amounts', async () => {
    const client = fakeClient([{ quote: {
      eligible: true, reason: 'eligible', tracked: true, warnings: [],
      cycles: [{ cycleStart: '2026-01-01', oldDays: '2.00', newDays: '3', availableDays: '3.00', availableAfter: '2.00' }]
    } }]);

    const quote = await quoteApprovedTimeOffChange(client as never, 42, proposed);

    assert.match(client.calls[0].sql, /pto_preview_approved_change\(\$1, \$2::JSONB\)/);
    assert.deepEqual(client.calls[0].params, [42, proposed]);
    assert.deepEqual(quote.cycles, [{ cycleStart: '2026-01-01', oldDays: 2, newDays: 3, availableDays: 3, availableAfter: 2 }]);
    assert.equal(quote.eligible, true);
  });

  it('applies an operation and returns the exact new version', async () => {
    const client = fakeClient([{ version: '9007199254740994' }]);
    const version = await applyApprovedTimeOffChange(client as never, '1b4e28ba-2fa1-41d2-883f-0016d3cca427');

    assert.equal(version, '9007199254740994');
    assert.match(client.calls[0].sql, /time_off_apply_approved_change\(\$1::UUID\)::TEXT/);
  });

  it('maps database accounting failures to the documented codes', () => {
    const cases: Array<[Error, string, number]> = [
      [new Error('Insufficient shared PTO balance for cycle 9'), 'PTO_INSUFFICIENT_BALANCE', 409],
      [new Error('TIME_OFF_PTO_RECONCILIATION_REQUIRED'), 'TIME_OFF_PTO_RECONCILIATION_REQUIRED', 422],
      [new Error('TIME_OFF_PTO_IDENTITY_CONFLICT'), 'TIME_OFF_PTO_IDENTITY_CONFLICT', 422],
      [new Error('TIME_OFF_VERSION_CONFLICT: expected 3'), 'TIME_OFF_VERSION_CONFLICT', 409],
      [new Error('TIME_OFF_INVALID_STATE: request is cancelled'), 'TIME_OFF_INVALID_STATE', 409],
      [new Error('PTO_CENTER_DISABLED'), 'PTO_CENTER_DISABLED', 409],
      [new Error('PTO_IDENTITY_UNRESOLVED'), 'PTO_IDENTITY_UNRESOLVED', 422]
    ];
    for (const [error, code, status] of cases) {
      const mapped = mapApprovedChangeDatabaseError(error);
      assert.equal(mapped?.code, code, error.message);
      assert.equal(mapped?.status, status, error.message);
    }
    assert.equal(mapApprovedChangeDatabaseError(new Error('connection reset')), null);
  });
});

describe('deadlock and serialization retry', () => {
  const failure = (code: string) => Object.assign(new Error(code), { code });

  it('retries deadlocks and serialization failures for at most three whole attempts', async () => {
    for (const code of ['40P01', '40001']) {
      let attempts = 0;
      await assert.rejects(retryTimeOffChangeTransaction(async () => {
        attempts += 1;
        throw failure(code);
      }), new RegExp(code));
      assert.equal(attempts, 3, code);
    }
  });

  it('returns the first successful attempt and never retries other failures', async () => {
    let attempts = 0;
    assert.equal(await retryTimeOffChangeTransaction(async () => {
      attempts += 1;
      if (attempts === 1) throw failure('40P01');
      return 'committed';
    }), 'committed');
    assert.equal(attempts, 2);

    let other = 0;
    await assert.rejects(retryTimeOffChangeTransaction(async () => {
      other += 1;
      throw failure('23505');
    }));
    assert.equal(other, 1);
  });
});
