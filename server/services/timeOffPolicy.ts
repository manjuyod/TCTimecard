import { DateTime } from 'luxon';
import {
  NormalizedTimeOffSubmission,
  TimeOffPolicy,
  TimeOffSubmissionInput,
  TimeOffType
} from '../types/timeoff';

const NOTICE_DAYS = 14 as const;
const ALLOWED_TYPES: TimeOffType[] = ['pto', 'sick', 'emergency', 'unpaid', 'other'];
const EXEMPT_TYPES: Array<'sick' | 'emergency'> = ['sick', 'emergency'];
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^\d{2}:\d{2}$/;

export interface TimeOffPolicyOptions {
  timezone: string;
  nowIso?: string;
  maxDurationHours: number;
}

export type TimeOffValidationResult =
  | { valid: true; errors: []; value: NormalizedTimeOffSubmission }
  | { valid: false; errors: string[]; value?: undefined };

export function buildTimeOffPolicy(options: TimeOffPolicyOptions): TimeOffPolicy {
  const today = currentLocalDate(options);
  return {
    timezone: options.timezone,
    today: today.toISODate() as string,
    minimumStartDate: today.plus({ days: NOTICE_DAYS }).toISODate() as string,
    noticeDays: NOTICE_DAYS,
    exemptTypes: [...EXEMPT_TYPES],
    allowedTypes: [...ALLOWED_TYPES],
    maxDurationHours: options.maxDurationHours
  };
}

export function normalizeTimeOffSubmission(
  input: TimeOffSubmissionInput,
  options: TimeOffPolicyOptions
): TimeOffValidationResult {
  const errors: string[] = [];
  const startDate = stringValue(input.startDate);
  const endDate = stringValue(input.endDate || input.startDate);
  const partialDay = booleanValue(input.partialDay);
  const leaveTime = optionalString(input.leaveTime);
  const returnTime = optionalString(input.returnTime);
  const type = normalizeType(input.type);
  const reason = stringValue(input.reason);

  if (!validDate(startDate, options.timezone)) errors.push('Start date is required.');
  if (!validDate(endDate, options.timezone)) errors.push('End date is required.');
  if (!type) errors.push('Type must be one of pto, sick, emergency, unpaid, other.');
  if (reason.length < 10) errors.push('Reason must be at least 10 characters.');
  if (reason.length > 2000) errors.push('Reason must be 2000 characters or fewer.');
  if (partialDay) {
    if (!leaveTime || !TIME_PATTERN.test(leaveTime)) errors.push('Leave time is required for partial-day requests.');
    if (!returnTime || !TIME_PATTERN.test(returnTime)) errors.push('Return time is required for partial-day requests.');
  }
  if (errors.length > 0 || !type) return { valid: false, errors };

  const startLocalDate = DateTime.fromISO(startDate, { zone: options.timezone }).startOf('day');
  const endLocalDate = DateTime.fromISO(endDate, { zone: options.timezone }).startOf('day');
  if (endLocalDate < startLocalDate) {
    return { valid: false, errors: ['End date cannot be before start date.'] };
  }

  const today = currentLocalDate(options);
  if (startLocalDate < today) {
    return { valid: false, errors: ['Start date cannot be in the past.'] };
  }
  if (!EXEMPT_TYPES.includes(type as 'sick' | 'emergency') && startLocalDate < today.plus({ days: NOTICE_DAYS })) {
    return { valid: false, errors: ['Non-sick and non-emergency requests must be submitted at least 14 days before the start date.'] };
  }

  const range = partialDay
    ? normalizePartialRange(startDate, endDate, leaveTime as string, returnTime as string, options.timezone)
    : {
        start: startLocalDate,
        end: endLocalDate.plus({ days: 1 })
      };
  if (!range.start.isValid || !range.end.isValid || range.end <= range.start) {
    return { valid: false, errors: ['Request date or time range is invalid.'] };
  }

  const durationHours = range.end.diff(range.start, 'hours').hours;
  if (durationHours > options.maxDurationHours) {
    return { valid: false, errors: [`Request duration cannot exceed ${options.maxDurationHours} hours.`] };
  }

  const mapping = storageMapping(type);
  return {
    valid: true,
    errors: [],
    value: {
      startDate,
      endDate,
      startAt: range.start.toUTC().toISO({ suppressMilliseconds: false }) as string,
      endAt: range.end.toUTC().toISO({ suppressMilliseconds: false }) as string,
      partialDay,
      leaveTime: partialDay ? leaveTime : null,
      returnTime: partialDay ? returnTime : null,
      type,
      storageType: mapping.storageType,
      absenceLabel: mapping.absenceLabel,
      reason,
      durationHours
    }
  };
}

function currentLocalDate(options: TimeOffPolicyOptions): DateTime {
  const now = options.nowIso
    ? DateTime.fromISO(options.nowIso, { setZone: true }).setZone(options.timezone)
    : DateTime.now().setZone(options.timezone);
  return now.startOf('day');
}

function normalizePartialRange(
  startDate: string,
  endDate: string,
  leaveTime: string,
  returnTime: string,
  timezone: string
): { start: DateTime; end: DateTime } {
  const start = DateTime.fromISO(`${startDate}T${leaveTime}`, { zone: timezone });
  let end = DateTime.fromISO(`${endDate}T${returnTime}`, { zone: timezone });
  if (end <= start && startDate === endDate) end = end.plus({ days: 1 });
  return { start, end };
}

function storageMapping(type: TimeOffType): { storageType: NormalizedTimeOffSubmission['storageType']; absenceLabel: string } {
  switch (type) {
    case 'pto':
      return { storageType: 'pto', absenceLabel: 'Paid Time Off' };
    case 'sick':
      return { storageType: 'sick', absenceLabel: 'Sick Leave' };
    case 'emergency':
      return { storageType: 'other', absenceLabel: 'Emergency' };
    case 'unpaid':
      return { storageType: 'unpaid', absenceLabel: 'Unpaid Time Off' };
    default:
      return { storageType: 'other', absenceLabel: 'Other' };
  }
}

function normalizeType(value: unknown): TimeOffType | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase() as TimeOffType;
  return ALLOWED_TYPES.includes(normalized) ? normalized : null;
}

function validDate(value: string, timezone: string): boolean {
  return DATE_PATTERN.test(value) && DateTime.fromISO(value, { zone: timezone }).isValid;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function optionalString(value: unknown): string | null {
  const valueString = stringValue(value);
  return valueString || null;
}

function booleanValue(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  return typeof value === 'string' && ['true', '1', 'yes', 'on'].includes(value.trim().toLowerCase());
}
