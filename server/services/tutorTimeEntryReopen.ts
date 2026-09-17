import type { ErrorRequestHandler } from 'express';
import type { PoolClient } from 'pg';
import type { AdminEntry } from './adminTimeEntry/contracts';
import { readEntryById } from './adminTimeEntry/repository';

class TutorReopenError extends Error {
  constructor(message: string, readonly status = 409, readonly code = 'ENTRY_CHANGED') { super(message); }
}

export const tutorReopenErrorHandler: ErrorRequestHandler = (error, _req, res, next) => {
  if (!(error instanceof TutorReopenError) || res.headersSent) { next(error); return; }
  res.status(error.status).json({ error: error.message, code: error.code });
};

export function parseReopenVoidedAuditId(value: unknown): number | null {
  if (value === undefined) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
    throw new TutorReopenError('Reload the voided day before confirming replacement.', 400, 'INVALID_INPUT');
  return value;
}

/** Runs inside the caller's transaction. Only an explicit, current void confirmation can clear old hours. */
export async function prepareTutorReopen(client: PoolClient, input: {
  dayId: number; franchiseId: number; tutorId: number; workDate: string; voidAuditId: number;
}): Promise<AdminEntry> {
  const before = await readEntryById(client, input.franchiseId, input.dayId, true);
  if (!before || before.tutorId !== input.tutorId || before.workDate !== input.workDate
      || before.status !== 'voided' || before.lastAuditId !== input.voidAuditId)
    throw new TutorReopenError('This day changed after you loaded it. Reload before replacing voided time.');
  const audit = await client.query(
    `SELECT action FROM public.time_entry_audit WHERE id=$1 AND entry_day_id=$2 AND actor_account_type='ADMIN'`,
    [input.voidAuditId, before.id]
  );
  if (audit.rows[0]?.action !== 'admin_voided')
    throw new TutorReopenError('The original void could not be verified. Reload the entry.');

  // The complete original aggregate is appended to audit in this SAME transaction after replacement succeeds.
  await client.query('DELETE FROM public.time_entry_breaks WHERE entry_day_id=$1', [before.id]);
  await client.query('DELETE FROM public.time_entry_sessions WHERE entry_day_id=$1', [before.id]);
  await client.query(`UPDATE public.time_entry_days SET status='pending', clock_state=0,
    schedule_snapshot=NULL, comparison=NULL, submitted_at=NOW(), decided_by=NULL, decided_at=NULL,
    decision_reason=NULL, updated_at=NOW() WHERE id=$1`, [before.id]);
  return before;
}

export async function appendTutorReopenAudit(client: PoolClient, before: AdminEntry, source: 'clock_in' | 'manual_entry'): Promise<void> {
  const after = await readEntryById(client, before.franchiseId, before.id, false);
  if (!after || after.status !== 'pending') throw new Error('Replacement day was not saved as pending');
  await client.query(`INSERT INTO public.time_entry_audit
    (entry_day_id,action,actor_account_type,actor_account_id,at,previous_status,new_status,metadata)
    VALUES($1,'tutor_reopened','TUTOR',$2,NOW(),'voided','pending',$3)`, [before.id, before.tutorId, {
    version: 1, reason: 'Tutor replaced previously voided time.', source,
    replacesVoidAuditId: before.lastAuditId, before, after
  }]);
}
