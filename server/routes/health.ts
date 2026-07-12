import express from 'express';
import { checkReadiness, ReadinessChecks } from '../services/readiness';

export const createHealthRouter = (checks?: ReadinessChecks) => {
  const router = express.Router();

  router.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  router.get('/ready', async (_req, res, next) => {
    try {
      const result = await checkReadiness(checks);
      res.status(result.ready ? 200 : 503).json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
};

export default createHealthRouter();
