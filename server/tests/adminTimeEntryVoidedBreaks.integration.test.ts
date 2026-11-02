import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withTimeEntryDatabase } from './helpers/adminTimeEntryDatabase';
import { seedPendingEntry } from './helpers/adminTimeEntryFixtures';
import { createAdminRepository } from '../services/adminTimeEntry/repository';
import { createAdminDirectory } from '../services/adminTimeEntry/directory';
import { previewCorrection, previewStatusOperation } from '../services/adminTimeEntry/preview';
import { verifyAdminPreviewIntegrity } from '../services/adminTimeEntry/previewToken';
import { commitAdminOperation } from '../services/adminTimeEntry/operations';
import type { BreakInput, PreviewDeps } from '../services/adminTimeEntry/contracts';

test('voided next-day break survives audited saves, later correction, and whole-day restore',
  { skip: process.env.RUN_TIME_ENTRY_POSTGRES_TESTS !== '1' }, async () => {
    await withTimeEntryDatabase(async pool => {
      await seedPendingEntry(pool);
      await pool.query("UPDATE public.time_entry_days SET work_date='2026-10-26' WHERE id=44");
      await pool.query("UPDATE public.time_entry_sessions SET start_at='2026-10-26T17:45:00Z',end_at='2026-10-27T02:45:00Z' WHERE id=99");
      await pool.query(`INSERT INTO public.time_entry_breaks
        (id,entry_day_id,time_entry_session_id,franchiseid,tutorid,start_time,end_time,duration_minutes,break_type,pay_treatment,source,status)
        VALUES (11,44,99,77,88,'2026-10-26T20:00:00Z','2026-10-26T21:00:00Z',60,'lunch','unpaid','employee','completed'),
               (12,44,99,77,88,'2026-10-27T21:33:09.123456Z','2026-10-27T21:50:09.123456Z',17,'lunch','unpaid','employee','completed')`);
      const actor = { accountId: 100, franchiseId: 77 };
      const tutor = { tutorId: 88, displayName: 'Test Tutor', active: true, historyOnly: false };
      const directory = createAdminDirectory({ pool: () => pool, roster: async () => [tutor] });
      const repo = createAdminRepository({ pool: () => pool, directory });
      const now = () => new Date('2026-11-02T21:00:00Z');
      const secret = 'local-voided-break-regression';
      const deps: PreviewDeps = {
        getDetail: repo.getAdminDetail, getById: repo.getAdminDetailById,
        requireActiveTutor: directory.requireActiveTutor,
        getSchedule: async () => { throw new Error('Schedule intentionally unavailable; no CRM access'); },
        now, secret,
      };
      const operation = { pool, secret, now };
      const original = await repo.getAdminDetailById(77, 44);
      const historical = original.day!.breaks[1];
      assert.equal(historical.startTime, '2026-10-27T21:33:09.123456Z');
      assert.equal(historical.endTime, '2026-10-27T21:50:09.123456Z');
      for (let pass = 0; pass < 2; pass++) {
        const detail = await repo.getAdminDetailById(77, 44);
        const preview = await previewCorrection(actor, {
          franchiseId: 77, tutorId: 88, workDate: detail.workDate,
          expectedRevision: detail.revision, reason: 'Remove historical next-day break',
          sessions: detail.day!.sessions.map(s => ({ id: s.id, startAt: s.startAt, endAt: s.endAt! })),
          breaks: detail.day!.breaks.map(({ sessionId, source, createdAt, updatedAt, ...b }) => ({
            ...b, status: b.id === 12 ? 'voided' : 'completed',
          } as BreakInput)),
        }, deps);
        const command = verifyAdminPreviewIntegrity(preview.previewToken, secret);
        assert.equal(command.correction!.breaks[1].startTime, historical.startTime);
        assert.equal(command.correction!.breaks[1].endTime, historical.endTime);
        assert.equal(preview.after.approvedMinutes, 480);
        const input = { operationId: randomUUID(), previewToken: preview.previewToken };
        const saved = await commitAdminOperation(actor, input, operation);
        assert.equal(saved.after.approvedMinutes, 480);
        assert.deepEqual(await commitAdminOperation(actor, input, operation), saved);
        const updated = await repo.getAdminDetailById(77, 44);
        assert.equal(updated.day!.breaks[1].status, 'voided');
        assert.equal(updated.day!.breaks[1].startTime, historical.startTime);
        assert.equal(updated.day!.breaks[1].endTime, historical.endTime);
        assert.equal(updated.day!.breaks[1].durationMinutes, 17);
        const audit = (await pool.query('SELECT metadata FROM public.time_entry_audit WHERE operation_id=$1', [input.operationId])).rows[0].metadata;
        assert.equal(audit.before.breaks[1].status, pass === 0 ? 'completed' : 'voided');
        assert.equal(audit.after.breaks[1].status, 'voided');
        assert.equal(audit.before.breaks[1].startTime, historical.startTime);
        assert.equal(audit.after.breaks[1].startTime, historical.startTime);
        assert.equal(audit.before.breaks[1].endTime, historical.endTime);
        assert.equal(audit.after.breaks[1].endTime, historical.endTime);
      }
      for (const action of ['void', 'restore'] as const) {
        const detail = await repo.getAdminDetailById(77, 44);
        const preview = await previewStatusOperation(action, actor, {
          franchiseId: 77, dayId: 44, expectedRevision: detail.revision,
          reason: 'Verify whole-day lifecycle preserves removed break',
        }, deps);
        const saved = await commitAdminOperation(actor, {
          operationId: randomUUID(), previewToken: preview.previewToken,
        }, operation);
        assert.equal(saved.after.approvedMinutes, action === 'void' ? 0 : 480);
      }
      const restored = await repo.getAdminDetailById(77, 44);
      assert.equal(restored.day!.status, 'approved');
      assert.equal(restored.day!.breaks[1].status, 'voided');
      assert.equal(restored.day!.breaks[1].startTime, historical.startTime);
    });
  });
