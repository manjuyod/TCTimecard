import express, { NextFunction, Request, Response } from 'express';
import { DateTime } from 'luxon';
import { requireAuth } from '../middleware/auth';
import { enforceFranchiseScope } from '../middleware/franchiseScope';
import { resolvePayPeriod } from '../payroll/payPeriodResolution';

const router = express.Router();

const invalidForDate = (res: Response) => res.status(400).json({ error: 'forDate must be YYYY-MM-DD' });

const extractForDate = (value: unknown): { dateISO: string | null; isValid: boolean } => {
  if (value === undefined || value === null || value === '') return { dateISO: null, isValid: true };
  if (typeof value !== 'string') return { dateISO: null, isValid: false };

  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return { dateISO: null, isValid: false };
  }

  const dt = DateTime.fromISO(trimmed, { zone: 'UTC' });
  if (!dt.isValid || dt.toISODate() !== trimmed) {
    return { dateISO: null, isValid: false };
  }

  return { dateISO: trimmed, isValid: true };
};

router.get(
  '/current',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const scope = enforceFranchiseScope(req, {
      requireFranchiseId: true,
      requiredMessage: 'franchiseId is required for admin requests'
    });
    if (scope.error || scope.franchiseId === null) {
      res
        .status(scope.error?.status ?? 400)
        .json({ error: scope.error?.message ?? 'franchiseId is required for admin requests' });
      return;
    }
    const franchiseId = scope.franchiseId;

    try {
      const payPeriod = await resolvePayPeriod(franchiseId, null);
      res.status(200).json({ payPeriod });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  '/',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const scope = enforceFranchiseScope(req, {
      requireFranchiseId: true,
      requiredMessage: 'franchiseId is required for admin requests'
    });
    if (scope.error || scope.franchiseId === null) {
      res
        .status(scope.error?.status ?? 400)
        .json({ error: scope.error?.message ?? 'franchiseId is required for admin requests' });
      return;
    }
    const franchiseId = scope.franchiseId;

    const { dateISO: forDate, isValid } = extractForDate((req.query as Record<string, unknown>).forDate);
    if (!isValid) {
      invalidForDate(res);
      return;
    }

    try {
      const payPeriod = await resolvePayPeriod(franchiseId, forDate);
      res.status(200).json({ payPeriod });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
