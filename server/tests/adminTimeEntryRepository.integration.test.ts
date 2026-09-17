import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  createAdminRepository,
  readEntry,
} from '../services/adminTimeEntry/repository';
import { createAdminDirectory } from '../services/adminTimeEntry/directory';
import { revisionForEntry } from '../services/adminTimeEntry/revision';
import { withTimeEntryDatabase } from './helpers/adminTimeEntryDatabase';
test(
  'real aggregate includes open end, scoped DATE and unique operation identities',
  { skip: process.env.RUN_TIME_ENTRY_POSTGRES_TESTS !== '1' },
  async () =>
    withTimeEntryDatabase(async (pool) => {
      const id = (
        await pool.query(
          `INSERT INTO public.time_entry_days(franchiseid,tutorid,work_date,timezone,status,clock_state) VALUES(77,88,'2026-09-15','America/Los_Angeles','draft',1) RETURNING id`,
        )
      ).rows[0].id;
      await pool.query(
        `INSERT INTO public.time_entry_sessions(entry_day_id,franchiseid,tutorid,start_at,end_at,sort_order) VALUES($1,77,88,'2026-09-15T22:00:00Z',NULL,0)`,
        [id],
      );
      const client = await pool.connect();
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const entry = await readEntry(
          client,
          { franchiseId: 77, tutorId: 88, workDate: '2026-09-15' },
          false,
        );
        assert.equal(entry?.clockState, 1);
        assert.equal(entry?.sessions[0].endAt, null);
        assert.equal(entry?.workDate, '2026-09-15');
        assert.equal(
          await readEntry(
            client,
            { franchiseId: 78, tutorId: 88, workDate: '2026-09-15' },
            false,
          ),
          null,
        );
        await client.query('COMMIT');
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
      const operation = randomUUID();
      const insert = `INSERT INTO public.time_entry_audit(entry_day_id,action,actor_account_type,new_status,operation_id)VALUES($1,'test','ADMIN','draft',$2)`;
      await pool.query(insert, [id, operation]);
      await assert.rejects(() => pool.query(insert, [id, operation]), {
        code: '23505',
      });
      await pool.query(insert, [id, null]);
      await pool.query(insert, [id, null]);
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int AS n FROM public.time_entry_audit',
          )
        ).rows[0].n,
        3,
      );
    }),
);
test(
  'real days/tutors/history paginate without duplicates and directory outage is not Missing',
  { skip: process.env.RUN_TIME_ENTRY_POSTGRES_TESTS !== '1' },
  async () =>
    withTimeEntryDatabase(async (pool) => {
      for (const [center, tutor, workDate] of [
        [77, 88, '2026-09-15'],
        [77, 89, '2026-09-15'],
        [77, 88, '2026-09-14'],
        [77, 90, '2026-09-13'],
        [78, 99, '2026-09-15'],
      ] as const)
        await pool.query(
          `INSERT INTO public.time_entry_days(franchiseid,tutorid,work_date,timezone,status,clock_state)VALUES($1,$2,$3,'America/Los_Angeles','pending',0)`,
          [center, tutor, workDate],
        );
      const roster = [
        {
          tutorId: 88,
          displayName: 'Alex Rivera',
          active: true,
          historyOnly: false,
        },
        {
          tutorId: 89,
          displayName: 'Morgan Inactive',
          active: false,
          historyOnly: false,
        },
        {
          tutorId: 91,
          displayName: 'Zed Current',
          active: true,
          historyOnly: false,
        },
      ];
      const directory = createAdminDirectory({
        pool: () => pool,
        roster: async () => roster,
      });
      const repo = createAdminRepository({
        pool: () => pool,
        directory,
        timezone: async () => 'America/Los_Angeles',
      });
      const filters = {
        franchiseId: 77,
        start: '2026-09-01',
        end: '2026-09-15',
        limit: 2,
      };
      const first = await repo.listAdminDays(filters);
      assert.equal(first.items.length, 2);
      assert.deepEqual(
        first.items.map((x) => [x.workDate, x.tutorId]),
        [
          ['2026-09-15', 88],
          ['2026-09-15', 89],
        ],
      );
      assert.ok(first.nextCursor);
      const second = await repo.listAdminDays({
        ...filters,
        cursor: first.nextCursor,
      });
      assert.deepEqual(
        second.items.map((x) => [x.workDate, x.tutorId]),
        [
          ['2026-09-14', 88],
          ['2026-09-13', 90],
        ],
      );
      assert.equal(second.nextCursor, null);
      assert.equal(
        new Set([...first.items, ...second.items].map((x) => x.id)).size,
        4,
      );
      await assert.rejects(
        () =>
          repo.listAdminDays({
            ...filters,
            franchiseId: 78,
            cursor: first.nextCursor!,
          }),
        { code: 'INVALID_INPUT' },
      );
      const tutors = await directory.listAdminTutors({
        franchiseId: 77,
        search: '',
        limit: 2,
      });
      assert.ok(tutors.nextCursor);
      const next = await directory.listAdminTutors({
        franchiseId: 77,
        search: '',
        limit: 2,
        cursor: tutors.nextCursor!,
      });
      assert.equal(
        new Set([...tutors.items, ...next.items].map((t) => t.tutorId)).size,
        4,
      );
      assert.ok(
        [...tutors.items, ...next.items].find(
          (t) => t.tutorId === 89 && !t.active && !t.historyOnly,
        ),
      );
      assert.ok(
        [...tutors.items, ...next.items].find(
          (t) => t.tutorId === 90 && t.historyOnly,
        ),
      );
      assert.equal(
        [...tutors.items, ...next.items].some((t) => t.tutorId === 99),
        false,
      );
      const day = await repo.getAdminDetail({
        franchiseId: 77,
        tutorId: 88,
        workDate: '2026-09-15',
      });
      assert.ok(day.day);
      const id = day.day.id;
      for (let i = 0; i < 3; i++)
        await pool.query(
          `INSERT INTO public.time_entry_audit(entry_day_id,action,actor_account_type,actor_account_id,new_status,metadata)VALUES($1,'historic','ADMIN',100,'pending',$2)`,
          [id, { reason: `Historical edit ${i}`, before: { marker: i } }],
        );
      const h1 = await repo.readHistory(77, id, null, 2);
      assert.equal(h1.items.length, 2);
      assert.equal((h1.items[0].metadata as any).before.marker, 2);
      assert.equal(h1.items[0].reason, 'Historical edit 2');
      const h2 = await repo.readHistory(77, id, Number(h1.nextCursor), 2);
      assert.equal(h2.items.length, 1);
      assert.equal(h2.nextCursor, null);
      await assert.rejects(() => repo.readHistory(78, id, null, 2), {
        status: 404,
      });
      const unavailable = createAdminRepository({
        pool: () => pool,
        directory: createAdminDirectory({
          pool: () => pool,
          roster: async () => {
            throw new Error('CRM down');
          },
        }),
        timezone: async () => 'America/Los_Angeles',
      });
      assert.equal(
        (await unavailable.getAdminDetailById(77, id)).tutor.historyOnly,
        true,
      );
      const historicalDirectory = createAdminDirectory({
        pool: () => pool,
        roster: async () => {
          throw new Error('CRM down');
        },
      });
      const historicalTutors = await historicalDirectory.listAdminTutors({
        franchiseId: 77,
        search: '',
        limit: 100,
      });
      assert.deepEqual(
        historicalTutors.items.map((t) => t.tutorId),
        [88, 89, 90],
      );
      assert.ok(
        historicalTutors.items.every((t) => !t.active && t.historyOnly),
      );
      await assert.rejects(
        () =>
          unavailable.getAdminDetail({
            franchiseId: 77,
            tutorId: 92,
            workDate: '2026-09-15',
          }),
        { code: 'ROSTER_UNAVAILABLE' },
      );
      const inactiveMissing = await repo.getAdminDetail({
        franchiseId: 77,
        tutorId: 89,
        workDate: '2026-09-12',
      });
      assert.equal(inactiveMissing.day, null);
      assert.deepEqual(inactiveMissing.allowedActions, []);
      await pool.query(
        `UPDATE public.time_entry_days SET updated_at='2026-09-16T01:00:00.000001Z' WHERE id=$1`,
        [id],
      );
      const precise = await repo.getAdminDetailById(77, id);
      assert.equal(precise.day!.updatedAt, '2026-09-16T01:00:00.000001Z');
      await pool.query(
        `UPDATE public.time_entry_days SET updated_at='2026-09-16T01:00:00.000002Z' WHERE id=$1`,
        [id],
      );
      assert.notEqual(
        (await repo.getAdminDetailById(77, id)).revision,
        precise.revision,
      );
    }),
);
