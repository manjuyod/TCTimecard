import express, { NextFunction, Request, Response } from 'express';
import { DateTime } from 'luxon';
import { APP_ORIGIN } from '../config/appOrigin';
import { getMssqlPool, sql } from '../db/mssql';
import { getPostgresPool } from '../db/postgres';
import { requireAdmin, requireTutor } from '../middleware/auth';
import { enforceFranchiseScope } from '../middleware/franchiseScope';
import { resolvePayPeriod } from '../payroll/payPeriodResolution';
import { buildGcalClientForSubject, buildGcalEventPayload } from '../services/googleCalendar';
import { buildGmailComposeUrl, buildMailtoUrl } from '../services/emailDraft';
import { fetchFranchiseContact, FranchiseContact } from '../services/franchiseContact';
import { EmailDraft } from '../types/email';

type TimeOffStatus = 'pending' | 'approved' | 'denied' | 'cancelled';
type TimeOffType = 'pto' | 'sick' | 'unpaid' | 'other';

interface TimeOffRow {
  id: number;
  franchiseid: number;
  tutorid: number;
  start_at: string;
  end_at: string;
  type: TimeOffType;
  notes: string | null;
  status: TimeOffStatus;
  created_at: string;
  created_by: number | null;
  decided_at: string | null;
  decided_by: number | null;
  decision_reason: string | null;
  google_calendar_event_id: string | null;
}

interface TimeOffResponse {
  id: number;
  franchiseId: number;
  tutorId: number;
  startAt: string;
  endAt: string;
  type: TimeOffType;
  notes: string | null;
  status: TimeOffStatus;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: number | null;
  decisionReason: string | null;
  googleCalendarEventId: string | null;
}

interface TutorIdentity {
  tutorId: number;
  firstName: string;
  lastName: string;
  email: string;
}

const router = express.Router();

const TIME_OFF_TYPES: TimeOffType[] = ['pto', 'sick', 'unpaid', 'other'];
const ALLOWED_STATUSES: TimeOffStatus[] = ['pending', 'approved', 'denied', 'cancelled'];
const DEFAULT_MAX_DURATION_HOURS = 336;

const truthy = new Set(['1', 'true', 'yes', 'y', 'on']);
const falsy = new Set(['0', 'false', 'no', 'n', 'off']);

const parseBoolean = (value: unknown, defaultValue: boolean): boolean => {
  if (value === undefined || value === null || value === '') return defaultValue;
  const normalized = String(value).toLowerCase();
  if (truthy.has(normalized)) return true;
  if (falsy.has(normalized)) return false;
  return defaultValue;
};

const parseInteger = (value: unknown, defaultValue: number): number => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return defaultValue;
  return parsed;
};

const parseIdParam = (value: unknown): number | null => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
};

const MAX_TIME_OFF_DURATION_HOURS = (() => {
  const raw = process.env.MAX_TIME_OFF_DURATION_HOURS ?? process.env.MAX_TIME_OFF_DURATION;
  const parsed = raw !== undefined && raw !== null ? Number(raw) : Number.NaN;
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return DEFAULT_MAX_DURATION_HOURS;
})();

const ENFORCE_TIMEOFF_OVERLAP = parseBoolean(process.env.ENFORCE_TIMEOFF_OVERLAP, false);

export const parseAndNormalizeTimestamptz = (isoString: string): { value: string } | null => {
  if (typeof isoString !== 'string') return null;
  const trimmed = isoString.trim();
  if (!trimmed) return null;

  const parsed = DateTime.fromISO(trimmed, { setZone: true });
  if (!parsed.isValid) return null;

  const normalized = parsed.toUTC().toISO();
  if (!normalized) return null;

  return { value: normalized };
};

export const hoursBetween = (startIso: string, endIso: string): number => {
  const start = DateTime.fromISO(startIso, { setZone: true });
  const end = DateTime.fromISO(endIso, { setZone: true });
  if (!start.isValid || !end.isValid) return Number.NaN;

  const diff = end.diff(start, 'hours').hours;
  return diff;
};

const buildTimeOffAdminReviewUrl = (franchiseId: number, requestId: number): string =>
  `${APP_ORIGIN}/admin/time-off?franchiseId=${franchiseId}&requestId=${requestId}`;

const formatDurationLabel = (hours: number): string => `${Math.round(hours * 100) / 100} hours`;

const formatLocalWindow = (startAt: string, endAt: string, timezone: string): { start: DateTime; end: DateTime } => {
  const start = DateTime.fromISO(startAt, { zone: 'utc' }).setZone(timezone);
  const end = DateTime.fromISO(endAt, { zone: 'utc' }).setZone(timezone);
  return { start, end };
};

const composeTimeOffEmailDraft = (args: {
  tutor: TutorIdentity;
  franchise: FranchiseContact;
  request: TimeOffResponse;
  timezone: string;
}): EmailDraft => {
  const { start, end } = formatLocalWindow(args.request.startAt, args.request.endAt, args.timezone);
  const durationHours = hoursBetween(args.request.startAt, args.request.endAt);
  const tutorName = `${args.tutor.firstName} ${args.tutor.lastName}`.trim() || 'Tutor';
  const subject = `[Time Off] Approval needed - ${tutorName} - ${start.toFormat('yyyy-LL-dd')}`;
  const adminReviewUrl = buildTimeOffAdminReviewUrl(args.request.franchiseId, args.request.id);

  const bodyLines = [
    `Hello,`,
    ``,
    `${tutorName}${args.tutor.email ? ` (${args.tutor.email})` : ''} is requesting ${args.request.type.toUpperCase()} time off.`,
    `Start: ${start.toFormat('yyyy-LL-dd HH:mm ZZZZ')}`,
    `End:   ${end.toFormat('yyyy-LL-dd HH:mm ZZZZ')}`,
    `Duration: ${formatDurationLabel(durationHours)}`,
    args.request.notes ? `Notes: ${args.request.notes}` : null,
    `Request ID: ${args.request.id}`,
    `Review / approve / deny: ${adminReviewUrl}`
  ].filter(Boolean) as string[];

  const bodyText = bodyLines.join('\n');
  const to = args.franchise.email ?? '';

  return {
    to,
    subject,
    bodyText,
    mailtoUrl: buildMailtoUrl(to, subject, bodyText),
    gmailComposeUrl: buildGmailComposeUrl(to, subject, bodyText),
    adminReviewUrl
  };
};

const normalizeType = (value: unknown): TimeOffType | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase() as TimeOffType;
  return TIME_OFF_TYPES.includes(normalized) ? normalized : null;
};

const normalizeNotes = (value: unknown): { value: string | null; valid: boolean } => {
  if (value === undefined || value === null) return { value: null, valid: true };
  if (typeof value !== 'string') return { value: null, valid: false };

  const trimmed = value.trim();
  if (!trimmed) return { value: null, valid: true };
  if (trimmed.length > 2000) return { value: null, valid: false };

  return { value: trimmed, valid: true };
};

const normalizeReason = (value: unknown): { value: string | null; valid: boolean } => {
  if (value === undefined || value === null) return { value: null, valid: true };
  if (typeof value !== 'string') return { value: null, valid: false };

  const trimmed = value.trim();
  if (!trimmed) return { value: null, valid: true };
  if (trimmed.length > 2000) return { value: null, valid: false };

  return { value: trimmed, valid: true };
};

const getTutorContext = (req: Request): { tutorId: number; franchiseId: number } | null => {
  const auth = req.session.auth;
  if (!auth) return null;

  const tutorId = Number(auth.accountId);
  const franchiseId =
    auth.franchiseId !== null && auth.franchiseId !== undefined ? Number(auth.franchiseId) : Number.NaN;

  if (!Number.isFinite(tutorId) || !Number.isFinite(franchiseId)) return null;

  return { tutorId, franchiseId };
};

const mapRowToResponse = (row: TimeOffRow): TimeOffResponse => {
  const toIso = (value: string | null): string | null => {
    if (!value) return null;
    const iso = new Date(value).toISOString();
    return iso;
  };

  return {
    id: row.id,
    franchiseId: row.franchiseid,
    tutorId: row.tutorid,
    startAt: toIso(row.start_at)!,
    endAt: toIso(row.end_at)!,
    type: row.type,
    notes: row.notes,
    status: row.status,
    createdAt: toIso(row.created_at)!,
    decidedAt: toIso(row.decided_at),
    decidedBy:
      row.decided_by !== null && row.decided_by !== undefined && Number.isFinite(Number(row.decided_by))
        ? Number(row.decided_by)
        : null,
    decisionReason: row.decision_reason ?? null,
    googleCalendarEventId: row.google_calendar_event_id ?? null
  };
};

const appendAuditEntry = async (entry: {
  requestId: number;
  action: 'created' | 'cancelled' | 'approved' | 'denied';
  actorAccountType: 'TUTOR' | 'ADMIN';
  actorAccountId: number;
  previousStatus: TimeOffStatus | null;
  newStatus: TimeOffStatus;
  metadata?: Record<string, unknown>;
}): Promise<void> => {
  const pool = getPostgresPool();
  await pool.query(
    `
      INSERT INTO public.time_off_audit
        (request_id, action, actor_account_type, actor_account_id, at, previous_status, new_status, metadata)
      VALUES ($1, $2, $3, $4, NOW(), $5, $6, $7)
    `,
    [
      entry.requestId,
      entry.action,
      entry.actorAccountType,
      entry.actorAccountId,
      entry.previousStatus,
      entry.newStatus,
      entry.metadata ?? {}
    ]
  );
};

const checkOverlap = async (tutorId: number, startAt: string, endAt: string): Promise<boolean> => {
  if (!ENFORCE_TIMEOFF_OVERLAP) return false;

  const pool = getPostgresPool();
  const overlap = await pool.query(
    `
      SELECT 1
      FROM public.time_off_requests
      WHERE tutorid = $1
        AND status IN ('pending', 'approved')
        AND NOT ($3 <= start_at OR $2 >= end_at)
      LIMIT 1
    `,
    [tutorId, startAt, endAt]
  );

  return Number(overlap.rowCount ?? 0) > 0;
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

    map.set(tutorId, {
      tutorId,
      firstName: firstNameRaw !== undefined && firstNameRaw !== null ? String(firstNameRaw) : '',
      lastName: lastNameRaw !== undefined && lastNameRaw !== null ? String(lastNameRaw) : '',
      email: emailRaw !== undefined && emailRaw !== null ? String(emailRaw) : ''
    });
  }

  return map;
};

const fetchTutorById = async (tutorId: number): Promise<TutorIdentity | null> => {
  const map = await fetchTutorsByIds([tutorId]);
  return map.get(tutorId) ?? null;
};

const fetchFranchiseGmailId = async (franchiseId: number): Promise<string | null> => {
  const pool = await getMssqlPool();
  const request = pool.request();
  request.input('franchiseId', sql.Int, franchiseId);

  const result = await request.query(`
    SELECT GmailID
    FROM dbo.tblFranchies
    WHERE ID = @franchiseId
  `);

  const gmailRaw = result.recordset?.[0]?.GmailID;
  if (typeof gmailRaw === 'string' && gmailRaw.trim()) {
    return gmailRaw.trim();
  }

  return null;
};

router.post(
  '/timeoff',
  requireTutor,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const context = getTutorContext(req);
    if (!context) {
      res.status(400).json({ error: 'Tutor context missing' });
      return;
    }

    const startAt = parseAndNormalizeTimestamptz(req.body?.startAt);
    const endAt = parseAndNormalizeTimestamptz(req.body?.endAt);
    const type = normalizeType(req.body?.type);
    const notes = normalizeNotes(req.body?.notes);

    if (!startAt || !endAt) {
      res.status(400).json({ error: 'startAt and endAt must be valid ISO timestamps with timezone offset' });
      return;
    }

    if (!type) {
      res.status(400).json({ error: 'type must be one of pto, sick, unpaid, other' });
      return;
    }

    if (!notes.valid) {
      res.status(400).json({ error: 'notes must be 2000 characters or fewer' });
      return;
    }

    const durationHours = hoursBetween(startAt.value, endAt.value);
    if (!Number.isFinite(durationHours) || durationHours <= 0) {
      res.status(400).json({ error: 'Duration must be greater than 0' });
      return;
    }

    if (durationHours > MAX_TIME_OFF_DURATION_HOURS) {
      res.status(400).json({ error: `Duration cannot exceed ${MAX_TIME_OFF_DURATION_HOURS} hours` });
      return;
    }

    if (await checkOverlap(context.tutorId, startAt.value, endAt.value)) {
      res.status(409).json({ error: 'Request overlaps an existing pending or approved request' });
      return;
    }

    try {
      const payPeriod = await resolvePayPeriod(context.franchiseId, null);
      const pool = getPostgresPool();
      const insert = await pool.query<TimeOffRow>(
        `
          INSERT INTO public.time_off_requests (
            franchiseid,
            tutorid,
            start_at,
            end_at,
            type,
            notes,
            status,
            created_at,
            created_by
          )
          VALUES ($1, $2, $3, $4, $5, $6, 'pending', NOW(), $7)
          RETURNING id, franchiseid, tutorid, start_at, end_at, type, notes, status, created_at, created_by, decided_at, decided_by, decision_reason, google_calendar_event_id
        `,
        [context.franchiseId, context.tutorId, startAt.value, endAt.value, type, notes.value, context.tutorId]
      );

      const created = mapRowToResponse(insert.rows[0]);

      await appendAuditEntry({
        requestId: created.id,
        action: 'created',
        actorAccountType: 'TUTOR',
        actorAccountId: context.tutorId,
        previousStatus: null,
        newStatus: 'pending',
        metadata: {
          franchiseId: context.franchiseId,
          tutorId: context.tutorId,
          startAt: created.startAt,
          endAt: created.endAt,
          type,
          durationHours
        }
      });

      const [tutor, franchise] = await Promise.all([
        fetchTutorById(context.tutorId),
        fetchFranchiseContact(context.franchiseId)
      ]);

      const draft = composeTimeOffEmailDraft({
        tutor:
          tutor ??
          ({
            tutorId: context.tutorId,
            firstName: (req.session.auth?.displayName ?? '').split(' ')[0] ?? '',
            lastName: '',
            email: ''
          } as TutorIdentity),
        franchise:
          franchise ??
          ({
            id: context.franchiseId,
            name: `Franchise ${context.franchiseId}`,
            email: null
          } as FranchiseContact),
        request: created,
        timezone: payPeriod.timezone
      });

      if (!tutor || !franchise || !franchise.email) {
        console.log(
          JSON.stringify({
            kind: 'timeoff_email_log',
            action: 'draft_partial_context',
            requestId: created.id,
            tutorFound: Boolean(tutor),
            franchiseFound: Boolean(franchise),
            franchiseEmailPresent: Boolean(franchise?.email)
          })
        );
      }

      res.status(201).json({ request: created, emailDraft: draft });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  '/timeoff/me',
  requireTutor,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const context = getTutorContext(req);
    if (!context) {
      res.status(400).json({ error: 'Tutor context missing' });
      return;
    }

    const statusRaw = (req.query as Record<string, unknown>).status;
    const normalizedStatus =
      typeof statusRaw === 'string' && statusRaw.trim()
        ? (statusRaw.trim().toLowerCase() as TimeOffStatus)
        : null;

    if (statusRaw && (!normalizedStatus || !ALLOWED_STATUSES.includes(normalizedStatus))) {
      res.status(400).json({ error: 'Invalid status filter' });
      return;
    }

    const fromNormalized = parseAndNormalizeTimestamptz((req.query as Record<string, unknown>).from as string);
    const toNormalized = parseAndNormalizeTimestamptz((req.query as Record<string, unknown>).to as string);

    if ((req.query as Record<string, unknown>).from && !fromNormalized) {
      res.status(400).json({ error: 'from must be a valid ISO timestamp' });
      return;
    }

    if ((req.query as Record<string, unknown>).to && !toNormalized) {
      res.status(400).json({ error: 'to must be a valid ISO timestamp' });
      return;
    }

    const limitRaw = (req.query as Record<string, unknown>).limit;
    const limit =
      limitRaw === undefined || limitRaw === null || limitRaw === ''
        ? 100
        : Math.min(parseInteger(limitRaw, 100), 500);

    try {
      const pool = getPostgresPool();
      const conditions: string[] = ['tutorid = $1'];
      const params: Array<string | number> = [context.tutorId];

      if (normalizedStatus) {
        conditions.push(`status = $${conditions.length + 1}`);
        params.push(normalizedStatus);
      }

      if (fromNormalized) {
        conditions.push(`start_at >= $${conditions.length + 1}`);
        params.push(fromNormalized.value);
      }

      if (toNormalized) {
        conditions.push(`start_at <= $${conditions.length + 1}`);
        params.push(toNormalized.value);
      }

      const query = `
        SELECT id, franchiseid, tutorid, start_at, end_at, type, notes, status, created_at, created_by, decided_at, decided_by, decision_reason, google_calendar_event_id
        FROM public.time_off_requests
        WHERE ${conditions.join(' AND ')}
        ORDER BY start_at DESC
        LIMIT $${conditions.length + 1}
      `;

      params.push(limit);

      const result = await pool.query<TimeOffRow>(query, params);
      const requests = result.rows.map((row) => mapRowToResponse(row));

      res.status(200).json({ requests });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/timeoff/:id/cancel',
  requireTutor,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const context = getTutorContext(req);
    if (!context) {
      res.status(400).json({ error: 'Tutor context missing' });
      return;
    }

    const requestId = parseIdParam((req.params as Record<string, unknown>).id);
    if (requestId === null) {
      res.status(400).json({ error: 'Invalid request id' });
      return;
    }

    try {
      const pool = getPostgresPool();
      const existing = await pool.query<TimeOffRow>(
        `
          SELECT id, franchiseid, tutorid, start_at, end_at, type, notes, status, created_at, created_by, decided_at, decided_by, decision_reason, google_calendar_event_id
          FROM public.time_off_requests
          WHERE id = $1 AND tutorid = $2
          LIMIT 1
        `,
        [requestId, context.tutorId]
      );

      if (!existing.rowCount) {
        res.status(404).json({ error: 'Request not found' });
        return;
      }

      const row = existing.rows[0];
      if (row.status !== 'pending') {
        res.status(400).json({ error: 'Only pending requests can be cancelled' });
        return;
      }

      const update = await pool.query<TimeOffRow>(
        `
          UPDATE public.time_off_requests
          SET status = 'cancelled',
              decided_at = NOW(),
              decided_by = $1,
              decision_reason = $2
          WHERE id = $3 AND status = 'pending'
          RETURNING id, franchiseid, tutorid, start_at, end_at, type, notes, status, created_at, created_by, decided_at, decided_by, decision_reason, google_calendar_event_id
        `,
        [context.tutorId, 'cancelled by tutor', requestId]
      );

      if (!update.rowCount) {
        res.status(409).json({ error: 'Request could not be cancelled' });
        return;
      }

      const updated = mapRowToResponse(update.rows[0]);

      await appendAuditEntry({
        requestId: updated.id,
        action: 'cancelled',
        actorAccountType: 'TUTOR',
        actorAccountId: context.tutorId,
        previousStatus: row.status,
        newStatus: updated.status,
        metadata: {
          franchiseId: row.franchiseid,
          tutorId: row.tutorid,
          startAt: updated.startAt,
          endAt: updated.endAt,
          type: updated.type,
          reason: 'cancelled by tutor'
        }
      });

      res.status(200).json({ request: updated });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  '/timeoff/admin/pending',
  requireAdmin,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const scope = enforceFranchiseScope(req, { requireFranchiseId: true, requiredMessage: 'franchiseId is required' });
    if (scope.error || scope.franchiseId === null) {
      res.status(scope.error?.status ?? 400).json({ error: scope.error?.message ?? 'franchiseId is required' });
      return;
    }
    const franchiseId = scope.franchiseId;

    const limitRaw = (req.query as Record<string, unknown>).limit;
    const limit =
      limitRaw === undefined || limitRaw === null || limitRaw === ''
        ? 200
        : Math.min(parseInteger(limitRaw, 200), 500);

    try {
      const pool = getPostgresPool();
      const result = await pool.query<TimeOffRow>(
        `
          SELECT id, franchiseid, tutorid, start_at, end_at, type, notes, status, created_at, created_by, decided_at, decided_by, decision_reason, google_calendar_event_id
          FROM public.time_off_requests
          WHERE franchiseid = $1 AND status = 'pending'
          ORDER BY created_at ASC
          LIMIT $2
        `,
        [franchiseId, limit]
      );

      const tutorIds = result.rows.map((row) => row.tutorid);
      const tutorMap = await fetchTutorsByIds(tutorIds);

      const requests = result.rows.map((row) => {
        const tutor = tutorMap.get(row.tutorid);
        return {
          id: row.id,
          tutorId: row.tutorid,
          tutorName: tutor ? `${tutor.firstName} ${tutor.lastName}`.trim() : '',
          tutorEmail: tutor?.email ?? '',
          startAt: new Date(row.start_at).toISOString(),
          endAt: new Date(row.end_at).toISOString(),
          type: row.type,
          notes: row.notes,
          status: row.status,
          createdAt: new Date(row.created_at).toISOString()
        };
      });

      res.status(200).json({ requests });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/timeoff/:id/decide',
  requireAdmin,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const requestId = parseIdParam((req.params as Record<string, unknown>).id);
    if (requestId === null) {
      res.status(400).json({ error: 'Invalid request id' });
      return;
    }

    const decisionRaw = typeof req.body?.decision === 'string' ? req.body.decision.trim().toLowerCase() : '';
    if (decisionRaw !== 'approve' && decisionRaw !== 'deny') {
      res.status(400).json({ error: 'decision must be approve or deny' });
      return;
    }

    const reason = normalizeReason(req.body?.reason);
    if (!reason.valid) {
      res.status(400).json({ error: 'reason must be 2000 characters or fewer' });
      return;
    }

    if (decisionRaw === 'deny' && !(reason.value && reason.value.length)) {
      res.status(400).json({ error: 'reason is required when denying a request' });
      return;
    }

    const scope = enforceFranchiseScope(req, { requireFranchiseId: true, requiredMessage: 'franchiseId is required' });
    if (scope.error || scope.franchiseId === null) {
      res.status(scope.error?.status ?? 400).json({ error: scope.error?.message ?? 'franchiseId is required' });
      return;
    }
    const franchiseId = scope.franchiseId;

    const auth = req.session.auth!;

    try {
      const pool = getPostgresPool();
      const existing = await pool.query<TimeOffRow>(
        `
          SELECT id, franchiseid, tutorid, start_at, end_at, type, notes, status, created_at, created_by, decided_at, decided_by, decision_reason, google_calendar_event_id
          FROM public.time_off_requests
          WHERE id = $1
          LIMIT 1
        `,
        [requestId]
      );

      if (!existing.rowCount) {
        res.status(404).json({ error: 'Request not found' });
        return;
      }

      const row = existing.rows[0];
      if (row.franchiseid !== franchiseId) {
        res.status(403).json({ error: 'Request does not belong to this franchise' });
        return;
      }

      if (row.status !== 'pending') {
        res.status(400).json({ error: 'Only pending requests can be decided' });
        return;
      }

      if (row.tutorid === Number(auth.accountId)) {
        res.status(403).json({ error: 'Self-approval is not allowed' });
        return;
      }

      const baseResponse = mapRowToResponse(row);

      if (decisionRaw === 'deny') {
        const update = await pool.query<TimeOffRow>(
          `
            UPDATE public.time_off_requests
            SET status = 'denied',
                decided_at = NOW(),
                decided_by = $1,
                decision_reason = $2
            WHERE id = $3 AND status = 'pending'
            RETURNING id, franchiseid, tutorid, start_at, end_at, type, notes, status, created_at, created_by, decided_at, decided_by, decision_reason, google_calendar_event_id
          `,
          [auth.accountId, reason.value, requestId]
        );

        if (!update.rowCount) {
          res.status(409).json({ error: 'Request could not be updated' });
          return;
        }

        const updated = mapRowToResponse(update.rows[0]);

        await appendAuditEntry({
          requestId: updated.id,
          action: 'denied',
          actorAccountType: 'ADMIN',
          actorAccountId: Number(auth.accountId),
          previousStatus: row.status,
          newStatus: 'denied',
          metadata: {
            franchiseId: row.franchiseid,
            tutorId: row.tutorid,
            startAt: updated.startAt,
            endAt: updated.endAt,
            type: updated.type,
            reason: updated.decisionReason ?? null
          }
        });

        res.status(200).json({ request: updated });
        return;
      }

      if (row.google_calendar_event_id) {
        res.status(409).json({
          error: 'Calendar event already exists for this pending request; use the retry calendar sync endpoint.'
        });
        return;
      }

      const gmailId = await fetchFranchiseGmailId(franchiseId);
      if (!gmailId) {
        res.status(502).json({ error: 'Franchise GmailID is required to approve and sync to Google Calendar' });
        return;
      }

      const tutorMap = await fetchTutorsByIds([row.tutorid]);
      const tutor = tutorMap.get(row.tutorid) ?? {
        tutorId: row.tutorid,
        firstName: '',
        lastName: '',
        email: ''
      };

      let calendarEventId: string;
      try {
        const calendarClient = buildGcalClientForSubject(gmailId);
        const eventPayload = buildGcalEventPayload(baseResponse, tutor);
        const eventResult = await calendarClient.insertEvent(gmailId, eventPayload);
        calendarEventId = String((eventResult as { id?: string }).id ?? '').trim();
        if (!calendarEventId) {
          throw new Error('Google Calendar did not return an event id');
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to create calendar event';
        console.error('[timeoff] calendar insert failed', message);
        res.status(502).json({ error: 'Failed to create Google Calendar event; request remains pending', details: message });
        return;
      }

      const update = await pool.query<TimeOffRow>(
        `
          UPDATE public.time_off_requests
          SET status = 'approved',
              decided_at = NOW(),
              decided_by = $1,
              decision_reason = $2,
              google_calendar_event_id = $3
          WHERE id = $4 AND status = 'pending'
          RETURNING id, franchiseid, tutorid, start_at, end_at, type, notes, status, created_at, created_by, decided_at, decided_by, decision_reason, google_calendar_event_id
        `,
        [auth.accountId, reason.value, calendarEventId, requestId]
      );

      if (!update.rowCount) {
        res.status(409).json({
          error:
            'Request could not be updated after calendar insert; the request may have changed. Calendar event was created.',
          googleCalendarEventId: calendarEventId
        });
        return;
      }

      const updated = mapRowToResponse(update.rows[0]);

      await appendAuditEntry({
        requestId: updated.id,
        action: 'approved',
        actorAccountType: 'ADMIN',
        actorAccountId: Number(auth.accountId),
        previousStatus: row.status,
        newStatus: 'approved',
        metadata: {
          franchiseId: row.franchiseid,
          tutorId: row.tutorid,
          startAt: updated.startAt,
          endAt: updated.endAt,
          type: updated.type,
          reason: updated.decisionReason ?? null,
          googleCalendarEventId: updated.googleCalendarEventId
        }
      });

      res.status(200).json({ request: updated });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
