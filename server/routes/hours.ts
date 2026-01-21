import express, { NextFunction, Request, Response } from 'express';
import { DateTime } from 'luxon';
import { getMssqlPool, sql } from '../db/mssql';
import { getPostgresPool } from '../db/postgres';
import { requireAdmin, requireTutor } from '../middleware/auth';
import { enforceFranchiseScope } from '../middleware/franchiseScope';
import { computeIsoWeekRange, computeMonthRange, parseMonthParam, roundHours2 } from '../payroll/hoursUtils';
import { localDateRangeToUtcBounds, resolvePayPeriod, type PayPeriod } from '../payroll/payPeriodResolution';
import {
  deriveIntervalsFromEntries,
  getScheduleSlotMinutes,
  getScheduleSnapshotSigningSecret,
  signScheduleSnapshot,
  type ScheduleSnapshotEntry,
  type ScheduleSnapshotV1
} from '../services/scheduleSnapshot';

const router = express.Router();

const CALENDAR_MONTH_SQL = `
DECLARE @MonthStart DATE = @p_month_start;
DECLARE @NextMonthStart DATE = @p_next_month_start;

SELECT
    s.ScheduleDate,
    s.TimeID,
    t.Time AS TimeLabel
FROM dbo.tblSessionSchedule s
JOIN dbo.tblTimes t ON s.TimeID = t.ID
WHERE s.TutorID = @p_tutor_id
  AND s.ScheduleDate >= @MonthStart
  AND s.ScheduleDate <  @NextMonthStart
GROUP BY s.ScheduleDate, s.TimeID, t.Time
ORDER BY s.ScheduleDate ASC, s.TimeID ASC;
`;

const TUTOR_NAMES_BY_IDS_TEMPLATE = `
SELECT
  t.ID AS TutorID,
  t.FirstName,
  t.LastName
FROM dbo.tblTutors t
WHERE t.ID IN (@p_id_list)
  AND t.FirstName <> 'Overflow';
`;

const missingFranchise = (res: Response) => res.status(400).json({ error: 'franchiseId is required for tutor requests' });
const invalidMonth = (res: Response) => res.status(400).json({ error: 'month must be YYYY-MM' });
const invalidForDate = (res: Response) => res.status(400).json({ error: 'forDate must be YYYY-MM-DD' });
const invalidWorkDate = (res: Response) => res.status(400).json({ error: 'workDate must be YYYY-MM-DD' });

type MinuteInterval = { startMinute: number; endMinute: number };

type ApprovedEntryDayRow = {
  id: number;
  tutorid: number;
  schedule_snapshot: unknown | null;
};

type ApprovedEntrySessionRow = {
  entry_day_id: number;
  start_at: unknown;
  end_at: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const extractForDateParam = (value: unknown): { dateISO: string | null; isValid: boolean } => {
  if (value === undefined || value === null || value === '') return { dateISO: null, isValid: true };
  if (typeof value !== 'string') return { dateISO: null, isValid: false };

  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return { dateISO: null, isValid: false };
  }

  const dt = DateTime.fromISO(trimmed, { zone: 'UTC' });
  if (!dt.isValid || dt.toISODate() !== trimmed) {
    return { dateISO: null, isValid: false };
  }

  return { dateISO: trimmed, isValid: true };
};

const parseIsoDateOnly = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const dt = DateTime.fromISO(trimmed, { zone: 'UTC', setZone: true });
  if (!dt.isValid) return null;

  return dt.toISODate() ?? null;
};

const toNumber = (value: unknown): number => {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
};

const toEpochMinuteFromDateish = (value: unknown): number | null => {
  const ms = new Date(value as never).getTime();
  if (!Number.isFinite(ms)) return null;
  if (ms % 60000 !== 0) return null;
  return Math.floor(ms / 60000);
};

const normalizeIntervals = (intervals: MinuteInterval[]): MinuteInterval[] => {
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

const sumIntervalMinutes = (intervals: MinuteInterval[]): number =>
  intervals.reduce((acc, interval) => acc + (interval.endMinute - interval.startMinute), 0);

const overlapMinutes = (a: MinuteInterval[], b: MinuteInterval[]): number => {
  let i = 0;
  let j = 0;
  let total = 0;

  while (i < a.length && j < b.length) {
    const start = Math.max(a[i].startMinute, b[j].startMinute);
    const end = Math.min(a[i].endMinute, b[j].endMinute);
    if (end > start) {
      total += end - start;
    }

    if (a[i].endMinute < b[j].endMinute) {
      i += 1;
    } else {
      j += 1;
    }
  }

  return total;
};

const parseScheduleUnionFromSnapshot = (value: unknown): MinuteInterval[] => {
  if (!isRecord(value)) return [];
  if (value.version !== 1) return [];

  const intervalsRaw = value.intervals;
  if (!Array.isArray(intervalsRaw)) return [];

  const intervals: MinuteInterval[] = [];
  for (const raw of intervalsRaw) {
    if (!isRecord(raw)) continue;
    const startAt = typeof raw.startAt === 'string' ? raw.startAt : '';
    const endAt = typeof raw.endAt === 'string' ? raw.endAt : '';

    const startMinute = toEpochMinuteFromDateish(startAt);
    const endMinute = toEpochMinuteFromDateish(endAt);

    if (startMinute === null || endMinute === null || endMinute <= startMinute) continue;
    intervals.push({ startMinute, endMinute });
  }

  return normalizeIntervals(intervals);
};

const sessionsToManualUnion = (sessions: ApprovedEntrySessionRow[]): MinuteInterval[] => {
  const intervals: MinuteInterval[] = [];
  for (const session of sessions) {
    const startMinute = toEpochMinuteFromDateish(session.start_at);
    const endMinute = toEpochMinuteFromDateish(session.end_at);
    if (startMinute === null || endMinute === null || endMinute <= startMinute) continue;
    intervals.push({ startMinute, endMinute });
  }

  return normalizeIntervals(intervals);
};

const getTutorContext = (req: Request): { tutorId: number; franchiseId: number } | null => {
  const auth = req.session.auth;
  if (!auth) return null;

  const tutorId = Number(auth.accountId);
  const franchiseId =
    auth.franchiseId !== null && auth.franchiseId !== undefined ? Number(auth.franchiseId) : Number.NaN;

  if (!Number.isFinite(tutorId) || !Number.isFinite(franchiseId)) {
    return null;
  }

  return { tutorId, franchiseId };
};

const resolveTimezone = async (franchiseId: number): Promise<string> => {
  const payPeriod = await resolvePayPeriod(franchiseId, null);
  return payPeriod.timezone;
};

const computeEndDateExclusive = (payPeriod: PayPeriod): string => {
  const endLocal = DateTime.fromISO(payPeriod.endDate, { zone: payPeriod.timezone, setZone: true }).startOf('day');
  const endExclusive = endLocal.plus({ days: 1 });
  return endExclusive.toISODate() || payPeriod.endDate;
};

const fetchApprovedDaysForTutor = async (
  franchiseId: number,
  tutorId: number,
  startDateISO: string,
  endDateISO: string
): Promise<ApprovedEntryDayRow[]> => {
  const pool = getPostgresPool();
  const result = await pool.query<ApprovedEntryDayRow>(
    `
      SELECT id, tutorid, schedule_snapshot
      FROM public.time_entry_days
      WHERE franchiseid = $1
        AND tutorid = $2
        AND status = 'approved'
        AND work_date >= $3
        AND work_date <= $4
      ORDER BY work_date ASC, id ASC
    `,
    [franchiseId, tutorId, startDateISO, endDateISO]
  );

  return result.rows ?? [];
};

const fetchApprovedDaysForFranchise = async (
  franchiseId: number,
  startDateISO: string,
  endDateISO: string
): Promise<ApprovedEntryDayRow[]> => {
  const pool = getPostgresPool();
  const result = await pool.query<ApprovedEntryDayRow>(
    `
      SELECT id, tutorid, schedule_snapshot
      FROM public.time_entry_days
      WHERE franchiseid = $1
        AND status = 'approved'
        AND work_date >= $2
        AND work_date <= $3
      ORDER BY tutorid ASC, work_date ASC, id ASC
    `,
    [franchiseId, startDateISO, endDateISO]
  );

  return result.rows ?? [];
};

const fetchSessionsByDayIds = async (dayIds: number[]): Promise<Map<number, ApprovedEntrySessionRow[]>> => {
  const sessionsByDay = new Map<number, ApprovedEntrySessionRow[]>();
  if (!dayIds.length) return sessionsByDay;

  const pool = getPostgresPool();
  const result = await pool.query<ApprovedEntrySessionRow>(
    `
      SELECT entry_day_id, start_at, end_at
      FROM public.time_entry_sessions
      WHERE entry_day_id = ANY($1::int[])
      ORDER BY entry_day_id ASC, start_at ASC
    `,
    [dayIds]
  );

  for (const row of result.rows ?? []) {
    const list = sessionsByDay.get(row.entry_day_id) ?? [];
    list.push(row);
    sessionsByDay.set(row.entry_day_id, list);
  }

  return sessionsByDay;
};

const computeRollupTotalsForDays = (
  days: ApprovedEntryDayRow[],
  sessionsByDay: Map<number, ApprovedEntrySessionRow[]>
): { tutoringMinutes: number; extraMinutes: number; totalMinutes: number } => {
  let tutoringMinutes = 0;
  let extraMinutes = 0;
  let totalMinutes = 0;

  for (const day of days) {
    const sessions = sessionsByDay.get(day.id) ?? [];
    const manualUnion = sessionsToManualUnion(sessions);
    const manualMinutes = sumIntervalMinutes(manualUnion);

    const scheduleUnion = day.schedule_snapshot ? parseScheduleUnionFromSnapshot(day.schedule_snapshot) : [];
    const withinScheduledMinutes = scheduleUnion.length ? overlapMinutes(manualUnion, scheduleUnion) : 0;
    const outsideScheduledMinutes = Math.max(0, manualMinutes - withinScheduledMinutes);

    tutoringMinutes += withinScheduledMinutes;
    extraMinutes += outsideScheduledMinutes;
    totalMinutes += manualMinutes;
  }

  return { tutoringMinutes, extraMinutes, totalMinutes };
};

const formatMssqlDate = (value: unknown): string | null => {
  if (value instanceof Date) {
    return DateTime.fromJSDate(value, { zone: 'utc' }).toISODate();
  }

  if (typeof value === 'string') {
    const parsed = DateTime.fromISO(value, { zone: 'utc' });
    return parsed.isValid ? parsed.toISODate() : null;
  }

  return null;
};

const fetchCalendarEntries = async (
  tutorId: number,
  monthStartISO: string,
  nextMonthStartISO: string
): Promise<Array<{ scheduleDate: string; timeId: number; timeLabel: string }>> => {
  const pool = await getMssqlPool();
  const request = pool.request();
  request.input('p_month_start', sql.Date, monthStartISO);
  request.input('p_next_month_start', sql.Date, nextMonthStartISO);
  request.input('p_tutor_id', sql.Int, tutorId);

  const result = await request.query(CALENDAR_MONTH_SQL);
  const entries: Array<{ scheduleDate: string; timeId: number; timeLabel: string }> = [];

  for (const row of result.recordset ?? []) {
    const scheduleDate = formatMssqlDate((row as Record<string, unknown>).ScheduleDate);
    if (!scheduleDate) continue;

    const timeId = toNumber((row as Record<string, unknown>).TimeID);
    const timeLabelRaw = (row as Record<string, unknown>).TimeLabel;
    const timeLabel = timeLabelRaw !== undefined && timeLabelRaw !== null ? String(timeLabelRaw) : '';

    entries.push({ scheduleDate, timeId, timeLabel });
  }

  return entries;
};

type TutorName = { firstName: string; lastName: string };

const fetchTutorNamesByIds = async (tutorIds: number[]): Promise<Map<number, TutorName>> => {
  if (!tutorIds.length) return new Map();

  const uniqueIds = Array.from(new Set(tutorIds.filter((id) => Number.isFinite(id)))) as number[];
  if (!uniqueIds.length) return new Map();

  const paramNames = uniqueIds.map((_, idx) => `p_id_${idx}`);
  const placeholders = paramNames.map((name) => `@${name}`).join(', ');
  const query = TUTOR_NAMES_BY_IDS_TEMPLATE.replace('@p_id_list', placeholders);

  const pool = await getMssqlPool();
  const request = pool.request();
  uniqueIds.forEach((id, idx) => request.input(paramNames[idx], sql.Int, id));

  const result = await request.query(query);
  const nameMap = new Map<number, TutorName>();

  for (const row of result.recordset ?? []) {
    const tutorId = toNumber((row as Record<string, unknown>).TutorID);
    if (!Number.isFinite(tutorId)) continue;

    const firstNameRaw = (row as Record<string, unknown>).FirstName;
    const lastNameRaw = (row as Record<string, unknown>).LastName;

    nameMap.set(tutorId, {
      firstName: firstNameRaw !== undefined && firstNameRaw !== null ? String(firstNameRaw) : '',
      lastName: lastNameRaw !== undefined && lastNameRaw !== null ? String(lastNameRaw) : ''
    });
  }

  return nameMap;
};

router.get(
  '/hours/me/weekly',
  requireTutor,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const context = getTutorContext(req);
    if (!context) {
      missingFranchise(res);
      return;
    }

    try {
      const timezone = await resolveTimezone(context.franchiseId);
      const { startLocal, startOfNextWeekLocal, endLocal } = computeIsoWeekRange(timezone);
      const startDate = startLocal.toISODate();
      const nextWeekStartDate = startOfNextWeekLocal.toISODate();
      const endDate = endLocal.toISODate();

      if (!startDate || !nextWeekStartDate || !endDate) {
        missingFranchise(res);
        return;
      }

      const { startAtUtcISO, endAtUtcISO } = localDateRangeToUtcBounds(startLocal, endLocal);

      const approvedDays = await fetchApprovedDaysForTutor(context.franchiseId, context.tutorId, startDate, endDate);
      const sessionsByDay = await fetchSessionsByDayIds(approvedDays.map((day) => day.id));
      const totals = computeRollupTotalsForDays(approvedDays, sessionsByDay);

      const tutoringHoursRaw = totals.tutoringMinutes / 60;
      const extraHoursRaw = totals.extraMinutes / 60;
      const totalHoursRaw = totals.totalMinutes / 60;

      res.status(200).json({
        range: {
          startDate,
          endDate,
          timezone
        },
        tutoringHours: roundHours2(tutoringHoursRaw),
        extraHours: roundHours2(extraHoursRaw),
        totalHours: roundHours2(totalHoursRaw)
      });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  '/hours/me/pay-period',
  requireTutor,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const context = getTutorContext(req);
    if (!context) {
      missingFranchise(res);
      return;
    }

    try {
      const payPeriod = await resolvePayPeriod(context.franchiseId, null);

      const approvedDays = await fetchApprovedDaysForTutor(
        context.franchiseId,
        context.tutorId,
        payPeriod.startDate,
        payPeriod.endDate
      );
      const sessionsByDay = await fetchSessionsByDayIds(approvedDays.map((day) => day.id));
      const totals = computeRollupTotalsForDays(approvedDays, sessionsByDay);

      const tutoringHoursRaw = totals.tutoringMinutes / 60;
      const extraHoursRaw = totals.extraMinutes / 60;
      const totalHoursRaw = totals.totalMinutes / 60;

      res.status(200).json({
        payPeriod,
        tutoringHours: roundHours2(tutoringHoursRaw),
        extraHours: roundHours2(extraHoursRaw),
        totalHours: roundHours2(totalHoursRaw)
      });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  '/hours/me/monthly',
  requireTutor,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const context = getTutorContext(req);
    if (!context) {
      missingFranchise(res);
      return;
    }

    const { month, isValid } = parseMonthParam((req.query as Record<string, unknown>).month);
    if (!isValid) {
      invalidMonth(res);
      return;
    }

    try {
      const timezone = await resolveTimezone(context.franchiseId);
      const range = computeMonthRange(timezone, month);

      if (!range.startLocal.isValid || !range.nextMonthStartLocal.isValid || !range.endLocal.isValid) {
        invalidMonth(res);
        return;
      }

      const startDate = range.startLocal.toISODate();
      const nextMonthStartDate = range.nextMonthStartLocal.toISODate();
      const endDate = range.endLocal.toISODate();

      if (!startDate || !nextMonthStartDate || !endDate) {
        invalidMonth(res);
        return;
      }

      const { startAtUtcISO, endAtUtcISO } = localDateRangeToUtcBounds(range.startLocal, range.endLocal);

      const approvedDays = await fetchApprovedDaysForTutor(context.franchiseId, context.tutorId, startDate, endDate);
      const sessionsByDay = await fetchSessionsByDayIds(approvedDays.map((day) => day.id));
      const totals = computeRollupTotalsForDays(approvedDays, sessionsByDay);

      const tutoringHoursRaw = totals.tutoringMinutes / 60;
      const extraHoursRaw = totals.extraMinutes / 60;
      const totalHoursRaw = totals.totalMinutes / 60;

      res.status(200).json({
        range: {
          month: range.month,
          startDate,
          endDate,
          timezone
        },
        tutoringHours: roundHours2(tutoringHoursRaw),
        extraHours: roundHours2(extraHoursRaw),
        totalHours: roundHours2(totalHoursRaw)
      });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  '/calendar/me/month',
  requireTutor,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const context = getTutorContext(req);
    if (!context) {
      missingFranchise(res);
      return;
    }

    const { month, isValid } = parseMonthParam((req.query as Record<string, unknown>).month);
    if (!isValid) {
      invalidMonth(res);
      return;
    }

    try {
      const timezone = await resolveTimezone(context.franchiseId);
      const range = computeMonthRange(timezone, month);

      if (!range.startLocal.isValid || !range.nextMonthStartLocal.isValid || !range.endLocal.isValid) {
        invalidMonth(res);
        return;
      }

      const startDate = range.startLocal.toISODate();
      const nextMonthStartDate = range.nextMonthStartLocal.toISODate();
      const endDate = range.endLocal.toISODate();

      if (!startDate || !nextMonthStartDate || !endDate) {
        invalidMonth(res);
        return;
      }

      const entries = await fetchCalendarEntries(context.tutorId, startDate, nextMonthStartDate);

      const slotMinutes = getScheduleSlotMinutes();
      const signingSecret = getScheduleSnapshotSigningSecret();
      const issuedAt = new Date().toISOString();

      const entriesByDate = new Map<string, ScheduleSnapshotEntry[]>();
      for (const entry of entries) {
        if (!entry.scheduleDate) continue;
        const list = entriesByDate.get(entry.scheduleDate) ?? [];
        list.push({ timeId: entry.timeId, timeLabel: entry.timeLabel });
        entriesByDate.set(entry.scheduleDate, list);
      }

      const snapshotsByDate: Record<string, ScheduleSnapshotV1> = {};
      for (let cursor = range.startLocal; cursor <= range.endLocal; cursor = cursor.plus({ days: 1 })) {
        const workDate = cursor.toISODate();
        if (!workDate) continue;

        const dayEntries = entriesByDate.get(workDate) ?? [];
        const baseSnapshot: ScheduleSnapshotV1 = {
          version: 1,
          franchiseId: context.franchiseId,
          tutorId: context.tutorId,
          workDate,
          timezone,
          slotMinutes,
          entries: dayEntries,
          intervals: deriveIntervalsFromEntries({ workDate, timezone, slotMinutes, entries: dayEntries }),
          issuedAt
        };

        snapshotsByDate[workDate] = signingSecret ? signScheduleSnapshot(baseSnapshot, signingSecret) : baseSnapshot;
      }

      res.status(200).json({
        range: {
          month: range.month,
          startDate,
          endDate,
          timezone
        },
        entries,
        snapshotsByDate
      });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  '/calendar/me/day/:workDate/snapshot',
  requireTutor,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const context = getTutorContext(req);
    if (!context) {
      missingFranchise(res);
      return;
    }

    const workDate = parseIsoDateOnly((req.params as Record<string, unknown>).workDate);
    if (!workDate) {
      invalidWorkDate(res);
      return;
    }

    try {
      const timezone = await resolveTimezone(context.franchiseId);
      const nextDay = DateTime.fromISO(workDate, { zone: 'UTC' })
        .plus({ days: 1 })
        .toISODate();
      if (!nextDay) {
        invalidWorkDate(res);
        return;
      }

      const entries = await fetchCalendarEntries(context.tutorId, workDate, nextDay);
      const dayEntries = entries.map((entry) => ({ timeId: entry.timeId, timeLabel: entry.timeLabel }));
      const slotMinutes = getScheduleSlotMinutes();
      const signingSecret = getScheduleSnapshotSigningSecret();
      const issuedAt = new Date().toISOString();

      const baseSnapshot: ScheduleSnapshotV1 = {
        version: 1,
        franchiseId: context.franchiseId,
        tutorId: context.tutorId,
        workDate,
        timezone,
        slotMinutes,
        entries: dayEntries,
        intervals: deriveIntervalsFromEntries({
          workDate,
          timezone,
          slotMinutes,
          entries: dayEntries
        }),
        issuedAt
      };

      const snapshot = signingSecret ? signScheduleSnapshot(baseSnapshot, signingSecret) : baseSnapshot;

      res.status(200).json({ snapshot });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  '/hours/admin/pay-period/summary',
  requireAdmin,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const scope = enforceFranchiseScope(req, { requireFranchiseId: true, requiredMessage: 'franchiseId is required' });
    if (scope.error || scope.franchiseId === null) {
      res.status(scope.error?.status ?? 400).json({ error: scope.error?.message ?? 'franchiseId is required' });
      return;
    }
    const franchiseId = scope.franchiseId;

    const { dateISO: forDate, isValid } = extractForDateParam((req.query as Record<string, unknown>).forDate);
    if (!isValid) {
      invalidForDate(res);
      return;
    }

    try {
      const payPeriod = await resolvePayPeriod(franchiseId, forDate);

      const approvedDays = await fetchApprovedDaysForFranchise(franchiseId, payPeriod.startDate, payPeriod.endDate);
      const sessionsByDay = await fetchSessionsByDayIds(approvedDays.map((day) => day.id));

      const totalsByTutor = new Map<number, { tutoringMinutes: number; extraMinutes: number; totalMinutes: number }>();
      for (const day of approvedDays) {
        const totals = computeRollupTotalsForDays([day], sessionsByDay);
        const current = totalsByTutor.get(day.tutorid) ?? { tutoringMinutes: 0, extraMinutes: 0, totalMinutes: 0 };
        totalsByTutor.set(day.tutorid, {
          tutoringMinutes: current.tutoringMinutes + totals.tutoringMinutes,
          extraMinutes: current.extraMinutes + totals.extraMinutes,
          totalMinutes: current.totalMinutes + totals.totalMinutes
        });
      }

      const tutorIds = Array.from(totalsByTutor.keys());
      const namesById = await fetchTutorNamesByIds(tutorIds);

      const rows = tutorIds
        .map((tutorId) => {
          const totals = totalsByTutor.get(tutorId);
          if (!totals) return null;
          const name = namesById.get(tutorId) ?? { firstName: '', lastName: '' };
          const tutoringHoursRaw = totals.tutoringMinutes / 60;
          const extraHoursRaw = totals.extraMinutes / 60;
          const totalHoursRaw = totals.totalMinutes / 60;
          return {
            tutorId,
            firstName: name.firstName,
            lastName: name.lastName,
            tutoringHours: roundHours2(tutoringHoursRaw),
            extraHours: roundHours2(extraHoursRaw),
            totalHours: roundHours2(totalHoursRaw)
          };
        })
        .filter(Boolean) as Array<{
        tutorId: number;
        firstName: string;
        lastName: string;
        tutoringHours: number;
        extraHours: number;
        totalHours: number;
      }>;

      rows.sort((a, b) => {
        const lastNameCompare = a.lastName.localeCompare(b.lastName);
        if (lastNameCompare !== 0) return lastNameCompare;
        return a.firstName.localeCompare(b.firstName);
      });

      res.status(200).json({ payPeriod, rows });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  '/hours/admin/pay-period/summary-total-positive',
  requireAdmin,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const scope = enforceFranchiseScope(req, { requireFranchiseId: true, requiredMessage: 'franchiseId is required' });
    if (scope.error || scope.franchiseId === null) {
      res.status(scope.error?.status ?? 400).json({ error: scope.error?.message ?? 'franchiseId is required' });
      return;
    }
    const franchiseId = scope.franchiseId;

    const { dateISO: forDate, isValid } = extractForDateParam((req.query as Record<string, unknown>).forDate);
    if (!isValid) {
      invalidForDate(res);
      return;
    }

    try {
      const payPeriod = await resolvePayPeriod(franchiseId, forDate);

      const approvedDays = await fetchApprovedDaysForFranchise(franchiseId, payPeriod.startDate, payPeriod.endDate);
      const sessionsByDay = await fetchSessionsByDayIds(approvedDays.map((day) => day.id));

      const totalsByTutor = new Map<number, { tutoringMinutes: number; extraMinutes: number; totalMinutes: number }>();
      for (const day of approvedDays) {
        const totals = computeRollupTotalsForDays([day], sessionsByDay);
        const current = totalsByTutor.get(day.tutorid) ?? { tutoringMinutes: 0, extraMinutes: 0, totalMinutes: 0 };
        totalsByTutor.set(day.tutorid, {
          tutoringMinutes: current.tutoringMinutes + totals.tutoringMinutes,
          extraMinutes: current.extraMinutes + totals.extraMinutes,
          totalMinutes: current.totalMinutes + totals.totalMinutes
        });
      }

      const tutorIds = Array.from(totalsByTutor.keys());
      const namesById = await fetchTutorNamesByIds(tutorIds);

      const rows: Array<{
        tutorId: number;
        firstName: string;
        lastName: string;
        tutoringHours: number;
        extraHours: number;
        totalHours: number;
      }> = [];

      for (const tutorId of tutorIds) {
        const totals = totalsByTutor.get(tutorId);
        if (!totals) continue;

        const tutoringHoursRaw = totals.tutoringMinutes / 60;
        const extraHoursRaw = totals.extraMinutes / 60;
        const totalHoursRaw = totals.totalMinutes / 60;
        if (totalHoursRaw <= 0) continue;

        const name = namesById.get(tutorId) ?? { firstName: '', lastName: '' };
        rows.push({
          tutorId,
          firstName: name.firstName,
          lastName: name.lastName,
          tutoringHours: roundHours2(tutoringHoursRaw),
          extraHours: roundHours2(extraHoursRaw),
          totalHours: roundHours2(totalHoursRaw)
        });
      }

      rows.sort((a, b) => {
        const lastNameCompare = a.lastName.localeCompare(b.lastName);
        if (lastNameCompare !== 0) return lastNameCompare;
        return a.firstName.localeCompare(b.firstName);
      });

      res.status(200).json({ payPeriod, rows });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
