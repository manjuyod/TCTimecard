import { DateTime } from 'luxon';
import type { ScheduleSnapshotInterval } from './scheduleSnapshot';
import type { BreakStatus, PayTreatment } from './timeEntryBreaks';
import { computeTimeAllocation } from './timeAllocation';

export type MinuteInterval = { startMinute: number; endMinute: number };

export type TimeEntryComparisonV1 = {
  version: 1;
  computedAt: string;
  matches: boolean;
  exactMatch: boolean;
  manual: {
    union: Array<{ startAt: string; endAt: string }>;
    grossMinutes: number;
    paidBreakMinutes: number;
    unpaidBreakMinutes: number;
    paidMinutes: number;
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

export type TimeEntryComparisonV2 = {
  version: 2;
  computedAt: string;
  matches: boolean;
  exactMatch: boolean;
  manual: {
    union: Array<{ startAt: string; endAt: string }>;
    grossMinutes: number;
    paidBreakMinutes: number;
    unpaidBreakMinutes: number;
    paidMinutes: number;
    totalMinutes: number;
  };
  scheduled: {
    union: Array<{ startAt: string; endAt: string }>;
    totalMinutes: number;
    coveredMinutes: number;
    deficitMinutes: number;
    deltaMinutes: number;
  };
  extra: {
    paidMinutes: number;
  };
  breaks: {
    scheduledOverlapMinutes: number;
    outsideScheduleMinutes: number;
    outsideSessionMinutes: number;
    unpositionedMinutes: number;
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

export const computeTimeEntryComparisonV2 = (params: {
  sessions: Array<{ startAt: string | Date; endAt: string | Date }>;
  breaks?: Array<{
    payTreatment: PayTreatment;
    status: BreakStatus;
    startTime?: string | Date | null;
    endTime?: string | Date | null;
    durationMinutes: number;
  }>;
  snapshotIntervals: ScheduleSnapshotInterval[];
  computedAt?: string;
}): { ok: true; matches: boolean; comparison: TimeEntryComparisonV2 } | { ok: false; error: string } => {
  const result = computeTimeAllocation({
    sessions: params.sessions,
    breaks: params.breaks,
    scheduleIntervals: params.snapshotIntervals
  });
  if (!result.ok) return result;

  const { allocation } = result;
  const toIsoIntervals = (intervals: MinuteInterval[]) =>
    intervals.map((interval) => ({
      startAt: minutesToIso(interval.startMinute),
      endAt: minutesToIso(interval.endMinute)
    }));

  const comparison: TimeEntryComparisonV2 = {
    version: 2,
    computedAt: params.computedAt ?? new Date().toISOString(),
    matches: allocation.matches,
    exactMatch: allocation.exactMatch,
    manual: {
      union: toIsoIntervals(allocation.manual.union),
      grossMinutes: allocation.manual.grossMinutes,
      paidBreakMinutes: allocation.manual.paidBreakMinutes,
      unpaidBreakMinutes: allocation.manual.unpaidBreakMinutes,
      paidMinutes: allocation.manual.paidMinutes,
      totalMinutes: allocation.manual.paidMinutes
    },
    scheduled: {
      union: toIsoIntervals(allocation.scheduled.union),
      totalMinutes: allocation.scheduled.totalMinutes,
      coveredMinutes: allocation.scheduled.coveredMinutes,
      deficitMinutes: allocation.scheduled.deficitMinutes,
      deltaMinutes: allocation.scheduled.deltaMinutes
    },
    extra: {
      paidMinutes: allocation.extra.paidMinutes
    },
    breaks: {
      scheduledOverlapMinutes: allocation.breaks.scheduledOverlapMinutes,
      outsideScheduleMinutes: allocation.breaks.outsideScheduleMinutes,
      outsideSessionMinutes: allocation.breaks.outsideSessionMinutes,
      unpositionedMinutes: allocation.breaks.unpositionedMinutes
    },
    diffs: {
      manualOnly: toIsoIntervals(allocation.diffs.manualOnly),
      scheduledOnly: toIsoIntervals(allocation.diffs.scheduledOnly)
    }
  };

  return { ok: true, matches: allocation.matches, comparison };
};
