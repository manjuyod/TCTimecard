import { DateTime } from 'luxon';

export type ClockInTimeSnapResolution = {
  detectedAt: string;
  startAt: string;
  timeSnapApplied: boolean;
  snapTargetAt: string | null;
};

export const resolveClockInStartAt = (params: {
  detectedAt: Date;
  enabled: boolean;
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
      snapTargetAt: null
    };
  }

  const minutesAfterQuarter = detectedMinute.minute % 15;
  const snappedMinute = minutesAfterQuarter <= 7
    ? detectedMinute.minus({ minutes: minutesAfterQuarter })
    : detectedMinute.plus({ minutes: 15 - minutesAfterQuarter });
  const snappedAt = snappedMinute.toUTC().toISO();
  if (!snappedAt) {
    throw new Error('Clock-in snap target could not be serialized');
  }
  const timeSnapApplied = snappedAt !== detectedAt;

  return {
    detectedAt,
    startAt: snappedAt,
    timeSnapApplied,
    snapTargetAt: timeSnapApplied ? snappedAt : null
  };
};
