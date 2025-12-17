import { DateTime } from 'luxon';

export const minutesToHoursDecimal = (minutes: number): number => minutes / 60;

export const roundHours2 = (hours: number): number => Math.round(hours * 100) / 100;

export const parseMonthParam = (value: unknown): { month: string | null; isValid: boolean } => {
  if (value === undefined || value === null || value === '') return { month: null, isValid: true };
  if (typeof value !== 'string') return { month: null, isValid: false };

  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}$/.test(trimmed)) {
    return { month: null, isValid: false };
  }

  return { month: trimmed, isValid: true };
};

export const computeIsoWeekRange = (
  timezone: string
): { startLocal: DateTime; startOfNextWeekLocal: DateTime; endLocal: DateTime } => {
  const now = DateTime.now().setZone(timezone);
  const startLocal = now.startOf('day').minus({ days: now.weekday - 1 });
  const startOfNextWeekLocal = startLocal.plus({ days: 7 });
  const endLocal = startOfNextWeekLocal.minus({ days: 1 });

  return { startLocal, startOfNextWeekLocal, endLocal };
};

export const computeMonthRange = (
  timezone: string,
  month: string | null
): { month: string; startLocal: DateTime; nextMonthStartLocal: DateTime; endLocal: DateTime } => {
  const base = month
    ? DateTime.fromISO(`${month}-01`, { zone: timezone, setZone: true })
    : DateTime.now().setZone(timezone).startOf('month');

  const startLocal = base.startOf('month').startOf('day');
  const nextMonthStartLocal = startLocal.plus({ months: 1 });
  const endLocal = nextMonthStartLocal.minus({ days: 1 });
  const monthLabel = startLocal.toFormat('yyyy-LL');

  return { month: monthLabel, startLocal, nextMonthStartLocal, endLocal };
};
