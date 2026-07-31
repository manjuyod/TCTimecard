import express, { NextFunction, Request, Response } from 'express';
import { requireAdmin } from '../middleware/auth';
import { enforceFranchiseScope } from '../middleware/franchiseScope';
import {
  getFranchiseSettings,
  updateFranchiseSettings
} from '../services/franchiseSettings';

const router = express.Router();

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
    res.status(200).json({ settings: await getFranchiseSettings(franchiseId) });
  } catch (error) {
    next(error);
  }
});

router.patch('/settings', requireAdmin, async (req, res, next): Promise<void> => {
  const franchiseId = resolveScope(req, res);
  if (franchiseId === null) return;
  if (typeof req.body?.autoClockOutEnabled !== 'boolean') {
    res.status(400).json({ error: 'autoClockOutEnabled must be a boolean' });
    return;
  }
  try {
    const settings = await updateFranchiseSettings({
      franchiseId,
      autoClockOutEnabled: req.body.autoClockOutEnabled
    });
    res.status(200).json({ settings });
  } catch (error) {
    next(error);
  }
});

export default router;
