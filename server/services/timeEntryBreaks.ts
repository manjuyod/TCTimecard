import type { Pool, PoolClient } from 'pg';
import { DateTime } from 'luxon';

export const BREAK_TYPES = ['lunch', 'rest_break', 'personal', 'training', 'travel', 'other'] as const;
export const PAY_TREATMENTS = ['paid', 'unpaid'] as const;
export const BREAK_SOURCES = ['employee', 'manager', 'auto_rule', 'import'] as const;
export const BREAK_STATUSES = ['active', 'completed', 'voided'] as const;

export type BreakType = (typeof BREAK_TYPES)[number];
export type PayTreatment = (typeof PAY_TREATMENTS)[number];
export type BreakSource = (typeof BREAK_SOURCES)[number];
export type BreakStatus = (typeof BREAK_STATUSES)[number];

export type TimeEntryBreakForTotals = {
  payTreatment: PayTreatment;
  status: BreakStatus;
  durationMinutes: number;
};

export type TimeEntryBreakRow = {
  id: number;
  entry_day_id: number;
  time_entry_session_id: number | null;
  franchiseid: number;
  tutorid: number;
  break_type: BreakType;
  pay_treatment: PayTreatment;
  start_time: string | Date | null;
  end_time: string | Date | null;
  duration_minutes: number;
  source: BreakSource;
  status: BreakStatus;
  note: string | null;
  created_at: string | Date;
  updated_at: string | Date;
};

export type TimeEntryBreakResponse = {
  id: number;
  entryDayId: number;
  timeEntrySessionId: number | null;
  breakType: BreakType;
  payTreatment: PayTreatment;
  startTime: string | null;
  endTime: string | null;
  durationMinutes: number;
  source: BreakSource;
  status: BreakStatus;
  note: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TimeEntrySessionWindow = {
  id: number;
  startAt: string | Date;
  endAt: string | Date | null;
};

export type ExistingBreakWindow = {
  id?: number;
  timeEntrySessionId?: number | null;
  startTime?: string | Date | null;
  endTime?: string | Date | null;
  status: BreakStatus;
};

type Queryable = Pick<Pool | PoolClient, 'query'>;

export const isBreakType = (value: unknown): value is BreakType =>
  typeof value === 'string' && (BREAK_TYPES as readonly string[]).includes(value);

export const isPayTreatment = (value: unknown): value is PayTreatment =>
  typeof value === 'string' && (PAY_TREATMENTS as readonly string[]).includes(value);

export const isBreakSource = (value: unknown): value is BreakSource =>
  typeof value === 'string' && (BREAK_SOURCES as readonly string[]).includes(value);

export const isBreakStatus = (value: unknown): value is BreakStatus =>
  typeof value === 'string' && (BREAK_STATUSES as readonly string[]).includes(value);

const toEpochMinute = (value: string | Date | null | undefined): number | null => {
  if (!value) return null;
  const dt = value instanceof Date ? DateTime.fromJSDate(value, { zone: 'utc' }) : DateTime.fromISO(value, { setZone: true });
  if (!dt.isValid || dt.second !== 0 || dt.millisecond !== 0) return null;
  return Math.floor(dt.toUTC().toMillis() / 60000);
};

const toIso = (value: string | Date | null): string | null => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString();
};

export const computeBreakMinuteTotals = (
  breaks: TimeEntryBreakForTotals[]
): { paidBreakMinutes: number; unpaidBreakMinutes: number } => {
  let paidBreakMinutes = 0;
  let unpaidBreakMinutes = 0;

  for (const item of breaks) {
    if (item.status !== 'completed') continue;
    const duration = Number(item.durationMinutes);
    if (!Number.isFinite(duration) || duration <= 0) continue;

    if (item.payTreatment === 'paid') {
      paidBreakMinutes += duration;
    } else {
      unpaidBreakMinutes += duration;
    }
  }

  return { paidBreakMinutes, unpaidBreakMinutes };
};

export const getDefaultPayTreatment = (
  breakType: BreakType,
  policy?: Partial<Record<'lunch' | 'other', PayTreatment>>
): PayTreatment => {
  if (breakType === 'lunch') return policy?.lunch ?? 'unpaid';
  if (breakType === 'rest_break') return 'paid';
  if (breakType === 'personal') return 'unpaid';
  if (breakType === 'training') return 'paid';
  if (breakType === 'travel') return 'paid';
  return policy?.other ?? 'unpaid';
};

export const computeDurationMinutes = (startTime: string | Date, endTime: string | Date): number | null => {
  const startMinute = toEpochMinute(startTime);
  const endMinute = toEpochMinute(endTime);
  if (startMinute === null || endMinute === null || endMinute <= startMinute) return null;
  return endMinute - startMinute;
};

export const validateBreakWindow = (params: {
  session: TimeEntrySessionWindow;
  startTime: string | Date;
  endTime: string | Date;
  existingBreaks: ExistingBreakWindow[];
  ignoreBreakId?: number;
}): { ok: true; durationMinutes: number } | { ok: false; error: string } => {
  const sessionStart = toEpochMinute(params.session.startAt);
  const sessionEnd = toEpochMinute(params.session.endAt);
  const startMinute = toEpochMinute(params.startTime);
  const endMinute = toEpochMinute(params.endTime);

  if (sessionStart === null || sessionEnd === null) {
    return { ok: false, error: 'Parent session must have valid start/end times.' };
  }
  if (startMinute === null || endMinute === null) {
    return { ok: false, error: 'Break start/end must be ISO timestamps aligned to the minute.' };
  }
  if (endMinute <= startMinute) {
    return { ok: false, error: 'Break end must be after break start.' };
  }
  if (startMinute < sessionStart || endMinute > sessionEnd) {
    return { ok: false, error: 'Break start/end must fall within the parent shift.' };
  }

  for (const existing of params.existingBreaks) {
    if (existing.id !== undefined && existing.id === params.ignoreBreakId) continue;
    if (existing.status === 'voided') continue;
    if (
      existing.timeEntrySessionId !== undefined &&
      existing.timeEntrySessionId !== null &&
      existing.timeEntrySessionId !== params.session.id
    ) {
      continue;
    }
    const existingStart = toEpochMinute(existing.startTime);
    const existingEnd = toEpochMinute(existing.endTime);
    if (existingStart === null || existingEnd === null) continue;
    if (startMinute < existingEnd && endMinute > existingStart) {
      return { ok: false, error: 'Breaks cannot overlap for the same shift.' };
    }
  }

  return { ok: true, durationMinutes: endMinute - startMinute };
};

export const mapBreakRowToResponse = (row: TimeEntryBreakRow): TimeEntryBreakResponse => ({
  id: row.id,
  entryDayId: row.entry_day_id,
  timeEntrySessionId: row.time_entry_session_id,
  breakType: row.break_type,
  payTreatment: row.pay_treatment,
  startTime: toIso(row.start_time),
  endTime: toIso(row.end_time),
  durationMinutes: Number(row.duration_minutes),
  source: row.source,
  status: row.status,
  note: row.note,
  createdAt: toIso(row.created_at) ?? new Date().toISOString(),
  updatedAt: toIso(row.updated_at) ?? new Date().toISOString()
});

export const fetchBreaksByDayIds = async (
  db: Queryable,
  dayIds: number[]
): Promise<Map<number, TimeEntryBreakRow[]>> => {
  const breaksByDay = new Map<number, TimeEntryBreakRow[]>();
  if (!dayIds.length) return breaksByDay;

  const result = await db.query<TimeEntryBreakRow>(
    `
      SELECT
        id,
        entry_day_id,
        time_entry_session_id,
        franchiseid,
        tutorid,
        break_type,
        pay_treatment,
        start_time,
        end_time,
        duration_minutes,
        source,
        status,
        note,
        created_at,
        updated_at
      FROM public.time_entry_breaks
      WHERE entry_day_id = ANY($1::int[])
      ORDER BY entry_day_id ASC, start_time ASC NULLS LAST, id ASC
    `,
    [dayIds]
  );

  for (const row of result.rows ?? []) {
    const list = breaksByDay.get(row.entry_day_id) ?? [];
    list.push(row);
    breaksByDay.set(row.entry_day_id, list);
  }

  return breaksByDay;
};
