import test from 'node:test';
import assert from 'node:assert/strict';
import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { commitAdminOperation } from '../services/adminTimeEntry/operations';
import { signAdminPreview } from '../services/adminTimeEntry/previewToken';
import { testCommand } from './helpers/adminTimeEntryFixtures';
import { pendingEntry } from './helpers/adminTimeEntryFixtures';
import { revisionForEntry } from '../services/adminTimeEntry/revision';
const actor = { accountId: 100, franchiseId: 77 };
test('expired preview can recover immutable outcome without writes; actor cannot recover another actor', async () => {
  const result = {
    operationId: randomUUID(),
    auditId: 12,
    action: 'void',
    entryId: 44,
    status: 'voided',
    committedAt: '2026-09-16T12:01:00Z',
    before: testCommand.before,
    after: testCommand.after,
  };
  const { createHash } = await import('node:crypto');
  const { canonicalJsonStringify } = await import(
    '../services/scheduleSnapshot'
  );
  const hash = createHash('sha256')
    .update(canonicalJsonStringify(testCommand))
    .digest('hex');
  const queries: string[] = [];
  const client = {
    query: async (sql: string) => {
      queries.push(sql);
      return {
        rows: sql.includes('time_entry_audit')
          ? [
              {
                metadata: {
                  commandHash: hash,
                  result,
                  actor: { accountId: 100, franchiseId: 77 },
                },
                actor_account_id: 100,
                franchiseid: 77,
              },
            ]
          : [],
      };
    },
    release: () => {},
  } as unknown as PoolClient;
  const pool = { connect: async () => client } as unknown as Pool;
  const input = {
    operationId: result.operationId,
    previewToken: signAdminPreview(testCommand, 'secret'),
  };
  assert.deepEqual(
    await commitAdminOperation(actor, input, {
      pool,
      now: () => new Date('2026-09-16T13:00:00Z'),
      secret: 'secret',
    }),
    result,
  );
  assert.ok(!queries.some((q) => /INSERT|UPDATE|DELETE/.test(q)));
  await assert.rejects(
    () =>
      commitAdminOperation({ ...actor, accountId: 101 }, input, {
        pool,
        now: () => new Date(),
        secret: 'secret',
      }),
    { code: 'OPERATION_CONFLICT' },
  );
});
test('a new operation that waits past expiry is rejected after obtaining the parent lock', async () => {
  const day = pendingEntry({ status: 'approved' });
  const command = { ...testCommand, expectedRevision: revisionForEntry(day) };
  const queries: string[] = [];
  const client = {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes('FROM public.time_entry_days'))
        return {
          rows: [
            {
              id: 44,
              franchiseid: 77,
              tutorid: 88,
              work_date: day.workDate,
              timezone: day.timezone,
              status: 'approved',
              clock_state: 0,
              created_at: day.createdAt,
              updated_at: day.updatedAt,
              submitted_at: day.submittedAt,
              decided_by: null,
              decided_at: null,
              decision_reason: null,
            },
          ],
        };
      if (sql.includes('time_entry_sessions'))
        return {
          rows: [
            {
              id: 99,
              start_at: day.sessions[0].startAt,
              end_at: day.sessions[0].endAt,
              sort_order: 0,
              created_at: day.sessions[0].createdAt,
              updated_at: day.sessions[0].updatedAt,
            },
          ],
        };
      if (sql.includes('SELECT id FROM public.time_entry_audit'))
        return { rows: [{ id: 1 }] };
      return { rows: [] };
    },
    release: () => {},
  } as unknown as PoolClient;
  let clockReads = 0;
  const pool = { connect: async () => client } as unknown as Pool;
  await assert.rejects(
    () =>
      commitAdminOperation(
        actor,
        {
          operationId: randomUUID(),
          previewToken: signAdminPreview(command, 'secret'),
        },
        {
          pool,
          secret: 'secret',
          now: () =>
            new Date(
              clockReads++ ? '2026-09-16T12:11:00Z' : '2026-09-16T12:00:00Z',
            ),
        },
      ),
    { code: 'PREVIEW_EXPIRED' },
  );
  assert.ok(!queries.some((sql) => /^\s*(INSERT|UPDATE|DELETE)\b/.test(sql)));
  assert.ok(queries.includes('ROLLBACK'));
});
