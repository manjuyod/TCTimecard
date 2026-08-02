export type ParsedTimeEntryComparison = {
  version: 1 | 2;
  scheduledMinutes: number;
  coveredMinutes: number;
  deltaMinutes: number;
  payableExtraMinutes: number;
  matches: boolean | null;
  scheduledBreakOverlapMinutes: number;
  outsideSessionMinutes: number;
  unpositionedMinutes: number;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const finiteNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const intervalMinutes = (value: unknown): number => {
  if (!Array.isArray(value)) return 0;
  return value.reduce((total, item) => {
    const interval = asRecord(item);
    if (!interval || typeof interval.startAt !== 'string' || typeof interval.endAt !== 'string') {
      return total;
    }
    const start = Date.parse(interval.startAt);
    const end = Date.parse(interval.endAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return total;
    return total + Math.round((end - start) / 60000);
  }, 0);
};

export const parseTimeEntryComparison = (value: unknown): ParsedTimeEntryComparison | null => {
  const comparison = asRecord(value);
  if (!comparison) return null;

  const scheduled = asRecord(comparison.scheduled);
  const scheduledMinutes = finiteNumber(scheduled?.totalMinutes);
  if (scheduledMinutes === null) return null;

  const matches = typeof comparison.matches === 'boolean' ? comparison.matches : null;
  if (comparison.version === 2) {
    const coveredMinutes = finiteNumber(scheduled?.coveredMinutes);
    const deltaMinutes = finiteNumber(scheduled?.deltaMinutes);
    const extra = asRecord(comparison.extra);
    const breaks = asRecord(comparison.breaks);
    const payableExtraMinutes = finiteNumber(extra?.paidMinutes);
    if (coveredMinutes === null || deltaMinutes === null || payableExtraMinutes === null) return null;

    return {
      version: 2,
      scheduledMinutes,
      coveredMinutes,
      deltaMinutes,
      payableExtraMinutes,
      matches,
      scheduledBreakOverlapMinutes: finiteNumber(breaks?.scheduledOverlapMinutes) ?? 0,
      outsideSessionMinutes: finiteNumber(breaks?.outsideSessionMinutes) ?? 0,
      unpositionedMinutes: finiteNumber(breaks?.unpositionedMinutes) ?? 0
    };
  }

  const manual = asRecord(comparison.manual);
  const manualMinutes = finiteNumber(manual?.totalMinutes);
  if (manualMinutes === null) return null;

  const diffs = asRecord(comparison.diffs);
  const hasScheduledOnly = Array.isArray(diffs?.scheduledOnly);
  const coveredMinutes = hasScheduledOnly
    ? Math.max(0, scheduledMinutes - intervalMinutes(diffs?.scheduledOnly))
    : Math.min(manualMinutes, scheduledMinutes);
  const payableExtraMinutes = Math.max(0, manualMinutes - coveredMinutes);

  return {
    version: 1,
    scheduledMinutes,
    coveredMinutes,
    deltaMinutes: coveredMinutes - scheduledMinutes,
    payableExtraMinutes,
    matches,
    scheduledBreakOverlapMinutes: 0,
    outsideSessionMinutes: 0,
    unpositionedMinutes: 0
  };
};
