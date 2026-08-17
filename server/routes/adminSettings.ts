import express, { NextFunction, Request, Response } from 'express';
import { requireAdmin } from '../middleware/auth';
import { enforceFranchiseScope } from '../middleware/franchiseScope';
import {
  getFranchiseSettings,
  updateFranchiseSettings
} from '../services/franchiseSettings';
import { getPtoCenterStatus } from '../services/pto';

const router = express.Router();

const withPtoStatus = async <T extends object>(franchiseId: number, settings: T) => {
  const pto = await getPtoCenterStatus(franchiseId);
  return {
    ...settings,
    ptoEnabled: pto.enabled,
    ptoFirstActivatedAt: pto.firstActivatedAt,
    ptoLastSuccessfulSyncAt: pto.lastSuccessfulSyncAt
  };
};

const resolveScope = (req: Request, res: Response): number | null => {
  const scope = enforceFranchiseScope(req, {
    requireFranchiseId: true,
    requiredMessage: 'franchiseId is required for admin requests'
  });
  if (scope.error || scope.franchiseId === null) {
    res.status(scope.error?.status ?? 400).json({
      error: scope.error?.message ?? 'franchiseId is required for admin requests'
    });
    return null;
  }
  return scope.franchiseId;
};

router.get('/settings', requireAdmin, async (req, res, next): Promise<void> => {
  const franchiseId = resolveScope(req, res);
  if (franchiseId === null) return;
  try {
    res.status(200).json({ settings: await withPtoStatus(franchiseId, await getFranchiseSettings(franchiseId)) });
  } catch (error) {
    next(error);
  }
});

router.patch('/settings', requireAdmin, async (req, res, next): Promise<void> => {
  const franchiseId = resolveScope(req, res);
  if (franchiseId === null) return;
  const body = req.body && typeof req.body === 'object'
    ? req.body as Record<string, unknown>
    : {};
  const hasAutoClockOut = Object.prototype.hasOwnProperty.call(body, 'autoClockOutEnabled');
  const hasClockInTimeSnap = Object.prototype.hasOwnProperty.call(body, 'clockInTimeSnapEnabled');
  const hasTimeOffNotice = Object.prototype.hasOwnProperty.call(body, 'timeOffNoticeRequired');
  if (!hasAutoClockOut && !hasClockInTimeSnap && !hasTimeOffNotice) {
    res.status(400).json({ error: 'At least one franchise setting is required' });
    return;
  }
  if (hasAutoClockOut && typeof body.autoClockOutEnabled !== 'boolean') {
    res.status(400).json({ error: 'autoClockOutEnabled must be a boolean' });
    return;
  }
  if (hasClockInTimeSnap && typeof body.clockInTimeSnapEnabled !== 'boolean') {
    res.status(400).json({ error: 'clockInTimeSnapEnabled must be a boolean' });
    return;
  }
  if (hasTimeOffNotice && typeof body.timeOffNoticeRequired !== 'boolean') {
    res.status(400).json({ error: 'timeOffNoticeRequired must be a boolean' });
    return;
  }
  try {
    const settings = await updateFranchiseSettings({
      franchiseId,
      ...(hasAutoClockOut ? { autoClockOutEnabled: body.autoClockOutEnabled as boolean } : {}),
      ...(hasClockInTimeSnap ? { clockInTimeSnapEnabled: body.clockInTimeSnapEnabled as boolean } : {}),
      ...(hasTimeOffNotice ? { timeOffNoticeRequired: body.timeOffNoticeRequired as boolean } : {})
    });
    res.status(200).json({ settings: await withPtoStatus(franchiseId, settings) });
  } catch (error) {
    next(error);
  }
});

export default router;
