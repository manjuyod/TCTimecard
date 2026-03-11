import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { setPostgresPoolOverride } from '../db/postgres';
import payPeriodRoutes from '../routes/payPeriod';

type SessionAuth = {
  accountType: 'ADMIN' | 'TUTOR';
  accountId: number;
  franchiseId: number | null;
  displayName?: string;
};

type SettingsRow = {
  franchiseid: number;
  policytype: string;
  timezone: string;
  pay_period_type: string;
  auto_email_enabled: boolean;
  custom_period_1_start_day: number | null;
  custom_period_1_end_day: number | null;
  custom_period_2_start_day: number | null;
  custom_period_2_end_day: number | null;
};

type QueryResult = { rowCount: number; rows: Array<Record<string, unknown>> };
type FakePool = {
  query: (sql: string, params?: unknown[]) => Promise<QueryResult>;
};

afterEach(() => {
  setPostgresPoolOverride(undefined);
});

const createPool = (rows: SettingsRow[]): { pool: FakePool; rowsByFranchise: Map<number, SettingsRow> } => {
  const rowsByFranchise = new Map(rows.map((row) => [row.franchiseid, { ...row }]));

  const pool: FakePool = {
    async query(sql: string, params: unknown[] = []): Promise<QueryResult> {
      if (sql.includes('FROM franchise_payroll_settings')) {
        const franchiseId = Number(params[0]);
        const row = rowsByFranchise.get(franchiseId);
        return row ? { rowCount: 1, rows: [{ ...row }] } : { rowCount: 0, rows: [] };
      }

      if (sql.includes('INSERT INTO franchise_payroll_settings')) {
        const franchiseId = Number(params[0]);
        rowsByFranchise.set(franchiseId, {
          franchiseid: franchiseId,
          policytype: String(params[1]),
          timezone: String(params[2]),
          pay_period_type: String(params[3]),
          auto_email_enabled: Boolean(params[4]),
          custom_period_1_start_day: params[5] === null ? null : Number(params[5]),
          custom_period_1_end_day: params[6] === null ? null : Number(params[6]),
          custom_period_2_start_day: params[7] === null ? null : Number(params[7]),
          custom_period_2_end_day: params[8] === null ? null : Number(params[8])
        });
        return { rowCount: 1, rows: [] };
      }

      throw new Error(`Unexpected query: ${sql}`);
    }
  };

  return { pool, rowsByFranchise };
};

const createApp = (auth: SessionAuth) => {
  const now = new Date().toISOString();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: { auth: Record<string, unknown>; save: (callback?: (err?: Error) => void) => void } }).session = {
      auth: {
        ...auth,
        createdAt: now,
        lastSeenAt: now
      },
      save: (callback) => {
        if (callback) callback();
      }
    };
    next();
  });
  app.use('/api/pay-period', payPeriodRoutes);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = typeof (err as { status?: number } | null | undefined)?.status === 'number'
      ? (err as { status: number }).status
      : 500;
    const message = err instanceof Error ? err.message : 'Internal server error';
    res.status(status).json({ error: message });
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

test('admin can read and update payroll settings for an allowed franchise scope', async () => {
  const { pool } = createPool([
    {
      franchiseid: 77,
      policytype: 'strict_approval',
      timezone: 'America/Los_Angeles',
      pay_period_type: 'biweekly',
      auto_email_enabled: false,
      custom_period_1_start_day: null,
      custom_period_1_end_day: null,
      custom_period_2_start_day: null,
      custom_period_2_end_day: null
    }
  ]);
  setPostgresPoolOverride(pool as never);

  const app = createApp({ accountType: 'ADMIN', accountId: 100, franchiseId: 1, displayName: 'Admin User' });

  await withServer(app, async (baseUrl) => {
    const getResponse = await fetch(`${baseUrl}/api/pay-period/settings?franchiseId=77`);
    assert.equal(getResponse.status, 200);
    const getBody = (await getResponse.json()) as {
      settings: {
        franchiseId: number;
        payPeriodType: string;
      };
    };
    assert.equal(getBody.settings.franchiseId, 77);
    assert.equal(getBody.settings.payPeriodType, 'biweekly');

    const putResponse = await fetch(`${baseUrl}/api/pay-period/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        franchiseId: 77,
        payPeriodType: 'custom_semimonthly',
        customPeriod1StartDay: 11,
        customPeriod1EndDay: 25,
        customPeriod2StartDay: 26,
        customPeriod2EndDay: 10
      })
    });

    assert.equal(putResponse.status, 200);
    const putBody = (await putResponse.json()) as {
      settings: {
        franchiseId: number;
        payPeriodType: string;
        customPeriod1StartDay: number;
        customPeriod1EndDay: number;
        customPeriod2StartDay: number;
        customPeriod2EndDay: number;
      };
    };
    assert.equal(putBody.settings.franchiseId, 77);
    assert.equal(putBody.settings.payPeriodType, 'custom_semimonthly');
    assert.equal(putBody.settings.customPeriod1StartDay, 11);
    assert.equal(putBody.settings.customPeriod1EndDay, 25);
    assert.equal(putBody.settings.customPeriod2StartDay, 26);
    assert.equal(putBody.settings.customPeriod2EndDay, 10);
  });
});

test('non-admin users cannot access payroll settings endpoints', async () => {
  const { pool } = createPool([]);
  setPostgresPoolOverride(pool as never);

  const app = createApp({ accountType: 'TUTOR', accountId: 200, franchiseId: 55, displayName: 'Tutor User' });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/pay-period/settings`);
    assert.equal(response.status, 403);
    const body = (await response.json()) as { error: string };
    assert.match(body.error, /forbidden/i);
  });
});

test('selector-disabled admins are locked to their session franchise when updating settings', async () => {
  const { pool, rowsByFranchise } = createPool([
    {
      franchiseid: 9,
      policytype: 'strict_approval',
      timezone: 'America/Los_Angeles',
      pay_period_type: 'monthly',
      auto_email_enabled: false,
      custom_period_1_start_day: null,
      custom_period_1_end_day: null,
      custom_period_2_start_day: null,
      custom_period_2_end_day: null
    }
  ]);
  setPostgresPoolOverride(pool as never);

  const app = createApp({ accountType: 'ADMIN', accountId: 300, franchiseId: 9, displayName: 'Scoped Admin' });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/pay-period/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        franchiseId: 123,
        payPeriodType: 'weekly'
      })
    });

    assert.equal(response.status, 200);
    const body = (await response.json()) as { settings: { franchiseId: number; payPeriodType: string } };
    assert.equal(body.settings.franchiseId, 9);
    assert.equal(body.settings.payPeriodType, 'weekly');
    assert.equal(rowsByFranchise.get(123), undefined);
    assert.equal(rowsByFranchise.get(9)?.pay_period_type, 'weekly');
  });
});

test('invalid custom semimonthly payloads are rejected with 400', async () => {
  const { pool } = createPool([
    {
      franchiseid: 12,
      policytype: 'strict_approval',
      timezone: 'America/Los_Angeles',
      pay_period_type: 'biweekly',
      auto_email_enabled: false,
      custom_period_1_start_day: null,
      custom_period_1_end_day: null,
      custom_period_2_start_day: null,
      custom_period_2_end_day: null
    }
  ]);
  setPostgresPoolOverride(pool as never);

  const app = createApp({ accountType: 'ADMIN', accountId: 400, franchiseId: 12, displayName: 'Admin User' });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/pay-period/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        franchiseId: 12,
        payPeriodType: 'custom_semimonthly',
        customPeriod1StartDay: 11,
        customPeriod1EndDay: 25
      })
    });

    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: string };
    assert.match(body.error, /all four custom/i);
  });
});
