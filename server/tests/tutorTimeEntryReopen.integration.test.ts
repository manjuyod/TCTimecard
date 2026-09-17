import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { withTimeEntryDatabase } from './helpers/adminTimeEntryDatabase';
import { actor, barrier, databaseState, observedPool, prepare, seedDay, waitForParentWaiter, withWriterHttp } from './helpers/timeEntryWriterGuards';
import { previewStatusOperation } from '../services/adminTimeEntry/preview';
import { commitAdminOperation } from '../services/adminTimeEntry/operations';

const options = { skip: process.env.RUN_TIME_ENTRY_POSTGRES_TESTS !== '1' };

test('tutor reads expose the current void confirmation and malformed or wrong-day confirmations cannot mutate', options, async () => {
  await withTimeEntryDatabase(async pool => {
    const fixture = await voidFixture(pool);
    const before = await databaseState(pool);
    await withWriterHttp(pool, async request => {
      const clock = await request('GET', '/clock/me/state');
      assert.equal(clock.status, 200);
      assert.equal((await clock.json() as any).state.voidedAuditId, fixture.voidAuditId);
      const calendar = await request('GET', `/time-entry/me?start=${fixture.workDate}&end=${fixture.workDate}`);
      assert.equal(calendar.status, 200);
      assert.equal((await calendar.json() as any).days[0].voidedAuditId, fixture.voidAuditId);
      for (const value of [null, true, '1', 0, -1, 1.5]) {
        for (const [method, path] of [['POST', '/clock/me/in'], ['PUT', `/time-entry/me/day/${fixture.workDate}`]]) {
          const response = await request(method, path, {
            sessions: [{ startAt: fixture.start, endAt: fixture.end }], reopenVoidedAuditId: value
          });
          assert.equal(response.status, 400, `${path}: ${value}`);
        }
      }
      const wrongDay = fixture.today.minus({ days: 1 });
      const response = await request('PUT', `/time-entry/me/day/${wrongDay.toISODate()}`, {
        sessions: [{ startAt: wrongDay.set({ hour: 9 }).toISO(), endAt: wrongDay.set({ hour: 12 }).toISO() }],
        reopenVoidedAuditId: fixture.voidAuditId
      });
      assert.equal(response.status, 409);
      assert.deepEqual(await databaseState(pool), before);
    });
  });
});

test('concurrent explicit replacements serialize and the loser cannot clear the winning session', options, async () => {
  await withTimeEntryDatabase(async pool => {
    const fixture = await voidFixture(pool);
    const locked = barrier(), release = barrier();
    let blockerId = 0;
    const observed = observedPool(pool, [], async (sql, result, clientId) => {
      if (!blockerId && /FROM public\.time_entry_days/.test(sql) && /FOR UPDATE/.test(sql) && result.rowCount) {
        blockerId = clientId;
        locked.release();
        await release.wait;
      }
    });
    await withWriterHttp(observed, async request => {
      const first = request('POST', '/clock/me/in', { reopenVoidedAuditId: fixture.voidAuditId });
      await locked.wait;
      const second = request('POST', '/clock/me/in', { reopenVoidedAuditId: fixture.voidAuditId });
      try { await waitForParentWaiter(pool, blockerId); } finally { release.release(); }
      assert.equal((await first).status, 201);
      assert.equal((await second).status, 409);
      const state = await databaseState(pool);
      assert.equal(state.sessions.length, 1);
      assert.notEqual(state.sessions[0].id, 99);
      assert.equal(state.breaks.length, 0);
      assert.equal(state.audits.filter(a => a.action === 'tutor_reopened').length, 1);
      assert.equal(state.days[0].status, 'pending');
      const current = await request('GET', '/clock/me/state');
      assert.equal((await current.json() as any).state.voidedAuditId, null);
    });
  });
});

async function voidFixture(pool: Pool) {
  const fixture = await prepare(pool);
  await seedDay(pool, fixture, 'approved');
  await pool.query(`INSERT INTO public.time_entry_breaks(entry_day_id,time_entry_session_id,franchiseid,tutorid,
    start_time,end_time,duration_minutes,break_type,pay_treatment,source,status)
    VALUES(44,99,77,88,$1,$2,30,'lunch','unpaid','employee','completed')`, [fixture.breakStart, fixture.breakEnd]);
  const detail = await fixture.repo.getAdminDetailById(77, 44);
  const preview = await previewStatusOperation('void', actor, { franchiseId: 77, dayId: 44,
    expectedRevision: detail.revision, reason: 'Erroneous original time' }, fixture.deps);
  const result = await commitAdminOperation(actor, {
    operationId: randomUUID(), previewToken: preview.previewToken }, fixture.operation);
  return { ...fixture, voidAuditId: result.auditId };
}

test('tutor replacement reuses the day, archives old sessions/breaks and uses normal submission approval', options, async () => {
  await withTimeEntryDatabase(async pool => {
    const fixture = await voidFixture(pool);
    const original = await databaseState(pool);
    await withWriterHttp(observedPool(pool, []), async request => {
      const response = await request('PUT', `/time-entry/me/day/${fixture.workDate}`, {
        sessions: [{ startAt: fixture.start, endAt: fixture.end }], reopenVoidedAuditId: fixture.voidAuditId
      });
      const body = await response.json() as any;
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.equal(body.day.id, 44);
      assert.equal(body.day.status, 'pending');
      assert.equal(body.day.breaks.length, 0, 'Voided breaks must not reduce the replacement hours');
      assert.equal(body.day.breakSummary.paidMinutes, 180);
      assert.equal(body.day.scheduleSnapshot, null);
      assert.equal(body.day.decidedAt, null);
      const state = await databaseState(pool);
      assert.equal(state.days.length, 1);
      assert.equal(state.sessions.length, 1);
      assert.notEqual(state.sessions[0].id, 99);
      const audit = state.audits.find(a => a.action === 'tutor_reopened');
      assert.ok(audit);
      assert.equal(audit.actor_account_id, 88);
      assert.equal(audit.actor_account_type, 'TUTOR');
      assert.equal(audit.previous_status, 'voided');
      assert.equal(audit.new_status, 'pending');
      assert.equal(audit.metadata.before.sessions[0].id, 99);
      assert.equal(audit.metadata.before.breaks.length, 1);
      assert.equal(audit.metadata.after.sessions[0].id, state.sessions[0].id);
      assert.equal(audit.metadata.after.breaks.length, 0);
      assert.deepEqual(state.audits.filter(a => a.action !== 'tutor_reopened' && a.action !== 'saved'), original.audits);
      const submitted = await request('POST', `/time-entry/me/day/${fixture.workDate}/submit`, { scheduleSnapshot: fixture.snapshot });
      assert.equal(submitted.status, 200);
      assert.equal((await submitted.json() as any).day.status, 'approved');
      const current = await fixture.repo.getAdminDetailById(77, 44);
      assert.equal(current.totals!.approvedMinutes, 180);
      assert.ok(!current.allowedActions.includes('restore'));
    });
  });
});

test('clock-in after explicit void replacement starts one fresh pending session, never appends the voided hours', options, async () => {
  await withTimeEntryDatabase(async pool => {
    const fixture = await voidFixture(pool);
    await withWriterHttp(observedPool(pool, []), async request => {
      const response = await request('POST', '/clock/me/in', { reopenVoidedAuditId: fixture.voidAuditId });
      const body = await response.json() as any;
      assert.equal(response.status, 201, JSON.stringify(body));
      assert.equal(body.state.dayId, 44);
      assert.equal(body.state.dayStatus, 'pending');
      assert.equal(body.state.clockState, 1);
      assert.notEqual(body.state.openSessionId, 99);
      const beforeRetry = await databaseState(pool);
      assert.equal(beforeRetry.sessions.length, 1);
      assert.equal(beforeRetry.sessions[0].end_at, null);
      assert.equal(beforeRetry.breaks.length, 0);
      const audit = beforeRetry.audits.find(a => a.action === 'tutor_reopened');
      assert.equal(audit.metadata.before.sessions[0].id, 99);
      assert.equal(audit.metadata.after.sessions[0].id, body.state.openSessionId);
      assert.equal(audit.metadata.after.clockState, 1);
      const duplicate = await request('POST', '/clock/me/in', { reopenVoidedAuditId: fixture.voidAuditId });
      assert.equal(duplicate.status, 409);
      assert.deepEqual(await databaseState(pool), beforeRetry, 'A retry cannot clear the fresh session');
    });
  });
});

test('replacement that exceeds scheduled time stays pending', options, async () => {
  await withTimeEntryDatabase(async pool => {
    const fixture = await voidFixture(pool);
    await withWriterHttp(pool, async request => {
      const saved = await request('PUT', `/time-entry/me/day/${fixture.workDate}`, {
        sessions: [{ startAt: fixture.start, endAt: fixture.correctedEnd }], reopenVoidedAuditId: fixture.voidAuditId
      });
      assert.equal(saved.status, 200);
      const submitted = await request('POST', `/time-entry/me/day/${fixture.workDate}/submit`, { scheduleSnapshot: fixture.snapshot });
      assert.equal(submitted.status, 200);
      const day = (await submitted.json() as any).day;
      assert.equal(day.status, 'pending');
      assert.equal(day.breakSummary.paidMinutes, 195);
      assert.equal((await fixture.repo.getAdminDetailById(77, 44)).totals!.approvedMinutes, 0);
    });
  });
});

for (const expected of ['approved', 'pending'] as const) {
  test(`replacement clock-out uses normal schedule comparison: ${expected}`, options, async () => {
    await withTimeEntryDatabase(async pool => {
      const fixture = await voidFixture(pool);
      // A deterministic clock boundary; all data reads/writes and transaction locking use real PostgreSQL.
      const atClockOut = observedPool(pool, [], async (sql, result) => {
        if (sql.trim() === "SELECT DATE_TRUNC('minute', NOW()) AS end_at")
          result.rows[0].end_at = expected === 'approved' ? fixture.end : fixture.correctedEnd;
      });
      await withWriterHttp(atClockOut, async request => {
        const clockIn = await request('POST', '/clock/me/in', { reopenVoidedAuditId: fixture.voidAuditId });
        assert.equal(clockIn.status, 201);
        const freshId = (await clockIn.json() as any).state.openSessionId;
        await pool.query('UPDATE public.time_entry_sessions SET start_at=$1 WHERE id=$2', [fixture.start, freshId]);
        const clockOut = await request('POST', '/clock/me/out', { scheduleSnapshot: fixture.snapshot });
        const result = await clockOut.json() as any;
        assert.equal(clockOut.status, 200, JSON.stringify(result));
        assert.equal(result.state.dayStatus, expected);
        assert.equal(result.state.clockState, 0);
        const detail = await fixture.repo.getAdminDetailById(77, 44);
        assert.equal(detail.day!.sessions.length, 1);
        assert.equal(detail.day!.sessions[0].id, freshId);
        assert.equal(detail.day!.breaks.length, 0);
        assert.equal(detail.totals!.recordedPaidMinutes, expected === 'approved' ? 180 : 195);
        assert.equal(detail.totals!.approvedMinutes, expected === 'approved' ? 180 : 0);
        assert.equal((await databaseState(pool)).audits.filter(a => a.action === 'tutor_reopened').length, 1);
      });
    });
  });
}

test('a stale void confirmation cannot reopen a newer void or overwrite restored time', options, async () => {
  await withTimeEntryDatabase(async pool => {
    const fixture = await voidFixture(pool);
    let detail = await fixture.repo.getAdminDetailById(77, 44);
    const restore = await previewStatusOperation('restore', actor, { franchiseId: 77, dayId: 44, expectedRevision: detail.revision, reason: 'Restore verified hours' }, fixture.deps);
    await commitAdminOperation(actor, { operationId: randomUUID(), previewToken: restore.previewToken }, fixture.operation);
    await withWriterHttp(pool, async request => {
      const restoredState = await databaseState(pool);
      const stale = await request('PUT', `/time-entry/me/day/${fixture.workDate}`, {
        sessions: [{ startAt: fixture.start, endAt: fixture.correctedEnd }], reopenVoidedAuditId: fixture.voidAuditId
      });
      assert.equal(stale.status, 409);
      assert.deepEqual(await databaseState(pool), restoredState);
      detail = await fixture.repo.getAdminDetailById(77, 44);
      const revoid = await previewStatusOperation('void', actor, { franchiseId: 77, dayId: 44, expectedRevision: detail.revision, reason: 'Void a second time' }, fixture.deps);
      await commitAdminOperation(actor, { operationId: randomUUID(), previewToken: revoid.previewToken }, fixture.operation);
      const revoided = await databaseState(pool);
      const response = await request('POST', '/clock/me/in', { reopenVoidedAuditId: fixture.voidAuditId });
      assert.equal(response.status, 409);
      assert.deepEqual(await databaseState(pool), revoided);
    });
  });
});

test('reopening audit failure rolls back the day and all original children', options, async () => {
  await withTimeEntryDatabase(async pool => {
    const fixture = await voidFixture(pool);
    const before = await databaseState(pool);
    const failing = observedPool(pool, [], async sql => {
      if (sql.includes('INSERT INTO public.time_entry_audit') && sql.includes("'tutor_reopened'")) throw new Error('Injected audit failure');
    });
    await withWriterHttp(failing, async request => {
      const response = await request('PUT', `/time-entry/me/day/${fixture.workDate}`, {
        sessions: [{ startAt: fixture.start, endAt: fixture.end }], reopenVoidedAuditId: fixture.voidAuditId
      });
      assert.equal(response.status, 500);
      assert.deepEqual(await databaseState(pool), before);
    });
  });
});
