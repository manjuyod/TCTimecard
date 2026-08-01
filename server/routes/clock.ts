import express, { NextFunction, Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { DateTime } from 'luxon';
import { getPostgresPool } from '../db/postgres';
import { requireTutor } from '../middleware/auth';
import { getFranchisePayrollSettings, resolvePayPeriod } from '../payroll/payPeriodResolution';
import {
  getScheduleSnapshotSigningSecret,
  parseScheduleSnapshotV1,
  verifyScheduleSnapshot
} from '../services/scheduleSnapshot';
import { enforcePriorWeekAttestation } from '../services/weeklyAttestationGate';
import {
  ClockOutFinalizationError,
  createPostgresClockOutTransaction,
  finalizeClockOutInTransaction,
  type TimeEntryDayRow
} from '../services/clockOutFinalization';
import {
  computeBreakMinuteTotals,
  fetchBreaksByDayIds,
  getDefaultPayTreatment,
  isBreakType,
  mapBreakRowToResponse,
  type TimeEntryBreakRow
} from '../services/timeEntryBreaks';

type TimeEntryStatus = 'draft' | 'pending' | 'approved' | 'denied';
type ClockStateValue = 0 | 1; // 0 = clocked out, 1 = clocked in

type OpenSessionRow = { id: number; start_at: string };

type ClockStateResponse = {
  timezone: string;
  workDate: string;
  dayId: number | null;
  dayStatus: TimeEntryStatus | null;
  clockState: ClockStateValue;
  persistedClockState: ClockStateValue;
  openSessionId: number | null;
  startedAt: string | null;
  activeBreak: ReturnType<typeof mapBreakRowToResponse> | null;
  breaks: Array<ReturnType<typeof mapBreakRowToResponse>>;
  breakSummary: {
    paidBreakMinutes: number;
    unpaidBreakMinutes: number;
  };
  attestationBlocking: boolean;
  missingWeekEnd: string | null;
};

const router = express.Router();

const getTutorContext = (req: Request): { tutorId: number; franchiseId: number } | null => {
  const auth = req.session.auth;
  if (!auth) return null;

  const tutorId = Number(auth.accountId);
  const franchiseId = Number(auth.franchiseId);
  if (!Number.isFinite(tutorId) || !Number.isFinite(franchiseId)) return null;

  return { tutorId, franchiseId };
};

const normalizeClockState = (value: unknown): ClockStateValue => (Number(value) === 1 ? 1 : 0);

const appendAudit = async (client: PoolClient, entry: {
  dayId: number;
  action:
    | 'clock_in'
    | 'clock_out'
    | 'submitted'
    | 'auto_approved'
    | 'invalidated'
    | 'admin_fixed'
    | 'break_started'
    | 'break_ended';
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

const buildClockStateResponse = (params: {
  timezone: string;
  workDate: string;
  day: TimeEntryDayRow | null;
  openSession: OpenSessionRow | null;
  breaks?: TimeEntryBreakRow[];
  attestationGate: { ok: true } | { ok: false; weekEnd: string };
}): ClockStateResponse => {
  const persistedClockState: ClockStateValue = normalizeClockState(params.day?.clock_state ?? 0);
  const authoritativeClockState: ClockStateValue = params.openSession ? 1 : 0;
  const breaks = params.breaks ?? [];
  const activeBreak = breaks.find((item) => item.status === 'active') ?? null;
  const breakSummary = computeBreakMinuteTotals(
    breaks.map((item) => ({
      payTreatment: item.pay_treatment,
      status: item.status,
      durationMinutes: Number(item.duration_minutes)
    }))
  );

  return {
    timezone: params.timezone,
    workDate: params.workDate,
    dayId: params.day?.id ?? null,
    dayStatus: params.day?.status ?? null,
    clockState: authoritativeClockState,
    persistedClockState,
    openSessionId: params.openSession?.id ?? null,
    startedAt: params.openSession?.start_at ? new Date(params.openSession.start_at).toISOString() : null,
    activeBreak: activeBreak ? mapBreakRowToResponse(activeBreak) : null,
    breaks: breaks.map(mapBreakRowToResponse),
    breakSummary,
    attestationBlocking: !params.attestationGate.ok,
    missingWeekEnd: params.attestationGate.ok ? null : params.attestationGate.weekEnd
  };
};

const fetchDayForUpdate = async (
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
        clock_state,
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
      FOR UPDATE
    `,
    [franchiseId, tutorId, workDate]
  );

  return result.rowCount ? result.rows[0] : null;
};

const fetchDay = async (
  franchiseId: number,
  tutorId: number,
  workDate: string
): Promise<TimeEntryDayRow | null> => {
  const pool = getPostgresPool();
  const result = await pool.query<TimeEntryDayRow>(
    `
      SELECT
        id,
        franchiseid,
        tutorid,
        work_date,
        timezone,
        status,
        clock_state,
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

const fetchOpenSession = async (client: PoolClient, dayId: number, lock: boolean): Promise<OpenSessionRow | null> => {
  const query = lock
    ? `
        SELECT id, start_at
        FROM public.time_entry_sessions
        WHERE entry_day_id = $1
          AND end_at IS NULL
        ORDER BY id DESC
        LIMIT 1
        FOR UPDATE
      `
    : `
        SELECT id, start_at
        FROM public.time_entry_sessions
        WHERE entry_day_id = $1
          AND end_at IS NULL
        ORDER BY id DESC
        LIMIT 1
      `;

  const result = await client.query<OpenSessionRow>(query, [dayId]);

  return result.rowCount ? result.rows[0] : null;
};

const fetchBreaksByDayId = async (client: PoolClient, dayId: number): Promise<TimeEntryBreakRow[]> =>
  (await fetchBreaksByDayIds(client, [dayId])).get(dayId) ?? [];

const fetchActiveBreak = async (
  client: PoolClient,
  dayId: number,
  lock: boolean
): Promise<TimeEntryBreakRow | null> => {
  const lockClause = lock ? 'FOR UPDATE' : '';
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
      WHERE entry_day_id = $1
        AND status = 'active'
      ORDER BY id DESC
      LIMIT 1
      ${lockClause}
    `,
    [dayId]
  );

  return result.rowCount ? result.rows[0] : null;
};

router.get(
  '/clock/me/state',
  requireTutor,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const context = getTutorContext(req);
    if (!context) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    try {
      const settings = await getFranchisePayrollSettings(context.franchiseId);
      const timezone = settings.timezone;
      const workDate = DateTime.now().setZone(timezone).toISODate();
      if (!workDate) {
        res.status(500).json({ error: 'Unable to resolve current work date' });
        return;
      }

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

      const day = await fetchDay(context.franchiseId, context.tutorId, workDate);

      let openSession: OpenSessionRow | null = null;
      let breaks: TimeEntryBreakRow[] = [];
      if (day) {
        const pool = getPostgresPool();
        const client = await pool.connect();
        try {
          openSession = await fetchOpenSession(client, day.id, false);
          breaks = await fetchBreaksByDayId(client, day.id);
        } finally {
          client.release();
        }
      }

      res.status(200).json({
        state: buildClockStateResponse({
          timezone,
          workDate,
          day,
          openSession,
          breaks,
          attestationGate
        })
      });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/clock/me/in',
  requireTutor,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const context = getTutorContext(req);
    if (!context) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    try {
      const payPeriod = await resolvePayPeriod(context.franchiseId, null);
      const timezone = payPeriod.timezone;
      const workDate = DateTime.now().setZone(timezone).toISODate();
      if (!workDate) {
        res.status(500).json({ error: 'Unable to resolve current work date' });
        return;
      }

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

      const pool = getPostgresPool();
      const client = await pool.connect();

      try {
        await client.query('BEGIN');

        await client.query(
          `
            INSERT INTO public.time_entry_days
              (franchiseid, tutorid, work_date, timezone, status, clock_state, created_at, updated_at)
            VALUES ($1, $2, $3, $4, 'draft', 1, NOW(), NOW())
            ON CONFLICT (franchiseid, tutorid, work_date) DO NOTHING
          `,
          [context.franchiseId, context.tutorId, workDate, timezone]
        );

        const existing = await fetchDayForUpdate(client, context.franchiseId, context.tutorId, workDate);
        if (!existing) {
          await client.query('ROLLBACK');
          res.status(500).json({ error: 'Unable to create or fetch entry day' });
          return;
        }

        const previousClockState = normalizeClockState(existing.clock_state);

        let day = existing;

        if (day.status === 'approved' || day.status === 'denied') {
          const invalidated = await client.query<TimeEntryDayRow>(
            `
              UPDATE public.time_entry_days
              SET status = 'pending',
                  timezone = $1,
                  decided_by = NULL,
                  decided_at = NULL,
                  decision_reason = NULL,
                  submitted_at = NOW(),
                  updated_at = NOW()
              WHERE id = $2
              RETURNING
                id,
                franchiseid,
                tutorid,
                work_date,
                timezone,
                status,
                clock_state,
                schedule_snapshot,
                comparison,
                submitted_at,
                decided_by,
                decided_at,
                decision_reason,
                created_at,
                updated_at
            `,
            [timezone, day.id]
          );
          const updatedDay = invalidated.rows[0];

          await appendAudit(client, {
            dayId: day.id,
            action: 'invalidated',
            actorAccountType: 'TUTOR',
            actorAccountId: context.tutorId,
            previousStatus: day.status,
            newStatus: updatedDay.status,
            metadata: {
              workDate,
              timezone,
              previousClockState,
              reason: 'clock_in'
            }
          });

          day = updatedDay;
        }

        const openSession = await fetchOpenSession(client, day.id, true);
        if (openSession) {
          if (normalizeClockState(day.clock_state) !== 1) {
            const updated = await client.query<TimeEntryDayRow>(
              `
                UPDATE public.time_entry_days
                SET clock_state = 1,
                    timezone = $1,
                    updated_at = NOW()
                WHERE id = $2
                RETURNING
                  id,
                  franchiseid,
                  tutorid,
                  work_date,
                  timezone,
                  status,
                  clock_state,
                  schedule_snapshot,
                  comparison,
                  submitted_at,
                  decided_by,
                  decided_at,
                  decision_reason,
                  created_at,
                  updated_at
              `,
              [timezone, day.id]
            );
            day = updated.rows[0];
          }

          await client.query('COMMIT');
          res.status(200).json({
            state: buildClockStateResponse({ timezone, workDate, day, openSession, attestationGate })
          });
          return;
        }

        const sortOrderResult = await client.query<{ next_sort_order: number }>(
          `
            SELECT COALESCE(MAX(sort_order), -1) + 1 as next_sort_order
            FROM public.time_entry_sessions
            WHERE entry_day_id = $1
          `,
          [day.id]
        );
        const nextSortOrder = Number(sortOrderResult.rows?.[0]?.next_sort_order ?? 0);

        const insertedSession = await client.query<OpenSessionRow>(
          `
            INSERT INTO public.time_entry_sessions
              (entry_day_id, franchiseid, tutorid, start_at, end_at, sort_order, created_at, updated_at)
            VALUES ($1, $2, $3, DATE_TRUNC('minute', NOW()), NULL, $4, NOW(), NOW())
            RETURNING id, start_at
          `,
          [day.id, context.franchiseId, context.tutorId, nextSortOrder]
        );

        const session = insertedSession.rows[0];

        const updatedDayResult = await client.query<TimeEntryDayRow>(
          `
            UPDATE public.time_entry_days
            SET clock_state = 1,
                timezone = $1,
                updated_at = NOW()
            WHERE id = $2
            RETURNING
              id,
              franchiseid,
              tutorid,
              work_date,
              timezone,
              status,
              clock_state,
              schedule_snapshot,
              comparison,
              submitted_at,
              decided_by,
              decided_at,
              decision_reason,
              created_at,
              updated_at
          `,
          [timezone, day.id]
        );
        day = updatedDayResult.rows[0];

        await appendAudit(client, {
          dayId: day.id,
          action: 'clock_in',
          actorAccountType: 'TUTOR',
          actorAccountId: context.tutorId,
          previousStatus: existing.status,
          newStatus: day.status,
          metadata: {
            workDate,
            timezone,
            sessionId: session.id,
            startedAt: new Date(session.start_at).toISOString(),
            previousClockState,
            newClockState: 1
          }
        });

        await client.query('COMMIT');

        res.status(201).json({
          state: buildClockStateResponse({ timezone, workDate, day, openSession: session, attestationGate })
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
  '/clock/me/break/start',
  requireTutor,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const context = getTutorContext(req);
    if (!context) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const breakTypeRaw = (req.body as Record<string, unknown> | null | undefined)?.breakType;
    if (!isBreakType(breakTypeRaw)) {
      res.status(400).json({ error: 'breakType is required and must be lunch, rest_break, personal, training, travel, or other.' });
      return;
    }
    const payTreatment = getDefaultPayTreatment(breakTypeRaw);

    try {
      const payPeriod = await resolvePayPeriod(context.franchiseId, null);
      const timezone = payPeriod.timezone;
      const workDate = DateTime.now().setZone(timezone).toISODate();
      if (!workDate) {
        res.status(500).json({ error: 'Unable to resolve current work date' });
        return;
      }

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

      const pool = getPostgresPool();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const day = await fetchDayForUpdate(client, context.franchiseId, context.tutorId, workDate);
        if (!day) {
          await client.query('ROLLBACK');
          res.status(409).json({ error: 'You must be clocked in before starting a break.' });
          return;
        }

        const openSession = await fetchOpenSession(client, day.id, true);
        if (!openSession) {
          await client.query('ROLLBACK');
          res.status(409).json({ error: 'You must be clocked in before starting a break.' });
          return;
        }

        const activeBreak = await fetchActiveBreak(client, day.id, true);
        if (activeBreak) {
          await client.query('ROLLBACK');
          res.status(409).json({ error: 'End the active break before starting another break.' });
          return;
        }

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
            VALUES ($1, $2, $3, $4, $5, $6, DATE_TRUNC('minute', NOW()), NULL, 0, 'employee', 'active', NULL, NOW(), NOW())
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
          [day.id, openSession.id, context.franchiseId, context.tutorId, breakTypeRaw, payTreatment]
        );
        const breakRow = inserted.rows[0];

        await appendAudit(client, {
          dayId: day.id,
          action: 'break_started',
          actorAccountType: 'TUTOR',
          actorAccountId: context.tutorId,
          previousStatus: day.status,
          newStatus: day.status,
          metadata: { workDate, break: mapBreakRowToResponse(breakRow) }
        });

        await client.query('COMMIT');

        const breaks = await fetchBreaksByDayId(client, day.id);
        res.status(201).json({
          state: buildClockStateResponse({ timezone, workDate, day, openSession, breaks, attestationGate })
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
  '/clock/me/break/end',
  requireTutor,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const context = getTutorContext(req);
    if (!context) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    try {
      const payPeriod = await resolvePayPeriod(context.franchiseId, null);
      const timezone = payPeriod.timezone;
      const workDate = DateTime.now().setZone(timezone).toISODate();
      if (!workDate) {
        res.status(500).json({ error: 'Unable to resolve current work date' });
        return;
      }

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

      const pool = getPostgresPool();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const day = await fetchDayForUpdate(client, context.franchiseId, context.tutorId, workDate);
        if (!day) {
          await client.query('ROLLBACK');
          res.status(409).json({ error: 'No active break was found.' });
          return;
        }

        const openSession = await fetchOpenSession(client, day.id, true);
        const activeBreak = await fetchActiveBreak(client, day.id, true);
        if (!activeBreak) {
          await client.query('ROLLBACK');
          res.status(409).json({ error: 'No active break was found.' });
          return;
        }

        const updated = await client.query<TimeEntryBreakRow>(
          `
            WITH finished AS (
              SELECT
                id,
                CASE
                  WHEN DATE_TRUNC('minute', NOW()) <= start_time THEN start_time + INTERVAL '1 minute'
                  ELSE DATE_TRUNC('minute', NOW())
                END AS ended_at
              FROM public.time_entry_breaks
              WHERE id = $1
                AND status = 'active'
            )
            UPDATE public.time_entry_breaks b
            SET end_time = finished.ended_at,
                duration_minutes = FLOOR(EXTRACT(EPOCH FROM (finished.ended_at - b.start_time)) / 60)::int,
                status = 'completed',
                updated_at = NOW()
            FROM finished
            WHERE b.id = finished.id
            RETURNING
              b.id,
              b.entry_day_id,
              b.time_entry_session_id,
              b.franchiseid,
              b.tutorid,
              b.break_type,
              b.pay_treatment,
              b.start_time,
              b.end_time,
              b.duration_minutes,
              b.source,
              b.status,
              b.note,
              b.created_at,
              b.updated_at
          `,
          [activeBreak.id]
        );
        const breakRow = updated.rows[0];

        await appendAudit(client, {
          dayId: day.id,
          action: 'break_ended',
          actorAccountType: 'TUTOR',
          actorAccountId: context.tutorId,
          previousStatus: day.status,
          newStatus: day.status,
          metadata: { workDate, break: mapBreakRowToResponse(breakRow) }
        });

        await client.query('COMMIT');

        const breaks = await fetchBreaksByDayId(client, day.id);
        res.status(200).json({
          state: buildClockStateResponse({ timezone, workDate, day, openSession, breaks, attestationGate })
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
  '/clock/me/out',
  requireTutor,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const context = getTutorContext(req);
    if (!context) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const requestSnapshotRaw = (req.body as Record<string, unknown> | null | undefined)?.scheduleSnapshot;

    try {
      const payPeriod = await resolvePayPeriod(context.franchiseId, null);
      const timezone = payPeriod.timezone;
      const workDate = DateTime.now().setZone(timezone).toISODate();
      if (!workDate) {
        res.status(500).json({ error: 'Unable to resolve current work date' });
        return;
      }

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

      const pool = getPostgresPool();
      const client = await pool.connect();

      try {
        await client.query('BEGIN');

        const existing = await fetchDayForUpdate(client, context.franchiseId, context.tutorId, workDate);
        if (!existing) {
          await client.query('ROLLBACK');
          res.status(200).json({
            state: buildClockStateResponse({
              timezone,
              workDate,
              day: null,
              openSession: null,
              attestationGate
            })
          });
          return;
        }

        const previousClockState = normalizeClockState(existing.clock_state);
        let day: TimeEntryDayRow = { ...existing, timezone };

        const openSession = await fetchOpenSession(client, day.id, true);
        const activeBreak = await fetchActiveBreak(client, day.id, true);
        if (activeBreak) {
          await client.query('ROLLBACK');
          res.status(409).json({ error: 'End the active break before clocking out.' });
          return;
        }

        const transaction = createPostgresClockOutTransaction(client);
        if (!openSession) {
          if (previousClockState !== 0) day = await transaction.setClockStateOut(day);
          const breaks = await transaction.listBreaks(day.id);
          await client.query('COMMIT');
          res.status(200).json({
            state: buildClockStateResponse({
              timezone,
              workDate,
              day,
              openSession: null,
              breaks,
              attestationGate
            })
          });
          return;
        }

        const storedSnapshot = parseScheduleSnapshotV1(day.schedule_snapshot);
        let snapshot =
          storedSnapshot &&
          storedSnapshot.franchiseId === context.franchiseId &&
          storedSnapshot.tutorId === context.tutorId &&
          storedSnapshot.workDate === workDate
            ? storedSnapshot
            : null;

        if (!snapshot) {
          const parsed = parseScheduleSnapshotV1(requestSnapshotRaw);
          if (!parsed) {
            try {
              await client.query('ROLLBACK');
            } catch (rollbackErr) {
              console.error('[clock] Failed to rollback after missing schedule snapshot:', rollbackErr);
            }
            res.status(400).json({ error: 'scheduleSnapshot (v1) is required to submit clocked time.' });
            return;
          }

          if (parsed.franchiseId !== context.franchiseId || parsed.tutorId !== context.tutorId) {
            await client.query('ROLLBACK');
            res.status(403).json({ error: 'scheduleSnapshot does not match your session scope' });
            return;
          }

          if (parsed.workDate !== workDate) {
            await client.query('ROLLBACK');
            res.status(400).json({ error: 'scheduleSnapshot.workDate must match today in franchise timezone' });
            return;
          }

          const signingSecret = getScheduleSnapshotSigningSecret();
          if (!signingSecret) {
            if (process.env.NODE_ENV === 'production') {
              await client.query('ROLLBACK');
              res.status(500).json({ error: 'Schedule snapshot signing secret is required.' });
              return;
            }
            console.warn('[clock] Missing schedule snapshot signing secret; accepting unsigned snapshot.');
          } else {
            const verify = verifyScheduleSnapshot(parsed, signingSecret);
            if (!verify.ok) {
              await client.query('ROLLBACK');
              res.status(400).json({ error: verify.error });
              return;
            }
          }

          snapshot = parsed;
        }

        const result = await finalizeClockOutInTransaction({
          transaction,
          day,
          openSession,
          activeBreak,
          detectedAt: new Date().toISOString(),
          snapshot,
          source: 'clock_out',
          actor: { accountType: 'TUTOR', accountId: context.tutorId },
          activeBreakPolicy: 'reject'
        });

        if (result.kind === 'active_break' || result.kind === 'invalid_break') {
          await client.query('ROLLBACK');
          res.status(409).json({ error: 'End the active break before clocking out.' });
          return;
        }

        if (result.kind === 'invalid_end') {
          await client.query('ROLLBACK');
          res.status(400).json({ error: 'Stored sessions are invalid; re-save your day sessions.' });
          return;
        }

        let breaks: TimeEntryBreakRow[];
        if (result.kind === 'already_closed') {
          day = await transaction.setClockStateOut(day);
          breaks = await transaction.listBreaks(day.id);
        } else {
          day = result.day;
          breaks = result.breaks;
        }

        await client.query('COMMIT');
        res.status(200).json({
          state: buildClockStateResponse({
            timezone,
            workDate,
            day,
            openSession: null,
            breaks,
            attestationGate
          })
        });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        if (err instanceof ClockOutFinalizationError) {
          res.status(400).json({ error: err.publicMessage });
          return;
        }
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
