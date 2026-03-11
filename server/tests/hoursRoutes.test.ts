import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { DateTime } from 'luxon';
import { setMssqlPoolOverride } from '../db/mssql';
import { setPostgresPoolOverride } from '../db/postgres';
import hoursRoutes from '../routes/hours';

type SessionAuth = {
  accountType: 'ADMIN' | 'TUTOR';
  accountId: number;
  franchiseId: number | null;
  displayName?: string;
};

type PayrollSettingsRow = {
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

type ApprovedDayRow = {
  id: number;
  franchiseid: number;
  tutorid: number;
  work_date: string | Date;
  schedule_snapshot: unknown | null;
};

type SessionRow = {
  entry_day_id: number;
  start_at: string;
  end_at: string | null;
};

type TutorNameRow = {
  tutorId: number;
  firstName: string;
  lastName: string;
};

type QueryResult = { rowCount: number; rows: Array<Record<string, unknown>> };

afterEach(() => {
  setPostgresPoolOverride(undefined);
  setMssqlPoolOverride(undefined);
});

const toDateOnly = (value: string | Date): string =>
  value instanceof Date
    ? DateTime.fromJSDate(value, { zone: 'utc' }).toISODate() ?? ''
    : DateTime.fromISO(value, { zone: 'utc', setZone: true }).toISODate() ?? value;

const createPostgresPool = (args: {
  settings: PayrollSettingsRow[];
  approvedDays: ApprovedDayRow[];
  sessions: SessionRow[];
}) => {
  const settingsByFranchise = new Map(args.settings.map((row) => [row.franchiseid, { ...row }]));

  return {
    async query(sqlText: string, params: unknown[] = []): Promise<QueryResult> {
      if (sqlText.includes('FROM franchise_payroll_settings')) {
        const franchiseId = Number(params[0]);
        const row = settingsByFranchise.get(franchiseId);
        return row ? { rowCount: 1, rows: [{ ...row }] } : { rowCount: 0, rows: [] };
      }

      if (sqlText.includes('FROM franchise_pay_period_overrides')) {
        return { rowCount: 0, rows: [] };
      }

      if (sqlText.includes('FROM public.time_entry_days')) {
        if (params.length === 4) {
          const [franchiseIdRaw, tutorIdRaw, startDateRaw, endDateRaw] = params;
          const franchiseId = Number(franchiseIdRaw);
          const tutorId = Number(tutorIdRaw);
          const startDate = String(startDateRaw);
          const endDate = String(endDateRaw);
          const rows = args.approvedDays.filter(
            (row) => {
              const workDate = toDateOnly(row.work_date);
              return (
                row.franchiseid === franchiseId &&
                row.tutorid === tutorId &&
                workDate >= startDate &&
                workDate <= endDate
              );
            }
          );
          return { rowCount: rows.length, rows };
        }

        const [franchiseIdRaw, startDateRaw, endDateRaw] = params;
        const franchiseId = Number(franchiseIdRaw);
        const startDate = String(startDateRaw);
        const endDate = String(endDateRaw);
        const rows = args.approvedDays.filter(
          (row) => {
            const workDate = toDateOnly(row.work_date);
            return row.franchiseid === franchiseId && workDate >= startDate && workDate <= endDate;
          }
        );
        return { rowCount: rows.length, rows };
      }

      if (sqlText.includes('FROM public.time_entry_sessions')) {
        const requestedIds = new Set(((params[0] as number[]) ?? []).map(Number));
        const rows = args.sessions.filter((row) => requestedIds.has(row.entry_day_id) && row.end_at !== null);
        return { rowCount: rows.length, rows };
      }

      throw new Error(`Unexpected query: ${sqlText}`);
    }
  };
};

const createMssqlPool = (tutors: TutorNameRow[]) => ({
  request() {
    const inputs = new Map<string, number>();
    return {
      input(name: string, _type: unknown, value: number) {
        inputs.set(name, Number(value));
        return this;
      },
      async query(sqlText: string) {
        if (!sqlText.includes('FROM dbo.tblTutors')) {
          throw new Error(`Unexpected MSSQL query: ${sqlText}`);
        }

        const requestedIds = new Set(Array.from(inputs.values()));
        return {
          recordset: tutors
            .filter((row) => requestedIds.has(row.tutorId))
            .map((row) => ({
              TutorID: row.tutorId,
              FirstName: row.firstName,
              LastName: row.lastName
            }))
        };
      }
    };
  }
});

const createApp = (auth: SessionAuth) => {
  const now = new Date().toISOString();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as {
      session: { auth: Record<string, unknown>; save: (callback?: (err?: Error) => void) => void };
    }).session = {
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
  app.use('/api', hoursRoutes);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status =
      typeof (err as { status?: number } | null | undefined)?.status === 'number'
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

test('admin daily summary groups by tutor-day, filters zero totals, and sorts by tutor then date', async () => {
  setPostgresPoolOverride(
    createPostgresPool({
      settings: [
        {
          franchiseid: 77,
          policytype: 'strict_approval',
          timezone: 'America/Los_Angeles',
          pay_period_type: 'weekly',
          auto_email_enabled: false,
          custom_period_1_start_day: null,
          custom_period_1_end_day: null,
          custom_period_2_start_day: null,
          custom_period_2_end_day: null
        }
      ],
      approvedDays: [
        { id: 1, franchiseid: 77, tutorid: 10, work_date: new Date('2026-02-02T00:00:00.000Z'), schedule_snapshot: null },
        { id: 2, franchiseid: 77, tutorid: 10, work_date: '2026-02-03', schedule_snapshot: null },
        { id: 3, franchiseid: 77, tutorid: 20, work_date: '2026-02-02', schedule_snapshot: null },
        { id: 4, franchiseid: 77, tutorid: 10, work_date: '2026-02-03', schedule_snapshot: null },
        { id: 5, franchiseid: 77, tutorid: 30, work_date: '2026-02-04', schedule_snapshot: null }
      ],
      sessions: [
        { entry_day_id: 1, start_at: '2026-02-02T17:00:00.000Z', end_at: '2026-02-02T19:00:00.000Z' },
        { entry_day_id: 2, start_at: '2026-02-03T18:00:00.000Z', end_at: '2026-02-03T19:00:00.000Z' },
        { entry_day_id: 3, start_at: '2026-02-02T16:00:00.000Z', end_at: '2026-02-02T17:00:00.000Z' },
        { entry_day_id: 4, start_at: '2026-02-03T20:00:00.000Z', end_at: '2026-02-03T21:30:00.000Z' }
      ]
    }) as never
  );
  setMssqlPoolOverride(
    createMssqlPool([
      { tutorId: 10, firstName: 'Ben', lastName: 'Baker' },
      { tutorId: 20, firstName: 'Amy', lastName: 'Adams' },
      { tutorId: 30, firstName: 'Cara', lastName: 'Carter' }
    ]) as never
  );

  const app = createApp({ accountType: 'ADMIN', accountId: 100, franchiseId: 1, displayName: 'Admin User' });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/hours/admin/pay-period/summary-daily?franchiseId=77&forDate=2026-02-03`
    );

    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      payPeriod: { startDate: string; endDate: string; franchiseId: number };
      rows: Array<{ tutorId: number; firstName: string; lastName: string; workDate: string; totalHours: number }>;
    };

    assert.equal(body.payPeriod.franchiseId, 77);
    assert.equal(body.payPeriod.startDate, '2026-02-02');
    assert.equal(body.payPeriod.endDate, '2026-02-08');
    assert.deepEqual(body.rows, [
      { tutorId: 20, firstName: 'Amy', lastName: 'Adams', workDate: '2026-02-02', totalHours: 1 },
      { tutorId: 10, firstName: 'Ben', lastName: 'Baker', workDate: '2026-02-02', totalHours: 2 },
      { tutorId: 10, firstName: 'Ben', lastName: 'Baker', workDate: '2026-02-03', totalHours: 2.5 }
    ]);
  });
});

test('daily summary rejects invalid forDate values', async () => {
  setPostgresPoolOverride(createPostgresPool({ settings: [], approvedDays: [], sessions: [] }) as never);
  setMssqlPoolOverride(createMssqlPool([]) as never);

  const app = createApp({ accountType: 'ADMIN', accountId: 200, franchiseId: 1, displayName: 'Admin User' });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/hours/admin/pay-period/summary-daily?franchiseId=77&forDate=2026-2-3`);
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: string };
    assert.match(body.error, /forDate must be YYYY-MM-DD/i);
  });
});

test('non-admin users cannot access daily summary endpoint', async () => {
  setPostgresPoolOverride(createPostgresPool({ settings: [], approvedDays: [], sessions: [] }) as never);
  setMssqlPoolOverride(createMssqlPool([]) as never);

  const app = createApp({ accountType: 'TUTOR', accountId: 300, franchiseId: 55, displayName: 'Tutor User' });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/hours/admin/pay-period/summary-daily?franchiseId=77`);
    assert.equal(response.status, 403);
    const body = (await response.json()) as { error: string };
    assert.match(body.error, /forbidden/i);
  });
});

test('selector-disabled admins are locked to their session franchise for daily summary', async () => {
  setPostgresPoolOverride(
    createPostgresPool({
      settings: [
        {
          franchiseid: 9,
          policytype: 'strict_approval',
          timezone: 'America/Los_Angeles',
          pay_period_type: 'weekly',
          auto_email_enabled: false,
          custom_period_1_start_day: null,
          custom_period_1_end_day: null,
          custom_period_2_start_day: null,
          custom_period_2_end_day: null
        }
      ],
      approvedDays: [{ id: 11, franchiseid: 9, tutorid: 41, work_date: '2026-02-02', schedule_snapshot: null }],
      sessions: [{ entry_day_id: 11, start_at: '2026-02-02T18:00:00.000Z', end_at: '2026-02-02T20:00:00.000Z' }]
    }) as never
  );
  setMssqlPoolOverride(createMssqlPool([{ tutorId: 41, firstName: 'Nina', lastName: 'North' }]) as never);

  const app = createApp({ accountType: 'ADMIN', accountId: 400, franchiseId: 9, displayName: 'Scoped Admin' });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/hours/admin/pay-period/summary-daily?franchiseId=123&forDate=2026-02-03`
    );

    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      payPeriod: { franchiseId: number };
      rows: Array<{ tutorId: number; firstName: string; lastName: string; workDate: string; totalHours: number }>;
    };

    assert.equal(body.payPeriod.franchiseId, 9);
    assert.deepEqual(body.rows, [
      { tutorId: 41, firstName: 'Nina', lastName: 'North', workDate: '2026-02-02', totalHours: 2 }
    ]);
  });
});
