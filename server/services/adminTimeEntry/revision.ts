import { createHash } from 'node:crypto';
import { canonicalJsonStringify } from '../scheduleSnapshot';
import type { AdminEntry } from './contracts';
import { persistedTimestamp } from './timestamps';
const normalizeTimestamp = (value: string | null) =>
  value === null ? null : persistedTimestamp(value);
export function revisionForEntry(day: AdminEntry | null): string {
  if (!day) return 'missing';
  const canonical = {
    ...day,
    createdAt: normalizeTimestamp(day.createdAt),
    updatedAt: normalizeTimestamp(day.updatedAt),
    submittedAt: normalizeTimestamp(day.submittedAt),
    decidedAt: normalizeTimestamp(day.decidedAt),
    sessions: day.sessions
      .map((s) => ({
        ...s,
        startAt: normalizeTimestamp(s.startAt),
        endAt: normalizeTimestamp(s.endAt),
        createdAt: normalizeTimestamp(s.createdAt),
        updatedAt: normalizeTimestamp(s.updatedAt),
      }))
      .sort((a, b) => a.id - b.id),
    breaks: day.breaks
      .map((b) => ({
        ...b,
        startTime: normalizeTimestamp(b.startTime),
        endTime: normalizeTimestamp(b.endTime),
        createdAt: normalizeTimestamp(b.createdAt),
        updatedAt: normalizeTimestamp(b.updatedAt),
      }))
      .sort((a, b) => a.id - b.id),
  };
  return createHash('sha256')
    .update(canonicalJsonStringify(canonical))
    .digest('hex');
}
