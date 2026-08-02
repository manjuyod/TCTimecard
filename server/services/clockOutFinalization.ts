import type { PoolClient } from 'pg';
import { resolveClockOutSubmission, shouldInvalidateClockDayStatus, type TimeEntryStatus } from './clockSubmission';
import type { ScheduleSnapshotV1 } from './scheduleSnapshot';
import { computeTimeEntryComparisonV2, type TimeEntryComparisonV2 } from './timeEntryComparison';
import { fetchBreaksByDayIds, type TimeEntryBreakRow } from './timeEntryBreaks';

export type ClockOutSource = 'clock_out' | 'auto_clock_out';
export type ActiveBreakPolicy = 'reject' | 'close';

export type TimeEntryDayRow = {
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

export type ClockOutFinalizationResult =
  | { kind: 'finalized'; day: TimeEntryDayRow; breaks: TimeEntryBreakRow[] }
  | { kind: 'active_break' }
  | { kind: 'invalid_break' }
  | { kind: 'invalid_end' }
  | { kind: 'already_closed' };

export type ClockOutAuditEntry = {
  dayId: number;
  action: 'clock_out' | 'invalidated' | 'submitted' | 'auto_approved';
  actorAccountType: 'TUTOR' | 'SYSTEM';
  actorAccountId: number | null;
  previousStatus: TimeEntryStatus | null;
  newStatus: TimeEntryStatus;
  metadata?: Record<string, unknown>;
};

export type ClockOutSubmissionWrite = {
  nextStatus: 'pending' | 'approved';
  decidedAt: string | null;
  decisionReason: string | null;
  snapshot: ScheduleSnapshotV1;
  comparison: TimeEntryComparisonV2;
};

export interface ClockOutTransaction {
  resolveTargetEndAt(explicit?: string): Promise<string>;
  closeActiveBreak(row: TimeEntryBreakRow, endAt: string): Promise<TimeEntryBreakRow>;
  closeSession(id: number, endAt: string): Promise<{ id: number; startAt: string; endAt: string } | null>;
  invalidateDay(day: TimeEntryDayRow): Promise<TimeEntryDayRow>;
  setClockStateOut(day: TimeEntryDayRow): Promise<TimeEntryDayRow>;
  appendAudit(entry: ClockOutAuditEntry): Promise<void>;
  listClosedSessions(dayId: number): Promise<Array<{ startAt: string; endAt: string }>>;
  listBreaks(dayId: number): Promise<TimeEntryBreakRow[]>;
  saveSubmission(day: TimeEntryDayRow, input: ClockOutSubmissionWrite): Promise<TimeEntryDayRow>;
}

export type FinalizeClockOutInTransaction = (params: {
  transaction: ClockOutTransaction;
  day: TimeEntryDayRow;
  openSession: { id: number; start_at: string };
  activeBreak: TimeEntryBreakRow | null;
  targetEndAt?: string;
  detectedAt: string;
  snapshot: ScheduleSnapshotV1;
  source: ClockOutSource;
  actor: { accountType: 'TUTOR' | 'SYSTEM'; accountId: number | null };
  activeBreakPolicy: ActiveBreakPolicy;
}) => Promise<ClockOutFinalizationResult>;

export type CreatePostgresClockOutTransaction = (client: PoolClient) => ClockOutTransaction;

export class ClockOutFinalizationError extends Error {
  readonly code = 'invalid_comparison' as const;

  constructor(readonly publicMessage: string) {
    super(publicMessage);
    this.name = 'ClockOutFinalizationError';
  }
}

export const createPostgresClockOutTransaction: CreatePostgresClockOutTransaction = (client) => ({
  async resolveTargetEndAt(explicit) {
    if (explicit) return explicit;
    const result = await client.query<{ end_at: string }>(
      `SELECT DATE_TRUNC('minute', NOW()) AS end_at`
    );
    return new Date(result.rows[0].end_at).toISOString();
  },
  async closeActiveBreak(row, endAt) {
    const result = await client.query<TimeEntryBreakRow>(
      `UPDATE public.time_entry_breaks
          SET end_time = $1,
              duration_minutes = FLOOR(EXTRACT(EPOCH FROM ($1::timestamptz - start_time)) / 60)::integer,
              status = 'completed',
              updated_at = NOW()
        WHERE id = $2 AND status = 'active'
        RETURNING *`,
      [endAt, row.id]
    );
    if (!result.rowCount) throw new Error('Active break changed during clock-out');
    return result.rows[0];
  },
  async closeSession(id, endAt) {
    const result = await client.query<{ id: number; start_at: string; end_at: string }>(
      `UPDATE public.time_entry_sessions
          SET end_at = $1, updated_at = NOW()
        WHERE id = $2 AND end_at IS NULL
        RETURNING id, start_at, end_at`,
      [endAt, id]
    );
    return result.rowCount ? {
      id: result.rows[0].id,
      startAt: new Date(result.rows[0].start_at).toISOString(),
      endAt: new Date(result.rows[0].end_at).toISOString()
    } : null;
  },
  async invalidateDay(day) {
    const result = await client.query<TimeEntryDayRow>(
      `UPDATE public.time_entry_days
          SET status = 'pending', decided_by = NULL, decided_at = NULL,
              decision_reason = NULL, submitted_at = NOW(), updated_at = NOW()
        WHERE id = $1 RETURNING *`,
      [day.id]
    );
    return result.rows[0];
  },
  async setClockStateOut(day) {
    const result = await client.query<TimeEntryDayRow>(
      `UPDATE public.time_entry_days
          SET clock_state = 0, timezone = $1, updated_at = NOW()
        WHERE id = $2 RETURNING *`,
      [day.timezone, day.id]
    );
    return result.rows[0];
  },
  async appendAudit(entry) {
    await client.query(
      `INSERT INTO public.time_entry_audit
        (entry_day_id, action, actor_account_type, actor_account_id,
         at, previous_status, new_status, metadata)
       VALUES ($1, $2, $3, $4, NOW(), $5, $6, $7)`,
      [entry.dayId, entry.action, entry.actorAccountType, entry.actorAccountId,
       entry.previousStatus, entry.newStatus, entry.metadata ?? {}]
    );
  },
  async listClosedSessions(dayId) {
    const result = await client.query<{ start_at: string; end_at: string }>(
      `SELECT start_at, end_at FROM public.time_entry_sessions
        WHERE entry_day_id = $1 AND end_at IS NOT NULL
        ORDER BY sort_order ASC, start_at ASC`,
      [dayId]
    );
    return result.rows.map((row) => ({
      startAt: new Date(row.start_at).toISOString(),
      endAt: new Date(row.end_at).toISOString()
    }));
  },
  async listBreaks(dayId) {
    return (await fetchBreaksByDayIds(client, [dayId])).get(dayId) ?? [];
  },
  async saveSubmission(day, input) {
    const result = await client.query<TimeEntryDayRow>(
      `UPDATE public.time_entry_days
          SET status = $1, timezone = $2, schedule_snapshot = $3,
              comparison = $4, submitted_at = NOW(), decided_by = NULL,
              decided_at = $5, decision_reason = $6, clock_state = 0,
              updated_at = NOW()
        WHERE id = $7 RETURNING *`,
      [input.nextStatus, day.timezone, input.snapshot, input.comparison,
       input.decidedAt, input.decisionReason, day.id]
    );
    return result.rows[0];
  }
});

const parseEpoch = (value: string | Date | null): number | null => {
  if (!value) return null;
  const epoch = new Date(value).getTime();
  return Number.isFinite(epoch) ? epoch : null;
};

export const finalizeClockOutInTransaction: FinalizeClockOutInTransaction = async (params) => {
  const timezone = params.source === 'auto_clock_out' ? params.snapshot.timezone : params.day.timezone;
  let currentDay: TimeEntryDayRow = { ...params.day, timezone };
  const previousClockState = Number(params.day.clock_state) === 1 ? 1 : 0;
  const targetEndAt = await params.transaction.resolveTargetEndAt(params.targetEndAt);
  const targetEpoch = parseEpoch(targetEndAt);
  const sessionStartEpoch = parseEpoch(params.openSession.start_at);

  if (targetEpoch === null || sessionStartEpoch === null || targetEpoch <= sessionStartEpoch) {
    return { kind: 'invalid_end' };
  }

  if (params.activeBreak) {
    if (params.activeBreakPolicy === 'reject') return { kind: 'active_break' };

    const breakStartEpoch = parseEpoch(params.activeBreak.start_time);
    if (
      params.activeBreak.time_entry_session_id !== params.openSession.id ||
      breakStartEpoch === null ||
      breakStartEpoch < sessionStartEpoch ||
      breakStartEpoch >= targetEpoch
    ) {
      return { kind: 'invalid_break' };
    }
  }

  const closedSession = await params.transaction.closeSession(params.openSession.id, targetEndAt);
  if (!closedSession) return { kind: 'already_closed' };

  if (params.activeBreak) {
    await params.transaction.closeActiveBreak(params.activeBreak, targetEndAt);
  }

  if (shouldInvalidateClockDayStatus(currentDay.status)) {
    const previousStatus = currentDay.status;
    const invalidatedDay = await params.transaction.invalidateDay(currentDay);
    currentDay = { ...invalidatedDay, timezone };
    await params.transaction.appendAudit({
      dayId: currentDay.id,
      action: 'invalidated',
      actorAccountType: params.actor.accountType,
      actorAccountId: params.actor.accountId,
      previousStatus,
      newStatus: currentDay.status,
      metadata: {
        workDate: currentDay.work_date,
        timezone,
        previousClockState,
        reason: 'clock_out'
      }
    });
  }

  currentDay = await params.transaction.setClockStateOut(currentDay);
  await params.transaction.appendAudit({
    dayId: currentDay.id,
    action: 'clock_out',
    actorAccountType: params.actor.accountType,
    actorAccountId: params.actor.accountId,
    previousStatus: params.day.status,
    newStatus: currentDay.status,
    metadata: {
      workDate: currentDay.work_date,
      timezone,
      sessionId: closedSession.id,
      startedAt: closedSession.startAt,
      endedAt: closedSession.endAt,
      previousClockState,
      newClockState: 0,
      source: params.source,
      detectedAt: params.detectedAt
    }
  });

  const sessions = await params.transaction.listClosedSessions(currentDay.id);
  const breaks = await params.transaction.listBreaks(currentDay.id);
  const computed = computeTimeEntryComparisonV2({
    sessions,
    breaks: breaks.map((row) => ({
      payTreatment: row.pay_treatment,
      status: row.status,
      startTime: row.start_time,
      endTime: row.end_time,
      durationMinutes: Number(row.duration_minutes)
    })),
    snapshotIntervals: params.snapshot.intervals
  });

  if (!computed.ok) {
    const message = computed.error.toLowerCase().includes('session')
      ? 'Stored sessions are invalid; re-save your day sessions.'
      : computed.error;
    throw new ClockOutFinalizationError(message);
  }

  const decision = resolveClockOutSubmission({
    snapshot: params.snapshot,
    comparison: computed.comparison,
    workDate: currentDay.work_date,
    timezone,
    source: params.source,
    detectedAt: params.detectedAt
  });
  const previousStatus = currentDay.status;
  currentDay = await params.transaction.saveSubmission(currentDay, {
    nextStatus: decision.nextStatus,
    decidedAt: decision.decidedAt,
    decisionReason: decision.decisionReason,
    snapshot: params.snapshot,
    comparison: computed.comparison
  });
  await params.transaction.appendAudit({
    dayId: currentDay.id,
    action: decision.audit.action,
    actorAccountType: decision.audit.actorAccountType,
    actorAccountId: decision.audit.actorAccountId,
    previousStatus,
    newStatus: currentDay.status,
    metadata: decision.audit.metadata
  });

  return { kind: 'finalized', day: currentDay, breaks };
};
