import express, { NextFunction, Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { DateTime } from 'luxon';
import { getPostgresPool } from '../db/postgres';
import { requireTutor } from '../middleware/auth';
import { resolvePayPeriod } from '../payroll/payPeriodResolution';
import {
  getScheduleSnapshotSigningSecret,
  parseScheduleSnapshotV1,
  verifyScheduleSnapshot
} from '../services/scheduleSnapshot';
import { enforcePriorWeekAttestation } from '../services/weeklyAttestationGate';
import { computeTimeEntryComparisonV1 } from '../services/timeEntryComparison';

type TimeEntryStatus = 'draft' | 'pending' | 'approved' | 'denied';
type ClockStateValue = 0 | 1; // 0 = clocked in, 1 = clocked out

type TimeEntryDayRow = {
  id: number;
  franchiseid: number;
  tutorid: number;
  work_date: string;
  timezone: string;
  status: TimeEntryStatus;
  clock_state: number;
  schedule_snapshot: unknown | null;
  comparison: unknown | null;
  submitted_at: string | null;
  decided_by: number | null;
  decided_at: string | null;
  decision_reason: string | null;
  created_at: string;
  updated_at: string;
};

type OpenSessionRow = { id: number; start_at: string };

type ClosedSessionRow = { id: number; start_at: string; end_at: string | null; sort_order: number };

type ClockStateResponse = {
  timezone: string;
  workDate: string;
  dayId: number | null;
  dayStatus: TimeEntryStatus | null;
  clockState: ClockStateValue;
  persistedClockState: ClockStateValue;
  openSessionId: number | null;
  startedAt: string | null;
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

const normalizeClockState = (value: unknown): ClockStateValue => (Number(value) === 0 ? 0 : 1);

const appendAudit = async (client: PoolClient, entry: {
  dayId: number;
  action: 'clock_in' | 'clock_out' | 'submitted' | 'auto_approved' | 'invalidated' | 'admin_fixed';
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
  attestationGate: { ok: true } | { ok: false; weekEnd: string };
}): ClockStateResponse => {
  const persistedClockState: ClockStateValue = normalizeClockState(params.day?.clock_state ?? 1);
  const authoritativeClockState: ClockStateValue = params.openSession ? 0 : 1;

  return {
    timezone: params.timezone,
    workDate: params.workDate,
    dayId: params.day?.id ?? null,
    dayStatus: params.day?.status ?? null,
    clockState: authoritativeClockState,
    persistedClockState,
    openSessionId: params.openSession?.id ?? null,
    startedAt: params.openSession?.start_at ? new Date(params.openSession.start_at).toISOString() : null,
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

      const day = await fetchDay(context.franchiseId, context.tutorId, workDate);

      let openSession: OpenSessionRow | null = null;
      if (day) {
        const pool = getPostgresPool();
        const client = await pool.connect();
        try {
          openSession = await fetchOpenSession(client, day.id, false);
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
          if (normalizeClockState(day.clock_state) !== 0) {
            const updated = await client.query<TimeEntryDayRow>(
              `
                UPDATE public.time_entry_days
                SET clock_state = 0,
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
            SET clock_state = 0,
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
            newClockState: 0
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
  '/clock/me/out',
  requireTutor,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const context = getTutorContext(req);
    if (!context) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const finalize = Boolean((req.body as Record<string, unknown> | null | undefined)?.finalize);

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
      if (!attestationGate.ok) {
        res.status(409).json({
          error: 'Weekly attestation is required before entering time for the new workweek.',
          missingWeekEnd: attestationGate.weekEnd
        });
        return;
      }

      const snapshot = finalize ? parseScheduleSnapshotV1((req.body as Record<string, unknown>)?.scheduleSnapshot) : null;
      if (finalize && !snapshot) {
        res.status(400).json({ error: 'scheduleSnapshot (v1) is required when finalize=true' });
        return;
      }

      if (snapshot) {
        if (snapshot.franchiseId !== context.franchiseId || snapshot.tutorId !== context.tutorId) {
          res.status(403).json({ error: 'scheduleSnapshot does not match your session scope' });
          return;
        }

        if (snapshot.workDate !== workDate) {
          res.status(400).json({ error: 'scheduleSnapshot.workDate must match today in franchise timezone' });
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
      }

      const pool = getPostgresPool();
      const client = await pool.connect();

      try {
        await client.query('BEGIN');

        const existing = await fetchDayForUpdate(client, context.franchiseId, context.tutorId, workDate);
        if (!existing) {
          await client.query('ROLLBACK');
          if (finalize) {
            res.status(404).json({ error: 'No time entry day found to finalize' });
            return;
          }
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
        let day = existing;

        const openSession = await fetchOpenSession(client, day.id, true);

        let closedSession: { id: number; startAt: string; endAt: string } | null = null;

        if (openSession) {
          const closed = await client.query<{ id: number; start_at: string; end_at: string }>(
            `
              UPDATE public.time_entry_sessions
              SET end_at = DATE_TRUNC('minute', NOW()),
                  updated_at = NOW()
              WHERE id = $1
                AND end_at IS NULL
              RETURNING id, start_at, end_at
            `,
            [openSession.id]
          );

          const row = closed.rows[0];
          closedSession = {
            id: row.id,
            startAt: new Date(row.start_at).toISOString(),
            endAt: new Date(row.end_at).toISOString()
          };

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
                reason: 'clock_out'
              }
            });

            day = updatedDay;
          }

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
            action: 'clock_out',
            actorAccountType: 'TUTOR',
            actorAccountId: context.tutorId,
            previousStatus: existing.status,
            newStatus: day.status,
            metadata: {
              workDate,
              timezone,
              sessionId: closedSession.id,
              startedAt: closedSession.startAt,
              endedAt: closedSession.endAt,
              previousClockState,
              newClockState: 1
            }
          });
        } else if (previousClockState !== 1) {
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
        }

        if (snapshot) {
          const sessionResult = await client.query<ClosedSessionRow>(
            `
              SELECT id, start_at, end_at, sort_order
              FROM public.time_entry_sessions
              WHERE entry_day_id = $1
                AND end_at IS NOT NULL
              ORDER BY sort_order ASC, start_at ASC
            `,
            [day.id]
          );

          const sessionPayload = (sessionResult.rows ?? []).map((session) => ({
            startAt: new Date(session.start_at).toISOString(),
            endAt: session.end_at ? new Date(session.end_at).toISOString() : ''
          }));

          const computed = computeTimeEntryComparisonV1({
            sessions: sessionPayload,
            snapshotIntervals: snapshot.intervals
          });

          if (!computed.ok) {
            const isStoredSessionError = computed.error.toLowerCase().includes('session');
            res.status(400).json({
              error: isStoredSessionError ? 'Stored sessions are invalid; re-save your day sessions.' : computed.error
            });
            await client.query('ROLLBACK');
            return;
          }

          const { matches, comparison } = computed;

          const nextStatus: TimeEntryStatus = matches ? 'approved' : 'pending';
          const decidedAt = matches ? new Date().toISOString() : null;
          const decisionReason = matches ? 'auto-approved (exact schedule match)' : null;

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
                  clock_state = 1,
                  updated_at = NOW()
              WHERE id = $7
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
            [nextStatus, timezone, snapshot, comparison, decidedAt, decisionReason, day.id]
          );

          const finalizedDay = updated.rows[0];

          await appendAudit(client, {
            dayId: finalizedDay.id,
            action: matches ? 'auto_approved' : 'submitted',
            actorAccountType: matches ? 'SYSTEM' : 'TUTOR',
            actorAccountId: matches ? null : context.tutorId,
            previousStatus: day.status,
            newStatus: finalizedDay.status,
            metadata: {
              workDate,
              timezone,
              scheduleSnapshot: snapshot,
              comparison,
              finalize: true
            }
          });

          day = finalizedDay;
        }

        await client.query('COMMIT');

        res.status(200).json({
          state: buildClockStateResponse({
            timezone,
            workDate,
            day,
            openSession: null,
            attestationGate
          })
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

export default router;
