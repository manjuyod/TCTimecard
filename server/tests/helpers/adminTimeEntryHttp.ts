import express from 'express';
import type { AddressInfo } from 'node:net';
import { createAdminTimeEntryRouter } from '../../routes/adminTimeEntry';
import type { AdminTimeEntryRouteDeps } from '../../services/adminTimeEntry/contracts';
export function adminApp(
  deps: AdminTimeEntryRouteDeps,
  auth: Record<string, unknown> | null = {
    accountType: 'ADMIN',
    accountId: 100,
    franchiseId: 77,
  },
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const now = new Date().toISOString();
    (req as any).session = {
      auth: auth ? { ...auth, createdAt: now, lastSeenAt: now } : undefined,
      save: (callback: (err?: Error) => void) => callback?.(),
    };
    next();
  });
  app.use('/api', createAdminTimeEntryRouter(deps));
  return app;
}
export async function withAdminHttp<T>(
  app: express.Express,
  run: (base: string) => Promise<T>,
): Promise<T> {
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  try {
    return await run(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/time-entry/admin`,
    );
  } finally {
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  }
}
