import { createHash } from 'node:crypto';
import { DateTime } from 'luxon';
import type { PoolClient, QueryResultRow } from 'pg';
import type { NormalizedTimeOffSubmission, TimeOffRecord, TimeOffType } from '../types/timeoff';
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
  TimeOffChangePage,
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
): Promise<{ request: ReturnType<typeof mapTimeOffRow>; version: string; calendarId: string | null } | null> {
  const result = await client.query<VersionedTimeOffRow>(
    `SELECT ${REQUEST_COLUMNS} FROM public.time_off_requests WHERE id = $1 FOR UPDATE`,
    [requestId]
  );
  const row = result.rows[0];
  return row
    ? { request: mapTimeOffRow(row, timezone), version: String(row.version), calendarId: row.google_calendar_id ?? null }
    : null;
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

export async function lockPendingAmendment(client: Queryable, requestId: number): Promise<TimeOffAmendment | null> {
  const result = await client.query<AmendmentRow>(
    `SELECT ${AMENDMENT_COLUMNS} FROM public.time_off_amendments
     WHERE request_id = $1 AND status = 'pending' FOR UPDATE`,
    [requestId]
  );
  return result.rows[0] ? mapAmendmentRow(result.rows[0]) : null;
}

export async function findAmendment(client: Queryable, requestId: number, amendmentId: string): Promise<TimeOffAmendment | null> {
  const result = await client.query<AmendmentRow>(
    `SELECT ${AMENDMENT_COLUMNS} FROM public.time_off_amendments WHERE request_id = $1 AND id = $2::BIGINT`,
    [requestId, amendmentId]
  );
  return result.rows[0] ? mapAmendmentRow(result.rows[0]) : null;
}

export async function insertAmendment(client: Queryable, input: {
  requestId: number;
  baseVersion: string;
  proposed: NormalizedTimeOffSubmission;
  timezone: string;
  changeReason: string;
  proposedBy: number;
}): Promise<TimeOffAmendment> {
  const value = input.proposed;
  const result = await client.query<AmendmentRow>(
    `INSERT INTO public.time_off_amendments
      (request_id, base_version, start_date, end_date, start_at, end_at, partial_day, leave_time, return_time,
       type, storage_type, absence_label, reason, duration_hours, timezone, change_reason, proposed_by)
     VALUES ($1, $2::BIGINT, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     RETURNING ${AMENDMENT_COLUMNS}`,
    [
      input.requestId, input.baseVersion, value.startDate, value.endDate, value.startAt, value.endAt, value.partialDay,
      value.leaveTime, value.returnTime, value.type, value.storageType, value.absenceLabel, value.reason,
      value.durationHours, input.timezone, input.changeReason, input.proposedBy
    ]
  );
  return mapAmendmentRow(result.rows[0]);
}

export async function closeAmendment(client: Queryable, input: {
  id: string;
  status: Exclude<AmendmentStatus, 'pending'>;
  decidedByType: TimeOffChangeActorType;
  decidedBy: number;
  decisionReason: string | null;
}): Promise<TimeOffAmendment> {
  const result = await client.query<AmendmentRow>(
    `UPDATE public.time_off_amendments
     SET status = $2, decided_by_type = $3, decided_by = $4, decided_at = NOW(), decision_reason = $5
     WHERE id = $1::BIGINT AND status = 'pending'
     RETURNING ${AMENDMENT_COLUMNS}`,
    [input.id, input.status, input.decidedByType, input.decidedBy, input.decisionReason]
  );
  if (!result.rows[0]) {
    throw new TimeOffChangeError('TIME_OFF_AMENDMENT_CLOSED', 'This change request is no longer pending', 409);
  }
  return mapAmendmentRow(result.rows[0]);
}

/** A delivery job planned inside the business transaction; inserted as written. */
export interface TimeOffChangeDeliveryInput {
  id: string;
  channel: 'calendar' | 'email';
  kind: string;
  targetVersion: string;
  payload: Record<string, unknown>;
  recipient: string | null;
  identity: string | null;
  calendarId: string | null;
  recoveryEventId: string | null;
  dedupeKey: string;
  status: 'pending' | 'failed';
  lastError: string | null;
}

export async function insertTimeOffChangeDeliveries(
  client: Queryable,
  operationId: string,
  requestId: number,
  deliveries: TimeOffChangeDeliveryInput[],
  nowIso: string
): Promise<void> {
  for (const delivery of deliveries) {
    await client.query(
      `INSERT INTO public.time_off_change_deliveries
        (id, operation_id, request_id, channel, kind, target_version, payload, recipient, identity, calendar_id,
         recovery_event_id, dedupe_key, status, last_error, next_attempt_at, completed_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::BIGINT, $7, $8, $9, $10, $11, $12, $13, $14,
         CASE WHEN $13 = 'pending' THEN $15::TIMESTAMPTZ END, CASE WHEN $13 = 'failed' THEN $15::TIMESTAMPTZ END,
         $15::TIMESTAMPTZ, $15::TIMESTAMPTZ)`,
      [
        delivery.id, operationId, requestId, delivery.channel, delivery.kind, delivery.targetVersion, delivery.payload,
        delivery.recipient, delivery.identity, delivery.calendarId, delivery.recoveryEventId, delivery.dedupeKey,
        delivery.status, delivery.lastError, nowIso
      ]
    );
  }
}

/** Pending proposals at or past the earlier of the current and proposed starts. */
export async function findExpiredAmendments(
  db: Queryable,
  nowIso: string,
  limit: number
): Promise<Array<{ amendmentId: string; requestId: number; franchiseId: number }>> {
  const result = await db.query<{ amendment_id: string; request_id: string; franchiseid: number }>(
    `SELECT amendment.id::TEXT AS amendment_id, amendment.request_id, request.franchiseid
     FROM public.time_off_amendments amendment
     JOIN public.time_off_requests request ON request.id = amendment.request_id
     WHERE amendment.status = 'pending' AND LEAST(request.start_at, amendment.start_at) <= $1
     ORDER BY LEAST(request.start_at, amendment.start_at), amendment.id
     LIMIT $2`,
    [nowIso, limit]
  );
  return result.rows.map((row) => ({
    amendmentId: row.amendment_id,
    requestId: Number(row.request_id),
    franchiseId: Number(row.franchiseid)
  }));
}

/** Other pending/approved leave for the same tutor that intersects an interval. */
export async function findTimeOffOverlapCandidates(
  db: Queryable,
  input: { tutorId: number; requestId: number; startAt: string; endAt: string }
): Promise<Array<{ id: number; status: TimeOffRecord['status']; startAt: string; endAt: string }>> {
  const result = await db.query<{ id: string; status: TimeOffRecord['status']; start_at: string | Date; end_at: string | Date }>(
    `SELECT id, status, start_at, end_at FROM public.time_off_requests
     WHERE tutorid = $1 AND id <> $2 AND status IN ('pending', 'approved')
       AND start_at < $4 AND end_at > $3`,
    [input.tutorId, input.requestId, input.startAt, input.endAt]
  );
  return result.rows.map((row) => ({ id: Number(row.id), status: row.status, startAt: iso(row.start_at), endAt: iso(row.end_at) }));
}

/**
 * Re-queues a failed delivery for a scoped admin without repeating the
 * business change. Calendar jobs replaced by a newer target stay closed.
 */
export async function retryTimeOffChangeDelivery(
  db: Queryable,
  input: { franchiseId: number; deliveryId: string; nowIso: string }
): Promise<TimeOffChangeDelivery> {
  const current = await db.query<{ status: string; has_newer_calendar_target: boolean }>(
    `SELECT delivery.status,
       EXISTS (
         SELECT 1 FROM public.time_off_change_deliveries newer
         WHERE delivery.channel = 'calendar' AND newer.channel = 'calendar'
           AND newer.request_id = delivery.request_id AND newer.target_version > delivery.target_version
       ) AS has_newer_calendar_target
     FROM public.time_off_change_deliveries delivery
     JOIN public.time_off_requests request ON request.id = delivery.request_id
     WHERE delivery.id::TEXT = $1 AND request.franchiseid = $2`,
    [input.deliveryId, input.franchiseId]
  );
  const row = current.rows[0];
  if (!row) throw new TimeOffChangeError('TIME_OFF_DELIVERY_NOT_FOUND', 'Delivery not found', 404);
  if (row.status === 'superseded' || row.has_newer_calendar_target) {
    throw new TimeOffChangeError('TIME_OFF_DELIVERY_SUPERSEDED', 'A newer calendar change replaced this delivery', 409);
  }
  const updated = await db.query(
    `UPDATE public.time_off_change_deliveries
     SET status = 'pending', attempts = 0, next_attempt_at = $2::TIMESTAMPTZ, completed_at = NULL,
       updated_at = $2::TIMESTAMPTZ
     WHERE id::TEXT = $1 AND status = 'failed'
     RETURNING ${DELIVERY_COLUMNS}`,
    [input.deliveryId, input.nowIso]
  );
  if (!updated.rows[0]) {
    throw new TimeOffChangeError('TIME_OFF_DELIVERY_NOT_RETRYABLE', 'Only failed deliveries can be retried', 409);
  }
  return mapDeliveryRow(updated.rows[0]);
}

const REQUEST_FIELDS = [
  'id', 'franchiseid', 'tutorid', 'bridge_flag', 'bridge_profile_id', 'first_name', 'last_name', 'email',
  'start_at', 'end_at', 'type', 'absence_label', 'notes', 'status', 'created_at', 'created_by', 'decided_at',
  'decided_by', 'decision_reason', 'google_calendar_event_id', 'duration_hours', 'partial_day',
  'leave_time', 'return_time', 'public_metadata', 'google_calendar_id'
];
const qualifiedRequestColumns = (alias: string) =>
  `${REQUEST_FIELDS.map((field) => `${alias}.${field}`).join(', ')}, ${alias}.version::TEXT AS version`;

const AMENDMENT_FIELDS: Array<[string, string]> = [
  ['id', '::TEXT'], ['request_id', ''], ['base_version', '::TEXT'], ['start_date', '::TEXT'], ['end_date', '::TEXT'],
  ['start_at', ''], ['end_at', ''], ['partial_day', ''], ['leave_time', ''], ['return_time', ''], ['type', ''],
  ['storage_type', ''], ['absence_label', ''], ['reason', ''], ['duration_hours', '::TEXT'], ['timezone', ''],
  ['change_reason', ''], ['proposed_by', ''], ['created_at', ''], ['status', ''], ['decided_by_type', ''],
  ['decided_by', ''], ['decided_at', ''], ['decision_reason', '']
];
const AMENDMENT_PREFIX = 'amendment__';
const prefixedAmendmentColumns = (alias: string) =>
  AMENDMENT_FIELDS.map(([field, cast]) => `${alias}.${field}${cast} AS ${AMENDMENT_PREFIX}${field}`).join(', ');

const MAX_CURSOR_LENGTH = 2000;

function cursorScope(filters: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJsonStringify(filters)).digest('hex').slice(0, 24);
}

function encodeListCursor(filters: Record<string, unknown>, tuple: [string, string]): string {
  return Buffer.from(JSON.stringify({ s: cursorScope(filters), t: tuple })).toString('base64url');
}

/** Cursors are opaque and only valid for the exact filters that produced them. */
function decodeListCursor(cursor: string | undefined, filters: Record<string, unknown>): [string, string] | null {
  if (cursor === undefined) return null;
  const invalidCursor = () =>
    new TimeOffChangeError('TIME_OFF_INVALID_CURSOR', 'This page link is no longer valid; reload the list', 400);
  if (cursor.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw invalidCursor();
  let payload: { s?: unknown; t?: unknown };
  try {
    payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { s?: unknown; t?: unknown };
  } catch {
    throw invalidCursor();
  }
  if (payload.s !== cursorScope(filters) || !Array.isArray(payload.t) || payload.t.length !== 2) throw invalidCursor();
  return [String(payload.t[0]), String(payload.t[1])];
}

export type AdminTimeOffStatusFilter = 'approved' | 'cancelled' | 'denied' | 'pending' | 'all';

export interface AdminTimeOffListQuery {
  franchiseId: number;
  timezone: string;
  /** The center-local date used for the default "upcoming approved" view. */
  today: string;
  status?: AdminTimeOffStatusFilter;
  tutorId?: number;
  from?: string;
  to?: string;
  requestId?: number;
  cursor?: string;
  limit: number;
}

export interface TimeOffChangeListItem {
  request: TimeOffRecord;
  version: string;
  pendingAmendmentId: string | null;
}

/**
 * Scoped management list ordered by (start_at DESC, id DESC). With no status
 * or date filter it shows approved requests starting today or later; dates
 * filter by overlap with whole local days in the center timezone.
 */
export async function listAdminTimeOffRequests(
  db: Queryable,
  query: AdminTimeOffListQuery
): Promise<TimeOffChangePage<TimeOffChangeListItem>> {
  const useDefault = query.status === undefined && query.from === undefined && query.to === undefined;
  const status = query.status ?? 'approved';
  const localStart = (date: string) => DateTime.fromISO(date, { zone: query.timezone }).startOf('day');
  const filters = {
    franchiseId: query.franchiseId,
    status,
    tutorId: query.tutorId ?? null,
    requestId: query.requestId ?? null,
    startsOnOrAfter: useDefault ? localStart(query.today).toUTC().toISO() : null,
    overlapStart: query.from ? localStart(query.from).toUTC().toISO() : null,
    overlapEnd: query.to ? localStart(query.to).plus({ days: 1 }).toUTC().toISO() : null
  };
  const after = decodeListCursor(query.cursor, filters);
  const result = await db.query<VersionedTimeOffRow & { pending_amendment_id: string | null }>(
    `SELECT ${qualifiedRequestColumns('request')}, pending.id::TEXT AS pending_amendment_id
     FROM public.time_off_requests request
     LEFT JOIN public.time_off_amendments pending
       ON pending.request_id = request.id AND pending.status = 'pending'
     WHERE request.franchiseid = $1
       AND ($2 = 'all' OR request.status::TEXT = $2)
       AND ($3::BIGINT IS NULL OR request.tutorid = $3)
       AND ($4::BIGINT IS NULL OR request.id = $4)
       AND ($5::TIMESTAMPTZ IS NULL OR request.start_at >= $5)
       AND ($6::TIMESTAMPTZ IS NULL OR request.end_at > $6)
       AND ($7::TIMESTAMPTZ IS NULL OR request.start_at < $7)
       AND ($8::TIMESTAMPTZ IS NULL OR (request.start_at, request.id) < ($8::TIMESTAMPTZ, $9::BIGINT))
     ORDER BY request.start_at DESC, request.id DESC
     LIMIT $10`,
    [
      query.franchiseId, status, filters.tutorId, filters.requestId, filters.startsOnOrAfter, filters.overlapStart,
      filters.overlapEnd, after ? after[0] : null, after ? after[1] : null, query.limit + 1
    ]
  );
  const rows = result.rows.slice(0, query.limit);
  const last = rows[rows.length - 1];
  return {
    items: rows.map((row) => ({
      request: mapTimeOffRow(row, query.timezone),
      version: String(row.version),
      pendingAmendmentId: row.pending_amendment_id
    })),
    nextCursor: result.rows.length > query.limit && last
      ? encodeListCursor(filters, [iso(last.start_at), String(last.id)])
      : null
  };
}

export interface TimeOffAmendmentQueueItem {
  amendment: TimeOffAmendment;
  request: TimeOffRecord;
  version: string;
  /** False once the proposal reached its expiry instant, before the expiry pass persists it. */
  actionable: boolean;
}

/** Scoped pending change requests, oldest first. */
export async function listPendingTimeOffAmendments(
  db: Queryable,
  query: { franchiseId: number; timezone: string; nowIso: string; cursor?: string; limit: number }
): Promise<TimeOffChangePage<TimeOffAmendmentQueueItem>> {
  const filters = { franchiseId: query.franchiseId, list: 'pending-amendments' };
  const after = decodeListCursor(query.cursor, filters);
  const result = await db.query<VersionedTimeOffRow & Record<string, unknown>>(
    `SELECT ${prefixedAmendmentColumns('amendment')}, ${qualifiedRequestColumns('request')}
     FROM public.time_off_amendments amendment
     JOIN public.time_off_requests request ON request.id = amendment.request_id
     WHERE amendment.status = 'pending' AND request.franchiseid = $1
       AND ($2::TIMESTAMPTZ IS NULL OR (amendment.created_at, amendment.id) > ($2::TIMESTAMPTZ, $3::BIGINT))
     ORDER BY amendment.created_at, amendment.id
     LIMIT $4`,
    [query.franchiseId, after ? after[0] : null, after ? after[1] : null, query.limit + 1]
  );
  const items = result.rows.slice(0, query.limit).map((row) => {
    const amendment = mapAmendmentRow(Object.fromEntries(AMENDMENT_FIELDS.map(([field]) =>
      [field, row[`${AMENDMENT_PREFIX}${field}`]])) as AmendmentRow);
    const request = mapTimeOffRow(row, query.timezone);
    const expiresAt = Math.min(Date.parse(request.startAt), Date.parse(amendment.proposed.startAt));
    return { amendment, request, version: String(row.version), actionable: expiresAt > Date.parse(query.nowIso) };
  });
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: result.rows.length > query.limit && last
      ? encodeListCursor(filters, [last.amendment.createdAt, last.amendment.id])
      : null
  };
}

/** Scoped open (pending or failed) delivery jobs, newest first. */
export async function listTimeOffChangeDeliveries(
  db: Queryable,
  query: { franchiseId: number; status?: 'pending' | 'failed'; cursor?: string; limit: number }
): Promise<TimeOffChangePage<TimeOffChangeDelivery>> {
  const filters = { franchiseId: query.franchiseId, status: query.status ?? 'open' };
  const after = decodeListCursor(query.cursor, filters);
  const result = await db.query(
    `SELECT delivery.id::TEXT AS id, delivery.operation_id::TEXT AS operation_id, delivery.request_id,
       delivery.channel, delivery.kind, delivery.status, delivery.attempts, delivery.next_attempt_at,
       delivery.last_error, delivery.target_version::TEXT AS target_version, delivery.created_at,
       delivery.completed_at
     FROM public.time_off_change_deliveries delivery
     JOIN public.time_off_requests request ON request.id = delivery.request_id
     WHERE request.franchiseid = $1
       AND delivery.status = ANY($2::TEXT[])
       AND ($3::TIMESTAMPTZ IS NULL OR (delivery.created_at, delivery.id::TEXT) < ($3::TIMESTAMPTZ, $4::TEXT))
     ORDER BY delivery.created_at DESC, delivery.id::TEXT DESC
     LIMIT $5`,
    [
      query.franchiseId, query.status ? [query.status] : ['pending', 'failed'],
      after ? after[0] : null, after ? after[1] : null, query.limit + 1
    ]
  );
  const items = result.rows.slice(0, query.limit).map(mapDeliveryRow);
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: result.rows.length > query.limit && last ? encodeListCursor(filters, [last.createdAt, last.id]) : null
  };
}
