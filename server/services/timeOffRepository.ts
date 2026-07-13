import { DateTime } from 'luxon';
import { Pool, PoolClient, QueryResultRow } from 'pg';
import { getPostgresPool } from '../db/postgres';
import {
  NormalizedTimeOffSubmission,
  StoredTimeOffType,
  TimeOffRecord,
  TimeOffStatus,
  TimeOffType
} from '../types/timeoff';

export interface TimeOffRow extends QueryResultRow {
  id: string | number;
  franchiseid: number;
  tutorid: number | null;
  bridge_flag: boolean | null;
  bridge_profile_id: string | number | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  start_at: string;
  end_at: string;
  type: StoredTimeOffType;
  absence_label: string | null;
  notes: string | null;
  status: TimeOffStatus;
  created_at: string;
  created_by: number | null;
  decided_at: string | null;
  decided_by: number | null;
  decision_reason: string | null;
  google_calendar_event_id: string | null;
  duration_hours: string | number | null;
  partial_day: boolean | null;
  leave_time: string | null;
  return_time: string | null;
  public_metadata: Record<string, unknown> | null;
}

export interface NotificationFailureRow extends QueryResultRow {
  audit_id: string | number;
  request_id: string | number;
  at: string;
  action: string;
  metadata: Record<string, unknown>;
}

type Queryable = Pool | PoolClient;

const COLUMNS = `
  id, franchiseid, tutorid, bridge_flag, bridge_profile_id, first_name, last_name, email,
  start_at, end_at, type, absence_label, notes, status, created_at, created_by, decided_at,
  decided_by, decision_reason, google_calendar_event_id, duration_hours, partial_day,
  leave_time, return_time, public_metadata
`;

export function mapTimeOffRow(row: TimeOffRow, timezone: string): TimeOffRecord {
  const start = DateTime.fromISO(new Date(row.start_at).toISOString(), { zone: 'utc' }).setZone(timezone);
  const end = DateTime.fromISO(new Date(row.end_at).toISOString(), { zone: 'utc' }).setZone(timezone);
  const storedPartial = row.partial_day === true;
  const timedLegacy = !storedPartial && (!isMidnight(start) || !isMidnight(end));
  const partialDay = storedPartial || timedLegacy;
  const type: TimeOffType = row.type === 'other' && row.absence_label?.trim().toLowerCase() === 'emergency'
    ? 'emergency'
    : row.type;
  const firstName = row.first_name ?? '';
  const lastName = row.last_name ?? '';
  const email = row.email ?? '';
  const source = row.public_metadata?.source === 'public_timeoff_form' ? 'public' : 'authenticated';
  const endDate = partialDay ? end.toISODate() : end.minus({ days: 1 }).toISODate();

  return {
    id: Number(row.id),
    franchiseId: Number(row.franchiseid),
    tutorId: row.tutorid === null ? null : Number(row.tutorid),
    bridgeFlag: row.bridge_flag === true,
    bridgeProfileId: row.bridge_profile_id === null ? null : Number(row.bridge_profile_id),
    firstName,
    lastName,
    tutorName: `${firstName} ${lastName}`.trim(),
    tutorEmail: email,
    startAt: start.toUTC().toISO({ suppressMilliseconds: false }) as string,
    endAt: end.toUTC().toISO({ suppressMilliseconds: false }) as string,
    startDate: start.toISODate() as string,
    endDate: endDate as string,
    type,
    absenceLabel: row.absence_label?.trim() || defaultAbsenceLabel(type),
    reason: row.notes,
    notes: row.notes,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    createdBy: row.created_by === null ? null : Number(row.created_by),
    decidedAt: row.decided_at ? new Date(row.decided_at).toISOString() : null,
    decidedBy: row.decided_by === null ? null : Number(row.decided_by),
    decisionReason: row.decision_reason,
    googleCalendarEventId: row.google_calendar_event_id,
    durationHours: row.duration_hours === null ? end.diff(start, 'hours').hours : Number(row.duration_hours),
    partialDay,
    leaveTime: normalizeTime(row.leave_time),
    returnTime: normalizeTime(row.return_time),
    source
  };
}

export async function createAuthenticatedTimeOff(args: {
  franchiseId: number;
  tutorId: number;
  firstName: string;
  lastName: string;
  email: string;
  submission: NormalizedTimeOffSubmission;
  timezone: string;
}): Promise<TimeOffRecord> {
  const pool = getPostgresPool();
  const result = await pool.query<TimeOffRow>(
    `
      INSERT INTO public.time_off_requests (
        franchiseid, tutorid, bridge_flag, bridge_profile_id, first_name, last_name, email,
        start_at, end_at, type, absence_label, notes, status, created_at, created_by,
        duration_hours, partial_day, leave_time, return_time, public_metadata
      )
      VALUES ($1, $2, FALSE, NULL, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', NOW(), $2,
        $11, $12, $13, $14, $15)
      RETURNING ${COLUMNS}
    `,
    [
      args.franchiseId,
      args.tutorId,
      args.firstName,
      args.lastName,
      args.email,
      args.submission.startAt,
      args.submission.endAt,
      args.submission.storageType,
      args.submission.absenceLabel,
      args.submission.reason,
      args.submission.durationHours,
      args.submission.partialDay,
      args.submission.leaveTime,
      args.submission.returnTime,
      { source: 'authenticated_timecard_app', startDate: args.submission.startDate, endDate: args.submission.endDate }
    ]
  );
  return mapTimeOffRow(result.rows[0], args.timezone);
}

export async function checkTimeOffOverlap(tutorId: number, startAt: string, endAt: string): Promise<boolean> {
  const result = await getPostgresPool().query(
    `SELECT 1 FROM public.time_off_requests
     WHERE tutorid = $1 AND status IN ('pending', 'approved')
       AND NOT ($3::timestamptz <= start_at OR $2::timestamptz >= end_at)
     LIMIT 1`,
    [tutorId, startAt, endAt]
  );
  return Number(result.rowCount ?? 0) > 0;
}

export async function listTutorTimeOff(tutorId: number, limit: number, timezone: string): Promise<TimeOffRecord[]> {
  const result = await getPostgresPool().query<TimeOffRow>(
    `SELECT ${COLUMNS} FROM public.time_off_requests WHERE tutorid = $1 ORDER BY created_at DESC LIMIT $2`,
    [tutorId, limit]
  );
  return result.rows.map((row) => mapTimeOffRow(row, timezone));
}

export async function listAdminPendingTimeOff(
  franchiseId: number,
  limit: number,
  timezone: string
): Promise<TimeOffRecord[]> {
  const result = await getPostgresPool().query<TimeOffRow>(
    `SELECT ${COLUMNS} FROM public.time_off_requests
     WHERE franchiseid = $1 AND status = 'pending' ORDER BY created_at ASC LIMIT $2`,
    [franchiseId, limit]
  );
  return result.rows.map((row) => mapTimeOffRow(row, timezone));
}

export async function fetchTimeOffById(
  requestId: number,
  timezone: string,
  db: Queryable = getPostgresPool(),
  forUpdate = false
): Promise<TimeOffRecord | null> {
  const result = await db.query<TimeOffRow>(
    `SELECT ${COLUMNS} FROM public.time_off_requests WHERE id = $1 LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [requestId]
  );
  return result.rows[0] ? mapTimeOffRow(result.rows[0], timezone) : null;
}

export async function cancelPendingTimeOff(requestId: number, tutorId: number, timezone: string): Promise<TimeOffRecord | null> {
  const result = await getPostgresPool().query<TimeOffRow>(
    `UPDATE public.time_off_requests SET status='cancelled', decided_at=NOW(), decided_by=$1,
       decision_reason='cancelled by tutor'
     WHERE id=$2 AND tutorid=$1 AND status='pending' RETURNING ${COLUMNS}`,
    [tutorId, requestId]
  );
  return result.rows[0] ? mapTimeOffRow(result.rows[0], timezone) : null;
}

export async function updateTimeOffDecision(args: {
  client: PoolClient;
  requestId: number;
  status: 'approved' | 'denied';
  actorId: number;
  reason: string;
  calendarEventId: string | null;
  timezone: string;
}): Promise<TimeOffRecord | null> {
  const result = await args.client.query<TimeOffRow>(
    `UPDATE public.time_off_requests SET status=$1, decided_at=NOW(), decided_by=$2,
       decision_reason=$3, google_calendar_event_id=COALESCE($4, google_calendar_event_id)
     WHERE id=$5 AND status='pending' RETURNING ${COLUMNS}`,
    [args.status, args.actorId, args.reason, args.calendarEventId, args.requestId]
  );
  return result.rows[0] ? mapTimeOffRow(result.rows[0], args.timezone) : null;
}

export async function appendTimeOffAudit(
  entry: {
    requestId: number;
    action: string;
    actorAccountType: string;
    actorAccountId: number | null;
    previousStatus: string | null;
    newStatus: string;
    metadata: Record<string, unknown>;
  },
  db: Queryable = getPostgresPool()
): Promise<void> {
  await db.query(
    `INSERT INTO public.time_off_audit
      (request_id, action, actor_account_type, actor_account_id, at, previous_status, new_status, metadata)
     VALUES ($1,$2,$3,$4,NOW(),$5,$6,$7)`,
    [
      entry.requestId,
      entry.action,
      entry.actorAccountType,
      entry.actorAccountId,
      entry.previousStatus,
      entry.newStatus,
      entry.metadata
    ]
  );
}

export async function listLatestNotificationFailures(franchiseId: number): Promise<NotificationFailureRow[]> {
  const result = await getPostgresPool().query<NotificationFailureRow>(
    `
      WITH latest AS (
        SELECT DISTINCT ON (a.request_id, a.metadata->>'notificationKind')
          a.id AS audit_id, a.request_id, a.at, a.action, a.metadata
        FROM public.time_off_audit a
        JOIN public.time_off_requests r ON r.id = a.request_id
        WHERE r.franchiseid = $1
          AND a.metadata ? 'notificationKind'
          AND a.action IN ('admin_email_sent','admin_email_failed','requester_email_sent','requester_email_failed',
                           'notification_retry_sent','notification_retry_failed')
        ORDER BY a.request_id, a.metadata->>'notificationKind', a.at DESC, a.id DESC
      )
      SELECT * FROM latest WHERE action IN ('admin_email_failed','requester_email_failed','notification_retry_failed')
      ORDER BY at DESC
    `,
    [franchiseId]
  );
  return result.rows;
}

function defaultAbsenceLabel(type: TimeOffType): string {
  switch (type) {
    case 'pto': return 'Paid Time Off';
    case 'sick': return 'Sick Leave';
    case 'emergency': return 'Emergency';
    case 'unpaid': return 'Unpaid Time Off';
    default: return 'Other';
  }
}

function isMidnight(value: DateTime): boolean {
  return value.hour === 0 && value.minute === 0 && value.second === 0 && value.millisecond === 0;
}

function normalizeTime(value: string | null): string | null {
  return value ? value.slice(0, 5) : null;
}
