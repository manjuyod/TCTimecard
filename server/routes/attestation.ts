import express, { NextFunction, Request, Response } from 'express';
import ExcelJS from 'exceljs';
import { DateTime } from 'luxon';
import { getMssqlPool, sql } from '../db/mssql';
import { getPostgresPool } from '../db/postgres';
import { requireAdmin, requireTutor } from '../middleware/auth';
import { enforceFranchiseScope } from '../middleware/franchiseScope';
import { resolvePayPeriod } from '../payroll/payPeriodResolution';
import {
  ATTESTATION_QUOTE,
  TIMEKEEPING_QUOTES,
  WEEKLY_ATTESTATION_STATEMENT,
  WEEKLY_ATTESTATION_TEXT_VERSION,
  WORKWEEK_DEFINITION
} from '../services/attestationCopy';
import { computeLastClosedWorkweek } from '../services/workweek';

type WeeklyAttestationRow = {
  id: number;
  franchiseid: number;
  tutorid: number;
  week_start: string;
  week_end: string;
  timezone: string;
  typed_name: string;
  signed_at: string;
  attestation_text: string;
  attestation_text_version: string;
  metadata: unknown;
};

type AdminTutorIdentity = {
  tutorId: number;
  firstName: string;
  lastName: string;
  displayName: string;
};

const router = express.Router();

const missingFranchise = (res: Response) => res.status(400).json({ error: 'franchiseId is required for tutor requests' });
const invalidTutorId = (res: Response) => res.status(400).json({ error: 'tutorId must be a positive integer' });

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

const parseRequiredWeekEndRange = (
  query: Record<string, unknown>
): { ok: true; weekEndStart: string; weekEndEnd: string } | { ok: false; message: string } => {
  const weekEndStart = typeof query.weekEndStart === 'string' ? query.weekEndStart.trim() : '';
  const weekEndEnd = typeof query.weekEndEnd === 'string' ? query.weekEndEnd.trim() : '';

  if (!weekEndStart) return { ok: false, message: 'weekEndStart is required' };
  if (!weekEndEnd) return { ok: false, message: 'weekEndEnd is required' };

  const start = DateTime.fromISO(weekEndStart, { zone: 'utc' });
  const end = DateTime.fromISO(weekEndEnd, { zone: 'utc' });
  if (!DATE_ONLY_RE.test(weekEndStart) || !start.isValid || start.toISODate() !== weekEndStart) {
    return { ok: false, message: 'weekEndStart must be YYYY-MM-DD' };
  }
  if (!DATE_ONLY_RE.test(weekEndEnd) || !end.isValid || end.toISODate() !== weekEndEnd) {
    return { ok: false, message: 'weekEndEnd must be YYYY-MM-DD' };
  }
  if (weekEndStart > weekEndEnd) {
    return { ok: false, message: 'weekEndStart must be on or before weekEndEnd' };
  }

  return { ok: true, weekEndStart, weekEndEnd };
};

const parseOptionalTutorId = (value: unknown): number | null | undefined => {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined;
  return parsed;
};

const formatTutorDisplayName = (tutorId: number, firstName: string, lastName: string): string => {
  const first = firstName.trim();
  const last = lastName.trim();
  if (first && last) return `${last}, ${first}`;
  if (last) return last;
  if (first) return first;
  return `Tutor ${tutorId}`;
};

const sanitizeSpreadsheetText = (value: string): string =>
  /^[=+\-@]/.test(value.trimStart()) ? `'${value}` : value;

const formatDateOnly = (value: unknown): string => {
  if (value instanceof Date) {
    return DateTime.fromJSDate(value, { zone: 'utc' }).toISODate() ?? '';
  }
  if (typeof value === 'string') {
    const parsed = DateTime.fromISO(value, { zone: 'utc', setZone: true });
    return parsed.isValid ? parsed.toISODate() ?? value : value;
  }
  return '';
};

const formatSignedAt = (value: unknown): string => {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
  }
  return '';
};

const fetchAdminTutorIdentities = async (tutorIds: number[]): Promise<Map<number, AdminTutorIdentity>> => {
  const uniqueIds = Array.from(new Set(tutorIds.filter((id) => Number.isInteger(id) && id > 0)));
  const identities = new Map<number, AdminTutorIdentity>();
  if (!uniqueIds.length) return identities;

  const paramNames = uniqueIds.map((_, idx) => `tutor_${idx}`);
  const placeholders = paramNames.map((name) => `@${name}`).join(', ');
  const query = `
    SELECT ID, FirstName, LastName
    FROM dbo.tblTutors
    WHERE ID IN (${placeholders}) AND IsDeleted = 0
  `;

  const pool = await getMssqlPool();
  const request = pool.request();
  uniqueIds.forEach((id, idx) => request.input(paramNames[idx], sql.Int, id));
  const result = await request.query(query);

  for (const row of result.recordset ?? []) {
    const record = row as Record<string, unknown>;
    const tutorId = Number(record.ID);
    if (!Number.isInteger(tutorId)) continue;

    const firstName = record.FirstName !== undefined && record.FirstName !== null ? String(record.FirstName) : '';
    const lastName = record.LastName !== undefined && record.LastName !== null ? String(record.LastName) : '';
    identities.set(tutorId, {
      tutorId,
      firstName,
      lastName,
      displayName: formatTutorDisplayName(tutorId, firstName, lastName)
    });
  }

  return identities;
};

const getTutorDisplayName = (tutorId: number, identities: Map<number, AdminTutorIdentity>): string =>
  identities.get(tutorId)?.displayName ?? `Tutor ${tutorId}`;

const fetchAttestationRowsForAdmin = async (args: {
  franchiseId: number;
  weekEndStart: string;
  weekEndEnd: string;
  tutorId?: number | null;
}): Promise<WeeklyAttestationRow[]> => {
  const pool = getPostgresPool();
  const params: unknown[] = [args.franchiseId, args.weekEndStart, args.weekEndEnd];
  const tutorFilter = args.tutorId ? 'AND tutorid = $4' : '';
  if (args.tutorId) params.push(args.tutorId);

  const result = await pool.query<WeeklyAttestationRow>(
    `
      SELECT
        id,
        franchiseid,
        tutorid,
        week_start,
        week_end,
        timezone,
        typed_name,
        signed_at,
        attestation_text,
        attestation_text_version,
        metadata
      FROM public.weekly_attestations
      WHERE franchiseid = $1
        AND week_end >= $2
        AND week_end <= $3
        ${tutorFilter}
      ORDER BY week_end DESC, tutorid ASC, signed_at DESC
    `,
    params
  );

  return result.rows ?? [];
};

const buildAttestationExportWorkbook = async (
  rows: WeeklyAttestationRow[],
  identities: Map<number, AdminTutorIdentity>
): Promise<Buffer> => {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Attestation Log');

  worksheet.addRow([
    'Tutor',
    'Tutor ID',
    'Week Start',
    'Week End',
    'Signed At',
    'Typed Name',
    'Attestation Text Version'
  ]);
  worksheet.getRow(1).font = { bold: true };

  for (const row of rows) {
    worksheet.addRow([
      sanitizeSpreadsheetText(getTutorDisplayName(row.tutorid, identities)),
      row.tutorid,
      formatDateOnly(row.week_start),
      formatDateOnly(row.week_end),
      formatSignedAt(row.signed_at),
      sanitizeSpreadsheetText(row.typed_name),
      row.attestation_text_version
    ]);
  }

  worksheet.columns = [
    { width: 28 },
    { width: 12 },
    { width: 14 },
    { width: 14 },
    { width: 26 },
    { width: 26 },
    { width: 24 }
  ];

  return Buffer.from(await workbook.xlsx.writeBuffer());
};

const getTutorContext = (req: Request): { tutorId: number; franchiseId: number; displayName: string } | null => {
  const auth = req.session.auth;
  if (!auth) return null;

  const tutorId = Number(auth.accountId);
  const franchiseId = Number(auth.franchiseId);
  if (!Number.isFinite(tutorId) || !Number.isFinite(franchiseId)) return null;

  return { tutorId, franchiseId, displayName: auth.displayName ?? '' };
};

const normalizeTypedName = (value: unknown, fallback: string): { value: string; valid: boolean } => {
  if (value === undefined || value === null) {
    const trimmed = fallback.trim();
    return { value: trimmed, valid: Boolean(trimmed) };
  }

  if (typeof value !== 'string') return { value: '', valid: false };
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (!trimmed) return { value: '', valid: false };
  if (trimmed.length > 200) return { value: '', valid: false };
  return { value: trimmed, valid: true };
};

const mapAttestationResponse = (
  row: WeeklyAttestationRow | null,
  args: { weekStart: string; weekEnd: string; timezone: string }
) => ({
  timezone: args.timezone,
  weekStart: args.weekStart,
  weekEnd: args.weekEnd,
  signed: Boolean(row),
  signedAt: row ? new Date(row.signed_at).toISOString() : null,
  typedName: row ? row.typed_name : null,
  attestationText: row?.attestation_text ?? WEEKLY_ATTESTATION_STATEMENT,
  attestationTextVersion: row?.attestation_text_version ?? WEEKLY_ATTESTATION_TEXT_VERSION,
  copy: {
    workweekDefinition: WORKWEEK_DEFINITION,
    timekeepingQuotes: TIMEKEEPING_QUOTES,
    attestationQuote: ATTESTATION_QUOTE,
    weeklyAttestationStatement: WEEKLY_ATTESTATION_STATEMENT
  }
});

router.get(
  '/attestation/admin/tutors',
  requireAdmin,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const scope = enforceFranchiseScope(req, { requireFranchiseId: true, requiredMessage: 'franchiseId is required' });
    if (scope.error || scope.franchiseId === null) {
      res.status(scope.error?.status ?? 400).json({ error: scope.error?.message ?? 'franchiseId is required' });
      return;
    }

    const range = parseRequiredWeekEndRange(req.query as Record<string, unknown>);
    if (!range.ok) {
      res.status(400).json({ error: range.message });
      return;
    }

    try {
      const pool = getPostgresPool();
      const result = await pool.query<{ tutorid: number }>(
        `
          SELECT DISTINCT tutorid
          FROM public.weekly_attestations
          WHERE franchiseid = $1
            AND week_end >= $2
            AND week_end <= $3
          ORDER BY tutorid ASC
        `,
        [scope.franchiseId, range.weekEndStart, range.weekEndEnd]
      );

      const tutorIds = (result.rows ?? [])
        .map((row) => Number(row.tutorid))
        .filter((tutorId) => Number.isInteger(tutorId) && tutorId > 0);
      const identities = await fetchAdminTutorIdentities(tutorIds);
      const tutors = tutorIds
        .map((tutorId) => {
          const identity = identities.get(tutorId);
          return identity ?? {
            tutorId,
            firstName: '',
            lastName: '',
            displayName: `Tutor ${tutorId}`
          };
        })
        .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.tutorId - b.tutorId);

      res.status(200).json({ tutors });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  '/attestation/admin/export',
  requireAdmin,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const scope = enforceFranchiseScope(req, { requireFranchiseId: true, requiredMessage: 'franchiseId is required' });
    if (scope.error || scope.franchiseId === null) {
      res.status(scope.error?.status ?? 400).json({ error: scope.error?.message ?? 'franchiseId is required' });
      return;
    }

    const range = parseRequiredWeekEndRange(req.query as Record<string, unknown>);
    if (!range.ok) {
      res.status(400).json({ error: range.message });
      return;
    }

    const tutorId = parseOptionalTutorId((req.query as Record<string, unknown>).tutorId);
    if (tutorId === undefined) {
      invalidTutorId(res);
      return;
    }

    try {
      const rows = await fetchAttestationRowsForAdmin({
        franchiseId: scope.franchiseId,
        weekEndStart: range.weekEndStart,
        weekEndEnd: range.weekEndEnd,
        tutorId
      });

      if (!rows.length) {
        res.status(404).json({ error: 'No attestation records found for the selected filters' });
        return;
      }

      const identities = await fetchAdminTutorIdentities(rows.map((row) => row.tutorid));
      const workbookBuffer = await buildAttestationExportWorkbook(rows, identities);
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      res.setHeader('Content-Disposition', 'attachment; filename="attestation-log.xlsx"');
      res.status(200).send(workbookBuffer);
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  '/attestation/me/status',
  requireTutor,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const context = getTutorContext(req);
    if (!context) {
      missingFranchise(res);
      return;
    }

    try {
      const payPeriod = await resolvePayPeriod(context.franchiseId, null);
      const timezone = payPeriod.timezone;
      const lastClosed = computeLastClosedWorkweek(timezone);

      const weekStart = lastClosed.weekStart.toISODate();
      const weekEnd = lastClosed.weekEnd.toISODate();
      if (!weekStart || !weekEnd) {
        res.status(500).json({ error: 'Unable to compute workweek boundaries' });
        return;
      }

      const pool = getPostgresPool();
      const result = await pool.query<WeeklyAttestationRow>(
        `
          SELECT
            id,
            franchiseid,
            tutorid,
            week_start,
            week_end,
            timezone,
            typed_name,
            signed_at,
            attestation_text,
            attestation_text_version,
            metadata
          FROM public.weekly_attestations
          WHERE franchiseid = $1
            AND tutorid = $2
            AND week_end = $3
          LIMIT 1
        `,
        [context.franchiseId, context.tutorId, weekEnd]
      );

      const row = result.rowCount ? result.rows[0] : null;
      res.status(200).json(mapAttestationResponse(row, { weekStart, weekEnd, timezone }));
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  '/attestation/me/reminder',
  requireTutor,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const context = getTutorContext(req);
    if (!context) {
      missingFranchise(res);
      return;
    }

    try {
      const payPeriod = await resolvePayPeriod(context.franchiseId, null);
      const timezone = payPeriod.timezone;
      const lastClosed = computeLastClosedWorkweek(timezone);

      const weekStart = lastClosed.weekStart.toISODate();
      const weekEnd = lastClosed.weekEnd.toISODate();
      if (!weekStart || !weekEnd) {
        res.status(500).json({ error: 'Unable to compute workweek boundaries' });
        return;
      }

      const pool = getPostgresPool();
      const result = await pool.query<{ ok: number }>(
        `
          SELECT 1 as ok
          FROM public.weekly_attestations
          WHERE franchiseid = $1
            AND tutorid = $2
            AND week_end = $3
          LIMIT 1
        `,
        [context.franchiseId, context.tutorId, weekEnd]
      );

      const signed = Boolean(result.rowCount);

      res.status(200).json({
        timezone,
        missingWeekEnd: signed ? null : weekEnd,
        weekStart,
        weekEnd,
        blocking: !signed
      });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/attestation/me/sign',
  requireTutor,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const context = getTutorContext(req);
    if (!context) {
      missingFranchise(res);
      return;
    }

    const typedName = normalizeTypedName((req.body as Record<string, unknown>)?.typedName, context.displayName);
    if (!typedName.valid) {
      res.status(400).json({ error: 'typedName is required (max 200 characters)' });
      return;
    }

    try {
      const payPeriod = await resolvePayPeriod(context.franchiseId, null);
      const timezone = payPeriod.timezone;
      const lastClosed = computeLastClosedWorkweek(timezone);

      const weekStart = lastClosed.weekStart.toISODate();
      const weekEnd = lastClosed.weekEnd.toISODate();
      if (!weekStart || !weekEnd) {
        res.status(500).json({ error: 'Unable to compute workweek boundaries' });
        return;
      }

      const ip = req.ip || null;
      const userAgent = req.get('user-agent') || null;
      const metadata = {
        ip,
        userAgent,
        signedAtLocal: DateTime.now().setZone(timezone).toISO()
      };

      const pool = getPostgresPool();

      const insert = await pool.query<WeeklyAttestationRow>(
        `
          INSERT INTO public.weekly_attestations
            (franchiseid, tutorid, week_start, week_end, timezone, typed_name, signed_at, attestation_text, attestation_text_version, metadata)
          VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7, $8, $9)
          ON CONFLICT (franchiseid, tutorid, week_end) DO NOTHING
          RETURNING
            id,
            franchiseid,
            tutorid,
            week_start,
            week_end,
            timezone,
            typed_name,
            signed_at,
            attestation_text,
            attestation_text_version,
            metadata
        `,
        [
          context.franchiseId,
          context.tutorId,
          weekStart,
          weekEnd,
          timezone,
          typedName.value,
          WEEKLY_ATTESTATION_STATEMENT,
          WEEKLY_ATTESTATION_TEXT_VERSION,
          metadata
        ]
      );

      if (insert.rowCount) {
        res.status(201).json(mapAttestationResponse(insert.rows[0], { weekStart, weekEnd, timezone }));
        return;
      }

      const existing = await pool.query<WeeklyAttestationRow>(
        `
          SELECT
            id,
            franchiseid,
            tutorid,
            week_start,
            week_end,
            timezone,
            typed_name,
            signed_at,
            attestation_text,
            attestation_text_version,
            metadata
          FROM public.weekly_attestations
          WHERE franchiseid = $1
            AND tutorid = $2
            AND week_end = $3
          LIMIT 1
        `,
        [context.franchiseId, context.tutorId, weekEnd]
      );

      res.status(200).json(mapAttestationResponse(existing.rowCount ? existing.rows[0] : null, { weekStart, weekEnd, timezone }));
    } catch (err) {
      next(err);
    }
  }
);

export default router;

