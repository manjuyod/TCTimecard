import express, { NextFunction, Request, Response } from 'express';
import { DateTime } from 'luxon';
import { getPostgresPool } from '../db/postgres';
import { requireTutor } from '../middleware/auth';
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

const router = express.Router();

const missingFranchise = (res: Response) => res.status(400).json({ error: 'franchiseId is required for tutor requests' });

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

