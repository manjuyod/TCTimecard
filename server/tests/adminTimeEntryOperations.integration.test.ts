import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { withTimeEntryDatabase } from './helpers/adminTimeEntryDatabase';
import {
  seedPendingEntry,
  correctionInput,
} from './helpers/adminTimeEntryFixtures';
import {
  createAdminRepository,
  readEntry,
} from '../services/adminTimeEntry/repository';
import { createAdminDirectory } from '../services/adminTimeEntry/directory';
import {
  previewCorrection,
  previewStatusOperation,
} from '../services/adminTimeEntry/preview';
import {
  commitAdminOperation,
  getAdminOperation,
} from '../services/adminTimeEntry/operations';
import type { PreviewDeps } from '../services/adminTimeEntry/contracts';
const actor = { accountId: 100, franchiseId: 77 },
  secret = 'local-preview-test-secret',
  now = () => new Date('2026-09-16T12:00:00Z');
function setup(pool: Pool) {
  const tutor = {
    tutorId: 88,
    displayName: 'Alex Rivera',
    active: true,
    historyOnly: false,
  };
  const directory = createAdminDirectory({
    pool: () => pool,
    roster: async () => [tutor],
  });
  const repo = createAdminRepository({
    pool: () => pool,
    directory,
    timezone: async () => 'America/Los_Angeles',
  });
  const deps: PreviewDeps = {
    getDetail: repo.getAdminDetail,
    getById: repo.getAdminDetailById,
    requireActiveTutor: directory.requireActiveTutor,
    getSchedule: async () => {
      throw new Error('CRM unavailable');
    },
    now,
    secret,
  };
  return { repo, deps, operation: { pool, secret, now } };
}
test('a snapped midnight clock-out can be voided and restored without changing its hours',
  { skip: process.env.RUN_TIME_ENTRY_POSTGRES_TESTS !== '1' }, async () =>
    withTimeEntryDatabase(async (pool) => {
      await seedPendingEntry(pool);
      await pool.query("UPDATE public.time_entry_days SET status='approved' WHERE id=44");
      await pool.query("UPDATE public.time_entry_sessions SET start_at='2026-09-16T06:00:00Z', end_at='2026-09-16T07:00:00Z' WHERE id=99");
      const { repo, deps, operation } = setup(pool);
      const original = await repo.getAdminDetailById(77, 44);
      for (const action of ['void', 'restore'] as const) {
        const detail = await repo.getAdminDetailById(77, 44);
        const preview = await previewStatusOperation(action, actor, {
          franchiseId: 77, dayId: 44, expectedRevision: detail.revision, reason: 'Verify midnight shift',
        }, deps);
        const result = await commitAdminOperation(actor, {
          operationId: randomUUID(), previewToken: preview.previewToken,
        }, operation);
        assert.equal(result.after.approvedMinutes, action === 'void' ? 0 : 60);
      }
      const restored = await repo.getAdminDetailById(77, 44);
      assert.equal(restored.day!.status, 'approved');
      assert.deepEqual(restored.day!.sessions, original.day!.sessions);
    }));

test(
  'atomic correction retry void and restore preserve raw children and original decisions',
  { skip: process.env.RUN_TIME_ENTRY_POSTGRES_TESTS !== '1' },
  async () =>
    withTimeEntryDatabase(async (pool) => {
      await seedPendingEntry(pool);
      const { repo, deps, operation } = setup(pool);
      const detail = await repo.getAdminDetail({
        franchiseId: 77,
        tutorId: 88,
        workDate: '2026-09-15',
      });
      const preview = await previewCorrection(
        actor,
        correctionInput({ expectedRevision: detail.revision }),
        deps,
      );
      const input = {
        operationId: randomUUID(),
        previewToken: preview.previewToken,
      };
      const [first, retry] = await Promise.all([
        commitAdminOperation(actor, input, operation),
        commitAdminOperation(actor, input, operation),
      ]);
      assert.deepEqual(retry, first);
      assert.deepEqual(
        await getAdminOperation(actor, input.operationId, pool),
        first,
      );
      assert.equal(
        await getAdminOperation(
          { ...actor, accountId: 101 },
          input.operationId,
          pool,
        ),
        null,
      );
      assert.deepEqual(
        await commitAdminOperation(actor, input, {
          ...operation,
          now: () => new Date('2026-09-16T13:00:00Z'),
        }),
        first,
      );
      const audit = (
        await pool.query(
          'SELECT metadata FROM public.time_entry_audit WHERE operation_id=$1',
          [input.operationId],
        )
      ).rows;
      assert.equal(audit.length, 1);
      assert.equal(
        audit[0].metadata.before.sessions[0].endAt,
        '2026-09-16T01:00:00.000Z',
      );
      assert.equal(
        audit[0].metadata.after.sessions[0].endAt,
        '2026-09-16T01:15:00.000Z',
      );
      const approved = await repo.getAdminDetailById(77, 44);
      const children = approved.day!.sessions;
      const originalDecisions = [
        approved.day!.decidedBy,
        approved.day!.decidedAt,
        approved.day!.decisionReason,
        approved.day!.submittedAt,
      ];
      const voidPreview = await previewStatusOperation(
        'void',
        actor,
        {
          franchiseId: 77,
          dayId: 44,
          expectedRevision: approved.revision,
          reason: 'Incorrect paid shift',
        },
        deps,
      );
      await commitAdminOperation(
        actor,
        { operationId: randomUUID(), previewToken: voidPreview.previewToken },
        operation,
      );
      const voided = await repo.getAdminDetailById(77, 44);
      assert.deepEqual(voided.day!.sessions, children);
      assert.equal(voided.day!.status, 'voided');
      assert.deepEqual(
        await commitAdminOperation(actor, input, operation),
        first,
      );
      assert.equal(
        (await repo.getAdminDetailById(77, 44)).day!.status,
        'voided',
        'Recovering the old immutable outcome cannot reapply its approval',
      );
      const restore = await previewStatusOperation(
        'restore',
        actor,
        {
          franchiseId: 77,
          dayId: 44,
          expectedRevision: voided.revision,
          reason: 'Voided wrong shift',
        },
        deps,
      );
      await commitAdminOperation(
        actor,
        { operationId: randomUUID(), previewToken: restore.previewToken },
        operation,
      );
      const restored = await repo.getAdminDetailById(77, 44);
      assert.deepEqual(restored.day!.sessions, children);
      assert.deepEqual(
        [
          restored.day!.decidedBy,
          restored.day!.decidedAt,
          restored.day!.decisionReason,
          restored.day!.submittedAt,
        ],
        originalDecisions,
      );
      assert.equal(restored.day!.status, 'approved');
      const before = await pool.query(
        'SELECT count(*)::int AS n FROM public.time_entry_audit',
      );
      await assert.rejects(
        () =>
          commitAdminOperation(
            actor,
            {
              operationId: input.operationId,
              previewToken: voidPreview.previewToken,
            },
            operation,
          ),
        { code: 'OPERATION_CONFLICT' },
      );
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int AS n FROM public.time_entry_audit',
          )
        ).rows[0].n,
        before.rows[0].n,
      );
    }),
);
test(
  'different creators and stale admins cannot merge or overwrite, audit failure rolls everything back',
  { skip: process.env.RUN_TIME_ENTRY_POSTGRES_TESTS !== '1' },
  async () =>
    withTimeEntryDatabase(async (pool) => {
      const { repo, deps, operation } = setup(pool);
      const createInput = correctionInput({
        expectedRevision: 'missing',
        sessions: correctionInput().sessions.map((s) => ({ ...s, id: null })),
      });
      const a = await previewCorrection(actor, createInput, deps),
        b = await previewCorrection(
          { ...actor, accountId: 101 },
          createInput,
          deps,
        );
      const results = await Promise.allSettled([
        commitAdminOperation(
          actor,
          { operationId: randomUUID(), previewToken: a.previewToken },
          operation,
        ),
        commitAdminOperation(
          { ...actor, accountId: 101 },
          { operationId: randomUUID(), previewToken: b.previewToken },
          operation,
        ),
      ]);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal(
        (results.find((r) => r.status === 'rejected') as PromiseRejectedResult)
          .reason.code,
        'ENTRY_CHANGED',
      );
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int AS n FROM public.time_entry_days',
          )
        ).rows[0].n,
        1,
      );
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int AS n FROM public.time_entry_sessions',
          )
        ).rows[0].n,
        1,
      );
      await pool.query(
        `TRUNCATE public.time_entry_days RESTART IDENTITY CASCADE`,
      );
      await seedPendingEntry(pool);
      const d = await repo.getAdminDetailById(77, 44);
      const p = await previewCorrection(
        actor,
        correctionInput({ expectedRevision: d.revision }),
        deps,
      );
      await pool.query(
        `CREATE FUNCTION fail_admin_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected audit failure'; END; $$; CREATE TRIGGER fail_admin_audit BEFORE INSERT ON public.time_entry_audit FOR EACH ROW EXECUTE FUNCTION fail_admin_audit()`,
      );
      await assert.rejects(() =>
        commitAdminOperation(
          actor,
          { operationId: randomUUID(), previewToken: p.previewToken },
          operation,
        ),
      );
      assert.equal(
        (await repo.getAdminDetailById(77, 44)).revision,
        d.revision,
      );
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int AS n FROM public.time_entry_audit',
          )
        ).rows[0].n,
        0,
      );
      await pool.query(
        'DROP TRIGGER fail_admin_audit ON public.time_entry_audit',
      );
      await pool.query(
        `UPDATE public.time_entry_sessions SET end_at='2026-09-16T01:05:00Z' WHERE id=99`,
      );
      await assert.rejects(
        () =>
          commitAdminOperation(
            actor,
            { operationId: randomUUID(), previewToken: p.previewToken },
            operation,
          ),
        { code: 'ENTRY_CHANGED' },
      );
    }),
);
test(
  'correction preserves auto-rule sources, active void audit and rejects altered preserved restore data',
  { skip: process.env.RUN_TIME_ENTRY_POSTGRES_TESTS !== '1' },
  async () =>
    withTimeEntryDatabase(async (pool) => {
      await seedPendingEntry(pool);
      await pool.query(
        `UPDATE public.time_entry_days SET clock_state=1 WHERE id=44`,
      );
      await pool.query(
        `UPDATE public.time_entry_sessions SET end_at=NULL WHERE id=99`,
      );
      await pool.query(
        `INSERT INTO public.time_entry_breaks(entry_day_id,time_entry_session_id,franchiseid,tutorid,start_time,end_time,duration_minutes,break_type,pay_treatment,source,status,note)VALUES(44,99,77,88,'2026-09-15T23:00:00Z',NULL,0,'lunch','unpaid','auto_rule','active',NULL)`,
      );
      const { repo, deps, operation } = setup(pool);
      const detail = await repo.getAdminDetailById(77, 44);
      const breakId = detail.day!.breaks[0].id;
      const p = await previewCorrection(
        actor,
        correctionInput({
          expectedRevision: detail.revision,
          breaks: [
            {
              id: breakId,
              breakType: 'lunch',
              payTreatment: 'unpaid',
              status: 'voided',
              startTime: null,
              endTime: null,
              durationMinutes: 0,
              note: 'Void incorrect active break',
            },
          ],
        }),
        deps,
      );
      const operationId = randomUUID();
      await commitAdminOperation(
        actor,
        { operationId, previewToken: p.previewToken },
        operation,
      );
      const corrected = await repo.getAdminDetailById(77, 44);
      assert.equal(corrected.day!.clockState, 0);
      assert.equal(corrected.day!.breaks[0].source, 'auto_rule');
      assert.equal(corrected.day!.breaks[0].status, 'voided');
      assert.equal(corrected.day!.breaks[0].id, breakId);
      const audit = (
        await pool.query(
          'SELECT metadata FROM public.time_entry_audit WHERE operation_id=$1',
          [operationId],
        )
      ).rows[0].metadata;
      assert.equal(audit.before.breaks[0].status, 'active');
      assert.equal(
        audit.before.breaks[0].startTime,
        '2026-09-15T23:00:00.000Z',
      );
      assert.equal(audit.before.breaks[0].endTime, null);
      assert.equal(audit.after.breaks[0].source, 'auto_rule');
      const v = await previewStatusOperation(
        'void',
        actor,
        {
          franchiseId: 77,
          dayId: 44,
          expectedRevision: corrected.revision,
          reason: 'Wrong historical shift',
        },
        deps,
      );
      await commitAdminOperation(
        actor,
        { operationId: randomUUID(), previewToken: v.previewToken },
        operation,
      );
      const voided = await repo.getAdminDetailById(77, 44);
      const restore = await previewStatusOperation(
        'restore',
        actor,
        {
          franchiseId: 77,
          dayId: 44,
          expectedRevision: voided.revision,
          reason: 'Restore shift please',
        },
        deps,
      );
      await pool.query(
        `UPDATE public.time_entry_sessions SET end_at='2026-09-16T01:20:00Z' WHERE id=99`,
      );
      await assert.rejects(
        () =>
          commitAdminOperation(
            actor,
            { operationId: randomUUID(), previewToken: restore.previewToken },
            operation,
          ),
        { code: 'ENTRY_CHANGED' },
      );
      const changed = await repo.getAdminDetailById(77, 44);
      const fresh = await previewStatusOperation(
        'restore',
        actor,
        {
          franchiseId: 77,
          dayId: 44,
          expectedRevision: changed.revision,
          reason: 'Restore changed entry',
        },
        deps,
      );
      await assert.rejects(
        () =>
          commitAdminOperation(
            actor,
            { operationId: randomUUID(), previewToken: fresh.previewToken },
            operation,
          ),
        { code: 'ENTRY_CHANGED' },
      );
      assert.equal(
        (await repo.getAdminDetailById(77, 44)).day!.status,
        'voided',
      );
    }),
);
test(
  'two stale corrections wait on the parent lock; only one can approve',
  { skip: process.env.RUN_TIME_ENTRY_POSTGRES_TESTS !== '1' },
  async () =>
    withTimeEntryDatabase(async (pool) => {
      await seedPendingEntry(pool);
      const { repo, deps, operation } = setup(pool);
      const detail = await repo.getAdminDetailById(77, 44);
      const a = await previewCorrection(
          actor,
          correctionInput({ expectedRevision: detail.revision }),
          deps,
        ),
        b = await previewCorrection(
          { ...actor, accountId: 101 },
          correctionInput({ expectedRevision: detail.revision }),
          deps,
        );
      const blocker = await pool.connect();
      await blocker.query('BEGIN');
      const blockerPid = (await blocker.query('SELECT pg_backend_pid() AS pid'))
        .rows[0].pid;
      await blocker.query(
        'SELECT id FROM public.time_entry_days WHERE id=44 FOR UPDATE',
      );
      const pending = Promise.allSettled([
        commitAdminOperation(
          actor,
          { operationId: randomUUID(), previewToken: a.previewToken },
          operation,
        ),
        commitAdminOperation(
          { ...actor, accountId: 101 },
          { operationId: randomUUID(), previewToken: b.previewToken },
          operation,
        ),
      ]);
      try {
        const deadline = Date.now() + 10000;
        let observed = false;
        while (Date.now() < deadline) {
          const waiting = (
            await pool.query(
              "SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid<>$1 AND cardinality(pg_blocking_pids(pid))>0 AND query LIKE '%public.time_entry_days%FOR UPDATE%'",
              [blockerPid],
            )
          ).rows[0].n;
          if (waiting === 2) {
            observed = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 10));
        }
        assert.ok(
          observed,
          'Both transactions must be observed blocked on the parent lock',
        );
        await blocker.query('COMMIT');
        const results = await pending;
        assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
        assert.equal(
          (
            results.find(
              (r) => r.status === 'rejected',
            ) as PromiseRejectedResult
          ).reason.code,
          'ENTRY_CHANGED',
        );
        assert.equal(
          (
            await pool.query(
              'SELECT count(*)::int AS n FROM public.time_entry_audit',
            )
          ).rows[0].n,
          1,
        );
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
        await pending;
      }
    }),
);
test(
  'fresh restore preview cannot approve a parent moved to another tutor, center or timezone',
  { skip: process.env.RUN_TIME_ENTRY_POSTGRES_TESTS !== '1' },
  async () =>
    withTimeEntryDatabase(async (pool) => {
      await seedPendingEntry(pool);
      const { repo, deps, operation } = setup(pool);
      const original = await repo.getAdminDetailById(77, 44);
      const correction = await previewCorrection(
        actor,
        correctionInput({ expectedRevision: original.revision }),
        deps,
      );
      await commitAdminOperation(
        actor,
        { operationId: randomUUID(), previewToken: correction.previewToken },
        operation,
      );
      const approved = await repo.getAdminDetailById(77, 44);
      const voidPreview = await previewStatusOperation(
        'void',
        actor,
        {
          franchiseId: 77,
          dayId: 44,
          expectedRevision: approved.revision,
          reason: 'Void wrong historical entry',
        },
        deps,
      );
      await commitAdminOperation(
        actor,
        { operationId: randomUUID(), previewToken: voidPreview.previewToken },
        operation,
      );
      const mutations = [
        {
          sql: 'UPDATE public.time_entry_days SET tutorid=$1 WHERE id=44',
          changed: 89,
          original: 88,
          franchiseId: 77,
        },
        {
          sql: 'UPDATE public.time_entry_days SET franchiseid=$1 WHERE id=44',
          changed: 78,
          original: 77,
          franchiseId: 78,
        },
        {
          sql: 'UPDATE public.time_entry_days SET timezone=$1 WHERE id=44',
          changed: 'America/Vancouver',
          original: 'America/Los_Angeles',
          franchiseId: 77,
        },
      ];
      for (const mutation of mutations) {
        await pool.query(mutation.sql, [mutation.changed]);
        const currentActor = { ...actor, franchiseId: mutation.franchiseId };
        const fresh = await repo.getAdminDetailById(mutation.franchiseId, 44);
        const preview = await previewStatusOperation(
          'restore',
          currentActor,
          {
            franchiseId: mutation.franchiseId,
            dayId: 44,
            expectedRevision: fresh.revision,
            reason: 'Restore freshly loaded historical entry',
          },
          deps,
        );
        await assert.rejects(
          () =>
            commitAdminOperation(
              currentActor,
              { operationId: randomUUID(), previewToken: preview.previewToken },
              operation,
            ),
          { code: 'ENTRY_CHANGED' },
        );
        assert.equal(
          (await repo.getAdminDetailById(mutation.franchiseId, 44)).day!.status,
          'voided',
        );
        assert.equal(
          (
            await pool.query(
              'SELECT count(*)::integer AS n FROM public.time_entry_audit',
            )
          ).rows[0].n,
          2,
        );
        await pool.query(mutation.sql, [mutation.original]);
      }
    }),
);
test(
  'deleted linked segment requires break resolution and audits original/final IDs and links',
  { skip: process.env.RUN_TIME_ENTRY_POSTGRES_TESTS !== '1' },
  async () =>
    withTimeEntryDatabase(async (pool) => {
      await seedPendingEntry(pool);
      await pool.query(
        `INSERT INTO public.time_entry_breaks(id,entry_day_id,time_entry_session_id,franchiseid,tutorid,start_time,end_time,duration_minutes,break_type,pay_treatment,source,status)VALUES(11,44,99,77,88,'2026-09-15T23:00:00Z','2026-09-15T23:30:00Z',30,'lunch','unpaid','auto_rule','completed')`,
      );
      const { repo, deps, operation } = setup(pool),
        detail = await repo.getAdminDetailById(77, 44);
      const sessions = [
        {
          id: null,
          startAt: '2026-09-16T01:00:00Z',
          endAt: '2026-09-16T02:00:00Z',
        },
      ];
      const originalBreak = {
        id: 11,
        breakType: 'lunch' as const,
        payTreatment: 'unpaid' as const,
        status: 'completed' as const,
        startTime: '2026-09-15T23:00:00Z',
        endTime: '2026-09-15T23:30:00Z',
        durationMinutes: 30,
        note: null,
      };
      await assert.rejects(
        () =>
          previewCorrection(
            actor,
            correctionInput({
              expectedRevision: detail.revision,
              sessions,
              breaks: [originalBreak],
            }),
            deps,
          ),
        { code: 'INVALID_INPUT' },
      );
      assert.equal(
        (await repo.getAdminDetailById(77, 44)).revision,
        detail.revision,
      );
      const repositioned = {
        ...originalBreak,
        startTime: '2026-09-16T01:00:00Z',
        endTime: '2026-09-16T01:30:00Z',
      };
      const preview = await previewCorrection(
        actor,
        correctionInput({
          expectedRevision: detail.revision,
          sessions,
          breaks: [repositioned],
        }),
        deps,
      );
      const operationId = randomUUID();
      await commitAdminOperation(
        actor,
        { operationId, previewToken: preview.previewToken },
        operation,
      );
      const final = await repo.getAdminDetailById(77, 44);
      assert.notEqual(final.day!.sessions[0].id, 99);
      assert.equal(final.day!.breaks[0].id, 11);
      assert.equal(final.day!.breaks[0].sessionId, final.day!.sessions[0].id);
      assert.equal(final.day!.breaks[0].source, 'auto_rule');
      const metadata = (
        await pool.query(
          'SELECT metadata FROM public.time_entry_audit WHERE operation_id=$1',
          [operationId],
        )
      ).rows[0].metadata;
      assert.equal(metadata.before.sessions[0].id, 99);
      assert.equal(metadata.before.breaks[0].sessionId, 99);
      assert.equal(
        metadata.before.breaks[0].startTime,
        '2026-09-15T23:00:00.000Z',
      );
      assert.equal(
        metadata.after.breaks[0].sessionId,
        final.day!.sessions[0].id,
      );
      await pool.query(
        'TRUNCATE public.time_entry_days RESTART IDENTITY CASCADE',
      );
      await seedPendingEntry(pool);
      await pool.query(
        `INSERT INTO public.time_entry_breaks(id,entry_day_id,time_entry_session_id,franchiseid,tutorid,start_time,end_time,duration_minutes,break_type,pay_treatment,source,status)VALUES(11,44,99,77,88,'2026-09-15T23:00:00Z','2026-09-15T23:30:00Z',30,'lunch','unpaid','auto_rule','completed')`,
      );
      const again = await repo.getAdminDetailById(77, 44);
      const voidPreview = await previewCorrection(
        actor,
        correctionInput({
          expectedRevision: again.revision,
          sessions,
          breaks: [{ ...originalBreak, status: 'voided' }],
        }),
        deps,
      );
      const voidOperation = randomUUID();
      await commitAdminOperation(
        actor,
        { operationId: voidOperation, previewToken: voidPreview.previewToken },
        operation,
      );
      const resolved = await repo.getAdminDetailById(77, 44);
      assert.equal(resolved.day!.breaks[0].status, 'voided');
      assert.equal(resolved.day!.breaks[0].sessionId, null);
      const voidMetadata = (
        await pool.query(
          'SELECT metadata FROM public.time_entry_audit WHERE operation_id=$1',
          [voidOperation],
        )
      ).rows[0].metadata;
      assert.equal(voidMetadata.before.breaks[0].sessionId, 99);
      assert.equal(voidMetadata.after.breaks[0].sessionId, null);
      assert.equal(voidMetadata.after.breaks[0].status, 'voided');
    }),
);
