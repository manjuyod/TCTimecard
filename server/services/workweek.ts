import { DateTime } from 'luxon';

export const computeSundayWeekStart = (localDate: DateTime): DateTime =>
  localDate.startOf('day').minus({ days: localDate.weekday % 7 });

export const computeWorkweekForDate = (localDate: DateTime): { weekStart: DateTime; weekEnd: DateTime } => {
  const weekStart = computeSundayWeekStart(localDate);
  const weekEnd = weekStart.plus({ days: 6 }).startOf('day');
  return { weekStart, weekEnd };
};

export const computeLastClosedWorkweek = (timezone: string): { weekStart: DateTime; weekEnd: DateTime } => {
  const nowLocal = DateTime.now().setZone(timezone);
  const currentWeekStart = computeSundayWeekStart(nowLocal);
  const weekEnd = currentWeekStart.minus({ days: 1 }).startOf('day');
  const weekStart = weekEnd.minus({ days: 6 }).startOf('day');
  return { weekStart, weekEnd };
};

