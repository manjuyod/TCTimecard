import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withTimeEntryDatabase } from './helpers/adminTimeEntryDatabase';
import { actor, databaseState, observedPool, prepare, seedDay, withWriterHttp } from './helpers/timeEntryWriterGuards';
import { previewCorrection, previewStatusOperation } from '../services/adminTimeEntry/preview';
import { commitAdminOperation } from '../services/adminTimeEntry/operations';

const options = { skip: process.env.RUN_TIME_ENTRY_POSTGRES_TESTS !== '1' };

test('approved adjustment stays approved, preserves breaks and original approval history, and retries only once', options, async () => {
  await withTimeEntryDatabase(async pool => {
    const fixture = await prepare(pool);
    await seedDay(pool, fixture, 'approved');
    await pool.query("UPDATE public.time_entry_days SET decided_by=101,decided_at=$1,decision_reason='Original approval' WHERE id=44", [fixture.end]);
    await pool.query(`INSERT INTO public.time_entry_breaks(entry_day_id,time_entry_session_id,franchiseid,tutorid,
      start_time,end_time,duration_minutes,break_type,pay_treatment,source,status)
      VALUES(44,99,77,88,$1,$2,30,'lunch','unpaid','employee','completed')`, [fixture.breakStart, fixture.breakEnd]);
    const detail = await fixture.repo.getAdminDetailById(77, 44);
    assert.deepEqual(detail.allowedActions, ['correct', 'void']);
    const before = await databaseState(pool);
    const oldVoid = await previewStatusOperation('void', actor, { franchiseId: 77, dayId: 44,
      expectedRevision: detail.revision, reason: 'Previously reviewed void' }, fixture.deps);
    const originalBreak = detail.day!.breaks[0];
    const preview = await previewCorrection(actor, { franchiseId: 77, tutorId: 88, workDate: fixture.workDate,
      expectedRevision: detail.revision, reason: 'Correct approved clock-out',
      sessions: [{ id: 99, startAt: fixture.start, endAt: fixture.correctedEnd }],
      breaks: [{ id: originalBreak.id, breakType: 'lunch', payTreatment: 'unpaid', status: 'completed',
        startTime: originalBreak.startTime, endTime: originalBreak.endTime, durationMinutes: 30, note: null }]
    }, fixture.deps);
    assert.equal(preview.before.approvedMinutes, 150);
    assert.equal(preview.after.approvedMinutes, 165);
    assert.equal(preview.approvedDeltaMinutes, 15);
    assert.deepEqual(await databaseState(pool), before, 'Review must not change an approved entry');
    const input = { operationId: randomUUID(), previewToken: preview.previewToken };
    const result = await commitAdminOperation(actor, input, fixture.operation);
    assert.deepEqual(await commitAdminOperation(actor, input, fixture.operation), result);
    assert.equal(result.status, 'approved');
    assert.equal(result.entryId, 44);
    const after = await fixture.repo.getAdminDetailById(77, 44);
    assert.equal(after.totals!.approvedMinutes, 165);
    assert.equal(after.day!.decidedBy, 100);
    assert.equal(after.day!.decisionReason, 'Correct approved clock-out');
    assert.equal(after.day!.sessions[0].id, 99);
    assert.equal(after.day!.breaks[0].id, originalBreak.id);
    assert.equal(after.day!.breaks[0].source, 'employee');
    const audits = (await databaseState(pool)).audits;
    const audit = audits.find(a => a.operation_id === input.operationId);
    assert.equal(audits.filter(a => a.operation_id === input.operationId).length, 1);
    assert.equal(audit.actor_account_id, 100);
    assert.equal(audit.previous_status, 'approved');
    assert.equal(audit.new_status, 'approved');
    assert.equal(audit.metadata.before.sessions[0].endAt, fixture.end);
    assert.equal(audit.metadata.after.sessions[0].endAt, fixture.correctedEnd);
    assert.equal(audit.metadata.previousApproval.decidedBy, 101);
    assert.equal(audit.metadata.previousApproval.decisionReason, 'Original approval');
    assert.equal(audit.metadata.previousApproval.decidedAt, detail.day!.decidedAt);
    assert.equal(audit.metadata.reason, 'Correct approved clock-out');
    const committedState = await databaseState(pool);
    await assert.rejects(() => commitAdminOperation(actor, { operationId: randomUUID(), previewToken: oldVoid.previewToken }, fixture.operation),
      (error: any) => error.code === 'ENTRY_CHANGED');
    assert.deepEqual(await databaseState(pool), committedState, 'Old void review cannot remove the corrected hours');
  });
});

test('approved correction cannot overwrite a tutor who clocks back in after review', options, async () => {
  await withTimeEntryDatabase(async pool => {
    const fixture = await prepare(pool);
    await seedDay(pool, fixture, 'approved');
    const detail = await fixture.repo.getAdminDetailById(77, 44);
    const preview = await previewCorrection(actor, { franchiseId: 77, tutorId: 88, workDate: fixture.workDate,
      expectedRevision: detail.revision, reason: 'Adjust previously approved time', breaks: [],
      sessions: [{ id: 99, startAt: fixture.start, endAt: fixture.correctedEnd }] }, fixture.deps);
    await withWriterHttp(pool, async request => {
      assert.equal((await request('POST', '/clock/me/in')).status, 201);
      const clockedIn = await databaseState(pool);
      await assert.rejects(() => commitAdminOperation(actor, { operationId: randomUUID(), previewToken: preview.previewToken }, fixture.operation),
        (error: any) => error.code === 'ENTRY_CHANGED');
      assert.deepEqual(await databaseState(pool), clockedIn);
    });
  });
});

test('an approved adjustment rolls back all changes when its audit fails', options, async () => {
  await withTimeEntryDatabase(async pool => {
    const fixture = await prepare(pool);
    await seedDay(pool, fixture, 'approved');
    const detail = await fixture.repo.getAdminDetailById(77, 44);
    const preview = await previewCorrection(actor, { franchiseId: 77, tutorId: 88, workDate: fixture.workDate,
      expectedRevision: detail.revision, reason: 'Adjust previously approved time', breaks: [],
      sessions: [{ id: 99, startAt: fixture.start, endAt: fixture.correctedEnd }] }, fixture.deps);
    const before = await databaseState(pool);
    const failing = observedPool(pool, [], async sql => {
      if (sql.includes('INSERT INTO public.time_entry_audit')) throw new Error('Injected audit failure');
    });
    await assert.rejects(() => commitAdminOperation(actor, { operationId: randomUUID(), previewToken: preview.previewToken },
      { ...fixture.operation, pool: failing }), /Injected audit failure/);
    assert.deepEqual(await databaseState(pool), before);
  });
});
