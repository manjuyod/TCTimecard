import { DateTime } from 'luxon';
import type { ScheduleSnapshotInterval } from './scheduleSnapshot';

export type ClockInTimeSnapResolution = {
  detectedAt: string;
  startAt: string;
  timeSnapApplied: boolean;
  matchedScheduledStartAt: string | null;
};

export const resolveClockInStartAt = (params: {
  detectedAt: Date;
  timezone: string;
  workDate: string;
  enabled: boolean;
  intervals: ScheduleSnapshotInterval[];
}): ClockInTimeSnapResolution => {
  const detectedMinute = DateTime.fromJSDate(params.detectedAt, { zone: 'utc' }).startOf('minute');
  if (!detectedMinute.isValid) {
    throw new Error('Clock-in detection time is invalid');
  }

  const detectedAt = detectedMinute.toUTC().toISO();
  if (!detectedAt) {
    throw new Error('Clock-in detection time could not be serialized');
  }

  if (!params.enabled) {
    return {
      detectedAt,
      startAt: detectedAt,
      timeSnapApplied: false,
      matchedScheduledStartAt: null
    };
  }

  const eligibleStarts = params.intervals
    .map((interval) => DateTime.fromISO(interval.startAt, { setZone: true }).setZone(params.timezone))
    .filter((start) =>
      start.isValid &&
      start.toISODate() === params.workDate &&
      start.minute === 0 &&
      start.second === 0 &&
      start.millisecond === 0
    )
    .filter((start) => {
      const differenceMinutes = detectedMinute.diff(start.toUTC(), 'minutes').minutes;
      return differenceMinutes >= -8 && differenceMinutes <= 2;
    })
    .sort((left, right) => {
      const leftDistance = Math.abs(detectedMinute.toMillis() - left.toUTC().toMillis());
      const rightDistance = Math.abs(detectedMinute.toMillis() - right.toUTC().toMillis());
      return leftDistance - rightDistance || left.toMillis() - right.toMillis();
    });

  const matched = eligibleStarts[0]?.toUTC().toISO() ?? null;
  return {
    detectedAt,
    startAt: matched ?? detectedAt,
    timeSnapApplied: matched !== null,
    matchedScheduledStartAt: matched
  };
};
