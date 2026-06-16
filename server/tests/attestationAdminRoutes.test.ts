import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import ExcelJS from 'exceljs';
import { setMssqlPoolOverride } from '../db/mssql';
import { setPostgresPoolOverride } from '../db/postgres';
import attestationRoutes from '../routes/attestation';

type SessionAuth = {
  accountType: 'ADMIN' | 'TUTOR';
  accountId: number;
  franchiseId: number | null;
  displayName?: string;
};

type AttestationRow = {
  id: number;
  franchiseid: number;
  tutorid: number;
  week_start: string;
  week_end: string;
  timezone: string;
  typed_name: string;
  signed_at: string;
  attestation_text: string;
  attestation_text_version: string;
  metadata?: Record<string, unknown>;
};

type TutorRow = {
  tutorId: number;
  firstName: string;
  lastName: string;
};

type QueryResult = { rowCount: number; rows: Array<Record<string, unknown>> };

afterEach(() => {
  setPostgresPoolOverride(undefined);
  setMssqlPoolOverride(undefined);
});

const createPostgresPool = (attestations: AttestationRow[]) => ({
  async query(sqlText: string, params: unknown[] = []): Promise<QueryResult> {
    if (!sqlText.includes('FROM public.weekly_attestations')) {
      throw new Error(`Unexpected query: ${sqlText}`);
    }

    const franchiseId = Number(params[0]);
    const weekEndStart = String(params[1]);
    const weekEndEnd = String(params[2]);
    const tutorId = params.length >= 4 && params[3] !== null && params[3] !== undefined ? Number(params[3]) : null;

    const rows = attestations.filter((row) => {
      const matchesTutor = tutorId === null || row.tutorid === tutorId;
      return (
        row.franchiseid === franchiseId &&
        row.week_end >= weekEndStart &&
        row.week_end <= weekEndEnd &&
        matchesTutor
      );
    });

    if (/SELECT\s+DISTINCT\s+tutorid/i.test(sqlText)) {
      const distinctRows = Array.from(new Set(rows.map((row) => row.tutorid)))
        .sort((a, b) => a - b)
        .map((tutorid) => ({ tutorid }));
      return { rowCount: distinctRows.length, rows: distinctRows };
    }

    return {
      rowCount: rows.length,
      rows: [...rows].sort((a, b) => {
        const byWeek = b.week_end.localeCompare(a.week_end);
        if (byWeek !== 0) return byWeek;
        return a.tutorid - b.tutorid;
      })
    };
  }
});

const createMssqlPool = (tutors: TutorRow[]) => ({
  request() {
    const inputs = new Map<string, unknown>();
    return {
      input(name: string, _type: unknown, value: unknown) {
        inputs.set(name, value);
        return this;
      },
      async query(sqlText: string) {
        if (!sqlText.includes('FROM dbo.tblTutors')) {
          throw new Error(`Unexpected MSSQL query: ${sqlText}`);
        }

        const requestedIds = new Set(Array.from(inputs.values()).map(Number));
        return {
          recordset: tutors
            .filter((row) => requestedIds.has(row.tutorId))
            .map((row) => ({
              ID: row.tutorId,
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
  app.use('/api', attestationRoutes);
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

const sampleAttestations: AttestationRow[] = [
  {
    id: 1,
    franchiseid: 77,
    tutorid: 10,
    week_start: '2026-02-01',
    week_end: '2026-02-07',
    timezone: 'America/Los_Angeles',
    typed_name: 'Ben Baker',
    signed_at: '2026-02-08T17:15:00.000Z',
    attestation_text: 'By signing...',
    attestation_text_version: '2026-01-07'
  },
  {
    id: 2,
    franchiseid: 77,
    tutorid: 20,
    week_start: '2026-02-08',
    week_end: '2026-02-14',
    timezone: 'America/Los_Angeles',
    typed_name: 'Amy Adams',
    signed_at: '2026-02-15T18:30:00.000Z',
    attestation_text: 'By signing...',
    attestation_text_version: '2026-01-07'
  },
  {
    id: 3,
    franchiseid: 88,
    tutorid: 30,
    week_start: '2026-02-08',
    week_end: '2026-02-14',
    timezone: 'America/Chicago',
    typed_name: 'Cara Carter',
    signed_at: '2026-02-15T19:30:00.000Z',
    attestation_text: 'By signing...',
    attestation_text_version: '2026-01-07'
  }
];

const sampleTutors: TutorRow[] = [
  { tutorId: 10, firstName: 'Ben', lastName: 'Baker' },
  { tutorId: 20, firstName: 'Amy', lastName: 'Adams' },
  { tutorId: 30, firstName: 'Cara', lastName: 'Carter' }
];

test('admin attestation export returns xlsx with signed attestation rows', async () => {
  setPostgresPoolOverride(createPostgresPool(sampleAttestations) as never);
  setMssqlPoolOverride(createMssqlPool(sampleTutors) as never);

  const app = createApp({ accountType: 'ADMIN', accountId: 100, franchiseId: 1, displayName: 'Admin User' });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/attestation/admin/export?franchiseId=77&weekEndStart=2026-02-01&weekEndEnd=2026-02-28`
    );

    assert.equal(response.status, 200);
    assert.match(
      response.headers.get('content-type') ?? '',
      /application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet/i
    );

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(new Uint8Array(await response.arrayBuffer()) as never);
    const worksheet = workbook.getWorksheet('Attestation Log');
    assert.ok(worksheet);
    assert.deepEqual(worksheet?.getRow(1).values, [
      ,
      'Tutor',
      'Tutor ID',
      'Week Start',
      'Week End',
      'Signed At',
      'Typed Name',
      'Attestation Text Version'
    ]);
    assert.deepEqual(worksheet?.getRow(2).values, [
      ,
      'Adams, Amy',
      20,
      '2026-02-08',
      '2026-02-14',
      '2026-02-15T18:30:00.000Z',
      'Amy Adams',
      '2026-01-07'
    ]);
    assert.deepEqual(worksheet?.getRow(3).values, [
      ,
      'Baker, Ben',
      10,
      '2026-02-01',
      '2026-02-07',
      '2026-02-08T17:15:00.000Z',
      'Ben Baker',
      '2026-01-07'
    ]);
  });
});

test('admin attestation export filters by tutorId', async () => {
  setPostgresPoolOverride(createPostgresPool(sampleAttestations) as never);
  setMssqlPoolOverride(createMssqlPool(sampleTutors) as never);

  const app = createApp({ accountType: 'ADMIN', accountId: 100, franchiseId: 1, displayName: 'Admin User' });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/attestation/admin/export?franchiseId=77&weekEndStart=2026-02-01&weekEndEnd=2026-02-28&tutorId=10`
    );

    assert.equal(response.status, 200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(new Uint8Array(await response.arrayBuffer()) as never);
    const worksheet = workbook.getWorksheet('Attestation Log');
    assert.equal(worksheet?.rowCount, 2);
    assert.equal(worksheet?.getRow(2).getCell(1).value, 'Baker, Ben');
    assert.equal(worksheet?.getRow(2).getCell(2).value, 10);
  });
});

test('admin attestation tutor options returns distinct signed tutors for selected week range', async () => {
  setPostgresPoolOverride(
    createPostgresPool([
      ...sampleAttestations,
      {
        ...sampleAttestations[0],
        id: 4,
        week_start: '2026-02-15',
        week_end: '2026-02-21',
        signed_at: '2026-02-22T17:15:00.000Z'
      }
    ]) as never
  );
  setMssqlPoolOverride(createMssqlPool(sampleTutors) as never);

  const app = createApp({ accountType: 'ADMIN', accountId: 100, franchiseId: 1, displayName: 'Admin User' });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/attestation/admin/tutors?franchiseId=77&weekEndStart=2026-02-01&weekEndEnd=2026-02-28`
    );

    assert.equal(response.status, 200);
    const body = (await response.json()) as { tutors: Array<{ tutorId: number; firstName: string; lastName: string; displayName: string }> };
    assert.deepEqual(body.tutors, [
      { tutorId: 20, firstName: 'Amy', lastName: 'Adams', displayName: 'Adams, Amy' },
      { tutorId: 10, firstName: 'Ben', lastName: 'Baker', displayName: 'Baker, Ben' }
    ]);
  });
});

test('admin attestation endpoints reject missing or invalid filters', async () => {
  setPostgresPoolOverride(createPostgresPool([]) as never);
  setMssqlPoolOverride(createMssqlPool([]) as never);

  const app = createApp({ accountType: 'ADMIN', accountId: 100, franchiseId: 1, displayName: 'Admin User' });

  await withServer(app, async (baseUrl) => {
    const missingDate = await fetch(`${baseUrl}/api/attestation/admin/export?franchiseId=77&weekEndEnd=2026-02-28`);
    assert.equal(missingDate.status, 400);
    assert.match(((await missingDate.json()) as { error: string }).error, /weekEndStart/i);

    const invalidRange = await fetch(
      `${baseUrl}/api/attestation/admin/export?franchiseId=77&weekEndStart=2026-03-01&weekEndEnd=2026-02-28`
    );
    assert.equal(invalidRange.status, 400);
    assert.match(((await invalidRange.json()) as { error: string }).error, /weekEndStart must be on or before weekEndEnd/i);

    const invalidTutor = await fetch(
      `${baseUrl}/api/attestation/admin/export?franchiseId=77&weekEndStart=2026-02-01&weekEndEnd=2026-02-28&tutorId=abc`
    );
    assert.equal(invalidTutor.status, 400);
    assert.match(((await invalidTutor.json()) as { error: string }).error, /tutorId/i);
  });
});

test('non-admin users cannot access admin attestation export', async () => {
  setPostgresPoolOverride(createPostgresPool([]) as never);
  setMssqlPoolOverride(createMssqlPool([]) as never);

  const app = createApp({ accountType: 'TUTOR', accountId: 10, franchiseId: 77, displayName: 'Tutor User' });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/attestation/admin/export?franchiseId=77&weekEndStart=2026-02-01&weekEndEnd=2026-02-28`
    );
    assert.equal(response.status, 403);
    assert.match(((await response.json()) as { error: string }).error, /forbidden/i);
  });
});

test('selector-disabled admins are locked to session franchise for attestation export', async () => {
  setPostgresPoolOverride(
    createPostgresPool([
      {
        id: 11,
        franchiseid: 9,
        tutorid: 10,
        week_start: '2026-02-01',
        week_end: '2026-02-07',
        timezone: 'America/Los_Angeles',
        typed_name: 'Ben Baker',
        signed_at: '2026-02-08T17:15:00.000Z',
        attestation_text: 'By signing...',
        attestation_text_version: '2026-01-07'
      },
      {
        id: 12,
        franchiseid: 77,
        tutorid: 20,
        week_start: '2026-02-01',
        week_end: '2026-02-07',
        timezone: 'America/Los_Angeles',
        typed_name: 'Amy Adams',
        signed_at: '2026-02-08T18:15:00.000Z',
        attestation_text: 'By signing...',
        attestation_text_version: '2026-01-07'
      }
    ]) as never
  );
  setMssqlPoolOverride(createMssqlPool(sampleTutors) as never);

  const app = createApp({ accountType: 'ADMIN', accountId: 400, franchiseId: 9, displayName: 'Scoped Admin' });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/attestation/admin/export?franchiseId=77&weekEndStart=2026-02-01&weekEndEnd=2026-02-28`
    );

    assert.equal(response.status, 200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(new Uint8Array(await response.arrayBuffer()) as never);
    const worksheet = workbook.getWorksheet('Attestation Log');
    assert.equal(worksheet?.rowCount, 2);
    assert.equal(worksheet?.getRow(2).getCell(1).value, 'Baker, Ben');
    assert.equal(worksheet?.getRow(2).getCell(2).value, 10);
  });
});
