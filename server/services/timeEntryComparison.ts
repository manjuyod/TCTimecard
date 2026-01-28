import { DateTime } from 'luxon';
import type { ScheduleSnapshotInterval } from './scheduleSnapshot';

export type MinuteInterval = { startMinute: number; endMinute: number };

export type TimeEntryComparisonV1 = {
  version: 1;
  computedAt: string;
  matches: boolean;
  exactMatch: boolean;
  manual: {
    union: Array<{ startAt: string; endAt: string }>;
    totalMinutes: number;
  };
  scheduled: {
    union: Array<{ startAt: string; endAt: string }>;
    totalMinutes: number;
  };
  diffs: {
    manualOnly: Array<{ startAt: string; endAt: string }>;
    scheduledOnly: Array<{ startAt: string; endAt: string }>;
  };
};

export const parseTimestamptzMinute = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (!/([zZ]|[+-]\d{2}:\d{2})$/.test(trimmed)) return null;

  const parsed = DateTime.fromISO(trimmed, { setZone: true });
  if (!parsed.isValid) return null;
  if (parsed.second !== 0 || parsed.millisecond !== 0) return null;

  const utc = parsed.toUTC();
  const normalized = utc.toISO({ suppressMilliseconds: true });
  return normalized ?? null;
};

export const toEpochMinute = (isoUtc: string): number | null => {
  const ms = Date.parse(isoUtc);
  if (!Number.isFinite(ms)) return null;
  if (ms % 60000 !== 0) return null;
  return Math.floor(ms / 60000);
};

export const normalizeIntervals = (intervals: MinuteInterval[]): MinuteInterval[] => {
  if (!intervals.length) return [];
  const sorted = intervals
    .slice()
    .sort((a, b) => a.startMinute - b.startMinute || a.endMinute - b.endMinute);

  const merged: MinuteInterval[] = [];
  for (const interval of sorted) {
    if (!merged.length) {
      merged.push({ ...interval });
      continue;
    }

    const last = merged[merged.length - 1];
    if (interval.startMinute > last.endMinute) {
      merged.push({ ...interval });
      continue;
    }

    last.endMinute = Math.max(last.endMinute, interval.endMinute);
  }

  return merged;
};

export const intervalsEqual = (a: MinuteInterval[], b: MinuteInterval[]): boolean => {
  if (a.length !== b.length) return false;
  for (let idx = 0; idx < a.length; idx += 1) {
    if (a[idx].startMinute !== b[idx].startMinute) return false;
    if (a[idx].endMinute !== b[idx].endMinute) return false;
  }
  return true;
};

export const minutesToIso = (minute: number): string => new Date(minute * 60000).toISOString();

export const toUnionIntervals = (
  intervals: ScheduleSnapshotInterval[]
): { ok: true; union: MinuteInterval[] } | { ok: false; error: string } => {
  const minutes: MinuteInterval[] = [];

  for (const interval of intervals) {
    const startIso = parseTimestamptzMinute(interval.startAt);
    const endIso = parseTimestamptzMinute(interval.endAt);
    if (!startIso || !endIso) {
      return { ok: false, error: 'Intervals must be ISO timestamps with timezone offset, aligned to the minute' };
    }

    const startMinute = toEpochMinute(startIso);
    const endMinute = toEpochMinute(endIso);
    if (startMinute === null || endMinute === null || endMinute <= startMinute) {
      return { ok: false, error: 'Interval is invalid' };
    }

    minutes.push({ startMinute, endMinute });
  }

  return { ok: true, union: normalizeIntervals(minutes) };
};

const sumMinutes = (intervals: MinuteInterval[]): number =>
  intervals.reduce((acc, interval) => acc + (interval.endMinute - interval.startMinute), 0);

const subtractIntervals = (base: MinuteInterval[], subtract: MinuteInterval[]): MinuteInterval[] => {
  if (!base.length) return [];
  if (!subtract.length) return base.slice().map((i) => ({ ...i }));

  const result: MinuteInterval[] = [];
  let j = 0;

  for (const interval of base) {
    let cursor = interval.startMinute;

    while (j < subtract.length && subtract[j].endMinute <= cursor) {
      j += 1;
    }

    let k = j;
    while (k < subtract.length && subtract[k].startMinute < interval.endMinute) {
      const cut = subtract[k];

      if (cut.startMinute > cursor) {
        result.push({ startMinute: cursor, endMinute: Math.min(cut.startMinute, interval.endMinute) });
      }

      cursor = Math.max(cursor, cut.endMinute);
      if (cursor >= interval.endMinute) break;
      k += 1;
    }

    if (cursor < interval.endMinute) {
      result.push({ startMinute: cursor, endMinute: interval.endMinute });
    }
  }

  return result.filter((i) => i.endMinute > i.startMinute);
};

export const computeTimeEntryComparisonV1 = (params: {
  sessions: Array<{ startAt: string; endAt: string }>;
  snapshotIntervals: ScheduleSnapshotInterval[];
  computedAt?: string;
}): { ok: true; matches: boolean; comparison: TimeEntryComparisonV1 } | { ok: false; error: string } => {
  const scheduleUnionResult = toUnionIntervals(params.snapshotIntervals);
  if (!scheduleUnionResult.ok) return scheduleUnionResult;

  const manualIntervals: MinuteInterval[] = [];
  for (const session of params.sessions) {
    const startIso = parseTimestamptzMinute(session.startAt);
    const endIso = parseTimestamptzMinute(session.endAt);
    if (!startIso || !endIso) {
      return { ok: false, error: 'Sessions must be ISO timestamps with timezone offset, aligned to the minute' };
    }

    const startMinute = toEpochMinute(startIso);
    const endMinute = toEpochMinute(endIso);
    if (startMinute === null || endMinute === null || endMinute <= startMinute) {
      return { ok: false, error: 'Session interval is invalid' };
    }

    manualIntervals.push({ startMinute, endMinute });
  }

  const manualUnion = normalizeIntervals(manualIntervals);
  const scheduleUnion = scheduleUnionResult.union;
  const matches = intervalsEqual(manualUnion, scheduleUnion);

  const manualOnly = subtractIntervals(manualUnion, scheduleUnion);
  const scheduledOnly = subtractIntervals(scheduleUnion, manualUnion);

  const comparison: TimeEntryComparisonV1 = {
    version: 1,
    computedAt: params.computedAt ?? new Date().toISOString(),
    matches,
    exactMatch: matches,
    manual: {
      union: manualUnion.map((i) => ({ startAt: minutesToIso(i.startMinute), endAt: minutesToIso(i.endMinute) })),
      totalMinutes: sumMinutes(manualUnion)
    },
    scheduled: {
      union: scheduleUnion.map((i) => ({ startAt: minutesToIso(i.startMinute), endAt: minutesToIso(i.endMinute) })),
      totalMinutes: sumMinutes(scheduleUnion)
    },
    diffs: {
      manualOnly: manualOnly.map((i) => ({ startAt: minutesToIso(i.startMinute), endAt: minutesToIso(i.endMinute) })),
      scheduledOnly: scheduledOnly.map((i) => ({ startAt: minutesToIso(i.startMinute), endAt: minutesToIso(i.endMinute) }))
    }
  };

  return { ok: true, matches, comparison };
};

