import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { Pool } from 'pg';
import { createPostgresPtoStore } from '../services/pto/postgresStore';
import { createPtoRouteStore } from '../services/pto/routeStore';

const enabled = process.env.RUN_PTO_POSTGRES_TESTS === '1';
const containerName = `timecard-pto-route-test-${process.pid}`;
const migration = (name: string) => readFileSync(path.resolve(__dirname, `../db/migrations/${name}`), 'utf8');
let pool: Pool | undefined;

const docker = (args: string[], timeout = 120_000) => execFileSync('docker', args, {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout
}).trim();

before(async () => {
  if (!enabled) return;
  docker(['run', '--detach', '--rm', '--name', containerName, '--env', 'POSTGRES_PASSWORD=pto_test_password',
    '--env', 'POSTGRES_DB=pto_test', '--publish', '127.0.0.1::5432', 'postgres:17-alpine']);
  const portOutput = docker(['port', containerName, '5432/tcp']);
  pool = new Pool({ host: '127.0.0.1', port: Number(portOutput.slice(portOutput.lastIndexOf(':') + 1)),
    database: 'pto_test', user: 'postgres', password: 'pto_test_password' });
  let error: unknown;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { await pool.query('SELECT 1'); return; } catch (candidate) { error = candidate; await new Promise((resolve) => setTimeout(resolve, 500)); }
  }
  throw error;
});

after(async () => {
  if (!enabled) return;
  await pool?.end();
  try { docker(['rm', '--force', containerName], 30_000); } catch { /* disposable */ }
});

test('disabled-center guard and deactivation preserve existing PTO lifecycle', { skip: !enabled }, async () => {
  const db = pool;
  assert.ok(db);
  await db.query(`
    CREATE TABLE public.time_off_requests (
      id BIGSERIAL PRIMARY KEY, franchiseid INTEGER NOT NULL, tutorid BIGINT, bridge_flag BOOLEAN,
      bridge_profile_id BIGINT, first_name TEXT, last_name TEXT, email TEXT,
      start_at TIMESTAMPTZ NOT NULL, end_at TIMESTAMPTZ NOT NULL, type TEXT NOT NULL,
      status TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), duration_hours NUMERIC,
      partial_day BOOLEAN, leave_time TIME, return_time TIME, public_metadata JSONB
    )
  `);
  await db.query(migration('0010_shared_pto.sql'));
  await db.query(migration('0011_pto_admin_invariants.sql'));
  const legacy = await db.query<{ id: string }>(`
    INSERT INTO public.time_off_requests
      (franchiseid, tutorid, first_name, last_name, email, start_at, end_at, type, status, duration_hours, partial_day, public_metadata)
    VALUES (44, 4401, 'Legacy', 'Tutor', 'legacy@example.com', '2026-08-17Z', '2026-08-18Z',
      'pto', 'pending', 24, FALSE, '{"startDate":"2026-08-17","endDate":"2026-08-17","source":"authenticated_timecard_app"}')
    RETURNING id
  `);
  await db.query(migration('0012_pto_routes.sql'));
  assert.equal((await db.query('SELECT COUNT(*)::INTEGER AS count FROM public.time_off_requests WHERE id = $1', [legacy.rows[0].id])).rows[0].count, 1);

  const insertDisabled = (source: 'authenticated_timecard_app' | 'public_timeoff_form') => db.query(`
    INSERT INTO public.time_off_requests
      (franchiseid, tutorid, first_name, last_name, email, start_at, end_at, type, status, duration_hours, partial_day, public_metadata)
    VALUES (44, $1, 'Blocked', 'Tutor', 'blocked@example.com', '2026-08-19Z', '2026-08-20Z',
      'pto', 'pending', 24, FALSE, JSONB_BUILD_OBJECT('startDate','2026-08-19','endDate','2026-08-19','source',$2::TEXT))
  `, [source === 'public_timeoff_form' ? null : 4401, source]);
  await assert.rejects(insertDisabled('authenticated_timecard_app'), /PTO_CENTER_DISABLED/);
  await assert.rejects(insertDisabled('public_timeoff_form'), /PTO_CENTER_DISABLED/);

  await db.query('INSERT INTO public.pto_center_settings (franchiseid, enabled) VALUES (44, TRUE)');
  const profile = await db.query<{ id: string }>(`
    INSERT INTO public.pto_profiles (first_name, last_name, identity_status) VALUES ('Active','Tutor','confirmed') RETURNING id
  `);
  await db.query("INSERT INTO public.pto_profile_crm_ids (profile_id, provider, crm_id) VALUES ($1, 'timecard-center:44', '4402')", [profile.rows[0].id]);
  const membership = await db.query<{ id: string }>(`
    INSERT INTO public.pto_profile_centers (profile_id, franchiseid, tutor_id, active) VALUES ($1,44,4402,TRUE) RETURNING id
  `, [profile.rows[0].id]);
  await db.query(`INSERT INTO public.pto_profile_emails
    (profile_id, franchiseid, email, active, source, source_membership_id)
    VALUES ($1,44,'active@example.com',TRUE,'crm',$2)`, [profile.rows[0].id, membership.rows[0].id]);
  const held = await db.query<{ id: string }>(`
    INSERT INTO public.time_off_requests
      (franchiseid, tutorid, first_name, last_name, email, start_at, end_at, type, status, duration_hours, partial_day, public_metadata)
    VALUES (44,4402,'Active','Tutor','active@example.com','2026-08-20Z','2026-08-21Z','pto','pending',24,FALSE,
      '{"startDate":"2026-08-20","endDate":"2026-08-20","source":"authenticated_timecard_app"}') RETURNING id
  `);
  const denied = await db.query<{ id: string }>(`
    INSERT INTO public.time_off_requests
      (franchiseid, tutorid, first_name, last_name, email, start_at, end_at, type, status, duration_hours, partial_day, public_metadata)
    VALUES (44,4402,'Active','Tutor','active@example.com','2026-08-21Z','2026-08-22Z','pto','pending',24,FALSE,
      '{"startDate":"2026-08-21","endDate":"2026-08-21","source":"authenticated_timecard_app"}') RETURNING id
  `);
  const cancelled = await db.query<{ id: string }>(`
    INSERT INTO public.time_off_requests
      (franchiseid, tutorid, first_name, last_name, email, start_at, end_at, type, status, duration_hours, partial_day, public_metadata)
    VALUES (44,4402,'Active','Tutor','active@example.com','2026-08-22Z','2026-08-23Z','pto','pending',24,FALSE,
      '{"startDate":"2026-08-22","endDate":"2026-08-22","source":"authenticated_timecard_app"}') RETURNING id
  `);
  const reservation = await db.query(`
    SELECT request.created_at, center.enabled, center.first_activated_at,
      (SELECT COUNT(*)::INTEGER FROM public.pto_request_allocations allocation
       WHERE allocation.request_id = request.id) AS allocation_count
    FROM public.time_off_requests request
    LEFT JOIN public.pto_center_settings center ON center.franchiseid = request.franchiseid
    WHERE request.id = $1
  `, [held.rows[0].id]);
  assert.equal(reservation.rows[0].enabled, true);
  assert.ok(reservation.rows[0].first_activated_at);
  assert.ok(new Date(reservation.rows[0].created_at).getTime() >= new Date(reservation.rows[0].first_activated_at).getTime(),
    `request ${reservation.rows[0].created_at} predates activation ${reservation.rows[0].first_activated_at}`);
  assert.equal(reservation.rows[0].allocation_count, 1);
  const crossYearQuote = await createPtoRouteStore(db).quoteAuthenticated({
    franchiseId: 44,
    tutorId: 4402,
    balanceDate: '2026-12-31',
    chargeDays: 2,
    dayCharges: [{ date: '2026-12-31', days: 1 }, { date: '2027-01-01', days: 1 }]
  });
  assert.deepEqual(crossYearQuote.cycleAllocations, [
    { cycleStart: '2026-01-01', days: 1 },
    { cycleStart: '2027-01-01', days: 1 }
  ]);
  const before = await db.query('SELECT first_activated_at, last_successful_sync_at FROM public.pto_center_settings WHERE franchiseid=44');
  const deactivated = await db.query('SELECT * FROM public.pto_deactivate_center(44, $1)', ['900']);
  assert.equal(deactivated.rows[0].enabled, false);
  assert.equal(String(deactivated.rows[0].first_activated_at), String(before.rows[0].first_activated_at));
  assert.equal(String(deactivated.rows[0].last_successful_sync_at), String(before.rows[0].last_successful_sync_at));
  await db.query("UPDATE public.time_off_requests SET status='approved' WHERE id=$1", [held.rows[0].id]);
  await db.query("UPDATE public.time_off_requests SET status='denied' WHERE id=$1", [denied.rows[0].id]);
  await db.query("UPDATE public.time_off_requests SET status='cancelled' WHERE id=$1", [cancelled.rows[0].id]);
  assert.equal((await db.query('SELECT state FROM public.pto_request_allocations WHERE request_id=$1', [held.rows[0].id])).rows[0].state, 'consumed');
  assert.equal((await db.query('SELECT state FROM public.pto_request_allocations WHERE request_id=$1', [denied.rows[0].id])).rows[0].state, 'released');
  assert.equal((await db.query('SELECT state FROM public.pto_request_allocations WHERE request_id=$1', [cancelled.rows[0].id])).rows[0].state, 'released');
  assert.equal((await db.query("SELECT COUNT(*)::INTEGER AS count FROM public.pto_audit_events WHERE event_type='center_deactivated' AND franchiseid=44")).rows[0].count, 1);
});

test('a linked-center admin may manage another listed center on the canonical profile', { skip: !enabled }, async () => {
  const db = pool;
  assert.ok(db);
  const profiles = await db.query<{ id: string }>(`
    INSERT INTO public.pto_profiles (first_name, last_name, identity_status)
    VALUES ('Cross', 'Center', 'confirmed'), ('Cross', 'Center', 'pending'),
      ('Reject', 'Pair', 'confirmed'), ('Reject', 'Pair', 'pending') RETURNING id
  `);
  const [target, source, rejectTarget, rejectSource] = profiles.rows.map((row) => row.id);
  const memberships = await db.query<{ id: string; franchiseid: number }>(`
    INSERT INTO public.pto_profile_centers (profile_id, franchiseid, tutor_id, active)
    VALUES ($1,50,5001,TRUE), ($2,51,5101,TRUE), ($3,50,5002,TRUE), ($4,52,5201,TRUE)
    RETURNING id, franchiseid
  `, [target, source, rejectTarget, rejectSource]);
  const candidates = await db.query<{ id: string }>(`
    INSERT INTO public.pto_profile_match_candidates (left_profile_id, right_profile_id)
    VALUES ($1,$2), ($3,$4) RETURNING id
  `, [target, source, rejectTarget, rejectSource]);
  const store = createPostgresPtoStore(db);
  assert.equal((await store.decideAlias({ candidateId: candidates.rows[0].id, decision: 'confirm',
    actorId: 'admin-50', actorFranchiseId: 50 })).decision, 'confirm');
  assert.equal((await store.decideAlias({ candidateId: candidates.rows[1].id, decision: 'reject',
    actorId: 'admin-50', actorFranchiseId: 50 })).decision, 'reject');
  const sourceMembership = memberships.rows.find((membershipRow) => membershipRow.franchiseid === 51);
  assert.ok(sourceMembership);
  const added = await store.addEmail({ profileId: target, membershipId: sourceMembership.id,
    email: 'cross-center@example.com', actorId: 'admin-50', actorFranchiseId: 50 });
  assert.equal(added.sourceMembershipId, sourceMembership.id);
  assert.equal((await store.removeEmail({ profileId: target, emailId: added.id,
    actorId: 'admin-50', actorFranchiseId: 50 })).active, false);
  const detached = await store.detachMembership({ profileId: target, membershipId: sourceMembership.id,
    actorId: 'admin-50', actorFranchiseId: 50 });
  assert.notEqual(detached.detachedProfileId, target);
});
