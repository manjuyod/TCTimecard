import express, { NextFunction, Request, Response } from 'express';
import { DateTime } from 'luxon';
import { getMssqlPool, sql } from '../db/mssql';
import { getPostgresPool } from '../db/postgres';
import { requireAdmin, requireTutor } from '../middleware/auth';
import { enforceFranchiseScope } from '../middleware/franchiseScope';
import { computeIsoWeekRange, computeMonthRange, parseMonthParam, roundHours2 } from '../payroll/hoursUtils';
import { localDateRangeToUtcBounds, resolvePayPeriod, type PayPeriod } from '../payroll/payPeriodResolution';

const router = express.Router();

const WEEKLY_TUTORING_SQL = `
DECLARE @StartOfThisWeek DATE = @p_start_of_week;
DECLARE @StartOfNextWeek DATE = @p_start_of_next_week;

;WITH Slots AS (
    SELECT TutorID, ScheduleDate, TimeID
    FROM dbo.tblSessionSchedule
    WHERE TutorID = @p_tutor_id
      AND ScheduleDate >= @StartOfThisWeek
      AND ScheduleDate <  @StartOfNextWeek
    GROUP BY TutorID, ScheduleDate, TimeID
)
SELECT COUNT(*) AS weekly_tutoring_hours
FROM Slots;
`;

const PAY_PERIOD_TUTORING_SQL = `
DECLARE @PeriodStart DATE = @p_period_start;
DECLARE @PeriodEnd   DATE = @p_period_end;

;WITH Slots AS (
    SELECT TutorID, ScheduleDate, TimeID
    FROM dbo.tblSessionSchedule
    WHERE TutorID = @p_tutor_id
      AND ScheduleDate >= @PeriodStart
      AND ScheduleDate <= @PeriodEnd
    GROUP BY TutorID, ScheduleDate, TimeID
)
SELECT COUNT(*) AS pay_period_tutoring_hours
FROM Slots;
`;

const MONTHLY_TUTORING_SQL = `
DECLARE @MonthStart DATE = @p_month_start;
DECLARE @NextMonthStart DATE = @p_next_month_start;

;WITH Slots AS (
    SELECT TutorID, ScheduleDate, TimeID
    FROM dbo.tblSessionSchedule
    WHERE TutorID = @p_tutor_id
      AND ScheduleDate >= @MonthStart
      AND ScheduleDate <  @NextMonthStart
    GROUP BY TutorID, ScheduleDate, TimeID
)
SELECT COUNT(*) AS monthly_tutoring_hours
FROM Slots;
`;

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

const WEEKLY_EXTRA_HOURS_SQL = `
SELECT
  COALESCE(SUM(EXTRACT(EPOCH FROM (end_at - start_at)) / 3600.0), 0) AS weekly_extra_hours
FROM public.extrahours
WHERE tutorid = $1
  AND status = 'approved'
  AND start_at >= $2
  AND start_at <  $3;
`;

const PAY_PERIOD_EXTRA_HOURS_SQL = `
SELECT
  COALESCE(SUM(EXTRACT(EPOCH FROM (end_at - start_at)) / 3600.0), 0) AS pay_period_extra_hours
FROM public.extrahours
WHERE tutorid = $1
  AND status = 'approved'
  AND start_at >= $2
  AND start_at <  $3;
`;

const MONTHLY_EXTRA_HOURS_SQL = `
SELECT
  COALESCE(SUM(EXTRACT(EPOCH FROM (end_at - start_at)) / 3600.0), 0) AS monthly_extra_hours
FROM public.extrahours
WHERE tutorid = $1
  AND status = 'approved'
  AND start_at >= $2
  AND start_at <  $3;
`;

const ADMIN_TUTORING_HOURS_SQL = `
;WITH Slots AS (
    SELECT
        s.TutorID,
        s.ScheduleDate,
        s.TimeID
    FROM dbo.tblSessionSchedule s
    WHERE s.FranchiseID = @p_franchise_id
      AND s.TutorID IS NOT NULL
      AND s.ScheduleDate >= @p_start_date
      AND s.ScheduleDate <  @p_end_date
    GROUP BY s.TutorID, s.ScheduleDate, s.TimeID
),
TutorHours AS (
    SELECT
        TutorID,
        COUNT(*) AS tutoring_hours
    FROM Slots
    GROUP BY TutorID
)
SELECT
    th.TutorID,
    t.FirstName,
    t.LastName,
    th.tutoring_hours
FROM TutorHours th
JOIN dbo.tblTutors t ON t.ID = th.TutorID
WHERE t.FirstName <> 'Overflow'
ORDER BY t.LastName, t.FirstName;
`;

const ADMIN_EXTRA_HOURS_SQL = `
SELECT
  tutorid,
  COALESCE(SUM(EXTRACT(EPOCH FROM (end_at - start_at)) / 3600.0), 0) AS extra_hours
FROM public.extrahours
WHERE franchiseid = $1
  AND status = 'approved'
  AND start_at >= $2
  AND start_at <  $3
GROUP BY tutorid;
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

const toNumber = (value: unknown): number => {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
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

const fetchWeeklyTutoringHours = async (
  tutorId: number,
  startDateISO: string,
  nextWeekStartISO: string
): Promise<number> => {
  const pool = await getMssqlPool();
  const request = pool.request();
  request.input('p_start_of_week', sql.Date, startDateISO);
  request.input('p_start_of_next_week', sql.Date, nextWeekStartISO);
  request.input('p_tutor_id', sql.Int, tutorId);

  const result = await request.query(WEEKLY_TUTORING_SQL);
  return toNumber(result.recordset?.[0]?.weekly_tutoring_hours);
};

const fetchPayPeriodTutoringHours = async (
  tutorId: number,
  periodStartISO: string,
  periodEndISO: string
): Promise<number> => {
  const pool = await getMssqlPool();
  const request = pool.request();
  request.input('p_period_start', sql.Date, periodStartISO);
  request.input('p_period_end', sql.Date, periodEndISO);
  request.input('p_tutor_id', sql.Int, tutorId);

  const result = await request.query(PAY_PERIOD_TUTORING_SQL);
  return toNumber(result.recordset?.[0]?.pay_period_tutoring_hours);
};

const fetchMonthlyTutoringHours = async (
  tutorId: number,
  monthStartISO: string,
  nextMonthStartISO: string
): Promise<number> => {
  const pool = await getMssqlPool();
  const request = pool.request();
  request.input('p_month_start', sql.Date, monthStartISO);
  request.input('p_next_month_start', sql.Date, nextMonthStartISO);
  request.input('p_tutor_id', sql.Int, tutorId);

  const result = await request.query(MONTHLY_TUTORING_SQL);
  return toNumber(result.recordset?.[0]?.monthly_tutoring_hours);
};

const fetchWeeklyExtraHours = async (tutorId: number, startAtUtcISO: string, endAtUtcISO: string): Promise<number> => {
  const pool = getPostgresPool();
  const result = await pool.query(WEEKLY_EXTRA_HOURS_SQL, [tutorId, startAtUtcISO, endAtUtcISO]);
  return toNumber(result.rows?.[0]?.weekly_extra_hours);
};

const fetchPayPeriodExtraHours = async (
  tutorId: number,
  startAtUtcISO: string,
  endAtUtcISO: string
): Promise<number> => {
  const pool = getPostgresPool();
  const result = await pool.query(PAY_PERIOD_EXTRA_HOURS_SQL, [tutorId, startAtUtcISO, endAtUtcISO]);
  return toNumber(result.rows?.[0]?.pay_period_extra_hours);
};

const fetchMonthlyExtraHours = async (
  tutorId: number,
  startAtUtcISO: string,
  endAtUtcISO: string
): Promise<number> => {
  const pool = getPostgresPool();
  const result = await pool.query(MONTHLY_EXTRA_HOURS_SQL, [tutorId, startAtUtcISO, endAtUtcISO]);
  return toNumber(result.rows?.[0]?.monthly_extra_hours);
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

type AdminTutoringSummaryRow = { tutorId: number; firstName: string; lastName: string; tutoringHours: number };
type AdminExtraHoursRow = { tutorId: number; extraHours: number };
type TutorName = { firstName: string; lastName: string };

const fetchAdminTutoringHours = async (
  franchiseId: number,
  startDateISO: string,
  endDateExclusiveISO: string
): Promise<AdminTutoringSummaryRow[]> => {
  const pool = await getMssqlPool();
  const request = pool.request();
  request.input('p_franchise_id', sql.Int, franchiseId);
  request.input('p_start_date', sql.Date, startDateISO);
  request.input('p_end_date', sql.Date, endDateExclusiveISO);

  const result = await request.query(ADMIN_TUTORING_HOURS_SQL);
  const rows: AdminTutoringSummaryRow[] = [];

  for (const row of result.recordset ?? []) {
    const tutorId = toNumber((row as Record<string, unknown>).TutorID);
    if (!Number.isFinite(tutorId)) continue;

    const firstNameRaw = (row as Record<string, unknown>).FirstName;
    const lastNameRaw = (row as Record<string, unknown>).LastName;
    const tutoringHours = toNumber((row as Record<string, unknown>).tutoring_hours);

    rows.push({
      tutorId,
      firstName: firstNameRaw !== undefined && firstNameRaw !== null ? String(firstNameRaw) : '',
      lastName: lastNameRaw !== undefined && lastNameRaw !== null ? String(lastNameRaw) : '',
      tutoringHours
    });
  }

  return rows;
};

const fetchAdminExtraHours = async (
  franchiseId: number,
  startAtUtcISO: string,
  endAtUtcISO: string
): Promise<AdminExtraHoursRow[]> => {
  const pool = getPostgresPool();
  const result = await pool.query(ADMIN_EXTRA_HOURS_SQL, [franchiseId, startAtUtcISO, endAtUtcISO]);
  const rows: AdminExtraHoursRow[] = [];

  for (const row of result.rows ?? []) {
    const tutorId = toNumber((row as Record<string, unknown>).tutorid);
    if (!Number.isFinite(tutorId)) continue;

    const extraHours = toNumber((row as Record<string, unknown>).extra_hours);
    rows.push({ tutorId, extraHours });
  }

  return rows;
};

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

      const [tutoringHours, extraHoursRaw] = await Promise.all([
        fetchWeeklyTutoringHours(context.tutorId, startDate, nextWeekStartDate),
        fetchWeeklyExtraHours(context.tutorId, startAtUtcISO, endAtUtcISO)
      ]);

      const totalHoursRaw = tutoringHours + extraHoursRaw;

      res.status(200).json({
        range: {
          startDate,
          endDate,
          timezone
        },
        tutoringHours,
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

      const [tutoringHours, extraHoursRaw] = await Promise.all([
        fetchPayPeriodTutoringHours(context.tutorId, payPeriod.startDate, payPeriod.endDate),
        fetchPayPeriodExtraHours(context.tutorId, payPeriod.startAt, payPeriod.endAt)
      ]);

      const totalHoursRaw = tutoringHours + extraHoursRaw;

      res.status(200).json({
        payPeriod,
        tutoringHours,
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

      const [tutoringHours, extraHoursRaw] = await Promise.all([
        fetchMonthlyTutoringHours(context.tutorId, startDate, nextMonthStartDate),
        fetchMonthlyExtraHours(context.tutorId, startAtUtcISO, endAtUtcISO)
      ]);

      const totalHoursRaw = tutoringHours + extraHoursRaw;

      res.status(200).json({
        range: {
          month: range.month,
          startDate,
          endDate,
          timezone
        },
        tutoringHours,
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

      res.status(200).json({
        range: {
          month: range.month,
          startDate,
          endDate,
          timezone
        },
        entries
      });
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
      const endDateExclusive = computeEndDateExclusive(payPeriod);

      const [tutoringRows, extraRows] = await Promise.all([
        fetchAdminTutoringHours(franchiseId, payPeriod.startDate, endDateExclusive),
        fetchAdminExtraHours(franchiseId, payPeriod.startAt, payPeriod.endAt)
      ]);

      const extraHoursByTutor = new Map<number, number>();
      for (const row of extraRows) {
        extraHoursByTutor.set(row.tutorId, row.extraHours);
      }

      const rows = tutoringRows.map((row) => {
        const extraHoursRaw = extraHoursByTutor.get(row.tutorId) ?? 0;
        const totalHoursRaw = row.tutoringHours + extraHoursRaw;
        return {
          tutorId: row.tutorId,
          firstName: row.firstName,
          lastName: row.lastName,
          tutoringHours: row.tutoringHours,
          extraHours: roundHours2(extraHoursRaw),
          totalHours: roundHours2(totalHoursRaw)
        };
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
      const endDateExclusive = computeEndDateExclusive(payPeriod);

      const [tutoringRows, extraRows] = await Promise.all([
        fetchAdminTutoringHours(franchiseId, payPeriod.startDate, endDateExclusive),
        fetchAdminExtraHours(franchiseId, payPeriod.startAt, payPeriod.endAt)
      ]);

      const tutoringById = new Map<number, AdminTutoringSummaryRow>();
      tutoringRows.forEach((row) => tutoringById.set(row.tutorId, row));

      const extraHoursByTutor = new Map<number, number>();
      extraRows.forEach((row) => extraHoursByTutor.set(row.tutorId, row.extraHours));

      const extraOnlyIds = Array.from(
        new Set(extraRows.map((row) => row.tutorId).filter((id) => !tutoringById.has(id)))
      );
      const tutorNamesFromExtras = await fetchTutorNamesByIds(extraOnlyIds);

      const allTutorIds = new Set<number>();
      tutoringRows.forEach((row) => allTutorIds.add(row.tutorId));
      extraRows.forEach((row) => allTutorIds.add(row.tutorId));

      const rows: Array<{
        tutorId: number;
        firstName: string;
        lastName: string;
        tutoringHours: number;
        extraHours: number;
        totalHours: number;
      }> = [];

      for (const tutorId of allTutorIds) {
        const tutoringRow = tutoringById.get(tutorId);
        const tutoringHours = tutoringRow?.tutoringHours ?? 0;
        const nameSource = tutoringRow
          ? { firstName: tutoringRow.firstName, lastName: tutoringRow.lastName }
          : tutorNamesFromExtras.get(tutorId) ?? { firstName: '', lastName: '' };

        const extraHoursRaw = extraHoursByTutor.get(tutorId) ?? 0;
        const totalHoursRaw = tutoringHours + extraHoursRaw;

        if (totalHoursRaw <= 0) continue;

        rows.push({
          tutorId,
          firstName: nameSource.firstName,
          lastName: nameSource.lastName,
          tutoringHours,
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
