import { DateTime } from 'luxon';
import type { ScheduleSnapshotInterval } from './scheduleSnapshot';
import type { BreakStatus, PayTreatment } from './timeEntryBreaks';

export type TimeAllocationInterval = {
  startMinute: number;
  endMinute: number;
};

export type TimeAllocationBreak = {
  payTreatment: PayTreatment;
  status: BreakStatus;
  startTime?: string | Date | null;
  endTime?: string | Date | null;
  durationMinutes: number;
};

export type TimeAllocation = {
  matches: boolean;
  exactMatch: boolean;
  manual: {
    union: TimeAllocationInterval[];
    payableUnion: TimeAllocationInterval[];
    activeTutoringUnion: TimeAllocationInterval[];
    grossMinutes: number;
    paidBreakMinutes: number;
    unpaidBreakMinutes: number;
    paidMinutes: number;
  };
  scheduled: {
    union: TimeAllocationInterval[];
    totalMinutes: number;
    coveredMinutes: number;
    payableMinutes: number;
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
    manualOnly: TimeAllocationInterval[];
    scheduledOnly: TimeAllocationInterval[];
  };
};

const toEpochMinute = (value: string | Date | null | undefined): number | null => {
  if (!value) return null;
  if (typeof value === 'string' && !/([zZ]|[+-]\d{2}:\d{2})$/.test(value.trim())) return null;
  const parsed =
    value instanceof Date
      ? DateTime.fromJSDate(value, { zone: 'utc' })
      : DateTime.fromISO(value.trim(), { setZone: true });
  if (!parsed.isValid || parsed.second !== 0 || parsed.millisecond !== 0) return null;
  return Math.floor(parsed.toUTC().toMillis() / 60000);
};

export const normalizeAllocationIntervals = (
  intervals: TimeAllocationInterval[]
): TimeAllocationInterval[] => {
  const sorted = intervals
    .filter((interval) => interval.endMinute > interval.startMinute)
    .slice()
    .sort((a, b) => a.startMinute - b.startMinute || a.endMinute - b.endMinute);

  const merged: TimeAllocationInterval[] = [];
  for (const interval of sorted) {
    const previous = merged[merged.length - 1];
    if (!previous || interval.startMinute > previous.endMinute) {
      merged.push({ ...interval });
      continue;
    }
    previous.endMinute = Math.max(previous.endMinute, interval.endMinute);
  }
  return merged;
};

export const sumAllocationMinutes = (intervals: TimeAllocationInterval[]): number =>
  intervals.reduce((total, interval) => total + interval.endMinute - interval.startMinute, 0);

export const intersectAllocationIntervals = (
  left: TimeAllocationInterval[],
  right: TimeAllocationInterval[]
): TimeAllocationInterval[] => {
  const a = normalizeAllocationIntervals(left);
  const b = normalizeAllocationIntervals(right);
  const result: TimeAllocationInterval[] = [];
  let leftIndex = 0;
  let rightIndex = 0;

  while (leftIndex < a.length && rightIndex < b.length) {
    const startMinute = Math.max(a[leftIndex].startMinute, b[rightIndex].startMinute);
    const endMinute = Math.min(a[leftIndex].endMinute, b[rightIndex].endMinute);
    if (endMinute > startMinute) result.push({ startMinute, endMinute });

    if (a[leftIndex].endMinute <= b[rightIndex].endMinute) {
      leftIndex += 1;
    } else {
      rightIndex += 1;
    }
  }

  return result;
};

export const subtractAllocationIntervals = (
  base: TimeAllocationInterval[],
  cuts: TimeAllocationInterval[]
): TimeAllocationInterval[] => {
  const normalizedBase = normalizeAllocationIntervals(base);
  const normalizedCuts = normalizeAllocationIntervals(cuts);
  if (!normalizedCuts.length) return normalizedBase.map((interval) => ({ ...interval }));

  const result: TimeAllocationInterval[] = [];
  let cutIndex = 0;

  for (const interval of normalizedBase) {
    let cursor = interval.startMinute;
    while (cutIndex < normalizedCuts.length && normalizedCuts[cutIndex].endMinute <= cursor) {
      cutIndex += 1;
    }

    let currentCutIndex = cutIndex;
    while (
      currentCutIndex < normalizedCuts.length &&
      normalizedCuts[currentCutIndex].startMinute < interval.endMinute
    ) {
      const cut = normalizedCuts[currentCutIndex];
      if (cut.startMinute > cursor) {
        result.push({
          startMinute: cursor,
          endMinute: Math.min(cut.startMinute, interval.endMinute)
        });
      }
      cursor = Math.max(cursor, cut.endMinute);
      if (cursor >= interval.endMinute) break;
      currentCutIndex += 1;
    }

    if (cursor < interval.endMinute) {
      result.push({ startMinute: cursor, endMinute: interval.endMinute });
    }
  }

  return result;
};

const intervalsEqual = (
  left: TimeAllocationInterval[],
  right: TimeAllocationInterval[]
): boolean =>
  left.length === right.length &&
  left.every(
    (interval, index) =>
      interval.startMinute === right[index].startMinute &&
      interval.endMinute === right[index].endMinute
  );

const parseIntervals = (
  intervals: Array<{ startAt: string | Date; endAt: string | Date }>,
  label: string
): { ok: true; union: TimeAllocationInterval[] } | { ok: false; error: string } => {
  const parsed: TimeAllocationInterval[] = [];
  for (const interval of intervals) {
    const startMinute = toEpochMinute(interval.startAt);
    const endMinute = toEpochMinute(interval.endAt);
    if (startMinute === null || endMinute === null) {
      return {
        ok: false,
        error: `${label} must be ISO timestamps with timezone offsets, aligned to the minute`
      };
    }
    if (endMinute <= startMinute) {
      return { ok: false, error: `${label} interval is invalid` };
    }
    parsed.push({ startMinute, endMinute });
  }
  return { ok: true, union: normalizeAllocationIntervals(parsed) };
};

export const computeTimeAllocation = (params: {
  sessions: Array<{ startAt: string | Date; endAt: string | Date }>;
  scheduleIntervals: ScheduleSnapshotInterval[];
  breaks?: TimeAllocationBreak[];
}): { ok: true; allocation: TimeAllocation } | { ok: false; error: string } => {
  const manualResult = parseIntervals(params.sessions, 'Sessions');
  if (!manualResult.ok) return manualResult;
  const scheduleResult = parseIntervals(params.scheduleIntervals, 'Schedule intervals');
  if (!scheduleResult.ok) return scheduleResult;

  const manualUnion = manualResult.union;
  const scheduleUnion = scheduleResult.union;
  const paidBreakIntervals: TimeAllocationInterval[] = [];
  const unpaidBreakIntervals: TimeAllocationInterval[] = [];
  let unpositionedMinutes = 0;

  for (const item of params.breaks ?? []) {
    if (item.status !== 'completed') continue;

    const startMinute = toEpochMinute(item.startTime);
    const endMinute = toEpochMinute(item.endTime);
    if (startMinute === null || endMinute === null || endMinute <= startMinute) {
      const storedDuration = Number(item.durationMinutes);
      if (Number.isFinite(storedDuration) && storedDuration > 0) {
        unpositionedMinutes += storedDuration;
      }
      continue;
    }

    const target = item.payTreatment === 'paid' ? paidBreakIntervals : unpaidBreakIntervals;
    target.push({ startMinute, endMinute });
  }

  const unpaidBreakUnion = normalizeAllocationIntervals(unpaidBreakIntervals);
  const paidBreakUnion = normalizeAllocationIntervals(paidBreakIntervals);
  const paidOnlyBreakUnion = subtractAllocationIntervals(paidBreakUnion, unpaidBreakUnion);
  const allBreakUnion = normalizeAllocationIntervals([...unpaidBreakUnion, ...paidBreakUnion]);
  const inSessionBreakUnion = intersectAllocationIntervals(allBreakUnion, manualUnion);
  const inSessionUnpaidBreakUnion = intersectAllocationIntervals(unpaidBreakUnion, manualUnion);
  const inSessionPaidBreakUnion = intersectAllocationIntervals(paidOnlyBreakUnion, manualUnion);
  const scheduledBreakUnion = intersectAllocationIntervals(inSessionBreakUnion, scheduleUnion);
  const outsideScheduleBreakUnion = subtractAllocationIntervals(inSessionBreakUnion, scheduleUnion);
  const outsideSessionBreakUnion = subtractAllocationIntervals(allBreakUnion, manualUnion);

  const activeTutoringUnion = subtractAllocationIntervals(manualUnion, inSessionBreakUnion);
  const payableUnion = subtractAllocationIntervals(manualUnion, inSessionUnpaidBreakUnion);
  const coveredUnion = intersectAllocationIntervals(activeTutoringUnion, scheduleUnion);
  const payableScheduledUnion = intersectAllocationIntervals(payableUnion, scheduleUnion);
  const manualOnly = subtractAllocationIntervals(payableUnion, scheduleUnion);
  const scheduledOnly = subtractAllocationIntervals(scheduleUnion, activeTutoringUnion);

  const scheduledMinutes = sumAllocationMinutes(scheduleUnion);
  const coveredMinutes = sumAllocationMinutes(coveredUnion);
  const paidMinutes = sumAllocationMinutes(payableUnion);
  const payableScheduledMinutes = sumAllocationMinutes(payableScheduledUnion);
  const deficitMinutes = Math.max(0, scheduledMinutes - coveredMinutes);
  const extraPaidMinutes = Math.max(0, paidMinutes - payableScheduledMinutes);

  const allocation: TimeAllocation = {
    matches: deficitMinutes === 0 && extraPaidMinutes === 0,
    exactMatch: intervalsEqual(manualUnion, scheduleUnion),
    manual: {
      union: manualUnion,
      payableUnion,
      activeTutoringUnion,
      grossMinutes: sumAllocationMinutes(manualUnion),
      paidBreakMinutes: sumAllocationMinutes(inSessionPaidBreakUnion),
      unpaidBreakMinutes: sumAllocationMinutes(inSessionUnpaidBreakUnion),
      paidMinutes
    },
    scheduled: {
      union: scheduleUnion,
      totalMinutes: scheduledMinutes,
      coveredMinutes,
      payableMinutes: payableScheduledMinutes,
      deficitMinutes,
      deltaMinutes: coveredMinutes - scheduledMinutes
    },
    extra: {
      paidMinutes: extraPaidMinutes
    },
    breaks: {
      scheduledOverlapMinutes: sumAllocationMinutes(scheduledBreakUnion),
      outsideScheduleMinutes: sumAllocationMinutes(outsideScheduleBreakUnion),
      outsideSessionMinutes: sumAllocationMinutes(outsideSessionBreakUnion),
      unpositionedMinutes
    },
    diffs: {
      manualOnly,
      scheduledOnly
    }
  };

  return { ok: true, allocation };
};
