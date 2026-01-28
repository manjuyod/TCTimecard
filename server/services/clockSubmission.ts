import type { ScheduleSnapshotV1 } from './scheduleSnapshot';
import type { TimeEntryComparisonV1 } from './timeEntryComparison';

export type TimeEntryStatus = 'draft' | 'pending' | 'approved' | 'denied';

export type ClockSubmissionDecision = {
  nextStatus: 'pending' | 'approved';
  decidedAt: string | null;
  decisionReason: string | null;
  audit: {
    action: 'submitted' | 'auto_approved';
    actorAccountType: 'SYSTEM';
    actorAccountId: null;
    metadata: Record<string, unknown>;
  };
};

export const shouldInvalidateClockDayStatus = (status: TimeEntryStatus): boolean =>
  status === 'approved' || status === 'denied';

export const resolveClockOutSubmission = (params: {
  snapshot: ScheduleSnapshotV1;
  comparison: TimeEntryComparisonV1;
  workDate: string;
  timezone: string;
}): ClockSubmissionDecision => {
  const matches = params.comparison.matches;
  const nextStatus: 'pending' | 'approved' = matches ? 'approved' : 'pending';
  const decidedAt = matches ? new Date().toISOString() : null;
  const decisionReason = matches ? 'auto-approved (exact schedule match)' : null;

  return {
    nextStatus,
    decidedAt,
    decisionReason,
    audit: {
      action: matches ? 'auto_approved' : 'submitted',
      actorAccountType: 'SYSTEM',
      actorAccountId: null,
      metadata: {
        workDate: params.workDate,
        timezone: params.timezone,
        scheduleSnapshot: params.snapshot,
        comparison: params.comparison,
        auto: true,
        reason: matches ? 'exact_match' : 'outside_schedule',
        source: 'clock_out'
      }
    }
  };
};
