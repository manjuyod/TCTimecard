import express, { NextFunction, Request, Response } from 'express';
import ExcelJS from 'exceljs';
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
  normalizeScheduleTimeLabel,
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

const CRM_PAY_PERIOD_SUMMARY_SQL = `
DECLARE @PeriodStart DATE = @p_period_start;
DECLARE @EffectiveEnd DATE = @p_effective_end;
DECLARE @FranchiseId INT = @p_franchise_id;

;WITH DedupSlots AS (
    SELECT
        s.TutorID,
        CAST(s.ScheduleDate AS DATE) AS ScheduleDate,
        s.TimeID
    FROM dbo.tblSessionSchedule s
    WHERE s.FranchiseID = @FranchiseId
      AND s.TutorID IS NOT NULL
      AND s.ScheduleDate >= @PeriodStart
      AND s.ScheduleDate < DATEADD(DAY, 1, @EffectiveEnd)
    GROUP BY
        s.TutorID,
        CAST(s.ScheduleDate AS DATE),
        s.TimeID
)
SELECT
    ds.TutorID,
    COUNT(*) AS ReportedCRMHours
FROM DedupSlots ds
GROUP BY ds.TutorID
ORDER BY ds.TutorID ASC;
`;

const CRM_PAY_PERIOD_DETAIL_SQL = `
DECLARE @PeriodStart DATE = @p_period_start;
DECLARE @EffectiveEnd DATE = @p_effective_end;
DECLARE @FranchiseId INT = @p_franchise_id;
DECLARE @TutorId INT = @p_tutor_id;

;WITH DedupSlots AS (
    SELECT
        CAST(s.ScheduleDate AS DATE) AS WorkDate,
        s.TimeID
    FROM dbo.tblSessionSchedule s
    WHERE s.FranchiseID = @FranchiseId
      AND s.TutorID = @TutorId
      AND s.ScheduleDate >= @PeriodStart
      AND s.ScheduleDate < DATEADD(DAY, 1, @EffectiveEnd)
    GROUP BY
        CAST(s.ScheduleDate AS DATE),
        s.TimeID
)
SELECT
    ds.WorkDate,
    COUNT(*) AS ReportedCRMHours
FROM DedupSlots ds
GROUP BY ds.WorkDate
ORDER BY ds.WorkDate ASC;
`;

const CRM_PAY_PERIOD_EXPORT_DAILY_SQL = `
DECLARE @PeriodStart DATE = @p_period_start;
DECLARE @EffectiveEnd DATE = @p_effective_end;
DECLARE @FranchiseId INT = @p_franchise_id;

;WITH DedupSlots AS (
    SELECT
        s.TutorID,
        CAST(s.ScheduleDate AS DATE) AS WorkDate,
        s.TimeID
    FROM dbo.tblSessionSchedule s
    WHERE s.FranchiseID = @FranchiseId
      AND s.TutorID IS NOT NULL
      AND s.ScheduleDate >= @PeriodStart
      AND s.ScheduleDate < DATEADD(DAY, 1, @EffectiveEnd)
    GROUP BY
        s.TutorID,
        CAST(s.ScheduleDate AS DATE),
        s.TimeID
)
SELECT
    ds.TutorID,
    ds.WorkDate,
    COUNT(*) AS ReportedCRMHours
FROM DedupSlots ds
GROUP BY ds.TutorID, ds.WorkDate
ORDER BY ds.TutorID ASC, ds.WorkDate ASC;
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

const MAX_TUTOR_NAME_BATCH_SIZE = 500;
const MAX_PAY_PERIOD_EXPORT_DETAIL_ROWS = 2000;

const missingFranchise = (res: Response) => res.status(400).json({ error: 'franchiseId is required for tutor requests' });
const invalidMonth = (res: Response) => res.status(400).json({ error: 'month must be YYYY-MM' });
const invalidForDate = (res: Response) => res.status(400).json({ error: 'forDate must be YYYY-MM-DD' });
const invalidWorkDate = (res: Response) => res.status(400).json({ error: 'workDate must be YYYY-MM-DD' });
const invalidTutorId = (res: Response) => res.status(400).json({ error: 'tutorId is required and must be an integer' });
const invalidExportFormat = (res: Response) => res.status(400).json({ error: 'format must be xlsx or csv' });
const exportTooLarge = (res: Response) =>
  res.status(413).json({ error: 'Pay period export is too large to export safely. Narrow the pay period and try again.' });

type MinuteInterval = { startMinute: number; endMinute: number };

type ApprovedEntryDayRow = {
  id: number;
  tutorid: number;
  work_date: unknown;
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
      SELECT id, tutorid, work_date, schedule_snapshot
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
      SELECT id, tutorid, work_date, schedule_snapshot
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
        AND end_at IS NOT NULL
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

const formatDateOnly = (value: unknown): string | null => {
  if (value instanceof Date) {
    return DateTime.fromJSDate(value, { zone: 'utc' }).toISODate();
  }

  if (typeof value === 'string') {
    const parsed = parseIsoDateOnly(value);
    if (parsed) return parsed;

    const dateTime = DateTime.fromISO(value, { zone: 'utc', setZone: true });
    return dateTime.isValid ? dateTime.toISODate() : null;
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
    const timeLabel = normalizeScheduleTimeLabel(timeLabelRaw);

    entries.push({ scheduleDate, timeId, timeLabel });
  }

  return entries;
};

type TutorName = { firstName: string; lastName: string };
type TutorRollupTotals = { tutoringMinutes: number; extraMinutes: number; totalMinutes: number };
type AdminComparisonSummaryRow = {
  tutorId: number;
  firstName: string;
  lastName: string;
  reportedCrmHours: number;
  loggedHours: number;
};
type AdminSummaryDetailRow = {
  workDate: string;
  reportedCrmHours: number;
  loggedHours: number;
};
type AdminExportRow = {
  tutorId: number;
  firstName: string;
  lastName: string;
  workDate: string;
  reportedCrmHours: number;
  loggedHours: number;
  diff: number;
  timeInOut: string;
};
type AdminLegacySummaryRow = {
  tutorId: number;
  firstName: string;
  lastName: string;
  tutoringHours: number;
  extraHours: number;
  totalHours: number;
};
type AdminDailySummaryRow = {
  tutorId: number;
  firstName: string;
  lastName: string;
  workDate: string;
  totalHours: number;
};

const fetchTutorNamesByIds = async (tutorIds: number[]): Promise<Map<number, TutorName>> => {
  if (!tutorIds.length) return new Map();

  const uniqueIds = Array.from(new Set(tutorIds.filter((id) => Number.isFinite(id)))) as number[];
  if (!uniqueIds.length) return new Map();

  const pool = await getMssqlPool();
  const nameMap = new Map<number, TutorName>();

  for (let offset = 0; offset < uniqueIds.length; offset += MAX_TUTOR_NAME_BATCH_SIZE) {
    const batchIds = uniqueIds.slice(offset, offset + MAX_TUTOR_NAME_BATCH_SIZE);
    const paramNames = batchIds.map((_, idx) => `p_id_${offset + idx}`);
    const placeholders = paramNames.map((name) => `@${name}`).join(', ');
    const query = TUTOR_NAMES_BY_IDS_TEMPLATE.replace('@p_id_list', placeholders);
    const request = pool.request();
    batchIds.forEach((id, idx) => request.input(paramNames[idx], sql.Int, id));

    const result = await request.query(query);
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
  }

  return nameMap;
};

const compareTutorNames = (
  a: { firstName: string; lastName: string },
  b: { firstName: string; lastName: string }
): number => {
  const lastNameCompare = a.lastName.localeCompare(b.lastName);
  if (lastNameCompare !== 0) return lastNameCompare;
  return a.firstName.localeCompare(b.firstName);
};

const buildAdminLegacySummaryRows = (
  totalsByTutor: Map<number, TutorRollupTotals>,
  namesById: Map<number, TutorName>,
  positiveOnly: boolean
): AdminLegacySummaryRow[] => {
  const rows = Array.from(totalsByTutor.entries())
    .map(([tutorId, totals]) => {
      const name = namesById.get(tutorId) ?? { firstName: '', lastName: '' };
      return {
        tutorId,
        firstName: name.firstName,
        lastName: name.lastName,
        tutoringHours: roundHours2(totals.tutoringMinutes / 60),
        extraHours: roundHours2(totals.extraMinutes / 60),
        totalHours: roundHours2(totals.totalMinutes / 60)
      };
    });

  const filteredRows = positiveOnly ? rows.filter((row) => row.totalHours > 0) : rows;

  filteredRows.sort(compareTutorNames);
  return filteredRows;
};

const getPayPeriodEffectiveEnd = (payPeriod: PayPeriod): string => {
  const todayLocal = DateTime.now().setZone(payPeriod.timezone).toISODate();
  if (!todayLocal) return payPeriod.endDate;
  return todayLocal < payPeriod.endDate ? todayLocal : payPeriod.endDate;
};

const fetchReportedCrmHoursByTutor = async (
  franchiseId: number,
  payPeriod: PayPeriod
): Promise<Map<number, number>> => {
  const pool = await getMssqlPool();
  const request = pool.request();
  request.input('p_franchise_id', sql.Int, franchiseId);
  request.input('p_period_start', sql.Date, payPeriod.startDate);
  request.input('p_effective_end', sql.Date, getPayPeriodEffectiveEnd(payPeriod));

  const result = await request.query(CRM_PAY_PERIOD_SUMMARY_SQL);
  const hoursByTutor = new Map<number, number>();

  for (const row of result.recordset ?? []) {
    const tutorId = toNumber((row as Record<string, unknown>).TutorID);
    const reportedCrmHours = roundHours2(toNumber((row as Record<string, unknown>).ReportedCRMHours));
    if (!Number.isFinite(tutorId) || reportedCrmHours <= 0) continue;
    hoursByTutor.set(tutorId, reportedCrmHours);
  }

  return hoursByTutor;
};

const fetchReportedCrmHoursByDate = async (
  franchiseId: number,
  tutorId: number,
  payPeriod: PayPeriod
): Promise<Map<string, number>> => {
  const pool = await getMssqlPool();
  const request = pool.request();
  request.input('p_franchise_id', sql.Int, franchiseId);
  request.input('p_tutor_id', sql.Int, tutorId);
  request.input('p_period_start', sql.Date, payPeriod.startDate);
  request.input('p_effective_end', sql.Date, getPayPeriodEffectiveEnd(payPeriod));

  const result = await request.query(CRM_PAY_PERIOD_DETAIL_SQL);
  const hoursByDate = new Map<string, number>();

  for (const row of result.recordset ?? []) {
    const workDate = formatMssqlDate((row as Record<string, unknown>).WorkDate);
    const reportedCrmHours = roundHours2(toNumber((row as Record<string, unknown>).ReportedCRMHours));
    if (!workDate || reportedCrmHours <= 0) continue;
    hoursByDate.set(workDate, reportedCrmHours);
  }

  return hoursByDate;
};

const fetchReportedCrmHoursByTutorDate = async (
  franchiseId: number,
  payPeriod: PayPeriod
): Promise<Map<string, number>> => {
  const pool = await getMssqlPool();
  const request = pool.request();
  request.input('p_franchise_id', sql.Int, franchiseId);
  request.input('p_period_start', sql.Date, payPeriod.startDate);
  request.input('p_effective_end', sql.Date, getPayPeriodEffectiveEnd(payPeriod));

  const result = await request.query(CRM_PAY_PERIOD_EXPORT_DAILY_SQL);
  const hoursByTutorDate = new Map<string, number>();

  for (const row of result.recordset ?? []) {
    const tutorId = toNumber((row as Record<string, unknown>).TutorID);
    const workDate = formatMssqlDate((row as Record<string, unknown>).WorkDate);
    const reportedCrmHours = roundHours2(toNumber((row as Record<string, unknown>).ReportedCRMHours));
    if (!Number.isFinite(tutorId) || !workDate || reportedCrmHours <= 0) continue;
    hoursByTutorDate.set(`${tutorId}:${workDate}`, reportedCrmHours);
  }

  return hoursByTutorDate;
};

const buildLoggedHoursByTutor = (
  totalsByTutor: Map<number, TutorRollupTotals>
): Map<number, number> =>
  new Map(
    Array.from(totalsByTutor.entries())
      .map(([tutorId, totals]) => [tutorId, roundHours2(totals.totalMinutes / 60)] as const)
      .filter(([, loggedHours]) => loggedHours > 0)
  );

const buildLoggedHoursByDate = (
  approvedDays: ApprovedEntryDayRow[],
  sessionsByDay: Map<number, ApprovedEntrySessionRow[]>
): Map<string, number> => {
  const totalsByDate = new Map<string, number>();

  for (const day of approvedDays) {
    const workDate = formatDateOnly(day.work_date);
    if (!workDate) continue;

    const totals = computeRollupTotalsForDays([day], sessionsByDay);
    const loggedHours = roundHours2(totals.totalMinutes / 60);
    if (loggedHours <= 0) continue;

    totalsByDate.set(workDate, roundHours2((totalsByDate.get(workDate) ?? 0) + loggedHours));
  }

  return totalsByDate;
};

const buildAdminComparisonSummaryRows = (
  loggedHoursByTutor: Map<number, number>,
  crmHoursByTutor: Map<number, number>,
  namesById: Map<number, TutorName>
): AdminComparisonSummaryRow[] => {
  const tutorIds = new Set<number>([...loggedHoursByTutor.keys(), ...crmHoursByTutor.keys()]);
  const rows = Array.from(tutorIds)
    .map((tutorId) => {
      const name = namesById.get(tutorId) ?? { firstName: '', lastName: '' };
      return {
        tutorId,
        firstName: name.firstName,
        lastName: name.lastName,
        reportedCrmHours: crmHoursByTutor.get(tutorId) ?? 0,
        loggedHours: loggedHoursByTutor.get(tutorId) ?? 0
      };
    })
    .filter((row) => row.reportedCrmHours > 0 || row.loggedHours > 0);

  rows.sort(compareTutorNames);
  return rows;
};

const buildAdminSummaryDetailRows = (
  loggedHoursByDate: Map<string, number>,
  crmHoursByDate: Map<string, number>
): AdminSummaryDetailRow[] => {
  const workDates = new Set<string>([...loggedHoursByDate.keys(), ...crmHoursByDate.keys()]);

  return Array.from(workDates)
    .sort((a, b) => a.localeCompare(b))
    .map((workDate) => ({
      workDate,
      reportedCrmHours: crmHoursByDate.get(workDate) ?? 0,
      loggedHours: loggedHoursByDate.get(workDate) ?? 0
    }))
    .filter((row) => row.reportedCrmHours > 0 || row.loggedHours > 0);
};

const formatSessionPair = (startAt: unknown, endAt: unknown, timezone: string): string | null => {
  const start = DateTime.fromJSDate(new Date(startAt as never), { zone: 'utc' }).setZone(timezone);
  const end = DateTime.fromJSDate(new Date(endAt as never), { zone: 'utc' }).setZone(timezone);
  if (!start.isValid || !end.isValid) return null;
  return `${start.toFormat('h:mm a')} - ${end.toFormat('h:mm a')}`;
};

const buildTimeInOutByTutorDate = (
  approvedDays: ApprovedEntryDayRow[],
  sessionsByDay: Map<number, ApprovedEntrySessionRow[]>,
  timezone: string
): Map<string, string> => {
  const result = new Map<string, string>();

  for (const day of approvedDays) {
    const workDate = formatDateOnly(day.work_date);
    if (!workDate) continue;

    const sessionPairs = (sessionsByDay.get(day.id) ?? [])
      .map((session) => formatSessionPair(session.start_at, session.end_at, timezone))
      .filter((value): value is string => Boolean(value));

    if (!sessionPairs.length) continue;
    result.set(`${day.tutorid}:${workDate}`, sessionPairs.join(' | '));
  }

  return result;
};

const buildAdminExportRows = (
  approvedDays: ApprovedEntryDayRow[],
  sessionsByDay: Map<number, ApprovedEntrySessionRow[]>,
  crmHoursByTutorDate: Map<string, number>,
  namesById: Map<number, TutorName>,
  timezone: string
): AdminExportRow[] => {
  const loggedHoursByTutorDate = new Map<string, number>();

  for (const day of approvedDays) {
    const workDate = formatDateOnly(day.work_date);
    if (!workDate) continue;

    const totals = computeRollupTotalsForDays([day], sessionsByDay);
    const loggedHours = roundHours2(totals.totalMinutes / 60);
    if (loggedHours <= 0) continue;

    const key = `${day.tutorid}:${workDate}`;
    loggedHoursByTutorDate.set(key, roundHours2((loggedHoursByTutorDate.get(key) ?? 0) + loggedHours));
  }

  const timeInOutByTutorDate = buildTimeInOutByTutorDate(approvedDays, sessionsByDay, timezone);
  const keys = new Set<string>([...loggedHoursByTutorDate.keys(), ...crmHoursByTutorDate.keys()]);

  const rows = Array.from(keys)
    .map((key) => {
      const splitIndex = key.indexOf(':');
      const tutorId = Number(key.slice(0, splitIndex));
      const workDate = key.slice(splitIndex + 1);
      const reportedCrmHours = crmHoursByTutorDate.get(key) ?? 0;
      const loggedHours = loggedHoursByTutorDate.get(key) ?? 0;
      const name = namesById.get(tutorId) ?? { firstName: '', lastName: '' };
      return {
        tutorId,
        firstName: name.firstName,
        lastName: name.lastName,
        workDate,
        reportedCrmHours,
        loggedHours,
        diff: roundHours2(loggedHours - reportedCrmHours),
        timeInOut: timeInOutByTutorDate.get(key) ?? ''
      };
    })
    .filter((row) => row.reportedCrmHours > 0 || row.loggedHours > 0);

  rows.sort((a, b) => compareTutorNames(a, b) || a.workDate.localeCompare(b.workDate));
  return rows;
};

const sanitizeSpreadsheetText = (value: string): string =>
  /^[=+\-@]/.test(value.trimStart()) ? `'${value}` : value;

const csvEscape = (value: string | number): string => {
  const text = String(value);
  if (/[",\n|]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
};

const csvQuote = (value: string): string => `"${value.replace(/"/g, '""')}"`;

const buildAdminExportCsv = (rows: AdminExportRow[]): string => {
  const header = ['Tutor', 'Date', 'Reported CRM Hours', 'Logged Hours', 'Diff', 'Time In / Out'];
  const lines = rows.map((row) => {
    const values = [
      csvEscape(sanitizeSpreadsheetText(`${row.lastName}, ${row.firstName}`)),
      csvEscape(row.workDate),
      csvEscape(row.reportedCrmHours.toFixed(2)),
      csvEscape(row.loggedHours.toFixed(2)),
      csvEscape(row.diff > 0 ? `+${row.diff.toFixed(2)}` : row.diff.toFixed(2)),
      csvQuote(row.timeInOut)
    ];
    return values.join(',');
  });
  return [header.join(','), ...lines].join('\n');
};

const buildAdminExportWorkbook = async (
  summaryRows: AdminComparisonSummaryRow[],
  exportRows: AdminExportRow[]
): Promise<Buffer> => {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Pay Period Review');
  worksheet.properties.outlineLevelRow = 1;

  worksheet.addRow(['Tutor', 'Date', 'Reported CRM Hours', 'Logged Hours', 'Diff', 'Time In / Out']);
  worksheet.getRow(1).font = { bold: true };

  const exportRowsByTutor = new Map<number, AdminExportRow[]>();
  for (const row of exportRows) {
    const list = exportRowsByTutor.get(row.tutorId) ?? [];
    list.push(row);
    exportRowsByTutor.set(row.tutorId, list);
  }

  for (const summaryRow of summaryRows) {
    const tutorName = sanitizeSpreadsheetText(`${summaryRow.lastName}, ${summaryRow.firstName}`);
    const diff = roundHours2(summaryRow.loggedHours - summaryRow.reportedCrmHours);
    const summaryExcelRow = worksheet.addRow([
      tutorName,
      '',
      summaryRow.reportedCrmHours,
      summaryRow.loggedHours,
      diff,
      ''
    ]);
    summaryExcelRow.font = { bold: true };

    for (const detail of exportRowsByTutor.get(summaryRow.tutorId) ?? []) {
      const detailRow = worksheet.addRow([
        '',
        detail.workDate,
        detail.reportedCrmHours,
        detail.loggedHours,
        detail.diff,
        detail.timeInOut
      ]);
      detailRow.outlineLevel = 1;
      detailRow.hidden = true;
    }
  }

  worksheet.columns = [
    { width: 24 },
    { width: 14 },
    { width: 20 },
    { width: 16 },
    { width: 12 },
    { width: 36 }
  ];

  return Buffer.from(await workbook.xlsx.writeBuffer());
};

const buildAdminDailySummaryRows = (
  approvedDays: ApprovedEntryDayRow[],
  sessionsByDay: Map<number, ApprovedEntrySessionRow[]>,
  namesById: Map<number, TutorName>
): AdminDailySummaryRow[] => {
  const groupedTotals = new Map<string, { tutorId: number; workDate: string; totalMinutes: number }>();

  for (const day of approvedDays) {
    const workDate = formatDateOnly(day.work_date);
    if (!workDate) continue;

    const totals = computeRollupTotalsForDays([day], sessionsByDay);
    if (totals.totalMinutes <= 0) continue;

    const key = `${day.tutorid}:${workDate}`;
    const current = groupedTotals.get(key) ?? { tutorId: day.tutorid, workDate, totalMinutes: 0 };
    groupedTotals.set(key, {
      ...current,
      totalMinutes: current.totalMinutes + totals.totalMinutes
    });
  }

  const rows = Array.from(groupedTotals.values()).map((row) => {
    const name = namesById.get(row.tutorId) ?? { firstName: '', lastName: '' };
    return {
      tutorId: row.tutorId,
      firstName: name.firstName,
      lastName: name.lastName,
      workDate: row.workDate,
      totalHours: roundHours2(row.totalMinutes / 60)
    };
  });

  rows.sort((a, b) => compareTutorNames(a, b) || a.workDate.localeCompare(b.workDate));
  return rows;
};

const buildTutorTotalsByTutor = (
  approvedDays: ApprovedEntryDayRow[],
  sessionsByDay: Map<number, ApprovedEntrySessionRow[]>
): Map<number, TutorRollupTotals> => {
  const totalsByTutor = new Map<number, TutorRollupTotals>();

  for (const day of approvedDays) {
    const totals = computeRollupTotalsForDays([day], sessionsByDay);
    const current = totalsByTutor.get(day.tutorid) ?? { tutoringMinutes: 0, extraMinutes: 0, totalMinutes: 0 };
    totalsByTutor.set(day.tutorid, {
      tutoringMinutes: current.tutoringMinutes + totals.tutoringMinutes,
      extraMinutes: current.extraMinutes + totals.extraMinutes,
      totalMinutes: current.totalMinutes + totals.totalMinutes
    });
  }

  return totalsByTutor;
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
      const totalsByTutor = buildTutorTotalsByTutor(approvedDays, sessionsByDay);
      const loggedHoursByTutor = buildLoggedHoursByTutor(totalsByTutor);
      const crmHoursByTutor = await fetchReportedCrmHoursByTutor(franchiseId, payPeriod);
      const tutorIds = Array.from(new Set([...loggedHoursByTutor.keys(), ...crmHoursByTutor.keys()]));
      const namesById = await fetchTutorNamesByIds(tutorIds);
      const rows = buildAdminComparisonSummaryRows(loggedHoursByTutor, crmHoursByTutor, namesById);

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
      const totalsByTutor = buildTutorTotalsByTutor(approvedDays, sessionsByDay);
      const tutorIds = Array.from(totalsByTutor.keys());
      const namesById = await fetchTutorNamesByIds(tutorIds);
      const rows = buildAdminLegacySummaryRows(totalsByTutor, namesById, true);

      res.status(200).json({ payPeriod, rows });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  '/hours/admin/pay-period/summary-legacy-export',
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
      const totalsByTutor = buildTutorTotalsByTutor(approvedDays, sessionsByDay);
      const tutorIds = Array.from(totalsByTutor.keys());
      const namesById = await fetchTutorNamesByIds(tutorIds);
      const rows = buildAdminLegacySummaryRows(totalsByTutor, namesById, true);

      res.status(200).json({ payPeriod, rows });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  '/hours/admin/pay-period/summary-detail',
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

    const tutorIdRaw = Number((req.query as Record<string, unknown>).tutorId);
    if (!Number.isInteger(tutorIdRaw)) {
      invalidTutorId(res);
      return;
    }

    try {
      const payPeriod = await resolvePayPeriod(franchiseId, forDate);
      const approvedDays = await fetchApprovedDaysForTutor(franchiseId, tutorIdRaw, payPeriod.startDate, payPeriod.endDate);
      const sessionsByDay = await fetchSessionsByDayIds(approvedDays.map((day) => day.id));
      const loggedHoursByDate = buildLoggedHoursByDate(approvedDays, sessionsByDay);
      const crmHoursByDate = await fetchReportedCrmHoursByDate(franchiseId, tutorIdRaw, payPeriod);
      const rows = buildAdminSummaryDetailRows(loggedHoursByDate, crmHoursByDate);

      res.status(200).json({ payPeriod, rows });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  '/hours/admin/pay-period/export',
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

    const format = typeof (req.query as Record<string, unknown>).format === 'string'
      ? String((req.query as Record<string, unknown>).format).toLowerCase()
      : 'xlsx';
    if (format !== 'xlsx' && format !== 'csv') {
      invalidExportFormat(res);
      return;
    }

    try {
      const payPeriod = await resolvePayPeriod(franchiseId, forDate);
      const approvedDays = await fetchApprovedDaysForFranchise(franchiseId, payPeriod.startDate, payPeriod.endDate);
      if (approvedDays.length > MAX_PAY_PERIOD_EXPORT_DETAIL_ROWS) {
        exportTooLarge(res);
        return;
      }

      const sessionsByDay = await fetchSessionsByDayIds(approvedDays.map((day) => day.id));
      const totalsByTutor = buildTutorTotalsByTutor(approvedDays, sessionsByDay);
      const loggedHoursByTutor = buildLoggedHoursByTutor(totalsByTutor);
      const crmHoursByTutor = await fetchReportedCrmHoursByTutor(franchiseId, payPeriod);
      const crmHoursByTutorDate = await fetchReportedCrmHoursByTutorDate(franchiseId, payPeriod);
      if (crmHoursByTutorDate.size > MAX_PAY_PERIOD_EXPORT_DETAIL_ROWS) {
        exportTooLarge(res);
        return;
      }

      const tutorIds = Array.from(
        new Set([
          ...loggedHoursByTutor.keys(),
          ...crmHoursByTutor.keys(),
          ...Array.from(crmHoursByTutorDate.keys()).map((key) => Number(key.split(':', 1)[0]))
        ])
      );
      const namesById = await fetchTutorNamesByIds(tutorIds);
      const summaryRows = buildAdminComparisonSummaryRows(loggedHoursByTutor, crmHoursByTutor, namesById);
      const exportRows = buildAdminExportRows(approvedDays, sessionsByDay, crmHoursByTutorDate, namesById, payPeriod.timezone);
      if (exportRows.length > MAX_PAY_PERIOD_EXPORT_DETAIL_ROWS) {
        exportTooLarge(res);
        return;
      }

      if (format === 'csv') {
        const csvContent = buildAdminExportCsv(exportRows);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="pay-period-review.csv"');
        res.status(200).send(csvContent);
        return;
      }

      const workbookBuffer = await buildAdminExportWorkbook(summaryRows, exportRows);
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      res.setHeader('Content-Disposition', 'attachment; filename="pay-period-review.xlsx"');
      res.status(200).send(workbookBuffer);
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  '/hours/admin/pay-period/summary-daily',
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
      const namesById = await fetchTutorNamesByIds(approvedDays.map((day) => day.tutorid));
      const rows = buildAdminDailySummaryRows(approvedDays, sessionsByDay, namesById);

      res.status(200).json({ payPeriod, rows });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
