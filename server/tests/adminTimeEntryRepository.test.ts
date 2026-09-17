import test from 'node:test';
import assert from 'node:assert/strict';
import type { PoolClient } from 'pg';
import {
  assertRestoreSnapshot,
  readEntry,
} from '../services/adminTimeEntry/repository';
import { pendingEntry } from './helpers/adminTimeEntryFixtures';
import {
  encodeCursor,
  decodeCursor,
  validateDayFilters,
} from '../services/adminTimeEntry/pagination';
test('aggregate locks scoped parent first and keeps nullable session ends', async () => {
  const queries: string[] = [];
  const client = {
    query: async (sql: string, params: unknown[]) => {
      queries.push(sql);
      if (sql.includes('FROM public.time_entry_days')) {
        assert.deepEqual(params, [77, 88, '2026-09-15']);
        return {
          rows: [
            {
              id: 44,
              franchiseid: 77,
              tutorid: 88,
              work_date: '2026-09-15',
              timezone: 'America/Los_Angeles',
              status: 'draft',
              clock_state: 1,
              created_at: new Date(),
              updated_at: new Date(),
            },
          ],
        };
      }
      if (sql.includes('time_entry_sessions'))
        return {
          rows: [
            {
              id: 99,
              start_at: new Date('2026-09-15T22:00:00Z'),
              end_at: null,
              sort_order: 0,
              created_at: new Date(),
              updated_at: new Date(),
            },
          ],
        };
      return { rows: [] };
    },
  } as unknown as PoolClient;
  const day = await readEntry(
    client,
    { franchiseId: 77, tutorId: 88, workDate: '2026-09-15' },
    true,
  );
  assert.ok(queries[0].includes('FOR UPDATE'));
  assert.equal(day?.sessions[0].endAt, null);
  assert.equal(day?.workDate, '2026-09-15');
});
test('cursor cannot cross center or filter scope and range is capped at 93 days', () => {
  const cursor = encodeCursor({ franchiseId: 77 }, ['2026-09-15', 88, 44]);
  assert.deepEqual(decodeCursor(cursor, { franchiseId: 77 }), [
    '2026-09-15',
    88,
    44,
  ]);
  assert.throws(() => decodeCursor(cursor, { franchiseId: 78 }));
  assert.throws(() =>
    validateDayFilters({
      franchiseId: 77,
      start: '2026-01-01',
      end: '2026-04-04',
      limit: 50,
    }),
  );
});
test('restore snapshot requires the original parent identity, date and timezone', async () => {
  const preserved = pendingEntry({ status: 'voided' });
  const client = {
    query: async () => ({ rows: [{ metadata: { after: preserved } }] }),
  } as unknown as PoolClient;
  await assertRestoreSnapshot(client, preserved);
  for (const change of [
    { id: 45 },
    { franchiseId: 78 },
    { tutorId: 89 },
    { workDate: '2026-09-14' },
    { timezone: 'America/Vancouver' },
  ])
    await assert.rejects(
      () => assertRestoreSnapshot(client, { ...preserved, ...change }),
      { code: 'ENTRY_CHANGED' },
    );
});
