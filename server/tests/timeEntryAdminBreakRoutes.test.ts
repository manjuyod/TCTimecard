import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { setPostgresPoolOverride } from '../db/postgres';
import timeEntryRoutes from '../routes/timeEntry';

afterEach(() => setPostgresPoolOverride(undefined));

// Source-preservation and break allocation now run through the atomic correction
// service in adminTimeEntryPreview/Operations tests. Retired routes must not mutate.
for (const role of ['ADMIN', 'TUTOR', null] as const) {
  test(`legacy admin break and session editors require the staged workflow (${role ?? 'unauthenticated'})`, async () => {
    let databaseCalls = 0;
    setPostgresPoolOverride({ connect: async () => {
      databaseCalls++; throw new Error('Retired route must not access the database');
    } } as never);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const now = new Date().toISOString();
      (req as unknown as { session: unknown }).session = {
        auth: role ? { accountType: role, accountId: 100, franchiseId: 77, createdAt: now, lastSeenAt: now } : undefined,
        save: (callback?: () => void) => callback?.()
      };
      next();
    });
    app.use('/api', timeEntryRoutes);
    app.use((error: { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) =>
      res.status(error.status ?? 500).json({ error: 'Request rejected' }));
    const server = app.listen(0);
    await new Promise<void>(resolve => server.on('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/time-entry/admin/day/44`;
    try {
      for (const [method, suffix] of [['PUT', ''], ['POST', '/breaks'], ['PUT', '/breaks/123'], ['POST', '/breaks/123/void']]) {
        const response = await fetch(`${base}${suffix}?franchiseId=77`, { method,
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'Correct an error' }) });
        assert.equal(response.status, role === 'ADMIN' ? 409 : role === 'TUTOR' ? 403 : 401);
        if (role === 'ADMIN') assert.equal((await response.json() as { code: string }).code, 'ADMIN_CORRECTION_REQUIRED');
      }
      assert.equal(databaseCalls, 0);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
}
