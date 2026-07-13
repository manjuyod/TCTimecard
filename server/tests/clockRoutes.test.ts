import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { setPostgresPoolOverride } from '../db/postgres';
import clockRoutes from '../routes/clock';

afterEach(() => {
  setPostgresPoolOverride(undefined);
});

const createApp = () => {
  const now = new Date().toISOString();
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as {
      session: { auth: Record<string, unknown>; save: (callback?: (err?: Error) => void) => void };
    }).session = {
      auth: {
        accountType: 'TUTOR',
        accountId: 42,
        franchiseId: 7,
        displayName: 'Test Tutor',
        createdAt: now,
        lastSeenAt: now
      },
      save: (callback) => callback?.()
    };
    next();
  });
  app.use('/api', clockRoutes);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Internal server error' });
  });
  return app;
};

const withServer = async <T>(app: express.Express, fn: (baseUrl: string) => Promise<T>): Promise<T> => {
  const server = await new Promise<ReturnType<express.Express['listen']>>((resolve) => {
    const nextServer = app.listen(0, () => resolve(nextServer));
  });

  try {
    const address = server.address() as AddressInfo;
    return await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
};

test('clock state resolves timezone without querying pay-period overrides', async () => {
  const queries: string[] = [];
  setPostgresPoolOverride({
    async query(sqlText: string) {
      queries.push(sqlText);

      if (sqlText.includes('FROM franchise_payroll_settings')) {
        return {
          rowCount: 1,
          rows: [{
            franchiseid: 7,
            policytype: 'strict_approval',
            timezone: 'America/Los_Angeles',
            pay_period_type: 'weekly',
            auto_email_enabled: false,
            custom_period_1_start_day: null,
            custom_period_1_end_day: null,
            custom_period_2_start_day: null,
            custom_period_2_end_day: null
          }]
        };
      }

      if (sqlText.includes('FROM franchise_pay_period_overrides')) {
        return { rowCount: 0, rows: [] };
      }

      if (sqlText.includes('FROM public.weekly_attestations')) {
        return { rowCount: 1, rows: [{ exists: 1 }] };
      }

      if (sqlText.includes('FROM public.time_entry_days')) {
        return { rowCount: 0, rows: [] };
      }

      throw new Error(`Unexpected query: ${sqlText}`);
    }
  } as never);

  await withServer(createApp(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/clock/me/state`);

    assert.equal(response.status, 200);
    assert.equal(queries.filter((sqlText) => sqlText.includes('FROM franchise_payroll_settings')).length, 1);
    assert.equal(queries.filter((sqlText) => sqlText.includes('FROM franchise_pay_period_overrides')).length, 0);
  });
});
