import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildClockOutSnapPlan, parseBackfillArgs, requireNeonUrl, runClockOutSnapBackfill,
  type ClockOutSnapBundle, type BackfillClient
} from '../scripts/backfillClockOutSnaps';

const fixture = (): ClockOutSnapBundle => ({
  day: {
    id: 1, franchiseid: 60, tutorid: 42, work_date: '2026-09-15', timezone: 'UTC',
    status: 'approved', clock_state: 0, submitted_at: '2026-09-15T18:02:25.000Z',
    decided_by: 9, decided_at: '2026-09-15T19:00:00.000Z', decision_reason: 'Reviewed',
    created_at: '2026-09-15T14:00:00.000Z', updated_at: '2026-09-15T19:00:00.000Z',
    comparison: null,
    schedule_snapshot: {
      version: 1, franchiseId: 60, tutorId: 42, workDate: '2026-09-15', timezone: 'UTC',
      slotMinutes: 60, entries: [],
      intervals: [{ startAt: '2026-09-15T14:00:00.000Z', endAt: '2026-09-15T18:00:00.000Z' }]
    }
  },
  sessions: [{
    id: 10, franchiseid: 60, tutorid: 42, start_at: '2026-09-15T14:00:00.000Z',
    end_at: '2026-09-15T18:02:00.000Z', updated_at: '2026-09-15T18:02:25.000Z'
  }],
  breaks: [],
  audits: [{
    id: 100, action: 'clock_out', actor_account_type: 'TUTOR', at: '2026-09-15T18:02:25.000Z',
    metadata: {
      source: 'clock_out', sessionId: 10, startedAt: '2026-09-15T14:00:00.000Z',
      endedAt: '2026-09-15T18:02:00.000Z', detectedAt: '2026-09-15T18:02:25.000Z'
    }
  }]
});

test('backfill corrects submitted days of every status and recalculates paid minutes', () => {
  for (const status of ['approved', 'pending', 'denied', 'draft'] as const) {
    const bundle = fixture();
    bundle.day.status = status;
    const plan = buildClockOutSnapPlan(bundle);
    assert.equal(plan.kind, 'change');
    assert.equal(plan.changes[0].afterEndAt, '2026-09-15T18:00:00.000Z');
    assert.equal(plan.beforeComparison.manual.paidMinutes, 242);
    assert.equal(plan.comparison.manual.paidMinutes, 240);
    assert.equal(plan.nextStatus, status);
    assert.equal(plan.previousStatus, status);
  }
});

test('franchise and inclusive work-date scope cannot expand through the input rows', () => {
  for (const [franchise, date, allowed] of [
    [6, '2026-09-01', true], [11, '2026-09-15', true], [15, '2026-09-10', false],
    [16, '2026-09-10', true], [60, '2026-09-10', true], [110, '2026-09-10', true],
    [57, '2026-09-10', true], [103, '2026-09-10', true], [7, '2026-09-10', false],
    [60, '2026-08-31', false], [60, '2026-09-16', false]
  ] as const) {
    const bundle = fixture();
    bundle.day.franchiseid = franchise;
    bundle.day.work_date = date;
    bundle.sessions[0].franchiseid = franchise;
    Object.assign(bundle.day.schedule_snapshot as object, { franchiseId: franchise, workDate: date });
    assert.equal(buildClockOutSnapPlan(bundle).kind, allowed ? 'change' : 'skip');
  }
});

test('submission evidence is required but a historical submission audit is sufficient', () => {
  const bundle = fixture();
  bundle.day.submitted_at = null;
  assert.equal(buildClockOutSnapPlan(bundle).kind, 'skip');
  bundle.audits.push({ id: 101, action: 'submitted', actor_account_type: 'SYSTEM',
    at: '2026-09-15T18:02:25.000Z', metadata: {} });
  assert.equal(buildClockOutSnapPlan(bundle).kind, 'change');
});

test('manual edits, auto clock-outs, open sessions, and missing snapshots are skipped', () => {
  const changes: Array<(bundle: ClockOutSnapBundle) => void> = [
    (b) => { b.sessions[0].end_at = '2026-09-15T18:04:00.000Z'; },
    (b) => { b.sessions[0].start_at = '2026-09-15T14:01:00.000Z'; },
    (b) => { b.sessions[0].updated_at = '2026-09-15T19:00:00.000Z'; },
    (b) => { b.sessions[0].id = 11; },
    (b) => { b.audits[0].metadata.source = 'auto_clock_out'; },
    (b) => { b.audits[0].actor_account_type = 'SYSTEM'; },
    (b) => { b.audits[0].metadata.timeSnapApplied = true; },
    (b) => { b.sessions[0].end_at = null; },
    (b) => { b.day.clock_state = 1; },
    (b) => { b.day.schedule_snapshot = null; },
    (b) => { (b.day.schedule_snapshot as { tutorId: number }).tutorId = 99; }
  ];
  for (const change of changes) {
    const bundle = fixture();
    change(bundle);
    assert.equal(buildClockOutSnapPlan(bundle).kind, 'skip');
  }
});

test('rounding up, midnight, already-rounded ends, and zero-length shifts are handled', () => {
  for (const [start, end, expected] of [
    ['14:00', '18:08', '2026-09-15T18:15:00.000Z'],
    ['14:00', '23:53', '2026-09-16T00:00:00.000Z'],
    ['14:00', '18:00', null], ['18:00', '18:02', null]
  ] as const) {
    const bundle = fixture();
    bundle.sessions[0].start_at = `2026-09-15T${start}:00.000Z`;
    bundle.sessions[0].end_at = `2026-09-15T${end}:00.000Z`;
    bundle.sessions[0].updated_at = bundle.sessions[0].end_at;
    bundle.audits[0].at = bundle.sessions[0].end_at;
    Object.assign(bundle.audits[0].metadata, {
      startedAt: bundle.sessions[0].start_at, endedAt: bundle.sessions[0].end_at,
      detectedAt: bundle.sessions[0].end_at
    });
    const plan = buildClockOutSnapPlan(bundle);
    assert.equal(plan.kind, expected ? 'change' : 'skip');
    if (plan.kind === 'change') assert.equal(plan.changes[0].afterEndAt, expected);
  }
});

test('rounding forward after local midnight is skipped without touching the following day', () => {
  for (const [timezone, end, allowed] of [
    ['UTC', '2026-09-16T00:08:00.000Z', false],
    ['America/Los_Angeles', '2026-09-16T07:08:00.000Z', false],
    ['America/Los_Angeles', '2026-09-16T06:53:00.000Z', true],
    ['America/Los_Angeles', '2026-09-16T07:17:00.000Z', true]
  ] as const) {
    const bundle = fixture();
    bundle.day.timezone = timezone;
    (bundle.day.schedule_snapshot as { timezone: string }).timezone = timezone;
    bundle.sessions[0].end_at = end;
    bundle.sessions[0].updated_at = end;
    bundle.audits[0].at = end;
    Object.assign(bundle.audits[0].metadata, { endedAt: end, detectedAt: end });
    assert.equal(buildClockOutSnapPlan(bundle).kind, allowed ? 'change' : 'skip');
  }
});

test('a correction cannot create a session overlap or cut through a completed break', () => {
  const overlap = fixture();
  overlap.sessions[0].end_at = '2026-09-15T18:08:00.000Z';
  overlap.sessions[0].updated_at = '2026-09-15T18:08:25.000Z';
  overlap.audits[0].at = overlap.sessions[0].updated_at;
  Object.assign(overlap.audits[0].metadata, {
    endedAt: overlap.sessions[0].end_at, detectedAt: overlap.sessions[0].updated_at
  });
  overlap.sessions.push({ ...overlap.sessions[0], id: 11,
    start_at: '2026-09-15T18:10:00.000Z', end_at: '2026-09-15T19:00:00.000Z' });
  assert.equal(buildClockOutSnapPlan(overlap).kind, 'skip');

  const withBreak = fixture();
  withBreak.breaks.push({
    id: 2, entry_day_id: 1, time_entry_session_id: 10, franchiseid: 60, tutorid: 42,
    break_type: 'lunch', pay_treatment: 'unpaid', source: 'employee', status: 'completed',
    start_time: '2026-09-15T17:32:00.000Z', end_time: '2026-09-15T18:01:00.000Z',
    duration_minutes: 29, note: null, created_at: '2026-09-15T17:32:00.000Z',
    updated_at: '2026-09-15T18:01:00.000Z'
  });
  assert.equal(buildClockOutSnapPlan(withBreak).kind, 'skip');
  withBreak.breaks[0].end_time = '2026-09-15T18:00:00.000Z';
  withBreak.breaks[0].duration_minutes = 28;
  const plan = buildClockOutSnapPlan(withBreak);
  assert.equal(plan.kind, 'change');
  if (plan.kind === 'change') assert.equal(plan.comparison.manual.paidMinutes, 212);
});

test('extending another session cannot hide a break cut off by rounding down', () => {
  const bundle = fixture();
  bundle.sessions.push({
    id: 11, franchiseid: 60, tutorid: 42, start_at: '2026-09-15T19:00:00.000Z',
    end_at: '2026-09-15T20:08:00.000Z', updated_at: '2026-09-15T20:08:25.000Z'
  });
  bundle.audits.push({
    id: 101, action: 'clock_out', actor_account_type: 'TUTOR', at: '2026-09-15T20:08:25.000Z',
    metadata: { source: 'clock_out', sessionId: 11, startedAt: '2026-09-15T19:00:00.000Z',
      endedAt: '2026-09-15T20:08:00.000Z', detectedAt: '2026-09-15T20:08:25.000Z' }
  });
  for (const [id, sessionId, start, end, duration] of [
    [2, 10, '17:32', '18:01', 29], [3, 11, '20:07', '20:09', 2]
  ] as const) {
    bundle.breaks.push({
      id, entry_day_id: 1, time_entry_session_id: sessionId, franchiseid: 60, tutorid: 42,
      break_type: 'lunch', pay_treatment: 'unpaid', source: 'employee', status: 'completed',
      start_time: `2026-09-15T${start}:00.000Z`, end_time: `2026-09-15T${end}:00.000Z`,
      duration_minutes: duration, note: null, created_at: `2026-09-15T${start}:00.000Z`,
      updated_at: `2026-09-15T${end}:00.000Z`
    });
  }
  assert.equal(buildClockOutSnapPlan(bundle).kind, 'skip');
});

const fakeClient = (bundles: ClockOutSnapBundle[], failAudit = false) => {
  const statements: Array<{ sql: string; values?: unknown[] }> = [];
  const client: BackfillClient = {
    async query(sql: string, values?: unknown[]) {
      statements.push({ sql, values });
      if (sql.includes('SELECT to_jsonb(d) AS day')) return { rows: bundles, rowCount: bundles.length };
      if (failAudit && sql.includes('INSERT INTO public.time_entry_audit')) throw new Error('audit failed');
      return { rows: [], rowCount: 1 };
    }
  };
  return { client, statements };
};

test('preview uses a read-only transaction and performs no writes', async () => {
  const fake = fakeClient([fixture()]);
  const report = await runClockOutSnapBackfill(fake.client, { apply: false });
  assert.equal(report.changedDays, 1);
  assert.match(report.reviewToken, /^[a-f0-9]{64}$/);
  assert.match(fake.statements[0].sql, /READ ONLY/);
  assert.equal(fake.statements.some(({ sql }) => /^\s*(UPDATE|INSERT|DELETE)/i.test(sql)), false);
  assert.equal(fake.statements[fake.statements.length - 1].sql, 'ROLLBACK');
});

test('apply requires the reviewed data, updates sessions and totals, and audits old decisions atomically', async () => {
  const preview = await runClockOutSnapBackfill(fakeClient([fixture()]).client, { apply: false });
  const fake = fakeClient([fixture()]);
  const report = await runClockOutSnapBackfill(fake.client, { apply: true, expectedToken: preview.reviewToken });
  assert.equal(report.changedDays, 1);
  assert.ok(fake.statements.some(({ sql, values }) => sql.includes('UPDATE public.time_entry_sessions') &&
    values?.[0] === '2026-09-15T18:00:00.000Z'));
  const dayUpdate = fake.statements.find(({ sql }) => sql.includes('UPDATE public.time_entry_days'));
  assert.ok(dayUpdate);
  assert.doesNotMatch(dayUpdate.sql, /\b(status|submitted_at|decided_by|decided_at|decision_reason|clock_state)\s*=/i);
  const audit = fake.statements.find(({ sql }) => sql.includes('INSERT INTO public.time_entry_audit'));
  assert.ok(audit);
  assert.match(JSON.stringify(audit.values), /Reviewed/);
  assert.match(JSON.stringify(audit.values), /clock_out_snap_backfill/);
  assert.equal(audit.values?.[2], 'approved');
  assert.equal(fake.statements[fake.statements.length - 1].sql, 'COMMIT');
});

test('stale preview or audit failure rolls back the complete apply', async () => {
  const preview = await runClockOutSnapBackfill(fakeClient([fixture()]).client, { apply: false });
  const changed = fixture();
  changed.day.decision_reason = 'Changed since preview';
  const stale = fakeClient([changed]);
  await assert.rejects(runClockOutSnapBackfill(stale.client, { apply: true, expectedToken: preview.reviewToken }), /preview/i);
  assert.equal(stale.statements.some(({ sql }) => /^\s*(UPDATE|INSERT)/i.test(sql)), false);
  const failing = fakeClient([fixture()], true);
  await assert.rejects(runClockOutSnapBackfill(failing.client, { apply: true, expectedToken: preview.reviewToken }), /audit failed/);
  assert.equal(failing.statements[failing.statements.length - 1].sql, 'ROLLBACK');
  assert.equal(failing.statements.some(({ sql }) => sql === 'COMMIT'), false);
});

test('a rerun does not snap the same session twice', () => {
  const bundle = fixture();
  bundle.sessions[0].end_at = '2026-09-15T18:00:00.000Z';
  bundle.sessions[0].updated_at = '2026-09-16T12:00:00.000Z';
  assert.equal(buildClockOutSnapPlan(bundle).kind, 'skip');
});

test('CLI defaults to preview and rejects unknown or incomplete apply arguments and non-Neon URLs', () => {
  assert.deepEqual(parseBackfillArgs([]), { apply: false });
  assert.throws(() => parseBackfillArgs(['--apply']), /token/i);
  assert.throws(() => parseBackfillArgs(['--franchiseId=99']), /Unknown/);
  assert.throws(() => requireNeonUrl('postgres://user:secret@localhost/db'), /Neon/);
  assert.throws(() => requireNeonUrl('postgres://user:secret@neon.tech.evil.test/db'), /Neon/);
  assert.throws(() => requireNeonUrl('postgres://user:secret@ep-example.neon.tech/db?host=localhost'), /Neon/);
  assert.equal(new URL(requireNeonUrl('postgres://user:secret@ep-example.neon.tech/db')).searchParams.get('sslmode'), 'verify-full');
});
