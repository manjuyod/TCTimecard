import type { AdminPreview, AdminTimeEntryDetail } from '../lib/adminTimeEntry';
export const pendingDetail: AdminTimeEntryDetail = {
  franchiseId: 77, tutor: { tutorId: 88, displayName: 'Alex Rivera', active: true, historyOnly: false },
  workDate: '2026-09-15', timezone: 'America/Los_Angeles', revision: 'fixture-revision', allowedActions: ['correct'],
  day: { id: 44, franchiseId: 77, tutorId: 88, workDate: '2026-09-15', timezone: 'America/Los_Angeles',
    status: 'pending', clockState: 0, scheduleSnapshot: null, comparison: null,
    submittedAt: '2026-09-16T01:00:00Z', decidedBy: null, decidedAt: null, decisionReason: null,
    createdAt: '2026-09-15T22:00:00Z', updatedAt: '2026-09-16T01:00:00Z',
    sessions: [{ id: 99, startAt: '2026-09-15T22:00:00Z', endAt: '2026-09-16T01:00:00Z', sortOrder: 0,
      createdAt: '2026-09-15T22:00:00Z', updatedAt: '2026-09-16T01:00:00Z' }], breaks: [], lastAuditId: 1 }
};
export const correctionPreview: AdminPreview = {
  previewToken: 'signed-preview', expiresAt: '2099-01-01T00:00:00Z',
  review: { action: 'correct', originalEntry: pendingDetail.day,
    correction: { reason: 'Forgot to clock out', sessions: [{ id: 99,
      startAt: '2026-09-15T22:00:00Z', endAt: '2026-09-16T01:15:00Z' }], breaks: [] },
    workDate: pendingDetail.workDate, timezone: pendingDetail.timezone, reason: 'Forgot to clock out' },
  before: { grossMinutes: 180, unpaidBreakMinutes: 0, recordedPaidMinutes: 180, approvedMinutes: 0 },
  after: { grossMinutes: 195, unpaidBreakMinutes: 0, recordedPaidMinutes: 195, approvedMinutes: 195 },
  recordedDeltaMinutes: 15, approvedDeltaMinutes: 195, warnings: []
};
