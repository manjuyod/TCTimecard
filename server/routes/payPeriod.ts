import express, { NextFunction, Request, Response } from 'express';
import { DateTime } from 'luxon';
import { requireAdmin, requireAuth } from '../middleware/auth';
import { enforceFranchiseScope } from '../middleware/franchiseScope';
import {
  getFranchisePayrollSettings,
  isPayPeriodType,
  resolvePayPeriod,
  updateFranchisePayrollSettings
} from '../payroll/payPeriodResolution';

const router = express.Router();

const invalidForDate = (res: Response) => res.status(400).json({ error: 'forDate must be YYYY-MM-DD' });
const invalidPayload = (res: Response, message: string) => res.status(400).json({ error: message });

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

const parseOptionalDay = (value: unknown): { value?: number; isValid: boolean } => {
  if (value === undefined || value === null || value === '') return { isValid: true };
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return { isValid: false };
  return { value: parsed, isValid: true };
};

router.get(
  '/settings',
  requireAdmin,
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

    try {
      const settings = await getFranchisePayrollSettings(scope.franchiseId);
      res.status(200).json({ settings });
    } catch (err) {
      next(err);
    }
  }
);

router.put(
  '/settings',
  requireAdmin,
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

    const payPeriodTypeRaw = typeof req.body?.payPeriodType === 'string' ? req.body.payPeriodType.trim().toLowerCase() : '';
    if (!isPayPeriodType(payPeriodTypeRaw)) {
      invalidPayload(res, 'payPeriodType must be one of weekly, biweekly, semimonthly, monthly, or custom_semimonthly');
      return;
    }

    const customPeriod1StartDay = parseOptionalDay(req.body?.customPeriod1StartDay);
    const customPeriod1EndDay = parseOptionalDay(req.body?.customPeriod1EndDay);
    const customPeriod2StartDay = parseOptionalDay(req.body?.customPeriod2StartDay);
    const customPeriod2EndDay = parseOptionalDay(req.body?.customPeriod2EndDay);

    const customValues = [
      customPeriod1StartDay,
      customPeriod1EndDay,
      customPeriod2StartDay,
      customPeriod2EndDay
    ];

    if (customValues.some((entry) => !entry.isValid)) {
      invalidPayload(res, 'Custom recurring payroll day values must be integers.');
      return;
    }

    const providedCustomCount = customValues.filter((entry) => entry.value !== undefined).length;
    if (providedCustomCount > 0 && providedCustomCount < 4) {
      invalidPayload(res, 'Provide all four custom recurring payroll day values together.');
      return;
    }

    if (payPeriodTypeRaw === 'custom_semimonthly' && providedCustomCount !== 4) {
      invalidPayload(res, 'Custom semimonthly pay periods require all four custom day values.');
      return;
    }

    try {
      const settings = await updateFranchisePayrollSettings({
        franchiseId: scope.franchiseId,
        payPeriodType: payPeriodTypeRaw,
        customPeriod1StartDay: customPeriod1StartDay.value,
        customPeriod1EndDay: customPeriod1EndDay.value,
        customPeriod2StartDay: customPeriod2StartDay.value,
        customPeriod2EndDay: customPeriod2EndDay.value
      });
      res.status(200).json({ settings });
    } catch (err) {
      next(err);
    }
  }
);

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
