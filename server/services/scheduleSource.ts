import { DateTime } from 'luxon';
import { getMssqlPool, sql } from '../db/mssql';
import {
  deriveIntervalsFromEntries,
  getScheduleSlotMinutes,
  getScheduleSnapshotSigningSecret,
  normalizeScheduleTimeLabel,
  signScheduleSnapshot,
  type ScheduleSnapshotEntry,
  type ScheduleSnapshotV1
} from './scheduleSnapshot';

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

export interface ScheduleCandidate {
  franchiseId: number;
  tutorId: number;
  workDate: string;
  timezone: string;
}

export const scheduleCandidateKey = (candidate: ScheduleCandidate): string =>
  `${candidate.franchiseId}:${candidate.tutorId}:${candidate.workDate}`;

const formatScheduleDate = (value: unknown): string | null => {
  if (value instanceof Date) {
    return DateTime.fromJSDate(value, { zone: 'utc' }).toISODate();
  }

  if (typeof value === 'string') {
    const parsed = DateTime.fromISO(value, { zone: 'utc' });
    return parsed.isValid ? parsed.toISODate() : null;
  }

  return null;
};

const scheduleNumber = (value: unknown): number => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};

const hasValidExplicitRange = (timeLabel: string, timezone: string): boolean => {
  const normalizedLabel = timeLabel.replace(/[–—]/g, '-').trim();
  const parts = normalizedLabel.split(/\s*-\s*/);
  if (parts.length === 1) return true;
  if (parts.length !== 2) return false;

  const formats = ['h:mm a', 'h:mma', 'h a', 'ha', 'H:mm', 'HH:mm', 'H:mm:ss', 'HH:mm:ss'];
  return parts.every((part) =>
    formats.some((format) => DateTime.fromFormat(part, format, { zone: timezone, setZone: true }).isValid)
  );
};

export const fetchCalendarEntries = async (
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
    const scheduleDate = formatScheduleDate((row as Record<string, unknown>).ScheduleDate);
    if (!scheduleDate) continue;

    const timeId = scheduleNumber((row as Record<string, unknown>).TimeID);
    const timeLabel = normalizeScheduleTimeLabel((row as Record<string, unknown>).TimeLabel);

    entries.push({ scheduleDate, timeId, timeLabel });
  }

  return entries;
};

export const fetchLatestScheduleSnapshots = async (
  candidates: ScheduleCandidate[],
  issuedAt: Date = new Date()
): Promise<Map<string, ScheduleSnapshotV1>> => {
  const uniqueCandidates = new Map<string, ScheduleCandidate>();
  for (const candidate of candidates) {
    const key = scheduleCandidateKey(candidate);
    if (!uniqueCandidates.has(key)) uniqueCandidates.set(key, candidate);
  }

  if (uniqueCandidates.size === 0) return new Map();

  const pool = await getMssqlPool();
  const request = pool.request();
  const valueTuples: string[] = [];
  let index = 0;

  for (const candidate of uniqueCandidates.values()) {
    request.input(`p_franchise_${index}`, sql.Int, candidate.franchiseId);
    request.input(`p_tutor_${index}`, sql.Int, candidate.tutorId);
    request.input(`p_date_${index}`, sql.Date, candidate.workDate);
    valueTuples.push(`(@p_franchise_${index}, @p_tutor_${index}, CAST(@p_date_${index} AS DATE))`);
    index += 1;
  }

  const query = `
WITH ActiveTutors AS (
  SELECT * FROM (VALUES
    ${valueTuples.join(',\n    ')}
  ) AS requested(FranchiseID, TutorID, WorkDate)
)
SELECT
  requested.FranchiseID,
  requested.TutorID,
  requested.WorkDate,
  schedule.TimeID,
  times.Time AS TimeLabel
FROM ActiveTutors requested
JOIN dbo.tblSessionSchedule schedule
  ON schedule.FranchiseID = requested.FranchiseID
 AND schedule.TutorID = requested.TutorID
 AND schedule.ScheduleDate = requested.WorkDate
JOIN dbo.tblTimes times ON schedule.TimeID = times.ID
GROUP BY requested.FranchiseID, requested.TutorID, requested.WorkDate,
         schedule.TimeID, times.Time
ORDER BY requested.FranchiseID, requested.TutorID, schedule.TimeID;
`;

  const result = await request.query(query);
  const entriesByCandidate = new Map<string, ScheduleSnapshotEntry[]>();

  for (const row of result.recordset ?? []) {
    const record = row as Record<string, unknown>;
    const workDate = formatScheduleDate(record.WorkDate);
    if (!workDate) continue;

    const key = scheduleCandidateKey({
      franchiseId: scheduleNumber(record.FranchiseID),
      tutorId: scheduleNumber(record.TutorID),
      workDate,
      timezone: ''
    });
    if (!uniqueCandidates.has(key)) continue;

    const entries = entriesByCandidate.get(key) ?? [];
    entries.push({
      timeId: scheduleNumber(record.TimeID),
      timeLabel: normalizeScheduleTimeLabel(record.TimeLabel)
    });
    entriesByCandidate.set(key, entries);
  }

  const slotMinutes = getScheduleSlotMinutes();
  const signingSecret = getScheduleSnapshotSigningSecret();
  const issuedAtISO = issuedAt.toISOString();
  const snapshots = new Map<string, ScheduleSnapshotV1>();

  for (const [key, candidate] of uniqueCandidates) {
    const entries = entriesByCandidate.get(key) ?? [];
    const intervalEntries = entries.filter((entry) => hasValidExplicitRange(entry.timeLabel, candidate.timezone));
    const baseSnapshot: ScheduleSnapshotV1 = {
      version: 1,
      franchiseId: candidate.franchiseId,
      tutorId: candidate.tutorId,
      workDate: candidate.workDate,
      timezone: candidate.timezone,
      slotMinutes,
      entries,
      intervals: deriveIntervalsFromEntries({
        workDate: candidate.workDate,
        timezone: candidate.timezone,
        slotMinutes,
        entries: intervalEntries
      }),
      issuedAt: issuedAtISO
    };

    snapshots.set(key, signingSecret ? signScheduleSnapshot(baseSnapshot, signingSecret) : baseSnapshot);
  }

  return snapshots;
};
