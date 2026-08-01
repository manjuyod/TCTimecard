import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { getPostgresPool } from '../db/postgres';
import {
  createPostgresClockOutTransaction,
  finalizeClockOutInTransaction,
  type ClockOutFinalizationResult,
  type FinalizeClockOutInTransaction,
  type TimeEntryDayRow
} from './clockOutFinalization';
import {
  fetchLatestScheduleSnapshots,
  scheduleCandidateKey,
  type ScheduleCandidate
} from './scheduleSource';
import type { ScheduleSnapshotV1 } from './scheduleSnapshot';
import {
  isBreakSource,
  isBreakStatus,
  isBreakType,
  isPayTreatment,
  type TimeEntryBreakRow
} from './timeEntryBreaks';

const ADVISORY_LOCK_KEY = 739280451;
const MAX_POSTGRES_CLIENTS = 4;

export const isAutoClockOutMinute = (date: Date): boolean => {
  const minute = date.getUTCMinutes();
  return minute <= 9 || minute >= 50;
};

export const nextAutoClockOutTick = (after: Date): Date => {
  const next = new Date(after);
  next.setUTCSeconds(0, 0);
  next.setUTCMinutes(next.getUTCMinutes() + 1);
  while (!isAutoClockOutMinute(next)) {
    next.setUTCMinutes(next.getUTCMinutes() + 1);
  }
  return next;
};

export const getFinalScheduleEnd = (snapshot: ScheduleSnapshotV1): string | null => {
  const valid = snapshot.intervals
    .map((interval) => ({ value: interval.endAt, epoch: Date.parse(interval.endAt) }))
    .filter((item) => Number.isFinite(item.epoch));
  valid.sort((left, right) => left.epoch - right.epoch);
  return valid.length > 0 ? valid[valid.length - 1].value : null;
};

export interface AutoClockOutRunSummary {
  runId: string;
  candidates: number;
  due: number;
  succeeded: number;
  alreadyClosed: number;
  failed: number;
  skipped: {
    missingSchedule: number;
    invalidSchedule: number;
    settingDisabled: number;
  };
  durationMs: number;
  lockAcquired: boolean;
}

export interface AutoClockOutCandidate extends ScheduleCandidate {
  dayId: number;
  openSessionId: number;
  startedAt: string;
}

export interface AutoClockOutFinalizationInput {
  client: PoolClient;
  candidate: AutoClockOutCandidate;
  snapshot: ScheduleSnapshotV1;
  targetEndAt: string;
  detectedAt: string;
}

export interface AutoClockOutPassDependencies {
  now: Date;
  acquireLockAndCandidates(): Promise<{
    lock: { client: PoolClient; release(): Promise<void> };
    candidates: AutoClockOutCandidate[];
  } | null>;
  fetchSchedules(candidates: ScheduleCandidate[]): Promise<Map<string, ScheduleSnapshotV1>>;
  acquireWorkerClient(): Promise<{ client: PoolClient; release(): void }>;
  finalize(input: AutoClockOutFinalizationInput): Promise<
    ClockOutFinalizationResult | { kind: 'finalized' } | { kind: 'setting_disabled' }
  >;
  maxClients?: number;
}

type DueCandidate = {
  candidate: AutoClockOutCandidate;
  snapshot: ScheduleSnapshotV1;
  targetEndAt: string;
};

const createSummary = (): AutoClockOutRunSummary => ({
  runId: randomUUID(),
  candidates: 0,
  due: 0,
  succeeded: 0,
  alreadyClosed: 0,
  failed: 0,
  skipped: {
    missingSchedule: 0,
    invalidSchedule: 0,
    settingDisabled: 0
  },
  durationMs: 0,
  lockAcquired: false
});

export const runAutoClockOutPass = async (
  dependencies: AutoClockOutPassDependencies
): Promise<AutoClockOutRunSummary> => {
  const startedAt = Date.now();
  const summary = createSummary();
  const acquiredWorkers: Array<{ client: PoolClient; release(): void }> = [];
  let acquired: Awaited<ReturnType<AutoClockOutPassDependencies['acquireLockAndCandidates']>> = null;

  try {
    acquired = await dependencies.acquireLockAndCandidates();
    if (!acquired) return summary;

    summary.lockAcquired = true;
    summary.candidates = acquired.candidates.length;
    if (acquired.candidates.length === 0) return summary;

    const snapshots = await dependencies.fetchSchedules(acquired.candidates);
    const due: DueCandidate[] = [];

    for (const candidate of acquired.candidates) {
      const snapshot = snapshots.get(scheduleCandidateKey(candidate));
      if (!snapshot) {
        summary.skipped.missingSchedule += 1;
        continue;
      }

      const targetEndAt = getFinalScheduleEnd(snapshot);
      const targetEpoch = targetEndAt ? Date.parse(targetEndAt) : Number.NaN;
      const startEpoch = Date.parse(candidate.startedAt);
      if (!targetEndAt || !Number.isFinite(targetEpoch) || !Number.isFinite(startEpoch)) {
        summary.skipped.invalidSchedule += 1;
        continue;
      }

      if (targetEpoch <= dependencies.now.getTime() && targetEpoch > startEpoch) {
        due.push({ candidate, snapshot, targetEndAt });
      }
    }

    summary.due = due.length;
    if (due.length === 0) return summary;

    const requestedClientCount = Math.max(
      1,
      Math.min(MAX_POSTGRES_CLIENTS, dependencies.maxClients ?? MAX_POSTGRES_CLIENTS, due.length)
    );
    for (let index = 1; index < requestedClientCount; index += 1) {
      acquiredWorkers.push(await dependencies.acquireWorkerClient());
    }

    const clients = [acquired.lock.client, ...acquiredWorkers.map((worker) => worker.client)];
    const lanes = clients.map((client, laneIndex) => async () => {
      for (let index = laneIndex; index < due.length; index += clients.length) {
        const item = due[index];
        try {
          const result = await dependencies.finalize({
            client,
            candidate: item.candidate,
            snapshot: item.snapshot,
            targetEndAt: item.targetEndAt,
            detectedAt: dependencies.now.toISOString()
          });
          if (result.kind === 'finalized') {
            summary.succeeded += 1;
          } else if (result.kind === 'already_closed') {
            summary.alreadyClosed += 1;
          } else if (result.kind === 'setting_disabled') {
            summary.skipped.settingDisabled += 1;
          } else {
            summary.failed += 1;
          }
        } catch {
          summary.failed += 1;
        }
      }
    });

    await Promise.all(lanes.map((lane) => lane()));
    return summary;
  } finally {
    for (const worker of acquiredWorkers) {
      try {
        worker.release();
      } catch {
        // A release failure cannot safely abort cleanup of the remaining clients.
      }
    }
    if (acquired) {
      try {
        await acquired.lock.release();
      } catch {
        // Production lock cleanup discards a connection when unlock fails.
      }
    }
    summary.durationMs = Date.now() - startedAt;
  }
};

type CandidateRow = {
  day_id: unknown;
  franchiseid: unknown;
  tutorid: unknown;
  work_date: unknown;
  timezone: unknown;
  open_session_id: unknown;
  start_at: unknown;
};

const normalizeDateOnly = (value: unknown): string | null => {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const epoch = Date.parse(trimmed);
  return Number.isFinite(epoch) ? new Date(epoch).toISOString().slice(0, 10) : null;
};

const normalizeId = (value: unknown): number | null => {
  const normalized = Number(value);
  return Number.isSafeInteger(normalized) && normalized > 0 ? normalized : null;
};

const releaseAdvisoryLock = async (client: PoolClient): Promise<void> => {
  try {
    const result = await client.query<{ unlocked: boolean }>(
      'SELECT pg_advisory_unlock($1) AS unlocked',
      [ADVISORY_LOCK_KEY]
    );
    if (result.rows[0]?.unlocked !== true) {
      throw new Error('advisory_unlock_failed');
    }
    client.release();
  } catch (error) {
    client.release(error instanceof Error ? error : new Error('advisory_unlock_failed'));
    throw error;
  }
};

export const acquireProductionLockAndCandidates = async (pool: Pool): Promise<{
  lock: { client: PoolClient; release(): Promise<void> };
  candidates: AutoClockOutCandidate[];
} | null> => {
  const client = await pool.connect();
  let ownsLock = false;
  try {
    const lockResult = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS acquired',
      [ADVISORY_LOCK_KEY]
    );
    ownsLock = lockResult.rows[0]?.acquired === true;
    if (!ownsLock) {
      client.release();
      return null;
    }

    const result = await client.query<CandidateRow>(`
      SELECT
        day.id AS day_id,
        day.franchiseid,
        day.tutorid,
        day.work_date,
        settings.timezone,
        session.id AS open_session_id,
        session.start_at
      FROM public.time_entry_days day
      JOIN public.time_entry_sessions session
        ON session.entry_day_id = day.id AND session.end_at IS NULL
      JOIN public.franchise_payroll_settings settings
        ON settings.franchiseid = day.franchiseid
       AND settings.auto_clock_out_enabled = TRUE
      WHERE day.clock_state = 1
        AND day.work_date IN (
          (NOW() AT TIME ZONE settings.timezone)::date,
          ((NOW() AT TIME ZONE settings.timezone)::date - 1)
        )
      ORDER BY day.franchiseid, day.tutorid, day.work_date
    `);

    const candidates: AutoClockOutCandidate[] = [];
    for (const row of result.rows) {
      const dayId = normalizeId(row.day_id);
      const franchiseId = normalizeId(row.franchiseid);
      const tutorId = normalizeId(row.tutorid);
      const workDate = normalizeDateOnly(row.work_date);
      const openSessionId = normalizeId(row.open_session_id);
      const startedEpoch = row.start_at instanceof Date
        ? row.start_at.getTime()
        : Date.parse(String(row.start_at));
      const timezone = typeof row.timezone === 'string' ? row.timezone.trim() : '';
      if (!dayId || !franchiseId || !tutorId || !workDate || !openSessionId ||
          !Number.isFinite(startedEpoch) || !timezone) continue;
      candidates.push({
        dayId,
        franchiseId,
        tutorId,
        workDate,
        timezone,
        openSessionId,
        startedAt: new Date(startedEpoch).toISOString()
      });
    }

    return {
      lock: { client, release: () => releaseAdvisoryLock(client) },
      candidates
    };
  } catch (error) {
    if (ownsLock) {
      try {
        await releaseAdvisoryLock(client);
      } catch {
        // releaseAdvisoryLock already discarded the connection.
      }
    } else {
      client.release(error instanceof Error ? error : new Error('candidate_read_failed'));
    }
    throw error;
  }
};

type LockedDayRow = TimeEntryDayRow & { auto_clock_out_enabled: boolean | null };
type RuntimeRow = Record<string, unknown>;

const normalizeRequiredTimestamp = (value: unknown, field: string): string => {
  const epoch = value instanceof Date ? value.getTime() : Date.parse(String(value));
  if (!Number.isFinite(epoch)) throw new Error(`invalid_${field}`);
  return new Date(epoch).toISOString();
};

const normalizeNullableTimestamp = (value: unknown, field: string): string | null =>
  value === null || value === undefined ? null : normalizeRequiredTimestamp(value, field);

const normalizeNullableId = (value: unknown, field: string): number | null => {
  if (value === null || value === undefined) return null;
  const id = normalizeId(value);
  if (id === null) throw new Error(`invalid_${field}`);
  return id;
};

const normalizeClockState = (value: unknown): number => {
  const state = Number(value);
  if (state !== 0 && state !== 1) throw new Error('invalid_clock_state');
  return state;
};

const normalizeDayRow = (row: RuntimeRow): TimeEntryDayRow => {
  const id = normalizeId(row.id);
  const franchiseid = normalizeId(row.franchiseid);
  const tutorid = normalizeId(row.tutorid);
  const workDate = normalizeDateOnly(row.work_date);
  const timezone = typeof row.timezone === 'string' ? row.timezone.trim() : '';
  const status = row.status;
  if (!id || !franchiseid || !tutorid || !workDate || !timezone) throw new Error('invalid_day');
  if (status !== 'draft' && status !== 'pending' && status !== 'approved' && status !== 'denied') {
    throw new Error('invalid_day_status');
  }
  return {
    id,
    franchiseid,
    tutorid,
    work_date: workDate,
    timezone,
    status,
    clock_state: normalizeClockState(row.clock_state),
    schedule_snapshot: row.schedule_snapshot ?? null,
    comparison: row.comparison ?? null,
    submitted_at: normalizeNullableTimestamp(row.submitted_at, 'submitted_at'),
    decided_by: normalizeNullableId(row.decided_by, 'decided_by'),
    decided_at: normalizeNullableTimestamp(row.decided_at, 'decided_at'),
    decision_reason: row.decision_reason === null || row.decision_reason === undefined
      ? null
      : String(row.decision_reason),
    created_at: normalizeRequiredTimestamp(row.created_at, 'created_at'),
    updated_at: normalizeRequiredTimestamp(row.updated_at, 'updated_at')
  };
};

const normalizeSessionRow = (row: RuntimeRow): { id: number; start_at: string } => {
  const id = normalizeId(row.id);
  if (!id) throw new Error('invalid_session_id');
  return { id, start_at: normalizeRequiredTimestamp(row.start_at, 'session_start_at') };
};

const normalizeBreakRow = (row: RuntimeRow): TimeEntryBreakRow => {
  const id = normalizeId(row.id);
  const entryDayId = normalizeId(row.entry_day_id);
  const franchiseId = normalizeId(row.franchiseid);
  const tutorId = normalizeId(row.tutorid);
  const sessionId = normalizeNullableId(row.time_entry_session_id, 'break_session_id');
  const durationMinutes = Number(row.duration_minutes);
  if (!id || !entryDayId || !franchiseId || !tutorId ||
      !Number.isInteger(durationMinutes) || durationMinutes < 0) {
    throw new Error('invalid_break');
  }
  if (!isBreakType(row.break_type) || !isPayTreatment(row.pay_treatment) ||
      !isBreakSource(row.source) || !isBreakStatus(row.status)) {
    throw new Error('invalid_break_status');
  }
  return {
    id,
    entry_day_id: entryDayId,
    time_entry_session_id: sessionId,
    franchiseid: franchiseId,
    tutorid: tutorId,
    break_type: row.break_type,
    pay_treatment: row.pay_treatment,
    start_time: normalizeNullableTimestamp(row.start_time, 'break_start_time'),
    end_time: normalizeNullableTimestamp(row.end_time, 'break_end_time'),
    duration_minutes: durationMinutes,
    source: row.source,
    status: row.status,
    note: row.note === null || row.note === undefined ? null : String(row.note),
    created_at: normalizeRequiredTimestamp(row.created_at, 'break_created_at'),
    updated_at: normalizeRequiredTimestamp(row.updated_at, 'break_updated_at')
  };
};

export const finalizeProductionCandidate = async (
  input: AutoClockOutFinalizationInput,
  finalize: FinalizeClockOutInTransaction = finalizeClockOutInTransaction
): Promise<ClockOutFinalizationResult | { kind: 'setting_disabled' }> => {
  const { client, candidate } = input;
  await client.query('BEGIN');
  try {
    const dayResult = await client.query<RuntimeRow>(
      `SELECT * FROM public.time_entry_days
        WHERE id = $1 AND franchiseid = $2 AND tutorid = $3
        FOR UPDATE`,
      [candidate.dayId, candidate.franchiseId, candidate.tutorId]
    );
    const dayRow = dayResult.rows[0];

    const settingResult = await client.query<Pick<LockedDayRow, 'auto_clock_out_enabled'>>(
      `SELECT auto_clock_out_enabled
         FROM public.franchise_payroll_settings
        WHERE franchiseid = $1
        FOR UPDATE`,
      [candidate.franchiseId]
    );
    if (!dayRow || settingResult.rows[0]?.auto_clock_out_enabled !== true) {
      await client.query('ROLLBACK');
      return { kind: 'setting_disabled' };
    }
    const day = normalizeDayRow(dayRow);

    const sessionResult = await client.query<RuntimeRow>(
      `SELECT id, start_at
         FROM public.time_entry_sessions
        WHERE id = $1 AND entry_day_id = $2 AND end_at IS NULL
        FOR UPDATE`,
      [candidate.openSessionId, candidate.dayId]
    );
    const openSessionRow = sessionResult.rows[0];
    if (!openSessionRow || day.clock_state !== 1) {
      await client.query('ROLLBACK');
      return { kind: 'already_closed' };
    }
    const openSession = normalizeSessionRow(openSessionRow);

    const breakResult = await client.query<RuntimeRow>(
      `SELECT * FROM public.time_entry_breaks
        WHERE entry_day_id = $1 AND status = 'active'
        ORDER BY start_time DESC
        LIMIT 1
        FOR UPDATE`,
      [candidate.dayId]
    );

    const activeBreak = breakResult.rows[0] ? normalizeBreakRow(breakResult.rows[0]) : null;
    const result = await finalize({
      transaction: createPostgresClockOutTransaction(client),
      day,
      openSession,
      activeBreak,
      targetEndAt: input.targetEndAt,
      detectedAt: input.detectedAt,
      snapshot: input.snapshot,
      source: 'auto_clock_out',
      actor: { accountType: 'SYSTEM', accountId: null },
      activeBreakPolicy: 'close'
    });

    if (result.kind === 'finalized') {
      await client.query('COMMIT');
    } else {
      await client.query('ROLLBACK');
    }
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the original error category for the caller.
    }
    throw error;
  }
};

export interface AutoClockOutProductionPassOptions {
  pool?: Pool;
  now?: Date;
  fetchSchedules?: AutoClockOutPassDependencies['fetchSchedules'];
  finalize?: AutoClockOutPassDependencies['finalize'];
}

export const runProductionPass = async (
  options: AutoClockOutProductionPassOptions = {}
): Promise<AutoClockOutRunSummary> => {
  const pool = options.pool ?? getPostgresPool();
  const configuredMax = Number(pool.options.max);
  const maxClients = Math.max(
    1,
    Math.min(MAX_POSTGRES_CLIENTS, Number.isFinite(configuredMax) ? configuredMax : 10)
  );
  return runAutoClockOutPass({
    now: options.now ?? new Date(),
    acquireLockAndCandidates: () => acquireProductionLockAndCandidates(pool),
    fetchSchedules: options.fetchSchedules ?? fetchLatestScheduleSnapshots,
    acquireWorkerClient: async () => {
      const client = await pool.connect();
      return { client, release: () => client.release() };
    },
    finalize: options.finalize ?? finalizeProductionCandidate,
    maxClients
  });
};

export interface AutoClockOutSchedulerOptions {
  now?: () => Date;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  runPass?: () => Promise<AutoClockOutRunSummary | void>;
  log?: Pick<Console, 'info' | 'error'>;
}

export const startAutoClockOutScheduler = (
  options: AutoClockOutSchedulerOptions = {}
): { stop(): void } => {
  const now = options.now ?? (() => new Date());
  const setTimer: NonNullable<AutoClockOutSchedulerOptions['setTimer']> =
    options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer = options.clearTimer ?? clearTimeout;
  const runPass = options.runPass ?? runProductionPass;
  const log = options.log ?? console;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let running = false;

  const scheduleNext = (): void => {
    if (stopped || running) return;
    const current = now();
    const next = nextAutoClockOutTick(current);
    timer = setTimer(() => {
      timer = undefined;
      if (stopped || running) return;
      if (!isAutoClockOutMinute(now())) {
        scheduleNext();
        return;
      }
      running = true;
      void runPass()
        .then((summary) => {
          if (summary) log.info('[auto-clock-out] pass summary', summary);
        })
        .catch(() => {
          log.error('[auto-clock-out] pass failed', { category: 'pass_failed' });
        })
        .finally(() => {
          running = false;
          scheduleNext();
        });
    }, Math.max(0, next.getTime() - current.getTime()));
  };

  scheduleNext();
  return {
    stop(): void {
      stopped = true;
      if (timer !== undefined) {
        clearTimer(timer);
        timer = undefined;
      }
    }
  };
};
