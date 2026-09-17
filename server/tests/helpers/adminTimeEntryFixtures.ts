import type { Pool } from 'pg';
import type {
  AdminCommand,
  AdminEntry,
  CorrectionInput,
} from '../../services/adminTimeEntry/contracts';
const zero = {
  grossMinutes: 0,
  unpaidBreakMinutes: 0,
  recordedPaidMinutes: 0,
  approvedMinutes: 0,
};
export const testCommand: AdminCommand = {
  version: 1,
  action: 'void',
  actor: { accountId: 100, franchiseId: 77 },
  tutorId: 88,
  workDate: '2026-09-15',
  timezone: 'America/Los_Angeles',
  entryId: 44,
  expectedRevision: 'hash',
  reason: 'Remove erroneous shift',
  correction: null,
  scheduleSnapshot: null,
  scheduleSource: 'none',
  before: zero,
  after: zero,
  issuedAt: '2026-09-16T12:00:00.000Z',
  expiresAt: '2026-09-16T12:10:00.000Z',
};
export const pendingEntry = (
  overrides: Partial<AdminEntry> = {},
): AdminEntry => ({
  id: 44,
  franchiseId: 77,
  tutorId: 88,
  workDate: '2026-09-15',
  timezone: 'America/Los_Angeles',
  status: 'pending',
  clockState: 0,
  scheduleSnapshot: null,
  comparison: null,
  submittedAt: '2026-09-16T01:00:00Z',
  decidedBy: null,
  decidedAt: null,
  decisionReason: null,
  createdAt: '2026-09-15T22:00:00Z',
  updatedAt: '2026-09-16T01:00:00Z',
  sessions: [
    {
      id: 99,
      startAt: '2026-09-15T22:00:00Z',
      endAt: '2026-09-16T01:00:00Z',
      sortOrder: 0,
      createdAt: '2026-09-15T22:00:00Z',
      updatedAt: '2026-09-16T01:00:00Z',
    },
  ],
  breaks: [],
  lastAuditId: 1,
  ...overrides,
});
export const correctionInput = (
  overrides: Partial<CorrectionInput> = {},
): CorrectionInput => ({
  franchiseId: 77,
  tutorId: 88,
  workDate: '2026-09-15',
  expectedRevision: 'test-revision',
  sessions: [
    { id: 99, startAt: '2026-09-15T22:00:00Z', endAt: '2026-09-16T01:15:00Z' },
  ],
  breaks: [],
  reason: 'Corrected forgotten clock-out',
  ...overrides,
});
export async function seedPendingEntry(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO public.time_entry_days (id,franchiseid,tutorid,work_date,timezone,status,clock_state) VALUES (44,77,88,'2026-09-15','America/Los_Angeles','pending',0)`,
  );
  await pool.query(
    `INSERT INTO public.time_entry_sessions (id,entry_day_id,franchiseid,tutorid,start_at,end_at,sort_order) VALUES (99,44,77,88,'2026-09-15T22:00:00Z','2026-09-16T01:00:00Z',0)`,
  );
  await pool.query(
    `SELECT setval(pg_get_serial_sequence('public.time_entry_days','id'),44)`,
  );
  await pool.query(
    `SELECT setval(pg_get_serial_sequence('public.time_entry_sessions','id'),99)`,
  );
}
