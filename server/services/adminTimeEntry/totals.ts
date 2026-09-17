import type {
  AdminEntry,
  BreakInput,
  MinuteSummary,
  SessionInput,
} from './contracts';
import { computeTimeAllocation } from '../timeAllocation';
export const unknownSummary = (): MinuteSummary => ({
  grossMinutes: null,
  unpaidBreakMinutes: null,
  recordedPaidMinutes: null,
  approvedMinutes: null,
});
export function summarize(
  sessions: Array<{ startAt: string; endAt: string | null }>,
  breaks: AdminEntry['breaks'] | BreakInput[],
  approved: boolean,
): MinuteSummary {
  if (
    !sessions.length ||
    sessions.some((s) => s.endAt === null) ||
    breaks.some((b) => b.status === 'active')
  )
    return unknownSummary();
  const sorted = sessions
    .slice()
    .sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
  if (
    sorted.some(
      (s, i) =>
        i > 0 && Date.parse(s.startAt) < Date.parse(sorted[i - 1].endAt!),
    )
  )
    return unknownSummary();
  const result = computeTimeAllocation({
    sessions: sessions as SessionInput[],
    breaks,
    scheduleIntervals: [],
  });
  if (!result.ok) return unknownSummary();
  return {
    grossMinutes: result.allocation.manual.grossMinutes,
    unpaidBreakMinutes: result.allocation.manual.unpaidBreakMinutes,
    recordedPaidMinutes: result.allocation.manual.paidMinutes,
    approvedMinutes: approved ? result.allocation.manual.paidMinutes : 0,
  };
}
export function entrySummary(day: AdminEntry | null): MinuteSummary {
  if (!day)
    return {
      grossMinutes: 0,
      unpaidBreakMinutes: 0,
      recordedPaidMinutes: 0,
      approvedMinutes: 0,
    };
  const totals = summarize(day.sessions, day.breaks, day.status === 'approved');
  // Lifecycle exclusion is known even when the original recorded intervals
  // cannot be calculated. Unknown approved totals only apply to approved days.
  return {
    ...totals,
    approvedMinutes: day.status === 'approved' ? totals.approvedMinutes : 0,
  };
}
