import express, { NextFunction, Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { DateTime } from 'luxon';
import { getMssqlPool, sql } from '../db/mssql';
import { getPostgresPool } from '../db/postgres';
import { requireAdmin, requireTutor } from '../middleware/auth';
import { enforceFranchiseScope } from '../middleware/franchiseScope';
import { resolvePayPeriod } from '../payroll/payPeriodResolution';
import {
  getScheduleSnapshotSigningSecret,
  parseScheduleSnapshotV1,
  verifyScheduleSnapshot
} from '../services/scheduleSnapshot';
import { enforcePriorWeekAttestation } from '../services/weeklyAttestationGate';
import { computeTimeEntryComparisonV1, parseTimestamptzMinute, toEpochMinute } from '../services/timeEntryComparison';
import {
  applyAutoLunchBreak,
  computeBreakMinuteTotals,
  computeDurationMinutes,
  fetchBreaksByDayIds,
  getDefaultPayTreatment,
  isBreakType,
  isPayTreatment,
  mapBreakRowToResponse,
  validateBreakWindow,
  type BreakType,
  type PayTreatment,
  type TimeEntryBreakRow,
  type TimeEntrySessionWindow
} from '../services/timeEntryBreaks';

type TimeEntryStatus = 'draft' | 'pending' | 'approved' | 'denied';

type TimeEntryDayRow = {
  id: number;
  franchiseid: number;
  tutorid: number;
  work_date: string;
  timezone: string;
  status: TimeEntryStatus;
  schedule_snapshot: unknown | null;
  comparison: unknown | null;
  submitted_at: string | null;
  decided_by: number | null;
  decided_at: string | null;
  decision_reason: string | null;
  created_at: string;
  updated_at: string;
};

type TimeEntrySessionRow = {
  id: number;
  entry_day_id: number;
  start_at: string;
  end_at: string;
  sort_order: number;
};

type TimeEntryAuditSummaryRow = {
  entry_day_id: number;
  action: string;
  actor_account_type: string;
  actor_account_id: number | null;
  at: string;
  previous_status: string | null;
  new_status: string;
};

type TimeEntryBreakPayload = {
  breakType: BreakType;
  payTreatment: PayTreatment;
  startTime: string | null;
  endTime: string | null;
  durationMinutes: number | null;
  note: string | null;
  timeEntrySessionId: number | null;
};

type TutorIdentity = { tutorId: number; name: string; email: string };

const router = express.Router();

const notFound = (res: Response) => res.status(404).json({ error: 'Not found' });
const missingFranchise = (res: Response) => res.status(400).json({ error: 'franchiseId is required for tutor requests' });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseIsoDateOnly = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const dt = DateTime.fromISO(trimmed, { zone: 'UTC', setZone: true });
  if (!dt.isValid) return null;

  return dt.toISODate() ?? null;
};

const normalizeWorkDate = (value: unknown): string | null => {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return DateTime.fromJSDate(value, { zone: 'UTC' }).toISODate();
  }
  const parsed = parseIsoDateOnly(value);
  if (parsed) return parsed;
  if (typeof value !== 'string') return null;
  const fallback = DateTime.fromISO(value, { zone: 'UTC' }).toISODate();
  return fallback ?? null;
};

const parseLimit = (value: unknown, defaultValue: number, maxValue: number): number => {
  const parsed = typeof value === 'string' || typeof value === 'number' ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed <= 0) return defaultValue;
  return Math.min(parsed, maxValue);
};

const getTutorContext = (req: Request): { tutorId: number; franchiseId: number; displayName: string } | null => {
  const auth = req.session.auth;
  if (!auth) return null;

  const tutorId = Number(auth.accountId);
  const franchiseId = Number(auth.franchiseId);
  if (!Number.isFinite(tutorId) || !Number.isFinite(franchiseId)) return null;

  return { tutorId, franchiseId, displayName: auth.displayName ?? '' };
};

const getAdminContext = (req: Request): { adminId: number } | null => {
  const auth = req.session.auth;
  if (!auth) return null;
  const adminId = Number(auth.accountId);
  if (!Number.isFinite(adminId)) return null;
  return { adminId };
};

const parseIdParam = (value: unknown): number | null => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
};

const fetchTutorsByIds = async (tutorIds: number[]): Promise<Map<number, TutorIdentity>> => {
  if (!tutorIds.length) return new Map();

  const uniqueIds = Array.from(new Set(tutorIds.filter((id) => Number.isFinite(id)))) as number[];
  if (!uniqueIds.length) return new Map();

  const paramNames = uniqueIds.map((_, idx) => `tutor_${idx}`);
  const placeholders = paramNames.map((name) => `@${name}`).join(', ');
  const query = `
    SELECT ID, FirstName, LastName, Email
    FROM dbo.tblTutors
    WHERE ID IN (${placeholders}) AND IsDeleted = 0
  `;

  const pool = await getMssqlPool();
  const request = pool.request();
  uniqueIds.forEach((id, idx) => request.input(paramNames[idx], sql.Int, id));

  const result = await request.query(query);
  const map = new Map<number, TutorIdentity>();

  for (const row of result.recordset ?? []) {
    const tutorId = Number((row as Record<string, unknown>).ID);
    if (!Number.isFinite(tutorId)) continue;

    const firstNameRaw = (row as Record<string, unknown>).FirstName;
    const lastNameRaw = (row as Record<string, unknown>).LastName;
    const emailRaw = (row as Record<string, unknown>).Email;

    const firstName = firstNameRaw !== undefined && firstNameRaw !== null ? String(firstNameRaw) : '';
    const lastName = lastNameRaw !== undefined && lastNameRaw !== null ? String(lastNameRaw) : '';
    const email = emailRaw !== undefined && emailRaw !== null ? String(emailRaw) : '';
    const name = `${firstName} ${lastName}`.trim();

    map.set(tutorId, { tutorId, name, email });
  }

  return map;
};

const fetchDayByWorkDate = async (
  client: PoolClient,
  franchiseId: number,
  tutorId: number,
  workDate: string
): Promise<TimeEntryDayRow | null> => {
  const result = await client.query<TimeEntryDayRow>(
    `
      SELECT
        id,
        franchiseid,
        tutorid,
        work_date,
        timezone,
        status,
        schedule_snapshot,
        comparison,
        submitted_at,
        decided_by,
        decided_at,
        decision_reason,
        created_at,
        updated_at
      FROM public.time_entry_days
      WHERE franchiseid = $1
        AND tutorid = $2
        AND work_date = $3
      LIMIT 1
    `,
    [franchiseId, tutorId, workDate]
  );

  return result.rowCount ? result.rows[0] : null;
};

const fetchSessionsByDayId = async (client: PoolClient, dayId: number): Promise<TimeEntrySessionRow[]> => {
  const result = await client.query<TimeEntrySessionRow>(
    `
      SELECT id, entry_day_id, start_at, end_at, sort_order
      FROM public.time_entry_sessions
      WHERE entry_day_id = $1
        AND end_at IS NOT NULL
      ORDER BY sort_order ASC, start_at ASC
    `,
    [dayId]
  );

  return result.rows ?? [];
};

const buildBreakSummary = (sessions: TimeEntrySessionRow[], breaks: TimeEntryBreakRow[]) => {
  const grossMinutes = sessions.reduce((total, row) => {
    const startMinute = toEpochMinute(new Date(row.start_at).toISOString());
    const endMinute = toEpochMinute(new Date(row.end_at).toISOString());
    if (startMinute === null || endMinute === null || endMinute <= startMinute) return total;
    return total + endMinute - startMinute;
  }, 0);
  const { paidBreakMinutes, unpaidBreakMinutes } = computeBreakMinuteTotals(
    breaks.map((row) => ({
      payTreatment: row.pay_treatment,
      status: row.status,
      durationMinutes: Number(row.duration_minutes)
    }))
  );

  return {
    grossMinutes,
    paidBreakMinutes,
    unpaidBreakMinutes,
    paidMinutes: Math.max(0, grossMinutes - unpaidBreakMinutes)
  };
};

const fetchBreaksByDayId = async (client: PoolClient, dayId: number): Promise<TimeEntryBreakRow[]> =>
  (await fetchBreaksByDayIds(client, [dayId])).get(dayId) ?? [];

const appendAudit = async (client: PoolClient, entry: {
  dayId: number;
  action:
    | 'created'
    | 'saved'
    | 'clock_in'
    | 'clock_out'
    | 'submitted'
    | 'approved'
    | 'denied'
    | 'invalidated'
    | 'admin_fixed'
    | 'admin_edited'
    | 'break_created'
    | 'break_updated'
    | 'break_voided'
    | 'auto_break_applied'
    | 'auto_approved';
  actorAccountType: 'TUTOR' | 'ADMIN' | 'SYSTEM';
  actorAccountId: number | null;
  previousStatus: TimeEntryStatus | null;
  newStatus: TimeEntryStatus;
  metadata?: Record<string, unknown>;
}): Promise<void> => {
  await client.query(
    `
      INSERT INTO public.time_entry_audit
        (entry_day_id, action, actor_account_type, actor_account_id, at, previous_status, new_status, metadata)
      VALUES ($1, $2, $3, $4, NOW(), $5, $6, $7)
    `,
    [
      entry.dayId,
      entry.action,
      entry.actorAccountType,
      entry.actorAccountId,
      entry.previousStatus,
      entry.newStatus,
      entry.metadata ?? {}
    ]
  );
};

const mapDayRowToResponse = (
  day: TimeEntryDayRow,
  sessions: TimeEntrySessionRow[],
  breaks: TimeEntryBreakRow[] = []
) => ({
  id: day.id,
  franchiseId: day.franchiseid,
  tutorId: day.tutorid,
  workDate: normalizeWorkDate(day.work_date) ?? String(day.work_date ?? ''),
  timezone: day.timezone,
  status: day.status,
  scheduleSnapshot: day.schedule_snapshot,
  comparison: day.comparison,
  submittedAt: day.submitted_at ? new Date(day.submitted_at).toISOString() : null,
  decidedBy: day.decided_by,
  decidedAt: day.decided_at ? new Date(day.decided_at).toISOString() : null,
  decisionReason: day.decision_reason,
  sessions: sessions.map((row) => ({
    startAt: new Date(row.start_at).toISOString(),
    endAt: new Date(row.end_at).toISOString(),
    sortOrder: row.sort_order
  })),
  breaks: breaks.map(mapBreakRowToResponse),
  breakSummary: buildBreakSummary(sessions, breaks)
});

const parseBreakPayload = (
  body: Record<string, unknown>,
  options: { requireWindowOrDuration: boolean; defaultSource?: 'employee' | 'manager' }
): { ok: true; payload: TimeEntryBreakPayload } | { ok: false; error: string } => {
  const breakTypeRaw = body.breakType ?? body.break_type;
  if (!isBreakType(breakTypeRaw)) {
    return { ok: false, error: 'breakType is required and must be lunch, rest_break, personal, training, travel, or other.' };
  }

  const payTreatmentRaw = body.payTreatment ?? body.pay_treatment;
  const payTreatment = isPayTreatment(payTreatmentRaw) ? payTreatmentRaw : getDefaultPayTreatment(breakTypeRaw);

  const startRaw = body.startTime ?? body.start_time;
  const endRaw = body.endTime ?? body.end_time;
  const startTime = startRaw === undefined || startRaw === null || startRaw === '' ? null : parseTimestamptzMinute(startRaw);
  const endTime = endRaw === undefined || endRaw === null || endRaw === '' ? null : parseTimestamptzMinute(endRaw);
  if ((startRaw !== undefined && startRaw !== null && startRaw !== '' && !startTime) || (endRaw !== undefined && endRaw !== null && endRaw !== '' && !endTime)) {
    return { ok: false, error: 'Break start/end must be ISO timestamps with timezone offset, aligned to the minute.' };
  }

  const durationRaw = body.durationMinutes ?? body.duration_minutes;
  const durationMinutes =
    durationRaw === undefined || durationRaw === null || durationRaw === '' ? null : Number(durationRaw);
  if (durationMinutes !== null && (!Number.isInteger(durationMinutes) || durationMinutes <= 0)) {
    return { ok: false, error: 'durationMinutes must be a positive integer.' };
  }

  const sessionIdRaw = body.timeEntrySessionId ?? body.time_entry_session_id;
  const timeEntrySessionId =
    sessionIdRaw === undefined || sessionIdRaw === null || sessionIdRaw === '' ? null : Number(sessionIdRaw);
  if (timeEntrySessionId !== null && (!Number.isInteger(timeEntrySessionId) || timeEntrySessionId <= 0)) {
    return { ok: false, error: 'timeEntrySessionId must be a positive integer.' };
  }

  const noteRaw = body.note;
  const note = typeof noteRaw === 'string' && noteRaw.trim() ? noteRaw.trim().slice(0, 2000) : null;

  if (options.requireWindowOrDuration && ((!startTime || !endTime) && durationMinutes === null)) {
    return { ok: false, error: 'Break requires start/end times or durationMinutes.' };
  }

  return {
    ok: true,
    payload: {
      breakType: breakTypeRaw,
      payTreatment,
      startTime,
      endTime,
      durationMinutes,
      note,
      timeEntrySessionId
    }
  };
};

const resolveBreakSession = (
  sessions: TimeEntrySessionRow[],
  payload: Pick<TimeEntryBreakPayload, 'startTime' | 'endTime' | 'timeEntrySessionId'>,
  existingBreaks: TimeEntryBreakRow[],
  ignoreBreakId?: number
): { ok: true; session: TimeEntrySessionRow; durationMinutes: number } | { ok: false; error: string } => {
  if (!payload.startTime || !payload.endTime) {
    return { ok: false, error: 'Break startTime and endTime are required for timed breaks.' };
  }

  const candidateSessions = payload.timeEntrySessionId
    ? sessions.filter((session) => session.id === payload.timeEntrySessionId)
    : sessions;
  if (!candidateSessions.length) {
    return { ok: false, error: 'Parent shift session was not found for this break.' };
  }

  for (const session of candidateSessions) {
    const validation = validateBreakWindow({
      session: { id: session.id, startAt: session.start_at, endAt: session.end_at } satisfies TimeEntrySessionWindow,
      startTime: payload.startTime,
      endTime: payload.endTime,
      existingBreaks: existingBreaks.map((item) => ({
        id: item.id,
        timeEntrySessionId: item.time_entry_session_id,
        startTime: item.start_time,
        endTime: item.end_time,
        status: item.status
      })),
      ignoreBreakId
    });
    if (validation.ok) {
      return { ok: true, session, durationMinutes: validation.durationMinutes };
    }
  }

  return { ok: false, error: 'Break start/end must fall within one parent shift and not overlap another break.' };
};

const insertBreak = async (
  client: PoolClient,
  args: {
    day: TimeEntryDayRow;
    sessionId: number | null;
    payload: TimeEntryBreakPayload;
    durationMinutes: number;
    source: 'employee' | 'manager';
  }
): Promise<TimeEntryBreakRow> => {
  const inserted = await client.query<TimeEntryBreakRow>(
    `
      INSERT INTO public.time_entry_breaks
        (
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
        )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'completed', $11, NOW(), NOW())
      RETURNING
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
    `,
    [
      args.day.id,
      args.sessionId,
      args.day.franchiseid,
      args.day.tutorid,
      args.payload.breakType,
      args.payload.payTreatment,
      args.payload.startTime,
      args.payload.endTime,
      args.durationMinutes,
      args.source,
      args.payload.note
    ]
  );

  return inserted.rows[0];
};

const fetchBreakForDay = async (
  client: PoolClient,
  dayId: number,
  breakId: number
): Promise<TimeEntryBreakRow | null> => {
  const result = await client.query<TimeEntryBreakRow>(
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
      WHERE id = $1
        AND entry_day_id = $2
      LIMIT 1
      FOR UPDATE
    `,
    [breakId, dayId]
  );

  return result.rowCount ? result.rows[0] : null;
};

const updateDayAfterBreakMutation = async (
  client: PoolClient,
  day: TimeEntryDayRow,
  sessions: TimeEntrySessionRow[],
  breaks: TimeEntryBreakRow[]
): Promise<TimeEntryDayRow> => {
  const snapshot = parseScheduleSnapshotV1(day.schedule_snapshot);
  let comparison = day.comparison;
  if (snapshot) {
    const computed = computeTimeEntryComparisonV1({
      sessions: sessions.map((row) => ({
        startAt: new Date(row.start_at).toISOString(),
        endAt: new Date(row.end_at).toISOString()
      })),
      breaks: breaks.map((row) => ({
        payTreatment: row.pay_treatment,
        status: row.status,
        durationMinutes: Number(row.duration_minutes)
      })),
      snapshotIntervals: snapshot.intervals
    });
    if (computed.ok) {
      comparison = computed.comparison;
    }
  }

  const nextStatus: TimeEntryStatus = day.status === 'approved' || day.status === 'denied' ? 'pending' : day.status;
  const updated = await client.query<TimeEntryDayRow>(
    `
      UPDATE public.time_entry_days
      SET status = $1,
          comparison = $2,
          submitted_at = CASE WHEN $1 = 'pending' THEN COALESCE(submitted_at, NOW()) ELSE submitted_at END,
          decided_by = CASE WHEN $1 = 'pending' THEN NULL ELSE decided_by END,
          decided_at = CASE WHEN $1 = 'pending' THEN NULL ELSE decided_at END,
          decision_reason = CASE WHEN $1 = 'pending' THEN NULL ELSE decision_reason END,
          updated_at = NOW()
      WHERE id = $3
      RETURNING
        id,
        franchiseid,
        tutorid,
        work_date,
        timezone,
        status,
        schedule_snapshot,
        comparison,
        submitted_at,
        decided_by,
        decided_at,
        decision_reason,
        created_at,
        updated_at
    `,
    [nextStatus, comparison, day.id]
  );

  return updated.rows[0];
};

router.get(
  '/time-entry/me',
  requireTutor,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const context = getTutorContext(req);
    if (!context) {
      missingFranchise(res);
      return;
    }

    const startDate = parseIsoDateOnly((req.query as Record<string, unknown>).start);
    const endDate = parseIsoDateOnly((req.query as Record<string, unknown>).end);
    if (!startDate || !endDate) {
      res.status(400).json({ error: 'start and end must be YYYY-MM-DD' });
      return;
    }

    const limit = parseLimit((req.query as Record<string, unknown>).limit, 366, 366);

    try {
      const pool = getPostgresPool();
      const dayResult = await pool.query<TimeEntryDayRow>(
        `
          SELECT
            id,
            franchiseid,
            tutorid,
            work_date,
            timezone,
            status,
            schedule_snapshot,
            comparison,
            submitted_at,
            decided_by,
            decided_at,
            decision_reason,
            created_at,
            updated_at
          FROM public.time_entry_days
          WHERE franchiseid = $1
            AND tutorid = $2
            AND work_date >= $3
            AND work_date <= $4
          ORDER BY work_date ASC
          LIMIT $5
        `,
        [context.franchiseId, context.tutorId, startDate, endDate, limit]
      );

      const days = dayResult.rows ?? [];
      const ids = days.map((day) => day.id);

      const sessionsByDay = new Map<number, TimeEntrySessionRow[]>();
      if (ids.length) {
        const sessionResult = await pool.query<TimeEntrySessionRow>(
          `
            SELECT id, entry_day_id, start_at, end_at, sort_order
            FROM public.time_entry_sessions
            WHERE entry_day_id = ANY($1::int[])
              AND end_at IS NOT NULL
            ORDER BY entry_day_id ASC, sort_order ASC, start_at ASC
          `,
          [ids]
        );

        for (const row of sessionResult.rows ?? []) {
          const list = sessionsByDay.get(row.entry_day_id) ?? [];
          list.push(row);
          sessionsByDay.set(row.entry_day_id, list);
        }
      }

      const breaksByDay = await fetchBreaksByDayIds(pool, ids);

      res.status(200).json({
        days: days.map((day) => mapDayRowToResponse(day, sessionsByDay.get(day.id) ?? [], breaksByDay.get(day.id) ?? []))
      });
    } catch (err) {
      next(err);
    }
  }
);

router.put(
  '/time-entry/me/day/:workDate',
  requireTutor,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const context = getTutorContext(req);
    if (!context) {
      missingFranchise(res);
      return;
    }

    const workDate = parseIsoDateOnly((req.params as Record<string, unknown>).workDate);
    if (!workDate) {
      res.status(400).json({ error: 'workDate must be YYYY-MM-DD' });
      return;
    }

    const sessionsRaw = (req.body as Record<string, unknown>)?.sessions;
    if (!Array.isArray(sessionsRaw)) {
      res.status(400).json({ error: 'sessions must be an array' });
      return;
    }

    if (sessionsRaw.length > 20) {
      res.status(400).json({ error: 'sessions is too large (max 20)' });
      return;
    }

    try {
      const payPeriod = await resolvePayPeriod(context.franchiseId, workDate);
      const timezone = payPeriod.timezone;

      const attestationGate = await enforcePriorWeekAttestation({
        franchiseId: context.franchiseId,
        tutorId: context.tutorId,
        timezone,
        workDate
      });
      if (!attestationGate.ok && 'error' in attestationGate) {
        res.status(500).json({ error: attestationGate.error });
        return;
      }
      if (!attestationGate.ok) {
        res.status(409).json({
          error: 'Weekly attestation is required before entering time for the new workweek.',
          missingWeekEnd: attestationGate.weekEnd
        });
        return;
      }

      const normalizedSessions = sessionsRaw
        .map((session, idx) => {
          if (!isRecord(session)) return null;
          const startAt = parseTimestamptzMinute(session.startAt);
          const endAt = parseTimestamptzMinute(session.endAt);
          if (!startAt || !endAt) return null;

          const startLocal = DateTime.fromISO(startAt, { zone: 'utc' }).setZone(timezone);
          const endLocal = DateTime.fromISO(endAt, { zone: 'utc' }).setZone(timezone);
          if (!startLocal.isValid || !endLocal.isValid) return null;

          if (startLocal.toISODate() !== workDate) return null;
          if (endLocal.toISODate() !== workDate) return null;

          const startMinute = toEpochMinute(startAt);
          const endMinute = toEpochMinute(endAt);
          if (startMinute === null || endMinute === null) return null;
          if (endMinute <= startMinute) return null;

          return {
            sortOrder: idx,
            startAt,
            endAt,
            startMinute,
            endMinute
          };
        })
        .filter(Boolean) as Array<{
        sortOrder: number;
        startAt: string;
        endAt: string;
        startMinute: number;
        endMinute: number;
      }>;

      if (normalizedSessions.length !== sessionsRaw.length) {
        res.status(400).json({
          error: 'Each session must include startAt/endAt as ISO timestamps with timezone offset, aligned to the minute, within workDate in franchise timezone.'
        });
        return;
      }

      const sorted = normalizedSessions.slice().sort((a, b) => a.startMinute - b.startMinute || a.endMinute - b.endMinute);
      for (let idx = 1; idx < sorted.length; idx += 1) {
        if (sorted[idx].startMinute < sorted[idx - 1].endMinute) {
          res.status(400).json({ error: 'Sessions must not overlap' });
          return;
        }
      }

      const pool = getPostgresPool();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const existing = await fetchDayByWorkDate(client, context.franchiseId, context.tutorId, workDate);
        const previousSessions = existing ? await fetchSessionsByDayId(client, existing.id) : [];

        let day: TimeEntryDayRow;
        let newStatus: TimeEntryStatus = existing?.status ?? 'draft';
        let action: 'created' | 'saved' | 'invalidated' = existing ? 'saved' : 'created';
        let comparison: unknown | null = existing?.comparison ?? null;
        let submittedAtOverride: string | null = null;

        if (existing && (existing.status === 'approved' || existing.status === 'denied')) {
          newStatus = 'pending';
          action = 'invalidated';
          submittedAtOverride = new Date().toISOString();
        }

        if (existing && newStatus === 'pending' && existing.schedule_snapshot) {
          const snapshot = parseScheduleSnapshotV1(existing.schedule_snapshot);
          if (snapshot) {
            const computed = computeTimeEntryComparisonV1({
              sessions: normalizedSessions.map((s) => ({ startAt: s.startAt, endAt: s.endAt })),
              snapshotIntervals: snapshot.intervals
            });
            if (computed.ok) {
              comparison = computed.comparison;
            }
          }
        }

        if (!existing) {
          const inserted = await client.query<TimeEntryDayRow>(
            `
              INSERT INTO public.time_entry_days
                (franchiseid, tutorid, work_date, timezone, status, created_at, updated_at)
              VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
              RETURNING
                id,
                franchiseid,
                tutorid,
                work_date,
                timezone,
                status,
                schedule_snapshot,
                comparison,
                submitted_at,
                decided_by,
                decided_at,
                decision_reason,
                created_at,
                updated_at
            `,
            [context.franchiseId, context.tutorId, workDate, timezone, newStatus]
          );
          day = inserted.rows[0];
        } else {
          const updated = await client.query<TimeEntryDayRow>(
            `
              UPDATE public.time_entry_days
              SET status = $1,
                  timezone = $2,
                  comparison = $3,
                  submitted_at = COALESCE($4, submitted_at),
                  decided_by = NULL,
                  decided_at = NULL,
                  decision_reason = NULL,
                  updated_at = NOW()
              WHERE id = $5
              RETURNING
                id,
                franchiseid,
                tutorid,
                work_date,
                timezone,
                status,
                schedule_snapshot,
                comparison,
                submitted_at,
                decided_by,
                decided_at,
                decision_reason,
                created_at,
                updated_at
            `,
            [newStatus, timezone, comparison, submittedAtOverride, existing.id]
          );
          day = updated.rows[0];
        }

        await client.query('DELETE FROM public.time_entry_sessions WHERE entry_day_id = $1', [day.id]);

        for (const session of normalizedSessions) {
          await client.query(
            `
              INSERT INTO public.time_entry_sessions
                (entry_day_id, franchiseid, tutorid, start_at, end_at, sort_order, created_at, updated_at)
              VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
            `,
            [day.id, context.franchiseId, context.tutorId, session.startAt, session.endAt, session.sortOrder]
          );
        }

        await appendAudit(client, {
          dayId: day.id,
          action,
          actorAccountType: 'TUTOR',
          actorAccountId: context.tutorId,
          previousStatus: existing?.status ?? null,
          newStatus: day.status,
          metadata: {
            workDate,
            timezone,
            previousSessions: previousSessions.map((row) => ({
              startAt: new Date(row.start_at).toISOString(),
              endAt: new Date(row.end_at).toISOString(),
              sortOrder: row.sort_order
            })),
            sessions: normalizedSessions.map((s) => ({ startAt: s.startAt, endAt: s.endAt, sortOrder: s.sortOrder }))
          }
        });

        await client.query('COMMIT');

        const savedSessions = await fetchSessionsByDayId(client, day.id);
        const savedBreaks = await fetchBreaksByDayId(client, day.id);
        res.status(existing ? 200 : 201).json({
          day: mapDayRowToResponse(day, savedSessions, savedBreaks)
        });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/time-entry/me/day/:workDate/submit',
  requireTutor,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const context = getTutorContext(req);
    if (!context) {
      missingFranchise(res);
      return;
    }

    const workDate = parseIsoDateOnly((req.params as Record<string, unknown>).workDate);
    if (!workDate) {
      res.status(400).json({ error: 'workDate must be YYYY-MM-DD' });
      return;
    }

    const snapshot = parseScheduleSnapshotV1((req.body as Record<string, unknown>)?.scheduleSnapshot);
    if (!snapshot) {
      res.status(400).json({ error: 'scheduleSnapshot (v1) is required' });
      return;
    }

    if (snapshot.franchiseId !== context.franchiseId || snapshot.tutorId !== context.tutorId) {
      res.status(403).json({ error: 'scheduleSnapshot does not match your session scope' });
      return;
    }

    if (snapshot.workDate !== workDate) {
      res.status(400).json({ error: 'scheduleSnapshot.workDate must match workDate' });
      return;
    }

    try {
      const payPeriod = await resolvePayPeriod(context.franchiseId, workDate);
      const timezone = payPeriod.timezone;

      const attestationGate = await enforcePriorWeekAttestation({
        franchiseId: context.franchiseId,
        tutorId: context.tutorId,
        timezone,
        workDate
      });
      if (!attestationGate.ok && 'error' in attestationGate) {
        res.status(500).json({ error: attestationGate.error });
        return;
      }
      if (!attestationGate.ok) {
        res.status(409).json({
          error: 'Weekly attestation is required before entering time for the new workweek.',
          missingWeekEnd: attestationGate.weekEnd
        });
        return;
      }

      const signingSecret = getScheduleSnapshotSigningSecret();
      if (signingSecret) {
        const verify = verifyScheduleSnapshot(snapshot, signingSecret);
        if (!verify.ok) {
          res.status(400).json({ error: verify.error });
          return;
        }
      }

      const pool = getPostgresPool();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const existing = await fetchDayByWorkDate(client, context.franchiseId, context.tutorId, workDate);
        if (!existing) {
          await client.query('ROLLBACK');
          notFound(res);
          return;
        }

        const sessions = await fetchSessionsByDayId(client, existing.id);
        let breaks = await fetchBreaksByDayId(client, existing.id);
        const autoBreak = await applyAutoLunchBreak({
          client,
          entryDayId: existing.id,
          franchiseId: existing.franchiseid,
          tutorId: existing.tutorid,
          sessions: sessions.map((row) => ({ id: row.id, startAt: row.start_at, endAt: row.end_at })),
          existingBreaks: breaks
        });
        if (autoBreak) {
          breaks = [...breaks, autoBreak];
          await appendAudit(client, {
            dayId: existing.id,
            action: 'auto_break_applied',
            actorAccountType: 'SYSTEM',
            actorAccountId: null,
            previousStatus: existing.status,
            newStatus: existing.status,
            metadata: { workDate, break: mapBreakRowToResponse(autoBreak) }
          });
        }

        const sessionPayload = sessions.map((row) => ({
          startAt: new Date(row.start_at).toISOString(),
          endAt: new Date(row.end_at).toISOString()
        }));

        const computed = computeTimeEntryComparisonV1({
          sessions: sessionPayload,
          breaks: breaks.map((row) => ({
            payTreatment: row.pay_treatment,
            status: row.status,
            durationMinutes: Number(row.duration_minutes)
          })),
          snapshotIntervals: snapshot.intervals
        });

        if (!computed.ok) {
          const isStoredSessionError = computed.error.toLowerCase().includes('session');
          const errorMessage = isStoredSessionError
            ? 'Stored sessions are invalid; re-save your day sessions.'
            : computed.error;
          await client.query('ROLLBACK');
          res.status(400).json({
            error: errorMessage
          });
          return;
        }

        const { matches, comparison } = computed;

        const nextStatus: TimeEntryStatus = matches ? 'approved' : 'pending';
        const decidedAt = matches ? new Date().toISOString() : null;
        const decisionReason = matches ? 'auto-approved (matching scheduled minutes)' : null;

        const updated = await client.query<TimeEntryDayRow>(
          `
            UPDATE public.time_entry_days
            SET status = $1,
                timezone = $2,
                schedule_snapshot = $3,
                comparison = $4,
                submitted_at = NOW(),
                decided_by = NULL,
                decided_at = $5,
                decision_reason = $6,
                updated_at = NOW()
            WHERE id = $7
            RETURNING
              id,
              franchiseid,
              tutorid,
              work_date,
              timezone,
              status,
              schedule_snapshot,
              comparison,
              submitted_at,
              decided_by,
              decided_at,
              decision_reason,
              created_at,
              updated_at
          `,
          [nextStatus, timezone, snapshot, comparison, decidedAt, decisionReason, existing.id]
        );

        const day = updated.rows[0];

        await appendAudit(client, {
          dayId: day.id,
          action: matches ? 'auto_approved' : 'submitted',
          actorAccountType: matches ? 'SYSTEM' : 'TUTOR',
          actorAccountId: matches ? null : context.tutorId,
          previousStatus: existing.status,
          newStatus: day.status,
          metadata: {
            workDate,
            timezone,
            scheduleSnapshot: snapshot,
            comparison
          }
        });

        await client.query('COMMIT');

        res.status(200).json({
          day: mapDayRowToResponse(day, sessions, breaks)
        });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/time-entry/me/day/:workDate/breaks',
  requireTutor,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const context = getTutorContext(req);
    if (!context) {
      missingFranchise(res);
      return;
    }

    const workDate = parseIsoDateOnly((req.params as Record<string, unknown>).workDate);
    if (!workDate) {
      res.status(400).json({ error: 'workDate must be YYYY-MM-DD' });
      return;
    }

    const parsed = parseBreakPayload((req.body as Record<string, unknown>) ?? {}, { requireWindowOrDuration: true });
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    if (!parsed.payload.startTime || !parsed.payload.endTime) {
      res.status(400).json({ error: 'Employee-entered manual breaks require startTime and endTime.' });
      return;
    }

    try {
      const pool = getPostgresPool();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const day = await fetchDayByWorkDate(client, context.franchiseId, context.tutorId, workDate);
        if (!day) {
          await client.query('ROLLBACK');
          notFound(res);
          return;
        }

        const sessions = await fetchSessionsByDayId(client, day.id);
        const existingBreaks = await fetchBreaksByDayId(client, day.id);
        const resolved = resolveBreakSession(sessions, parsed.payload, existingBreaks);
        if (!resolved.ok) {
          await client.query('ROLLBACK');
          res.status(400).json({ error: resolved.error });
          return;
        }

        const inserted = await insertBreak(client, {
          day,
          sessionId: resolved.session.id,
          payload: parsed.payload,
          durationMinutes: resolved.durationMinutes,
          source: 'employee'
        });
        const nextBreaks = [...existingBreaks, inserted];
        const updatedDay = await updateDayAfterBreakMutation(client, day, sessions, nextBreaks);

        await appendAudit(client, {
          dayId: day.id,
          action: 'break_created',
          actorAccountType: 'TUTOR',
          actorAccountId: context.tutorId,
          previousStatus: day.status,
          newStatus: updatedDay.status,
          metadata: {
            workDate,
            break: mapBreakRowToResponse(inserted)
          }
        });

        await client.query('COMMIT');

        res.status(201).json({ day: mapDayRowToResponse(updatedDay, sessions, nextBreaks) });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/time-entry/admin/day/:id/breaks',
  requireAdmin,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const admin = getAdminContext(req);
    if (!admin) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const scope = enforceFranchiseScope(req, { requireFranchiseId: true, requiredMessage: 'franchiseId is required' });
    if (scope.error || scope.franchiseId === null) {
      res.status(scope.error?.status ?? 400).json({ error: scope.error?.message ?? 'franchiseId is required' });
      return;
    }

    const dayId = parseIdParam((req.params as Record<string, unknown>).id);
    if (!dayId) {
      res.status(400).json({ error: 'id must be a positive integer' });
      return;
    }

    const parsed = parseBreakPayload((req.body as Record<string, unknown>) ?? {}, { requireWindowOrDuration: true });
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    try {
      const pool = getPostgresPool();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const existingResult = await client.query<TimeEntryDayRow>(
          `
            SELECT
              id,
              franchiseid,
              tutorid,
              work_date,
              timezone,
              status,
              schedule_snapshot,
              comparison,
              submitted_at,
              decided_by,
              decided_at,
              decision_reason,
              created_at,
              updated_at
            FROM public.time_entry_days
            WHERE id = $1
              AND franchiseid = $2
            LIMIT 1
            FOR UPDATE
          `,
          [dayId, scope.franchiseId]
        );

        if (!existingResult.rowCount) {
          await client.query('ROLLBACK');
          notFound(res);
          return;
        }

        const day = existingResult.rows[0];
        const sessions = await fetchSessionsByDayId(client, day.id);
        const existingBreaks = await fetchBreaksByDayId(client, day.id);

        let sessionId: number | null = null;
        let durationMinutes: number;
        if (parsed.payload.startTime && parsed.payload.endTime) {
          const resolved = resolveBreakSession(sessions, parsed.payload, existingBreaks);
          if (!resolved.ok) {
            await client.query('ROLLBACK');
            res.status(400).json({ error: resolved.error });
            return;
          }
          sessionId = resolved.session.id;
          durationMinutes = resolved.durationMinutes;
        } else {
          durationMinutes = parsed.payload.durationMinutes ?? 0;
          if (durationMinutes <= 0) {
            await client.query('ROLLBACK');
            res.status(400).json({ error: 'durationMinutes is required for duration-only breaks.' });
            return;
          }
        }

        const inserted = await insertBreak(client, {
          day,
          sessionId,
          payload: parsed.payload,
          durationMinutes,
          source: 'manager'
        });
        const nextBreaks = [...existingBreaks, inserted];
        const updatedDay = await updateDayAfterBreakMutation(client, day, sessions, nextBreaks);

        await appendAudit(client, {
          dayId: day.id,
          action: 'break_created',
          actorAccountType: 'ADMIN',
          actorAccountId: admin.adminId,
          previousStatus: day.status,
          newStatus: updatedDay.status,
          metadata: {
            break: mapBreakRowToResponse(inserted),
            reason: typeof (req.body as Record<string, unknown>)?.reason === 'string'
              ? String((req.body as Record<string, unknown>).reason).trim()
              : null
          }
        });

        await client.query('COMMIT');
        res.status(201).json({ day: mapDayRowToResponse(updatedDay, sessions, nextBreaks) });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      next(err);
    }
  }
);

router.put(
  '/time-entry/admin/day/:id/breaks/:breakId',
  requireAdmin,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const admin = getAdminContext(req);
    if (!admin) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const scope = enforceFranchiseScope(req, { requireFranchiseId: true, requiredMessage: 'franchiseId is required' });
    if (scope.error || scope.franchiseId === null) {
      res.status(scope.error?.status ?? 400).json({ error: scope.error?.message ?? 'franchiseId is required' });
      return;
    }

    const dayId = parseIdParam((req.params as Record<string, unknown>).id);
    const breakId = parseIdParam((req.params as Record<string, unknown>).breakId);
    if (!dayId || !breakId) {
      res.status(400).json({ error: 'id and breakId must be positive integers' });
      return;
    }

    try {
      const pool = getPostgresPool();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const dayResult = await client.query<TimeEntryDayRow>(
          `
            SELECT
              id,
              franchiseid,
              tutorid,
              work_date,
              timezone,
              status,
              schedule_snapshot,
              comparison,
              submitted_at,
              decided_by,
              decided_at,
              decision_reason,
              created_at,
              updated_at
            FROM public.time_entry_days
            WHERE id = $1
              AND franchiseid = $2
            LIMIT 1
            FOR UPDATE
          `,
          [dayId, scope.franchiseId]
        );
        if (!dayResult.rowCount) {
          await client.query('ROLLBACK');
          notFound(res);
          return;
        }
        const day = dayResult.rows[0];

        const currentBreak = await fetchBreakForDay(client, day.id, breakId);
        if (!currentBreak) {
          await client.query('ROLLBACK');
          notFound(res);
          return;
        }
        if (currentBreak.status === 'voided') {
          await client.query('ROLLBACK');
          res.status(409).json({ error: 'Voided breaks cannot be edited.' });
          return;
        }

        const body = (req.body as Record<string, unknown>) ?? {};
        const mergedBody = {
          breakType: body.breakType ?? body.break_type ?? currentBreak.break_type,
          payTreatment: body.payTreatment ?? body.pay_treatment ?? currentBreak.pay_treatment,
          startTime: body.startTime ?? body.start_time ?? (currentBreak.start_time ? new Date(currentBreak.start_time).toISOString() : null),
          endTime: body.endTime ?? body.end_time ?? (currentBreak.end_time ? new Date(currentBreak.end_time).toISOString() : null),
          durationMinutes: body.durationMinutes ?? body.duration_minutes ?? currentBreak.duration_minutes,
          note: body.note ?? currentBreak.note,
          timeEntrySessionId: body.timeEntrySessionId ?? body.time_entry_session_id ?? currentBreak.time_entry_session_id
        };
        const parsed = parseBreakPayload(mergedBody, { requireWindowOrDuration: true });
        if (!parsed.ok) {
          await client.query('ROLLBACK');
          res.status(400).json({ error: parsed.error });
          return;
        }

        const sessions = await fetchSessionsByDayId(client, day.id);
        const existingBreaks = await fetchBreaksByDayId(client, day.id);

        let sessionId: number | null = null;
        let durationMinutes: number;
        if (parsed.payload.startTime && parsed.payload.endTime) {
          const resolved = resolveBreakSession(sessions, parsed.payload, existingBreaks, currentBreak.id);
          if (!resolved.ok) {
            await client.query('ROLLBACK');
            res.status(400).json({ error: resolved.error });
            return;
          }
          sessionId = resolved.session.id;
          durationMinutes = resolved.durationMinutes;
        } else {
          durationMinutes = parsed.payload.durationMinutes ?? 0;
          if (durationMinutes <= 0) {
            await client.query('ROLLBACK');
            res.status(400).json({ error: 'durationMinutes is required for duration-only breaks.' });
            return;
          }
        }

        const updatedBreakResult = await client.query<TimeEntryBreakRow>(
          `
            UPDATE public.time_entry_breaks
            SET time_entry_session_id = $1,
                break_type = $2,
                pay_treatment = $3,
                start_time = $4,
                end_time = $5,
                duration_minutes = $6,
                status = 'completed',
                note = $7,
                updated_at = NOW()
            WHERE id = $8
              AND entry_day_id = $9
            RETURNING
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
          `,
          [
            sessionId,
            parsed.payload.breakType,
            parsed.payload.payTreatment,
            parsed.payload.startTime,
            parsed.payload.endTime,
            durationMinutes,
            parsed.payload.note,
            currentBreak.id,
            day.id
          ]
        );
        const updatedBreak = updatedBreakResult.rows[0];
        const nextBreaks = existingBreaks.map((item) => (item.id === updatedBreak.id ? updatedBreak : item));
        const updatedDay = await updateDayAfterBreakMutation(client, day, sessions, nextBreaks);

        await appendAudit(client, {
          dayId: day.id,
          action: 'break_updated',
          actorAccountType: 'ADMIN',
          actorAccountId: admin.adminId,
          previousStatus: day.status,
          newStatus: updatedDay.status,
          metadata: {
            previousBreak: mapBreakRowToResponse(currentBreak),
            break: mapBreakRowToResponse(updatedBreak)
          }
        });

        await client.query('COMMIT');
        res.status(200).json({ day: mapDayRowToResponse(updatedDay, sessions, nextBreaks) });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/time-entry/admin/day/:id/breaks/:breakId/void',
  requireAdmin,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const admin = getAdminContext(req);
    if (!admin) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const scope = enforceFranchiseScope(req, { requireFranchiseId: true, requiredMessage: 'franchiseId is required' });
    if (scope.error || scope.franchiseId === null) {
      res.status(scope.error?.status ?? 400).json({ error: scope.error?.message ?? 'franchiseId is required' });
      return;
    }

    const dayId = parseIdParam((req.params as Record<string, unknown>).id);
    const breakId = parseIdParam((req.params as Record<string, unknown>).breakId);
    if (!dayId || !breakId) {
      res.status(400).json({ error: 'id and breakId must be positive integers' });
      return;
    }

    try {
      const pool = getPostgresPool();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const dayResult = await client.query<TimeEntryDayRow>(
          `
            SELECT
              id,
              franchiseid,
              tutorid,
              work_date,
              timezone,
              status,
              schedule_snapshot,
              comparison,
              submitted_at,
              decided_by,
              decided_at,
              decision_reason,
              created_at,
              updated_at
            FROM public.time_entry_days
            WHERE id = $1
              AND franchiseid = $2
            LIMIT 1
            FOR UPDATE
          `,
          [dayId, scope.franchiseId]
        );
        if (!dayResult.rowCount) {
          await client.query('ROLLBACK');
          notFound(res);
          return;
        }
        const day = dayResult.rows[0];
        const currentBreak = await fetchBreakForDay(client, day.id, breakId);
        if (!currentBreak) {
          await client.query('ROLLBACK');
          notFound(res);
          return;
        }

        const voidedResult = await client.query<TimeEntryBreakRow>(
          `
            UPDATE public.time_entry_breaks
            SET status = 'voided',
                source = CASE WHEN source = 'auto_rule' THEN source ELSE 'manager' END,
                note = COALESCE($1, note),
                updated_at = NOW()
            WHERE id = $2
              AND entry_day_id = $3
            RETURNING
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
          `,
          [
            typeof (req.body as Record<string, unknown>)?.note === 'string'
              ? String((req.body as Record<string, unknown>).note).trim().slice(0, 2000)
              : null,
            currentBreak.id,
            day.id
          ]
        );
        const voidedBreak = voidedResult.rows[0];
        const sessions = await fetchSessionsByDayId(client, day.id);
        const existingBreaks = await fetchBreaksByDayId(client, day.id);
        const nextBreaks = existingBreaks.map((item) => (item.id === voidedBreak.id ? voidedBreak : item));
        const updatedDay = await updateDayAfterBreakMutation(client, day, sessions, nextBreaks);

        await appendAudit(client, {
          dayId: day.id,
          action: 'break_voided',
          actorAccountType: 'ADMIN',
          actorAccountId: admin.adminId,
          previousStatus: day.status,
          newStatus: updatedDay.status,
          metadata: {
            previousBreak: mapBreakRowToResponse(currentBreak),
            break: mapBreakRowToResponse(voidedBreak)
          }
        });

        await client.query('COMMIT');
        res.status(200).json({ day: mapDayRowToResponse(updatedDay, sessions, nextBreaks) });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  '/time-entry/admin/pending',
  requireAdmin,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const scope = enforceFranchiseScope(req, { requireFranchiseId: true, requiredMessage: 'franchiseId is required' });
    if (scope.error || scope.franchiseId === null) {
      res.status(scope.error?.status ?? 400).json({ error: scope.error?.message ?? 'franchiseId is required' });
      return;
    }

    const limit = parseLimit((req.query as Record<string, unknown>).limit, 200, 500);

    try {
      const pool = getPostgresPool();
      const dayResult = await pool.query<TimeEntryDayRow>(
        `
          SELECT
            id,
            franchiseid,
            tutorid,
            work_date,
            timezone,
            status,
            schedule_snapshot,
            comparison,
            submitted_at,
            decided_by,
            decided_at,
            decision_reason,
            created_at,
            updated_at
          FROM public.time_entry_days
          WHERE franchiseid = $1
            AND status = 'pending'
          ORDER BY submitted_at DESC NULLS LAST, work_date DESC, id DESC
          LIMIT $2
        `,
        [scope.franchiseId, limit]
      );

      const days = dayResult.rows ?? [];
      const ids = days.map((day) => day.id);

      const sessionsByDay = new Map<number, TimeEntrySessionRow[]>();
      if (ids.length) {
        const sessionResult = await pool.query<TimeEntrySessionRow>(
          `
            SELECT id, entry_day_id, start_at, end_at, sort_order
            FROM public.time_entry_sessions
            WHERE entry_day_id = ANY($1::int[])
              AND end_at IS NOT NULL
            ORDER BY entry_day_id ASC, sort_order ASC, start_at ASC
          `,
          [ids]
        );

        for (const row of sessionResult.rows ?? []) {
          const list = sessionsByDay.get(row.entry_day_id) ?? [];
          list.push(row);
          sessionsByDay.set(row.entry_day_id, list);
        }
      }

      const lastAuditByDay = new Map<
        number,
        {
          action: string;
          actorAccountType: string;
          actorAccountId: number | null;
          at: string;
          previousStatus: string | null;
          newStatus: string;
        }
      >();
      const wasEverApproved = new Set<number>();

      const tutorIdentityById = new Map<number, TutorIdentity>();
      const breaksByDay = await fetchBreaksByDayIds(pool, ids);

      if (ids.length) {
        const tutorIds = Array.from(new Set(days.map((day) => day.tutorid)));

        const [lastAuditResult, approvedEverResult] = await Promise.all([
          pool.query<TimeEntryAuditSummaryRow>(
            `
              SELECT DISTINCT ON (entry_day_id)
                entry_day_id,
                action,
                actor_account_type,
                actor_account_id,
                at,
                previous_status,
                new_status
              FROM public.time_entry_audit
              WHERE entry_day_id = ANY($1::int[])
              ORDER BY entry_day_id, at DESC, id DESC
            `,
            [ids]
          ),
          pool.query<{ entry_day_id: number }>(
            `
              SELECT entry_day_id
              FROM public.time_entry_audit
              WHERE entry_day_id = ANY($1::int[])
                AND action IN ('approved', 'auto_approved')
              GROUP BY entry_day_id
            `,
            [ids]
          )
        ]);

        const tutorMap = await fetchTutorsByIds(tutorIds);
        tutorMap.forEach((value, key) => tutorIdentityById.set(key, value));

        for (const row of lastAuditResult.rows ?? []) {
          lastAuditByDay.set(row.entry_day_id, {
            action: row.action,
            actorAccountType: row.actor_account_type,
            actorAccountId: row.actor_account_id,
            at: new Date(row.at).toISOString(),
            previousStatus: row.previous_status,
            newStatus: row.new_status
          });
        }

        for (const row of approvedEverResult.rows ?? []) {
          wasEverApproved.add(row.entry_day_id);
        }
      }

      res.status(200).json({
        days: days.map((day) => mapDayRowToResponse(day, sessionsByDay.get(day.id) ?? [], breaksByDay.get(day.id) ?? []))
          .map((payload) => ({
            ...payload,
            tutorName: tutorIdentityById.get(payload.tutorId)?.name ?? null,
            tutorEmail: tutorIdentityById.get(payload.tutorId)?.email ?? null,
            history: {
              wasEverApproved: wasEverApproved.has(payload.id),
              lastAudit: lastAuditByDay.get(payload.id) ?? null
            }
          }))
      });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/time-entry/admin/day/:id/decide',
  requireAdmin,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const admin = getAdminContext(req);
    if (!admin) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const scope = enforceFranchiseScope(req, { requireFranchiseId: true, requiredMessage: 'franchiseId is required' });
    if (scope.error || scope.franchiseId === null) {
      res.status(scope.error?.status ?? 400).json({ error: scope.error?.message ?? 'franchiseId is required' });
      return;
    }

    const dayId = parseIdParam((req.params as Record<string, unknown>).id);
    if (!dayId) {
      res.status(400).json({ error: 'id must be a positive integer' });
      return;
    }

    const decisionRaw = typeof (req.body as Record<string, unknown>)?.decision === 'string' ? String((req.body as Record<string, unknown>).decision) : '';
    const decision = decisionRaw.trim().toLowerCase();
    if (decision !== 'approve' && decision !== 'deny') {
      res.status(400).json({ error: "decision must be 'approve' or 'deny'" });
      return;
    }

    const reasonRaw = (req.body as Record<string, unknown>)?.reason;
    const reason = typeof reasonRaw === 'string' ? reasonRaw.trim() : '';
    if (reason.length > 2000) {
      res.status(400).json({ error: 'reason must be 2000 characters or fewer' });
      return;
    }

    if (decision === 'deny' && !reason) {
      res.status(400).json({ error: 'reason is required when denying a request' });
      return;
    }

    try {
      const pool = getPostgresPool();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const existing = await client.query<TimeEntryDayRow>(
          `
            SELECT
              id,
              franchiseid,
              tutorid,
              work_date,
              timezone,
              status,
              schedule_snapshot,
              comparison,
              submitted_at,
              decided_by,
              decided_at,
              decision_reason,
              created_at,
              updated_at
            FROM public.time_entry_days
            WHERE id = $1
              AND franchiseid = $2
            LIMIT 1
          `,
          [dayId, scope.franchiseId]
        );

        if (!existing.rowCount) {
          await client.query('ROLLBACK');
          notFound(res);
          return;
        }

        const day = existing.rows[0];
        if (day.status !== 'pending') {
          await client.query('ROLLBACK');
          res.status(409).json({ error: `Only pending entries can be decided (current status: ${day.status})` });
          return;
        }

        const nextStatus: TimeEntryStatus = decision === 'approve' ? 'approved' : 'denied';
        const update = await client.query<TimeEntryDayRow>(
          `
            UPDATE public.time_entry_days
            SET status = $1,
                decided_by = $2,
                decided_at = NOW(),
                decision_reason = $3,
                updated_at = NOW()
            WHERE id = $4
            RETURNING
              id,
              franchiseid,
              tutorid,
              work_date,
              timezone,
              status,
              schedule_snapshot,
              comparison,
              submitted_at,
              decided_by,
              decided_at,
              decision_reason,
              created_at,
              updated_at
          `,
          [nextStatus, admin.adminId, reason || null, dayId]
        );

        const updatedDay = update.rows[0];
        await appendAudit(client, {
          dayId: updatedDay.id,
          action: nextStatus === 'approved' ? 'approved' : 'denied',
          actorAccountType: 'ADMIN',
          actorAccountId: admin.adminId,
          previousStatus: day.status,
          newStatus: updatedDay.status,
          metadata: { reason: reason || null }
        });

        await client.query('COMMIT');

        const sessions = await fetchSessionsByDayId(client, updatedDay.id);
        const breaks = await fetchBreaksByDayId(client, updatedDay.id);
        res.status(200).json({ day: mapDayRowToResponse(updatedDay, sessions, breaks) });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      next(err);
    }
  }
);

router.put(
  '/time-entry/admin/day/:id',
  requireAdmin,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const admin = getAdminContext(req);
    if (!admin) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const scope = enforceFranchiseScope(req, { requireFranchiseId: true, requiredMessage: 'franchiseId is required' });
    if (scope.error || scope.franchiseId === null) {
      res.status(scope.error?.status ?? 400).json({ error: scope.error?.message ?? 'franchiseId is required' });
      return;
    }

    const dayId = parseIdParam((req.params as Record<string, unknown>).id);
    if (!dayId) {
      res.status(400).json({ error: 'id must be a positive integer' });
      return;
    }

    const reasonRaw = (req.body as Record<string, unknown>)?.reason;
    const reason = typeof reasonRaw === 'string' ? reasonRaw.trim() : '';
    if (reason.length > 2000) {
      res.status(400).json({ error: 'reason must be 2000 characters or fewer' });
      return;
    }
    if (reason.length < 5) {
      res.status(400).json({ error: 'reason is required (min 5 characters)' });
      return;
    }

    const sessionsRaw = (req.body as Record<string, unknown>)?.sessions;
    if (!Array.isArray(sessionsRaw)) {
      res.status(400).json({ error: 'sessions must be an array' });
      return;
    }

    if (sessionsRaw.length > 20) {
      res.status(400).json({ error: 'sessions is too large (max 20)' });
      return;
    }

    try {
      const pool = getPostgresPool();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const existingResult = await client.query<TimeEntryDayRow>(
          `
            SELECT
              id,
              franchiseid,
              tutorid,
              work_date,
              timezone,
              status,
              schedule_snapshot,
              comparison,
              submitted_at,
              decided_by,
              decided_at,
              decision_reason,
              created_at,
              updated_at
            FROM public.time_entry_days
            WHERE id = $1
              AND franchiseid = $2
            LIMIT 1
          `,
          [dayId, scope.franchiseId]
        );

        if (!existingResult.rowCount) {
          await client.query('ROLLBACK');
          notFound(res);
          return;
        }

        const existingDay = existingResult.rows[0];
        const workDate = normalizeWorkDate(existingDay.work_date);
        if (!workDate) {
          await client.query('ROLLBACK');
          res.status(500).json({ error: 'Unable to resolve work date for this entry.' });
          return;
        }
        const timezone = existingDay.timezone;

        const normalizedSessions = sessionsRaw
          .map((session, idx) => {
            if (!isRecord(session)) return null;
            const startAt = parseTimestamptzMinute(session.startAt);
            const endAt = parseTimestamptzMinute(session.endAt);
            if (!startAt || !endAt) return null;

            const startLocal = DateTime.fromISO(startAt, { zone: 'utc' }).setZone(timezone);
            const endLocal = DateTime.fromISO(endAt, { zone: 'utc' }).setZone(timezone);
            if (!startLocal.isValid || !endLocal.isValid) return null;
            if (startLocal.toISODate() !== workDate) return null;
            if (endLocal.toISODate() !== workDate) return null;

            const startMinute = toEpochMinute(startAt);
            const endMinute = toEpochMinute(endAt);
            if (startMinute === null || endMinute === null) return null;
            if (endMinute <= startMinute) return null;

            return {
              sortOrder: idx,
              startAt,
              endAt,
              startMinute,
              endMinute
            };
          })
          .filter(Boolean) as Array<{
          sortOrder: number;
          startAt: string;
          endAt: string;
          startMinute: number;
          endMinute: number;
        }>;

        if (normalizedSessions.length !== sessionsRaw.length) {
          await client.query('ROLLBACK');
          res.status(400).json({
            error: 'Each session must include startAt/endAt as ISO timestamps with timezone offset, aligned to the minute, within workDate in franchise timezone.'
          });
          return;
        }

        const sorted = normalizedSessions
          .slice()
          .sort((a, b) => a.startMinute - b.startMinute || a.endMinute - b.endMinute);
        for (let idx = 1; idx < sorted.length; idx += 1) {
          if (sorted[idx].startMinute < sorted[idx - 1].endMinute) {
            await client.query('ROLLBACK');
            res.status(400).json({ error: 'Sessions must not overlap' });
            return;
          }
        }

        const previousSessions = await fetchSessionsByDayId(client, existingDay.id);

        const snapshot = parseScheduleSnapshotV1(existingDay.schedule_snapshot);

        let comparison: unknown | null = existingDay.comparison;
        if (snapshot) {
          const computed = computeTimeEntryComparisonV1({
            sessions: normalizedSessions.map((s) => ({ startAt: s.startAt, endAt: s.endAt })),
            snapshotIntervals: snapshot.intervals
          });
          if (computed.ok) {
            comparison = computed.comparison;
          }
        }

        const update = await client.query<TimeEntryDayRow>(
          `
            UPDATE public.time_entry_days
            SET status = 'pending',
                comparison = $1,
                submitted_at = NOW(),
                decided_by = NULL,
                decided_at = NULL,
                decision_reason = NULL,
                clock_state = 0,
                updated_at = NOW()
            WHERE id = $2
            RETURNING
              id,
              franchiseid,
              tutorid,
              work_date,
              timezone,
              status,
              schedule_snapshot,
              comparison,
              submitted_at,
              decided_by,
              decided_at,
              decision_reason,
              created_at,
              updated_at
          `,
            [comparison, existingDay.id]
          );

        const updatedDay = update.rows[0];

        await client.query('DELETE FROM public.time_entry_sessions WHERE entry_day_id = $1', [existingDay.id]);
        for (const session of normalizedSessions) {
          await client.query(
            `
              INSERT INTO public.time_entry_sessions
                (entry_day_id, franchiseid, tutorid, start_at, end_at, sort_order, created_at, updated_at)
              VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
            `,
            [
              existingDay.id,
              existingDay.franchiseid,
              existingDay.tutorid,
              session.startAt,
              session.endAt,
              session.sortOrder
            ]
          );
        }

        if (existingDay.status === 'approved') {
          await appendAudit(client, {
            dayId: existingDay.id,
            action: 'invalidated',
            actorAccountType: 'ADMIN',
            actorAccountId: admin.adminId,
            previousStatus: existingDay.status,
            newStatus: updatedDay.status,
            metadata: { workDate, timezone, reason, kind: 'admin_fixed' }
          });
        }

        await appendAudit(client, {
          dayId: existingDay.id,
          action: 'admin_fixed',
          actorAccountType: 'ADMIN',
          actorAccountId: admin.adminId,
          previousStatus: existingDay.status,
          newStatus: updatedDay.status,
          metadata: {
            workDate,
            timezone,
            reason,
            previousSessions: previousSessions.map((row) => ({
              startAt: new Date(row.start_at).toISOString(),
              endAt: new Date(row.end_at).toISOString(),
              sortOrder: row.sort_order
            })),
            sessions: normalizedSessions.map((s) => ({ startAt: s.startAt, endAt: s.endAt, sortOrder: s.sortOrder }))
          }
        });

        await client.query('COMMIT');

        const sessions = await fetchSessionsByDayId(client, updatedDay.id);
        const breaks = await fetchBreaksByDayId(client, updatedDay.id);
        res.status(200).json({ day: mapDayRowToResponse(updatedDay, sessions, breaks) });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      next(err);
    }
  }
);

export default router;
