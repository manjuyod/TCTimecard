import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';
import ExcelJS from 'exceljs';
import { DateTime } from 'luxon';
import { setPostgresPoolOverride } from '../db/postgres';
import { setMssqlPoolOverride } from '../db/mssql';
import hoursRoutes from '../routes/hours';
import { createAdminRepository } from '../services/adminTimeEntry/repository';
import { createAdminDirectory } from '../services/adminTimeEntry/directory';
import {
  fetchLatestScheduleSnapshots,
  scheduleCandidateKey,
} from '../services/scheduleSource';
import {
  previewCorrection,
  previewStatusOperation,
} from '../services/adminTimeEntry/preview';
import { commitAdminOperation } from '../services/adminTimeEntry/operations';
import type { PreviewDeps } from '../services/adminTimeEntry/contracts';
import { withTimeEntryDatabase } from './helpers/adminTimeEntryDatabase';

const timezone = 'America/Los_Angeles';
const actor = { accountId: 100, franchiseId: 77 };

/** Only the external CRM schedule/name boundary is fake; PostgreSQL SQL and
 * allocation, lifecycle, rollups, route authorization and exporters remain real. */
function crmPool(workDate: string) {
  const slots = Object.freeze(
    [9, 10, 11].map((hour, i) =>
      Object.freeze({
        FranchiseID: 77,
        TutorID: 88,
        WorkDate: workDate,
        ScheduleDate: workDate,
        TimeID: i + 1,
        TimeLabel: `${hour}:00 AM`,
      }),
    ),
  );
  const queries: string[] = [];
  const pool = {
    request() {
      const inputs = new Map<string, unknown>();
      return {
        input(name: string, _type: unknown, value: unknown) {
          inputs.set(name, value);
          return this;
        },
        async query(sql: string) {
          queries.push(sql);
          assert.ok(
            !/^\s*(INSERT|UPDATE|DELETE|MERGE)\b/i.test(sql),
            'Payroll lifecycle must not write CRM',
          );
          if (sql.includes('dbo.tblTutors')) {
            if (inputs.has('FranchiseId'))
              assert.equal(inputs.get('FranchiseId'), 77);
            else
              assert.ok(
                [...inputs.values()].includes(88),
                'Tutor names must be queried for the real tutor ID',
              );
            return {
              recordset: [
                {
                  ID: 88,
                  TutorID: 88,
                  FirstName: 'Alex',
                  LastName: 'Rivera',
                  IsDeleted: 0,
                },
              ],
            };
          }
          if (sql.includes('dbo.tblSessionSchedule')) {
            if (inputs.has('p_franchise_0')) {
              assert.equal(inputs.get('p_franchise_0'), 77);
              assert.equal(inputs.get('p_tutor_0'), 88);
              assert.equal(inputs.get('p_date_0'), workDate);
              return { recordset: slots.map((slot) => ({ ...slot })) };
            }
            assert.equal(inputs.get('p_franchise_id'), 77);
            assert.ok(String(inputs.get('p_period_start')) <= workDate);
            assert.ok(String(inputs.get('p_effective_end')) >= workDate);
            if (inputs.has('p_tutor_id')) {
              assert.equal(inputs.get('p_tutor_id'), 88);
              return {
                recordset: [{ WorkDate: workDate, ReportedCRMHours: 3 }],
              };
            }
            if (sql.includes('GROUP BY ds.TutorID, ds.WorkDate'))
              return {
                recordset: [
                  { TutorID: 88, WorkDate: workDate, ReportedCRMHours: 3 },
                ],
              };
            return { recordset: [{ TutorID: 88, ReportedCRMHours: 3 }] };
          }
          throw new Error('Unexpected CRM SQL in payroll test');
        },
      };
    },
  };
  return { pool, slots, queries };
}

function app() {
  const next = express();
  next.use(express.json());
  next.use((req, _res, done) => {
    const tutor = req.headers['x-test-role'] === 'tutor';
    const now = new Date().toISOString();
    (req as any).session = {
      auth: {
        accountType: tutor ? 'TUTOR' : 'ADMIN',
        accountId: tutor ? 88 : 100,
        franchiseId: 77,
        displayName: tutor ? 'Alex Rivera' : 'Test Admin',
        createdAt: now,
        lastSeenAt: now,
      },
      save: (callback: () => void) => callback?.(),
    };
    done();
  });
  next.use('/api', hoursRoutes);
  next.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) =>
      res
        .status(500)
        .json({
          error: err instanceof Error ? err.message : 'Unexpected error',
        }),
  );
  return next;
}

async function withHttp<T>(run: (base: string) => Promise<T>): Promise<T> {
  const server = app().listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  try {
    return await run(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`,
    );
  } finally {
    await new Promise<void>((r, j) =>
      server.close((err) => (err ? j(err) : r())),
    );
  }
}

function parseCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    field = '',
    quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (c === '"') {
      if (quoted && csv[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = !quoted;
    } else if (c === ',' && !quoted) {
      row.push(field);
      field = '';
    } else if (c === '\n' && !quoted) {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field || row.length) {
    row.push(field.replace(/\r$/, ''));
    rows.push(row);
  }
  assert.equal(quoted, false, 'CSV must finish outside a quoted field');
  return rows;
}

test(
  'approved correction, void and restore update every public payroll read and parsed export exactly once',
  { skip: process.env.RUN_TIME_ENTRY_POSTGRES_TESTS !== '1' },
  async (t) =>
    withTimeEntryDatabase(async (pool) => {
      // Choose the current center-local work date so current-only weekly/pay-period
      // routes and the explicit monthly query remain stable across calendar edges.
      const today = DateTime.now().setZone(timezone).startOf('day'),
        workDate = today.toISODate()!;
      const start = today.set({ hour: 9 }).toUTC().toISO()!,
        oldEnd = today.set({ hour: 12 }).toUTC().toISO()!,
        newEnd = today.set({ hour: 12, minute: 15 }).toUTC().toISO()!;
      // Operation services expose an authoritative clock dependency. Fixed day-end
      // simulates actual completed punches without mocking Date or public readers.
      const now = () => today.set({ hour: 23, minute: 59 }).toJSDate();
      await pool.query(`CREATE TABLE public.franchise_payroll_settings(franchiseid INTEGER PRIMARY KEY,policytype TEXT NOT NULL,timezone TEXT NOT NULL,pay_period_type TEXT NOT NULL,auto_email_enabled BOOLEAN NOT NULL,custom_period_1_start_day INTEGER,custom_period_1_end_day INTEGER,custom_period_2_start_day INTEGER,custom_period_2_end_day INTEGER);
    CREATE TABLE public.franchise_pay_period_overrides(id SERIAL PRIMARY KEY,franchiseid INTEGER NOT NULL,periodstart DATE NOT NULL,periodend DATE NOT NULL,createdat TIMESTAMPTZ NOT NULL DEFAULT NOW());
    INSERT INTO public.franchise_payroll_settings(franchiseid,policytype,timezone,pay_period_type,auto_email_enabled) VALUES(77,'strict_approval','America/Los_Angeles','weekly',false)`);
      await pool.query(
        `INSERT INTO public.time_entry_days(id,franchiseid,tutorid,work_date,timezone,status,clock_state)VALUES(44,77,88,$1,$2,'pending',0)`,
        [workDate, timezone],
      );
      await pool.query(
        `INSERT INTO public.time_entry_sessions(id,entry_day_id,franchiseid,tutorid,start_at,end_at,sort_order)VALUES(99,44,77,88,$1,$2,0)`,
        [start, oldEnd],
      );
      const crm = crmPool(workDate),
        originalCrm = JSON.stringify(crm.slots);
      setPostgresPoolOverride(pool);
      setMssqlPoolOverride(crm.pool as never);
      const directory = createAdminDirectory({ pool: () => pool });
      const repo = createAdminRepository({ pool: () => pool, directory });
      const secret = 'disposable-payroll-test-secret';
      const deps: PreviewDeps = {
        getDetail: repo.getAdminDetail,
        getById: repo.getAdminDetailById,
        requireActiveTutor: directory.requireActiveTutor,
        getSchedule: async (key) =>
          (await fetchLatestScheduleSnapshots([key], now())).get(
            scheduleCandidateKey(key),
          ) ?? null,
        now,
        secret,
      };
      const operation = { pool, now, secret };
      try {
        await withHttp(async (base) => {
          const json = async (path: string, tutor = false) => {
            const response = await fetch(base + path, {
              headers: tutor ? { 'x-test-role': 'tutor' } : {},
            });
            assert.equal(
              response.status,
              200,
              `${path}: ${await response.clone().text()}`,
            );
            return response.json() as Promise<any>;
          };
          const checkpoint = async (label: string, minutes: number, expected?: {
            tutoringHours: number; extraHours: number; diff: string; punches: string;
          }) =>
            t.test(label, async () => {
              const hours = minutes / 60;
              const tutoringHours = expected?.tutoringHours ?? (minutes ? 3 : 0),
                extraHours = expected?.extraHours ?? (minutes ? 0.25 : 0);
              const adminQuery = `?franchiseId=77&forDate=${workDate}`;
              for (const path of [
                '/hours/me/weekly',
                `/hours/me/monthly?month=${workDate.slice(0, 7)}`,
                '/hours/me/pay-period',
              ]) {
                const body = await json(path, true);
                assert.equal(body.totalHours, hours, `${label}: ${path}`);
                assert.equal(body.tutoringHours, tutoringHours);
                assert.equal(body.extraHours, extraHours);
              }
              const summary = await json(
                '/hours/admin/pay-period/summary' + adminQuery,
              );
              assert.deepEqual(summary.rows, [
                {
                  tutorId: 88,
                  firstName: 'Alex',
                  lastName: 'Rivera',
                  reportedCrmHours: 3,
                  loggedHours: hours,
                },
              ]);
              const detail = await json(
                '/hours/admin/pay-period/summary-detail' +
                  adminQuery +
                  '&tutorId=88',
              );
              assert.deepEqual(detail.rows, [
                { workDate, reportedCrmHours: 3, loggedHours: hours },
              ]);
              const daily = await json(
                '/hours/admin/pay-period/summary-daily' + adminQuery,
              );
              assert.deepEqual(
                daily.rows,
                minutes
                  ? [
                      {
                        tutorId: 88,
                        firstName: 'Alex',
                        lastName: 'Rivera',
                        workDate,
                        totalHours: hours,
                      },
                    ]
                  : [],
              );
              const legacyExpected = minutes
                ? [
                    {
                      tutorId: 88,
                      firstName: 'Alex',
                      lastName: 'Rivera',
                      tutoringHours,
                      extraHours,
                      totalHours: hours,
                    },
                  ]
                : [];
              for (const endpoint of [
                'summary-total-positive',
                'summary-legacy-export',
              ])
                assert.deepEqual(
                  (
                    await json(
                      '/hours/admin/pay-period/' + endpoint + adminQuery,
                    )
                  ).rows,
                  legacyExpected,
                  `${label}: clipboard/legacy source ${endpoint}`,
                );
              const csvResponse = await fetch(
                base +
                  '/hours/admin/pay-period/export' +
                  adminQuery +
                  '&format=csv',
              );
              assert.equal(csvResponse.status, 200);
              const csv = parseCsv(await csvResponse.text());
              assert.deepEqual(csv[0], [
                'Tutor',
                'Date',
                'Reported CRM Hours',
                'Logged Hours',
                'Diff',
                'Time In / Out',
              ]);
              assert.equal(csv.length, 2);
              assert.deepEqual(csv[1], [
                'Rivera, Alex',
                workDate,
                '3.00',
                hours.toFixed(2),
                expected?.diff ?? (minutes ? '+0.25' : '-3.00'),
                expected?.punches ?? (minutes ? '9:00 AM - 12:15 PM' : ''),
              ]);
              const xlsxResponse = await fetch(
                base +
                  '/hours/admin/pay-period/export' +
                  adminQuery +
                  '&format=xlsx',
              );
              assert.equal(xlsxResponse.status, 200);
              const workbook = new ExcelJS.Workbook();
              await workbook.xlsx.load(
                new Uint8Array(await xlsxResponse.arrayBuffer()) as never,
              );
              const sheet = workbook.getWorksheet('Pay Period Review');
              assert.ok(sheet);
              assert.equal(sheet.rowCount, 3);
              assert.equal(sheet.getRow(2).getCell(1).value, 'Rivera, Alex');
              assert.equal(sheet.getRow(2).getCell(3).value, 3);
              assert.equal(sheet.getRow(2).getCell(4).value, hours);
              assert.equal(sheet.getRow(2).getCell(5).value, hours - 3);
              assert.equal(sheet.getRow(3).getCell(2).value, workDate);
              assert.equal(sheet.getRow(3).getCell(3).value, 3);
              assert.equal(sheet.getRow(3).getCell(4).value, hours);
              assert.equal(sheet.getRow(3).getCell(5).value, hours - 3);
              assert.equal(
                sheet.getRow(3).getCell(6).value,
                expected?.punches ?? (minutes ? '9:00 AM - 12:15 PM' : ''),
              );
              assert.equal(sheet.getRow(3).outlineLevel, 1);
              assert.equal(sheet.getRow(3).hidden, true);
              assert.equal(
                JSON.stringify(crm.slots),
                originalCrm,
                'CRM reported schedule data must remain unchanged',
              );
            });
          const pending = await repo.getAdminDetailById(77, 44);
          assert.equal(pending.totals!.recordedPaidMinutes, 180);
          await checkpoint(
            'pending 180 recorded minutes contributes zero payroll minutes',
            0,
          );
          const correction = await previewCorrection(
            actor,
            {
              franchiseId: 77,
              tutorId: 88,
              workDate,
              expectedRevision: pending.revision,
              sessions: [{ id: 99, startAt: start, endAt: newEnd }],
              breaks: [],
              reason: 'Corrected forgotten clock-out',
            },
            deps,
          );
          assert.equal(correction.approvedDeltaMinutes, 195);
          const approvedResult = await commitAdminOperation(
            actor,
            {
              operationId: randomUUID(),
              previewToken: correction.previewToken,
            },
            operation,
          );
          assert.equal(approvedResult.after.approvedMinutes, 195);
          await checkpoint('corrected and approved 195 minutes', 195);
          for (const edit of [
            { minutes: 210, end: today.set({ hour: 12, minute: 30 }).toUTC().toISO()!,
              tutoringHours: 3, extraHours: 0.5, diff: '+0.50', punches: '9:00 AM - 12:30 PM' },
            { minutes: 165, end: today.set({ hour: 11, minute: 45 }).toUTC().toISO()!,
              tutoringHours: 2.75, extraHours: 0, diff: '-0.25', punches: '9:00 AM - 11:45 AM' },
            { minutes: 195, end: newEnd,
              tutoringHours: 3, extraHours: 0.25, diff: '+0.25', punches: '9:00 AM - 12:15 PM' },
          ]) {
            const current = await repo.getAdminDetailById(77, 44);
            const adjustment = await previewCorrection(actor, {
              franchiseId: 77, tutorId: 88, workDate, expectedRevision: current.revision,
              sessions: [{ id: 99, startAt: start, endAt: edit.end }], breaks: [],
              reason: 'Correct already approved hours',
            }, deps);
            assert.equal(adjustment.before.approvedMinutes, current.totals!.approvedMinutes);
            assert.equal(adjustment.after.approvedMinutes, edit.minutes);
            const request = { operationId: randomUUID(), previewToken: adjustment.previewToken };
            const result = await commitAdminOperation(actor, request, operation);
            assert.deepEqual(await commitAdminOperation(actor, request, operation), result);
            assert.equal(result.status, 'approved');
            await checkpoint(`approved-to-approved edit counts exactly ${edit.minutes} minutes`, edit.minutes, edit);
          }
          const approved = await repo.getAdminDetailById(77, 44),
            preserved = approved.day!.sessions;
          const voidPreview = await previewStatusOperation(
            'void',
            actor,
            {
              franchiseId: 77,
              dayId: 44,
              expectedRevision: approved.revision,
              reason: 'Void incorrect paid entry',
            },
            deps,
          );
          await commitAdminOperation(
            actor,
            {
              operationId: randomUUID(),
              previewToken: voidPreview.previewToken,
            },
            operation,
          );
          const voided = await repo.getAdminDetailById(77, 44);
          assert.equal(voided.day!.status, 'voided');
          assert.deepEqual(voided.day!.sessions, preserved);
          await checkpoint(
            'voided retained raw 195 minutes contributes zero payroll minutes',
            0,
          );
          const rawMinutes = (
            await pool.query(
              'SELECT sum(EXTRACT(EPOCH FROM(end_at-start_at))/60)::integer AS minutes FROM public.time_entry_sessions WHERE entry_day_id=44',
            )
          ).rows[0].minutes;
          assert.equal(
            rawMinutes,
            195,
            'The zero is lifecycle exclusion, not deletion of worked intervals',
          );
          const restore = await previewStatusOperation(
            'restore',
            actor,
            {
              franchiseId: 77,
              dayId: 44,
              expectedRevision: voided.revision,
              reason: 'Restore mistakenly voided entry',
            },
            deps,
          );
          const restoreRequest = {
            operationId: randomUUID(),
            previewToken: restore.previewToken,
          };
          await commitAdminOperation(actor, restoreRequest, operation);
          await commitAdminOperation(actor, restoreRequest, operation);
          const restored = await repo.getAdminDetailById(77, 44);
          assert.equal(restored.day!.status, 'approved');
          assert.deepEqual(restored.day!.sessions, preserved);
          await checkpoint(
            'restored once to 195 minutes despite operation replay',
            195,
          );
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::integer AS count FROM public.time_entry_sessions WHERE entry_day_id=44',
              )
            ).rows[0].count,
            1,
          );
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::integer AS count FROM public.time_entry_audit WHERE operation_id IS NOT NULL',
              )
            ).rows[0].count,
            6,
          );
          assert.ok(crm.queries.some((q) => q.includes('dbo.tblTutors')));
          assert.ok(
            crm.queries.some((q) => q.includes('dbo.tblSessionSchedule')),
          );
        });
      } finally {
        setPostgresPoolOverride(undefined);
        setMssqlPoolOverride(undefined);
      }
    }),
);
