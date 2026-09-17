import type { Pool, PoolClient } from 'pg';
import { getPostgresPool } from '../../db/postgres';
import { resolvePayPeriod } from '../../payroll/payPeriodResolution';
import type {
  AdminCommand,
  AdminEntry,
  AdminOperationResult,
  AdminTimeEntryDetail,
  AuditItem,
  DayFilters,
  DayListItem,
  EntryKey,
  NormalizedCorrection,
  Page,
} from './contracts';
import {
  canonicalJsonStringify,
  parseScheduleSnapshotV1,
} from '../scheduleSnapshot';
import { computeTimeEntryComparisonV2 } from '../timeEntryComparison';
import { allowedAdminTimeEntryActions } from './policy';
import { revisionForEntry } from './revision';
import { AdminTimeEntryError, invalid, positiveId } from './errors';
import { decodeCursor, encodeCursor, validateDayFilters } from './pagination';
import { entrySummary } from './totals';
import { createAdminDirectory } from './directory';
import { persistedTimestamp, timestampColumns } from './timestamps';
type Row = Record<string, any>;
const iso = (value: any): string => persistedTimestamp(value);
const nullableIso = (value: any): string | null =>
  value == null ? null : iso(value);
const dayColumns = `*,${timestampColumns(['created_at', 'updated_at', 'submitted_at', 'decided_at'])}`;
const sessionColumns = `*,${timestampColumns(['start_at', 'end_at', 'created_at', 'updated_at'])}`;
const breakColumns = `*,${timestampColumns(['start_time', 'end_time', 'created_at', 'updated_at'])}`;
export function mapEntry(
  row: Row,
  sessions: Row[],
  breaks: Row[],
  lastAuditId: number | null,
): AdminEntry {
  return {
    id: row.id,
    franchiseId: row.franchiseid,
    tutorId: row.tutorid,
    workDate:
      row.work_date instanceof Date
        ? row.work_date.toISOString().slice(0, 10)
        : row.work_date,
    timezone: row.timezone,
    status: row.status,
    clockState: row.clock_state ?? 0,
    scheduleSnapshot: row.schedule_snapshot ?? null,
    comparison: row.comparison ?? null,
    submittedAt: nullableIso(row.submitted_at),
    decidedBy: row.decided_by ?? null,
    decidedAt: nullableIso(row.decided_at),
    decisionReason: row.decision_reason ?? null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    lastAuditId,
    sessions: sessions.map((s) => ({
      id: s.id,
      startAt: iso(s.start_at),
      endAt: nullableIso(s.end_at),
      sortOrder: s.sort_order,
      createdAt: iso(s.created_at),
      updatedAt: iso(s.updated_at),
    })),
    breaks: breaks.map((b) => ({
      id: b.id,
      sessionId: b.time_entry_session_id ?? null,
      breakType: b.break_type,
      payTreatment: b.pay_treatment,
      status: b.status,
      source: b.source,
      startTime: nullableIso(b.start_time),
      endTime: nullableIso(b.end_time),
      durationMinutes: b.duration_minutes,
      note: b.note ?? null,
      createdAt: iso(b.created_at),
      updatedAt: iso(b.updated_at),
    })),
  };
}
async function readChildren(client: PoolClient, row: Row): Promise<AdminEntry> {
  const sessions = await client.query(
    `SELECT ${sessionColumns} FROM public.time_entry_sessions WHERE entry_day_id=$1 ORDER BY sort_order,time_entry_sessions.start_at,id`,
    [row.id],
  );
  const breaks = await client.query(
    `SELECT ${breakColumns} FROM public.time_entry_breaks WHERE entry_day_id=$1 ORDER BY id`,
    [row.id],
  );
  const audit = await client.query(
    'SELECT id FROM public.time_entry_audit WHERE entry_day_id=$1 ORDER BY id DESC LIMIT 1',
    [row.id],
  );
  return mapEntry(row, sessions.rows, breaks.rows, audit.rows[0]?.id ?? null);
}
export async function readEntry(
  client: PoolClient,
  key: EntryKey,
  lock: boolean,
): Promise<AdminEntry | null> {
  const result = await client.query(
    `SELECT ${dayColumns} FROM public.time_entry_days WHERE franchiseid=$1 AND tutorid=$2 AND work_date=$3${lock ? ' FOR UPDATE' : ''}`,
    [key.franchiseId, key.tutorId, key.workDate],
  );
  return result.rows[0] ? readChildren(client, result.rows[0]) : null;
}
export async function readEntryById(
  client: PoolClient,
  franchiseId: number,
  dayId: number,
  lock: boolean,
): Promise<AdminEntry | null> {
  const result = await client.query(
    `SELECT ${dayColumns} FROM public.time_entry_days WHERE franchiseid=$1 AND id=$2${lock ? ' FOR UPDATE' : ''}`,
    [franchiseId, dayId],
  );
  return result.rows[0] ? readChildren(client, result.rows[0]) : null;
}
export async function consistentRead<T>(
  pool: Pool,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
export function createAdminRepository(
  deps: {
    pool?: () => Pool;
    directory?: ReturnType<typeof createAdminDirectory>;
    timezone?: (key: EntryKey) => Promise<string>;
  } = {},
) {
  const pool = deps.pool ?? getPostgresPool,
    directory = deps.directory ?? createAdminDirectory({ pool });
  const detail = async (
    key: EntryKey,
    day: AdminEntry | null,
  ): Promise<AdminTimeEntryDetail> => {
    const tutor = await directory.resolveTutor(
      key.franchiseId,
      key.tutorId,
      day !== null,
    );
    const timezone: string =
      day?.timezone ??
      (await (deps.timezone
        ? deps.timezone(key)
        : resolvePayPeriod(key.franchiseId, key.workDate).then(
            (p) => p.timezone,
          )));
    return {
      franchiseId: key.franchiseId,
      tutor,
      workDate: key.workDate,
      timezone,
      day,
      revision: revisionForEntry(day),
      allowedActions: allowedAdminTimeEntryActions(day, tutor.active),
      totals: entrySummary(day),
    };
  };
  return {
    getAdminDetail: async (key: EntryKey) =>
      detail(
        key,
        await consistentRead(pool(), (client) => readEntry(client, key, false)),
      ),
    getAdminDetailById: async (franchiseId: number, dayId: number) => {
      const day = await consistentRead(pool(), (client) =>
        readEntryById(client, franchiseId, dayId, false),
      );
      if (!day)
        throw new AdminTimeEntryError('NOT_FOUND', 'Entry not found', 404);
      return detail(
        { franchiseId, tutorId: day.tutorId, workDate: day.workDate },
        day,
      );
    },
    listAdminDays: async (filters: DayFilters): Promise<Page<DayListItem>> => {
      validateDayFilters(filters);
      const scope = {
        franchiseId: filters.franchiseId,
        start: filters.start,
        end: filters.end,
        tutorId: filters.tutorId ?? null,
        status: filters.status ?? 'all',
      };
      const tuple = filters.cursor ? decodeCursor(filters.cursor, scope) : null;
      if (
        tuple &&
        (tuple.length !== 3 ||
          typeof tuple[0] !== 'string' ||
          !Number.isSafeInteger(tuple[1]) ||
          !Number.isSafeInteger(tuple[2]))
      )
        invalid('Invalid cursor');
      const entries = await consistentRead(pool(), async (client) => {
        const rows = (
          await client.query(
            `SELECT ${dayColumns} FROM public.time_entry_days WHERE franchiseid=$1 AND work_date BETWEEN $2 AND $3 AND ($4::integer IS NULL OR tutorid=$4) AND ($5='all' OR status=$5) AND ($6::date IS NULL OR work_date<$6 OR (work_date=$6 AND tutorid>$7) OR (work_date=$6 AND tutorid=$7 AND id<$8)) ORDER BY work_date DESC,tutorid ASC,id DESC LIMIT $9`,
            [
              filters.franchiseId,
              filters.start,
              filters.end,
              filters.tutorId ?? null,
              filters.status ?? 'all',
              tuple?.[0] ?? null,
              tuple?.[1] ?? null,
              tuple?.[2] ?? null,
              filters.limit + 1,
            ],
          )
        ).rows;
        if (!rows.length) return [];
        const ids = rows.map((r) => r.id);
        const sessions = (
          await client.query(
            `SELECT ${sessionColumns} FROM public.time_entry_sessions WHERE entry_day_id=ANY($1::int[]) ORDER BY sort_order,time_entry_sessions.start_at,id`,
            [ids],
          )
        ).rows;
        const breaks = (
          await client.query(
            `SELECT ${breakColumns} FROM public.time_entry_breaks WHERE entry_day_id=ANY($1::int[]) ORDER BY id`,
            [ids],
          )
        ).rows;
        return rows.map((r) =>
          mapEntry(
            r,
            sessions.filter((s) => s.entry_day_id === r.id),
            breaks.filter((b) => b.entry_day_id === r.id),
            null,
          ),
        );
      });
      const names = await directory.identitiesForHistory(
        filters.franchiseId,
        entries.map((e) => e.tutorId),
      );
      const visible = entries.slice(0, filters.limit);
      const last = visible[visible.length - 1];
      return {
        items: visible.map((e) => ({
          id: e.id,
          tutorId: e.tutorId,
          tutorName: names.get(e.tutorId)?.displayName ?? `Tutor #${e.tutorId}`,
          workDate: e.workDate,
          timezone: e.timezone,
          status: e.status,
          inProgress:
            e.clockState === 1 ||
            e.sessions.some((s) => s.endAt === null) ||
            e.breaks.some((b) => b.status === 'active'),
          totals: entrySummary(e),
        })),
        nextCursor:
          entries.length > filters.limit && last
            ? encodeCursor(scope, [last.workDate, last.tutorId, last.id])
            : null,
      };
    },
    readHistory: async (
      franchiseId: number,
      dayId: number,
      beforeId: number | null,
      limit: number,
    ): Promise<Page<AuditItem>> => {
      positiveId(franchiseId, 'franchiseId');
      positiveId(dayId, 'dayId');
      if (beforeId !== null) positiveId(beforeId, 'beforeId');
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        invalid('Invalid history limit');
      return consistentRead(pool(), async (client) => {
        const parent = await client.query(
          'SELECT id FROM public.time_entry_days WHERE franchiseid=$1 AND id=$2',
          [franchiseId, dayId],
        );
        if (!parent.rows.length)
          throw new AdminTimeEntryError('NOT_FOUND', 'Entry not found', 404);
        const rows = (
          await client.query(
            'SELECT * FROM public.time_entry_audit WHERE entry_day_id=$1 AND ($2::integer IS NULL OR id<$2) ORDER BY id DESC LIMIT $3',
            [dayId, beforeId, limit + 1],
          )
        ).rows;
        const items = rows.slice(0, limit).map((r) => ({
          id: r.id,
          action: r.action,
          actorAccountId: r.actor_account_id,
          actorAccountType: r.actor_account_type,
          at: iso(r.at),
          reason: r.metadata?.reason ?? null,
          metadata: r.metadata,
        }));
        return {
          items,
          nextCursor:
            rows.length > limit ? String(items[items.length - 1].id) : null,
        };
      });
    },
  };
}
const defaultRepository = createAdminRepository();
export const getAdminDetail = defaultRepository.getAdminDetail;
export const getAdminDetailById = defaultRepository.getAdminDetailById;
export const listAdminDays = defaultRepository.listAdminDays;
export const readHistory = defaultRepository.readHistory;
export type StoredOperation = {
  commandHash: string;
  actorId: number;
  franchiseId: number;
  result: AdminOperationResult;
};
export async function findOperation(
  client: PoolClient,
  operationId: string,
): Promise<StoredOperation | null> {
  const row = (
    await client.query(
      'SELECT a.metadata,a.actor_account_id,d.franchiseid FROM public.time_entry_audit a JOIN public.time_entry_days d ON d.id=a.entry_day_id WHERE a.operation_id=$1',
      [operationId],
    )
  ).rows[0];
  return row
    ? {
        commandHash: row.metadata.commandHash,
        actorId: row.actor_account_id,
        franchiseId: row.franchiseid,
        result: row.metadata.result,
      }
    : null;
}
export async function createMissingDay(
  client: PoolClient,
  command: AdminCommand,
): Promise<number | null> {
  const result = await client.query(
    `INSERT INTO public.time_entry_days(franchiseid,tutorid,work_date,timezone,status,clock_state) VALUES($1,$2,$3,$4,'draft',0) ON CONFLICT(franchiseid,tutorid,work_date) DO NOTHING RETURNING id`,
    [
      command.actor.franchiseId,
      command.tutorId,
      command.workDate,
      command.timezone,
    ],
  );
  return result.rows[0]?.id ?? null;
}
export async function writeCorrectedChildren(
  client: PoolClient,
  day: AdminEntry,
  correction: NormalizedCorrection,
): Promise<void> {
  const finalSessions: Array<{ id: number; startAt: string; endAt: string }> =
    [];
  for (let i = 0; i < correction.sessions.length; i++) {
    const s = correction.sessions[i];
    if (s.id === null) {
      const inserted = await client.query(
        'INSERT INTO public.time_entry_sessions(entry_day_id,franchiseid,tutorid,start_at,end_at,sort_order) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
        [day.id, day.franchiseId, day.tutorId, s.startAt, s.endAt, i],
      );
      finalSessions.push({ ...s, id: inserted.rows[0].id });
    } else {
      const original = day.sessions.find((x) => x.id === s.id)!;
      if (
        original.startAt !== s.startAt ||
        original.endAt !== s.endAt ||
        original.sortOrder !== i
      )
        await client.query(
          'UPDATE public.time_entry_sessions SET start_at=$1,end_at=$2,sort_order=$3,updated_at=NOW() WHERE id=$4 AND entry_day_id=$5',
          [s.startAt, s.endAt, i, s.id, day.id],
        );
      finalSessions.push({ ...s, id: s.id });
    }
  }
  for (const b of correction.breaks) {
    const containing =
      b.startTime && b.endTime
        ? finalSessions.find(
            (s) =>
              Date.parse(b.startTime!) >= Date.parse(s.startAt) &&
              Date.parse(b.endTime!) <= Date.parse(s.endAt),
          )
        : undefined;
    const sessionId = containing?.id ?? null;
    if (b.id === null) {
      await client.query(
        `INSERT INTO public.time_entry_breaks(entry_day_id,time_entry_session_id,franchiseid,tutorid,start_time,end_time,duration_minutes,break_type,pay_treatment,source,status,note) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'manager',$10,$11)`,
        [
          day.id,
          sessionId,
          day.franchiseId,
          day.tutorId,
          b.startTime,
          b.endTime,
          b.durationMinutes,
          b.breakType,
          b.payTreatment,
          b.status,
          b.note,
        ],
      );
    } else {
      const original = day.breaks.find((x) => x.id === b.id)!;
      const changed =
        original.sessionId !== sessionId ||
        original.startTime !== b.startTime ||
        original.endTime !== b.endTime ||
        original.durationMinutes !== b.durationMinutes ||
        original.breakType !== b.breakType ||
        original.payTreatment !== b.payTreatment ||
        original.status !== b.status ||
        original.note !== b.note;
      if (changed)
        await client.query(
          'UPDATE public.time_entry_breaks SET time_entry_session_id=$1,start_time=$2,end_time=$3,duration_minutes=$4,break_type=$5,pay_treatment=$6,status=$7,note=$8,updated_at=NOW() WHERE id=$9 AND entry_day_id=$10',
          [
            sessionId,
            b.startTime,
            b.endTime,
            b.durationMinutes,
            b.breakType,
            b.payTreatment,
            b.status,
            b.note,
            b.id,
            day.id,
          ],
        );
    }
  }
  await client.query(
    'DELETE FROM public.time_entry_sessions WHERE entry_day_id=$1 AND NOT(id=ANY($2::int[]))',
    [day.id, finalSessions.map((s) => s.id)],
  );
}
export async function writeApprovedDay(
  client: PoolClient,
  dayId: number,
  command: AdminCommand,
): Promise<void> {
  const snapshot = parseScheduleSnapshotV1(command.scheduleSnapshot);
  const computed =
    snapshot && command.scheduleSource !== 'unavailable'
      ? computeTimeEntryComparisonV2({
          sessions: command.correction!.sessions,
          breaks: command.correction!.breaks,
          snapshotIntervals: snapshot.intervals,
          computedAt: command.issuedAt,
        })
      : null;
  const comparison = computed?.ok ? computed.comparison : null;
  const result = await client.query(
    `UPDATE public.time_entry_days SET status='approved',clock_state=0,schedule_snapshot=$1,comparison=$2,submitted_at=COALESCE(submitted_at,NOW()),decided_by=$3,decided_at=NOW(),decision_reason=$4,updated_at=NOW() WHERE id=$5 AND franchiseid=$6 AND status IN ('draft','pending','approved')`,
    [
      command.scheduleSnapshot,
      comparison,
      command.actor.accountId,
      command.reason,
      dayId,
      command.actor.franchiseId,
    ],
  );
  if (result.rowCount !== 1)
    throw new AdminTimeEntryError(
      'INVALID_ENTRY_STATE',
      'Entry state cannot be corrected',
      409,
    );
}
export async function writeDayStatus(
  client: PoolClient,
  dayId: number,
  status: 'approved' | 'voided',
): Promise<void> {
  const expected = status === 'voided' ? 'approved' : 'voided';
  const result = await client.query(
    'UPDATE public.time_entry_days SET status=$1,updated_at=NOW() WHERE id=$2 AND status=$3 AND clock_state=0',
    [status, dayId, expected],
  );
  if (result.rowCount !== 1)
    throw new AdminTimeEntryError(
      'INVALID_ENTRY_STATE',
      'Entry state does not allow this action',
      409,
    );
}
export async function appendOperationAudit(
  client: PoolClient,
  operationId: string,
  commandHash: string,
  command: AdminCommand,
  before: AdminEntry | null,
  after: AdminEntry,
): Promise<AdminOperationResult> {
  const action = {
    correct: 'admin_corrected_approved',
    void: 'admin_voided',
    restore: 'admin_restored',
  }[command.action];
  const metadata = {
    version: 1,
    source: 'admin_time_entry',
    actor: command.actor,
    franchiseId: command.actor.franchiseId,
    tutorId: command.tutorId,
    workDate: command.workDate,
    timezone: command.timezone,
    reason: command.reason,
    commandHash,
    before,
    after,
    scheduleSource: command.scheduleSource,
    previousApproval: before
      ? {
          decidedBy: before.decidedBy,
          decidedAt: before.decidedAt,
          decisionReason: before.decisionReason,
        }
      : null,
  };
  const row = (
    await client.query(
      `INSERT INTO public.time_entry_audit(entry_day_id,action,actor_account_type,actor_account_id,previous_status,new_status,metadata,operation_id) VALUES($1,$2,'ADMIN',$3,$4,$5,$6,$7) RETURNING id,at`,
      [
        after.id,
        action,
        command.actor.accountId,
        before?.status ?? null,
        after.status,
        metadata,
        operationId,
      ],
    )
  ).rows[0];
  const result: AdminOperationResult = {
    operationId,
    auditId: row.id,
    action: command.action,
    entryId: after.id,
    status: after.status as 'approved' | 'voided',
    committedAt: iso(row.at),
    before: command.before,
    after: command.after,
  };
  await client.query(
    'UPDATE public.time_entry_audit SET metadata=$1 WHERE id=$2 AND operation_id=$3',
    [
      { ...metadata, after: { ...after, lastAuditId: row.id }, result },
      row.id,
      operationId,
    ],
  );
  return result;
}
export async function assertRestoreSnapshot(
  client: PoolClient,
  day: AdminEntry,
): Promise<void> {
  const row = (
    await client.query(
      `SELECT metadata FROM public.time_entry_audit WHERE entry_day_id=$1 AND action='admin_voided' ORDER BY id DESC LIMIT 1`,
      [day.id],
    )
  ).rows[0];
  const preserved = row?.metadata?.after as AdminEntry | undefined;
  if (
    !preserved ||
    preserved.id !== day.id ||
    preserved.franchiseId !== day.franchiseId ||
    preserved.tutorId !== day.tutorId ||
    preserved.workDate !== day.workDate ||
    preserved.timezone !== day.timezone ||
    canonicalJsonStringify(preserved.sessions) !==
      canonicalJsonStringify(day.sessions) ||
    canonicalJsonStringify(preserved.breaks) !==
      canonicalJsonStringify(day.breaks) ||
    preserved.decidedBy !== day.decidedBy ||
    preserved.decidedAt !== day.decidedAt ||
    preserved.decisionReason !== day.decisionReason ||
    preserved.submittedAt !== day.submittedAt ||
    canonicalJsonStringify(preserved.scheduleSnapshot) !==
      canonicalJsonStringify(day.scheduleSnapshot) ||
    canonicalJsonStringify(preserved.comparison) !==
      canonicalJsonStringify(day.comparison)
  )
    throw new AdminTimeEntryError(
      'ENTRY_CHANGED',
      'Preserved entry changed after voiding; reload the entry',
      409,
    );
}
