import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { setPostgresPoolOverride } from '../db/postgres';
import adminSettingsRoutes from '../routes/adminSettings';

type SessionAuth = {
  accountType: 'ADMIN' | 'TUTOR';
  accountId: number;
  franchiseId: number | null;
};

type SettingRow = {
  franchiseid: number;
  auto_clock_out_enabled: boolean;
  clock_in_time_snap_enabled: boolean;
};

afterEach(() => setPostgresPoolOverride(undefined));

const createPool = (initial: SettingRow[]) => {
  const rows = new Map(initial.map((row) => [row.franchiseid, { ...row }]));
  let lastUpdatedFranchiseId: number | null = null;
  const pool = {
    async query(sql: string, params: unknown[] = []) {
      const franchiseId = Number(params[0]);
      if (/SELECT franchiseid, auto_clock_out_enabled/i.test(sql)) {
        const row = rows.get(franchiseId);
        return row ? { rowCount: 1, rows: [{ ...row }] } : { rowCount: 0, rows: [] };
      }
      if (/INSERT INTO public\.franchise_payroll_settings/i.test(sql)) {
        lastUpdatedFranchiseId = franchiseId;
        const current = rows.get(franchiseId);
        const row = {
          franchiseid: franchiseId,
          auto_clock_out_enabled: typeof params[1] === 'boolean'
            ? params[1] : current?.auto_clock_out_enabled ?? false,
          clock_in_time_snap_enabled: typeof params[2] === 'boolean'
            ? params[2] : current?.clock_in_time_snap_enabled ?? false
        };
        rows.set(franchiseId, row);
        return { rowCount: 1, rows: [row] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
  return { pool, rows, lastUpdatedFranchiseId: () => lastUpdatedFranchiseId };
};

const createApp = (auth: SessionAuth) => {
  const now = new Date().toISOString();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as never as { session: { auth: object; save(callback?: (error?: Error) => void): void } }).session = {
      auth: { ...auth, createdAt: now, lastSeenAt: now },
      save: (callback) => callback?.()
    };
    next();
  });
  app.use('/api/admin', adminSettingsRoutes);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = typeof (error as { status?: unknown })?.status === 'number'
      ? Number((error as { status: number }).status) : 500;
    res.status(status).json({ error: error instanceof Error ? error.message : 'Internal server error' });
  });
  return app;
};

const withServer = async <T>(app: express.Express, run: (baseUrl: string) => Promise<T>): Promise<T> => {
  const server = await new Promise<ReturnType<express.Express['listen']>>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  try {
    const address = server.address() as AddressInfo;
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
};

test('admin reads and enables auto clock-out for the scoped franchise', async () => {
  const harness = createPool([]);
  setPostgresPoolOverride(harness.pool as never);
  const app = createApp({ accountType: 'ADMIN', accountId: 10, franchiseId: 1 });
  await withServer(app, async (baseUrl) => {
    const get = await fetch(`${baseUrl}/api/admin/settings?franchiseId=77`);
    assert.equal(get.status, 200);
    assert.deepEqual(await get.json(), {
      settings: {
        franchiseId: 77,
        autoClockOutEnabled: false,
        clockInTimeSnapEnabled: false
      }
    });
    const patch = await fetch(`${baseUrl}/api/admin/settings`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ franchiseId: 77, autoClockOutEnabled: true })
    });
    assert.equal(patch.status, 200);
    assert.deepEqual(await patch.json(), {
      settings: {
        franchiseId: 77,
        autoClockOutEnabled: true,
        clockInTimeSnapEnabled: false
      }
    });
  });
});

test('admin enables Time Snap without changing auto clock-out', async () => {
  const harness = createPool([{
    franchiseid: 77,
    auto_clock_out_enabled: true,
    clock_in_time_snap_enabled: false
  }]);
  setPostgresPoolOverride(harness.pool as never);
  const app = createApp({ accountType: 'ADMIN', accountId: 10, franchiseId: 1 });
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/admin/settings`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ franchiseId: 77, clockInTimeSnapEnabled: true })
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      settings: {
        franchiseId: 77,
        autoClockOutEnabled: true,
        clockInTimeSnapEnabled: true
      }
    });
  });
});

test('non-Boolean auto clock-out payload is rejected', async () => {
  const harness = createPool([]);
  setPostgresPoolOverride(harness.pool as never);
  await withServer(createApp({ accountType: 'ADMIN', accountId: 10, franchiseId: 1 }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/admin/settings`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ franchiseId: 77, autoClockOutEnabled: 'true' })
    });
    assert.equal(response.status, 400);
    assert.match(((await response.json()) as { error: string }).error, /boolean/i);
  });
});

test('invalid Time Snap and empty patches are rejected', async () => {
  const harness = createPool([]);
  setPostgresPoolOverride(harness.pool as never);
  await withServer(createApp({ accountType: 'ADMIN', accountId: 10, franchiseId: 1 }), async (baseUrl) => {
    const cases: Array<{ body: Record<string, unknown>; error: RegExp }> = [
      {
        body: { franchiseId: 77, clockInTimeSnapEnabled: 'true' },
        error: /clockInTimeSnapEnabled must be a boolean/i
      },
      {
        body: { franchiseId: 77 },
        error: /at least one automatic timekeeping setting/i
      }
    ];
    for (const { body, error } of cases) {
      const response = await fetch(`${baseUrl}/api/admin/settings`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      assert.equal(response.status, 400);
      assert.match(((await response.json()) as { error: string }).error, error);
    }
  });
});

test('tutors cannot access admin settings', async () => {
  const harness = createPool([]);
  setPostgresPoolOverride(harness.pool as never);
  await withServer(createApp({ accountType: 'TUTOR', accountId: 20, franchiseId: 9 }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/admin/settings`);
    assert.equal(response.status, 403);
  });
});

test('fixed-franchise admins cannot override their session franchise', async () => {
  const harness = createPool([]);
  setPostgresPoolOverride(harness.pool as never);
  await withServer(createApp({ accountType: 'ADMIN', accountId: 30, franchiseId: 9 }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/admin/settings`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ franchiseId: 77, autoClockOutEnabled: true })
    });
    assert.equal(response.status, 200);
  });
  assert.equal(harness.lastUpdatedFranchiseId(), 9);
});
