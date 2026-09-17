import { createHash } from 'node:crypto';
import { DateTime } from 'luxon';
import type { TimeEntryDayRow } from '../services/clockOutFinalization';
import type { TimeEntryBreakRow } from '../services/timeEntryBreaks';
import { computeTimeEntryComparisonV2, parseTimestamptzMinute, type TimeEntryComparisonV2 } from '../services/timeEntryComparison';
import { resolveClockInStartAt } from '../services/clockInTimeSnap';
import { canonicalJsonStringify, parseScheduleSnapshotV1 } from '../services/scheduleSnapshot';

// Intentionally fixed: this maintenance operation cannot be broadened with CLI flags.
const scope = {
  operation: 'clock-out-snap-2026-09-01-through-2026-09-15-v1',
  franchiseIds: [6, 11, 16, 60, 110, 57, 103],
  startDate: '2026-09-01',
  endDate: '2026-09-15'
};

export type ClockOutSnapBundle = {
  day: TimeEntryDayRow;
  sessions: Array<{
    id: number; franchiseid: number; tutorid: number;
    start_at: string; end_at: string | null; updated_at: string;
  }>;
  breaks: TimeEntryBreakRow[];
  audits: Array<{
    id: number; action: string; actor_account_type: string; at: string;
    metadata: Record<string, unknown>;
  }>;
};

type Change = { sessionId: number; auditId: number; beforeEndAt: string; afterEndAt: string };
export type ClockOutSnapPlan =
  | { kind: 'skip'; reason: string }
  | {
    kind: 'change'; changes: Change[]; previousStatus: string; nextStatus: string;
    beforeComparison: TimeEntryComparisonV2; comparison: TimeEntryComparisonV2;
  };

export type BackfillClient = {
  query(sql: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
};
export type BackfillArgs = { apply: boolean; expectedToken?: string };

export const buildClockOutSnapPlan = (bundle: ClockOutSnapBundle): ClockOutSnapPlan => {
  const { day, sessions, breaks, audits } = bundle;
  const skip = (reason: string): ClockOutSnapPlan => ({ kind: 'skip', reason });
  if (!scope.franchiseIds.includes(day.franchiseid) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(day.work_date) ||
      day.work_date < scope.startDate || day.work_date > scope.endDate) return skip('outside_scope');
  if (!day.submitted_at && !audits.some((a) => ['submitted', 'auto_approved'].includes(a.action))) {
    return skip('no_submission');
  }
  if (day.clock_state !== 0 || !sessions.length || sessions.some((s) => !s.end_at) ||
      breaks.some((b) => b.status === 'active')) return skip('open_or_empty_day');
  if (sessions.some((s) => s.franchiseid !== day.franchiseid || s.tutorid !== day.tutorid) ||
      breaks.some((b) => b.franchiseid !== day.franchiseid || b.tutorid !== day.tutorid)) {
    return skip('scope_mismatch');
  }
  const snapshot = parseScheduleSnapshotV1(day.schedule_snapshot);
  if (!snapshot || snapshot.franchiseId !== day.franchiseid || snapshot.tutorId !== day.tutorid ||
      snapshot.workDate !== day.work_date || snapshot.timezone !== day.timezone) {
    return skip('missing_or_mismatched_snapshot');
  }
  const nextMidnight = DateTime.fromISO(day.work_date, { zone: day.timezone }).plus({ days: 1 }).startOf('day');
  if (!nextMidnight.isValid) return skip('invalid_work_date_or_timezone');

  const changes: Change[] = [];
  for (const session of sessions) {
    const start = parseTimestamptzMinute(session.start_at);
    const end = parseTimestamptzMinute(session.end_at);
    if (!start || !end) return skip('invalid_session_timestamp');
    const audit = audits.filter((a) => a.action === 'clock_out' &&
      Number(a.metadata.sessionId) === session.id).sort((a, b) => b.id - a.id)[0];
    if (!audit || audit.actor_account_type !== 'TUTOR' ||
        (audit.metadata.source ?? 'clock_out') !== 'clock_out' || audit.metadata.timeSnapApplied === true) continue;
    if (parseTimestamptzMinute(audit.metadata.startedAt) !== start ||
        parseTimestamptzMinute(audit.metadata.endedAt) !== end ||
        !Number.isFinite(Date.parse(session.updated_at)) || !Number.isFinite(Date.parse(audit.at)) ||
        Date.parse(session.updated_at) > Date.parse(audit.at)) continue;
    // Require evidence of an actual, unsnapped clock-out; do not reinterpret edited times.
    const detected = typeof audit.metadata.detectedAt === 'string' ? new Date(audit.metadata.detectedAt) : null;
    if (!detected || !Number.isFinite(detected.getTime())) continue;
    const rounded = resolveClockInStartAt({ detectedAt: detected, enabled: true });
    if (Date.parse(rounded.detectedAt) !== Date.parse(end) || !rounded.timeSnapApplied) continue;
    if (Date.parse(rounded.startAt) <= Date.parse(start)) return skip('rounding_would_make_nonpositive_session');
    if (Date.parse(rounded.startAt) > Date.parse(end) && Date.parse(rounded.startAt) > nextMidnight.toMillis()) {
      return skip('cross_day_round_up_requires_manual_review');
    }
    changes.push({ sessionId: session.id, auditId: audit.id, beforeEndAt: session.end_at!, afterEndAt: rounded.startAt });
  }
  if (!changes.length) return skip('no_unchanged_unsnapped_manual_clock_outs');

  const original = sessions.map((s) => ({ startAt: s.start_at, endAt: s.end_at! }));
  const updated = sessions.map((s) => ({
    startAt: s.start_at, endAt: changes.find((c) => c.sessionId === s.id)?.afterEndAt ?? s.end_at!
  }));
  const sorted = updated.slice().sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
  if (sorted.some((s, i) => i > 0 && Date.parse(s.startAt) < Date.parse(sorted[i - 1].endAt))) {
    return skip('overlapping_sessions');
  }
  const comparisonArgs = {
    snapshotIntervals: snapshot.intervals,
    breaks: breaks.map((b) => ({
      payTreatment: b.pay_treatment, status: b.status, startTime: b.start_time,
      endTime: b.end_time, durationMinutes: Number(b.duration_minutes)
    }))
  };
  const before = computeTimeEntryComparisonV2({ ...comparisonArgs, sessions: original });
  const after = computeTimeEntryComparisonV2({ ...comparisonArgs, sessions: updated });
  if (!before.ok || !after.ok) return skip('invalid_comparison');
  const cutsBreak = changes.some((change) => breaks.some((b) => {
    if (b.status !== 'completed') return false;
    const breakStart = b.start_time instanceof Date ? b.start_time.getTime() : Date.parse(b.start_time ?? '');
    const breakEnd = b.end_time instanceof Date ? b.end_time.getTime() : Date.parse(b.end_time ?? '');
    // Check each removed interval independently; extending a different session must not mask a cut.
    return Math.max(Date.parse(change.afterEndAt), breakStart) <
      Math.min(Date.parse(change.beforeEndAt), breakEnd);
  }));
  if (cutsBreak) {
    return skip('rounding_would_cut_through_break');
  }
  return {
    kind: 'change', changes, previousStatus: day.status, nextStatus: day.status,
    beforeComparison: before.comparison, comparison: after.comparison
  };
};

export const parseBackfillArgs = (argv: string[]): BackfillArgs => {
  const args: BackfillArgs = { apply: false };
  for (const arg of argv) {
    if (arg === '--apply') args.apply = true;
    else if (arg.startsWith('--expected-token=')) args.expectedToken = arg.slice('--expected-token='.length);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (args.apply && !/^[a-f0-9]{64}$/.test(args.expectedToken ?? '')) {
    throw new Error('--apply requires --expected-token=<reviewToken from a fresh preview>');
  }
  if (!args.apply && args.expectedToken) throw new Error('--expected-token requires --apply');
  return args;
};

export const requireNeonUrl = (value: string): string => {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('A valid Neon Postgres URL is required'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname.endsWith('.neon.tech') ||
      ['host', 'hostaddr', 'port', 'ssl', 'uselibpqcompat'].some((key) => url.searchParams.has(key))) {
    throw new Error('Only a Neon Postgres URL without host or TLS overrides is allowed');
  }
  url.searchParams.set('sslmode', 'verify-full');
  return url.toString();
};

const scopeFilter = `d.franchiseid = ANY($1::int[])
  AND d.work_date BETWEEN $2::date AND $3::date
  AND (d.submitted_at IS NOT NULL OR EXISTS (
    SELECT 1 FROM public.time_entry_audit submitted
    WHERE submitted.entry_day_id = d.id AND submitted.action IN ('submitted', 'auto_approved')
  ))`;

export const runClockOutSnapBackfill = async (client: BackfillClient, args: BackfillArgs) => {
  if (args.apply && !/^[a-f0-9]{64}$/.test(args.expectedToken ?? '')) {
    throw new Error('Apply requires a preview token');
  }
  const values = [scope.franchiseIds, scope.startDate, scope.endDate];
  await client.query(args.apply ? 'BEGIN ISOLATION LEVEL SERIALIZABLE' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    if (args.apply) {
      // Match the app's lock order: parent days, then their sessions and breaks.
      await client.query(`SELECT d.id FROM public.time_entry_days d WHERE ${scopeFilter} ORDER BY d.id FOR UPDATE OF d`, values);
      await client.query(`SELECT s.id FROM public.time_entry_sessions s JOIN public.time_entry_days d ON d.id = s.entry_day_id
        WHERE ${scopeFilter} ORDER BY s.id FOR UPDATE OF s`, values);
      await client.query(`SELECT b.id FROM public.time_entry_breaks b JOIN public.time_entry_days d ON d.id = b.entry_day_id
        WHERE ${scopeFilter} ORDER BY b.id FOR UPDATE OF b`, values);
    }
    const result = await client.query(`SELECT to_jsonb(d) AS day,
      COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM public.time_entry_sessions s WHERE s.entry_day_id = d.id), '[]'::jsonb) AS sessions,
      COALESCE((SELECT jsonb_agg(to_jsonb(b) ORDER BY b.id) FROM public.time_entry_breaks b WHERE b.entry_day_id = d.id), '[]'::jsonb) AS breaks,
      COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM public.time_entry_audit a WHERE a.entry_day_id = d.id), '[]'::jsonb) AS audits
      FROM public.time_entry_days d WHERE ${scopeFilter} ORDER BY d.id`, values);
    const bundles = result.rows as ClockOutSnapBundle[];
    const reviewToken = createHash('sha256').update(canonicalJsonStringify({ scope, bundles })).digest('hex');
    if (args.apply && args.expectedToken !== reviewToken) {
      throw new Error('Data differs from the reviewed preview. Run and review a fresh preview before applying.');
    }
    const planned = bundles.map((bundle) => ({ bundle, plan: buildClockOutSnapPlan(bundle) }));
    let changedDays = 0;
    let changedSessions = 0;
    let paidMinuteDelta = 0;
    for (const { bundle, plan } of planned) {
      if (plan.kind !== 'change') continue;
      changedDays += 1;
      changedSessions += plan.changes.length;
      paidMinuteDelta += plan.comparison.manual.paidMinutes - plan.beforeComparison.manual.paidMinutes;
      if (!args.apply) continue;
      for (const change of plan.changes) {
        const session = bundle.sessions.find((s) => s.id === change.sessionId)!;
        const updated = await client.query(`UPDATE public.time_entry_sessions
          SET end_at = $1, updated_at = NOW()
          WHERE id = $2 AND entry_day_id = $3 AND franchiseid = $4 AND tutorid = $5
            AND start_at = $6::timestamptz AND end_at = $7::timestamptz AND updated_at = $8::timestamptz`,
        [change.afterEndAt, session.id, bundle.day.id, bundle.day.franchiseid, bundle.day.tutorid,
          session.start_at, change.beforeEndAt, session.updated_at]);
        if (updated.rowCount !== 1) throw new Error(`Session ${session.id} changed; rolling back`);
      }
      // Preserve status, submission date, and all human/automatic decision fields.
      const updatedDay = await client.query(`UPDATE public.time_entry_days SET comparison = $1, updated_at = NOW()
        WHERE id = $2 AND franchiseid = $3 AND updated_at = $4::timestamptz`,
      [plan.comparison, bundle.day.id, bundle.day.franchiseid, bundle.day.updated_at]);
      if (updatedDay.rowCount !== 1) throw new Error(`Day ${bundle.day.id} changed; rolling back`);
      const audit = await client.query(`INSERT INTO public.time_entry_audit
        (entry_day_id, action, actor_account_type, actor_account_id, at, previous_status, new_status, metadata)
        VALUES ($1, $2, 'SYSTEM', NULL, NOW(), $3, $3, $4)`,
      [bundle.day.id, 'clock_out_snap_backfill', bundle.day.status, {
        operation: scope.operation, reviewToken, workDate: bundle.day.work_date,
        timezone: bundle.day.timezone, changes: plan.changes,
        beforeDay: bundle.day, beforeSessions: bundle.sessions,
        beforeComparison: plan.beforeComparison, comparison: plan.comparison,
        reason: 'Apply missing quarter-hour clock-out snapping; preserve existing status and decisions'
      }]);
      if (audit.rowCount !== 1) throw new Error(`Audit for day ${bundle.day.id} was not written; rolling back`);
    }
    await client.query(args.apply ? 'COMMIT' : 'ROLLBACK');
    return {
      mode: args.apply ? 'applied' : 'preview', scope, reviewToken,
      scannedDays: bundles.length, changedDays, changedSessions, paidMinuteDelta,
      days: planned.map(({ bundle, plan }) => ({
        dayId: bundle.day.id, franchiseId: bundle.day.franchiseid, tutorId: bundle.day.tutorid,
        workDate: bundle.day.work_date, timezone: bundle.day.timezone, status: bundle.day.status,
        ...(plan.kind === 'skip' ? { outcome: 'skip', reason: plan.reason } : {
          outcome: 'change', statusAfter: plan.nextStatus, changes: plan.changes,
          beforePaidMinutes: plan.beforeComparison.manual.paidMinutes,
          afterPaidMinutes: plan.comparison.manual.paidMinutes,
          scheduleMatchesBefore: plan.beforeComparison.matches,
          scheduleMatchesAfter: plan.comparison.matches
        })
      }))
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
};

const main = async (): Promise<void> => {
  const args = parseBackfillArgs(process.argv.slice(2));
  // No environment loading or connection occurs when this file is imported by offline tests.
  const dotenv = await import('dotenv');
  dotenv.config();
  const connectionString = requireNeonUrl(process.env.POSTGRES_URL || process.env.DATABASE_URL || '');
  const { Client } = await import('pg');
  const client = new Client({ connectionString, connectionTimeoutMillis: 10000,
    application_name: 'clock_out_snap_backfill' });
  try {
    await client.connect();
    const report = await runClockOutSnapBackfill(client, args);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await client.end();
  }
};

if (require.main === module) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Backfill failed';
    console.error(message.replace(/postgres(?:ql)?:\/\/\S+/gi, '[REDACTED]'));
    process.exitCode = 1;
  });
}
