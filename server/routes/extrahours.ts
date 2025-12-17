import express, { NextFunction, Request, Response } from 'express';
import { DateTime } from 'luxon';
import { APP_ORIGIN } from '../config/appOrigin';
import { getMssqlPool, sql } from '../db/mssql';
import { getPostgresPool } from '../db/postgres';
import { requireAdmin, requireTutor } from '../middleware/auth';
import { enforceFranchiseScope } from '../middleware/franchiseScope';
import { resolvePayPeriod } from '../payroll/payPeriodResolution';
import { sendEmail } from '../services/email';
import { buildGmailComposeUrl, buildMailtoUrl } from '../services/emailDraft';
import { fetchFranchiseContact, FranchiseContact } from '../services/franchiseContact';
import { EmailDraft } from '../types/email';

const parseBoolean = (value: unknown, defaultValue: boolean): boolean => {
  if (value === undefined || value === null || value === '') return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return defaultValue;
};

type ExtraHoursStatus = 'pending' | 'approved' | 'denied' | 'cancelled';

interface ExtraHoursRow {
  id: number;
  franchiseid: number;
  tutorid: number;
  start_at: string;
  end_at: string;
  description: string;
  status: ExtraHoursStatus;
  approvedby: number | null;
  approvedat: string | null;
  createdat: string;
  updatedat: string;
  decision_reason?: string | null;
}

interface ExtraHoursResponse {
  id: number;
  franchiseId: number;
  tutorId: number;
  startAt: string;
  endAt: string;
  description: string;
  status: ExtraHoursStatus;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: number | null;
  decisionReason: string | null;
}

interface TutorInfo {
  tutorId: number;
  firstName: string;
  lastName: string;
  email: string;
}

const router = express.Router();

const ALLOWED_STATUSES: ExtraHoursStatus[] = ['pending', 'approved', 'denied', 'cancelled'];
const CANCELLED_DECISION_REASON = 'cancelled by tutor';
const CANCELLED_STORAGE_STATUS: ExtraHoursStatus = 'denied';

const parseNullableNumber = (value: number | null | undefined): number | null => {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const normalizeDecisionReason = (value: string | null | undefined): string => {
  if (!value) return '';
  return value.trim().toLowerCase();
};

const isTutorCancelledRow = (row: ExtraHoursRow): boolean => {
  if (row.status === 'cancelled') return true;
  if (row.status !== CANCELLED_STORAGE_STATUS) return false;

  const reasonMatches = normalizeDecisionReason(row.decision_reason) === CANCELLED_DECISION_REASON;

  return reasonMatches;
};

const deriveResponseStatus = (row: ExtraHoursRow): ExtraHoursStatus => (isTutorCancelledRow(row) ? 'cancelled' : row.status);
const DEFAULT_MAX_HOURS = 12;
const MAX_HOURS_PER_REQUEST = (() => {
  const raw = process.env.MAX_EXTRA_HOURS_PER_REQUEST_HOURS ?? process.env.MAX_EXTRA_HOURS_PER_REQUEST;
  const parsed = raw !== undefined && raw !== null ? Number(raw) : Number.NaN;
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return DEFAULT_MAX_HOURS;
})();
const EMAIL_SEND_ENABLED = parseBoolean(process.env.EMAIL_SEND_ENABLED, false);
const DECISION_EMAIL_ENABLED = parseBoolean(process.env.DECISION_EMAIL_ENABLED, false);

const parseIdParam = (value: unknown): number | null => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
};

const normalizeStatus = (value: unknown): ExtraHoursStatus | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase() as ExtraHoursStatus;
  return ALLOWED_STATUSES.includes(normalized) ? normalized : null;
};

const parseIsoDateTime = (value: unknown, timezone: string): DateTime | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const hasZoneInfo = /([zZ]|[+-]\d{2}:\d{2})$/.test(trimmed);
  const parsed = DateTime.fromISO(trimmed, { setZone: true });
  if (!parsed.isValid) return null;

  const zoned = hasZoneInfo ? parsed : parsed.setZone(timezone, { keepLocalTime: true });
  return zoned.isValid ? zoned.toUTC() : null;
};

const sanitizeDescription = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length < 5) return null;
  const normalized = trimmed.replace(/\s+/g, ' ');
  if (!normalized) return null;
  return normalized.slice(0, 1000);
};

const computeDurationHours = (start: DateTime, end: DateTime): number => {
  const diff = end.diff(start, 'minutes').minutes;
  return diff / 60;
};

const mapRowToResponse = (row: ExtraHoursRow): ExtraHoursResponse => {
  const toIso = (value: string | Date | null | undefined): string | null => {
    if (value === null || value === undefined) return null;
    const source = value instanceof Date ? value.toISOString() : String(value);
    const iso = new Date(source).toISOString();
    return iso;
  };

  const decidedByNumber = parseNullableNumber(row.approvedby);
  const status = deriveResponseStatus(row);
  const decidedAtIso =
    row.approvedat !== null && row.approvedat !== undefined
      ? toIso(row.approvedat)
      : status !== 'pending'
        ? toIso(row.updatedat)
        : null;

  return {
    id: row.id,
    franchiseId: row.franchiseid,
    tutorId: row.tutorid,
    startAt: toIso(row.start_at)!,
    endAt: toIso(row.end_at)!,
    description: row.description,
    status,
    createdAt: toIso(row.createdat)!,
    decidedAt: decidedAtIso,
    decidedBy: decidedByNumber,
    decisionReason: row.decision_reason ?? null
  };
};

const getTutorContext = (req: Request): { tutorId: number; franchiseId: number } | null => {
  const auth = req.session.auth;
  if (!auth) return null;

  const tutorId = Number(auth.accountId);
  const franchiseId = Number(auth.franchiseId);
  if (!Number.isFinite(tutorId) || !Number.isFinite(franchiseId)) return null;

  return { tutorId, franchiseId };
};

const appendAuditLog = (entry: {
  requestId: number;
  action: 'created' | 'cancelled' | 'approved' | 'denied';
  actorAccountType: 'TUTOR' | 'ADMIN';
  actorAccountId: number;
  previousStatus: ExtraHoursStatus | null;
  newStatus: ExtraHoursStatus;
  metadata: Record<string, unknown>;
}) => {
  const payload = {
    kind: 'extrahours_audit',
    at: new Date().toISOString(),
    ...entry
  };
  console.log(JSON.stringify(payload));
};

const buildAdminReviewUrl = (franchiseId: number, requestId: number): string =>
  `${APP_ORIGIN}/admin/extra-hours?franchiseId=${franchiseId}&requestId=${requestId}`;

const formatLocalWindow = (startAt: string, endAt: string, timezone: string): { start: DateTime; end: DateTime } => {
  const start = DateTime.fromISO(startAt, { zone: 'utc' }).setZone(timezone);
  const end = DateTime.fromISO(endAt, { zone: 'utc' }).setZone(timezone);
  return { start, end };
};

const formatDurationLabel = (hours: number): string => `${Math.round(hours * 100) / 100} hours`;

const composeEmailDraft = (args: {
  tutor: TutorInfo;
  franchise: FranchiseContact;
  request: ExtraHoursResponse;
  timezone: string;
}): EmailDraft => {
  const { start, end } = formatLocalWindow(args.request.startAt, args.request.endAt, args.timezone);
  const durationHours = computeDurationHours(start, end);
  const tutorName = `${args.tutor.firstName} ${args.tutor.lastName}`.trim() || 'Tutor';
  const subject = `[Extra Hours] Approval needed - ${tutorName} - ${start.toFormat('yyyy-LL-dd')}`;
  const adminReviewUrl = buildAdminReviewUrl(args.request.franchiseId, args.request.id);

  const bodyLines = [
    `Hello,`,
    ``,
    `${tutorName}${args.tutor.email ? ` (${args.tutor.email})` : ''} is requesting extra hours.`,
    `Start: ${start.toFormat('yyyy-LL-dd HH:mm ZZZZ')}`,
    `End:   ${end.toFormat('yyyy-LL-dd HH:mm ZZZZ')}`,
    `Duration: ${formatDurationLabel(durationHours)}`,
    `Description: ${args.request.description}`,
    `Request ID: ${args.request.id}`,
    `Review / approve / deny: ${adminReviewUrl}`
  ];

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

const composeDecisionEmail = (args: {
  tutor: TutorInfo;
  request: ExtraHoursResponse;
  decision: 'approved' | 'denied';
  reason: string | null;
  timezone: string;
}): { subject: string; text: string; to: string[] } => {
  const { start, end } = formatLocalWindow(args.request.startAt, args.request.endAt, args.timezone);
  const durationHours = computeDurationHours(start, end);
  const decisionLabel = args.decision === 'approved' ? 'Approved' : 'Denied';

  const lines = [
    `Your extra hours request has been ${decisionLabel.toLowerCase()}.`,
    ``,
    `Decision: ${decisionLabel}`,
    args.reason ? `Reason: ${args.reason}` : null,
    `Start: ${start.toFormat('yyyy-LL-dd HH:mm ZZZZ')}`,
    `End:   ${end.toFormat('yyyy-LL-dd HH:mm ZZZZ')}`,
    `Duration: ${formatDurationLabel(durationHours)}`,
    `Request ID: ${args.request.id}`
  ].filter(Boolean) as string[];

  const subject = `[Extra Hours] ${decisionLabel} - ${start.toFormat('yyyy-LL-dd')}`;

  return {
    subject,
    text: lines.join('\n'),
    to: args.tutor.email ? [args.tutor.email] : []
  };
};

const fetchTutorById = async (tutorId: number): Promise<TutorInfo | null> => {
  const pool = await getMssqlPool();
  const request = pool.request();
  request.input('tutorId', sql.Int, tutorId);

  const result = await request.query(`
    SELECT ID, FirstName, LastName, Email
    FROM dbo.tblTutors
    WHERE ID = @tutorId AND IsDeleted = 0
  `);

  if (!result.recordset?.length) return null;

  const row = result.recordset[0] as Record<string, unknown>;
  const firstNameRaw = row.FirstName;
  const lastNameRaw = row.LastName;
  const emailRaw = row.Email;

  return {
    tutorId,
    firstName: firstNameRaw !== undefined && firstNameRaw !== null ? String(firstNameRaw) : '',
    lastName: lastNameRaw !== undefined && lastNameRaw !== null ? String(lastNameRaw) : '',
    email: emailRaw !== undefined && emailRaw !== null ? String(emailRaw) : ''
  };
};

const fetchTutorsByIds = async (tutorIds: number[]): Promise<Map<number, TutorInfo>> => {
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
  const map = new Map<number, TutorInfo>();

  for (const row of result.recordset ?? []) {
    const tutorId = Number((row as Record<string, unknown>).ID);
    if (!Number.isFinite(tutorId)) continue;

    map.set(tutorId, {
      tutorId,
      firstName: (row as Record<string, unknown>).FirstName
        ? String((row as Record<string, unknown>).FirstName)
        : '',
      lastName: (row as Record<string, unknown>).LastName ? String((row as Record<string, unknown>).LastName) : '',
      email: (row as Record<string, unknown>).Email ? String((row as Record<string, unknown>).Email) : ''
    });
  }

  return map;
};

router.post(
  '/extrahours',
  requireTutor,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const context = getTutorContext(req);
    if (!context) {
      res.status(400).json({ error: 'Tutor context missing' });
      return;
    }

    const description = sanitizeDescription(req.body?.description);
    if (!description) {
      res.status(400).json({ error: 'description is required (min 5 characters)' });
      return;
    }

    try {
      const payPeriod = await resolvePayPeriod(context.franchiseId, null);
      const startAt = parseIsoDateTime(req.body?.startAt, payPeriod.timezone);
      const endAt = parseIsoDateTime(req.body?.endAt, payPeriod.timezone);

      if (!startAt || !endAt) {
        res.status(400).json({ error: 'startAt and endAt must be valid ISO timestamps' });
        return;
      }

      if (startAt >= endAt) {
        res.status(400).json({ error: 'startAt must be before endAt' });
        return;
      }

      const durationHours = computeDurationHours(startAt, endAt);
      if (durationHours <= 0) {
        res.status(400).json({ error: 'Duration must be greater than 0' });
        return;
      }

      if (durationHours > MAX_HOURS_PER_REQUEST) {
        res.status(400).json({ error: `Duration cannot exceed ${MAX_HOURS_PER_REQUEST} hours` });
        return;
      }

      const pool = getPostgresPool();
      const insertResult = await pool.query<ExtraHoursRow>(
        `
          INSERT INTO public.extrahours (franchiseid, tutorid, start_at, end_at, description, status, createdat, updatedat)
          VALUES ($1, $2, $3, $4, $5, 'pending', NOW(), NOW())
          RETURNING id, franchiseid, tutorid, start_at, end_at, description, status, approvedby, approvedat, createdat, updatedat, decision_reason
        `,
        [context.franchiseId, context.tutorId, startAt.toISO(), endAt.toISO(), description]
      );

      const created = mapRowToResponse(insertResult.rows[0]);

      appendAuditLog({
        requestId: created.id,
        action: 'created',
        actorAccountType: 'TUTOR',
        actorAccountId: context.tutorId,
        previousStatus: null,
        newStatus: 'pending',
        metadata: {
          franchiseId: context.franchiseId,
          tutorId: context.tutorId,
          durationHours,
          startAt: created.startAt,
          endAt: created.endAt
        }
      });

      const [tutor, franchise] = await Promise.all([
        fetchTutorById(context.tutorId),
        fetchFranchiseContact(context.franchiseId)
      ]);

      const draft = composeEmailDraft({
        tutor:
          tutor ??
          ({
            tutorId: context.tutorId,
            firstName: (req.session.auth?.displayName ?? '').split(' ')[0] ?? '',
            lastName: '',
            email: ''
          } as TutorInfo),
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
            kind: 'extrahours_email_log',
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
  '/extrahours/me',
  requireTutor,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const context = getTutorContext(req);
    if (!context) {
      res.status(400).json({ error: 'Tutor context missing' });
      return;
    }

    const statusFilter = normalizeStatus((req.query as Record<string, unknown>).status);
    const fromRaw = (req.query as Record<string, unknown>).from;
    const toRaw = (req.query as Record<string, unknown>).to;

    const from =
      typeof fromRaw === 'string' && fromRaw.trim()
        ? DateTime.fromISO(fromRaw, { setZone: true }).toUTC()
        : null;
    const to =
      typeof toRaw === 'string' && toRaw.trim()
        ? DateTime.fromISO(toRaw, { setZone: true }).toUTC()
        : null;

    if ((fromRaw && (!from || !from.isValid)) || (toRaw && (!to || !to.isValid))) {
      res.status(400).json({ error: 'from/to must be valid ISO timestamps' });
      return;
    }

    try {
      const pool = getPostgresPool();
      const conditions: string[] = ['tutorid = $1'];
      const params: Array<string | number> = [context.tutorId];

      if (statusFilter) {
        if (statusFilter === 'cancelled') {
          conditions.push(`status = $${conditions.length + 1}`);
          params.push(CANCELLED_STORAGE_STATUS);
          conditions.push(`decision_reason = $${conditions.length + 1}`);
          params.push(CANCELLED_DECISION_REASON);
        } else {
          conditions.push(`status = $${conditions.length + 1}`);
          params.push(statusFilter);
        }
      }

      if (from) {
        conditions.push(`start_at >= $${conditions.length + 1}`);
        params.push(from.toISO()!);
      }

      if (to) {
        conditions.push(`start_at <= $${conditions.length + 1}`);
        params.push(to.toISO()!);
      }

      const query = `
        SELECT id, franchiseid, tutorid, start_at, end_at, description, status, approvedby, approvedat, createdat, updatedat, decision_reason
        FROM public.extrahours
        WHERE ${conditions.join(' AND ')}
        ORDER BY start_at DESC
      `;

      const result = await pool.query<ExtraHoursRow>(query, params);
      const requests = result.rows.map((row) => {
        const mapped = mapRowToResponse(row);
        return {
          id: mapped.id,
          startAt: mapped.startAt,
          endAt: mapped.endAt,
          description: mapped.description,
          status: mapped.status,
          createdAt: mapped.createdAt,
          decidedAt: mapped.decidedAt,
          decidedBy: mapped.decidedBy,
          decisionReason: mapped.decisionReason
        };
      });

      res.status(200).json({ requests });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/extrahours/:id/cancel',
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
      const existing = await pool.query<ExtraHoursRow>(
        `
          SELECT id, franchiseid, tutorid, start_at, end_at, description, status, approvedby, approvedat, createdat, updatedat, decision_reason
          FROM public.extrahours
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

      const update = await pool.query<ExtraHoursRow>(
        `
          UPDATE public.extrahours
          SET status = $1,
              approvedby = NULL,
              approvedat = NULL,
              decision_reason = $2,
              updatedat = NOW()
          WHERE id = $3 AND status = 'pending'
          RETURNING id, franchiseid, tutorid, start_at, end_at, description, status, approvedby, approvedat, createdat, updatedat, decision_reason
        `,
        [CANCELLED_STORAGE_STATUS, CANCELLED_DECISION_REASON, requestId]
      );

      if (!update.rowCount) {
        res.status(409).json({ error: 'Request could not be cancelled' });
        return;
      }

      const updated = mapRowToResponse(update.rows[0]);
      const startDt = DateTime.fromISO(updated.startAt, { setZone: true });
      const endDt = DateTime.fromISO(updated.endAt, { setZone: true });
      const durationHours = computeDurationHours(startDt, endDt);

      appendAuditLog({
        requestId: updated.id,
        action: 'cancelled',
        actorAccountType: 'TUTOR',
        actorAccountId: context.tutorId,
        previousStatus: row.status,
        newStatus: updated.status,
        metadata: {
          franchiseId: row.franchiseid,
          tutorId: row.tutorid,
          durationHours,
          startAt: updated.startAt,
          endAt: updated.endAt
        }
      });

      res.status(200).json({ request: updated });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  '/extrahours/admin/pending',
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
        ? 100
        : Math.min(Number(limitRaw) || 100, 500);

    try {
      const pool = getPostgresPool();
      const result = await pool.query<ExtraHoursRow>(
        `
          SELECT id, franchiseid, tutorid, start_at, end_at, description, status, approvedby, approvedat, createdat, updatedat, decision_reason
          FROM public.extrahours
          WHERE franchiseid = $1 AND status = 'pending'
          ORDER BY createdat ASC
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
          description: row.description,
          status: row.status,
          createdAt: new Date(row.createdat).toISOString()
        };
      });

      res.status(200).json({ requests });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/extrahours/:id/decide',
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

    const reason =
      typeof req.body?.reason === 'string' && req.body.reason.trim() ? req.body.reason.trim().slice(0, 1000) : null;
    if (decisionRaw === 'deny' && !reason) {
      res.status(400).json({ error: 'reason is required when denying a request' });
      return;
    }

    const scope = enforceFranchiseScope(req, { requireFranchiseId: true, requiredMessage: 'franchiseId is required' });
    if (scope.error || scope.franchiseId === null) {
      res.status(scope.error?.status ?? 400).json({ error: scope.error?.message ?? 'franchiseId is required' });
      return;
    }
    const scopedFranchiseId = scope.franchiseId;
    const auth = req.session.auth!;

    try {
      const pool = getPostgresPool();
      const existing = await pool.query<ExtraHoursRow>(
        `
          SELECT id, franchiseid, tutorid, start_at, end_at, description, status, approvedby, approvedat, createdat, updatedat, decision_reason
          FROM public.extrahours
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
      if (row.franchiseid !== scopedFranchiseId) {
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

      const newStatus: ExtraHoursStatus = decisionRaw === 'approve' ? 'approved' : 'denied';
      const update = await pool.query<ExtraHoursRow>(
        `
          UPDATE public.extrahours
          SET status = $1,
              approvedby = CASE WHEN $1 = 'approved' THEN $2 ELSE NULL END,
              approvedat = CASE WHEN $1 = 'approved' THEN NOW() ELSE NULL END,
              decision_reason = $3,
              updatedat = NOW()
          WHERE id = $4 AND status = 'pending'
          RETURNING id, franchiseid, tutorid, start_at, end_at, description, status, approvedby, approvedat, createdat, updatedat, decision_reason
        `,
        [newStatus, auth.accountId, reason, requestId]
      );

      if (!update.rowCount) {
        res.status(409).json({ error: 'Request could not be updated' });
        return;
      }

      const updated = mapRowToResponse(update.rows[0]);

      const startDt = DateTime.fromISO(updated.startAt, { setZone: true });
      const endDt = DateTime.fromISO(updated.endAt, { setZone: true });
      const durationHours = computeDurationHours(startDt, endDt);

      appendAuditLog({
        requestId: updated.id,
        action: newStatus === 'approved' ? 'approved' : 'denied',
        actorAccountType: 'ADMIN',
        actorAccountId: Number(auth.accountId),
        previousStatus: row.status,
        newStatus,
        metadata: {
          franchiseId: row.franchiseid,
          tutorId: row.tutorid,
          durationHours,
          startAt: updated.startAt,
          endAt: updated.endAt,
          reason: updated.decisionReason ?? null
        }
      });

      const shouldSendDecisionEmail = EMAIL_SEND_ENABLED && DECISION_EMAIL_ENABLED;
      if (shouldSendDecisionEmail) {
        const tutor = await fetchTutorById(updated.tutorId);
        if (tutor) {
          const payPeriod = await resolvePayPeriod(scopedFranchiseId, null);
          const email = composeDecisionEmail({
            tutor,
            request: updated,
            decision: newStatus === 'approved' ? 'approved' : 'denied',
            reason: updated.decisionReason,
            timezone: payPeriod.timezone
          });
          await sendEmail(email, { feature: 'extra_hours_decision', requestId: updated.id });
        } else {
          console.log(
            JSON.stringify({
              kind: 'extrahours_email_log',
              action: 'decision_email_skipped_missing_tutor',
              requestId: updated.id,
              tutorId: updated.tutorId
            })
          );
        }
      } else {
        console.log(
          JSON.stringify({
            kind: 'extrahours_email_log',
            action: 'decision_email_disabled',
            requestId: updated.id,
            tutorId: updated.tutorId,
            emailSendEnabled: EMAIL_SEND_ENABLED,
            decisionEmailEnabled: DECISION_EMAIL_ENABLED
          })
        );
      }

      res.status(200).json({ request: updated });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
