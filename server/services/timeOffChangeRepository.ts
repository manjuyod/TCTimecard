import { createHash } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import type { NormalizedTimeOffSubmission, TimeOffType } from '../types/timeoff';
import type {
  AmendmentStatus,
  TimeOffAmendment,
  TimeOffChangeActorType,
  TimeOffChangeCommand,
  TimeOffChangeDelivery,
  TimeOffChangeDetail,
  TimeOffChangeHistoryEntry,
  TimeOffChangeOperationAction,
  TimeOffChangeOperationActor,
  TimeOffChangeReceipt
} from '../types/timeOffChanges';
import { canonicalJsonStringify } from './scheduleSnapshot';
import { TimeOffChangeError } from './timeOffChangeErrors';
import { mapTimeOffRow, TimeOffRow } from './timeOffRepository';

type Queryable = Pick<PoolClient, 'query'>;

const REQUEST_COLUMNS = `
  id, franchiseid, tutorid, bridge_flag, bridge_profile_id, first_name, last_name, email,
  start_at, end_at, type, absence_label, notes, status, created_at, created_by, decided_at,
  decided_by, decision_reason, google_calendar_event_id, duration_hours, partial_day,
  leave_time, return_time, public_metadata, version::TEXT AS version, google_calendar_id
`;

export const AMENDMENT_COLUMNS = `
  id::TEXT AS id, request_id, base_version::TEXT AS base_version, start_date::TEXT AS start_date,
  end_date::TEXT AS end_date, start_at, end_at, partial_day, leave_time, return_time, type, storage_type,
  absence_label, reason, duration_hours::TEXT AS duration_hours, timezone, change_reason, proposed_by,
  created_at, status, decided_by_type, decided_by, decided_at, decision_reason
`;

const DELIVERY_COLUMNS = `
  id::TEXT AS id, operation_id::TEXT AS operation_id, request_id, channel, kind, status, attempts,
  next_attempt_at, last_error, target_version::TEXT AS target_version, created_at, completed_at
`;

interface VersionedTimeOffRow extends TimeOffRow {
  version: string;
  google_calendar_id: string | null;
}

export interface AmendmentRow extends QueryResultRow {
  id: string;
  request_id: string | number;
  base_version: string;
  start_date: string;
  end_date: string;
  start_at: string | Date;
  end_at: string | Date;
  partial_day: boolean;
  leave_time: string | null;
  return_time: string | null;
  type: TimeOffType;
  storage_type: NormalizedTimeOffSubmission['storageType'];
  absence_label: string;
  reason: string;
  duration_hours: string;
  timezone: string;
  change_reason: string;
  proposed_by: string | number;
  created_at: string | Date;
  status: AmendmentStatus;
  decided_by_type: TimeOffChangeActorType | null;
  decided_by: string | number | null;
  decided_at: string | Date | null;
  decision_reason: string | null;
}

/** Exact `time_off_change_operations` columns, written once and never updated. */
export interface TimeOffChangeOperationInput {
  id: string;
  requestId: number;
  actorType: TimeOffChangeActorType;
  actorId: number;
  franchiseId: number;
  action: TimeOffChangeOperationAction;
  amendmentId: string | null;
  expectedVersion: string;
  resultVersion: string;
  idempotencyKey: string;
  inputHash: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  target: NormalizedTimeOffSubmission | null;
  changeReason: string | null;
  response: TimeOffChangeReceipt;
}

const iso = (value: string | Date): string => new Date(value).toISOString();
const isoOrNull = (value: string | Date | null): string | null => (value === null ? null : iso(value));

export function mapAmendmentRow(row: AmendmentRow): TimeOffAmendment {
  return {
    id: String(row.id),
    requestId: Number(row.request_id),
    baseVersion: String(row.base_version),
    status: row.status,
    proposed: {
      startDate: row.start_date,
      endDate: row.end_date,
      startAt: iso(row.start_at),
      endAt: iso(row.end_at),
      partialDay: row.partial_day,
      leaveTime: row.leave_time,
      returnTime: row.return_time,
      type: row.type,
      storageType: row.storage_type,
      absenceLabel: row.absence_label,
      reason: row.reason,
      durationHours: Number(row.duration_hours)
    },
    timezone: row.timezone,
    changeReason: row.change_reason,
    proposedBy: Number(row.proposed_by),
    createdAt: iso(row.created_at),
    decidedByType: row.decided_by_type,
    decidedBy: row.decided_by === null ? null : Number(row.decided_by),
    decidedAt: isoOrNull(row.decided_at),
    decisionReason: row.decision_reason
  };
}

export function mapDeliveryRow(row: QueryResultRow): TimeOffChangeDelivery {
  return {
    id: String(row.id),
    operationId: String(row.operation_id),
    requestId: Number(row.request_id),
    channel: row.channel,
    kind: String(row.kind),
    status: row.status,
    attempts: Number(row.attempts),
    nextAttemptAt: isoOrNull(row.next_attempt_at ?? null),
    lastError: row.last_error ?? null,
    targetVersion: String(row.target_version),
    createdAt: iso(row.created_at),
    completedAt: isoOrNull(row.completed_at ?? null)
  };
}

function mapHistoryRow(row: QueryResultRow): TimeOffChangeHistoryEntry {
  return {
    operationId: String(row.id),
    action: row.action,
    actorType: row.actor_type,
    actorId: Number(row.actor_id),
    at: iso(row.created_at),
    reason: row.change_reason ?? null,
    amendmentId: row.amendment_id === null ? null : String(row.amendment_id),
    resultVersion: String(row.result_version),
    before: row.before_snapshot ?? {},
    after: row.after_snapshot ?? {}
  };
}

export async function lockTimeOffChangeRequest(
  client: Queryable,
  requestId: number,
  timezone: string
): Promise<{ request: ReturnType<typeof mapTimeOffRow>; version: string } | null> {
  const result = await client.query<VersionedTimeOffRow>(
    `SELECT ${REQUEST_COLUMNS} FROM public.time_off_requests WHERE id = $1 FOR UPDATE`,
    [requestId]
  );
  const row = result.rows[0];
  return row ? { request: mapTimeOffRow(row, timezone), version: String(row.version) } : null;
}

/** Reads the unauthorized detail; callers authorize scope and set `allowedActions`. */
export async function readTimeOffChangeDetail(
  client: Queryable,
  requestId: number,
  timezone: string
): Promise<TimeOffChangeDetail | null> {
  const requestResult = await client.query<VersionedTimeOffRow>(
    `SELECT ${REQUEST_COLUMNS} FROM public.time_off_requests WHERE id = $1`,
    [requestId]
  );
  const row = requestResult.rows[0];
  if (!row) return null;
  const [amendments, history, deliveries] = [
    await client.query<AmendmentRow>(
      `SELECT ${AMENDMENT_COLUMNS} FROM public.time_off_amendments WHERE request_id = $1 AND status = 'pending'`,
      [requestId]
    ),
    await client.query(
      `SELECT id::TEXT AS id, action, actor_type, actor_id, created_at, change_reason, amendment_id::TEXT AS amendment_id,
         result_version::TEXT AS result_version, before_snapshot, after_snapshot
       FROM public.time_off_change_operations WHERE request_id = $1
       ORDER BY result_version ASC, created_at ASC`,
      [requestId]
    ),
    await client.query(
      `SELECT ${DELIVERY_COLUMNS} FROM public.time_off_change_deliveries WHERE request_id = $1
       ORDER BY created_at DESC, id DESC LIMIT 100`,
      [requestId]
    )
  ];
  return {
    request: mapTimeOffRow(row, timezone),
    version: String(row.version),
    timezone,
    pendingAmendment: amendments.rows[0] ? mapAmendmentRow(amendments.rows[0]) : null,
    history: history.rows.map(mapHistoryRow),
    deliveries: deliveries.rows.map(mapDeliveryRow),
    allowedActions: []
  };
}

/**
 * Returns the stored receipt for an actor-scoped key. A reused key with a
 * different normalized command is a conflict, never a silent replay.
 */
export async function findTimeOffChangeReplay(
  client: Queryable,
  actor: TimeOffChangeOperationActor,
  key: string,
  inputHash: string
): Promise<TimeOffChangeReceipt | null> {
  const result = await client.query<{ input_hash: string; response: TimeOffChangeReceipt }>(
    `SELECT input_hash, response FROM public.time_off_change_operations
     WHERE actor_type = $1 AND actor_id = $2 AND franchiseid = $3 AND idempotency_key = $4`,
    [actor.kind, actor.accountId, actor.franchiseId, key]
  );
  const stored = result.rows[0];
  if (!stored) return null;
  if (stored.input_hash !== inputHash) {
    throw new TimeOffChangeError(
      'TIME_OFF_IDEMPOTENCY_MISMATCH',
      'This idempotency key was already used for a different change',
      409
    );
  }
  return stored.response;
}

export async function persistTimeOffChangeOperation(
  client: Queryable,
  operation: TimeOffChangeOperationInput
): Promise<TimeOffChangeReceipt> {
  await client.query(
    `INSERT INTO public.time_off_change_operations
      (id, request_id, actor_type, actor_id, franchiseid, action, amendment_id, expected_version,
       result_version, idempotency_key, input_hash, before_snapshot, after_snapshot, target, change_reason, response)
     VALUES ($1, $2, $3, $4, $5, $6, $7::BIGINT, $8::BIGINT, $9::BIGINT, $10, $11, $12, $13, $14, $15, $16)`,
    [
      operation.id,
      operation.requestId,
      operation.actorType,
      operation.actorId,
      operation.franchiseId,
      operation.action,
      operation.amendmentId,
      operation.expectedVersion,
      operation.resultVersion,
      operation.idempotencyKey,
      operation.inputHash,
      operation.before,
      operation.after,
      operation.target,
      operation.changeReason,
      operation.response
    ]
  );
  return operation.response;
}

/** A unique-key race lost to another transaction; roll back and fetch the winner. */
export function isTimeOffChangeKeyConflict(error: unknown): boolean {
  const candidate = error as { code?: string; constraint?: string } | null;
  return candidate?.code === '23505' && candidate.constraint === 'time_off_change_operations_scope_key';
}

type HashableCommand = Omit<TimeOffChangeCommand, 'actor' | 'nowIso' | 'idempotencyKey'> & Record<string, unknown>;

/**
 * Hashes the meaning of a command: action, request, expected version, and
 * normalized inputs. Actor scope lives in the lookup key; receipt time and the
 * key itself are excluded so a retried request matches its first attempt.
 */
export function hashTimeOffChangeCommand(command: TimeOffChangeCommand): string {
  const { actor: _actor, nowIso: _nowIso, idempotencyKey: _key, ...rest } = command;
  const normalized: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(rest as HashableCommand)) {
    normalized[field] = field === 'proposed' ? normalizeProposedForHash(value) : normalizeHashValue(value);
  }
  return createHash('sha256').update(canonicalJsonStringify(normalized)).digest('hex');
}

function normalizeProposedForHash(value: unknown): Record<string, unknown> {
  const input = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const text = (field: unknown) => (typeof field === 'string' ? field.trim() : '');
  const partialDay = typeof input.partialDay === 'boolean'
    ? input.partialDay
    : ['true', '1', 'yes', 'on'].includes(text(input.partialDay).toLowerCase());
  const startDate = text(input.startDate);
  return {
    startDate,
    endDate: text(input.endDate) || startDate,
    partialDay,
    leaveTime: partialDay ? text(input.leaveTime) || null : null,
    returnTime: partialDay ? text(input.returnTime) || null : null,
    type: text(input.type).toLowerCase(),
    reason: text(input.reason)
  };
}

function normalizeHashValue(value: unknown): unknown {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(normalizeHashValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalizeHashValue(entry)]));
  }
  return value;
}
