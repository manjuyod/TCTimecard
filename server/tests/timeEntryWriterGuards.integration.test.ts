import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withTimeEntryDatabase } from './helpers/adminTimeEntryDatabase';
import {
  actor,
  barrier,
  databaseState,
  observedPool,
  prepare,
  seedDay,
  waitForParentWaiter,
  withWriterHttp,
  type Trace,
} from './helpers/timeEntryWriterGuards';
import { previewCorrection } from '../services/adminTimeEntry/preview';
import { commitAdminOperation } from '../services/adminTimeEntry/operations';
const options = { skip: process.env.RUN_TIME_ENTRY_POSTGRES_TESTS !== '1' };
const previousSnapshotSecret = process.env.SCHEDULE_SNAPSHOT_SIGNING_SECRET;
before(() => {
  process.env.SCHEDULE_SNAPSHOT_SIGNING_SECRET =
    'local_writer_guard_schedule_secret';
});
after(() => {
  if (previousSnapshotSecret === undefined)
    delete process.env.SCHEDULE_SNAPSHOT_SIGNING_SECRET;
  else process.env.SCHEDULE_SNAPSHOT_SIGNING_SECRET = previousSnapshotSecret;
});

test(
  'voided days cannot be resurrected by any public ordinary writer, even with stale open children',
  options,
  async () =>
    withTimeEntryDatabase(async (pool) => {
      const fixture = await prepare(pool);
      await seedDay(pool, fixture, 'voided');
      await pool.query(
        'UPDATE public.time_entry_days SET clock_state=1 WHERE id=44',
      );
      await pool.query(
        'UPDATE public.time_entry_sessions SET end_at=NULL WHERE id=99',
      );
      await pool.query(
        `INSERT INTO public.time_entry_breaks(entry_day_id,time_entry_session_id,franchiseid,tutorid,start_time,duration_minutes,break_type,pay_treatment,source,status)VALUES(44,99,77,88,$1,0,'lunch','unpaid','employee','active')`,
        [fixture.start],
      );
      const before = await databaseState(pool),
        traces: Trace[] = [];
      const writers = [
        {
          method: 'PUT',
          path: `/time-entry/me/day/${fixture.workDate}`,
          body: { sessions: [{ startAt: fixture.start, endAt: fixture.end }] },
        },
        {
          method: 'POST',
          path: `/time-entry/me/day/${fixture.workDate}/submit`,
          body: { scheduleSnapshot: fixture.snapshot },
        },
        {
          method: 'POST',
          path: `/time-entry/me/day/${fixture.workDate}/breaks`,
          body: {
            breakType: 'lunch',
            payTreatment: 'unpaid',
            startTime: fixture.breakStart,
            endTime: fixture.breakEnd,
            durationMinutes: 30,
          },
        },
        { method: 'POST', path: '/clock/me/in', body: {} },
        {
          method: 'POST',
          path: '/clock/me/out',
          body: { scheduleSnapshot: fixture.snapshot },
        },
        {
          method: 'POST',
          path: '/clock/me/break/start',
          body: { breakType: 'lunch' },
        },
        { method: 'POST', path: '/clock/me/break/end', body: {} },
        {
          method: 'POST',
          path: '/time-entry/admin/day/44/decide',
          body: { franchiseId: 77, decision: 'approve' },
          admin: true,
        },
      ];
      await withWriterHttp(observedPool(pool, traces), async (request) => {
        for (const writer of writers) {
          const offset = traces.length,
            response = await request(
              writer.method,
              writer.path,
              writer.body,
              writer.admin,
            );
          assert.equal(response.status, 409, writer.path);
          const body = (await response.json()) as any;
          if (!writer.admin)
            assert.equal(body.code, 'INVALID_ENTRY_STATE', writer.path);
          else assert.match(body.error, /current status: voided/);
          assert.deepEqual(await databaseState(pool), before, writer.path);
          const attempt = traces.slice(offset);
          assert.ok(
            attempt.some(
              (t) =>
                /FROM public\.time_entry_days/.test(t.sql) &&
                /FOR UPDATE/.test(t.sql),
            ),
            writer.path,
          );
          assert.ok(
            !attempt.some((t) =>
              /\b(INSERT|UPDATE|DELETE)\s+(INTO\s+|FROM\s+)?public\.time_entry_/.test(
                t.sql,
              ),
            ),
            writer.path,
          );
        }
      });
    }),
);

test(
  'ordinary approval rejects open sessions, active breaks and nonpending days under the parent lock',
  options,
  async () =>
    withTimeEntryDatabase(async (pool) => {
      const fixture = await prepare(pool);
      await seedDay(pool, fixture, 'pending');
      const traces: Trace[] = [];
      await withWriterHttp(observedPool(pool, traces), async (request) => {
        await pool.query('UPDATE public.time_entry_days SET clock_state=1 WHERE id=44');
        const runningBefore = await databaseState(pool);
        const runningResponse = await request('POST', '/time-entry/admin/day/44/decide', { decision: 'approve', franchiseId: 77 }, true);
        assert.equal(runningResponse.status, 409, 'A running parent clock cannot be approved even when its sessions are closed');
        assert.deepEqual(await databaseState(pool), runningBefore);
        await pool.query('UPDATE public.time_entry_days SET clock_state=0 WHERE id=44');
        await pool.query(
          'UPDATE public.time_entry_sessions SET end_at=NULL WHERE id=99',
        );
        let before = await databaseState(pool);
        let response = await request(
          'POST',
          '/time-entry/admin/day/44/decide',
          { decision: 'approve', franchiseId: 77 },
          true,
        );
        assert.equal(response.status, 409);
        assert.equal(
          ((await response.json()) as any).code,
          'INVALID_ENTRY_STATE',
        );
        assert.deepEqual(await databaseState(pool), before);
        await pool.query(
          'UPDATE public.time_entry_sessions SET end_at=$1 WHERE id=99',
          [fixture.end],
        );
        await pool.query(
          `INSERT INTO public.time_entry_breaks(entry_day_id,time_entry_session_id,franchiseid,tutorid,start_time,duration_minutes,break_type,pay_treatment,source,status)VALUES(44,99,77,88,$1,0,'lunch','unpaid','employee','active')`,
          [fixture.start],
        );
        before = await databaseState(pool);
        response = await request(
          'POST',
          '/time-entry/admin/day/44/decide',
          { decision: 'approve', franchiseId: 77 },
          true,
        );
        assert.equal(response.status, 409);
        assert.deepEqual(await databaseState(pool), before);
        for (const status of ['draft', 'approved', 'denied']) {
          await pool.query(
            'UPDATE public.time_entry_days SET status=$1 WHERE id=44',
            [status],
          );
          before = await databaseState(pool);
          response = await request(
            'POST',
            '/time-entry/admin/day/44/decide',
            { decision: 'approve', franchiseId: 77 },
            true,
          );
          assert.equal(response.status, 409);
          assert.deepEqual(await databaseState(pool), before);
        }
      });
      assert.ok(traces.some((t) => /FOR UPDATE/.test(t.sql) && t.parentOwned));
    }),
);

test(
  'successful ordinary writers own the parent before child writes and approved invalidation remains intentional',
  options,
  async () =>
    withTimeEntryDatabase(async (pool) => {
      const fixture = await prepare(pool);
      await seedDay(pool, fixture);
      const traces: Trace[] = [];
      await withWriterHttp(observedPool(pool, traces), async (request) => {
        const sessions = {
          sessions: [{ startAt: fixture.start, endAt: fixture.correctedEnd }],
        };
        let response = await request(
          'PUT',
          `/time-entry/me/day/${fixture.workDate}`,
          sessions,
        );
        assert.equal(response.status, 200);
        response = await request(
          'POST',
          `/time-entry/me/day/${fixture.workDate}/submit`,
          { scheduleSnapshot: fixture.snapshot },
        );
        assert.equal(response.status, 200);
        response = await request(
          'POST',
          `/time-entry/me/day/${fixture.workDate}/breaks`,
          {
            breakType: 'lunch',
            payTreatment: 'unpaid',
            startTime: fixture.breakStart,
            endTime: fixture.breakEnd,
            durationMinutes: 30,
          },
        );
        assert.equal(response.status, 201);
        response = await request(
          'POST',
          '/time-entry/admin/day/44/decide',
          { decision: 'approve', franchiseId: 77 },
          true,
        );
        assert.equal(response.status, 200);
        response = await request(
          'PUT',
          `/time-entry/me/day/${fixture.workDate}`,
          sessions,
        );
        assert.equal(response.status, 200);
        assert.equal(((await response.json()) as any).day.status, 'pending');
        response = await request(
          'POST',
          '/time-entry/admin/day/44/decide',
          { decision: 'approve', franchiseId: 77 },
          true,
        );
        assert.equal(response.status, 200);
        response = await request('POST', '/clock/me/in');
        assert.equal(
          response.status,
          201,
          'A deliberately existing approved day must still invalidate and clock in',
        );
        assert.equal(
          ((await response.json()) as any).state.dayStatus,
          'pending',
        );
        await pool.query(
          "UPDATE public.time_entry_sessions SET start_at=DATE_TRUNC('minute',NOW())-INTERVAL '30 minutes' WHERE end_at IS NULL AND entry_day_id=44",
        );
        response = await request('POST', '/clock/me/break/start', {
          breakType: 'lunch',
        });
        assert.equal(response.status, 201);
        response = await request('POST', '/clock/me/break/end');
        assert.equal(response.status, 200);
        response = await request('POST', '/clock/me/out', {
          scheduleSnapshot: fixture.snapshot,
        });
        assert.equal(response.status, 200);
        assert.equal(((await response.json()) as any).state.clockState, 0);
      });
      assert.ok(
        traces.some((t) =>
          /INSERT INTO public\.time_entry_sessions/.test(t.sql),
        ),
      );
      assert.ok(
        traces.some((t) => /UPDATE public\.time_entry_breaks/.test(t.sql)),
      );
      assert.ok(
        traces.some((t) => /INSERT INTO public\.time_entry_audit/.test(t.sql)),
      );
    }),
);

test(
  'a tutor save serializes with admin correction and the old admin revision cannot overwrite it',
  options,
  async () =>
    withTimeEntryDatabase(async (pool) => {
      const fixture = await prepare(pool);
      await seedDay(pool, fixture);
      const detail = await fixture.repo.getAdminDetailById(77, 44);
      const preview = await previewCorrection(
        actor,
        {
          franchiseId: 77,
          tutorId: 88,
          workDate: fixture.workDate,
          expectedRevision: detail.revision,
          sessions: [
            { id: 99, startAt: fixture.start, endAt: fixture.correctedEnd },
          ],
          breaks: [],
          reason: 'Complete corrected time',
        },
        fixture.deps,
      );
      const locked = barrier(),
        resume = barrier(),
        traces: Trace[] = [];
      let owner = 0,
        paused = false;
      const observed = observedPool(pool, traces, async (sql, result, id) => {
        if (
          !paused &&
          /FROM public\.time_entry_days/.test(sql) &&
          /FOR UPDATE/.test(sql) &&
          result.rowCount
        ) {
          paused = true;
          owner = id;
          locked.release();
          await resume.wait;
        }
      });
      await withWriterHttp(observed, async (request) => {
        const save = request('PUT', `/time-entry/me/day/${fixture.workDate}`, {
          sessions: [{ startAt: fixture.start, endAt: fixture.end }],
        });
        await locked.wait;
        const correcting = commitAdminOperation(
          actor,
          { operationId: randomUUID(), previewToken: preview.previewToken },
          fixture.operation,
        );
        const result = correcting.then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        try {
          await waitForParentWaiter(pool, owner);
          resume.release();
          assert.equal((await save).status, 200);
          const outcome = await result;
          assert.ok('error' in outcome);
          assert.equal(outcome.error.code, 'ENTRY_CHANGED');
          const current = await fixture.repo.getAdminDetailById(77, 44);
          assert.equal(current.day!.status, 'draft');
          assert.equal(
            current.day!.sessions[0].endAt,
            new Date(fixture.end).toISOString(),
          );
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::integer AS n FROM public.time_entry_audit WHERE action='admin_corrected_approved'",
              )
            ).rows[0].n,
            0,
          );
        } finally {
          resume.release();
          await save;
          await result;
        }
      });
    }),
);

for (const writer of ['tutor save', 'clock in'] as const)
  test(
    `${writer} loses a missing-day creation race without altering the admin-approved winner`,
    options,
    async () =>
      withTimeEntryDatabase(async (pool) => {
        const fixture = await prepare(pool),
          missing = barrier(),
          resume = barrier(),
          traces: Trace[] = [];
        let paused = false;
        const observed = observedPool(pool, traces, async (sql, result) => {
          if (
            !paused &&
            /FROM public\.time_entry_days/.test(sql) &&
            /FOR UPDATE/.test(sql) &&
            !result.rowCount
          ) {
            paused = true;
            missing.release();
            await resume.wait;
          }
        });
        await withWriterHttp(observed, async (request) => {
          const saving =
            writer === 'tutor save'
              ? request('PUT', `/time-entry/me/day/${fixture.workDate}`, {
                  sessions: [{ startAt: fixture.start, endAt: fixture.end }],
                })
              : request('POST', '/clock/me/in');
          await missing.wait;
          try {
            const preview = await previewCorrection(
              actor,
              {
                franchiseId: 77,
                tutorId: 88,
                workDate: fixture.workDate,
                expectedRevision: 'missing',
                sessions: [
                  {
                    id: null,
                    startAt: fixture.start,
                    endAt: fixture.correctedEnd,
                  },
                ],
                breaks: [],
                reason: 'Create complete missing time',
              },
              fixture.deps,
            );
            await commitAdminOperation(
              actor,
              { operationId: randomUUID(), previewToken: preview.previewToken },
              fixture.operation,
            );
            const winner = await databaseState(pool);
            resume.release();
            const response = await saving;
            assert.equal(
              response.status,
              409,
              `${writer} must reload the concurrent winner`,
            );
            assert.equal(
              ((await response.json()) as any).code,
              'ENTRY_CHANGED',
            );
            assert.deepEqual(await databaseState(pool), winner);
            assert.equal(winner.days[0].status, 'approved');
            assert.equal(winner.sessions.length, 1);
            assert.equal(winner.audits.length, 1);
            const insert = traces.findIndex((t) =>
              /INSERT INTO public\.time_entry_days/.test(t.sql),
            );
            assert.ok(insert >= 0);
            assert.equal(traces[insert].rowCount, 0);
            assert.ok(
              !traces
                .slice(insert + 1)
                .some((t) =>
                  /\b(INSERT|UPDATE|DELETE)\s+(INTO\s+|FROM\s+)?public\.time_entry_(sessions|breaks|audit)/.test(
                    t.sql,
                  ),
                ),
            );
          } finally {
            resume.release();
            await saving;
          }
        });
      }),
  );
